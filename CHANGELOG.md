# Changelog

All notable changes to Ask2GPT are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-08-09

### Added

- Durable `SourceAnchorV1` provenance for captured contexts, including exact and normalized content
  hashes, document version, optional adjacent-line hashes, and a workspace-relative path.

### Changed

- Trusted source-trace hints are now derived by the Host only from attachments on the nearest user
  turn before an answer. Derivation is cached, limited to the active conversation, and bounded by
  message and payload budgets. Unattached file and symbol references remain ordinary text.
- **Find Related Turn** now requires same-URI unique content evidence. A successful trace keeps the
  exact turn and matched context card highlighted until the user clears it.

### Security

- Selection navigation fails closed when its exact snapshot is missing or repeated, and symbol
  providers cannot escape the attached evidence. Historical whole-file references require exact,
  normalized, uniquely relocated, or adjacent-anchor evidence after a change. Rename/move recovery
  never searches the workspace for a guessed replacement URI.

## [0.1.0] - 2026-08-08

### Added

- ChatGPT-style fenced code blocks with a language toolbar, a block-level copy action and expanded
  multicolor syntax highlighting that follows VS Code theme colors.
- A selected-code Ask2GPT action in the always-visible Ask2GPT view title, editor title bar, editor
  context menu, Command Palette and Composer context menu.
- Eight selection-aware code task shortcuts for explanation, issue finding, error fixing, review,
  refactoring, comments, unit tests, and performance/security analysis. Shortcuts fill an isolated,
  editable conversation draft and never send automatically.
- Host-verified source tracing: context cards open their captured lines, answer references such as
  `file.py:34` and attached function symbols open their source definitions, and an editor selection
  can reveal the sent conversation turn that used it.

### Changed

- Streaming code blocks keep their lightweight stable rendering and apply full syntax highlighting
  when the answer reaches a terminal state.
- Code context now stays packaged as compact cards/file capsules. The visible ChatGPT prompt contains
  only the human-written question, while bounded snapshots are uploaded as in-memory text files.
- Versioned context-transport receipts and ChatGPT presentation matching keep old inline turns and new
  packaged turns compact during history restoration.
- The Relay hot-upgrade compatibility line now covers adjacent `0.1.x` patch releases starting at
  `0.1.0`; formal installations still require matching VSIX and Relay versions.

### Fixed

- Minimized-window dispatch no longer submits fully off-screen Chrome bounds. Relay restores the owned
  home window at Chrome-managed bounds without focus and minimizes it again after completion, avoiding
  Chromium's “at least 50% within visible screen space” rejection before a packaged-context send.

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
