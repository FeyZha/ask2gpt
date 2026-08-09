# Ask2GPT for VS Code

Ask project-code questions in VS Code through your signed-in ChatGPT web session. Ask2GPT does not
start a Codex/Coding Agent task, use an OpenAI API key, run shell commands, or modify your workspace.
ChatGPT account and web usage limits still apply.

This document describes Ask2GPT 0.1.1 and Relay protocol v15.

## Required companion

Install the matching `ask2gpt-relay-<version>.zip` from the same
[GitHub Release](https://github.com/FeyZha/ask2gpt/releases/latest):

1. Extract the ZIP to a stable directory.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select the extracted directory and keep **Ask2GPT Relay** enabled.
4. Sign in to ChatGPT and create or open a Project named exactly `Ask2GPT`.

Do not mix VSIX and Relay files from different releases. No pairing code, Node.js, pnpm, or OpenAI
API key is required. Chrome 116+ and VS Code 1.96+ are supported.

## Start asking

- Click the Ask2GPT icon in the Activity Bar, or run
  `Ask2GPT: 打开问答窗口 / Open Q&A`.
- Select code and click the always-visible Ask2GPT action in the Ask2GPT view title. The same
  `问 Ask2GPT（使用当前选区） / Ask About Selection` command is also available from the editor
  title, editor context menu and Command Palette.
- Use the Composer `+` button to attach the current selection, current file or selected text files.
- After attaching a selection, choose Explain, Find issues, Fix errors, Review, Refactor, Add comments,
  Unit tests, or Performance/security. A shortcut only fills the conversation's editable draft; it
  never sends automatically.
- Review every context item before sending; Ask2GPT never scans the workspace for more files.
- Click a context card or a Host-verified `file.ts:line`/inline symbol in an answer to return to
  attached source. With code selected, **Find Related Turn** accepts only unique content evidence,
  then keeps the matched turn and exact context card highlighted until you clear the trace.

Code context remains a compact attachment card in the VS Code transcript and a file capsule on the
ChatGPT page. Only the human-written question appears as prompt text; the Relay uploads each bounded
snapshot as an in-memory text file for ChatGPT to read.
The Host derives clickable hints only from contexts on the nearest user turn before an answer.
Unattached references stay ordinary text. A selection snapshot that is missing or repeated in the
current document fails closed instead of opening an old line. Durable contexts include versioned
`SourceAnchorV1` hash metadata for provenance and relocation.

To keep long histories responsive, source affordances are indexed only for the active conversation
and at most its 200 newest terminal assistant messages. Older answers remain readable, with source
tokens rendered as ordinary text.

Ask2GPT supports streaming Markdown, ChatGPT-style code blocks with multicolor syntax highlighting and
block-level copy, multi-turn conversations, title/history sync, model-option sync, stop/regenerate,
queued follow-ups, encrypted extension-private history, and isolated routing across multiple VS Code
windows.

Ask2GPT is best for explanation, analysis, comparison, and planning. Use a coding Agent when the task
needs repository search, file edits, terminal commands, tests, or Git operations.

## Data boundary

Only explicitly selected text is relayed to the visible ChatGPT page. Sensitive filenames, binary
files, and oversized content are rejected. Ask2GPT does not request Chrome cookie, history, download,
clipboard, native-messaging, or file-URL permissions.

Renaming or moving a file can invalidate URI-based source navigation and reverse lookup. Ask2GPT does
not search the workspace to guess a replacement path.

The complete installation guide, synthetic tutorial, demo, limitations, and security model are in the
[project README](https://github.com/FeyZha/ask2gpt#readme).

## License

[MIT](./LICENSE). Third-party notices are included in `THIRD_PARTY_NOTICES.txt`.
