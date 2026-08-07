import * as vscode from 'vscode';
import { TranscriptWatcher, Utterance } from './transcriptWatcher';
import { SpeechPanel, PlaybackState } from './speechPanel';

const CONFIG_SECTION = 'response-narrator';
const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

let watcher: TranscriptWatcher | undefined;
let speechPanel: SpeechPanel | undefined;
let menuStatusBarItem: vscode.StatusBarItem;
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

	playbackStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	playbackStatusBarItem.command = 'response-narrator.togglePlayback';
	playbackStatusBarItem.show();

	updateMenuStatusBar();
	updatePlaybackStatusBar();

	context.subscriptions.push(
		outputChannel,
		menuStatusBarItem,
		playbackStatusBarItem,
		vscode.commands.registerCommand('response-narrator.openMenu', openMenu),
		vscode.commands.registerCommand('response-narrator.togglePlayback', togglePlayback),
		vscode.commands.registerCommand('response-narrator.selectVoice', selectVoice),
		vscode.commands.registerCommand('response-narrator.stopSpeaking', stopSpeaking),
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
		}),
		speechPanel.onDidChangeState((state) => {
			playbackState = state;
			updatePlaybackStatusBar();
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
			speak(utterance.text);
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
	speak(chunks.join(' '));
}

function stopSpeaking(): void {
	speechPanel?.stop();
}

async function openMenu(): Promise<void> {
	const picked = await vscode.window.showQuickPick(
		[
			{ id: 'playback', label: '$(gear) Playback', description: getPlaybackMode() === 'auto' ? 'Auto' : 'Manual' },
			{ id: 'voice', label: '$(mic) Voice', description: getVoiceSetting() || 'System default' },
			{ id: 'speed', label: '$(zap) Speed', description: `${getRate()}x` }
		],
		{ placeHolder: 'Response Narrator settings' }
	);
	if (!picked) {
		return;
	}
	if (picked.id === 'playback') {
		await choosePlaybackMode();
	} else if (picked.id === 'voice') {
		await selectVoice();
	} else if (picked.id === 'speed') {
		await chooseSpeed();
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
		{ placeHolder: 'Select a voice for Response Narrator' }
	);
	if (picked) {
		await vscode.workspace
			.getConfiguration(CONFIG_SECTION)
			.update('voice', picked.value, vscode.ConfigurationTarget.Global);
	}
}

function speak(text: string): void {
	speechPanel?.speak(text, { rate: getRate(), voice: getVoiceSetting() || undefined });
}

function getPlaybackMode(): 'auto' | 'manual' {
	return vscode.workspace.getConfiguration(CONFIG_SECTION).get<'auto' | 'manual'>('playbackMode', 'auto');
}

function getRate(): number {
	return vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>('rate', 1);
}

function getVoiceSetting(): string {
	return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('voice', '');
}

function resetResponseBuffers(): void {
	currentResponseChunks = [];
	lastCompletedResponse = undefined;
}

function updateMenuStatusBar(): void {
	const mode = getPlaybackMode() === 'auto' ? 'Auto' : 'Manual';
	menuStatusBarItem.tooltip = `Response Narrator settings — Playback: ${mode}, Voice: ${
		getVoiceSetting() || 'System default'
	}, Speed: ${getRate()}x`;
}

function updatePlaybackStatusBar(): void {
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
		playbackStatusBarItem.text = '$(broadcast) Auto';
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
