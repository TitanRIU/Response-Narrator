# Change Log

All notable changes to the "response-narrator" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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