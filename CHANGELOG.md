# Changelog

All notable changes to Ask2GPT are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [0.0.1] - 2026-08-08

### Added

- A focused VS Code code-Q&A workflow that uses the signed-in ChatGPT web session without starting a
  Codex/Coding Agent task or requiring an OpenAI API key.
- VS Code conversation sidebar with multi-turn history, archive/restore, title sync and encrypted
  extension-private storage.
- Chrome Relay companion with protocol v15 loopback discovery across ports 32171–32180.
- Strict `Ask2GPT` ChatGPT Project discovery and binding.
- Streaming answers, stop/regenerate, queued follow-ups and restart recovery.
- Account model/reasoning-option synchronization without an OpenAI API key.
- Explicit selection, current-file and multi-file context attachments with sensitive-file and size
  limits.
- Multi-window routing isolation and durable terminal-event acknowledgement.
- Background answer reception for minimized Chrome windows.
- Windows/Linux CI plus tag-driven GitHub Release packaging and SHA-256 checksums.
- Node 22/24 build support with Node 24 release jobs and commit-pinned GitHub Actions.
- Deterministic third-party dependency notices included in both installation packages.
- A fully synthetic tutorial project plus repository-safe GIF, MP4 and poster demonstrations.

### Fixed

- Follow-up sends now prepare the exact owned tab in its home Chrome window, verify four stable
  composer/send-button geometry samples, and perform one trusted CDP pointer press/release at a
  MAIN-world validated unobscured hit point. Page-script clicks, form submission, keyboard injection,
  fallback activation and automatic resend are excluded from the send path. Once the pointer is
  pressed, all uncertain outcomes enter read-only recovery.
- ChatGPT History API navigation no longer invalidates a later turn merely because Chrome keeps the
  content script's original Project URL in `MessageSender.url`; both follow-up send and recovery paths
  instead require that sender and live tab remain inside the exact bound Project.
- The exact ChatGPT conversation-history rate-limit notice is dismissed only when it is the sole
  visible matching notice with one enabled confirmation control. Generic or ambiguous dialogs still
  fail closed before submission.
- Inactive, minimized and temporarily parked tabs are prewarmed before history inspection, then the
  user's previous tab/window state is restored. A virtualized visible transcript that is only a strict
  suffix of the cached history is published as partial and cannot truncate the VS Code conversation.
- Live smoke verification now selects an explicit account model option, supplies transcript proofs,
  reconciles only exact partial suffixes, and rejects any incomplete history incorrectly marked
  complete.
- Terminal restoration distinguishes an already-focused user window from later user intervention, so
  background runs preserve the tab the user was already viewing instead of selecting the Relay tab.
- A request-start signal alone no longer confirms a send. Ask2GPT waits for the matching user turn
  or response lifecycle before accepting submission, preventing an intercepted request from leaving
  a follow-up permanently busy.
- A page transaction that proves the question was not submitted now returns a bounded definitive
  failure directly to the Relay worker, so a lost secondary error event cannot leave the
  conversation permanently busy.

### Security

- Fixed Chrome extension identity, Origin checks, protocol/schema validation, replay rejection and
  bounded message sizes.
- Required Chrome permissions are limited to `alarms`, `debugger`, `scripting`, `storage` and `tabs`.
- The unauthenticated loopback transport is explicitly documented as suitable only for trusted
  personal machines.
- Production and development dependency trees are required to pass the npm advisory audit before
  release.
