import * as assert from 'assert';
import { extractAssistantText, isUserTurnBoundary } from '../transcriptParser';

suite('extractAssistantText', () => {
	test('extracts text blocks from an assistant entry', () => {
		const entry = { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello **world**' }] } };
		assert.deepStrictEqual(extractAssistantText(entry), ['Hello world']);
	});

	test('skips non-text content blocks', () => {
		const entry = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } };
		assert.deepStrictEqual(extractAssistantText(entry), []);
	});

	test('skips non-assistant entries', () => {
		const entry = { type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } };
		assert.deepStrictEqual(extractAssistantText(entry), []);
	});

	test('skips sidechain (subagent) entries', () => {
		const entry = { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'hi' }] } };
		assert.deepStrictEqual(extractAssistantText(entry), []);
	});

	test('handles malformed entries without throwing', () => {
		assert.deepStrictEqual(extractAssistantText(null), []);
		assert.deepStrictEqual(extractAssistantText('not an object'), []);
		assert.deepStrictEqual(extractAssistantText({ type: 'assistant' }), []);
	});
});

suite('isUserTurnBoundary', () => {
	test('recognizes a real user text entry', () => {
		const entry = { type: 'user', message: { content: [{ type: 'text', text: 'hello' }] } };
		assert.strictEqual(isUserTurnBoundary(entry), true);
	});

	test('rejects tool_result entries even though they are type "user"', () => {
		const entry = {
			type: 'user',
			toolUseResult: { stdout: 'ok' },
			message: { content: [{ type: 'tool_result', text: 'ok' }] }
		};
		assert.strictEqual(isUserTurnBoundary(entry), false);
	});

	test('rejects assistant entries', () => {
		const entry = { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
		assert.strictEqual(isUserTurnBoundary(entry), false);
	});

	test('rejects sidechain and meta entries', () => {
		assert.strictEqual(
			isUserTurnBoundary({ type: 'user', isSidechain: true, message: { content: [{ type: 'text', text: 'hi' }] } }),
			false
		);
		assert.strictEqual(
			isUserTurnBoundary({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'hi' }] } }),
			false
		);
	});

	test('handles malformed entries without throwing', () => {
		assert.strictEqual(isUserTurnBoundary(null), false);
		assert.strictEqual(isUserTurnBoundary('not an object'), false);
		assert.strictEqual(isUserTurnBoundary({ type: 'user' }), false);
	});
});
