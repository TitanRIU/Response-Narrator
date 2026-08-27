import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { WordBoundary, EnhancedVoiceInfo } from './edgeTts';

export interface VoiceInfo {
	name: string;
	lang: string;
	default: boolean;
}

export type PlaybackState = 'idle' | 'speaking' | 'paused';

interface SpeakOptions {
	rate?: number;
	voice?: string;
}

/**
 * Owns a webview panel that plays speech two ways: the browser's built-in
 * speechSynthesis API (System engine, zero dependencies, instant, offline),
 * or pre-synthesized audio bytes played through the Web Audio API (Enhanced
 * engine — e.g. Microsoft Edge's neural TTS, fetched by the extension host
 * and handed to the webview as base64). The panel is created lazily and
 * kept unobtrusive: it opens in the active editor group without stealing
 * focus, and retains its JS context while not the visible tab so speech
 * keeps playing in the background.
 *
 * Pause/resume delegate to native pause()/resume() for the System engine so
 * "picks up where it left off" is the browser's own behavior, not something
 * hand-rolled. Rate/voice for the System engine are locked onto a
 * SpeechSynthesisUtterance the moment it starts — there's no way to retune
 * audio already in flight — so a live settings change instead cancels the
 * in-progress utterance and immediately re-speaks just its unspoken
 * remainder (tracked via the `boundary` event) with the new settings.
 *
 * The Enhanced engine plays through a single persistent `<audio>` element
 * routed into the AudioContext graph via `createMediaElementSource` (see
 * getSharedAudioElement), rather than decoding each response into an
 * AudioBuffer and playing it through a fresh AudioBufferSourceNode. Two
 * reasons: `<audio>` exposes `preservesPitch`, so speeding up playback no
 * longer raises pitch the way AudioBufferSourceNode's naive resampling did;
 * and routing it through the same AudioContext that gets unlocked by one
 * click keeps the one-time-unlock behavior — once `ctx.resume()` has
 * succeeded from a real click, calling `.play()` on the connected element
 * keeps working with no further clicks, the same as raw buffer playback
 * did. Rate changes are still instant and live (`audioEl.playbackRate`),
 * and native `.currentTime`/`.pause()`/`.play()` replace the manual
 * playStartedAt/playOffsetAtStart bookkeeping the old approach needed to
 * simulate pause/resume and word-highlight timing.
 */
export class SpeechPanel {
	private panel: vscode.WebviewPanel | undefined;
	private pendingVoicesResolve: ((voices: VoiceInfo[]) => void) | undefined;
	private readonly stateEmitter = new vscode.EventEmitter<PlaybackState>();
	private readonly logEmitter = new vscode.EventEmitter<string>();
	private readonly needsUnlockEmitter = new vscode.EventEmitter<void>();
	private readonly resynthesisEmitter = new vscode.EventEmitter<{ token: number; text: string }>();
	private readonly playPauseEmitter = new vscode.EventEmitter<void>();
	private readonly stopEmitter = new vscode.EventEmitter<void>();
	private readonly setRateEmitter = new vscode.EventEmitter<number>();
	private readonly setEngineEmitter = new vscode.EventEmitter<'system' | 'enhanced'>();
	private readonly setModeEmitter = new vscode.EventEmitter<'auto' | 'manual'>();
	private readonly requestEnhancedVoicesEmitter = new vscode.EventEmitter<void>();
	private readonly setVoiceEmitter = new vscode.EventEmitter<{ engine: 'system' | 'enhanced'; voice: string }>();

	readonly onDidChangeState = this.stateEmitter.event;
	/** Diagnostics from inside the webview (e.g. audio playback errors) that wouldn't otherwise be visible. */
	readonly onDidLog = this.logEmitter.event;
	/** Fires when Chromium blocked audio playback pending a real click inside the panel. */
	readonly onDidRequireUnlock = this.needsUnlockEmitter.event;
	/** Fires when the webview needs fresh Enhanced audio for a mid-utterance voice hand-off (see notifyEnhancedVoiceChanged). */
	readonly onDidRequestResynthesis = this.resynthesisEmitter.event;
	/** Fires when the panel's own Play/Pause button is clicked — same action as the status bar/keybinding. */
	readonly onDidRequestPlayPause = this.playPauseEmitter.event;
	/** Fires when the panel's own Stop button is clicked. */
	readonly onDidRequestStop = this.stopEmitter.event;
	/** Fires when the panel's speed control changes, with the newly picked rate. */
	readonly onDidRequestSetRate = this.setRateEmitter.event;
	/** Fires when the panel's engine control changes, with the newly picked engine. */
	readonly onDidRequestSetEngine = this.setEngineEmitter.event;
	/** Fires when the panel's playback-mode control changes, with the newly picked mode. */
	readonly onDidRequestSetMode = this.setModeEmitter.event;
	/** Fires when the panel's own Voice popup needs the Enhanced voice list (fetched once, cached in the webview). */
	readonly onDidRequestEnhancedVoices = this.requestEnhancedVoicesEmitter.event;
	/** Fires when a voice is picked from the panel's own Voice popup. */
	readonly onDidRequestSetVoice = this.setVoiceEmitter.event;

	constructor(private readonly context: vscode.ExtensionContext) {
		context.subscriptions.push(
			this.stateEmitter,
			this.logEmitter,
			this.needsUnlockEmitter,
			this.resynthesisEmitter,
			this.playPauseEmitter,
			this.stopEmitter,
			this.setRateEmitter,
			this.setEngineEmitter,
			this.setModeEmitter,
			this.requestEnhancedVoicesEmitter,
			this.setVoiceEmitter
		);
	}

	/** Brings the panel to the foreground, e.g. so the user can click it to unlock audio playback. */
	reveal(): void {
		this.panel?.reveal(undefined, false);
	}

	/** Opens the panel (creating it if needed) and brings it to the foreground, e.g. from the status bar item. */
	open(): void {
		this.ensurePanel().reveal(undefined, false);
	}

	/**
	 * `responseId` (see notifyNewResponse) tells the panel which response's
	 * transcript card this chunk belongs to, since — for the Enhanced engine
	 * — chunk fetches from different responses run concurrently and can
	 * resolve out of order: without an explicit id, a response's slow-to-
	 * arrive last chunk could land after the next response's first chunk has
	 * already switched the panel's "current card", and get appended to the
	 * wrong one.
	 */
	speak(text: string, options: SpeakOptions, responseId: number): void {
		const panel = this.ensurePanel();
		void panel.webview.postMessage({ type: 'speak', text, rate: options.rate, voice: options.voice, responseId });
	}

	/**
	 * Marks the start of a new response in the persistent transcript, before
	 * its first chunk is spoken — the panel has no other way to tell "this
	 * next chunk begins a new response" apart from "another chunk of the one
	 * already in progress". `responseId` is a caller-assigned id (extension.ts
	 * increments a counter) that every speak()/playAudio() call for this
	 * response must then be tagged with, so the panel can route each chunk to
	 * the right transcript card even if chunks from different responses
	 * arrive out of order (see speak's doc).
	 */
	notifyNewResponse(responseId: number): void {
		void this.panel?.webview.postMessage({ type: 'newResponse', responseId });
	}

	/** Queues pre-synthesized audio (base64-encoded) for playback, e.g. from the Enhanced engine. See speak's doc for `responseId`. */
	playAudio(base64Data: string, rate: number | undefined, text: string, words: WordBoundary[], responseId: number): void {
		const panel = this.ensurePanel();
		void panel.webview.postMessage({ type: 'playAudio', base64: base64Data, rate, text, words, responseId });
	}

	/**
	 * Tells the webview the Enhanced voice setting changed. If something is
	 * actively playing an Enhanced utterance (not paused), it estimates how
	 * far in it is, stops it, and requests fresh audio for just the
	 * remainder via onDidRequestResynthesis — see class doc for why this
	 * can't be instant like the System engine's restart.
	 */
	notifyEnhancedVoiceChanged(): void {
		void this.panel?.webview.postMessage({ type: 'enhancedVoiceChanged' });
	}

	/** Supplies freshly-synthesized Enhanced audio for a hand-off requested via onDidRequestResynthesis. */
	provideResynthesizedAudio(token: number, base64Data: string, rate: number | undefined, text: string, words: WordBoundary[] = []): void {
		void this.panel?.webview.postMessage({ type: 'resynthesizedAudio', token, base64: base64Data, rate, text, words });
	}

	/** Supplies a System-voice fallback for a hand-off whose Enhanced resynthesis failed. */
	provideResynthesizedFallback(token: number, text: string, rate: number | undefined, voice: string | undefined): void {
		void this.panel?.webview.postMessage({ type: 'resynthesizedFallback', token, text, rate, voice });
	}

	pause(): void {
		void this.panel?.webview.postMessage({ type: 'pause' });
	}

	resume(): void {
		void this.panel?.webview.postMessage({ type: 'resume' });
	}

	/** Applies a rate/voice change immediately where possible (see class doc). */
	updateSettings(options: SpeakOptions): void {
		void this.panel?.webview.postMessage({ type: 'updateSettings', rate: options.rate, voice: options.voice });
	}

	/** Syncs the panel's own speed/engine/mode controls to the current settings, e.g. after a change made via the settings menu. */
	updateControlBar(info: { engine: 'system' | 'enhanced'; rate: number; mode: 'auto' | 'manual'; voice: string }): void {
		void this.panel?.webview.postMessage({
			type: 'updateControlBar',
			engine: info.engine,
			rate: info.rate,
			mode: info.mode,
			voice: info.voice
		});
	}

	/** Supplies the full Enhanced voice list for the panel's own Voice popup to group/search client-side (see onDidRequestEnhancedVoices). */
	provideEnhancedVoices(voices: EnhancedVoiceInfo[]): void {
		void this.panel?.webview.postMessage({ type: 'enhancedVoices', voices });
	}

	/** Reports an Enhanced voice list fetch failure to the panel's own Voice popup. */
	provideEnhancedVoicesError(message: string): void {
		void this.panel?.webview.postMessage({ type: 'enhancedVoicesError', message });
	}

	/**
	 * Restarts the most recently rendered response from its own beginning,
	 * reusing its existing transcript card and (for Enhanced) its
	 * already-fetched audio, instead of fetching/rendering a duplicate one —
	 * for a "play last response" press that isn't actually new content (see
	 * playLastResponse in extension.ts).
	 */
	restartLastResponse(): void {
		void this.panel?.webview.postMessage({ type: 'restartLastResponse' });
	}

	/** Hard stop: cancels and clears the queue, not resumable. */
	stop(): void {
		void this.panel?.webview.postMessage({ type: 'stop' });
		this.stateEmitter.fire('idle');
	}

	async getVoices(): Promise<VoiceInfo[]> {
		const panel = this.ensurePanel();
		return new Promise<VoiceInfo[]>((resolve) => {
			const timeout = setTimeout(() => {
				this.pendingVoicesResolve = undefined;
				resolve([]);
			}, 3000);
			this.pendingVoicesResolve = (voices) => {
				clearTimeout(timeout);
				resolve(voices);
			};
			void panel.webview.postMessage({ type: 'getVoices' });
		});
	}

	dispose(): void {
		this.panel?.dispose();
		this.panel = undefined;
	}

	private ensurePanel(): vscode.WebviewPanel {
		if (this.panel) {
			return this.panel;
		}
		const codiconsDir = vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist');
		const panel = vscode.window.createWebviewPanel(
			'responseNarrator.speech',
			'Response Narrator',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
			{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [codiconsDir] }
		);
		const codiconCssUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(codiconsDir, 'codicon.css'));
		panel.webview.html = buildHtml(panel.webview.cspSource, codiconCssUri.toString());
		panel.webview.onDidReceiveMessage(
			(message: {
				type?: string;
				voices?: VoiceInfo[];
				state?: PlaybackState;
				message?: string;
				token?: number;
				text?: string;
				rate?: number;
				engine?: 'system' | 'enhanced';
				mode?: 'auto' | 'manual';
				voice?: string;
			}) => {
				if (message?.type === 'voices' && this.pendingVoicesResolve) {
					const resolve = this.pendingVoicesResolve;
					this.pendingVoicesResolve = undefined;
					resolve(message.voices ?? []);
				} else if (message?.type === 'playbackState' && message.state) {
					this.stateEmitter.fire(message.state);
				} else if (message?.type === 'log' && message.message) {
					this.logEmitter.fire(message.message);
				} else if (message?.type === 'needsUnlock') {
					this.needsUnlockEmitter.fire();
				} else if (message?.type === 'requestResynthesis' && message.token !== undefined && message.text) {
					this.resynthesisEmitter.fire({ token: message.token, text: message.text });
				} else if (message?.type === 'controlPlayPause') {
					this.playPauseEmitter.fire();
				} else if (message?.type === 'controlStop') {
					this.stopEmitter.fire();
				} else if (message?.type === 'controlSetRate' && message.rate !== undefined) {
					this.setRateEmitter.fire(message.rate);
				} else if (message?.type === 'controlSetEngine' && message.engine) {
					this.setEngineEmitter.fire(message.engine);
				} else if (message?.type === 'controlSetMode' && message.mode) {
					this.setModeEmitter.fire(message.mode);
				} else if (message?.type === 'requestEnhancedVoices') {
					this.requestEnhancedVoicesEmitter.fire();
				} else if (message?.type === 'controlSetVoice' && message.engine && message.voice) {
					this.setVoiceEmitter.fire({ engine: message.engine, voice: message.voice });
				}
			},
			undefined,
			this.context.subscriptions
		);
		panel.onDidDispose(
			() => {
				this.panel = undefined;
			},
			undefined,
			this.context.subscriptions
		);
		this.panel = panel;
		const config = vscode.workspace.getConfiguration('response-narrator');
		const initialEngine = config.get<'system' | 'enhanced'>('voiceEngine', 'system');
		this.updateControlBar({
			engine: initialEngine,
			rate: config.get<number>('rate', 1),
			mode: config.get<'auto' | 'manual'>('playbackMode', 'auto'),
			voice: config.get<string>(initialEngine === 'enhanced' ? 'enhancedVoice' : 'voice', '')
		});
		return panel;
	}
}

function buildHtml(cspSource: string, codiconCssUri: string): string {
	const nonce = crypto.randomBytes(16).toString('base64');
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' ${cspSource}; font-src ${cspSource}; media-src data:;">
<link rel="stylesheet" href="${codiconCssUri}">
<title>Response Narrator</title>
<style>
  html, body { height: 100%; }
  body {
    font-family: var(--vscode-font-family, sans-serif);
    color: var(--vscode-foreground);
    margin: 0;
    padding: 1rem;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
  }
  #textDisplay {
    flex: 1 1 auto;
    min-height: 0;
    margin: 0 -1rem 0 0;
    padding-right: 1rem;
    overflow-y: auto;
    line-height: 1.7;
    font-size: 0.95rem;
    white-space: pre-wrap;
  }
  #textDisplay:empty { display: none; }
  #textDisplay .response-entry {
    padding: 0.7rem 0.9rem;
    border-radius: 6px;
    background: rgba(127, 127, 127, 0.07);
  }
  #textDisplay .response-entry + .response-entry {
    margin-top: 0.6rem;
  }
  #textDisplay .word {
    cursor: pointer;
    border-radius: 3px;
  }
  #textDisplay .word:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.1));
  }
  #textDisplay .word.current-word {
    background: var(--vscode-editor-selectionBackground, #264f78);
    border-radius: 3px;
  }
  #statusBar {
    flex-shrink: 0;
    margin-top: 0.85rem;
    padding: 0.7rem 0.85rem;
    border-radius: 8px;
    border: 1px solid var(--vscode-input-border, transparent);
    background: var(--vscode-input-background, #3c3c3c);
  }
  #statusRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  #transportButtons {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.3rem;
  }
  #optionsRow {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.9rem;
    margin-top: 0.7rem;
  }
  #statusBar button {
    flex-shrink: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-foreground);
    font-family: inherit;
    font-size: 0.95rem;
    line-height: 1;
    padding: 0.3rem;
    opacity: 0.8;
    cursor: pointer;
  }
  #statusBar button:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.08));
  }
  #statusBar #playPauseBtn,
  #statusBar #stopBtn,
  #statusBar #skipBackBtn,
  #statusBar #skipForwardBtn {
    opacity: 1;
    width: 1.8rem;
    height: 1.8rem;
    padding: 0;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  #statusBar #playPauseBtn {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
  }
  #statusBar #playPauseBtn:hover {
    background: var(--vscode-button-hoverBackground, #1177bb);
  }
  #statusBar #stopBtn,
  #statusBar #skipBackBtn,
  #statusBar #skipForwardBtn {
    background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.08));
    color: var(--vscode-foreground);
  }
  #statusBar #stopBtn:hover,
  #statusBar #skipBackBtn:hover,
  #statusBar #skipForwardBtn:hover {
    background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.14));
  }
  #optionsRow .ctrl-icon {
    flex-shrink: 0;
    opacity: 0.7;
    font-size: 14px;
  }
  #statusBar button .codicon {
    font-size: 14px;
    vertical-align: text-bottom;
  }
  #optionsRow .ctrl-trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    border-radius: 4px;
    padding: 0.15rem 0.35rem;
    opacity: 0.85;
    font-size: 0.85rem;
    max-width: 9rem;
  }
  #optionsRow .ctrl-trigger > span:not(.ctrl-icon) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #optionsRow .ctrl-trigger:hover {
    opacity: 1;
  }
  #optionsRow .ctrl-trigger.open {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.08));
  }
  #status { opacity: 0.7; margin: 0; font-size: 0.9rem; }
  .ctrl-popup {
    position: fixed;
    z-index: 100;
    display: flex;
    flex-direction: column;
    width: 15.5rem;
    max-height: 20rem;
    border-radius: 8px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #454545));
    background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background, #252526));
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    overflow: hidden;
  }
  .ctrl-popup-header {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    gap: 0.3rem;
    padding: 0.5rem 0.7rem;
    font-size: 0.8rem;
    font-weight: 600;
    opacity: 0.75;
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #454545));
  }
  .ctrl-popup-back {
    flex-shrink: 0;
    display: inline-flex;
    border: none;
    background: transparent;
    color: var(--vscode-foreground);
    padding: 0.1rem;
    margin: -0.1rem 0;
    border-radius: 3px;
    cursor: pointer;
  }
  .ctrl-popup-back:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.08));
  }
  .ctrl-popup-search {
    flex-shrink: 0;
    margin: 0.4rem 0.6rem;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, inherit);
    font-family: inherit;
    font-size: 0.85rem;
  }
  .ctrl-popup-list {
    overflow-y: auto;
    padding: 0.25rem;
  }
  .ctrl-popup-empty, .ctrl-popup-loading, .ctrl-popup-error {
    padding: 0.6rem 0.7rem;
    font-size: 0.85rem;
    opacity: 0.7;
  }
  .ctrl-popup-item {
    display: flex;
    align-items: center;
    width: 100%;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--vscode-foreground);
    font-family: inherit;
    text-align: left;
    cursor: pointer;
  }
  .ctrl-popup-item:hover {
    background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.08));
  }
  .ctrl-popup-item.checked {
    background: var(--vscode-list-inactiveSelectionBackground, rgba(255, 255, 255, 0.06));
  }
  .ctrl-popup-item .codicon:first-child {
    flex-shrink: 0;
    opacity: 0.8;
    margin-top: 0.15rem;
  }
  .ctrl-popup-item-spacer {
    flex-shrink: 0;
    width: 16px;
  }
  .ctrl-popup-item-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .ctrl-popup-item-label {
    font-size: 0.85rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ctrl-popup-item-desc {
    font-size: 0.75rem;
    opacity: 0.65;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ctrl-popup-item .codicon-check {
    flex-shrink: 0;
    opacity: 0.85;
  }
  body.needs-unlock { cursor: pointer; }
  #unlockPrompt {
    display: none;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-top: 0.85rem;
    padding: 0.85rem 1rem;
    border: 1px solid var(--vscode-notificationsWarningIcon-foreground, #cca700);
    border-radius: 4px;
    background: var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.1));
  }
  body.needs-unlock #unlockPrompt { display: flex; }
  #unlockPrompt span { flex: 1; }
  #unlockPrompt button {
    flex-shrink: 0;
    padding: 0.4rem 1rem;
    border: none;
    border-radius: 3px;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
    font-weight: 600;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
  }
  #unlockPrompt button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
</style>
</head>
<body>
<div id="textDisplay"></div>
<div id="statusBar">
  <div id="statusRow">
    <p id="status">Idle.</p>
    <div id="transportButtons">
      <button id="skipBackBtn" type="button" title="Previous section"><span class="codicon codicon-chevron-left"></span></button>
      <button id="playPauseBtn" type="button" title="Play"><span id="playPauseIcon" class="codicon codicon-play"></span></button>
      <button id="skipForwardBtn" type="button" title="Next section"><span class="codicon codicon-chevron-right"></span></button>
      <button id="stopBtn" type="button" title="Stop"><span class="codicon codicon-debug-stop"></span></button>
    </div>
  </div>
  <div id="optionsRow">
    <button id="rateBtn" type="button" class="ctrl-trigger" title="Speed">
      <span class="ctrl-icon codicon codicon-dashboard" aria-hidden="true"></span>
      <span id="rateBtnLabel">1x</span>
    </button>
    <button id="engineBtn" type="button" class="ctrl-trigger" title="Voice Engine">
      <span id="engineBtnIcon" class="ctrl-icon codicon codicon-device-desktop" aria-hidden="true"></span>
      <span id="engineBtnLabel">System</span>
    </button>
    <button id="voiceBtn" type="button" class="ctrl-trigger" title="Choose voice">
      <span class="ctrl-icon codicon codicon-person-voice" aria-hidden="true"></span>
      <span id="voiceBtnLabel">Voice…</span>
    </button>
    <button id="modeBtn" type="button" class="ctrl-trigger" title="Playback">
      <span id="modeBtnIcon" class="ctrl-icon codicon codicon-zap" aria-hidden="true"></span>
      <span id="modeBtnLabel">Auto</span>
    </button>
  </div>
  <div id="unlockPrompt">
    <span>Would you like to enable Enhanced voice for Response Narrator?</span>
    <button id="enableButton" type="button">Enable</button>
  </div>
</div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const statusEl = document.getElementById('status');
  const textDisplayEl = document.getElementById('textDisplay');
  const skipBackBtn = document.getElementById('skipBackBtn');
  const playPauseBtn = document.getElementById('playPauseBtn');
  const playPauseIcon = document.getElementById('playPauseIcon');
  const skipForwardBtn = document.getElementById('skipForwardBtn');
  const stopBtn = document.getElementById('stopBtn');
  const rateBtn = document.getElementById('rateBtn');
  const rateBtnLabel = document.getElementById('rateBtnLabel');
  const engineBtn = document.getElementById('engineBtn');
  const engineBtnIcon = document.getElementById('engineBtnIcon');
  const engineBtnLabel = document.getElementById('engineBtnLabel');
  const voiceBtn = document.getElementById('voiceBtn');
  const voiceBtnLabel = document.getElementById('voiceBtnLabel');
  const modeBtn = document.getElementById('modeBtn');
  const modeBtnIcon = document.getElementById('modeBtnIcon');
  const modeBtnLabel = document.getElementById('modeBtnLabel');

  playPauseBtn.addEventListener('click', () => vscode.postMessage({ type: 'controlPlayPause' }));
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'controlStop' }));
  // Skip Back/Forward are purely local to the webview (no extension-host
  // round trip like Play/Stop) — see skipBy/skipToItem below.
  skipBackBtn.addEventListener('click', () => skipBy(-1));
  skipForwardBtn.addEventListener('click', () => skipBy(1));

  // Current values, kept in sync via the 'updateControlBar' message (see
  // extension.ts) — used to show a checkmark on the right option and (for
  // rate/engine/mode) the trigger button's own label.
  let currentRate = 1;
  let currentEngine = 'system';
  let currentMode = 'auto';
  let currentVoice = '';

  const RATE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const ENGINE_OPTIONS = [
    { value: 'system', label: 'System', icon: 'device-desktop', description: 'Built-in OS voices, instant, works offline' },
    { value: 'enhanced', label: 'Enhanced', icon: 'rocket', description: 'Higher-quality neural voices via Microsoft Edge, requires network' }
  ];
  const MODE_OPTIONS = [
    { value: 'auto', label: 'Auto', icon: 'zap', description: 'Read new responses automatically as they arrive' },
    { value: 'manual', label: 'Manual', icon: 'cursor', description: 'Only read when you press play' }
  ];

  // Generic popup menu (Speed/Engine/Mode/Voice all use this) — a small,
  // positioned card of icon+label(+description) rows, closer to how the
  // Claude Code chat panel's own mode picker looks than a native <select>.
  let activePopup = null;

  function closePopup() {
    if (!activePopup) {
      return;
    }
    activePopup.trigger.classList.remove('open');
    activePopup.el.remove();
    document.removeEventListener('mousedown', activePopup.onOutside, true);
    document.removeEventListener('keydown', activePopup.onKey, true);
    activePopup = null;
  }

  function positionPopup(popupEl, anchorEl) {
    const anchorRect = anchorEl.getBoundingClientRect();
    const popupRect = popupEl.getBoundingClientRect();
    const gap = 6;
    let left = anchorRect.left;
    if (left + popupRect.width > window.innerWidth - 8) {
      left = window.innerWidth - popupRect.width - 8;
    }
    if (left < 8) {
      left = 8;
    }
    let top = anchorRect.top - popupRect.height - gap;
    if (top < 8) {
      top = anchorRect.bottom + gap;
    }
    popupEl.style.left = left + 'px';
    popupEl.style.top = top + 'px';
  }

  // opts: { title, items: [{value,label,description,icon,checked}],
  //   searchable, loading, error, onSelect(value), onBack() }
  function openPopup(anchorEl, opts) {
    closePopup();
    anchorEl.classList.add('open');

    const popup = document.createElement('div');
    popup.className = 'ctrl-popup';

    const header = document.createElement('div');
    header.className = 'ctrl-popup-header';
    if (opts.onBack) {
      const backBtn = document.createElement('button');
      backBtn.type = 'button';
      backBtn.className = 'ctrl-popup-back';
      const backIcon = document.createElement('span');
      backIcon.className = 'codicon codicon-chevron-left';
      backBtn.appendChild(backIcon);
      backBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        opts.onBack();
      });
      header.appendChild(backBtn);
    }
    const titleEl = document.createElement('span');
    titleEl.textContent = opts.title;
    header.appendChild(titleEl);
    popup.appendChild(header);

    let searchInput = null;
    if (opts.searchable) {
      searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.placeholder = 'Search…';
      searchInput.className = 'ctrl-popup-search';
      popup.appendChild(searchInput);
    }

    const list = document.createElement('div');
    list.className = 'ctrl-popup-list';
    popup.appendChild(list);

    function renderList() {
      list.textContent = '';
      if (opts.loading) {
        const el = document.createElement('div');
        el.className = 'ctrl-popup-loading';
        el.textContent = 'Loading…';
        list.appendChild(el);
        return;
      }
      if (opts.error) {
        const el = document.createElement('div');
        el.className = 'ctrl-popup-error';
        el.textContent = opts.error;
        list.appendChild(el);
        return;
      }
      const filterText = searchInput ? searchInput.value.trim().toLowerCase() : '';
      const items = filterText
        ? opts.items.filter((it) => it.label.toLowerCase().indexOf(filterText) !== -1)
        : opts.items;
      if (items.length === 0) {
        const el = document.createElement('div');
        el.className = 'ctrl-popup-empty';
        el.textContent = 'No matches.';
        list.appendChild(el);
        return;
      }
      items.forEach((item) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'ctrl-popup-item' + (item.checked ? ' checked' : '');
        if (item.icon) {
          const icon = document.createElement('span');
          icon.className = 'codicon codicon-' + item.icon;
          row.appendChild(icon);
        } else {
          const spacer = document.createElement('span');
          spacer.className = 'ctrl-popup-item-spacer';
          row.appendChild(spacer);
        }
        const text = document.createElement('span');
        text.className = 'ctrl-popup-item-text';
        const label = document.createElement('span');
        label.className = 'ctrl-popup-item-label';
        label.textContent = item.label;
        text.appendChild(label);
        if (item.description) {
          const desc = document.createElement('span');
          desc.className = 'ctrl-popup-item-desc';
          desc.textContent = item.description;
          text.appendChild(desc);
        }
        row.appendChild(text);
        if (item.checked) {
          const check = document.createElement('span');
          check.className = 'codicon codicon-check';
          row.appendChild(check);
        }
        row.addEventListener('click', () => opts.onSelect(item.value));
        list.appendChild(row);
      });
    }
    renderList();
    if (searchInput) {
      searchInput.addEventListener('input', renderList);
      searchInput.addEventListener('click', (e) => e.stopPropagation());
    }

    document.body.appendChild(popup);
    positionPopup(popup, anchorEl);
    if (searchInput) {
      searchInput.focus();
    }

    const onOutside = (e) => {
      if (!popup.contains(e.target) && !anchorEl.contains(e.target)) {
        closePopup();
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        closePopup();
      }
    };
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);

    activePopup = { el: popup, trigger: anchorEl, onOutside: onOutside, onKey: onKey };
    return activePopup;
  }

  function isPopupOpenFor(anchorEl) {
    return !!activePopup && activePopup.trigger === anchorEl;
  }

  rateBtn.addEventListener('click', () => {
    if (isPopupOpenFor(rateBtn)) {
      closePopup();
      return;
    }
    openPopup(rateBtn, {
      title: 'Speed',
      items: RATE_OPTIONS.map((r) => ({ value: String(r), label: r + 'x', checked: r === currentRate })),
      onSelect: (value) => {
        closePopup();
        vscode.postMessage({ type: 'controlSetRate', rate: parseFloat(value) });
      }
    });
  });

  engineBtn.addEventListener('click', () => {
    if (isPopupOpenFor(engineBtn)) {
      closePopup();
      return;
    }
    openPopup(engineBtn, {
      title: 'Voice Engine',
      items: ENGINE_OPTIONS.map((o) => ({
        value: o.value,
        label: o.label,
        icon: o.icon,
        description: o.description,
        checked: o.value === currentEngine
      })),
      onSelect: (value) => {
        closePopup();
        vscode.postMessage({ type: 'controlSetEngine', engine: value });
      }
    });
  });

  modeBtn.addEventListener('click', () => {
    if (isPopupOpenFor(modeBtn)) {
      closePopup();
      return;
    }
    openPopup(modeBtn, {
      title: 'Playback',
      items: MODE_OPTIONS.map((o) => ({
        value: o.value,
        label: o.label,
        icon: o.icon,
        description: o.description,
        checked: o.value === currentMode
      })),
      onSelect: (value) => {
        closePopup();
        vscode.postMessage({ type: 'controlSetMode', mode: value });
      }
    });
  });

  // --- Voice popup: a flat searchable list for System, a language/region/
  // voice drill-down for Enhanced (300+ voices across 140+ locales fetched
  // once from the extension host and cached here — see requestEnhancedVoices
  // below — then grouped/searched entirely client-side for instant
  // navigation between levels, mirroring extension.ts's own QuickPick-based
  // selectEnhancedVoice, just rendered as this panel's popup instead). ---
  let enhancedVoicesCache = null;
  let enhancedVoicesFetchError = null;
  let localeDisplayNamesInstance = null;

  function baseLanguageOf(locale) {
    return locale.split('-')[0];
  }

  function localeDisplayName(locale) {
    try {
      localeDisplayNamesInstance = localeDisplayNamesInstance || new Intl.DisplayNames(['en'], { type: 'language' });
      return localeDisplayNamesInstance.of(locale) || locale;
    } catch (e) {
      return locale;
    }
  }

  // Enhanced's raw voice names (e.g. "en-GB-RyanNeural") aren't friendly for
  // the trigger label — swap in the friendlyName once the voice list has
  // been fetched at least once (see the 'enhancedVoices' message handler).
  function friendlyVoiceLabel(voice) {
    if (!voice) {
      return 'Voice…';
    }
    if (currentEngine === 'enhanced' && enhancedVoicesCache) {
      const match = enhancedVoicesCache.find((v) => v.name === voice);
      if (match) {
        return match.friendlyName;
      }
    }
    return voice;
  }

  function openSystemVoicePopup() {
    const voices = speechSynthesis.getVoices();
    const items = voices.map((v) => ({
      value: v.name,
      label: v.name,
      description: v.lang + (v.default ? ' (default)' : ''),
      checked: v.name === currentVoice
    }));
    openPopup(voiceBtn, {
      title: 'Voice',
      searchable: items.length > 8,
      items: items,
      onSelect: (value) => {
        closePopup();
        vscode.postMessage({ type: 'controlSetVoice', engine: 'system', voice: value });
      }
    });
  }

  function groupEnhancedVoicesByBaseLanguage() {
    const localesByBaseLang = new Map();
    const locales = [];
    enhancedVoicesCache.forEach((v) => {
      if (locales.indexOf(v.locale) === -1) {
        locales.push(v.locale);
      }
    });
    locales.forEach((locale) => {
      const base = baseLanguageOf(locale);
      if (!localesByBaseLang.has(base)) {
        localesByBaseLang.set(base, []);
      }
      localesByBaseLang.get(base).push(locale);
    });
    return localesByBaseLang;
  }

  function renderEnhancedLanguageLevel() {
    const localesByBaseLang = groupEnhancedVoicesByBaseLanguage();
    const currentEntry = enhancedVoicesCache.find((v) => v.name === currentVoice);
    const currentBaseLang = currentEntry ? baseLanguageOf(currentEntry.locale) : undefined;
    const baseLangs = [...localesByBaseLang.keys()].sort((a, b) => {
      const aEn = a === 'en' ? 0 : 1;
      const bEn = b === 'en' ? 0 : 1;
      return aEn - bEn || localeDisplayName(a).localeCompare(localeDisplayName(b));
    });
    const items = baseLangs.map((base) => {
      const regions = localesByBaseLang.get(base);
      const voiceCount = enhancedVoicesCache.filter((v) => baseLanguageOf(v.locale) === base).length;
      return {
        value: base,
        label: localeDisplayName(base),
        description: regions.length > 1 ? regions.length + ' regions · ' + voiceCount + ' voice(s)' : voiceCount + ' voice(s)',
        checked: base === currentBaseLang
      };
    });
    openPopup(voiceBtn, {
      title: 'Voice — Language',
      searchable: true,
      items: items,
      onSelect: (base) => {
        const regions = localesByBaseLang.get(base).slice().sort((a, b) => localeDisplayName(a).localeCompare(localeDisplayName(b)));
        if (regions.length > 1) {
          renderEnhancedRegionLevel(base, regions);
        } else {
          renderEnhancedVoiceLevel(regions[0], base, regions);
        }
      }
    });
  }

  function renderEnhancedRegionLevel(base, regions) {
    const currentEntry = enhancedVoicesCache.find((v) => v.name === currentVoice);
    const currentLocale = currentEntry ? currentEntry.locale : undefined;
    const items = regions.map((locale) => ({
      value: locale,
      label: localeDisplayName(locale),
      description: locale + ' · ' + enhancedVoicesCache.filter((v) => v.locale === locale).length + ' voice(s)',
      checked: locale === currentLocale
    }));
    openPopup(voiceBtn, {
      title: 'Voice — ' + localeDisplayName(base),
      searchable: items.length > 8,
      items: items,
      onBack: renderEnhancedLanguageLevel,
      onSelect: (locale) => renderEnhancedVoiceLevel(locale, base, regions)
    });
  }

  function renderEnhancedVoiceLevel(locale, base, regions) {
    const voicesInLocale = enhancedVoicesCache
      .filter((v) => v.locale === locale)
      .slice()
      .sort((a, b) => a.friendlyName.localeCompare(b.friendlyName));
    const items = voicesInLocale.map((v) => ({
      value: v.name,
      label: v.friendlyName,
      description: v.locale + ' · ' + v.gender,
      checked: v.name === currentVoice
    }));
    openPopup(voiceBtn, {
      title: 'Voice — ' + localeDisplayName(locale),
      searchable: items.length > 8,
      items: items,
      onBack: () => {
        if (regions.length > 1) {
          renderEnhancedRegionLevel(base, regions);
        } else {
          renderEnhancedLanguageLevel();
        }
      },
      onSelect: (voiceName) => {
        closePopup();
        vscode.postMessage({ type: 'controlSetVoice', engine: 'enhanced', voice: voiceName });
      }
    });
  }

  function openEnhancedVoicePopup() {
    if (enhancedVoicesFetchError) {
      openPopup(voiceBtn, { title: 'Voice', items: [], error: enhancedVoicesFetchError });
      return;
    }
    if (!enhancedVoicesCache) {
      openPopup(voiceBtn, { title: 'Voice', items: [], loading: true });
      vscode.postMessage({ type: 'requestEnhancedVoices' });
      return;
    }
    renderEnhancedLanguageLevel();
  }

  voiceBtn.addEventListener('click', () => {
    if (isPopupOpenFor(voiceBtn)) {
      closePopup();
      return;
    }
    if (currentEngine === 'enhanced') {
      openEnhancedVoicePopup();
    } else {
      openSystemVoicePopup();
    }
  });

  // Bounded history of responses so the transcript stays persistent and
  // clickable (see replayFromWord) instead of being wiped on every new
  // chunk, while capping DOM/memory growth over a long session.
  const MAX_HISTORY_RESPONSES = 5;
  const responseHistory = [];
  let currentResponseEntry = null;

  function startNewResponseEntry(responseId) {
    const entryEl = document.createElement('div');
    entryEl.className = 'response-entry';
    textDisplayEl.appendChild(entryEl);
    currentResponseEntry = { el: entryEl, items: [], responseId: responseId };
    responseHistory.push(currentResponseEntry);
    while (responseHistory.length > MAX_HISTORY_RESPONSES) {
      const oldest = responseHistory.shift();
      oldest.el.remove();
    }
    return currentResponseEntry;
  }

  // Looks up the entry a chunk belongs to by the responseId its speak/
  // playAudio message carried, rather than trusting "whatever entry is
  // current right now" — needed because, for the Enhanced engine, one
  // response's chunk fetches can still be in flight when the next response's
  // own first chunk already arrived and switched currentResponseEntry, so a
  // late chunk could otherwise land in the wrong (next) response's card.
  // Falls back to "current, creating one if needed" for the id-less/
  // should-be-impossible case of a chunk arriving before any 'newResponse',
  // or for a response so old its entry already aged out of responseHistory.
  function getEntryForResponse(responseId) {
    if (responseId !== undefined) {
      for (let i = responseHistory.length - 1; i >= 0; i--) {
        if (responseHistory[i].responseId === responseId) {
          return responseHistory[i];
        }
      }
    }
    return currentResponseEntry || startNewResponseEntry(responseId);
  }

  // Renders item.text as a sequence of per-word span elements (splitting on
  // whitespace, preserving it as plain text nodes between them) so live
  // highlighting is just toggling a class on the right span instead of
  // re-rendering text on every word boundary. Appends into this item's own
  // response's container (see getEntryForResponse) rather than replacing
  // #textDisplay's content, so earlier chunks/responses stay visible. Each
  // span carries a direct back-reference to the item and its own index for
  // click-to-replay.
  function renderTextWithWordSpans(item) {
    const entry = getEntryForResponse(item.responseId);
    const container = entry.el;
    item._responseEntry = entry;
    entry.items.push(item);
    const text = item.text || '';
    const spans = [];
    const wordRegex = /\\S+/g;
    let match;
    let lastIndex = 0;
    while ((match = wordRegex.exec(text))) {
      if (match.index > lastIndex) {
        container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const span = document.createElement('span');
      span.className = 'word';
      span.textContent = match[0];
      span._replayItem = item;
      span._replayIndex = spans.length;
      container.appendChild(span);
      spans.push({ start: match.index, end: match.index + match[0].length, el: span });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      container.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    // Separates this chunk from whatever's appended next with a paragraph
    // break (rendered thanks to #textDisplay's white-space: pre-wrap) rather
    // than a single space, so a multi-chunk response reads as distinct
    // chunks instead of one run-on paragraph. Chunks otherwise have no
    // whitespace between them since splitIntoSpeechChunks trims each.
    container.appendChild(document.createTextNode('\\n\\n'));
    item.wordSpans = spans;
    return spans;
  }

  // Removes this item's not-yet-spoken spans (start >= charIndex) from the
  // transcript. Used before Enhanced mid-utterance voice resynthesis, whose
  // new word-boundary timings are relative to the new remainder text, not
  // the original item's — so the old "remainder" spans can't just be
  // reused/re-highlighted the way the System engine's offset-based replay
  // (see replayFromWord/startTts) can, and would otherwise appear twice
  // once the resynthesized remainder's own spans get appended after it.
  function removeUnspokenSpansFrom(item, charIndex) {
    if (!item.wordSpans) {
      return;
    }
    const keep = [];
    for (const s of item.wordSpans) {
      if (s.start >= charIndex) {
        s.el.remove();
      } else {
        keep.push(s);
      }
    }
    item.wordSpans = keep;
  }

  function clearAnyCurrentWordHighlight() {
    const el = textDisplayEl.querySelector('.word.current-word');
    if (el) {
      el.classList.remove('current-word');
    }
  }

  function setCurrentWordSpan(item, target) {
    const stale = textDisplayEl.querySelectorAll('.word.current-word');
    for (const el of stale) {
      if (!target || el !== target.el) {
        el.classList.remove('current-word');
      }
    }
    if (target && !target.el.classList.contains('current-word')) {
      target.el.classList.add('current-word');
      target.el.scrollIntoView({ block: 'nearest' });
    }
  }

  // System engine: speechSynthesis's onboundary event gives a character
  // index directly, so the matching span is found by offset comparison.
  function highlightWordAt(item, charIndex) {
    if (!item.wordSpans) {
      return;
    }
    const target =
      item.wordSpans.find((s) => charIndex >= s.start && charIndex < s.end) ||
      item.wordSpans.find((s) => s.start >= charIndex);
    setCurrentWordSpan(item, target);
  }

  // Enhanced engine: there's no per-word event during playback, only a list
  // of {text, offsetSeconds, durationSeconds} timings fetched alongside the
  // audio. item.words and item.wordSpans are built from the same source
  // text and so line up index-for-index (barring a rare tokenization
  // mismatch, guarded by clamping to the shorter of the two below); the
  // current word is whichever one's offset the playback clock has reached.
  function highlightWordAtTime(item, audioTimeSeconds) {
    if (!item.words || !item.wordSpans) {
      return;
    }
    const count = Math.min(item.words.length, item.wordSpans.length);
    let index = -1;
    for (let i = 0; i < count; i++) {
      if (audioTimeSeconds >= item.words[i].offsetSeconds) {
        index = i;
      } else {
        break;
      }
    }
    if (index === -1) {
      return;
    }
    setCurrentWordSpan(item, item.wordSpans[index]);
  }

  // Self-managed queue (rather than relying on speechSynthesis's own
  // multi-utterance queue) so a live settings change can splice a new
  // remainder item in at the front instead of only affecting whatever
  // hasn't started yet. Items are either { kind: 'tts', text, rate, voice }
  // (System engine) or { kind: 'audio', text, base64, rate, pausedOffset }
  // (Enhanced engine, played through the shared <audio> element — text is
  // kept around so a mid-utterance voice change can estimate a remainder).
  const queue = [];
  let current = null;
  let audioCtx = null;
  // Single <audio> element reused for every Enhanced item, routed through
  // audioCtx via createMediaElementSource — see getSharedAudioElement.
  let audioEl = null;
  let paused = false;
  // Bumped every time we deliberately move on to a new item, so a
  // cancel()'d/replaced item's onend/onerror (which may fire asynchronously,
  // after we've already started the next one ourselves) can recognize it's
  // stale and no-op instead of double-advancing the queue.
  let speakToken = 0;
  // Set while waiting on a click (either the Enable button or anywhere else
  // in the panel) to unlock the AudioContext — see playAudioItem.
  let pendingUnlockRetry = null;
  // Only announce the unlock prompt once per panel lifetime, same as the
  // unlock itself — otherwise a chunked response stuck waiting on Enable
  // would re-trigger it on every chunk and talk over itself.
  let unlockAnnounced = false;
  // Polls playback position for Enhanced-engine word highlighting, since
  // (unlike SpeechSynthesisUtterance) Web Audio API playback has no
  // per-word event to react to.
  let highlightPollHandle = null;

  function stopHighlightPoll() {
    if (highlightPollHandle !== null) {
      clearInterval(highlightPollHandle);
      highlightPollHandle = null;
    }
  }

  function startHighlightPoll(item, token) {
    stopHighlightPoll();
    if (!item.words || item.words.length === 0) {
      return;
    }
    highlightPollHandle = setInterval(() => {
      if (token !== speakToken || paused || !audioEl) {
        return;
      }
      // audioEl.currentTime already reflects playbackRate correctly on its
      // own — unlike AudioBufferSourceNode, which had no exposed playback
      // position at all and needed elapsed-time-times-rate math against
      // AudioContext's own clock to approximate it.
      highlightWordAtTime(item, audioEl.currentTime);
    }, 80);
  }

  function getAudioContext() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtx;
  }

  // Created once and reused for every Enhanced item (swapping .src rather
  // than creating a new element/node per item — a MediaElementAudioSourceNode
  // can only ever be created once per element). Routing it through the same
  // AudioContext that gets unlocked by one click is what lets later
  // utterances play with no further clicks, the same as the old raw-buffer
  // approach — see class doc.
  function getSharedAudioElement() {
    if (!audioEl) {
      audioEl = new Audio();
      audioEl.preservesPitch = true;
      if ('webkitPreservesPitch' in audioEl) {
        audioEl.webkitPreservesPitch = true;
      }
      const ctx = getAudioContext();
      const mediaSourceNode = ctx.createMediaElementSource(audioEl);
      mediaSourceNode.connect(ctx.destination);
    }
    return audioEl;
  }

  function currentState() {
    if (paused) return 'paused';
    if (current) return 'speaking';
    return 'idle';
  }

  function reportState() {
    const state = currentState();
    statusEl.textContent =
      state === 'speaking' ? 'Speaking (' + queue.length + ' more queued)...' :
      state === 'paused' ? 'Paused.' :
      'Idle.';
    playPauseIcon.className = 'codicon ' + (state === 'speaking' ? 'codicon-debug-pause' : 'codicon-play');
    playPauseBtn.title = state === 'speaking' ? 'Pause' : state === 'paused' ? 'Resume' : 'Play last response';
    vscode.postMessage({ type: 'playbackState', state: state });
  }

  // speakOffset > 0 means "continue this same item from partway through"
  // (a live rate/voice change mid-utterance, or a transcript click) rather
  // than a fresh chunk: item.wordSpans already exists and is reused as-is
  // (no re-render, so the already-visible transcript isn't touched), only
  // the remainder text from that offset is actually spoken, and the
  // utterance's own onboundary charIndex — relative to that remainder — is
  // shifted back into the original item.text's coordinate space before
  // highlighting, so it still resolves to the correct span in the reused
  // (unshifted) wordSpans array.
  function startTts(item, token, speakOffset) {
    const offset = speakOffset || 0;
    if (!item.wordSpans) {
      renderTextWithWordSpans(item);
    }
    const utterance = new SpeechSynthesisUtterance(offset > 0 ? item.text.slice(offset) : item.text);
    if (item.rate) {
      utterance.rate = item.rate;
    }
    if (item.voice) {
      const match = speechSynthesis.getVoices().find((v) => v.name === item.voice);
      if (match) {
        utterance.voice = match;
      }
    }
    utterance.onboundary = (e) => {
      if (token !== speakToken) {
        return;
      }
      if (e.name && e.name !== 'word') {
        return;
      }
      item.charIndex = e.charIndex + offset;
      highlightWordAt(item, item.charIndex);
    };
    utterance.onstart = reportState;
    utterance.onend = () => { if (token === speakToken) { current = null; speakNext(); } };
    utterance.onerror = () => { if (token === speakToken) { current = null; speakNext(); } };
    speechSynthesis.speak(utterance);
  }

  function playAudioItem(item, token, offsetSeconds) {
    const ctx = getAudioContext();
    const el = getSharedAudioElement();
    const play = () => {
      item.suppressAdvance = false;
      el.onended = () => {
        if (token === speakToken && !item.suppressAdvance) {
          current = null;
          speakNext();
        }
      };
      // Waits for loadedmetadata (rather than seeking/playing immediately)
      // so the offsetSeconds seek below is honored reliably once duration
      // is actually known, and so a load failure is caught distinctly from
      // a playback failure.
      const onReady = () => {
        cleanup();
        if (token !== speakToken) {
          return;
        }
        el.playbackRate = item.rate || 1;
        if (offsetSeconds > 0) {
          el.currentTime = offsetSeconds;
        }
        startHighlightPoll(item, token);
        document.body.classList.remove('needs-unlock');
        reportState();
        el.play().catch((err) => {
          if (token !== speakToken) {
            return;
          }
          vscode.postMessage({ type: 'log', message: 'Enhanced audio playback failed: ' + (err && err.message ? err.message : err) });
          current = null;
          speakNext();
        });
      };
      const onLoadError = () => {
        cleanup();
        if (token !== speakToken) {
          return;
        }
        vscode.postMessage({ type: 'log', message: 'Enhanced audio failed to load' + (el.error ? ': ' + el.error.message : '') });
        current = null;
        speakNext();
      };
      function cleanup() {
        el.removeEventListener('loadedmetadata', onReady);
        el.removeEventListener('error', onLoadError);
      }
      el.addEventListener('loadedmetadata', onReady, { once: true });
      el.addEventListener('error', onLoadError, { once: true });
      el.src = 'data:audio/mpeg;base64,' + item.base64;
    };

    if (ctx.state === 'suspended') {
      // Only needs to happen once per panel lifetime — resume() moves the
      // context to 'running' permanently, and el.play() keeps working with
      // no further clicks as long as el stays routed through this same
      // context (see getSharedAudioElement / class doc).
      document.body.classList.add('needs-unlock');
      vscode.postMessage({ type: 'needsUnlock' });
      if (!unlockAnnounced) {
        unlockAnnounced = true;
        // Bypasses the app's own queue deliberately: the queue's current
        // slot is already held by this blocked Enhanced item, so anything
        // enqueued normally would just wait behind it forever instead of
        // playing now, when it's actually needed. speechSynthesis itself
        // isn't subject to the same autoplay block as AudioContext, so this
        // plays immediately without needing its own unlock.
        speechSynthesis.speak(new SpeechSynthesisUtterance(
          'To use the Enhanced voice feature, click Enable on the Response Narrator panel.'
        ));
      }
      // Idempotent regardless of which click fires it (the Enable button or
      // anywhere else in the panel) — clears itself immediately so the
      // other one becomes a no-op instead of resuming/playing twice.
      const attemptUnlock = () => {
        if (pendingUnlockRetry !== attemptUnlock) {
          return;
        }
        pendingUnlockRetry = null;
        document.body.removeEventListener('click', attemptUnlock);
        // Cuts off the spoken announcement immediately if Enable is clicked
        // before it finishes, so it can't overlap with the Enhanced audio
        // that's about to start. Safe to call unconditionally here: the
        // app's own queue can't have a legitimate System-voice item playing
        // at this point, since current is the blocked Enhanced item.
        speechSynthesis.cancel();
        ctx.resume().then(() => {
          if (token === speakToken) {
            play();
          }
        });
      };
      pendingUnlockRetry = attemptUnlock;
      document.body.addEventListener('click', attemptUnlock, { once: true });
    } else {
      play();
    }
  }

  function startAudio(item, token) {
    if (!item.wordSpans) {
      renderTextWithWordSpans(item);
    }
    playAudioItem(item, token, 0);
  }

  function speakNext() {
    speakToken++;
    stopHighlightPoll();
    if (queue.length === 0) {
      current = null;
      paused = false;
      clearAnyCurrentWordHighlight();
      reportState();
      return;
    }
    current = queue.shift();
    current.charIndex = 0;
    if (current.kind === 'audio') {
      startAudio(current, speakToken);
    } else {
      startTts(current, speakToken);
    }
    reportState();
  }

  // Renders the item into the transcript immediately, regardless of whether
  // anything is currently playing or paused — otherwise text arriving while
  // paused (or while playback is still working through an earlier backlog)
  // wouldn't show up until its turn to actually be spoken, well after it was
  // received. startTts/startAudio's own wordSpans-presence check means this
  // render is never repeated once the item's turn to play actually comes.
  function enqueue(item) {
    if (!item.wordSpans) {
      renderTextWithWordSpans(item);
    }
    queue.push(item);
    if (!current && !paused) {
      speakNext();
    }
  }

  // Shared setup for handing playback over to a specific item: cancels
  // whatever's currently playing, clears the paused flag, pulls the item out
  // of the queue if it was already sitting there, and takes it over as
  // current. Returns the fresh token to start playback with. Used by both
  // replayFromWord (click a word) and skipToItem (Skip Back/Forward) — they
  // differ only in which items get queued up to resume with afterward.
  function takeOverPlayback(item) {
    speakToken++;
    const token = speakToken;
    stopHighlightPoll();
    speechSynthesis.cancel();
    if (audioEl && !audioEl.paused) {
      audioEl.pause();
    }
    paused = false;
    item.suppressAdvance = false;

    const queuedIdx = queue.indexOf(item);
    if (queuedIdx !== -1) {
      queue.splice(queuedIdx, 1);
    }
    current = item;
    return token;
  }

  // Click-to-replay: stops whatever's currently playing (without touching
  // the transcript itself) and plays this chunk from the clicked word
  // onward, then continues into the rest of its response's chunks
  // (entry.items, in original order) the same way it would have played
  // through them the first time — otherwise clicking a word near the start
  // of a response would replay just that one chunk and stop, leaving the
  // rest of the response unspoken. Since chunks are now rendered as soon as
  // they arrive (see enqueue) rather than only once played, entry.items can
  // include chunks still sitting unplayed in the global queue — those are
  // filtered out of the resumed set (they'll play in their existing turn).
  function replayFromWord(item, wordIndex) {
    const token = takeOverPlayback(item);

    const entry = item._responseEntry;
    if (entry) {
      const idx = entry.items.indexOf(item);
      if (idx !== -1) {
        const resumeItems = entry.items.slice(idx + 1).filter((it) => !queue.includes(it));
        queue.unshift(...resumeItems);
      }
    }

    if (item.kind === 'audio') {
      const word = item.words && item.words[wordIndex];
      playAudioItem(item, token, word ? word.offsetSeconds : 0);
    } else {
      const span = item.wordSpans && item.wordSpans[wordIndex];
      startTts(item, token, span ? span.start : 0);
    }
  }

  // Flattens every rendered chunk across the visible response history
  // (oldest to newest) into one list — the same "sub-sections" the
  // transcript itself shows. This is the timeline Skip Back/Forward step
  // through, unlike click-to-replay, which deliberately stays within one
  // response.
  function getFlatItems() {
    const items = [];
    for (const entry of responseHistory) {
      items.push(...entry.items);
    }
    return items;
  }

  // Jumps playback to the very start of the given item, then queues whatever
  // comes after it across the whole flattened history (not just its own
  // response) so playback continues naturally past a response boundary.
  function skipToItem(item) {
    const token = takeOverPlayback(item);

    const flat = getFlatItems();
    const idx = flat.indexOf(item);
    if (idx !== -1) {
      const resumeItems = flat.slice(idx + 1).filter((it) => !queue.includes(it));
      queue.unshift(...resumeItems);
    }

    if (item.kind === 'audio') {
      playAudioItem(item, token, 0);
    } else {
      startTts(item, token, 0);
    }
  }

  // Moves to the next/previous chunk relative to whatever's currently
  // playing (or, if paused, about to resume). No-ops at either end of the
  // flattened history. When nothing is playing/queued at all (e.g. right
  // after Stop, or playback simply ran out at the end) there's no "current"
  // position to step from — Skip Back falls back to replaying the last
  // rendered sub-section instead (the same "previous track on a stopped
  // player" expectation most media controls have); Skip Forward has no
  // equivalent obvious target from idle, so it stays a no-op.
  function skipBy(direction) {
    const reference = current || queue[0];
    if (!reference) {
      if (direction < 0) {
        const flat = getFlatItems();
        const last = flat[flat.length - 1];
        if (last) {
          skipToItem(last);
        }
      }
      return;
    }
    const flat = getFlatItems();
    const idx = flat.indexOf(reference);
    if (idx === -1) {
      return;
    }
    const target = flat[idx + direction];
    if (!target) {
      return;
    }
    skipToItem(target);
  }

  textDisplayEl.addEventListener('click', (e) => {
    const span = e.target.closest ? e.target.closest('.word') : null;
    if (!span || !span._replayItem) {
      return;
    }
    replayFromWord(span._replayItem, span._replayIndex);
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'newResponse') {
      startNewResponseEntry(message.responseId);
    } else if (message.type === 'speak') {
      enqueue({ kind: 'tts', text: message.text, rate: message.rate, voice: message.voice, charIndex: 0, responseId: message.responseId });
    } else if (message.type === 'playAudio') {
      enqueue({ kind: 'audio', base64: message.base64, rate: message.rate, text: message.text, words: message.words || [], pausedOffset: 0, responseId: message.responseId });
    } else if (message.type === 'enhancedVoiceChanged') {
      if (current && current.kind === 'audio' && !paused) {
        const elapsed = audioEl ? audioEl.currentTime : 0;
        const duration = audioEl && Number.isFinite(audioEl.duration) ? audioEl.duration : 0;
        const text = current.text || '';
        let charIndex = duration > 0 ? Math.round(text.length * Math.min(1, elapsed / duration)) : 0;
        // Bias back to the start of the current word so a mistimed estimate
        // repeats a word rather than risking skipping one.
        const before = text.slice(0, charIndex).replace(/\\s+$/, '');
        const lastSpace = before.lastIndexOf(' ');
        charIndex = lastSpace >= 0 ? lastSpace + 1 : 0;
        const remainder = text.slice(charIndex).trim();

        // Anything already queued — fetched and waiting to play — still has
        // the OLD voice baked into its audio, since it was synthesized
        // before this change. Collect its original text too so the whole
        // rest of the response gets re-spoken in the new voice, not just
        // the one sentence that was interrupted.
        const queuedText = queue.map((item) => item.text).filter(Boolean).join(' ');
        const combined = [remainder, queuedText].filter((s) => s.length > 0).join(' ');

        if (combined.length > 0) {
          // The resynthesized remainder's word-boundary timings will be
          // relative to itself, not this item's original text, so its
          // spans can't be reused/re-highlighted the way a same-engine
          // replay can — remove the not-yet-spoken portion now so the
          // fresh spans rendered for the resynthesized remainder (see the
          // resynthesizedAudio handler) don't end up duplicating it.
          removeUnspokenSpansFrom(current, charIndex);
          current.suppressAdvance = true;
          if (audioEl) {
            audioEl.pause();
          }
          queue.length = 0;
          speakToken++; // invalidate anything still arriving from before this change
          vscode.postMessage({ type: 'requestResynthesis', token: speakToken, text: combined });
        }
      }
    } else if (message.type === 'resynthesizedAudio') {
      if (message.token !== speakToken || !current) {
        return; // superseded (stopped/replaced again) while resynthesizing
      }
      current.kind = 'audio';
      current.text = message.text;
      current.rate = message.rate;
      current.base64 = message.base64;
      current.words = message.words || [];
      startAudio(current, speakToken);
    } else if (message.type === 'resynthesizedFallback') {
      if (message.token !== speakToken || !current) {
        return;
      }
      current.kind = 'tts';
      current.text = message.text;
      current.rate = message.rate;
      current.voice = message.voice;
      current.charIndex = 0;
      startTts(current, speakToken);
    } else if (message.type === 'pause') {
      if (current && current.kind === 'audio' && audioEl && !audioEl.paused) {
        // audioEl.currentTime is always accurate regardless of playbackRate,
        // unlike the old ctx.currentTime-based estimate it replaces.
        current.pausedOffset = audioEl.currentTime;
        current.suppressAdvance = true;
        audioEl.pause();
        stopHighlightPoll();
      } else {
        speechSynthesis.pause();
      }
      paused = true;
      reportState();
    } else if (message.type === 'resume') {
      if (current && current.kind === 'audio') {
        playAudioItem(current, speakToken, current.pausedOffset || 0);
      } else {
        speechSynthesis.resume();
      }
      paused = false;
      reportState();
    } else if (message.type === 'updateSettings') {
      queue.forEach((item) => {
        item.rate = message.rate;
        if (item.kind === 'tts') {
          item.voice = message.voice;
        }
      });
      if (current && current.kind === 'audio') {
        current.rate = message.rate;
        if (audioEl) {
          // Live, instant — no restart needed, and preservesPitch keeps
          // this from raising pitch the way it used to (see class doc).
          audioEl.playbackRate = message.rate || 1;
        }
        // Voice changes apply to the next Enhanced utterance instead, since
        // a different voice means a different synthesized file that would
        // need a fresh network fetch to swap in.
      } else if (current && current.kind === 'tts') {
        // Reuses the same item (via startTts's speakOffset) rather than
        // splicing a new { text: remaining, ... } item into the queue —
        // that would render a second, fresh set of spans for the
        // remainder, duplicating it in the transcript alongside the
        // original item's still-visible (already-rendered) ones.
        const charOffset = current.charIndex || 0;
        const hasRemaining = current.text.slice(charOffset).trim().length > 0;
        const wasPaused = paused;
        current.rate = message.rate;
        current.voice = message.voice;
        speechSynthesis.cancel();
        speakToken++; // invalidate the interrupted utterance's onend/onerror
        if (hasRemaining) {
          startTts(current, speakToken, charOffset);
          if (wasPaused) {
            // Rebuild + start the replacement utterance, then immediately
            // re-suspend it — speak() always starts playing, there's no way
            // to hand the engine a paused utterance directly, so this is the
            // only way to swap settings without losing the pause.
            speechSynthesis.pause();
            paused = true;
          }
          reportState();
        } else {
          current = null;
          speakNext();
        }
      }
    } else if (message.type === 'stop') {
      queue.length = 0;
      if (current) {
        current.suppressAdvance = true;
      }
      current = null;
      paused = false;
      speechSynthesis.cancel();
      if (audioEl && !audioEl.paused) {
        audioEl.pause();
      }
      stopHighlightPoll();
      clearAnyCurrentWordHighlight();
      reportState();
    } else if (message.type === 'getVoices') {
      const collectVoices = () => new Promise((resolve) => {
        const existing = speechSynthesis.getVoices();
        if (existing.length > 0) {
          resolve(existing);
          return;
        }
        const onChange = () => {
          speechSynthesis.removeEventListener('voiceschanged', onChange);
          resolve(speechSynthesis.getVoices());
        };
        speechSynthesis.addEventListener('voiceschanged', onChange);
        setTimeout(() => {
          speechSynthesis.removeEventListener('voiceschanged', onChange);
          resolve(speechSynthesis.getVoices());
        }, 1000);
      });
      collectVoices().then((voices) => {
        vscode.postMessage({
          type: 'voices',
          voices: voices.map((v) => ({ name: v.name, lang: v.lang, default: v.default }))
        });
      });
    } else if (message.type === 'updateControlBar') {
      if (message.rate !== undefined) {
        currentRate = message.rate;
        rateBtnLabel.textContent = message.rate + 'x';
      }
      if (message.engine) {
        currentEngine = message.engine;
        engineBtnLabel.textContent = message.engine === 'enhanced' ? 'Enhanced' : 'System';
        engineBtnIcon.className = 'ctrl-icon codicon codicon-' + (message.engine === 'enhanced' ? 'rocket' : 'device-desktop');
      }
      if (message.mode) {
        currentMode = message.mode;
        modeBtnLabel.textContent = message.mode === 'auto' ? 'Auto' : 'Manual';
        modeBtnIcon.className = 'ctrl-icon codicon codicon-' + (message.mode === 'auto' ? 'zap' : 'cursor');
      }
      if (message.voice !== undefined) {
        currentVoice = message.voice;
        voiceBtnLabel.textContent = friendlyVoiceLabel(message.voice);
      }
    } else if (message.type === 'enhancedVoices') {
      enhancedVoicesCache = message.voices || [];
      enhancedVoicesFetchError = null;
      voiceBtnLabel.textContent = friendlyVoiceLabel(currentVoice);
      if (isPopupOpenFor(voiceBtn)) {
        renderEnhancedLanguageLevel();
      }
    } else if (message.type === 'enhancedVoicesError') {
      enhancedVoicesFetchError = message.message || 'Could not load Enhanced voices.';
      if (isPopupOpenFor(voiceBtn)) {
        openPopup(voiceBtn, { title: 'Voice', items: [], error: enhancedVoicesFetchError });
      }
    } else if (message.type === 'restartLastResponse') {
      const entry = responseHistory[responseHistory.length - 1];
      if (entry && entry.items.length > 0) {
        replayFromWord(entry.items[0], 0);
      }
    }
  });
})();
</script>
</body>
</html>`;
}
