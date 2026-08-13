import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { WordBoundary } from './edgeTts';

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

	readonly onDidChangeState = this.stateEmitter.event;
	/** Diagnostics from inside the webview (e.g. audio playback errors) that wouldn't otherwise be visible. */
	readonly onDidLog = this.logEmitter.event;
	/** Fires when Chromium blocked audio playback pending a real click inside the panel. */
	readonly onDidRequireUnlock = this.needsUnlockEmitter.event;
	/** Fires when the webview needs fresh Enhanced audio for a mid-utterance voice hand-off (see notifyEnhancedVoiceChanged). */
	readonly onDidRequestResynthesis = this.resynthesisEmitter.event;

	constructor(private readonly context: vscode.ExtensionContext) {
		context.subscriptions.push(this.stateEmitter, this.logEmitter, this.needsUnlockEmitter, this.resynthesisEmitter);
	}

	/** Brings the panel to the foreground, e.g. so the user can click it to unlock audio playback. */
	reveal(): void {
		this.panel?.reveal(undefined, false);
	}

	speak(text: string, options: SpeakOptions = {}): void {
		const panel = this.ensurePanel();
		void panel.webview.postMessage({ type: 'speak', text, rate: options.rate, voice: options.voice });
	}

	/**
	 * Marks the start of a new response in the persistent transcript, before
	 * its first chunk is spoken — the panel has no other way to tell "this
	 * next chunk begins a new response" apart from "another chunk of the
	 * one already in progress", since chunk messages (speak/playAudio)
	 * carry no such distinction themselves.
	 */
	notifyNewResponse(): void {
		void this.panel?.webview.postMessage({ type: 'newResponse' });
	}

	/** Queues pre-synthesized audio (base64-encoded) for playback, e.g. from the Enhanced engine. */
	playAudio(base64Data: string, rate: number | undefined, text: string, words: WordBoundary[] = []): void {
		const panel = this.ensurePanel();
		void panel.webview.postMessage({ type: 'playAudio', base64: base64Data, rate, text, words });
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
		const panel = vscode.window.createWebviewPanel(
			'responseNarrator.speech',
			'Response Narrator',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
			{ enableScripts: true, retainContextWhenHidden: true }
		);
		panel.webview.html = buildHtml();
		panel.webview.onDidReceiveMessage(
			(message: {
				type?: string;
				voices?: VoiceInfo[];
				state?: PlaybackState;
				message?: string;
				token?: number;
				text?: string;
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
		return panel;
	}
}

function buildHtml(): string {
	const nonce = crypto.randomBytes(16).toString('base64');
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; media-src data:;">
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
  #textDisplay .response-entry:not(:first-child) {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px dashed var(--vscode-panel-border, #3c3c3c);
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
    padding-top: 0.85rem;
    border-top: 1px solid var(--vscode-panel-border, #3c3c3c);
  }
  #status { opacity: 0.8; }
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
  <p>Response Narrator is active.</p>
  <p id="status">Idle.</p>
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

  // Bounded history of responses so the transcript stays persistent and
  // clickable (see replayFromWord) instead of being wiped on every new
  // chunk, while capping DOM/memory growth over a long session.
  const MAX_HISTORY_RESPONSES = 5;
  const responseHistory = [];
  let currentResponseEntry = null;

  function startNewResponseEntry() {
    const entryEl = document.createElement('div');
    entryEl.className = 'response-entry';
    textDisplayEl.appendChild(entryEl);
    currentResponseEntry = { el: entryEl, items: [] };
    responseHistory.push(currentResponseEntry);
    while (responseHistory.length > MAX_HISTORY_RESPONSES) {
      const oldest = responseHistory.shift();
      oldest.el.remove();
    }
  }

  // Defensive fallback for the (should-be-impossible) case a chunk arrives
  // before the extension host's first 'newResponse' signal.
  function ensureCurrentResponseEntry() {
    if (!currentResponseEntry) {
      startNewResponseEntry();
    }
    return currentResponseEntry;
  }

  // Renders item.text as a sequence of per-word span elements (splitting on
  // whitespace, preserving it as plain text nodes between them) so live
  // highlighting is just toggling a class on the right span instead of
  // re-rendering text on every word boundary. Appends into the current
  // response's own container rather than replacing #textDisplay's content,
  // so earlier chunks/responses stay visible. Each span carries a direct
  // back-reference to the item and its own index for click-to-replay.
  function renderTextWithWordSpans(item) {
    const entry = ensureCurrentResponseEntry();
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
    // Separates this chunk from whatever's appended next — chunks otherwise
    // have no whitespace between them since splitIntoSpeechChunks trims each.
    container.appendChild(document.createTextNode(' '));
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

  function enqueue(item) {
    queue.push(item);
    if (!current && !paused) {
      speakNext();
    }
  }

  // Click-to-replay: stops whatever's currently playing (without touching
  // the transcript itself) and plays this chunk from the clicked word
  // onward, then continues into the rest of its response's already-
  // rendered chunks (entry.items, in original order) the same way it would
  // have played through them the first time — otherwise clicking a word
  // near the start of a response would replay just that one chunk and
  // stop, leaving the rest of the response unspoken. Chunks still waiting
  // in the global queue (not yet rendered/played) are untouched: they're
  // disjoint from entry.items and keep their place after the resumed ones.
  function replayFromWord(item, wordIndex) {
    speakToken++;
    const token = speakToken;
    stopHighlightPoll();
    speechSynthesis.cancel();
    if (audioEl && !audioEl.paused) {
      audioEl.pause();
    }
    paused = false;
    current = item;
    item.suppressAdvance = false;

    const entry = item._responseEntry;
    if (entry) {
      const idx = entry.items.indexOf(item);
      if (idx !== -1) {
        queue.unshift(...entry.items.slice(idx + 1));
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
      startNewResponseEntry();
    } else if (message.type === 'speak') {
      enqueue({ kind: 'tts', text: message.text, rate: message.rate, voice: message.voice, charIndex: 0 });
    } else if (message.type === 'playAudio') {
      enqueue({ kind: 'audio', base64: message.base64, rate: message.rate, text: message.text, words: message.words || [], pausedOffset: 0 });
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
    }
  });
})();
</script>
</body>
</html>`;
}
