import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createPreviewServer } from "./webview-preview-server.mjs";
import { createPreviewState, validatePreviewState } from "./webview-preview-state.mjs";

test("preview fixtures live beside the server instead of disposable smoke state", async () => {
  const [html, harness] = await Promise.all([
    readFile(new URL("./webview-preview/index.html", import.meta.url), "utf8"),
    readFile(new URL("./webview-preview/harness.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /__ask2gpt_INITIAL_STATE__/u);
  assert.match(harness, /acquireVsCodeApi/u);
});

test("preview state satisfies the current AppState invariants", () => {
  const state = validatePreviewState(createPreviewState());
  assert.equal(state.activeConversationId, "preview-main");
  assert.equal(state.backend.connection.phase, "ready");
  assert.equal(state.backend.connection.hostVersion, "0.1.0");
  assert.equal(state.backend.connection.relayVersion, "0.1.0");
  assert.equal(state.backend.connection.protocolVersion, 15);
  assert.equal(state.backend.selectorVersion, 50);
  assert.equal(state.backend.project.name, "ask2gpt-tour");
  assert.equal(state.modelPicker.conversationId, state.activeConversationId);
  assert.deepEqual(state.composerPreferences, {
    followUpQueueMode: "queue",
    composerEnterBehavior: "enter",
  });
  assert.equal(state.contextLocked, false);
  assert.equal(state.pendingContexts.length, 2);
  assert.deepEqual(
    state.pendingContexts.map((context) => context.kind),
    ["selection", "current-file"],
  );
  assert.ok(state.pendingContexts.every((context) => context.fileName === "insight-board.ts"));
  assert.match(
    state.conversations[0].messages[1].markdown,
    /insight-board\.ts:68.*`summarize\(\)`/u,
  );
  assert.deepEqual(state.automaticContextIds, []);
});

test("preview server injects state and serves the current built webview assets", async (context) => {
  const server = createPreviewServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const [
    indexResponse,
    harnessResponse,
    scriptResponse,
    styleResponse,
    traversalResponse,
    healthResponse,
  ] = await Promise.all([
    fetch(`${origin}/`),
    fetch(`${origin}/preview/harness.js`),
    fetch(`${origin}/webview/webview.js`),
    fetch(`${origin}/webview/webview.css`),
    fetch(`${origin}/webview/%2e%2e%5cpnpm-lock.yaml`),
    fetch(`${origin}/health`),
  ]);
  assert.equal(indexResponse.status, 200);
  assert.equal(harnessResponse.status, 200);
  assert.equal(scriptResponse.status, 200);
  assert.equal(styleResponse.status, 200);
  assert.equal(traversalResponse.status, 404);
  assert.equal(healthResponse.status, 200);

  const [html, harness, script, style, health] = await Promise.all([
    indexResponse.text(),
    harnessResponse.text(),
    scriptResponse.text(),
    styleResponse.text(),
    healthResponse.json(),
  ]);
  assert.doesNotMatch(html, /__ask2gpt_INITIAL_STATE__/u);
  assert.match(html, /"activeConversationId": "preview-main"/u);
  assert.match(html, /\/preview\/harness\.js/u);
  assert.match(harness, /streamLongMarkdown/u);
  assert.match(harness, /generationUpdate/u);
  assert.match(harness, /reconnect/u);
  assert.match(harness, /completeGeneration/u);
  assert.match(harness, /showError/u);
  assert.match(harness, /setActiveConversation/u);
  assert.match(harness, /interruptWithFollowUp/u);
  assert.match(harness, /targetRunId/u);
  assert.match(harness, /clientRequestId/u);
  assert.match(harness, /conversationId === "preview-secondary"/u);
  assert.ok(script.length > 100_000, "expected the current bundled React webview");
  for (const actionId of [
    "explain",
    "find-issues",
    "fix-error",
    "review",
    "refactor",
    "comments",
    "tests",
    "performance-security",
  ]) {
    assert.match(script, new RegExp(actionId, "u"));
  }
  assert.match(script, /代码任务快捷动作/u);
  assert.match(script, /只填入，不自动发送/u);
  assert.match(script, /openSourceReference/u);
  assert.match(script, /source\.ask2gpt\.invalid/u);
  assert.match(script, /Matched selection/u);
  assert.match(style, /\.composer/u);
  assert.match(style, /--type-body:/u);
  assert.match(style, /\.conversation-view/u);
  assert.match(style, /\.markdown-code-block/u);
  assert.match(style, /--code-keyword:/u);
  assert.match(style, /\.hljs-addition/u);
  assert.match(style, /\.code-task-actions/u);
  assert.match(style, /\.code-task-action:focus-visible/u);
  assert.match(style, /\.source-reference:focus-visible/u);
  assert.match(style, /\.message--trace-target/u);
  assert.match(style, /@media\s*\((?:max-width:\s*340px|width<=340px)\)/u);
  assert.match(style, /history-panel-in/u);
  assert.match(style, /message--assistant\[data-latest-assistant=(?:"true"|true)\]/u);
  assert.match(style, /prefers-reduced-motion:\s*reduce/u);
  assert.deepEqual(health, { ok: true, state: "ready" });
});
