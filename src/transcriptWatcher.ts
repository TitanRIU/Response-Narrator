import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { extractAssistantText, isUserTurnBoundary } from './transcriptParser';

const POLL_INTERVAL_MS = 2000;

export interface Utterance {
	text: string;
	timestamp: string;
	sessionFile: string;
}

export function getClaudeProjectsDir(): string {
	return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Mirrors Claude Code's own project-directory naming convention, so a VS
 * Code workspace folder's path can be matched to its corresponding
 * transcript directory: the drive letter (if any) is lowercased, and each
 * path separator/colon becomes a literal dash; everything else, including
 * case, is preserved. E.g. "C:\Foo\Bar" -> "c--Foo-Bar".
 */
export function encodeWorkspacePathAsProjectDirName(workspacePath: string): string {
	const withLowerDrive = /^[A-Za-z]:/.test(workspacePath)
		? workspacePath[0].toLowerCase() + workspacePath.slice(1)
		: workspacePath;
	return withLowerDrive.replace(/[:\\/]/g, '-');
}

async function findAllTranscriptFiles(dir: string): Promise<string[]> {
	let entries: fs.Dirent[];
	try {
		entries = await fsp.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const results: string[] = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...await findAllTranscriptFiles(full));
		} else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
			results.push(full);
		}
	}
	return results;
}

export async function findLatestTranscriptFile(rootDirs: string | string[]): Promise<string | undefined> {
	const dirs = Array.isArray(rootDirs) ? rootDirs : [rootDirs];
	let latest: { file: string; mtimeMs: number } | undefined;
	for (const dir of dirs) {
		const files = await findAllTranscriptFiles(dir);
		for (const file of files) {
			let stat: fs.Stats;
			try {
				stat = await fsp.stat(file);
			} catch {
				continue;
			}
			if (!latest || stat.mtimeMs > latest.mtimeMs) {
				latest = { file, mtimeMs: stat.mtimeMs };
			}
		}
	}
	return latest?.file;
}

/**
 * Tails the most-recently-modified Claude Code transcript under a projects
 * root (or roots — see encodeWorkspacePathAsProjectDirName, used to scope
 * this to only the calling VS Code window's own workspace folders, so two
 * windows watching different projects don't both narrate whichever one
 * happens to be globally most recent), emitting an 'utterance' event for
 * each new assistant text block as it's appended. Never replays existing
 * file content — only what's written after watching starts (or after
 * switching to a newly-active session).
 */
export declare interface TranscriptWatcher {
	on(event: 'utterance', listener: (utterance: Utterance) => void): this;
	on(event: 'error', listener: (err: Error) => void): this;
	on(event: 'sessionChanged', listener: (filePath: string) => void): this;
	on(event: 'turnBoundary', listener: () => void): this;
}

export class TranscriptWatcher extends EventEmitter {
	private readonly rootDirs: string[];
	private currentFile: string | undefined;
	private offset = 0;
	private pendingPartialLine = '';
	private fsWatcher: fs.FSWatcher | undefined;
	private pollTimer: NodeJS.Timeout | undefined;
	private reading = false;
	private stopped = true;

	constructor(rootDirs: string | string[] = getClaudeProjectsDir()) {
		super();
		this.rootDirs = Array.isArray(rootDirs) ? rootDirs : [rootDirs];
	}

	/** Returns false if no transcript files were found to watch. */
	async start(): Promise<boolean> {
		this.stopped = false;
		const latest = await findLatestTranscriptFile(this.rootDirs);
		if (!latest) {
			this.stopped = true;
			return false;
		}
		await this.switchTo(latest);
		this.pollTimer = setInterval(() => {
			this.checkForNewerFile().catch((err) => this.emit('error', err));
		}, POLL_INTERVAL_MS);
		return true;
	}

	stop(): void {
		this.stopped = true;
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
		this.detachFileWatcher();
		this.currentFile = undefined;
		this.offset = 0;
		this.pendingPartialLine = '';
	}

	get watchedFile(): string | undefined {
		return this.currentFile;
	}

	private detachFileWatcher(): void {
		if (this.fsWatcher) {
			this.fsWatcher.close();
			this.fsWatcher = undefined;
		}
	}

	private async switchTo(filePath: string): Promise<void> {
		this.detachFileWatcher();
		this.currentFile = filePath;
		this.pendingPartialLine = '';
		try {
			const stat = await fsp.stat(filePath);
			this.offset = stat.size;
		} catch {
			this.offset = 0;
		}
		try {
			this.fsWatcher = fs.watch(filePath, () => {
				this.readNewContent().catch((err) => this.emit('error', err));
			});
			this.fsWatcher.on('error', (err) => this.emit('error', err as Error));
		} catch (err) {
			this.emit('error', err as Error);
		}
		this.emit('sessionChanged', filePath);
	}

	private async checkForNewerFile(): Promise<void> {
		if (this.stopped) {
			return;
		}
		const latest = await findLatestTranscriptFile(this.rootDirs);
		if (latest && latest !== this.currentFile) {
			await this.switchTo(latest);
		}
	}

	private async readNewContent(): Promise<void> {
		if (this.stopped || !this.currentFile || this.reading) {
			return;
		}
		this.reading = true;
		try {
			const filePath = this.currentFile;
			let stat: fs.Stats;
			try {
				stat = await fsp.stat(filePath);
			} catch {
				// File may have just been removed/replaced; the poll loop will recover.
				return;
			}
			if (stat.size < this.offset) {
				// File shrank or was replaced in place; restart from the beginning.
				this.offset = 0;
				this.pendingPartialLine = '';
			}
			if (stat.size === this.offset) {
				return;
			}
			const chunk = await this.readRange(filePath, this.offset, stat.size);
			this.offset = stat.size;
			this.pendingPartialLine += chunk;
			const lines = this.pendingPartialLine.split('\n');
			this.pendingPartialLine = lines.pop() ?? '';
			for (const line of lines) {
				this.processLine(line, filePath);
			}
		} finally {
			this.reading = false;
		}
	}

	private readRange(filePath: string, start: number, end: number): Promise<string> {
		return new Promise((resolve, reject) => {
			const stream = fs.createReadStream(filePath, { start, end: end - 1, encoding: 'utf8' });
			let data = '';
			stream.on('data', (part) => {
				data += part;
			});
			stream.on('end', () => resolve(data));
			stream.on('error', reject);
		});
	}

	private processLine(line: string, sessionFile: string): void {
		const trimmed = line.trim();
		if (!trimmed) {
			return;
		}
		let entry: unknown;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			// Ignore malformed/partial lines.
			return;
		}
		if (isUserTurnBoundary(entry)) {
			this.emit('turnBoundary');
			return;
		}
		for (const text of extractAssistantText(entry)) {
			const utterance: Utterance = { text, timestamp: new Date().toISOString(), sessionFile };
			this.emit('utterance', utterance);
		}
	}
}
