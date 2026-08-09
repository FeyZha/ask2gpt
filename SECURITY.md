# Ask2GPT security model

Ask2GPT provides focused code Q&A in VS Code while routing model interaction through the user's
signed-in ChatGPT page. It does not start a Codex/Coding Agent task. The local extension remains
capability-limited:

- The VS Code extension has no shell, terminal, Git, test runner, patch, or workspace write path;
  coding requests are sent to ChatGPT instead of being blocked by a local intent classifier.
- Code context is captured only after an explicit user action: from the current selection, the
  current in-memory text buffer, or files the user confirms in the system file picker. Ask2GPT
  never enumerates, scans, searches, or infers files from the workspace.
- Source navigation remains host-authoritative. Webview clicks carry conversation/message/context IDs
  or a bounded textual reference, never a URI. The Host proves the reference exists in its stored
  answer and resolves it only against source snapshots explicitly attached before that answer;
  navigation never expands into workspace file search.
- Conversation data is encrypted with AES-256-GCM under an OS-backed VS Code SecretStorage key.
- AES-GCM records bind the conversation ID as authenticated additional data and keep one last-valid backup.
- First-time key generation is serialized across Extension Host processes by an exclusive lock inside
  extension-private `globalStorageUri`; the lock contains only a PID and random ownership token, never
  the encryption key. The value is re-read from SecretStorage before it is accepted.
- Chrome connection is zero-configuration and has no pairing code, shared relay key, HMAC proof, or
  trust reset. VS Code `SecretStorage` is used only for the local conversation-encryption key.
- Each active VS Code window holds an exclusive storage slot. The slot deterministically selects its
  extension-private conversation namespace and relay identity, so same-workspace windows remain
  isolated while a reloaded window can recover its Chrome tab, run, and pending events.
- The relay binds only to `127.0.0.1`, checks the fixed Chrome extension Origin and ID, requires the
  explicit WebSocket subprotocol and equal or adjacent Host/Relay patch versions during rolling
  updates, limits frames to 2 MiB by UTF-8 byte length, rejects replayed envelope IDs, and validates message direction,
  schema, and target window identity. These checks prevent accidental cross-version or cross-window
  routing; they are not cryptographic authentication of a local process.
- The Chrome DOM/content relay runs only on `https://chatgpt.com/*` in an isolated world. A separate
  `document_start` MAIN-world bridge consumes only a validated one-shot model slug and rewrites only
  the next ChatGPT page-owned conversation request; it cannot receive loopback messages directly.
- The required `debugger` permission supports background streaming while Chrome is minimized. It is
  enabled by default unless the user explicitly opts out. The Service Worker attaches only to the
  Ask2GPT-owned ChatGPT tab for an active run, matches one ChatGPT event-stream response, follows
  only the `conversation-turn-*` WebSocket topic declared by a `stream_handoff`, forwards validated
  assistant snapshots, and detaches on completion, stop, or failure. Shared-socket frames for other
  topics and opaque resume tokens are ignored. It does not inspect request bodies, cookies,
  credentials, or unrelated tabs, and raw SSE/WebSocket bytes are not persisted.
- The required `scripting` permission is limited to re-injecting the reviewed MAIN/ISOLATED content
  runtimes into a validated Ask2GPT-owned tab after lifecycle replacement, and to one guarded
  MAIN-world send-button action for the already active run. The target tab, Project URL, run,
  transcript baseline, runtime revision and unique marker must all match before execution.
- In enhanced mode, the same debugger session activates only the owned renderer lifecycle and emulates
  page focus immediately before submission; it does not focus the OS window. A guarded MAIN-world
  transaction validates the uniquely marked page-owned send button, its visible geometry and an
  unobscured interior hit point across four stable samples. The Service Worker then sends exactly one
  CDP left-pointer press/release at that validated point. Page-script clicks, form submission and
  keyboard injection are never used for sending. If enhanced reception is disabled, a short-lived
  debugger session performs only that pointer action, enables no Network domain, and detaches immediately.
  The request must match the exact tab, trusted Project URL, run ID, durable pre-dispatch transcript
  baseline, and content-runtime revision; the marker carries only the run ID, must resolve to one
  connected enabled button, and is removed immediately. From `mousePressed` onward, an ambiguous
  outcome is handled only by read-only inspection/recovery and is never retried.
- Before the non-idempotent send boundary, inactive or minimized owned tabs may receive a reversible
  visibility prewarm. The actual pointer action is allowed only after the exact tab has returned to its
  home window and is Chrome's active tab there. A minimized home window is temporarily restored at
  Chrome's browser-managed restore bounds with `focused=false`, then returned to its original
  bounds/minimized state after the terminal event. Relay never supplies fully off-screen coordinates:
  Chromium requires at least half of extension-managed window bounds to intersect a current display.
  Read-only history prewarming may use a non-focused temporary window, but no send action is permitted
  from that window.
- Model discovery calls only ChatGPT's same-origin `/backend-api/models` with the current page session.
  A short-lived access token may be read from page bootstrap data for that request, but it is never
  sent to the Relay or VS Code, persisted, cached, logged, or included in diagnostics.
- Project discovery inspects only the same-origin GET response from the exact
  `/backend-api/gizmos/snorlax/sidebar` directory endpoint. It accepts only direct entries in the
  response's top-level `items` array, never recursively searches unrelated response data, and leaves
  every other `backend-api` response body untouched. When the sidebar is not rendered, only one
  Relay-owned home tab may request that same fixed endpoint; page input cannot choose its URL, method,
  headers, or body. The response is streamed through a 4 MiB byte cap and is cancelled immediately
  when the cap is exceeded. Project evidence is versioned, short-lived, revoked by a later no-match,
  and must match the current Content Script evidence revision before it can become a durable binding.
- Loopback messages can never reload the Chrome extension. `chrome.runtime.reload()` is exposed only
  by the Relay popup's explicit user action, preventing an unauthenticated local endpoint from creating
  a reload loop. Before reloading, the popup waits for a two-minute, one-use checkpoint containing only
  Project verification and tab/run routing metadata; it never contains prompts, answers, code, cookies,
  or account data, and is deleted immediately after validated restoration. Reloading does not delete or
  rename ChatGPT conversations.
- Webview, relay, persisted-state, content-message, URL, and ChatGPT DOM inputs are validated at their trust boundaries.
- Logs contain allowlisted event metadata and error codes, never prompts, responses, code, URLs, conversation/instance IDs, or secrets.
- `pnpm verify:boundaries` rejects new shell, Git, terminal, task/test execution, workspace search/write,
  command, dependency, or Chrome permission surfaces. Its reviewed Chrome permission set is fixed to
  `alarms`, `debugger`, `scripting`, `storage`, and `tabs`; its direct network-client allowlist contains
  only the fixed ChatGPT session/model-catalog requests and Project-directory bridge described above.
- CI and tag releases use supported Node 22/24 lines, commit-pinned GitHub Actions, a frozen pnpm
  lockfile, allowlisted dependency build scripts, and the official npm advisory endpoint. Both the
  production and complete dependency trees must report no known vulnerabilities. Deterministic
  third-party notices are checked against the installed production tree and embedded in both release
  archives.

The loopback WebSocket does not provide TLS or peer authentication. A malicious local process can
occupy a relay port and impersonate the VS Code endpoint to Chrome, or connect to a VS Code relay
while claiming the expected Origin and extension identity. Successful impersonation could expose a
prompt and its explicitly attached code or induce operations on an Ask2GPT-owned ChatGPT tab.
This zero-configuration MVP therefore assumes a trusted personal machine. Removing the local-adversary
risk requires a different transport such as Native Messaging, an OS-ACL-protected IPC endpoint, or
another verifiable local identity mechanism.

Report suspected security issues through the repository's private **Security → Report a
vulnerability** flow. If private vulnerability reporting is unavailable, contact the maintainer
privately before sharing technical details. Never include secrets, code, prompts, answers, ChatGPT
URLs, cookies, tokens, or conversation exports in a public issue.
