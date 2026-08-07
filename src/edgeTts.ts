import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

export interface EnhancedVoiceInfo {
	name: string;
	friendlyName: string;
	locale: string;
	gender: string;
}

/** One word's timing within the synthesized audio, for live highlighting. */
export interface WordBoundary {
	text: string;
	offsetSeconds: number;
	durationSeconds: number;
}

export interface SynthesisResult {
	audio: Buffer;
	words: WordBoundary[];
}

/** Edge TTS reports word-boundary offsets/durations in 100-nanosecond ticks (.NET TimeSpan convention). */
const TICKS_PER_SECOND = 10_000_000;

export const DEFAULT_ENHANCED_VOICE = 'en-GB-RyanNeural';

const SYNTHESIS_TIMEOUT_MS = 10000;
const VOICES_TIMEOUT_MS = 10000;

/** Below this length, splitting isn't worth an extra network round-trip. */
const SPLIT_THRESHOLD_CHARS = 200;
/** How far into the text to look for a sentence boundary or mid-sentence pause for the head chunk. */
const HEAD_SEARCH_WINDOW_CHARS = 250;
/** Fallback head length (snapped to the nearest word) if neither a sentence boundary nor a pause is found in range. */
const HEAD_FALLBACK_TARGET_CHARS = 120;

/**
 * Splits off one chunk from the front of `text`, in three tiers, each a
 * fallback for when the previous one isn't found within
 * HEAD_SEARCH_WINDOW_CHARS: (1) a sentence-ending boundary, so a whole
 * sentence becomes the chunk; (2) for one long run-on sentence with no
 * ending in range, the last natural pause (comma/semicolon/colon) in range,
 * so the cut at least lands somewhere a speaker would actually pause; (3) as
 * a last resort with no punctuation at all, the nearest word boundary.
 */
function splitOnce(text: string): { head: string; rest: string } | undefined {
	const window = text.slice(0, HEAD_SEARCH_WINDOW_CHARS);
	const sentenceEnd = window.search(/[.!?](\s|$)/);
	let splitAt: number;
	if (sentenceEnd !== -1) {
		splitAt = sentenceEnd + 1;
	} else {
		const pauses = [...window.matchAll(/[,;:](\s)/g)];
		const lastPause = pauses.length > 0 ? pauses[pauses.length - 1] : undefined;
		if (lastPause && lastPause.index !== undefined) {
			splitAt = lastPause.index + 1;
		} else {
			const fallbackWindow = text.slice(0, HEAD_FALLBACK_TARGET_CHARS);
			const lastSpace = fallbackWindow.lastIndexOf(' ');
			splitAt = lastSpace > 0 ? lastSpace : HEAD_FALLBACK_TARGET_CHARS;
		}
	}
	const head = text.slice(0, splitAt).trim();
	const rest = text.slice(splitAt).trim();
	if (!head || !rest) {
		return undefined;
	}
	return { head, rest };
}

/**
 * Splits long text into a sequence of sentence-sized chunks. Two reasons to
 * chunk, not just one: it lets a long response start speaking after the
 * first chunk synthesizes instead of waiting for the whole thing, and it
 * keeps any single request to Microsoft's TTS service short enough to avoid
 * "Stream closed before the synthesis completed" — observed in practice
 * when sending an entire multi-paragraph response as one request. Returns a
 * single-element array unchanged when text is already short enough that
 * splitting wouldn't help.
 */
export function splitIntoSpeechChunks(text: string): string[] {
	const chunks: string[] = [];
	let remaining = text.trim();
	while (remaining.length > SPLIT_THRESHOLD_CHARS) {
		const split = splitOnce(remaining);
		if (!split) {
			break;
		}
		chunks.push(split.head);
		remaining = split.rest;
	}
	if (remaining.length > 0) {
		chunks.push(remaining);
	}
	return chunks;
}

let cachedVoices: EnhancedVoiceInfo[] | undefined;

class TimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TimeoutError';
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			}
		);
	});
}

/** Fetches the catalog of available Microsoft Edge neural voices (cached after the first call). */
export async function listEnhancedVoices(): Promise<EnhancedVoiceInfo[]> {
	if (cachedVoices) {
		return cachedVoices;
	}
	const tts = new MsEdgeTTS();
	const voices = await withTimeout(tts.getVoices(), VOICES_TIMEOUT_MS, 'Fetching Enhanced voice list');
	cachedVoices = voices.map((v) => ({
		name: v.ShortName,
		friendlyName: v.FriendlyName,
		locale: v.Locale,
		gender: v.Gender
	}));
	return cachedVoices;
}

/**
 * msedge-tts embeds the input text directly into an SSML/XML request
 * without escaping it (its own README warns callers must do this
 * themselves). An unescaped `&`, `<`, or `>` produces malformed XML that
 * the service can't parse — observed in practice as the connection closing
 * mid-stream ("Stream closed before the synthesis completed") on text
 * containing something as ordinary as an ampersand.
 */
export function escapeXml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

interface RawWordBoundaryEntry {
	Type?: string;
	Data?: {
		Offset?: number;
		Duration?: number;
		text?: { Text?: string };
	};
}

/**
 * Parses the metadata stream's newline-delimited JSON chunks into word
 * timings. Each chunk is `{"Metadata": [...]}`; entries other than
 * `WordBoundary` (e.g. `SentenceBoundary`, which isn't requested here but
 * would otherwise be silently ignored) are skipped.
 */
function parseWordBoundaries(metadataChunks: Buffer[]): WordBoundary[] {
	const words: WordBoundary[] = [];
	for (const chunk of metadataChunks) {
		let parsed: { Metadata?: RawWordBoundaryEntry[] };
		try {
			parsed = JSON.parse(chunk.toString());
		} catch {
			continue;
		}
		for (const entry of parsed.Metadata ?? []) {
			if (entry.Type !== 'WordBoundary' || !entry.Data) {
				continue;
			}
			words.push({
				text: entry.Data.text?.Text ?? '',
				offsetSeconds: (entry.Data.Offset ?? 0) / TICKS_PER_SECOND,
				durationSeconds: (entry.Data.Duration ?? 0) / TICKS_PER_SECOND
			});
		}
	}
	return words;
}

async function attemptSynthesis(text: string, voiceName: string): Promise<SynthesisResult> {
	const tts = new MsEdgeTTS();
	await withTimeout(
		tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3, { wordBoundaryEnabled: true }),
		SYNTHESIS_TIMEOUT_MS,
		'Enhanced voice connection'
	);
	const { audioStream, metadataStream } = tts.toStream(escapeXml(text));
	const audioChunks: Buffer[] = [];
	const metadataChunks: Buffer[] = [];
	const audioDone = (async () => {
		for await (const chunk of audioStream) {
			audioChunks.push(chunk as Buffer);
		}
	})();
	// Unlike audioStream (which gets an explicit push(null) on turn.end),
	// metadataStream is only ever torn down via a cascaded destroy() once
	// audioStream closes — there's no natural "end" for it. Consuming it
	// with for-await would throw on that destroy (premature close) instead
	// of resolving, so this listens directly the same way the library's own
	// toFile() helper does, treating close as normal completion.
	const metadataDone = metadataStream
		? new Promise<void>((resolve, reject) => {
				metadataStream.on('data', (chunk: Buffer) => metadataChunks.push(chunk));
				metadataStream.once('close', () => resolve());
				metadataStream.once('error', reject);
			})
		: Promise.resolve();
	await withTimeout(Promise.all([audioDone, metadataDone]), SYNTHESIS_TIMEOUT_MS, 'Enhanced voice synthesis');
	tts.close();
	return { audio: Buffer.concat(audioChunks), words: parseWordBoundaries(metadataChunks) };
}

/**
 * Synthesizes speech via Microsoft Edge's online neural TTS service, returning
 * MP3 audio bytes. Rate is intentionally not requested here — it's applied
 * client-side instead (see speechPanel.ts), since that can change live while
 * audio is already playing and this synthesis call can't.
 *
 * Retries once, but only if the first attempt failed fast (a real
 * connection/service error) rather than timing out. Retrying after a
 * timeout would just wait the full timeout again — doubling worst-case
 * latency for a connection that's genuinely not responding, for a retry
 * that's unlikely to succeed any faster the second time.
 */
export async function synthesizeSpeech(text: string, voiceName: string): Promise<SynthesisResult> {
	try {
		return await attemptSynthesis(text, voiceName);
	} catch (err) {
		if (err instanceof TimeoutError) {
			throw err;
		}
		return attemptSynthesis(text, voiceName);
	}
}
