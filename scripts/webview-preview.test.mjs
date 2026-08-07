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
  assert.equal(state.modelPicker.conversationId, state.activeConversationId);
  assert.deepEqual(state.composerPreferences, {
    followUpQueueMode: "queue",
    composerEnterBehavior: "enter",
  });
  assert.equal(state.contextLocked, false);
  assert.equal(state.pendingContexts.length, 2);
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
  const [indexResponse, harnessResponse, scriptResponse, styleResponse, healthResponse] =
    await Promise.all([
      fetch(`${origin}/`),
      fetch(`${origin}/preview/harness.js`),
      fetch(`${origin}/webview/webview.js`),
      fetch(`${origin}/webview/webview.css`),
      fetch(`${origin}/health`),
    ]);
  assert.equal(indexResponse.status, 200);
  assert.equal(harnessResponse.status, 200);
  assert.equal(scriptResponse.status, 200);
  assert.equal(styleResponse.status, 200);
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
  assert.match(style, /\.composer/u);
  assert.match(style, /--type-body:/u);
  assert.match(style, /\.conversation-view/u);
  assert.match(style, /history-panel-in/u);
  assert.match(style, /message--assistant\[data-latest-assistant=(?:"true"|true)\]/u);
  assert.match(style, /prefers-reduced-motion:\s*reduce/u);
  assert.deepEqual(health, { ok: true, state: "ready" });
});
