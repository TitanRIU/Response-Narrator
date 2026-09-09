import * as assert from 'assert';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { encodeWorkspacePathAsProjectDirName, findLatestTranscriptFile, TranscriptWatcher, Utterance } from '../transcriptWatcher';

function assistantTextLine(text: string): string {
	return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000, intervalMs = 30): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error('Timed out waiting for condition');
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

suite('encodeWorkspacePathAsProjectDirName', () => {
	test('matches Claude Code\'s real project directory naming for a two-level Windows path', () => {
		assert.strictEqual(
			encodeWorkspacePathAsProjectDirName('C:\\VScode-Extensions\\Response-Narrator'),
			'c--VScode-Extensions-Response-Narrator'
		);
	});

	test('matches Claude Code\'s real project directory naming for a short Windows path', () => {
		assert.strictEqual(encodeWorkspacePathAsProjectDirName('C:\\Users\\TOM'), 'c--Users-TOM');
	});

	test('matches Claude Code\'s real project directory naming for a deeper Windows path', () => {
		assert.strictEqual(
			encodeWorkspacePathAsProjectDirName('C:\\Users\\TOM\\dev\\Projects\\Timeloop-Script'),
			'c--Users-TOM-dev-Projects-Timeloop-Script'
		);
	});

	test('preserves case of path segments, only lowercasing the drive letter', () => {
		assert.strictEqual(encodeWorkspacePathAsProjectDirName('D:\\MyStuff\\CoolProject'), 'd--MyStuff-CoolProject');
	});

	test('handles a POSIX-style path with no drive letter', () => {
		assert.strictEqual(encodeWorkspacePathAsProjectDirName('/home/tom/my-project'), '-home-tom-my-project');
	});
});

suite('findLatestTranscriptFile with multiple roots', () => {
	let tmpRoot: string;

	setup(async () => {
		tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'response-narrator-test-'));
	});

	teardown(async () => {
		await fsp.rm(tmpRoot, { recursive: true, force: true });
	});

	test('picks the most recently modified file across multiple separate roots, not just within one', async () => {
		const rootA = path.join(tmpRoot, 'project-a');
		const rootB = path.join(tmpRoot, 'project-b');
		await fsp.mkdir(rootA, { recursive: true });
		await fsp.mkdir(rootB, { recursive: true });

		const fileA = path.join(rootA, 'session.jsonl');
		const fileB = path.join(rootB, 'session.jsonl');
		await fsp.writeFile(fileA, '{}\n');
		// Ensure a distinct, later mtime than fileA regardless of filesystem timestamp resolution.
		await new Promise((resolve) => setTimeout(resolve, 20));
		await fsp.writeFile(fileB, '{}\n');

		const latest = await findLatestTranscriptFile([rootA, rootB]);
		assert.strictEqual(latest, fileB);
	});

	test('scoping to one root ignores newer files in a sibling root entirely', async () => {
		const rootA = path.join(tmpRoot, 'project-a');
		const rootB = path.join(tmpRoot, 'project-b');
		await fsp.mkdir(rootA, { recursive: true });
		await fsp.mkdir(rootB, { recursive: true });

		const fileA = path.join(rootA, 'session.jsonl');
		const fileB = path.join(rootB, 'session.jsonl');
		await fsp.writeFile(fileA, '{}\n');
		await new Promise((resolve) => setTimeout(resolve, 20));
		await fsp.writeFile(fileB, '{}\n');

		// Scoped to just rootA: the newer file in rootB must never be picked, even though
		// it's the globally latest — this is the exact behavior the cross-window fix relies on.
		const latest = await findLatestTranscriptFile([rootA]);
		assert.strictEqual(latest, fileA);
	});

	test('returns undefined when no root has any transcript files', async () => {
		const emptyRoot = path.join(tmpRoot, 'empty');
		await fsp.mkdir(emptyRoot, { recursive: true });
		const latest = await findLatestTranscriptFile([emptyRoot]);
		assert.strictEqual(latest, undefined);
	});

	test('tolerates a root directory that does not exist', async () => {
		const missingRoot = path.join(tmpRoot, 'does-not-exist');
		const realRoot = path.join(tmpRoot, 'project-a');
		await fsp.mkdir(realRoot, { recursive: true });
		const file = path.join(realRoot, 'session.jsonl');
		await fsp.writeFile(file, '{}\n');

		const latest = await findLatestTranscriptFile([missingRoot, realRoot]);
		assert.strictEqual(latest, file);
	});
});

suite('TranscriptWatcher and context compaction', () => {
	let tmpRoot: string;
	let watcher: TranscriptWatcher | undefined;

	setup(async () => {
		tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'response-narrator-test-'));
	});

	teardown(async () => {
		watcher?.stop();
		watcher = undefined;
		await fsp.rm(tmpRoot, { recursive: true, force: true });
	});

	test('a compacted rewrite that shrinks the file does not replay its content as new utterances', async () => {
		const file = path.join(tmpRoot, 'session.jsonl');
		// A "long" pre-compaction history — replaying this in full is exactly
		// the bug: real sessions have seen this happen with 300+ messages.
		const longHistory = Array.from({ length: 20 }, (_, i) => assistantTextLine(`Original message ${i}`)).join('\n') + '\n';
		await fsp.writeFile(file, longHistory);

		const utterances: Utterance[] = [];
		watcher = new TranscriptWatcher([tmpRoot]);
		watcher.on('utterance', (u) => utterances.push(u));
		const started = await watcher.start();
		assert.ok(started);

		// Starting to watch an existing file must never replay its
		// pre-existing content — only what's appended after.
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.strictEqual(utterances.length, 0);

		// Simulate context compaction: Claude Code rewrites the transcript
		// in place with a much shorter compacted summary, so the file is now
		// smaller than what's already been "read" (the offset sits at the
		// end of the pre-compaction file).
		const compactedRewrite = assistantTextLine('Compacted summary of the conversation so far.') + '\n';
		assert.ok(compactedRewrite.length < longHistory.length, 'the whole point of compaction is a smaller file');
		await fsp.writeFile(file, compactedRewrite);

		// Give the watcher a real chance to (wrongly) replay it before
		// asserting it didn't — a fixed short wait rather than waitFor,
		// since there's no positive condition to poll for here.
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.strictEqual(utterances.length, 0, 'the compacted rewrite must not be replayed as new utterances');

		// Normal tailing must still work for genuinely new content appended
		// after the compaction.
		await fsp.appendFile(file, assistantTextLine('Genuinely new message after compaction') + '\n');
		await waitFor(() => utterances.length > 0);
		assert.strictEqual(utterances.length, 1);
		assert.strictEqual(utterances[0].text, 'Genuinely new message after compaction');
	});
});
