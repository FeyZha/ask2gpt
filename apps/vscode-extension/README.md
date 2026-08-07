# Ask2GPT for VS Code

Ask project-code questions in VS Code through your signed-in ChatGPT web session. Ask2GPT does not
start a Codex/Coding Agent task, use an OpenAI API key, run shell commands, or modify your workspace.
ChatGPT account and web usage limits still apply.

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
- Select code and use the yellow-lightbulb action
  `问 Ask2GPT（使用当前选区） / Ask Ask2GPT about this selection`.
- Use the Composer `+` button to attach the current file or selected text files.
- Review every context item before sending; Ask2GPT never scans the workspace for more files.

Ask2GPT supports streaming Markdown, multi-turn conversations, title/history sync, model-option sync,
stop/regenerate, queued follow-ups, encrypted extension-private history, and isolated routing across
multiple VS Code windows.

Ask2GPT is best for explanation, analysis, comparison, and planning. Use a coding Agent when the task
needs repository search, file edits, terminal commands, tests, or Git operations.

## Data boundary

Only explicitly selected text is relayed to the visible ChatGPT page. Sensitive filenames, binary
files, and oversized content are rejected. Ask2GPT does not request Chrome cookie, history, download,
clipboard, native-messaging, or file-URL permissions.

The complete installation guide, synthetic tutorial, demo, limitations, and security model are in the
[project README](https://github.com/FeyZha/ask2gpt#readme).

## License

[MIT](./LICENSE). Third-party notices are included in `THIRD_PARTY_NOTICES.txt`.
