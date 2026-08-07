import * as assert from 'assert';
import { stripMarkdownForSpeech } from '../markdown';

suite('stripMarkdownForSpeech', () => {
	test('strips bold and italic markers', () => {
		assert.strictEqual(stripMarkdownForSpeech('This is **bold** and *italic*.'), 'This is bold and italic.');
	});

	test('strips inline code backticks', () => {
		assert.strictEqual(stripMarkdownForSpeech('Run `npm install` first.'), 'Run npm install first.');
	});

	test('replaces a fenced code block with a spoken language + line-count announcement', () => {
		const input = 'Here:\n```typescript\nconst x = 1;\n```\nDone.';
		assert.strictEqual(stripMarkdownForSpeech(input), 'Here:\nTypescript code block, 1 line.\nDone.');
	});

	test('pluralizes "lines" for a multi-line code block', () => {
		const input = '```python\ndef foo():\n    return 1\n```';
		assert.strictEqual(stripMarkdownForSpeech(input), 'Python code block, 2 lines.');
	});

	test('announces a fenced code block with no language tag as just "Code block"', () => {
		const input = '```\nplain\n```';
		assert.strictEqual(stripMarkdownForSpeech(input), 'Code block, 1 line.');
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
