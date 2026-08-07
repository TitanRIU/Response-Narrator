import * as assert from 'assert';
import { stripMarkdownForSpeech } from '../markdown';

suite('stripMarkdownForSpeech', () => {
	test('strips bold and italic markers', () => {
		assert.strictEqual(stripMarkdownForSpeech('This is **bold** and *italic*.'), 'This is bold and italic.');
	});

	test('strips inline code backticks', () => {
		assert.strictEqual(stripMarkdownForSpeech('Run `npm install` first.'), 'Run npm install first.');
	});

	test('strips fenced code blocks but keeps the code text', () => {
		const input = 'Here:\n```ts\nconst x = 1;\n```\nDone.';
		assert.strictEqual(stripMarkdownForSpeech(input), 'Here:\nconst x = 1;\nDone.');
	});

	test('converts markdown links to their text', () => {
		assert.strictEqual(stripMarkdownForSpeech('See [the docs](https://example.com) for more.'), 'See the docs for more.');
	});

	test('strips header and blockquote markers', () => {
		assert.strictEqual(stripMarkdownForSpeech('## Heading\n> quoted line'), 'Heading\nquoted line');
	});

	test('strips list bullet markers', () => {
		assert.strictEqual(stripMarkdownForSpeech('- first\n- second'), 'first\nsecond');
	});
});
