import * as vscode from 'vscode';
import { TranscriptWatcher, Utterance } from './transcriptWatcher';
import { SpeechPanel, PlaybackState } from './speechPanel';
import { listEnhancedVoices, synthesizeSpeech, splitIntoSpeechChunks, DEFAULT_ENHANCED_VOICE, WordBoundary } from './edgeTts';

const CONFIG_SECTION = 'response-narrator';
const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const ISSUES_URL = 'https://github.com/TitanRIU/Response-Narrator/issues';
// Cap on simultaneous Enhanced synthesis requests when speaking a
// chunked response. Firing every chunk's request at once for a long
// response appears to trigger Microsoft's TTS service to drop some of
// them ("Stream closed before the synthesis completed") — a sliding
// window keeps a couple of requests running ahead of playback without
// opening a dozen connections at once.
const MAX_CONCURRENT_ENHANCED_REQUESTS = 2;

/** Simple counting semaphore: run() waits for a free slot, then executes fn. */
class ConcurrencyLimiter {
	private active = 0;
	private readonly waiters: (() => void)[] = [];

	constructor(private readonly max: number) {}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.max) {
			await new Promise<void>((resolve) => this.waiters.push(resolve));
		}
		this.active++;
		try {
			return await fn();
		} finally {
			this.active--;
			this.waiters.shift()?.();
		}
	}
}

const enhancedConcurrency = new ConcurrencyLimiter(MAX_CONCURRENT_ENHANCED_REQUESTS);

let enhancedFailureWarned = false;
// Bumped whenever a voice hand-off (SpeechPanel.onDidRequestResynthesis)
// takes over mid-response. A chunked speak() call captures the generation
// it started with and stops enqueueing more audio once it no longer
// matches — otherwise its still-in-flight chunks (fetched with the OLD
// voice, before the change) would keep trickling into the queue behind the
// hand-off's replacement, undoing the voice change after one sentence.
let speechGeneration = 0;
// Counts in-flight Enhanced-engine synthesis requests, so the button can
// show a loading state and ignore clicks between "play pressed" and "audio
// actually started" — otherwise a click during that gap looks like it did
// nothing (icon hasn't changed yet), inviting a second click that fires a
// second synthesis request and speaks the same text twice.
let pendingSynthesisCount = 0;

let watcher: TranscriptWatcher | undefined;
let speechPanel: SpeechPanel | undefined;
let menuStatusBarItem: vscode.StatusBarItem;
let stopStatusBarItem: vscode.StatusBarItem;
let playbackStatusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

let playbackState: PlaybackState = 'idle';

// Text chunks spoken since the last user turn (in-progress response), and a
// snapshot of the previous turn's chunks once a new one starts — together
// these back "play last response".
let currentResponseChunks: string[] = [];
let lastCompletedResponse: string[] | undefined;

export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('Response Narrator');
	speechPanel = new SpeechPanel(context);

	menuStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	menuStatusBarItem.text = '$(unmute) Narrator';
	menuStatusBarItem.command = 'response-narrator.openMenu';
	menuStatusBarItem.show();

	stopStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	stopStatusBarItem.text = '$(debug-stop)';
	stopStatusBarItem.tooltip = 'Response Narrator: stop playback';
	stopStatusBarItem.command = 'response-narrator.stopSpeaking';
	stopStatusBarItem.show();

	playbackStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
	playbackStatusBarItem.command = 'response-narrator.togglePlayback';
	playbackStatusBarItem.show();

	updateMenuStatusBar();
	updatePlaybackStatusBar();

	context.subscriptions.push(
		outputChannel,
		menuStatusBarItem,
		stopStatusBarItem,
		playbackStatusBarItem,
		vscode.commands.registerCommand('response-narrator.openMenu', openMenu),
		vscode.commands.registerCommand('response-narrator.togglePlayback', togglePlayback),
		vscode.commands.registerCommand('response-narrator.selectVoice', selectVoice),
		vscode.commands.registerCommand('response-narrator.stopSpeaking', stopSpeaking),
		vscode.commands.registerCommand('response-narrator.reportIssue', reportIssue),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration(CONFIG_SECTION)) {
				return;
			}
			updateMenuStatusBar();
			updatePlaybackStatusBar();
			if (
				e.affectsConfiguration(`${CONFIG_SECTION}.rate`) ||
				e.affectsConfiguration(`${CONFIG_SECTION}.voice`)
			) {
				speechPanel?.updateSettings({ rate: getRate(), voice: getVoiceSetting() || undefined });
			}
			if (e.affectsConfiguration(`${CONFIG_SECTION}.enhancedVoice`)) {
				speechPanel?.notifyEnhancedVoiceChanged();
			}
		}),
		speechPanel.onDidChangeState((state) => {
			playbackState = state;
			updatePlaybackStatusBar();
		}),
		speechPanel.onDidLog((message) => {
			console.warn('[Response Narrator]', message);
			outputChannel.appendLine(message);
		}),
		speechPanel.onDidRequireUnlock(() => {
			// A native VS Code notification button click was tried here and
			// confirmed NOT to work: it fires in a different frame than the
			// webview's own document, so it doesn't carry the "user
			// activation" Chromium's autoplay policy requires to resume an
			// AudioContext. The in-panel Enable prompt (speechPanel.ts) is
			// the only place this can actually happen.
			speechPanel?.reveal();
		}),
		speechPanel.onDidRequestResynthesis(({ token, text }) => {
			speechGeneration++;
			void handleResynthesis(token, text);
		})
	);

	void startWatching();
}

export function deactivate() {
	watcher?.stop();
	watcher = undefined;
	speechPanel?.dispose();
}

async function startWatching(): Promise<void> {
	const newWatcher = new TranscriptWatcher();
	resetResponseBuffers();

	newWatcher.on('utterance', (utterance: Utterance) => {
		console.log('[Response Narrator]', utterance.text);
		outputChannel.appendLine(utterance.text);
		currentResponseChunks.push(utterance.text);
		if (getPlaybackMode() === 'auto') {
			void speak(utterance.text);
		}
	});
	newWatcher.on('turnBoundary', () => {
		if (currentResponseChunks.length > 0) {
			lastCompletedResponse = currentResponseChunks;
			currentResponseChunks = [];
		}
	});
	newWatcher.on('error', (err: Error) => {
		console.error('[Response Narrator] watcher error:', err);
		outputChannel.appendLine(`Error: ${err.message}`);
	});
	newWatcher.on('sessionChanged', (filePath: string) => {
		resetResponseBuffers();
		speechPanel?.stop();
		outputChannel.appendLine(`Watching session: ${filePath}`);
	});

	const started = await newWatcher.start();
	if (!started) {
		void vscode.window.showWarningMessage(
			'Response Narrator: no Claude Code transcripts found under ~/.claude/projects.'
		);
		return;
	}

	watcher = newWatcher;
}

function togglePlayback(): void {
	if (isLoading()) {
		return;
	}
	if (playbackState === 'speaking') {
		speechPanel?.pause();
	} else if (playbackState === 'paused') {
		speechPanel?.resume();
	} else {
		playLastResponse();
	}
}

function playLastResponse(): void {
	const chunks = currentResponseChunks.length > 0 ? currentResponseChunks : lastCompletedResponse;
	if (!chunks || chunks.length === 0) {
		void vscode.window.showInformationMessage('Response Narrator: no response captured yet.');
		return;
	}
	void speak(chunks.join(' '));
}

function stopSpeaking(): void {
	// Bumping the generation here (not just on a voice hand-off) means any
	// chunk fetches already in flight for the response being stopped will
	// see they're superseded and skip enqueueing once they resolve — same
	// leak this guards against for voice hand-offs, triggered here by a stop.
	speechGeneration++;
	speechPanel?.stop();
}

async function openMenu(): Promise<void> {
	const engine = getVoiceEngine();
	const voiceLabel =
		engine === 'enhanced' ? getEnhancedVoiceSetting() || DEFAULT_ENHANCED_VOICE : getVoiceSetting() || 'System default';
	const picked = await vscode.window.showQuickPick(
		[
			{ id: 'playback', label: '$(gear) Playback', description: getPlaybackMode() === 'auto' ? 'Auto' : 'Manual' },
			{ id: 'engine', label: '$(rocket) Voice Engine', description: engine === 'enhanced' ? 'Enhanced' : 'System' },
			{ id: 'voice', label: '$(mic) Voice', description: voiceLabel },
			{ id: 'speed', label: '$(zap) Speed', description: `${getRate()}x` },
			{ id: 'feedback', label: '$(comment) Report Issue / Give Feedback', description: 'Opens GitHub Issues' }
		],
		{ placeHolder: 'Response Narrator settings' }
	);
	if (!picked) {
		return;
	}
	if (picked.id === 'playback') {
		await choosePlaybackMode();
	} else if (picked.id === 'engine') {
		await chooseEngine();
	} else if (picked.id === 'voice') {
		await selectVoice();
	} else if (picked.id === 'speed') {
		await chooseSpeed();
	} else if (picked.id === 'feedback') {
		await reportIssue();
	}
}

async function reportIssue(): Promise<void> {
	await vscode.env.openExternal(vscode.Uri.parse(ISSUES_URL));
}

async function chooseEngine(): Promise<void> {
	const engine = getVoiceEngine();
	const options: { label: string; description: string; value: 'system' | 'enhanced' }[] = [
		{ label: 'System', description: 'Built-in OS voices — instant, works offline', value: 'system' },
		{
			label: 'Enhanced',
			description: "Higher-quality neural voices via Microsoft Edge's TTS service — requires network",
			value: 'enhanced'
		}
	];
	const picked = await vscode.window.showQuickPick(
		options.map((item) => ({ ...item, label: item.value === engine ? `$(check) ${item.label}` : item.label })),
		{ placeHolder: 'Response Narrator: Voice engine' }
	);
	if (picked) {
		await vscode.workspace
			.getConfiguration(CONFIG_SECTION)
			.update('voiceEngine', picked.value, vscode.ConfigurationTarget.Global);
	}
}

async function choosePlaybackMode(): Promise<void> {
	const mode = getPlaybackMode();
	const options: { label: string; description: string; value: 'auto' | 'manual' }[] = [
		{ label: 'Auto', description: 'Read new responses automatically as they arrive', value: 'auto' },
		{ label: 'Manual', description: 'Only read when you press play', value: 'manual' }
	];
	const picked = await vscode.window.showQuickPick(
		options.map((item) => ({ ...item, label: item.value === mode ? `$(check) ${item.label}` : item.label })),
		{ placeHolder: 'Response Narrator: Playback mode' }
	);
	if (picked) {
		await vscode.workspace
			.getConfiguration(CONFIG_SECTION)
			.update('playbackMode', picked.value, vscode.ConfigurationTarget.Global);
	}
}

async function chooseSpeed(): Promise<void> {
	const rate = getRate();
	const picked = await vscode.window.showQuickPick(
		SPEED_PRESETS.map((value) => ({
			label: value === rate ? `$(check) ${value}x` : `${value}x`,
			value
		})),
		{ placeHolder: 'Response Narrator: Speech rate' }
	);
	if (picked) {
		await vscode.workspace
			.getConfiguration(CONFIG_SECTION)
			.update('rate', picked.value, vscode.ConfigurationTarget.Global);
	}
}

async function selectVoice(): Promise<void> {
	if (getVoiceEngine() === 'enhanced') {
		await selectEnhancedVoice();
	} else {
		await selectSystemVoice();
	}
}

async function selectSystemVoice(): Promise<void> {
	if (!speechPanel) {
		return;
	}
	const voices = await speechPanel.getVoices();
	if (voices.length === 0) {
		void vscode.window.showWarningMessage('Response Narrator: no speech synthesis voices are available.');
		return;
	}
	const currentVoice = getVoiceSetting();
	const picked = await vscode.window.showQuickPick(
		voices.map((v) => ({
			label: v.name === currentVoice ? `$(check) ${v.name}` : v.name,
			description: v.lang + (v.default ? ' (default)' : ''),
			value: v.name
		})),
		{ placeHolder: 'Select a System voice for Response Narrator' }
	);
	if (picked) {
		await vscode.workspace
			.getConfiguration(CONFIG_SECTION)
			.update('voice', picked.value, vscode.ConfigurationTarget.Global);
	}
}

let localeDisplayNames: Intl.DisplayNames | undefined;

/** Friendly name for a BCP-47 locale tag (e.g. "fr-FR" -> "French (France)"), falling back to the raw tag. */
function localeDisplayName(locale: string): string {
	localeDisplayNames ??= new Intl.DisplayNames(['en'], { type: 'language' });
	try {
		return localeDisplayNames.of(locale) ?? locale;
	} catch {
		return locale;
	}
}

/** The primary language subtag of a BCP-47 locale (e.g. "en-GB" -> "en"). */
function baseLanguageOf(locale: string): string {
	return locale.split('-')[0];
}

/**
 * Enhanced has 300+ voices across 140+ locales — most languages have only
 * one region (e.g. Albanian is just sq-AL), but a handful (English, Arabic,
 * Spanish, ...) have a dozen+, which is what actually bloats the list. So
 * this groups by base language first (~75 entries); only languages with
 * more than one region get an extra step to narrow further before landing
 * on a specific voice.
 */
async function selectEnhancedVoice(): Promise<void> {
	let voices;
	try {
		voices = await listEnhancedVoices();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		void vscode.window.showWarningMessage(`Response Narrator: couldn't fetch Enhanced voices (${message}).`);
		return;
	}

	const currentVoice = getEnhancedVoiceSetting() || DEFAULT_ENHANCED_VOICE;
	const currentLocale = voices.find((v) => v.name === currentVoice)?.locale;
	const currentBaseLang = currentLocale ? baseLanguageOf(currentLocale) : undefined;

	const localesByBaseLang = new Map<string, string[]>();
	for (const locale of new Set(voices.map((v) => v.locale))) {
		const base = baseLanguageOf(locale);
		const list = localesByBaseLang.get(base);
		if (list) {
			list.push(locale);
		} else {
			localesByBaseLang.set(base, [locale]);
		}
	}

	const baseLangs = [...localesByBaseLang.keys()].sort((a, b) => {
		const aEn = a === 'en' ? 0 : 1;
		const bEn = b === 'en' ? 0 : 1;
		return aEn - bEn || localeDisplayName(a).localeCompare(localeDisplayName(b));
	});
	const pickedBaseLang = await vscode.window.showQuickPick(
		baseLangs.map((base) => {
			const regions = localesByBaseLang.get(base) ?? [];
			const voiceCount = voices.filter((v) => baseLanguageOf(v.locale) === base).length;
			return {
				label: base === currentBaseLang ? `$(check) ${localeDisplayName(base)}` : localeDisplayName(base),
				description: regions.length > 1 ? `${regions.length} regions · ${voiceCount} voice(s)` : `${voiceCount} voice(s)`,
				value: base
			};
		}),
		{ placeHolder: 'Response Narrator: Voice language' }
	);
	if (!pickedBaseLang) {
		return;
	}

	const regions = (localesByBaseLang.get(pickedBaseLang.value) ?? []).sort((a, b) =>
		localeDisplayName(a).localeCompare(localeDisplayName(b))
	);
	let resolvedLocale: string;
	if (regions.length > 1) {
		const pickedRegion = await vscode.window.showQuickPick(
			regions.map((locale) => ({
				label: locale === currentLocale ? `$(check) ${localeDisplayName(locale)}` : localeDisplayName(locale),
				description: `${locale} · ${voices.filter((v) => v.locale === locale).length} voice(s)`,
				value: locale
			})),
			{ placeHolder: `Response Narrator: Region — ${localeDisplayName(pickedBaseLang.value)}` }
		);
		if (!pickedRegion) {
			return;
		}
		resolvedLocale = pickedRegion.value;
	} else {
		resolvedLocale = regions[0];
	}

	const voicesInLocale = voices
		.filter((v) => v.locale === resolvedLocale)
		.sort((a, b) => a.friendlyName.localeCompare(b.friendlyName));
	const picked = await vscode.window.showQuickPick(
		voicesInLocale.map((v) => ({
			label: v.name === currentVoice ? `$(check) ${v.friendlyName}` : v.friendlyName,
			description: `${v.locale} · ${v.gender}`,
			value: v.name
		})),
		{ placeHolder: `Select an Enhanced voice — ${localeDisplayName(resolvedLocale)}` }
	);
	if (picked) {
		await vscode.workspace
			.getConfiguration(CONFIG_SECTION)
			.update('enhancedVoice', picked.value, vscode.ConfigurationTarget.Global);
	}
}

// Only the *initial* fetch (nothing has started playing yet) should show a
// loading state and block Play/Pause — once the first chunk is actually
// audible, later chunks fetching in the background shouldn't stop the user
// from pausing what's already playing.
function isLoading(): boolean {
	return pendingSynthesisCount > 0 && playbackState === 'idle';
}

/**
 * Tries Enhanced synthesis for `text`, tracking the loading indicator around
 * it; calls `onSuccess` with the audio on success, or `onFallback` (with the
 * System voice already resolved) if Enhanced failed. Shared between a fresh
 * utterance (queues) and a mid-utterance voice hand-off (replaces).
 */
async function synthesizeWithFallback(
	text: string,
	onSuccess: (base64: string, rate: number, words: WordBoundary[]) => void,
	onFallback: (rate: number, voice: string | undefined) => void,
	waitFor?: Promise<unknown>
): Promise<void> {
	const voice = getEnhancedVoiceSetting() || DEFAULT_ENHANCED_VOICE;
	pendingSynthesisCount++;
	updatePlaybackStatusBar();
	try {
		const { audio, words } = await synthesizeSpeech(text, voice);
		// The fetch can run concurrently with another part's, but firing the
		// callback (which enqueues to the webview) waits for `waitFor` so
		// playback order stays correct regardless of which request actually
		// resolves first.
		if (waitFor) {
			await waitFor.catch(() => undefined);
		}
		onSuccess(audio.toString('base64'), getRate(), words);
		enhancedFailureWarned = false;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('[Response Narrator] Enhanced voice failed:', err);
		outputChannel.appendLine(`Enhanced voice failed, falling back to System voice: ${message}`);
		if (!enhancedFailureWarned) {
			enhancedFailureWarned = true;
			void vscode.window.showWarningMessage(
				'Response Narrator: Enhanced voice is unavailable right now, falling back to System voice.'
			);
		}
		if (waitFor) {
			await waitFor.catch(() => undefined);
		}
		onFallback(getRate(), getVoiceSetting() || undefined);
	} finally {
		pendingSynthesisCount--;
		updatePlaybackStatusBar();
	}
}

async function speak(text: string): Promise<void> {
	if (getVoiceEngine() === 'enhanced') {
		const generation = speechGeneration;
		const chunks = splitIntoSpeechChunks(text);
		if (chunks.length > 1) {
			await speakEnhancedInChunks(chunks, generation);
			return;
		}
		await synthesizeWithFallback(
			text,
			(base64, rate, words) => {
				if (generation === speechGeneration) {
					speechPanel?.playAudio(base64, rate, text, words);
				}
			},
			(rate, voice) => {
				if (generation === speechGeneration) {
					speechPanel?.speak(text, { rate, voice });
				}
			}
		);
		return;
	}
	// The System engine has no network fetch to overlap, so unlike the
	// Enhanced path this can just enqueue each chunk in order with no
	// concurrency/ordering machinery — but it still needs chunking:
	// Windows' local speechSynthesis onboundary event is known to become
	// unreliable (sometimes freezing on one word) over one very long
	// utterance. Sentence-sized utterances keep boundary tracking accurate
	// and bound any staleness to at most one sentence.
	for (const chunk of splitIntoSpeechChunks(text)) {
		speechPanel?.speak(chunk, { rate: getRate(), voice: getVoiceSetting() || undefined });
	}
}

/**
 * Speaks a long response as a sequence of chunks (see
 * edgeTts.splitIntoSpeechChunks). Chunks are fetched via a sliding window
 * of at most MAX_CONCURRENT_ENHANCED_REQUESTS at a time — enough overlap to
 * keep ahead of playback without opening a request per chunk all at once —
 * but each chunk's enqueue is gated behind the previous chunk's, so
 * playback always stays in order regardless of which requests actually
 * resolve first. Each enqueue also checks `generation` is still current, so
 * a voice hand-off that supersedes this call stops it from continuing to
 * enqueue leftover chunks in the old voice.
 */
async function speakEnhancedInChunks(chunks: string[], generation: number): Promise<void> {
	let previousDone: Promise<unknown> = Promise.resolve();
	const allDone: Promise<unknown>[] = [];
	for (const chunk of chunks) {
		const gate = previousDone;
		const done = enhancedConcurrency.run(() =>
			synthesizeWithFallback(
				chunk,
				(base64, rate, words) => {
					if (generation === speechGeneration) {
						speechPanel?.playAudio(base64, rate, chunk, words);
					}
				},
				(rate, voice) => {
					if (generation === speechGeneration) {
						speechPanel?.speak(chunk, { rate, voice });
					}
				},
				gate
			)
		);
		allDone.push(done);
		previousDone = done;
	}
	await Promise.all(allDone);
}

/**
 * Fetches fresh Enhanced audio for a mid-utterance voice hand-off (see
 * SpeechPanel.notifyEnhancedVoiceChanged). The remainder can be as long as
 * the rest of the response, so it's chunked the same way a fresh utterance
 * would be — the first chunk replaces what's currently playing, the rest
 * enqueue normally behind it.
 */
async function handleResynthesis(token: number, text: string): Promise<void> {
	const generation = speechGeneration;
	const chunks = splitIntoSpeechChunks(text);
	let previousDone: Promise<unknown> = Promise.resolve();
	const allDone: Promise<unknown>[] = [];
	chunks.forEach((chunk, index) => {
		const gate = previousDone;
		const isFirst = index === 0;
		const done = enhancedConcurrency.run(() =>
			synthesizeWithFallback(
				chunk,
				(base64, rate, words) => {
					if (generation !== speechGeneration) {
						return;
					}
					if (isFirst) {
						speechPanel?.provideResynthesizedAudio(token, base64, rate, chunk, words);
					} else {
						speechPanel?.playAudio(base64, rate, chunk, words);
					}
				},
				(rate, voice) => {
					if (generation !== speechGeneration) {
						return;
					}
					if (isFirst) {
						speechPanel?.provideResynthesizedFallback(token, chunk, rate, voice);
					} else {
						speechPanel?.speak(chunk, { rate, voice });
					}
				},
				gate
			)
		);
		allDone.push(done);
		previousDone = done;
	});
	await Promise.all(allDone);
}

function getPlaybackMode(): 'auto' | 'manual' {
	return vscode.workspace.getConfiguration(CONFIG_SECTION).get<'auto' | 'manual'>('playbackMode', 'auto');
}

function getVoiceEngine(): 'system' | 'enhanced' {
	return vscode.workspace.getConfiguration(CONFIG_SECTION).get<'system' | 'enhanced'>('voiceEngine', 'system');
}

function getRate(): number {
	return vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>('rate', 1);
}

function getVoiceSetting(): string {
	return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('voice', '');
}

function getEnhancedVoiceSetting(): string {
	return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('enhancedVoice', '');
}

function resetResponseBuffers(): void {
	currentResponseChunks = [];
	lastCompletedResponse = undefined;
}

function updateMenuStatusBar(): void {
	const mode = getPlaybackMode() === 'auto' ? 'Auto' : 'Manual';
	const engine = getVoiceEngine();
	const voiceLabel =
		engine === 'enhanced' ? getEnhancedVoiceSetting() || DEFAULT_ENHANCED_VOICE : getVoiceSetting() || 'System default';
	menuStatusBarItem.tooltip = `Response Narrator settings — Playback: ${mode}, Engine: ${
		engine === 'enhanced' ? 'Enhanced' : 'System'
	}, Voice: ${voiceLabel}, Speed: ${getRate()}x`;
}

function updatePlaybackStatusBar(): void {
	if (isLoading()) {
		playbackStatusBarItem.text = '$(loading~spin) Loading';
		playbackStatusBarItem.tooltip = 'Response Narrator: fetching Enhanced voice audio...';
		return;
	}
	const mode = getPlaybackMode();
	if (playbackState === 'speaking') {
		playbackStatusBarItem.text = '$(debug-pause) Pause';
		playbackStatusBarItem.tooltip = 'Response Narrator: pause playback';
		return;
	}
	// Paused and idle share the same icon per mode — pausing always returns
	// to the mode's "at rest" icon, and clicking it again resumes rather
	// than restarting (only idle-with-nothing-paused starts fresh).
	if (mode === 'auto') {
		playbackStatusBarItem.text = '$(live-share) Auto';
		playbackStatusBarItem.tooltip =
			playbackState === 'paused'
				? 'Response Narrator: resume playback'
				: 'Response Narrator: auto-narrating new responses. Click to pause.';
	} else {
		playbackStatusBarItem.text = '$(play) Play';
		playbackStatusBarItem.tooltip =
			playbackState === 'paused' ? 'Response Narrator: resume playback' : 'Response Narrator: play the last response';
	}
}
