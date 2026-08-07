import { stripMarkdownForSpeech } from './markdown';

interface ContentBlock {
	type: string;
	text?: string;
}

interface TranscriptMessage {
	content?: ContentBlock[];
}

interface TranscriptEntry {
	type?: string;
	isSidechain?: boolean;
	isMeta?: boolean;
	toolUseResult?: unknown;
	message?: TranscriptMessage;
}

/**
 * Extracts speakable text from a single parsed transcript line. Each JSONL
 * line represents one complete content block of an assistant turn (text,
 * tool_use, or thinking) — non-text blocks and sidechain (subagent) entries
 * are skipped.
 */
export function extractAssistantText(entry: unknown): string[] {
	if (typeof entry !== 'object' || entry === null) {
		return [];
	}
	const e = entry as TranscriptEntry;
	if (e.type !== 'assistant' || e.isSidechain) {
		return [];
	}
	const blocks = e.message?.content;
	if (!Array.isArray(blocks)) {
		return [];
	}
	const texts: string[] = [];
	for (const block of blocks) {
		if (block?.type === 'text' && typeof block.text === 'string') {
			const cleaned = stripMarkdownForSpeech(block.text).trim();
			if (cleaned) {
				texts.push(cleaned);
			}
		}
	}
	return texts;
}

/**
 * True if this entry marks the start of a new user turn — i.e. something
 * actually typed/sent by the user, not a tool result. Tool results are also
 * written as `type: "user"` entries (mirroring the Anthropic API's message
 * structure), so they're distinguished by carrying a `toolUseResult` field
 * and `tool_result` content blocks instead of `text` ones.
 */
export function isUserTurnBoundary(entry: unknown): boolean {
	if (typeof entry !== 'object' || entry === null) {
		return false;
	}
	const e = entry as TranscriptEntry;
	if (e.type !== 'user' || e.isSidechain || e.isMeta || e.toolUseResult !== undefined) {
		return false;
	}
	const blocks = e.message?.content;
	return Array.isArray(blocks) && blocks.some((block) => block?.type === 'text');
}
