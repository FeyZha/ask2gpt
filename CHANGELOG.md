# Changelog

All notable changes to Ask2GPT are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [0.0.1] - 2026-08-08

### Added

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

### Fixed

- Follow-up sends on ChatGPT's unified composer now move an inactive exact owned tab into a
  desktop-layout, non-focused normal window for the run, including when the original Chrome window
  is not minimized. The temporary window deliberately uses `type=normal`, because Chrome rejects
  moving tabs into or out of `type=popup` windows.
  This makes the document genuinely visible so React submission and confirmation timers cannot freeze,
  without switching or focusing the user's Chrome window. After a window move, Relay requires two
  ready-composer proofs 350 ms apart so it cannot click a visible editor before ChatGPT has reattached
  its submission handlers. Enhanced mode then prepares the renderer's
  lifecycle and emulated page focus immediately before validating the run-marked send button in MAIN
  world. A regular page still activates the button in that synchronous transaction. A Relay parking
  window instead receives exactly one trusted CDP left-pointer press/release at the validated, unobscured button
  hit point, because current ChatGPT builds ignore programmatic `button.click()` in that state. With
  enhanced reception disabled, a short-lived debugger session performs only this pointer action and
  detaches immediately without enabling Network capture. Form submission, keyboard injection, fallback
  activation, and automatic retries stay forbidden.
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
