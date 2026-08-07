import * as assert from 'assert';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { encodeWorkspacePathAsProjectDirName, findLatestTranscriptFile } from '../transcriptWatcher';

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
