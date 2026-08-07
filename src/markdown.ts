/**
 * Strips common Markdown formatting from assistant text so it reads
 * cleanly as speech instead of being read aloud literally (e.g. "asterisk
 * asterisk bold asterisk asterisk").
 */
export function stripMarkdownForSpeech(text: string): string {
	let result = text;

	// Fenced code blocks: drop the fence markers, keep the code content.
	result = result.replace(/```[^\n]*\n([\s\S]*?)```/g, (_match, code: string) => code.replace(/\n$/, ''));

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
