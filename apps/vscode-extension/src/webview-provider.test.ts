import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import type { AppState, GenerationViewUpdate, WebviewToHostMessage } from "./types";

const contextNavigationMock = vi.hoisted(() => ({
  openContextFromState: vi.fn(async () => undefined),
}));

const sourceTraceMock = vi.hoisted(() => ({
  openAnswerSourceReferenceFromState: vi.fn(async () => undefined),
  openAnswerSymbolFromState: vi.fn(async () => undefined),
}));

vi.mock("vscode", () => ({
  commands: {
    executeCommand: vi.fn(async () => undefined),
  },
  env: {
    language: "en",
    clipboard: { writeText: vi.fn(async () => undefined) },
    openExternal: vi.fn(async () => true),
  },
  window: {
    activeTextEditor: undefined,
    showWarningMessage: vi.fn(async () => undefined),
  },
  Uri: {
    joinPath: (...parts: Array<{ path?: string } | string>) => ({
      path: parts.map((part) => (typeof part === "string" ? part : (part.path ?? ""))).join("/"),
    }),
    parse: (value: string) => ({ path: value }),
  },
}));

vi.mock("./context-navigation", () => contextNavigationMock);
vi.mock("./source-trace", () => sourceTraceMock);

import { Ask2GPTViewProvider } from "./webview-provider";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = undefined;
});

describe("Ask2GPTViewProvider state delivery", () => {
  it("captures the exact active selection for the composer selection action", async () => {
    const state = appState({ activeRuns: 0 });
    const attachSelection = vi.fn();
    const controller = {
      attachSelection,
      getState: () => state,
      onState: () => ({ dispose: vi.fn() }),
    };
    (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = {
      document: {
        uri: { scheme: "file", toString: () => "file:///workspace/index.ts" },
        version: 7,
      },
      selection: {
        isEmpty: false,
        start: { line: 4, character: 2 },
        end: { line: 6, character: 11 },
      },
    };
    let receiveMessage: ((message: WebviewToHostMessage) => void) | undefined;
    const view = {
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      visible: true,
      webview: {
        asWebviewUri: (value: unknown) => value,
        cspSource: "test-source",
        html: "",
        onDidReceiveMessage: vi.fn((listener: (message: WebviewToHostMessage) => void) => {
          receiveMessage = listener;
          return { dispose: vi.fn() };
        }),
        options: {},
        postMessage: vi.fn(async () => true),
      },
    };
    const provider = new Ask2GPTViewProvider(
      { path: "extension" } as never,
      controller as never,
      { error: vi.fn(), info: vi.fn() } as never,
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    );
    provider.resolveWebviewView(view as never);

    receiveMessage?.({ type: "attachSelection", conversationId: "conversation-1" });

    await vi.waitFor(() =>
      expect(attachSelection).toHaveBeenCalledWith("conversation-1", {
        uri: "file:///workspace/index.ts",
        documentVersion: 7,
        startLine: 4,
        startCharacter: 2,
        endLine: 6,
        endCharacter: 11,
      }),
    );
    provider.dispose();
  });

  it("reveals the contributed view, focuses it, and focuses the composer after ready", async () => {
    const state = appState({ activeRuns: 0 });
    const controller = {
      getState: () => state,
      onState: () => ({ dispose: vi.fn() }),
    };
    const postMessage = vi.fn(async (_message: unknown) => true);
    const show = vi.fn();
    let receiveMessage: ((message: WebviewToHostMessage) => void) | undefined;
    const view = {
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      show,
      visible: true,
      webview: {
        asWebviewUri: (value: unknown) => value,
        cspSource: "test-source",
        html: "",
        onDidReceiveMessage: vi.fn((listener: (message: WebviewToHostMessage) => void) => {
          receiveMessage = listener;
          return { dispose: vi.fn() };
        }),
        options: {},
        postMessage,
      },
    };
    const provider = new Ask2GPTViewProvider(
      { path: "extension" } as never,
      controller as never,
      { error: vi.fn(), info: vi.fn() } as never,
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    );
    provider.resolveWebviewView(view as never);

    await provider.show(true);

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith(false);
    expect(postMessage).not.toHaveBeenCalled();

    receiveMessage?.({ type: "ready" });
    // The initial state is embedded in the host HTML, so the ready handshake
    // only needs to deliver the pending focus request when state is unchanged.
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({ type: "focusComposer" });

    provider.dispose();
  });

  it("delivers authoritative state before revealing a turn in a ready renderer", async () => {
    const state = appState({ activeRuns: 0 });
    let releaseState!: (delivered: boolean) => void;
    const stateDelivery = new Promise<boolean>((resolve) => {
      releaseState = resolve;
    });
    const postMessage = vi.fn((message: unknown) =>
      (message as { type?: string }).type === "state" ? stateDelivery : Promise.resolve(true),
    );
    const harness = createStateDeliveryHarness(() => state, postMessage);
    harness.ready();
    postMessage.mockClear();

    await harness.provider.revealTurn("conversation-1", "assistant-1", "context-1");

    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenLastCalledWith({ type: "state", state });
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "revealTurn" }));

    releaseState(true);
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "state", state },
      {
        type: "revealTurn",
        conversationId: "conversation-1",
        messageId: "assistant-1",
        contextId: "context-1",
      },
    ]);
    harness.provider.dispose();
  });

  it("retains a turn reveal until an unresolved renderer announces readiness", async () => {
    const state = appState({ activeRuns: 0 });
    const postMessage = vi.fn(async () => true);
    const harness = createStateDeliveryHarness(() => state, postMessage);

    await harness.provider.revealTurn("conversation-1", "assistant-1");
    expect(postMessage).not.toHaveBeenCalled();

    harness.ready();
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    expect(postMessage).toHaveBeenCalledWith({
      type: "revealTurn",
      conversationId: "conversation-1",
      messageId: "assistant-1",
    });
    harness.provider.dispose();
  });

  it("redelivers an in-flight turn reveal when its renderer is replaced", async () => {
    const state = appState({ activeRuns: 0 });
    let firstReceive: ((message: WebviewToHostMessage) => void) | undefined;
    let secondReceive: ((message: WebviewToHostMessage) => void) | undefined;
    let releaseOldReveal!: (delivered: boolean) => void;
    const oldRevealDelivery = new Promise<boolean>((resolve) => {
      releaseOldReveal = resolve;
    });
    const firstPost = vi.fn((message: unknown) =>
      (message as { type?: string }).type === "revealTurn"
        ? oldRevealDelivery
        : Promise.resolve(true),
    );
    const secondPost = vi.fn(async () => true);
    const controller = {
      getState: () => state,
      onState: () => ({ dispose: vi.fn() }),
    };
    const makeView = (
      postMessage: (message: unknown) => PromiseLike<boolean>,
      capture: (listener: (message: WebviewToHostMessage) => void) => void,
    ) => ({
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      visible: true,
      webview: {
        asWebviewUri: (value: unknown) => value,
        cspSource: "test-source",
        html: "",
        onDidReceiveMessage: vi.fn((listener: (message: WebviewToHostMessage) => void) => {
          capture(listener);
          return { dispose: vi.fn() };
        }),
        options: {},
        postMessage,
      },
    });
    const provider = new Ask2GPTViewProvider(
      { path: "extension" } as never,
      controller as never,
      { error: vi.fn(), info: vi.fn() } as never,
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    );
    provider.resolveWebviewView(
      makeView(firstPost, (listener) => {
        firstReceive = listener;
      }) as never,
    );
    firstReceive?.({ type: "ready" });

    await provider.revealTurn("conversation-1", "assistant-1");
    await vi.waitFor(() => expect(firstPost).toHaveBeenCalledTimes(2));
    expect(firstPost).toHaveBeenLastCalledWith({
      type: "revealTurn",
      conversationId: "conversation-1",
      messageId: "assistant-1",
    });

    provider.resolveWebviewView(
      makeView(secondPost, (listener) => {
        secondReceive = listener;
      }) as never,
    );
    secondReceive?.({ type: "ready" });

    await vi.waitFor(() =>
      expect(secondPost).toHaveBeenCalledWith({
        type: "revealTurn",
        conversationId: "conversation-1",
        messageId: "assistant-1",
      }),
    );
    releaseOldReveal(true);
    provider.dispose();
  });

  it("uses the generated view focus command before VS Code resolves the webview", async () => {
    const controller = {
      getState: () => appState({ activeRuns: 0 }),
      onState: () => ({ dispose: vi.fn() }),
    };
    const provider = new Ask2GPTViewProvider(
      { path: "extension" } as never,
      controller as never,
      { error: vi.fn(), info: vi.fn() } as never,
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    );

    await provider.show(true);

    expect(vscode.commands.executeCommand).toHaveBeenCalledOnce();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("ask2gpt.sidebar.focus");
    provider.dispose();
  });

  it("delivers accepted send receipts immediately followed by authoritative state", async () => {
    const initial = appState({ activeRuns: 0 });
    const accepted = appState({ activeRuns: 1 });
    let current = initial;
    const controller = {
      getState: () => current,
      onState: () => ({ dispose: vi.fn() }),
      send: vi.fn(async () => {
        current = accepted;
      }),
      enqueueFollowUp: vi.fn(async () => undefined),
      interruptWithFollowUp: vi.fn(async (): Promise<"interrupted" | "queued"> => "interrupted"),
      stop: vi.fn(async () => undefined),
    };
    const postMessage = vi.fn(async (_message: unknown) => true);
    let receiveMessage: ((message: WebviewToHostMessage) => Promise<void> | void) | undefined;
    const view = {
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      visible: true,
      webview: {
        asWebviewUri: (value: unknown) => value,
        cspSource: "test-source",
        html: "",
        onDidReceiveMessage: vi.fn(
          (listener: (message: WebviewToHostMessage) => Promise<void> | void) => {
            receiveMessage = listener;
            return { dispose: vi.fn() };
          },
        ),
        options: {},
        postMessage,
      },
    };
    const provider = new Ask2GPTViewProvider(
      { path: "extension" } as never,
      controller as never,
      { error: vi.fn(), info: vi.fn() } as never,
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    );
    provider.resolveWebviewView(view as never);
    await receiveMessage?.({ type: "ready" });
    postMessage.mockClear();
    let releaseReceipt: ((delivered: boolean) => void) | undefined;
    const receiptDelivery = new Promise<boolean>((resolve) => {
      releaseReceipt = resolve;
    });
    postMessage.mockImplementationOnce(() => receiptDelivery);

    await receiveMessage?.({
      type: "send",
      conversationId: "conversation-1",
      requestId: "request-00000000-0000-4000-8000-000000000001",
      text: "Only reply OK",
    });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "sendResult",
      accepted: true,
      conversationId: "conversation-1",
      requestId: "request-00000000-0000-4000-8000-000000000001",
    });
    releaseReceipt?.(true);
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));

    expect(controller.send).toHaveBeenCalledWith(
      "Only reply OK",
      "conversation-1",
      "request-00000000-0000-4000-8000-000000000001",
    );
    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      {
        type: "sendResult",
        accepted: true,
        conversationId: "conversation-1",
        requestId: "request-00000000-0000-4000-8000-000000000001",
      },
      { type: "state", state: accepted },
    ]);

    postMessage.mockClear();
    controller.interruptWithFollowUp.mockResolvedValueOnce("queued");
    await receiveMessage?.({
      type: "interruptWithFollowUp",
      conversationId: "conversation-1",
      targetRunId: "run-1",
      requestId: "interrupt-00000000-0000-4000-8000-000000000002",
      text: "Keep this queued if stopping fails",
    });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(3));
    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      {
        type: "sendResult",
        accepted: true,
        conversationId: "conversation-1",
        requestId: "interrupt-00000000-0000-4000-8000-000000000002",
      },
      { type: "state", state: accepted },
      {
        type: "notice",
        level: "warning",
        message: "未能停止当前回答；消息已保留，将在当前回答完成后发送。",
      },
    ]);

    postMessage.mockClear();
    await receiveMessage?.({
      type: "enqueueFollowUp",
      conversationId: "conversation-1",
      targetRunId: "run-1",
      requestId: "queue-00000000-0000-4000-8000-000000000001",
      text: "Queue this next",
    });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    expect(controller.enqueueFollowUp).toHaveBeenCalledWith(
      "Queue this next",
      "conversation-1",
      "queue-00000000-0000-4000-8000-000000000001",
      "run-1",
    );
    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      {
        type: "sendResult",
        accepted: true,
        conversationId: "conversation-1",
        requestId: "queue-00000000-0000-4000-8000-000000000001",
      },
      { type: "state", state: accepted },
    ]);

    postMessage.mockClear();
    await receiveMessage?.({
      type: "interruptWithFollowUp",
      conversationId: "conversation-1",
      targetRunId: "run-1",
      requestId: "interrupt-00000000-0000-4000-8000-000000000001",
      text: "Stop and run this next",
    });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    expect(controller.interruptWithFollowUp).toHaveBeenCalledWith(
      "Stop and run this next",
      "conversation-1",
      "interrupt-00000000-0000-4000-8000-000000000001",
      "run-1",
    );
    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      {
        type: "sendResult",
        accepted: true,
        conversationId: "conversation-1",
        requestId: "interrupt-00000000-0000-4000-8000-000000000001",
      },
      { type: "state", state: accepted },
    ]);

    postMessage.mockClear();
    await receiveMessage?.({
      type: "stop",
      conversationId: "conversation-1",
      targetRunId: "run-1",
    });
    await vi.waitFor(() => expect(controller.stop).toHaveBeenCalledWith("conversation-1", "run-1"));
    expect(postMessage).not.toHaveBeenCalled();

    provider.dispose();
  });

  it("publishes the authoritative blank state immediately after New chat", async () => {
    const initial = appState({ activeRuns: 0 });
    initial.pendingContexts = [
      {
        id: "context-old",
        kind: "selection",
        fileName: "old.ts",
        uri: "file:///old.ts",
        language: "typescript",
        startLine: 1,
        endLine: 1,
        content: "const old = true;",
        charCount: 17,
        unsaved: false,
      },
    ];
    const next = structuredClone(initial);
    next.activeConversationId = "conversation-2";
    next.pendingContexts = [];
    next.automaticContextIds = [];
    next.modelPicker.conversationId = "conversation-2";
    next.conversations.push({
      id: "conversation-2",
      title: "New conversation",
      createdAt: "2026-07-24T00:00:01.000Z",
      updatedAt: "2026-07-24T00:00:01.000Z",
      messages: [],
    });
    let current = initial;
    const controller = {
      getState: () => current,
      onState: () => ({ dispose: vi.fn() }),
      newConversation: vi.fn(async () => {
        current = next;
      }),
    };
    const postMessage = vi.fn(async (_message: unknown) => true);
    let receiveMessage: ((message: WebviewToHostMessage) => Promise<void> | void) | undefined;
    const view = {
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      visible: true,
      webview: {
        asWebviewUri: (value: unknown) => value,
        cspSource: "test-source",
        html: "",
        onDidReceiveMessage: vi.fn(
          (listener: (message: WebviewToHostMessage) => Promise<void> | void) => {
            receiveMessage = listener;
            return { dispose: vi.fn() };
          },
        ),
        options: {},
        postMessage,
      },
    };
    const provider = new Ask2GPTViewProvider(
      { path: "extension" } as never,
      controller as never,
      { error: vi.fn(), info: vi.fn() } as never,
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    );
    provider.resolveWebviewView(view as never);
    await receiveMessage?.({ type: "ready" });
    postMessage.mockClear();

    await receiveMessage?.({
      type: "newConversation",
      sourceConversationId: "conversation-1",
    });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));

    expect(controller.newConversation).toHaveBeenCalledWith("conversation-1");
    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "state", state: next },
      { type: "focusComposer" },
    ]);
    provider.dispose();
  });

  it("resolves an open-context request from the controller's current host state", async () => {
    const state = appState({ activeRuns: 0 });
    state.pendingContexts = [
      {
        id: "context-1",
        kind: "selection",
        fileName: "source.ts",
        uri: "file:///workspace/source.ts",
        language: "typescript",
        startLine: 3,
        endLine: 5,
        content: "selected",
        charCount: 8,
        unsaved: false,
      },
    ];
    const controller = {
      getState: () => state,
      onState: () => ({ dispose: vi.fn() }),
    };
    let receiveMessage: ((message: WebviewToHostMessage) => Promise<void> | void) | undefined;
    const view = {
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      visible: true,
      webview: {
        asWebviewUri: (value: unknown) => value,
        cspSource: "test-source",
        html: "",
        onDidReceiveMessage: vi.fn(
          (listener: (message: WebviewToHostMessage) => Promise<void> | void) => {
            receiveMessage = listener;
            return { dispose: vi.fn() };
          },
        ),
        options: {},
        postMessage: vi.fn(async () => true),
      },
    };
    const provider = new Ask2GPTViewProvider(
      { path: "extension" } as never,
      controller as never,
      { error: vi.fn(), info: vi.fn() } as never,
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    );
    provider.resolveWebviewView(view as never);

    await receiveMessage?.({
      type: "openContext",
      conversationId: "conversation-1",
      contextId: "context-1",
    });

    expect(contextNavigationMock.openContextFromState).toHaveBeenCalledWith(
      state,
      "conversation-1",
      "context-1",
    );
    provider.dispose();
  });

  it("routes file and symbol source references through the current host state", async () => {
    const state = appState({ activeRuns: 0 });
    const controller = {
      getState: () => state,
      onState: () => ({ dispose: vi.fn() }),
    };
    let receiveMessage: ((message: WebviewToHostMessage) => Promise<void> | void) | undefined;
    const view = {
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      visible: true,
      webview: {
        asWebviewUri: (value: unknown) => value,
        cspSource: "test-source",
        html: "",
        onDidReceiveMessage: vi.fn(
          (listener: (message: WebviewToHostMessage) => Promise<void> | void) => {
            receiveMessage = listener;
            return { dispose: vi.fn() };
          },
        ),
        options: {},
        postMessage: vi.fn(async () => true),
      },
    };
    const provider = new Ask2GPTViewProvider(
      { path: "extension" } as never,
      controller as never,
      { error: vi.fn(), info: vi.fn() } as never,
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    );
    provider.resolveWebviewView(view as never);

    void receiveMessage?.({
      type: "openSourceReference",
      conversationId: "conversation-1",
      messageId: "assistant-1",
      kind: "file-line",
      reference: "src/store.ts:34-36",
    });
    await vi.waitFor(() =>
      expect(sourceTraceMock.openAnswerSourceReferenceFromState).toHaveBeenCalledWith(
        state,
        "conversation-1",
        "assistant-1",
        "src/store.ts:34-36",
      ),
    );

    void receiveMessage?.({
      type: "openSourceReference",
      conversationId: "conversation-1",
      messageId: "assistant-1",
      kind: "symbol",
      reference: "VectorStore.search()",
    });
    await vi.waitFor(() =>
      expect(sourceTraceMock.openAnswerSymbolFromState).toHaveBeenCalledWith(
        state,
        "conversation-1",
        "assistant-1",
        "VectorStore.search()",
      ),
    );

    expect(sourceTraceMock.openAnswerSourceReferenceFromState).toHaveBeenCalledOnce();
    expect(sourceTraceMock.openAnswerSymbolFromState).toHaveBeenCalledOnce();
    provider.dispose();
  });

  it("sends current state on ready and coalesces a burst into one frame", async () => {
    vi.useFakeTimers();
    const initial = appState({ activeRuns: 0 });
    let current = initial;
    let stateListener: ((state: AppState) => void) | undefined;
    let generationListener: ((update: GenerationViewUpdate) => void) | undefined;
    const controller = {
      getState: () => current,
      onState: (listener: (state: AppState) => void) => {
        stateListener = listener;
        return { dispose: vi.fn() };
      },
      onGeneration: (listener: (update: GenerationViewUpdate) => void) => {
        generationListener = listener;
        return { dispose: vi.fn() };
      },
    };
    const postMessage = vi.fn(async () => true);
    let receiveMessage: ((message: WebviewToHostMessage) => void) | undefined;
    const view = {
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      visible: true,
      webview: {
        asWebviewUri: (value: unknown) => value,
        cspSource: "test-source",
        html: "",
        onDidReceiveMessage: vi.fn((listener: (message: WebviewToHostMessage) => void) => {
          receiveMessage = listener;
          return { dispose: vi.fn() };
        }),
        options: {},
        postMessage,
      },
    };
    const provider = new Ask2GPTViewProvider(
      { path: "extension" } as never,
      controller as never,
      { error: vi.fn(), info: vi.fn() } as never,
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    );
    provider.resolveWebviewView(view as never);

    const beforeReady = appState({ activeRuns: 1 });
    current = beforeReady;
    stateListener?.(beforeReady);
    await vi.advanceTimersByTimeAsync(20);
    expect(postMessage).not.toHaveBeenCalled();

    receiveMessage?.({ type: "ready" });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "state", state: beforeReady });
    postMessage.mockClear();

    const intermediate = appState({ activeRuns: 2 });
    const latest = appState({ activeRuns: 3 });
    stateListener?.(intermediate);
    stateListener?.(latest);
    expect(postMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(39);
    expect(postMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "state", state: latest });
    postMessage.mockClear();

    current = streamingState("older snapshot");
    const compactUpdate: GenerationViewUpdate = {
      conversationId: "conversation-1",
      messageId: "assistant-1",
      runId: "run-1",
      markdown: "newest snapshot",
      updatedAt: "2026-07-25T00:00:01.000Z",
    };
    generationListener?.({ ...compactUpdate, markdown: "older snapshot" });
    generationListener?.(compactUpdate);
    await vi.advanceTimersByTimeAsync(39);
    expect(postMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "generationUpdate",
      update: compactUpdate,
    });

    provider.dispose();
  });

  it("coalesces long generation bursts and lets terminal state immediately supersede them", async () => {
    vi.useFakeTimers();
    let current = streamingState("partial");
    let stateListener: ((state: AppState) => void) | undefined;
    let generationListener: ((update: GenerationViewUpdate) => void) | undefined;
    let receiveMessage: ((message: WebviewToHostMessage) => void) | undefined;
    const postMessage = vi.fn(async () => true);
    const controller = {
      getState: () => current,
      onState: (listener: (state: AppState) => void) => {
        stateListener = listener;
        return { dispose: vi.fn() };
      },
      onGeneration: (listener: (update: GenerationViewUpdate) => void) => {
        generationListener = listener;
        return { dispose: vi.fn() };
      },
    };
    const view = {
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      visible: true,
      webview: {
        asWebviewUri: (value: unknown) => value,
        cspSource: "test-source",
        html: "",
        onDidReceiveMessage: vi.fn((listener: (message: WebviewToHostMessage) => void) => {
          receiveMessage = listener;
          return { dispose: vi.fn() };
        }),
        options: {},
        postMessage,
      },
    };
    const provider = new Ask2GPTViewProvider(
      { path: "extension" } as never,
      controller as never,
      { error: vi.fn(), info: vi.fn() } as never,
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    );
    provider.resolveWebviewView(view as never);
    receiveMessage?.({ type: "ready" });

    const update: GenerationViewUpdate = {
      conversationId: "conversation-1",
      messageId: "assistant-1",
      runId: "run-1",
      markdown: "x".repeat(40_000),
      updatedAt: "2026-07-25T00:00:01.000Z",
    };
    generationListener?.({ ...update, markdown: "older" });
    generationListener?.(update);
    await vi.advanceTimersByTimeAsync(59);
    expect(postMessage).not.toHaveBeenCalled();

    const terminal = structuredClone(current);
    terminal.conversations[0]!.run = undefined;
    terminal.conversations[0]!.messages[0]!.markdown = "complete answer";
    terminal.conversations[0]!.messages[0]!.status = "complete";
    current = terminal;
    stateListener?.(terminal);

    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenLastCalledWith({ type: "state", state: terminal });
    await vi.advanceTimersByTimeAsync(100);
    expect(postMessage).toHaveBeenCalledOnce();

    generationListener?.({ ...update, markdown: "stale after complete" });
    await vi.advanceTimersByTimeAsync(100);
    expect(postMessage).toHaveBeenCalledOnce();
    provider.dispose();
  });

  it("keeps only the latest queued frame for a generation without overtaking controls", async () => {
    vi.useFakeTimers();
    const current = streamingState("initial");
    let releaseFirst: ((delivered: boolean) => void) | undefined;
    const firstDelivery = new Promise<boolean>((resolve) => {
      releaseFirst = resolve;
    });
    const postMessage = vi.fn((_message: unknown) =>
      postMessage.mock.calls.length === 1 ? firstDelivery : Promise.resolve(true),
    );
    const harness = createStateDeliveryHarness(() => current, postMessage);
    harness.ready();

    const first: GenerationViewUpdate = {
      conversationId: "conversation-1",
      messageId: "assistant-1",
      runId: "run-1",
      markdown: "first compact frame",
      updatedAt: "2026-07-25T00:00:01.000Z",
    };
    harness.emitGeneration(first);
    await vi.advanceTimersByTimeAsync(40);
    expect(postMessage).toHaveBeenCalledOnce();

    const superseded = {
      ...first,
      markdown: "superseded compact frame",
      updatedAt: "2026-07-25T00:00:02.000Z",
    };
    harness.emitGeneration(superseded);
    await vi.advanceTimersByTimeAsync(40);
    expect(postMessage).toHaveBeenCalledOnce();

    await harness.provider.show(true);
    const latest = {
      ...first,
      markdown: "latest compact frame",
      updatedAt: "2026-07-25T00:00:03.000Z",
    };
    harness.emitGeneration(latest);
    await vi.advanceTimersByTimeAsync(40);
    expect(postMessage).toHaveBeenCalledOnce();

    releaseFirst?.(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "generationUpdate", update: first },
      { type: "focusComposer" },
      { type: "generationUpdate", update: latest },
    ]);
    harness.provider.dispose();
  });

  it("lets a full streaming state supersede a compact frame already queued behind backpressure", async () => {
    vi.useFakeTimers();
    let current = streamingState("initial");
    let releaseFirst: ((delivered: boolean) => void) | undefined;
    const firstDelivery = new Promise<boolean>((resolve) => {
      releaseFirst = resolve;
    });
    const postMessage = vi.fn((_message: unknown) =>
      postMessage.mock.calls.length === 1 ? firstDelivery : Promise.resolve(true),
    );
    const harness = createStateDeliveryHarness(() => current, postMessage);
    harness.ready();

    const first: GenerationViewUpdate = {
      conversationId: "conversation-1",
      messageId: "assistant-1",
      runId: "run-1",
      markdown: "first compact frame",
      updatedAt: "2026-07-25T00:00:01.000Z",
    };
    harness.emitGeneration(first);
    await vi.advanceTimersByTimeAsync(40);

    const queued = {
      ...first,
      markdown: "queued compact frame",
      updatedAt: "2026-07-25T00:00:02.000Z",
    };
    harness.emitGeneration(queued);
    await vi.advanceTimersByTimeAsync(40);
    expect(postMessage).toHaveBeenCalledOnce();

    const authoritative = structuredClone(current);
    authoritative.conversations[0]!.messages[0]!.markdown = "authoritative streaming frame";
    authoritative.conversations[0]!.updatedAt = "2026-07-25T00:00:03.000Z";
    current = authoritative;
    harness.emitState(authoritative);
    await vi.advanceTimersByTimeAsync(40);
    expect(postMessage).toHaveBeenCalledOnce();

    releaseFirst?.(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "generationUpdate", update: first },
      { type: "state", state: authoritative },
    ]);
    harness.provider.dispose();
  });

  it("delivers terminal state after pending controls instead of stale queued generation frames", async () => {
    vi.useFakeTimers();
    let current = streamingState("initial");
    let releaseFirst: ((delivered: boolean) => void) | undefined;
    const firstDelivery = new Promise<boolean>((resolve) => {
      releaseFirst = resolve;
    });
    const postMessage = vi.fn((_message: unknown) =>
      postMessage.mock.calls.length === 1 ? firstDelivery : Promise.resolve(true),
    );
    const harness = createStateDeliveryHarness(() => current, postMessage);
    harness.ready();

    const first: GenerationViewUpdate = {
      conversationId: "conversation-1",
      messageId: "assistant-1",
      runId: "run-1",
      markdown: "first compact frame",
      updatedAt: "2026-07-25T00:00:01.000Z",
    };
    harness.emitGeneration(first);
    await vi.advanceTimersByTimeAsync(40);

    harness.emitGeneration({
      ...first,
      markdown: "stale queued compact frame",
      updatedAt: "2026-07-25T00:00:02.000Z",
    });
    await vi.advanceTimersByTimeAsync(40);
    await harness.provider.show(true);
    expect(postMessage).toHaveBeenCalledOnce();

    const terminal = structuredClone(current);
    terminal.backend.activeRuns = 0;
    terminal.conversations[0]!.run = undefined;
    terminal.conversations[0]!.messages[0]!.markdown = "complete answer";
    terminal.conversations[0]!.messages[0]!.status = "complete";
    terminal.conversations[0]!.updatedAt = "2026-07-25T00:00:03.000Z";
    current = terminal;
    harness.emitState(terminal);
    expect(postMessage).toHaveBeenCalledOnce();

    releaseFirst?.(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "generationUpdate", update: first },
      { type: "focusComposer" },
      { type: "state", state: terminal },
    ]);
    harness.provider.dispose();
  });

  it("times out a non-settling compact delivery and advances to authoritative terminal state", async () => {
    vi.useFakeTimers();
    let current = streamingState("initial");
    const neverSettles = new Promise<boolean>(() => undefined);
    const postMessage = vi.fn((_message: unknown) =>
      postMessage.mock.calls.length === 1 ? neverSettles : Promise.resolve(true),
    );
    const harness = createStateDeliveryHarness(() => current, postMessage, 100);
    harness.ready();

    const first: GenerationViewUpdate = {
      conversationId: "conversation-1",
      messageId: "assistant-1",
      runId: "run-1",
      markdown: "first compact frame",
      updatedAt: "2026-07-25T00:00:01.000Z",
    };
    harness.emitGeneration(first);
    await vi.advanceTimersByTimeAsync(40);
    harness.emitGeneration({
      ...first,
      markdown: "stale queued compact frame",
      updatedAt: "2026-07-25T00:00:02.000Z",
    });
    await vi.advanceTimersByTimeAsync(40);

    const terminal = structuredClone(current);
    terminal.backend.activeRuns = 0;
    terminal.conversations[0]!.run = undefined;
    terminal.conversations[0]!.messages[0]!.markdown = "complete answer";
    terminal.conversations[0]!.messages[0]!.status = "complete";
    current = terminal;
    harness.emitState(terminal);

    await vi.advanceTimersByTimeAsync(59);
    expect(postMessage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "generationUpdate", update: first },
      { type: "state", state: terminal },
    ]);
    expect(harness.logger.error).toHaveBeenCalledWith(
      "webview.post-timeout",
      "WEBVIEW_POST_TIMEOUT",
      expect.objectContaining({ messageType: "generationUpdate", timeoutMs: 100 }),
    );
    harness.provider.dispose();
  });

  it("ignores a timed-out delivery's late settlement while a newer delivery is active", async () => {
    vi.useFakeTimers();
    let current = streamingState("initial");
    let releaseFirst: ((delivered: boolean) => void) | undefined;
    let releaseTerminal: ((delivered: boolean) => void) | undefined;
    const firstDelivery = new Promise<boolean>((resolve) => {
      releaseFirst = resolve;
    });
    const terminalDelivery = new Promise<boolean>((resolve) => {
      releaseTerminal = resolve;
    });
    const postMessage = vi.fn((_message: unknown) => {
      if (postMessage.mock.calls.length === 1) return firstDelivery;
      if (postMessage.mock.calls.length === 2) return terminalDelivery;
      return Promise.resolve(true);
    });
    const harness = createStateDeliveryHarness(() => current, postMessage, 100);
    harness.ready();

    const first: GenerationViewUpdate = {
      conversationId: "conversation-1",
      messageId: "assistant-1",
      runId: "run-1",
      markdown: "first compact frame",
      updatedAt: "2026-07-25T00:00:01.000Z",
    };
    harness.emitGeneration(first);
    await vi.advanceTimersByTimeAsync(40);

    const terminal = structuredClone(current);
    terminal.backend.activeRuns = 0;
    terminal.conversations[0]!.run = undefined;
    terminal.conversations[0]!.messages[0]!.markdown = "complete answer";
    terminal.conversations[0]!.messages[0]!.status = "complete";
    current = terminal;
    harness.emitState(terminal);
    await vi.advanceTimersByTimeAsync(100);
    expect(postMessage).toHaveBeenCalledTimes(2);

    releaseFirst?.(true);
    await vi.advanceTimersByTimeAsync(0);
    await harness.provider.show(true);
    expect(postMessage).toHaveBeenCalledTimes(2);

    releaseTerminal?.(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "generationUpdate", update: first },
      { type: "state", state: terminal },
      { type: "focusComposer" },
    ]);
    harness.provider.dispose();
  });

  it("keeps delivering coalesced state while VS Code reports the retained view hidden", async () => {
    vi.useFakeTimers();
    let current = appState({ activeRuns: 0 });
    let stateListener: ((state: AppState) => void) | undefined;
    let visibilityListener: (() => void) | undefined;
    let receiveMessage: ((message: WebviewToHostMessage) => void) | undefined;
    const postMessage = vi.fn(async () => true);
    const view = {
      onDidChangeVisibility: vi.fn((listener: () => void) => {
        visibilityListener = listener;
        return { dispose: vi.fn() };
      }),
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      visible: true,
      webview: {
        asWebviewUri: (value: unknown) => value,
        cspSource: "test-source",
        html: "",
        onDidReceiveMessage: vi.fn((listener: (message: WebviewToHostMessage) => void) => {
          receiveMessage = listener;
          return { dispose: vi.fn() };
        }),
        options: {},
        postMessage,
      },
    };
    const controller = {
      getState: () => current,
      onState: (listener: (state: AppState) => void) => {
        stateListener = listener;
        return { dispose: vi.fn() };
      },
    };
    const provider = new Ask2GPTViewProvider(
      { path: "extension" } as never,
      controller as never,
      { error: vi.fn(), info: vi.fn() } as never,
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    );
    provider.resolveWebviewView(view as never);
    receiveMessage?.({ type: "ready" });
    expect(postMessage).not.toHaveBeenCalled();

    view.visible = false;
    visibilityListener?.();
    current = appState({ activeRuns: 1 });
    stateListener?.(current);
    current = appState({ activeRuns: 2 });
    stateListener?.(current);
    await vi.advanceTimersByTimeAsync(59);
    expect(postMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenLastCalledWith({ type: "state", state: current });
    postMessage.mockClear();

    view.visible = true;
    visibilityListener?.();
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({ type: "state", state: current });
    provider.dispose();
  });

  it("retries a dropped terminal snapshot and stops after the first confirmed delivery", async () => {
    vi.useFakeTimers();
    let current = streamingState("partial");
    const postMessage = vi.fn(async (_message: unknown) => true);
    postMessage.mockResolvedValueOnce(false);
    const harness = createStateDeliveryHarness(() => current, postMessage);
    harness.ready();

    const terminal = structuredClone(current);
    terminal.backend.activeRuns = 0;
    terminal.conversations[0]!.run = undefined;
    terminal.conversations[0]!.messages[0]!.markdown = "complete answer";
    terminal.conversations[0]!.messages[0]!.status = "complete";
    current = terminal;
    harness.emitState(terminal);

    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenLastCalledWith({ type: "state", state: terminal });
    await vi.advanceTimersByTimeAsync(99);
    expect(postMessage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "state", state: terminal });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(postMessage).toHaveBeenCalledTimes(2);
    harness.provider.dispose();
  });

  it("retries the newest terminal snapshot after postMessage rejects", async () => {
    vi.useFakeTimers();
    let current = streamingState("partial");
    const postMessage = vi.fn(async (_message: unknown) => true);
    postMessage.mockRejectedValueOnce(new Error("renderer unavailable"));
    const harness = createStateDeliveryHarness(() => current, postMessage);
    harness.ready();

    const firstTerminal = structuredClone(current);
    firstTerminal.backend.activeRuns = 0;
    firstTerminal.conversations[0]!.run = undefined;
    firstTerminal.conversations[0]!.messages[0]!.markdown = "first terminal snapshot";
    firstTerminal.conversations[0]!.messages[0]!.status = "complete";
    current = firstTerminal;
    harness.emitState(firstTerminal);

    const latestTerminal = structuredClone(firstTerminal);
    latestTerminal.backend.connection.lastConnectedAt = "2026-07-25T00:00:02.000Z";
    latestTerminal.conversations[0]!.messages[0]!.markdown = "latest terminal snapshot";
    current = latestTerminal;
    harness.emitState(latestTerminal);

    expect(postMessage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "state", state: latestTerminal });
    expect(harness.logger.error).toHaveBeenCalledWith(
      "webview.post-failed",
      "WEBVIEW_POST_FAILED",
      expect.objectContaining({ messageType: "state", name: "Error" }),
    );
    harness.provider.dispose();
  });

  it("serializes state delivery and coalesces queued snapshots to the latest terminal frame", async () => {
    vi.useFakeTimers();
    let current = streamingState("initial");
    let releaseFirst: ((delivered: boolean) => void) | undefined;
    let activePosts = 0;
    let maxActivePosts = 0;
    const firstDelivery = new Promise<boolean>((resolve) => {
      releaseFirst = resolve;
    });
    const postMessage = vi.fn((_message: unknown) => {
      activePosts += 1;
      maxActivePosts = Math.max(maxActivePosts, activePosts);
      const result = postMessage.mock.calls.length === 1 ? firstDelivery : Promise.resolve(true);
      return result.finally(() => {
        activePosts -= 1;
      });
    });
    const harness = createStateDeliveryHarness(() => current, postMessage);
    harness.ready();

    const first = structuredClone(current);
    first.conversations[0]!.messages[0]!.markdown = "first streaming snapshot";
    first.conversations[0]!.updatedAt = "2026-07-25T00:00:01.000Z";
    current = first;
    harness.emitState(first);
    await vi.advanceTimersByTimeAsync(40);
    expect(postMessage).toHaveBeenCalledOnce();

    const intermediate = structuredClone(first);
    intermediate.conversations[0]!.messages[0]!.markdown = "intermediate snapshot";
    intermediate.conversations[0]!.updatedAt = "2026-07-25T00:00:02.000Z";
    current = intermediate;
    harness.emitState(intermediate);
    const terminal = structuredClone(intermediate);
    terminal.backend.activeRuns = 0;
    terminal.conversations[0]!.run = undefined;
    terminal.conversations[0]!.messages[0]!.markdown = "terminal snapshot";
    terminal.conversations[0]!.messages[0]!.status = "complete";
    terminal.conversations[0]!.updatedAt = "2026-07-25T00:00:03.000Z";
    current = terminal;
    harness.emitState(terminal);

    expect(postMessage).toHaveBeenCalledOnce();
    releaseFirst?.(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "state", state: first },
      { type: "state", state: terminal },
    ]);
    expect(maxActivePosts).toBe(1);
    harness.provider.dispose();
  });

  it("promotes a dropped compact generation update to the current full state", async () => {
    vi.useFakeTimers();
    let current = streamingState("partial");
    const postMessage = vi.fn(async (_message: unknown) => true);
    postMessage.mockResolvedValueOnce(false);
    const harness = createStateDeliveryHarness(() => current, postMessage);
    harness.ready();

    current = streamingState("authoritative newest snapshot");
    current.conversations[0]!.updatedAt = "2026-07-25T00:00:01.000Z";
    const update: GenerationViewUpdate = {
      conversationId: "conversation-1",
      messageId: "assistant-1",
      runId: "run-1",
      markdown: "compact newest snapshot",
      updatedAt: "2026-07-25T00:00:01.000Z",
    };
    harness.emitGeneration(update);
    await vi.advanceTimersByTimeAsync(40);
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenLastCalledWith({ type: "generationUpdate", update });

    await vi.advanceTimersByTimeAsync(100);
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "state", state: current });
    harness.provider.dispose();
  });

  it("does not revive delivery retries when an in-flight compact update settles after dispose", async () => {
    vi.useFakeTimers();
    const current = streamingState("partial");
    let releaseDelivery: ((delivered: boolean) => void) | undefined;
    const pendingDelivery = new Promise<boolean>((resolve) => {
      releaseDelivery = resolve;
    });
    const postMessage = vi.fn(() => pendingDelivery);
    const harness = createStateDeliveryHarness(() => current, postMessage);
    harness.ready();

    const update: GenerationViewUpdate = {
      conversationId: "conversation-1",
      messageId: "assistant-1",
      runId: "run-1",
      markdown: "compact pending during dispose",
      updatedAt: "2026-07-25T00:00:01.000Z",
    };
    harness.emitGeneration(update);
    await vi.advanceTimersByTimeAsync(40);
    expect(postMessage).toHaveBeenCalledOnce();

    harness.provider.dispose();
    releaseDelivery?.(false);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(postMessage).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for visibility before retrying a hidden dropped terminal state", async () => {
    vi.useFakeTimers();
    let current = streamingState("partial");
    const postMessage = vi.fn(async (_message: unknown) => true);
    postMessage.mockResolvedValueOnce(false);
    const harness = createStateDeliveryHarness(() => current, postMessage);
    harness.ready();
    harness.setVisible(false);

    const terminal = structuredClone(current);
    terminal.backend.activeRuns = 0;
    terminal.conversations[0]!.run = undefined;
    terminal.conversations[0]!.messages[0]!.markdown = "complete while hidden";
    terminal.conversations[0]!.messages[0]!.status = "complete";
    current = terminal;
    harness.emitState(terminal);
    expect(postMessage).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(postMessage).toHaveBeenCalledOnce();
    harness.setVisible(true);
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "state", state: terminal });
    harness.provider.dispose();
  });

  it("does not let a replaced view's delayed delivery result affect the new view", async () => {
    vi.useFakeTimers();
    let current = appState({ activeRuns: 0 });
    let stateListener: ((state: AppState) => void) | undefined;
    let firstReceive: ((message: WebviewToHostMessage) => void) | undefined;
    let secondReceive: ((message: WebviewToHostMessage) => void) | undefined;
    let releaseFirst: ((delivered: boolean) => void) | undefined;
    const firstDelivery = new Promise<boolean>((resolve) => {
      releaseFirst = resolve;
    });
    const firstPost = vi.fn(() => firstDelivery);
    const secondPost = vi.fn(async () => true);
    const controller = {
      getState: () => current,
      onState: (listener: (state: AppState) => void) => {
        stateListener = listener;
        return { dispose: vi.fn() };
      },
    };
    const makeView = (
      postMessage: (message: unknown) => PromiseLike<boolean>,
      receive: (listener: (message: WebviewToHostMessage) => void) => void,
    ) => ({
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      visible: true,
      webview: {
        asWebviewUri: (value: unknown) => value,
        cspSource: "test-source",
        html: "",
        onDidReceiveMessage: vi.fn((listener: (message: WebviewToHostMessage) => void) => {
          receive(listener);
          return { dispose: vi.fn() };
        }),
        options: {},
        postMessage,
      },
    });
    const provider = new Ask2GPTViewProvider(
      { path: "extension" } as never,
      controller as never,
      { error: vi.fn(), info: vi.fn() } as never,
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    );

    provider.resolveWebviewView(
      makeView(firstPost, (listener) => {
        firstReceive = listener;
      }) as never,
    );
    firstReceive?.({ type: "ready" });
    current = appState({ activeRuns: 1 });
    stateListener?.(current);
    await vi.advanceTimersByTimeAsync(40);
    expect(firstPost).toHaveBeenCalledOnce();

    provider.resolveWebviewView(
      makeView(secondPost, (listener) => {
        secondReceive = listener;
      }) as never,
    );
    secondReceive?.({ type: "ready" });
    expect(secondPost).not.toHaveBeenCalled();

    const next = appState({ activeRuns: 2 });
    current = next;
    stateListener?.(next);
    await vi.advanceTimersByTimeAsync(40);
    expect(secondPost).toHaveBeenCalledOnce();
    expect(secondPost).toHaveBeenLastCalledWith({ type: "state", state: next });

    releaseFirst?.(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(secondPost).toHaveBeenCalledOnce();
    provider.dispose();
  });

  it("ignores a delayed ready message from a replaced webview", () => {
    const state = appState({ activeRuns: 0 });
    const controller = {
      getState: () => state,
      onState: () => ({ dispose: vi.fn() }),
    };
    const firstPost = vi.fn(async () => true);
    const secondPost = vi.fn(async () => true);
    let firstReceive: ((message: WebviewToHostMessage) => void) | undefined;
    let secondReceive: ((message: WebviewToHostMessage) => void) | undefined;
    const makeView = (
      postMessage: typeof firstPost,
      receive: (listener: (message: WebviewToHostMessage) => void) => void,
    ) => ({
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      visible: true,
      webview: {
        asWebviewUri: (value: unknown) => value,
        cspSource: "test-source",
        html: "",
        onDidReceiveMessage: vi.fn((listener: (message: WebviewToHostMessage) => void) => {
          receive(listener);
          return { dispose: vi.fn() };
        }),
        options: {},
        postMessage,
      },
    });
    const provider = new Ask2GPTViewProvider(
      { path: "extension" } as never,
      controller as never,
      { error: vi.fn(), info: vi.fn() } as never,
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    );
    provider.resolveWebviewView(
      makeView(firstPost, (listener) => {
        firstReceive = listener;
      }) as never,
    );
    provider.resolveWebviewView(
      makeView(secondPost, (listener) => {
        secondReceive = listener;
      }) as never,
    );

    firstReceive?.({ type: "ready" });
    expect(firstPost).not.toHaveBeenCalled();
    expect(secondPost).not.toHaveBeenCalled();

    secondReceive?.({ type: "ready" });
    expect(secondPost).not.toHaveBeenCalled();
    provider.dispose();
  });

  it("embeds the initial state with a nonce and escapes script-breaking content", () => {
    const state = appState({ activeRuns: 0 });
    state.conversations[0]!.title = '</script><img src=x onerror="alert(1)">&\u2028';
    const controller = {
      getState: () => state,
      onState: () => ({ dispose: vi.fn() }),
    };
    const view = {
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      visible: true,
      webview: {
        asWebviewUri: (value: unknown) => value,
        cspSource: "test-source",
        html: "",
        onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
        options: {},
        postMessage: vi.fn(async () => true),
      },
    };
    const provider = new Ask2GPTViewProvider(
      { path: "extension" } as never,
      controller as never,
      { error: vi.fn(), info: vi.fn() } as never,
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    );
    provider.resolveWebviewView(view as never);

    expect(view.webview.html).not.toContain("</script><img");
    expect(view.webview.html).not.toContain("\u2028");
    expect(view.webview.html).toContain(
      '\\u003c/script\\u003e\\u003cimg src=x onerror=\\"alert(1)\\"\\u003e\\u0026\\u2028',
    );
    const styleNonce = /<style nonce="([^"]+)">/.exec(view.webview.html)?.[1];
    expect(styleNonce).toBeTruthy();
    expect(view.webview.html).toContain(`style-src test-source 'nonce-${styleNonce}'`);
    expect(view.webview.html).toContain(
      `<script id="ask2gpt-initial-state" nonce="${styleNonce}" type="application/json">`,
    );
    expect(view.webview.html).toContain("<title>Ask2GPT</title>");
    expect(view.webview.html).not.toContain("Chrome Relay Coding Chat");
    provider.dispose();
  });
});

function createStateDeliveryHarness(
  getState: () => AppState,
  postMessage: (message: unknown) => PromiseLike<boolean>,
  deliveryTimeoutMs?: number,
) {
  let stateListener: ((state: AppState) => void) | undefined;
  let generationListener: ((update: GenerationViewUpdate) => void) | undefined;
  let receiveMessage: ((message: WebviewToHostMessage) => void) | undefined;
  let visibilityListener: (() => void) | undefined;
  let disposeListener: (() => void) | undefined;
  const controller = {
    getState,
    onState: (listener: (state: AppState) => void) => {
      stateListener = listener;
      return { dispose: vi.fn() };
    },
    onGeneration: (listener: (update: GenerationViewUpdate) => void) => {
      generationListener = listener;
      return { dispose: vi.fn() };
    },
  };
  const view = {
    onDidChangeVisibility: vi.fn((listener: () => void) => {
      visibilityListener = listener;
      return { dispose: vi.fn() };
    }),
    onDidDispose: vi.fn((listener: () => void) => {
      disposeListener = listener;
      return { dispose: vi.fn() };
    }),
    visible: true,
    webview: {
      asWebviewUri: (value: unknown) => value,
      cspSource: "test-source",
      html: "",
      onDidReceiveMessage: vi.fn((listener: (message: WebviewToHostMessage) => void) => {
        receiveMessage = listener;
        return { dispose: vi.fn() };
      }),
      options: {},
      postMessage,
    },
  };
  const logger = { error: vi.fn(), info: vi.fn() };
  const provider = new Ask2GPTViewProvider(
    { path: "extension" } as never,
    controller as never,
    logger as never,
    vi.fn(async () => undefined),
    vi.fn(async () => undefined),
    deliveryTimeoutMs,
  );
  provider.resolveWebviewView(view as never);
  return {
    disposeView: () => disposeListener?.(),
    emitGeneration: (update: GenerationViewUpdate) => generationListener?.(update),
    emitState: (state: AppState) => stateListener?.(state),
    logger,
    provider,
    ready: () => receiveMessage?.({ type: "ready" }),
    setVisible: (visible: boolean) => {
      view.visible = visible;
      visibilityListener?.();
    },
    view,
  };
}

function appState({ activeRuns }: { activeRuns: number }): AppState {
  const now = "2026-07-24T00:00:00.000Z";
  return {
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
}

function streamingState(markdown: string): AppState {
  const state = appState({ activeRuns: 1 });
  state.conversations[0]!.messages.push({
    id: "assistant-1",
    role: "assistant",
    markdown,
    status: "streaming",
    createdAt: "2026-07-25T00:00:00.000Z",
  });
  state.conversations[0]!.run = {
    id: "run-1",
    messageId: "assistant-1",
    status: "streaming",
    startedAt: "2026-07-25T00:00:00.000Z",
  };
  return state;
}
