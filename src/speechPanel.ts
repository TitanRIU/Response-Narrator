import * as vscode from 'vscode';
import * as crypto from 'crypto';

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
 * Owns a webview panel whose only job is to run the browser's speechSynthesis
 * API (VS Code's webview is Chromium-based, so this needs no extra
 * dependencies and works cross-platform). The panel is created lazily and
 * kept unobtrusive: it opens in the active editor group without stealing
 * focus, and retains its JS context while not the visible tab so speech
 * keeps playing in the background.
 *
 * Pause/resume delegate to the native speechSynthesis.pause()/resume() so
 * "picks up where it left off" is the browser's own behavior, not something
 * hand-rolled here. Rate/voice, however, are locked onto a
 * SpeechSynthesisUtterance the moment it starts — the API has no way to
 * retune audio already in flight — so a live settings change instead
 * cancels the in-progress utterance and immediately re-speaks just its
 * unspoken remainder (tracked via the `boundary` event) with the new
 * settings, which reads as a fast ramp rather than a hard wait-for-next-message.
 */
export class SpeechPanel {
	private panel: vscode.WebviewPanel | undefined;
	private pendingVoicesResolve: ((voices: VoiceInfo[]) => void) | undefined;
	private readonly stateEmitter = new vscode.EventEmitter<PlaybackState>();

	readonly onDidChangeState = this.stateEmitter.event;

	constructor(private readonly context: vscode.ExtensionContext) {
		context.subscriptions.push(this.stateEmitter);
	}

	speak(text: string, options: SpeakOptions = {}): void {
		const panel = this.ensurePanel();
		void panel.webview.postMessage({ type: 'speak', text, rate: options.rate, voice: options.voice });
	}

	pause(): void {
		void this.panel?.webview.postMessage({ type: 'pause' });
	}

	resume(): void {
		void this.panel?.webview.postMessage({ type: 'resume' });
	}

	/** Applies a rate/voice change immediately, mid-utterance if something is speaking. */
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
			(message: { type?: string; voices?: VoiceInfo[]; state?: PlaybackState }) => {
				if (message?.type === 'voices' && this.pendingVoicesResolve) {
					const resolve = this.pendingVoicesResolve;
					this.pendingVoicesResolve = undefined;
					resolve(message.voices ?? []);
				} else if (message?.type === 'playbackState' && message.state) {
					this.stateEmitter.fire(message.state);
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<title>Response Narrator</title>
<style>
  body { font-family: var(--vscode-font-family, sans-serif); padding: 1rem; color: var(--vscode-foreground); }
  #status { opacity: 0.8; }
</style>
</head>
<body>
<p>Response Narrator is active.</p>
<p id="status">Idle.</p>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const statusEl = document.getElementById('status');

  // Self-managed queue (rather than relying on speechSynthesis's own
  // multi-utterance queue) so a live settings change can splice a new
  // remainder utterance in at the front instead of only affecting whatever
  // hasn't started yet.
  const queue = [];
  let current = null; // { text, rate, voice, charIndex }
  let paused = false;
  // Bumped every time we deliberately move on to a new utterance, so a
  // cancel()'d utterance's onend/onerror (which may fire asynchronously,
  // after we've already started the next one ourselves) can recognize it's
  // stale and no-op instead of double-advancing the queue.
  let speakToken = 0;

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

  function buildUtterance(item, token) {
    const utterance = new SpeechSynthesisUtterance(item.text);
    if (item.rate) {
      utterance.rate = item.rate;
    }
    if (item.voice) {
      const match = speechSynthesis.getVoices().find((v) => v.name === item.voice);
      if (match) {
        utterance.voice = match;
      }
    }
    utterance.onboundary = (e) => { item.charIndex = e.charIndex; };
    utterance.onstart = reportState;
    utterance.onend = () => { if (token === speakToken) { current = null; speakNext(); } };
    utterance.onerror = () => { if (token === speakToken) { current = null; speakNext(); } };
    return utterance;
  }

  function speakNext() {
    speakToken++;
    if (queue.length === 0) {
      current = null;
      // Nothing left to pause/resume, however we got here.
      paused = false;
      reportState();
      return;
    }
    current = queue.shift();
    current.charIndex = 0;
    speechSynthesis.speak(buildUtterance(current, speakToken));
    reportState();
  }

  function enqueue(text, rate, voice) {
    queue.push({ text: text, rate: rate, voice: voice, charIndex: 0 });
    if (!current && !paused) {
      speakNext();
    }
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'speak') {
      enqueue(message.text, message.rate, message.voice);
    } else if (message.type === 'pause') {
      speechSynthesis.pause();
      paused = true;
      reportState();
    } else if (message.type === 'resume') {
      speechSynthesis.resume();
      paused = false;
      reportState();
    } else if (message.type === 'updateSettings') {
      queue.forEach((item) => {
        item.rate = message.rate;
        item.voice = message.voice;
      });
      if (current) {
        const remaining = current.text.slice(current.charIndex || 0);
        if (remaining.trim().length > 0) {
          queue.unshift({ text: remaining, rate: message.rate, voice: message.voice, charIndex: 0 });
        }
        const wasPaused = paused;
        speechSynthesis.cancel();
        speakNext();
        if (wasPaused && current) {
          // Rebuild + start the replacement utterance, then immediately
          // re-suspend it — speak() always starts playing, there's no way
          // to hand the engine a paused utterance directly, so this is the
          // only way to swap settings without losing the pause.
          speechSynthesis.pause();
          paused = true;
          reportState();
        }
      }
    } else if (message.type === 'stop') {
      queue.length = 0;
      current = null;
      paused = false;
      speechSynthesis.cancel();
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
