function countCodeLines(code: string): number {
	const trimmed = code.replace(/\n$/, '');
	return trimmed.length === 0 ? 0 : trimmed.split('\n').length;
}

function capitalize(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Strips common Markdown formatting from assistant text so it reads
 * cleanly as speech instead of being read aloud literally (e.g. "asterisk
 * asterisk bold asterisk asterisk").
 */
export function stripMarkdownForSpeech(text: string): string {
	let result = text;

	// Fenced code blocks: reading raw code aloud verbatim is unpleasant to
	// listen to, so replace the block with a short spoken announcement
	// instead (e.g. "TypeScript code block, 12 lines.") using the fence's
	// language tag when present.
	result = result.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_match, lang: string, code: string) => {
		const lineCount = countCodeLines(code);
		const label = lang.trim() ? `${capitalize(lang.trim())} code` : 'Code';
		return `${label} block, ${lineCount} line${lineCount === 1 ? '' : 's'}.`;
	});

	// Inline code: keep the content, drop the backticks.
	result = result.replace(/`([^`]+)`/g, '$1');

	// Images: ![alt](url) -> alt
	result = result.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');

	// Links: [text](url) -> text
	result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

	// Emphasis markers, longest first so "**bold**" isn't left with stray asterisks.
	result = result.replace(/(\*\*\*|___)(.+?)\1/g, '$2');
	result = result.replace(/(\*\*|__)(.+?)\1/g, '$2');
	result = result.replace(/(\*|_)(.+?)\1/g, '$2');

	// Strikethrough.
	result = result.replace(/~~(.+?)~~/g, '$1');

	// Headers.
	result = result.replace(/^#{1,6}\s+/gm, '');

	// Blockquotes.
	result = result.replace(/^>\s?/gm, '');

	// Horizontal rules on their own line.
	result = result.replace(/^ {0,3}([-*_])( *\1){2,}\s*$/gm, '');

	// Bullet and numbered list markers.
	result = result.replace(/^(\s*)[-*+]\s+/gm, '$1');
	result = result.replace(/^(\s*)\d+\.\s+/gm, '$1');

	// Collapse whitespace left behind by the above.
	result = result.replace(/[ \t]{2,}/g, ' ');
	result = result.replace(/\n{3,}/g, '\n\n');

	return result.trim();
}
