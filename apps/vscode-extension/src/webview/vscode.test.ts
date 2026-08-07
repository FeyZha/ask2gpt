// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppState, HostToWebviewMessage } from "../types";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("acquireVsCodeApi", () => ({ postMessage: vi.fn() }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("webview host-message delivery", () => {
  it("accepts hidden state frames and renders only the latest one when visible", async () => {
    setVisibility("hidden");
    const { onHostMessage } = await import("./vscode");
    const received: HostToWebviewMessage[] = [];
    const dispose = onHostMessage((message) => received.push(message));
    const first = stateMessage(1);
    const latest = stateMessage(2);

    window.dispatchEvent(new MessageEvent("message", { data: first }));
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "sendResult",
          accepted: true,
          conversationId: "conversation-1",
          requestId: "request-1",
        },
      }),
    );
    window.dispatchEvent(new MessageEvent("message", { data: latest }));

    expect(received).toEqual([
      {
        type: "sendResult",
        accepted: true,
        conversationId: "conversation-1",
        requestId: "request-1",
      },
    ]);

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(received).toEqual([
      {
        type: "sendResult",
        accepted: true,
        conversationId: "conversation-1",
        requestId: "request-1",
      },
      latest,
    ]);
    dispose();
  });

  it("delivers state continuously when the document remains visible", async () => {
    setVisibility("visible");
    const { onHostMessage } = await import("./vscode");
    const received: HostToWebviewMessage[] = [];
    const dispose = onHostMessage((message) => received.push(message));
    const state = stateMessage(1);

    window.dispatchEvent(new MessageEvent("message", { data: state }));

    expect(received).toEqual([state]);
    dispose();
  });
});

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}

function stateMessage(activeRuns: number): Extract<HostToWebviewMessage, { type: "state" }> {
  const now = "2026-07-24T00:00:00.000Z";
  const state: AppState = {
    activeConversationId: "conversation-1",
    backend: {
      activeRuns,
      authenticated: true,
      connected: true,
      project: { bound: true, name: "Ask2GPT" },
      selectorVersion: 1,
      connection: {
        phase: "ready",
        since: "2026-01-01T00:00:00.000Z",
        browserDetected: true,
        hasStoredTrust: true,
      },
    },
    conversations: [
      {
        id: "conversation-1",
        title: "Conversation",
        createdAt: now,
        updatedAt: now,
        messages: [],
      },
    ],
    modelPicker: { conversationId: "conversation-1", status: "idle", options: [] },
    pendingContexts: [],
    automaticContextIds: [],
    contextLocked: false,
    locale: "en",
  };
  return { type: "state", state };
}
