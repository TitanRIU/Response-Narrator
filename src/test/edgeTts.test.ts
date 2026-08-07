import * as assert from 'assert';
import { splitIntoSpeechChunks, escapeXml } from '../edgeTts';

suite('escapeXml', () => {
	test('escapes ampersands, the character that broke real synthesis requests', () => {
		assert.strictEqual(
			escapeXml('And symbols—ampersands (&), at signs (@), and percentages (%)?'),
			'And symbols—ampersands (&amp;), at signs (@), and percentages (%)?'
		);
	});

	test('escapes angle brackets so stray text can\'t be parsed as XML tags', () => {
		assert.strictEqual(escapeXml('a < b and b > a'), 'a &lt; b and b &gt; a');
	});

	test('escapes quotes', () => {
		assert.strictEqual(escapeXml(`She said "hi" and it's fine.`), 'She said &quot;hi&quot; and it&apos;s fine.');
	});

	test('does not double-escape an ampersand introduced by escaping another character', () => {
		// A naive "escape < then escape &" ordering would turn "<" into
		// "&lt;" and then corrupt it further into "&amp;lt;".
		assert.strictEqual(escapeXml('<'), '&lt;');
	});

	test('leaves plain text untouched', () => {
		assert.strictEqual(escapeXml('Nothing special here.'), 'Nothing special here.');
	});
});

suite('splitIntoSpeechChunks', () => {
	test('does not split short text', () => {
		assert.deepStrictEqual(splitIntoSpeechChunks('Short text.'), ['Short text.']);
	});

	test('splits at sentence boundaries when present', () => {
		const text =
			'This is the first sentence of a fairly long response. ' +
			'This is the second sentence which continues on for quite a while providing lots of detail and context, ' +
			'well past the splitting threshold so this test actually exercises the split path.';
		const chunks = splitIntoSpeechChunks(text);
		assert.ok(chunks.length > 1);
		assert.strictEqual(chunks[0], 'This is the first sentence of a fairly long response.');
		for (const chunk of chunks) {
			assert.ok(chunk.length > 0);
		}
	});

	test('breaks a long multi-paragraph response into more than two chunks', () => {
		const sentence = 'This is one sentence in a long multi paragraph response about testing chunking behavior. ';
		const text = sentence.repeat(10).trim();
		const chunks = splitIntoSpeechChunks(text);
		assert.ok(chunks.length > 2, `expected more than 2 chunks, got ${chunks.length}`);
		// No single chunk should still be as long as the whole thing — that's
		// the exact "one giant request" failure mode this is meant to avoid.
		for (const chunk of chunks) {
			assert.ok(chunk.length < text.length);
		}
	});

	test('falls back to a word boundary when there is no sentence-ending punctuation nearby', () => {
		const text = 'a '.repeat(150).trim(); // long, single "sentence", no punctuation
		const chunks = splitIntoSpeechChunks(text);
		assert.ok(chunks.length > 1);
		for (const chunk of chunks) {
			assert.ok(!chunk.endsWith(' '));
		}
	});

	test('prefers a comma over a mid-word cut for one long run-on sentence', () => {
		const text =
			'This is a very long sentence without any ending punctuation for quite a while, ' +
			'which keeps going and going through many many words in a row without ever stopping, ' +
			'continuing to ramble on and on past the splitting threshold so this test can check that ' +
			'the comma is used as the natural pause point instead of an arbitrary word boundary cut';
		const chunks = splitIntoSpeechChunks(text);
		assert.ok(chunks.length > 1);
		assert.ok(chunks[0].endsWith(','), `expected first chunk to end at a comma, got: "${chunks[0]}"`);
	});

	test('chunks recombine to the original content', () => {
		const text =
			'Sentence one is here. Sentence two follows right after it, and it keeps going for a while ' +
			'to make sure the total length clears the splitting threshold comfortably, with a bit more ' +
			'padding text added here just to be safe about it.';
		const chunks = splitIntoSpeechChunks(text);
		assert.strictEqual(chunks.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
	});
});
