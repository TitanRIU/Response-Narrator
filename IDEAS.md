# Ideas

Possible future features for Response Narrator. Nothing here is committed, just a running list to pull from.

- [ ] **Persistent, clickable transcript.** `#textDisplay` currently only shows the chunk being spoken right now. Keeping the whole response (and maybe recent responses) visible and scrollable, with click-to-replay-from-there on any word, would properly solve response history navigation (see "History navigation" below for why blind Back/Forward buttons were rejected instead).
- [ ] **Announce which project a response is from.** The watcher already tracks multiple Claude Code sessions/projects at once; if more than one workspace is running Claude Code simultaneously, there's no audible cue which project a narrated response belongs to.
- [ ] **Volume control.** Rate is adjustable but volume isn't. Both engines support it cheaply (`SpeechSynthesisUtterance.volume`, a Web Audio `GainNode`).
- [ ] **Rewind one sentence.** A bounded "back up a bit" using the sentence chunks that already exist, without the ambiguity full history navigation had.
- [ ] **Narrate tool actions, not just final text.** E.g. "Editing extension.ts" / "Running npm test", for ambient awareness of what Claude's doing while looking elsewhere. Bigger, more speculative: real risk of getting noisy on tool-heavy responses, so it'd need to be opt-in.
- [ ] **Skip auto-reading very short responses.** E.g. under some character threshold, to save a beat on one-word acknowledgments like "Done."

## Maintenance notes

- **Azure DevOps global PAT retirement (December 1, 2026).** Publishing (`vsce publish`) currently requires a Personal Access Token scoped to "All accessible organizations" ("global" PAT). Microsoft is retiring global PATs entirely on 2026-12-01; after that, the current publish token will stop working. As of 2026-08-07, `vsce`/the Marketplace publishing docs have no confirmed working alternative yet (org-scoped PATs aren't confirmed supported, see [microsoft/vscode#322741](https://github.com/microsoft/vscode/issues/322741), still open). Before publishing an update after that date, check whether Microsoft has published new guidance or `vsce` has added org-scoped PAT support.

## Declined / shelved

- **History navigation (Back/Forward through past responses).** Proposed as a CD-player-style feature, declined 2026-08-07: without a visible list of past responses, Back/Forward buttons would make the user guess blindly which message they're jumping to. Superseded by "Persistent, clickable transcript" above, which solves the same problem with actual visibility into the destination before clicking.
