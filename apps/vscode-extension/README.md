# Ask2GPT

Codex-style coding chat for VS Code, backed by your signed-in ChatGPT session through Chrome Relay.

> Codex-like chat in VS Code, routed through Chrome Relay.

Ask2GPT keeps explanations, analysis, and discussion inside VS Code, relayed through the companion **Ask2GPT Relay** Chrome extension.

Protocol v15 discovers the companion automatically over loopback, with no pairing
code or per-window setup. Multiple VS Code windows connect independently and keep
their conversation routing isolated by instance ID.

Ask2GPT does not use the OpenAI API or directly execute shell commands, Git, tests, patches, or workspace writes. Every valid prompt follows the same Relay send path. See the repository `README.md` for installation and automatic Chrome Relay connection instructions.

## Required companion setup

Install the matching `ask2gpt-relay-<version>.zip` from the same GitHub Release:

1. Extract the ZIP to a stable directory.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select the extracted Relay directory and keep the extension enabled.
4. Sign in to ChatGPT and open or create a Project named exactly `Ask2GPT`.

Do not mix VSIX and Relay files from different releases. No OpenAI API key or pairing code is
required. Chrome 116+ and VS Code 1.96+ are supported.

## Open Ask2GPT

After installing the VSIX, reload VS Code, then use any of these entry points:

- Click the Ask2GPT speech-bubble icon in the Activity Bar.
- Run `Ask2GPT: 打开问答窗口 / Open Q&A` from the Command Palette.

The open command reveals the view and focuses its composer even if the Activity
Bar icon is hidden or the view has been moved. Drag the view to the Secondary
Sidebar if you want it beside Codex.

When text is selected, Ask2GPT contributes one
`Ask Ask2GPT about this selection` action to VS Code's native lightbulb.
It captures the exact document version and range, attaches the snapshot to the
current composer, and focuses the chat without sending. No editor-title,
context-menu, CodeLens, inline-chat, or extension keybinding duplicates it.
The action is absent when the selection is empty. Ask2GPT adds no
context-menu item, CodeLens, inline text, Command Palette entry, or default
keybinding for this selection action.

The composer keeps one state-aware action button. Its configured send key is
Enter or Ctrl/Cmd+Enter; while an answer is running, Ctrl/Cmd+Shift+Enter always
uses the opposite Queue/stop-then-send behavior for that submission only.
