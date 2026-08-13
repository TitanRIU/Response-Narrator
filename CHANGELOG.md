# Change Log

All notable changes to the "response-narrator" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.9] - 2026-08-13

### Added

- The transcript panel now stays visible and clickable instead of only showing the chunk currently being spoken. The current response and the last few before it remain on screen, separated by a divider, and clicking any word replays from that exact point (both voice engines).

### Fixed

- A word's highlight could get stuck lit up after its chunk finished, leaving multiple words appearing highlighted at once across a long response. Highlight clearing now checks the whole panel instead of only the chunk currently playing.

## [0.1.8] - 2026-08-08

### Fixed

- Enhanced voice no longer rises in pitch at faster playback speeds. Replaced the AudioBufferSourceNode-based playback (a naive resample, with no pitch correction) with a single persistent `<audio>` element with `preservesPitch` enabled, routed into the same AudioContext graph via `createMediaElementSource` so the one-click autoplay unlock still applies to every later utterance. Native `.currentTime`/`.pause()`/`.play()` also replace the old manual offset-tracking used to simulate pause/resume and word-highlight timing.

## [0.1.7] - 2026-08-07

### Changed

- Bundled the extension with esbuild instead of shipping `node_modules` unbundled. Package size dropped from 452 files / 852 KB to 12 files / 172 KB, and the "you should bundle your extension" warning from `vsce` is gone. No functional changes; verified via full test suite and a real F5 launch.

## [0.1.6] - 2026-08-07

### Fixed

- Response Narrator now scopes watching to the current window's own open workspace folder(s) instead of the globally most-recently-active Claude Code session across the whole machine. Fixes responses being read aloud twice when multiple VS Code windows are open at once, each narrating whichever project happened to be globally most recent.

## [0.1.5] - 2026-08-07

### Fixed

- Clicking Enable before the spoken "click Enable" announcement finished could leave it playing on top of the Enhanced audio that had just started. The announcement is now cut off immediately when Enable is clicked.

## [0.1.4] - 2026-08-07

### Added

- README Requirements section (what Response Narrator needs to do anything, and how session discovery works across workspaces) and a Privacy section (what the Enhanced voice engine sends to Microsoft's service).

### Changed

- Removed em dashes from user-facing text throughout: README, IDEAS.md, package.json descriptions, and in-app QuickPick labels/tooltips.

## [0.1.3] - 2026-08-07

### Added

- README "Getting Started" section walking through initial usage: status bar controls, settings menu, playback modes, and the one-time Enhanced voice unlock step.

## [0.1.2] - 2026-08-07

### Added

- Marketplace search keywords (claude code, text-to-speech, accessibility, etc.) for better discoverability on specific-phrase searches.

## [0.1.1] - 2026-08-07

### Added

- README screenshots: the panel with live word highlighting, the status bar controls, and the settings menu.

## [0.1.0] - 2026-08-07

### Added

- Watches Claude Code session transcripts and narrates new assistant responses, with Markdown stripped for clean speech.
- System voice engine (built-in OS voices via the browser's speech synthesis API) and Enhanced voice engine (Microsoft Edge neural voices), with automatic fallback to System if Enhanced fails.
- Auto and Manual playback modes.
- Status bar Play/Pause/Stop controls, a settings menu (voice engine, voice, speed), and keyboard shortcuts (`Ctrl+Alt+P` to play/pause, `Ctrl+Alt+S` to stop).
- Live word-by-word highlighting synced to playback, for both voice engines.
- Two-tier language → voice picker for the Enhanced engine's 300+ voices.
- Mid-utterance voice hand-off: changing voice while something is playing continues from roughly the same position instead of restarting.
- Natural sentence- and pause-based chunking, so long responses split at sentence or comma boundaries instead of mid-word.
- Code blocks are announced (e.g. "TypeScript code block, 12 lines") instead of being read aloud character by character.
- One-time in-panel prompt (with a spoken heads-up) to enable Enhanced voice playback, satisfying the browser's autoplay policy.
- "Report Issue / Give Feedback" menu entry and command, linking to GitHub Issues.