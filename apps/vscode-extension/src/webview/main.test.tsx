// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ContextSnapshot } from "@ask2gpt/protocol";

import type { AppState, HostToWebviewMessage, WebviewToHostMessage } from "../types";

const posted: WebviewToHostMessage[] = [];
let App: typeof import("./main").App;

beforeAll(async () => {
  vi.stubGlobal("acquireVsCodeApi", () => ({
    getState: () => undefined,
    postMessage: (message: WebviewToHostMessage) => posted.push(message),
    setState: () => undefined,
  }));
  vi.stubGlobal("crypto", {
    ...globalThis.crypto,
    randomUUID: () => "request-00000000-0000-4000-8000-000000000001",
  });
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  Element.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = "";
  ({ App } = await import("./main"));
});

afterEach(() => {
  cleanup();
  posted.length = 0;
  vi.useRealTimers();
});

describe("Ask2GPT webview", () => {
  it("renders the host-provided initial state without waiting for a message round trip", () => {
    const initialState = makeState();
    const initialStateElement = document.createElement("script");
    initialStateElement.id = "ask2gpt-initial-state";
    initialStateElement.type = "application/json";
    initialStateElement.textContent = JSON.stringify(initialState);
    document.body.append(initialStateElement);

    render(<App />);

    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(document.getElementById("ask2gpt-initial-state")).toBeNull();
  });

  it("shows recent ChatGPT-synced conversations on the initial screen", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations.push({
      id: "conversation-history",
      title: "Compare event-driven architectures",
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
      messages: [
        {
          id: "question-history",
          role: "user",
          markdown: "Compare them",
          status: "complete",
          createdAt: "2026-07-25T00:00:00.000Z",
        },
      ],
    });
    sendHostMessage({ type: "state", state });

    expect(await screen.findByRole("region", { name: "Ask2GPT home" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
    expect(screen.queryByText("Ask clearly, then act")).toBeNull();
    expect(screen.getByPlaceholderText("Describe a task or ask about code…")).toBeTruthy();
    expect(document.querySelector(".home-state__mark")).toBeNull();
    const composer = screen.getByRole("textbox");
    fireEvent.click(screen.getByRole("button", { name: /Compare event-driven architectures/ }));
    expect(posted).toContainEqual({
      type: "selectConversation",
      conversationId: "conversation-history",
    });

    const selected = structuredClone(state);
    selected.activeConversationId = "conversation-history";
    selected.modelPicker.conversationId = "conversation-history";
    sendHostMessage({ type: "state", state: selected });
    await vi.waitFor(() => expect(document.activeElement).toBe(composer));
  });

  it("uses the conversation title as the Codex-style history trigger", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.title = "New chat";
    sendHostMessage({ type: "state", state });

    const heading = document.querySelector(".conversation-heading");
    expect(heading?.textContent).toBe("New chat");
    const historyTrigger = await screen.findByRole("button", {
      name: "New chat · Recent chats",
    });
    expect(heading?.querySelector("button")).toBe(historyTrigger);
    expect(historyTrigger.querySelector(".conversation-heading__history-icon")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Recent chats" })).toBeNull();
    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();
    expect(document.querySelectorAll(".header-actions button")).toHaveLength(1);
    fireEvent.click(historyTrigger);
    expect(screen.getByRole("dialog", { name: "Recent chats" })).toBeTruthy();

    const activeState = structuredClone(state);
    activeState.conversations[0]!.title = "Review relay recovery";
    activeState.conversations[0]!.messages.push({
      id: "question-header",
      role: "user",
      markdown: "Review the recovery flow",
      status: "complete",
      createdAt: new Date().toISOString(),
    });
    sendHostMessage({ type: "state", state: activeState });

    expect(document.querySelector(".conversation-heading")?.textContent).toBe(
      "Review relay recovery",
    );
  });

  it("keeps the Codex control hierarchy singular and ordered", () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    sendHostMessage({ type: "state", state });

    const header = document.querySelector(".conversation-toolbar") as HTMLElement;
    expect(
      within(header)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([expect.stringContaining("Recent chats"), "New chat"]);

    const composerToolbar = document.querySelector(".composer-toolbar") as HTMLElement;
    expect(
      within(composerToolbar)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Context", "Choose model", "Send"]);
  });

  it("uses the Codex Ctrl+N shortcut once per authoritative new-chat handoff", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    sendHostMessage({ type: "state", state });

    fireEvent.click(await screen.findByTitle("Recent chats"));
    expect(screen.getByRole("dialog", { name: "Recent chats" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "n" });
    fireEvent.keyDown(window, { key: "n", ctrlKey: true, shiftKey: true });
    expect(posted.filter((message) => message.type === "newConversation")).toHaveLength(0);

    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    fireEvent.keyDown(window, { key: "n", ctrlKey: true, repeat: true });
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    expect(posted.filter((message) => message.type === "newConversation")).toEqual([
      { type: "newConversation", sourceConversationId: "conversation-1" },
    ]);
    expect(screen.queryByRole("dialog", { name: "Recent chats" })).toBeNull();

    const next = structuredClone(state);
    next.activeConversationId = "conversation-2";
    next.modelPicker.conversationId = "conversation-2";
    next.conversations.push({
      id: "conversation-2",
      title: "Second conversation",
      createdAt: "2026-07-25T00:00:01.000Z",
      updatedAt: "2026-07-25T00:00:01.000Z",
      messages: [],
    });
    sendHostMessage({ type: "state", state: next });

    fireEvent.keyDown(window, { key: "N", ctrlKey: true });
    expect(posted.filter((message) => message.type === "newConversation")).toEqual([
      { type: "newConversation", sourceConversationId: "conversation-1" },
      { type: "newConversation", sourceConversationId: "conversation-2" },
    ]);
  });

  it("prewarms dispatch on composer activity without messaging on every keystroke", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    render(<App />);
    const state = makeState();
    sendHostMessage({ type: "state", state });
    const composer = await screen.findByRole("textbox");
    posted.length = 0;

    fireEvent.pointerDown(composer);
    fireEvent.change(composer, { target: { value: "Explain" } });
    expect(posted.filter((message) => message.type === "prepareConversation")).toEqual([
      { type: "prepareConversation", conversationId: state.activeConversationId },
    ]);

    now.mockReturnValue(13_001);
    fireEvent.change(composer, { target: { value: "Explain this flow" } });
    expect(posted.filter((message) => message.type === "prepareConversation")).toHaveLength(2);
    now.mockRestore();
  });

  it("uses concise state-aware composer prompts", async () => {
    render(<App />);
    const emptyState = makeState();
    emptyState.locale = "en";
    sendHostMessage({ type: "state", state: emptyState });
    expect(await screen.findByPlaceholderText("Describe a task or ask about code…")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Ask Ask2GPT" })).toBeTruthy();

    const followUpState = makeState();
    followUpState.locale = "en";
    followUpState.conversations[0]!.messages.push({
      id: "existing-question",
      role: "user",
      markdown: "Explain this",
      status: "complete",
      createdAt: "2026-07-25T00:00:00.000Z",
    });
    sendHostMessage({ type: "state", state: followUpState });
    expect(
      await screen.findByPlaceholderText("Add a requirement or request the next change…"),
    ).toBeTruthy();
  });

  it("scopes model selection to the conversation and waits for authoritative state", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.modelPicker = {
      conversationId: "conversation-1",
      status: "ready",
      currentModelId: "mode-smart",
      options: [
        modelOption("smart", "mode-smart", "", true),
        modelOption("fast", "mode-fast", ""),
        modelOption("medium", "mode-medium", ""),
        modelOption("high", "mode-high", ""),
        modelOption("very-high", "mode-very-high", ""),
        modelOption("pro", "mode-pro", ""),
      ],
    };
    sendHostMessage({ type: "state", state });

    fireEvent.click(await screen.findByRole("button", { name: "Choose model" }));
    expect(posted).not.toContainEqual({ type: "listModels" });
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(6);

    fireEvent.click(await screen.findByRole("menuitemradio", { name: "High" }));
    expect(posted).toContainEqual({
      type: "selectModel",
      conversationId: "conversation-1",
      modelId: "mode-high",
    });
    expect(screen.getByRole("button", { name: "Choose model" }).textContent).toContain("Smart");

    const accepted = structuredClone(state);
    accepted.modelPicker.currentModelId = "mode-high";
    accepted.modelPicker.options = accepted.modelPicker.options.map((option) => ({
      ...option,
      selected: option.id === "mode-high",
    }));
    sendHostMessage({ type: "state", state: accepted });
    expect(screen.getByRole("button", { name: "Choose model" }).textContent).toContain("High");
  });

  it("never exposes background catalog synchronization as a picker wait state", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.modelPicker = {
      conversationId: "conversation-1",
      status: "selecting",
      currentModelId: "mode-high",
      syncing: true,
      options: [
        modelOption("smart", "mode-smart", "GPT-5.5"),
        modelOption("high", "mode-high", "GPT-5.6 Sol", true),
      ],
    };
    sendHostMessage({ type: "state", state });

    const trigger = await screen.findByRole("button", { name: "Choose model" });
    expect(trigger.getAttribute("aria-busy")).toBeNull();
    expect(trigger.textContent).toContain("5.6 Sol");
    fireEvent.click(trigger);
    expect(await screen.findByRole("menuitemradio", { name: "High" })).toBeTruthy();
    expect(screen.queryByText("Applying to the next message")).toBeNull();
  });

  it("uses a compact mode menu with a keyboard-accessible model-family submenu", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.modelPicker = {
      conversationId: "conversation-1",
      status: "ready",
      currentModelId: "mode-high",
      options: [
        modelOption("smart", "mode-smart", "GPT-5.5"),
        { ...modelOption("fast", "mode-fast", "GPT-5.5"), secondaryLabel: "5.5" },
        modelOption("low", "mode-low", "GPT-5.6 Sol"),
        modelOption("medium", "mode-medium", "GPT-5.6 Sol"),
        modelOption("high", "mode-high", "GPT-5.6 Sol", true),
        modelOption("very-high", "mode-very-high", "GPT-5.6 Sol"),
        modelOption("pro", "mode-pro", "GPT-5.6 Sol Pro"),
      ],
    };
    sendHostMessage({ type: "state", state });

    fireEvent.click(await screen.findByRole("button", { name: "Choose model" }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(7);
    expect(screen.getByRole("group", { name: "Reasoning" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Light" })).toBeTruthy();
    expect(screen.queryByText(/Terra|Luna/)).toBeNull();
    const familyEntry = screen.getByRole("menuitem", { name: "GPT-5.6 Sol" });
    expect(familyEntry.getAttribute("aria-controls")).toBeTruthy();
    expect(familyEntry.getAttribute("aria-expanded")).toBe("false");
    expect(familyEntry.tabIndex).toBe(-1);
    familyEntry.focus();
    fireEvent.keyDown(familyEntry, { key: "ArrowRight" });
    expect(await screen.findByRole("menuitemradio", { name: "GPT-5.5" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "GPT-5.6 Sol Pro" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowLeft" });
    const high = await screen.findByRole("menuitemradio", { name: "High" });
    fireEvent.keyDown(high, { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("hides all connection facilities when direct connection is ready", async () => {
    render(<App />);
    sendHostMessage({ type: "state", state: makeState() });

    expect(await screen.findByRole("textbox")).toBeTruthy();
    expect(screen.queryByText("可以提问")).toBeNull();
    expect(screen.queryByText("技术详情")).toBeNull();
    expect(screen.queryByText(/连接码|验证码|Project 绑定/)).toBeNull();
  });

  it("shows a delayed lightweight reconnecting line without a manual action", async () => {
    vi.useFakeTimers();
    render(<App />);
    const state = makeState();
    state.backend.connected = false;
    state.backend.authenticated = false;
    state.backend.connection = {
      phase: "reconnecting",
      since: new Date().toISOString(),
      browserDetected: true,
      hasStoredTrust: true,
      lastConnectedAt: new Date().toISOString(),
    };
    sendHostMessage({ type: "state", state });

    expect(screen.queryByText("正在恢复连接")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(799));
    expect(screen.queryByText("正在恢复连接")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText("正在恢复连接")).toBeTruthy();
    expect(screen.getByText(/正在自动重连/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "立即重试" })).toBeNull();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false);
  });

  it.each(["reconnecting", "syncing"] as const)(
    "keeps the composer visually stable during short %s without bypassing send gating",
    async (phase) => {
      vi.useFakeTimers();
      render(<App />);
      const state = makeState();
      state.locale = "en";
      sendHostMessage({ type: "state", state });

      const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(composer, { target: { value: "Draft survives the relay handoff" } });
      composer.focus();
      const readyPlaceholder = composer.placeholder;

      const recovering = structuredClone(state);
      recovering.backend.connected = false;
      recovering.backend.authenticated = false;
      recovering.backend.connection = {
        ...recovering.backend.connection,
        phase,
        since: new Date().toISOString(),
      };
      sendHostMessage({ type: "state", state: recovering });

      expect(screen.getByRole("textbox")).toBe(composer);
      expect(composer.value).toBe("Draft survives the relay handoff");
      expect(composer.placeholder).toBe(readyPlaceholder);
      expect(document.activeElement).toBe(composer);
      const pausedSend = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
      expect(pausedSend.disabled).toBe(true);
      expect(pausedSend.classList.contains("send-button--connection-grace")).toBe(true);

      fireEvent.keyDown(composer, { key: "Enter" });
      expect(posted.filter((message) => message.type === "send")).toHaveLength(0);
      expect(composer.value).toBe("Draft survives the relay handoff");

      sendHostMessage({ type: "state", state });
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(screen.queryByText("Restoring the connection")).toBeNull();
      expect(screen.getByRole("textbox")).toBe(composer);
      expect(composer.value).toBe("Draft survives the relay handoff");
      expect(document.activeElement).toBe(composer);
      const readySend = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
      expect(readySend.disabled).toBe(false);
      expect(readySend.classList.contains("send-button--connection-grace")).toBe(false);
    },
  );

  it("never exposes verification codes and gives one direct reconnect action", async () => {
    render(<App />);
    const state = makeState();
    state.backend.connected = false;
    state.backend.authenticated = false;
    state.backend.connection = {
      phase: "pairing-required",
      since: new Date().toISOString(),
      browserDetected: true,
      hasStoredTrust: false,
    };
    sendHostMessage({ type: "state", state });

    expect(await screen.findByText("需要重新连接")).toBeTruthy();
    expect(screen.getByText(/重新加载 Ask2GPT Relay.*草稿和对话不会丢失/)).toBeTruthy();
    expect(screen.queryByText("ABCDEFGH")).toBeNull();
    expect(screen.queryByText("首次连接 Chrome")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    expect(posted).toContainEqual({ type: "retryConnection" });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("optimistically clears a send, restores a rejected draft, and ignores IME Enter", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    sendHostMessage({ type: "state", state });

    const composer = await screen.findByRole("textbox");
    fireEvent.change(composer, { target: { value: "Explain the event loop" } });
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });
    expect(posted.filter((message) => message.type === "send")).toHaveLength(0);

    fireEvent.keyDown(composer, { key: "Enter" });
    const send = posted.filter((message) => message.type === "send").at(-1);
    expect(send).toMatchObject({
      conversationId: "conversation-1",
      requestId: "request-00000000-0000-4000-8000-000000000001",
      text: "Explain the event loop",
      type: "send",
    });
    expect((composer as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByLabelText("Your question").textContent).toContain("Explain the event loop");
    expect(screen.queryByText("Submitting…")).toBeNull();

    fireEvent.keyDown(composer, { key: "Enter" });
    expect(posted.filter((message) => message.type === "send")).toHaveLength(1);

    sendHostMessage({
      type: "sendResult",
      accepted: false,
      conversationId: "conversation-1",
      requestId: "request-00000000-0000-4000-8000-000000000001",
    });
    expect((composer as HTMLTextAreaElement).value).toBe("Explain the event loop");
    expect(screen.queryByLabelText("Your question")).toBeNull();

    fireEvent.keyDown(composer, { key: "Enter" });
    expect((composer as HTMLTextAreaElement).value).toBe("");
    sendHostMessage({
      type: "sendResult",
      accepted: true,
      conversationId: "conversation-1",
      requestId: "request-00000000-0000-4000-8000-000000000001",
    });
    expect((composer as HTMLTextAreaElement).value).toBe("");
  });

  it("restores the exact attachment stack only for the matching rejected request", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.pendingContexts = [
      makeContext({ id: "selection-a", kind: "selection", fileName: "alpha.ts" }),
      makeContext({ id: "file-b", kind: "file", fileName: "beta.ts" }),
    ];
    state.automaticContextIds = ["selection-a"];
    sendHostMessage({ type: "state", state });

    const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Review both files" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(composer.value).toBe("");
    expect(screen.queryByRole("region", { name: "Attached code context" })).toBeNull();
    expect(screen.getByLabelText("Your question").textContent).toContain("Review both files");
    expect(
      screen.getByRole("group", { name: "Code context sent with this question" }),
    ).toBeTruthy();
    expect(posted.filter((message) => message.type === "send")).toHaveLength(1);

    sendHostMessage({
      type: "sendResult",
      accepted: false,
      conversationId: "conversation-1",
      requestId: "stale-request",
    });
    expect(composer.value).toBe("");
    expect(screen.queryByRole("region", { name: "Attached code context" })).toBeNull();
    expect(posted.filter((message) => message.type === "send")).toHaveLength(1);

    sendHostMessage({
      type: "sendResult",
      accepted: false,
      conversationId: "conversation-1",
      requestId: "request-00000000-0000-4000-8000-000000000001",
    });
    expect(composer.value).toBe("Review both files");
    expect(screen.getByRole("region", { name: "Attached code context" })).toBeTruthy();
    expect(screen.getByText("alpha.ts")).toBeTruthy();
    expect(screen.queryByText("beta.ts")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review code context: +1" }));
    expect(screen.getByText("beta.ts")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Review code context" }), {
      key: "Escape",
    });
    expect(screen.queryByLabelText("Your question")).toBeNull();
    expect(posted.filter((message) => message.type === "send")).toHaveLength(1);

    const contextRemoved = structuredClone(state);
    contextRemoved.pendingContexts = [state.pendingContexts[1]!];
    contextRemoved.automaticContextIds = [];
    sendHostMessage({ type: "state", state: contextRemoved });
    expect(screen.queryByText("alpha.ts")).toBeNull();
    expect(screen.getByText("beta.ts")).toBeTruthy();
  });

  it("recovers an accepted send from authoritative state when sendResult is lost", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    sendHostMessage({ type: "state", state });

    const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Explain this loop" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(composer.value).toBe("");
    expect(composer.disabled).toBe(false);
    expect(composer.readOnly).toBe(true);
    expect(screen.getAllByLabelText("Your question")).toHaveLength(1);
    expect(posted.filter((message) => message.type === "send")).toHaveLength(1);

    const accepted = structuredClone(state);
    accepted.contextLocked = true;
    accepted.conversations[0]!.messages.push(
      {
        id: "accepted-question",
        role: "user",
        markdown: "Explain this loop",
        status: "complete",
        createdAt: new Date().toISOString(),
      },
      {
        id: "accepted-answer",
        role: "assistant",
        markdown: "",
        status: "streaming",
        createdAt: new Date().toISOString(),
      },
    );
    accepted.conversations[0]!.run = {
      id: "accepted-run",
      messageId: "accepted-answer",
      status: "starting",
      startedAt: new Date().toISOString(),
    };
    sendHostMessage({ type: "state", state: accepted });
    expect(composer.value).toBe("");
    expect(composer.disabled).toBe(false);
    expect(composer.readOnly).toBe(true);
    expect(screen.getAllByLabelText("Your question")).toHaveLength(1);

    const dispatched = structuredClone(accepted);
    dispatched.contextLocked = false;
    sendHostMessage({ type: "state", state: dispatched });
    expect(composer.value).toBe("");
    expect(composer.disabled).toBe(false);
    expect(composer.readOnly).toBe(false);
    expect(posted.filter((message) => message.type === "send")).toHaveLength(1);
  });

  it("restores a rejected send from rolled-back state when sendResult is lost", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    sendHostMessage({ type: "state", state });

    const composer = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Keep this draft" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    const dispatching = structuredClone(state);
    dispatching.contextLocked = true;
    sendHostMessage({ type: "state", state: dispatching });
    expect(composer.disabled).toBe(false);
    expect(composer.readOnly).toBe(true);

    const rejected = structuredClone(state);
    rejected.contextLocked = false;
    sendHostMessage({ type: "state", state: rejected });
    expect(composer.value).toBe("Keep this draft");
    expect(composer.disabled).toBe(false);
    expect(composer.readOnly).toBe(false);
    expect(posted.filter((message) => message.type === "send")).toHaveLength(1);
  });

  it("keeps pending drafts isolated when a background conversation rolls back", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations.push({
      id: "conversation-2",
      title: "Second conversation",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    });
    sendHostMessage({ type: "state", state });

    const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Question for A" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    const queuedA = structuredClone(state);
    queuedA.contextLocked = true;
    queuedA.dispatchingConversationIds = ["conversation-1"];
    queuedA.conversations[0]!.messages.push(
      {
        id: "question-a",
        role: "user",
        markdown: "Question for A",
        status: "complete",
        createdAt: new Date().toISOString(),
      },
      {
        id: "answer-a",
        role: "assistant",
        markdown: "",
        status: "streaming",
        createdAt: new Date().toISOString(),
      },
    );
    queuedA.conversations[0]!.run = {
      id: "run-a",
      messageId: "answer-a",
      status: "starting",
      startedAt: new Date().toISOString(),
    };
    sendHostMessage({ type: "state", state: queuedA });
    expect(composer.value).toBe("");
    expect(composer.readOnly).toBe(true);

    const switchedToB = structuredClone(queuedA);
    switchedToB.activeConversationId = "conversation-2";
    switchedToB.contextLocked = false;
    switchedToB.modelPicker.conversationId = "conversation-2";
    sendHostMessage({ type: "state", state: switchedToB });
    expect(composer.value).toBe("");
    expect(composer.readOnly).toBe(false);
    fireEvent.change(composer, { target: { value: "Independent draft for B" } });

    const rejectedA = structuredClone(switchedToB);
    rejectedA.dispatchingConversationIds = [];
    rejectedA.conversations[0]!.messages = [];
    rejectedA.conversations[0]!.run = undefined;
    sendHostMessage({ type: "state", state: rejectedA });
    expect(composer.value).toBe("Independent draft for B");

    const switchedBackToA = structuredClone(rejectedA);
    switchedBackToA.activeConversationId = "conversation-1";
    switchedBackToA.modelPicker.conversationId = "conversation-1";
    sendHostMessage({ type: "state", state: switchedBackToA });
    expect(composer.value).toBe("Question for A");
    expect(composer.readOnly).toBe(false);

    const sendMessages = posted.filter((message) => message.type === "send");
    expect(sendMessages).toHaveLength(1);
    expect(sendMessages[0]).toMatchObject({ conversationId: "conversation-1" });
  });

  it("unlocks after a missing sendResult without clearing or resending the draft", async () => {
    vi.useFakeTimers();
    render(<App />);
    const state = makeState();
    state.locale = "en";
    sendHostMessage({ type: "state", state });

    const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Do not resend me" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await act(async () => vi.advanceTimersByTimeAsync(14_999));
    expect(composer.disabled).toBe(false);
    expect(composer.readOnly).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(composer.value).toBe("Do not resend me");
    expect(composer.disabled).toBe(false);
    expect(composer.readOnly).toBe(false);
    expect(posted.filter((message) => message.type === "send")).toHaveLength(1);
  });

  it("allows drafting after host acceptance while guarding the request until authoritative state", async () => {
    vi.useFakeTimers();
    let requestCount = 0;
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockImplementation(
        () =>
          (requestCount++ === 0
            ? "request-00000000-0000-4000-8000-000000000001"
            : "request-00000000-0000-4000-8000-000000000002") as ReturnType<Crypto["randomUUID"]>,
      );
    render(<App />);
    const state = makeState();
    state.locale = "en";
    sendHostMessage({ type: "state", state });

    const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Repeat this question" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    sendHostMessage({
      type: "sendResult",
      accepted: true,
      conversationId: "conversation-1",
      requestId: "request-00000000-0000-4000-8000-000000000001",
    });

    expect(composer.readOnly).toBe(false);
    fireEvent.change(composer, { target: { value: "Follow-up draft" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(posted.filter((message) => message.type === "send")).toHaveLength(1);

    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(composer.readOnly).toBe(false);

    const firstAccepted = structuredClone(state);
    firstAccepted.conversations[0]!.messages.push({
      id: "first-authoritative-question",
      role: "user",
      markdown: "Repeat this question",
      status: "complete",
      createdAt: new Date().toISOString(),
    });
    sendHostMessage({ type: "state", state: firstAccepted });
    expect(composer.value).toBe("Follow-up draft");
    expect(composer.readOnly).toBe(false);

    fireEvent.keyDown(composer, { key: "Enter" });
    expect(posted.filter((message) => message.type === "send")).toHaveLength(2);
    expect(posted.filter((message) => message.type === "send").at(-1)).toMatchObject({
      requestId: "request-00000000-0000-4000-8000-000000000002",
    });

    // A delayed replay of the first accepted state cannot settle the new
    // request because its baseline already contains the first user message.
    sendHostMessage({ type: "state", state: firstAccepted });
    expect(composer.readOnly).toBe(true);
    sendHostMessage({
      type: "sendResult",
      accepted: false,
      conversationId: "conversation-1",
      requestId: "request-00000000-0000-4000-8000-000000000002",
    });
    expect(composer.value).toBe("Follow-up draft");
    expect(composer.readOnly).toBe(false);
    expect(posted.filter((message) => message.type === "send")).toHaveLength(2);
    randomUuid.mockRestore();
  });

  it("moves focus into the history dialog and closes it with Escape", async () => {
    render(<App />);
    sendHostMessage({ type: "state", state: makeState() });

    const historyTrigger = await screen.findByTitle("最近聊天");
    fireEvent.click(historyTrigger);
    const dialog = screen.getByRole("dialog", { name: "最近聊天" });
    expect(document.activeElement).toBe(dialog);
    expect(screen.getAllByRole("button", { name: "新聊天" })).toHaveLength(1);

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "最近聊天" })).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(historyTrigger));
  });

  it("shows only substantive chats and keeps relay metadata out of history", async () => {
    render(<App />);
    const state = makeState();
    const syncedChat = {
      id: "synced-chat",
      title: "解释 LangChain",
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
      messages: [
        {
          id: "synced-question",
          role: "user" as const,
          markdown: "解释这段代码",
          status: "complete" as const,
          createdAt: "2026-07-25T00:00:00.000Z",
        },
      ],
    };
    Object.assign(syncedChat, {
      remoteUrl: "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc",
      syncStatus: "synced",
      titleSource: "chatgpt",
    });
    state.conversations.push(syncedChat);
    state.conversations.push({
      id: "legacy-notice-only",
      title: "旧版本地提示",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
      messages: [
        {
          id: "legacy-notice",
          role: "local-notice",
          markdown: "旧版本地提示",
          status: "complete",
          createdAt: "2026-07-24T00:00:00.000Z",
        },
      ],
    });
    sendHostMessage({ type: "state", state });

    fireEvent.click(await screen.findByTitle("最近聊天"));
    const dialog = screen.getByRole("dialog", { name: "最近聊天" });
    const list = within(dialog).getByRole("list", { name: "聊天" });
    expect(within(list).getByText("解释 LangChain")).toBeTruthy();
    expect(within(list).queryByText(state.conversations[0]!.title)).toBeNull();
    expect(within(list).queryByText("旧版本地提示")).toBeNull();
    expect(screen.queryByText("已同步")).toBeNull();
    expect(screen.queryByText("ChatGPT 标题")).toBeNull();
    expect(screen.queryByText(/本地重命名或删除不影响网站会话/)).toBeNull();
    expect(screen.queryByRole("button", { name: "重命名" })).toBeNull();
    expect(screen.queryByRole("button", { name: "复制脱敏诊断信息" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "聊天操作: 解释 LangChain" }));
    expect(screen.getByRole("menu", { name: "聊天操作: 解释 LangChain" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    const nameInput = screen.getByRole("textbox", { name: "会话名称" });
    fireEvent.change(nameInput, { target: { value: "解释 LCEL" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(posted).toContainEqual({
      type: "renameConversation",
      conversationId: "synced-chat",
      title: "解释 LCEL",
    });

    fireEvent.click(screen.getByRole("button", { name: "聊天操作: 解释 LangChain" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(
      screen.getByRole("alertdialog", { name: "永久删除这条聊天？: 解释 LangChain" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(posted).not.toContainEqual({
      type: "deleteConversation",
      conversationId: "synced-chat",
    });

    fireEvent.click(screen.getByRole("menuitem", { name: "归档聊天" }));
    expect(posted).toContainEqual({
      type: "archiveConversation",
      conversationId: "synced-chat",
    });
    expect(screen.queryByText("聊天已归档")).toBeNull();

    const archivedState = structuredClone(state);
    Object.assign(
      archivedState.conversations.find((conversation) => conversation.id === "synced-chat")!,
      { archivedAt: "2026-07-31T00:00:00.000Z" },
    );
    sendHostMessage({ type: "state", state: archivedState });
    expect(await screen.findByText("聊天已归档")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(posted).toContainEqual({
      type: "unarchiveConversation",
      activate: false,
      conversationId: "synced-chat",
    });
    expect(screen.getByText("聊天已归档")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "最近聊天" })).toBeTruthy();

    const restoredState = structuredClone(archivedState);
    delete restoredState.conversations.find((conversation) => conversation.id === "synced-chat")!
      .archivedAt;
    sendHostMessage({ type: "state", state: restoredState });
    expect(screen.queryByText("聊天已归档")).toBeNull();

    const queuedState = structuredClone(restoredState);
    queuedState.conversations.find(
      (conversation) => conversation.id === "synced-chat",
    )!.queuedFollowUps = [
      {
        id: "queued-before-archive",
        text: "继续验证",
        contexts: [],
        automaticContextIds: [],
        createdAt: "2026-07-31T00:01:00.000Z",
      },
    ];
    sendHostMessage({ type: "state", state: queuedState });
    fireEvent.click(screen.getByRole("button", { name: "聊天操作: 解释 LangChain" }));
    expect((screen.getByRole("menuitem", { name: "归档聊天" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    sendHostMessage({ type: "state", state: archivedState });
    fireEvent.click(screen.getByRole("tab", { name: "已归档 (1)" }));
    expect(within(list).getByText("解释 LangChain")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "聊天操作: 解释 LangChain" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "恢复聊天" }));
    expect(posted.filter((message) => message.type === "unarchiveConversation")).toHaveLength(2);
    expect(posted.at(-1)).toEqual({
      type: "unarchiveConversation",
      activate: false,
      conversationId: "synced-chat",
    });
    expect(screen.getByRole("dialog", { name: "最近聊天" })).toBeTruthy();
    sendHostMessage({ type: "state", state: restoredState });
    expect(within(list).queryByText("解释 LangChain")).toBeNull();

    sendHostMessage({ type: "state", state: archivedState });
    fireEvent.click(within(list).getByTitle("恢复聊天"));
    expect(posted.at(-1)).toEqual({
      type: "unarchiveConversation",
      activate: true,
      conversationId: "synced-chat",
    });
    expect(screen.getByRole("dialog", { name: "最近聊天" })).toBeTruthy();
    const activatedState = structuredClone(restoredState);
    activatedState.activeConversationId = "synced-chat";
    sendHostMessage({ type: "state", state: activatedState });
    expect(screen.queryByRole("dialog", { name: "最近聊天" })).toBeNull();
  });

  it("keeps destructive chat actions behind one contextual history button", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations.push({
      id: "history-delete-target",
      title: "Disposable chat",
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
      messages: [
        {
          id: "history-delete-question",
          role: "user",
          markdown: "Temporary question",
          status: "complete",
          createdAt: "2026-07-31T00:00:00.000Z",
        },
      ],
    });
    sendHostMessage({ type: "state", state });

    fireEvent.click(await screen.findByTitle("Recent chats"));
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Chat actions: Disposable chat" }));
    const menu = screen.getByRole("menu", { name: "Chat actions: Disposable chat" });
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(3);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));

    const confirmation = screen.getByRole("alertdialog", {
      name: "Permanently delete this chat?: Disposable chat",
    });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete" }));
    expect(posted).toContainEqual({
      type: "deleteConversation",
      conversationId: "history-delete-target",
    });
  });

  it("opens the context menu with native keyboard navigation and restores the trigger", async () => {
    render(<App />);
    sendHostMessage({ type: "state", state: makeState() });

    const trigger = await screen.findByRole("button", { name: "上下文" });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "选择上下文" });
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(3);
    expect(screen.getByRole("menuitem", { name: /当前选区|Current selection/u })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /当前文件/u })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /选择文件/u })).toBeTruthy();
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "选择上下文" })).toBeNull();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: /当前选区|Current selection/u }));
    expect(posted).toContainEqual({
      type: "attachSelection",
      conversationId: "conversation-1",
    });

    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "选择上下文" })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "选择上下文" })).toBeNull();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("offers eight selection task shortcuts that only edit the current draft", async () => {
    render(<App />);
    const state = makeState();
    const selection = makeContext({
      id: "task-selection",
      kind: "selection",
      fileName: "auth.ts",
      content: "export function authorize() { return true; }",
    });
    state.pendingContexts = [
      makeContext({ id: "task-file", kind: "current-file", fileName: "policy.ts" }),
      selection,
    ];
    sendHostMessage({ type: "state", state });

    const actions = await screen.findByRole("region", { name: "代码任务快捷动作" });
    const expected = [
      ["explain", "解释这段代码", "解释这段代码的用途、执行流程和关键设计。"],
      ["find-issues", "查找问题", "查找这段代码中的错误、边界情况和潜在问题。"],
      ["fix-error", "修复报错", "分析并修复这段代码中的报错，说明根因和修改。"],
      ["review", "代码审查", "审查这段代码，按严重程度指出问题并给出改进建议。"],
      ["refactor", "重构", "重构这段代码以提高可读性和可维护性，并保持现有行为。"],
      ["comments", "添加注释", "为这段代码添加必要且简洁的注释，避免解释显而易见的内容。"],
      ["tests", "编写单元测试", "为这段代码编写覆盖正常路径、边界情况和失败路径的单元测试。"],
      [
        "performance-security",
        "分析性能或安全问题",
        "分析这段代码的性能和安全风险，并给出可执行的改进方案。",
      ],
    ] as const;
    const buttons = within(actions).getAllByRole("button");
    expect(buttons).toHaveLength(expected.length);
    expected.forEach(([id, label, prompt], index) => {
      expect(buttons[index]?.dataset.codeTask).toBe(id);
      expect(buttons[index]?.textContent).toContain(label);
      expect(buttons[index]?.title).toBe(prompt);
      expect(buttons[index]?.getAttribute("type")).toBe("button");
    });

    const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
    posted.length = 0;
    fireEvent.click(within(actions).getByRole("button", { name: /解释这段代码/u }));
    await vi.waitFor(() => {
      expect(composer.value).toBe(expected[0][2]);
      expect(document.activeElement).toBe(composer);
      expect(composer.selectionStart).toBe(composer.value.length);
      expect(composer.selectionEnd).toBe(composer.value.length);
    });
    expect(composer.value).not.toContain(selection.content);
    expect(within(actions).getByRole("status").textContent).toContain("已填入草稿");

    fireEvent.change(composer, { target: { value: "保留原稿尾部空格  " } });
    fireEvent.click(within(actions).getByRole("button", { name: /代码审查/u }));
    expect(composer.value).toBe(`保留原稿尾部空格  \n\n${expected[3][2]}`);
    fireEvent.click(within(actions).getByRole("button", { name: /代码审查/u }));
    expect(composer.value).toBe(`保留原稿尾部空格  \n\n${expected[3][2]}`);
    expect(within(actions).getByRole("status").textContent).toContain("已在草稿末尾");
    fireEvent.click(within(actions).getByRole("button", { name: /^重构/u }));
    expect(composer.value).toBe(`保留原稿尾部空格  \n\n${expected[3][2]}\n\n${expected[4][2]}`);

    expect(
      posted.filter(
        (message) =>
          message.type === "send" ||
          message.type === "enqueueFollowUp" ||
          message.type === "interruptWithFollowUp",
      ),
    ).toHaveLength(0);
  });

  it("shows selection shortcuts only for pending selection context and preserves their draft", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.pendingContexts = [
      makeContext({ id: "only-file", kind: "current-file", fileName: "whole-file.ts" }),
    ];
    state.conversations[0]!.messages.push({
      id: "historical-selection",
      role: "user",
      markdown: "Earlier question",
      status: "complete",
      createdAt: new Date().toISOString(),
      contexts: [makeContext({ id: "sent-selection", kind: "selection" })],
    });
    sendHostMessage({ type: "state", state });

    const composer = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    expect(screen.queryByRole("region", { name: "Code task shortcuts" })).toBeNull();

    const withSelection = structuredClone(state);
    withSelection.pendingContexts.push(
      makeContext({ id: "pending-selection", kind: "selection", fileName: "selected.ts" }),
    );
    sendHostMessage({ type: "state", state: withSelection });
    const actions = await screen.findByRole("region", { name: "Code task shortcuts" });
    expect(within(actions).getAllByRole("button")).toHaveLength(8);
    fireEvent.click(within(actions).getByRole("button", { name: /Review the code/u }));
    expect(composer.value).toBe(
      "Review this code, report issues by severity, and suggest concrete improvements.",
    );

    const withoutSelection = structuredClone(withSelection);
    withoutSelection.pendingContexts = withoutSelection.pendingContexts.filter(
      (context) => context.kind !== "selection",
    );
    sendHostMessage({ type: "state", state: withoutSelection });
    expect(screen.queryByRole("region", { name: "Code task shortcuts" })).toBeNull();
    expect(composer.value).toBe(
      "Review this code, report issues by severity, and suggest concrete improvements.",
    );
  });

  it("keeps selection task drafts isolated by conversation", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.pendingContexts = [makeContext({ id: "selection-a", kind: "selection" })];
    state.conversations.push({
      id: "conversation-2",
      title: "Second conversation",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    });
    sendHostMessage({ type: "state", state });

    const composer = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole("button", { name: /Review the code/u }));
    const draftA =
      "Review this code, report issues by severity, and suggest concrete improvements.";
    expect(composer.value).toBe(draftA);

    const selectedB = structuredClone(state);
    selectedB.activeConversationId = "conversation-2";
    selectedB.modelPicker.conversationId = "conversation-2";
    selectedB.pendingContexts = [makeContext({ id: "selection-b", kind: "selection" })];
    sendHostMessage({ type: "state", state: selectedB });
    expect(composer.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /Explain this code/u }));
    const draftB = "Explain this code's purpose, execution flow, and key design decisions.";
    expect(composer.value).toBe(draftB);

    const selectedA = structuredClone(state);
    sendHostMessage({ type: "state", state: selectedA });
    expect(composer.value).toBe(draftA);
    expect(
      posted.some(
        (message) =>
          message.type === "send" ||
          message.type === "enqueueFollowUp" ||
          message.type === "interruptWithFollowUp",
      ),
    ).toBe(false);
  });

  it("keeps a full composer draft unchanged when a selection task would exceed the limit", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.pendingContexts = [makeContext({ id: "limit-selection", kind: "selection" })];
    sendHostMessage({ type: "state", state });

    const composer = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    expect(composer.maxLength).toBe(20_000);
    const fullDraft = "x".repeat(20_000);
    fireEvent.change(composer, { target: { value: fullDraft } });
    posted.length = 0;
    const actions = screen.getByRole("region", { name: "Code task shortcuts" });
    fireEvent.click(within(actions).getByRole("button", { name: /Performance or security/u }));

    expect(composer.value).toBe(fullDraft);
    expect(within(actions).getByRole("status").textContent).toContain("20,000-character limit");
    expect(posted.filter((message) => message.type === "prepareConversation")).toHaveLength(0);
  });

  it("sends only the chosen task prompt while selection content stays packaged", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    const selection = makeContext({
      id: "send-selection",
      kind: "selection",
      fileName: "secret.ts",
      content: "const secretImplementation = 42;",
    });
    state.pendingContexts = [selection];
    sendHostMessage({ type: "state", state });

    const composer = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole("button", { name: /Fix the error/u }));
    const prompt =
      "Diagnose and fix the error in this code, explaining the root cause and changes.";
    expect(composer.value).toBe(prompt);
    expect(composer.value).not.toContain(selection.content);
    posted.length = 0;
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(posted.filter((message) => message.type === "send")).toEqual([
      {
        type: "send",
        conversationId: "conversation-1",
        requestId: "request-00000000-0000-4000-8000-000000000001",
        text: prompt,
      },
    ]);
  });

  it("dismisses every composer overlay before honoring a host focus request", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.pendingContexts = [
      makeContext({
        id: "context-selection",
        kind: "selection",
        fileName: "auth.ts",
        content: "export function authorize() { return true; }",
      }),
      makeContext({
        id: "context-file",
        kind: "current-file",
        fileName: "policy.ts",
        content: "export const policy = new Map();",
      }),
    ];
    sendHostMessage({ type: "state", state });

    const composer = await screen.findByRole("textbox", { name: "Ask Ask2GPT" });
    const focusComposer = async () => {
      sendHostMessage({ type: "focusComposer" });
      await vi.waitFor(() => expect(document.activeElement).toBe(composer));
    };

    fireEvent.click(screen.getByTitle("Recent chats"));
    expect(screen.getByRole("dialog", { name: "Recent chats" })).toBeTruthy();
    await focusComposer();
    expect(screen.queryByRole("dialog", { name: "Recent chats" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Context" }));
    expect(screen.getByRole("menu", { name: "Choose context" })).toBeTruthy();
    await focusComposer();
    expect(screen.queryByRole("menu", { name: "Choose context" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Review code context: +1" }));
    expect(screen.getByRole("dialog", { name: "Review code context" })).toBeTruthy();
    await focusComposer();
    expect(screen.queryByRole("dialog", { name: "Review code context" })).toBeNull();
  });

  it("shows a removable explicit multi-file context stack with totals and expandable previews", async () => {
    render(<App />);
    const state = makeState();
    state.pendingContexts = [
      makeContext({
        id: "context-selection",
        kind: "selection",
        fileName: "auth.ts",
        content: "export function authorize() { return true; }",
        charCount: 1_200,
      }),
      makeContext({
        id: "context-file",
        kind: "current-file",
        fileName: "policy.ts",
        content: "export const policy = new Map();",
        charCount: 800,
      }),
    ];
    sendHostMessage({ type: "state", state });

    expect(await screen.findByRole("region", { name: "已附加的代码上下文" })).toBeTruthy();
    expect(screen.getAllByText(/auth\.ts/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/policy\.ts/)).toBeNull();
    expect(screen.getByRole("button", { name: "审阅代码上下文: +1" })).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByText(/export function authorize/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "在编辑器中打开: auth.ts, L1–4" }));
    expect(posted).toContainEqual({
      type: "openContext",
      contextId: "context-selection",
      conversationId: "conversation-1",
    });
    fireEvent.click(screen.getByRole("button", { name: "审阅代码上下文: +1" }));
    expect(screen.getByRole("dialog", { name: "审阅代码上下文" })).toBeTruthy();
    expect(screen.getByText("policy.ts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "预览上下文: auth.ts" }));
    expect(screen.getByText("export function authorize() { return true; }")).toBeTruthy();
    const review = screen.getByRole("dialog");
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(review);
    fireEvent.keyDown(review, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "移除上下文: auth.ts" })[0]!);
    expect(posted).toContainEqual({
      type: "removeContext",
      contextId: "context-selection",
      conversationId: "conversation-1",
    });
  });

  it("removes a sent selection card and never revives it during reconnect", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    const selection = makeContext({
      id: "selected-code",
      kind: "selection",
      fileName: "selected.ts",
      content: "const selected = true;",
      charCount: 22,
    });
    state.pendingContexts = [selection];
    sendHostMessage({ type: "state", state });

    const composer = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    expect(composer.value).toBe("");
    expect(screen.getByRole("region", { name: "Attached code context" })).toBeTruthy();
    expect(screen.getByText("selected.ts")).toBeTruthy();
    expect(screen.queryByText(/const selected = true;/u)).toBeNull();

    fireEvent.change(composer, { target: { value: "Explain this selection" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    sendHostMessage({
      type: "sendResult",
      accepted: true,
      conversationId: "conversation-1",
      requestId: "request-00000000-0000-4000-8000-000000000001",
    });

    const accepted = structuredClone(state);
    accepted.pendingContexts = [];
    accepted.automaticContextIds = [];
    accepted.conversations[0]!.messages.push({
      id: "sent-question",
      role: "user",
      markdown: "Explain this selection",
      status: "complete",
      createdAt: new Date().toISOString(),
      contexts: [selection],
    });
    sendHostMessage({ type: "state", state: accepted });
    expect(composer.value).toBe("");
    expect(screen.queryByRole("region", { name: "Attached code context" })).toBeNull();

    const reconnecting = structuredClone(accepted);
    reconnecting.backend.connected = false;
    reconnecting.backend.authenticated = false;
    reconnecting.backend.connection = {
      phase: "reconnecting",
      since: new Date().toISOString(),
      browserDetected: true,
      hasStoredTrust: true,
    };
    sendHostMessage({ type: "state", state: reconnecting });
    sendHostMessage({ type: "state", state: accepted });
    expect(screen.queryByRole("region", { name: "Attached code context" })).toBeNull();
  });

  it("keeps the context entry available after attachments and offers an explicit file picker", async () => {
    render(<App />);
    const state = makeState();
    state.pendingContexts = [makeContext({ id: "context-file" })];
    sendHostMessage({ type: "state", state });

    fireEvent.click(await screen.findByRole("button", { name: "上下文" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /选择文件/ }));

    expect(posted).toContainEqual({ type: "attachFiles", conversationId: "conversation-1" });
  });

  it("queues Enter follow-ups while generation is active and keeps Stop for an empty draft", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.run = {
      id: "run-1",
      messageId: "assistant-streaming",
      status: "streaming",
      startedAt: new Date().toISOString(),
    };
    sendHostMessage({ type: "state", state });

    const composer = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    expect(composer.disabled).toBe(false);
    expect(composer.placeholder).toBe("Press Enter to queue the next message…");
    expect(document.querySelector(".run-status-line")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop generating" })).toBeTruthy();
    fireEvent.change(composer, { target: { value: "Next queued change" } });
    expect(screen.queryByRole("button", { name: "Stop generating" })).toBeNull();
    expect(screen.getByRole("button", { name: "Queue" })).toBeTruthy();
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(composer.value).toBe("");
    expect(posted.filter((message) => message.type === "send")).toHaveLength(0);
    const queuedMessage = posted.find((message) => message.type === "enqueueFollowUp");
    expect(queuedMessage).toMatchObject({
      type: "enqueueFollowUp",
      conversationId: "conversation-1",
      targetRunId: "run-1",
      text: "Next queued change",
    });

    const accepted = structuredClone(state);
    accepted.conversations[0]!.queuedFollowUps = [
      {
        id: (queuedMessage as { requestId: string }).requestId,
        text: "Next queued change",
        contexts: [],
        automaticContextIds: [],
        createdAt: new Date().toISOString(),
      },
    ];
    sendHostMessage({ type: "state", state: accepted });
    sendHostMessage({
      type: "sendResult",
      accepted: true,
      conversationId: "conversation-1",
      requestId: (queuedMessage as { requestId: string }).requestId,
    });
    expect(screen.getByText("Next queued change")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Queued" })).toBeTruthy();
  });

  it("uses one state-aware button for stop-then-send follow-ups", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.composerPreferences = {
      followUpQueueMode: "interrupt",
      composerEnterBehavior: "enter",
    };
    state.conversations[0]!.run = {
      id: "run-interrupt",
      messageId: "assistant-interrupt",
      status: "streaming",
      startedAt: new Date().toISOString(),
    };
    sendHostMessage({ type: "state", state });

    const composer = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    expect(screen.getByRole("button", { name: "Stop generating" })).toBeTruthy();
    fireEvent.change(composer, { target: { value: "Use the corrected constraint" } });
    const action = screen.getByRole("button", { name: "Stop and send" });
    expect(action.getAttribute("data-follow-up-action")).toBe("interrupt");
    expect(action.getAttribute("title")).toMatch(/Stop the current answer/);
    expect(screen.queryByRole("button", { name: "Queue" })).toBeNull();
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(posted).toContainEqual({
      type: "interruptWithFollowUp",
      conversationId: "conversation-1",
      requestId: "request-00000000-0000-4000-8000-000000000001",
      targetRunId: "run-interrupt",
      text: "Use the corrected constraint",
    });
  });

  it("keeps the configured follow-up action on Mod+Enter in enter mode", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.composerPreferences = {
      followUpQueueMode: "queue",
      composerEnterBehavior: "enter",
    };
    state.conversations[0]!.run = {
      id: "run-opposite",
      messageId: "assistant-opposite",
      status: "streaming",
      startedAt: new Date().toISOString(),
    };
    sendHostMessage({ type: "state", state });

    const composer = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Apply this now" } });
    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });

    expect(posted).toContainEqual(
      expect.objectContaining({
        type: "enqueueFollowUp",
        targetRunId: "run-opposite",
        text: "Apply this now",
      }),
    );
    expect(posted.filter((message) => message.type === "interruptWithFollowUp")).toHaveLength(0);
  });

  it("honors cmdAlways, Alt+Enter, and multiline-safe keyboard behavior", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.composerPreferences = {
      followUpQueueMode: "queue",
      composerEnterBehavior: "cmdAlways",
    };
    sendHostMessage({ type: "state", state });

    const composer = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "First line\nSecond line" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(composer, { key: "Enter", altKey: true });
    expect(posted.filter((message) => message.type === "send")).toHaveLength(0);

    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: "send",
        text: "First line\nSecond line",
      }),
    );
  });

  it("requires Mod+Enter only after cmdIfMultiline becomes multiline", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.composerPreferences = {
      followUpQueueMode: "queue",
      composerEnterBehavior: "cmdIfMultiline",
    };
    sendHostMessage({ type: "state", state });

    const composer = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "First line\nSecond line" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(posted.filter((message) => message.type === "send")).toHaveLength(0);

    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: "send",
        text: "First line\nSecond line",
      }),
    );
  });

  it("uses Mod+Shift+Enter for the one-shot follow-up inverse outside enter mode", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.composerPreferences = {
      followUpQueueMode: "queue",
      composerEnterBehavior: "cmdIfMultiline",
    };
    state.conversations[0]!.run = {
      id: "run-shift-opposite",
      messageId: "assistant-shift-opposite",
      status: "streaming",
      startedAt: new Date().toISOString(),
    };
    sendHostMessage({ type: "state", state });

    const composer = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Change direction now" } });
    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true, shiftKey: true });

    expect(posted).toContainEqual(
      expect.objectContaining({
        type: "interruptWithFollowUp",
        targetRunId: "run-shift-opposite",
        text: "Change direction now",
      }),
    );
  });

  it("binds the visible Stop action to the rendered run", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.run = {
      id: "run-visible-stop",
      messageId: "assistant-visible-stop",
      status: "streaming",
      startedAt: new Date().toISOString(),
    };
    sendHostMessage({ type: "state", state });

    fireEvent.click(await screen.findByRole("button", { name: "Stop generating" }));
    expect(posted).toContainEqual({
      type: "stop",
      conversationId: "conversation-1",
      targetRunId: "run-visible-stop",
    });
  });

  it("forces a stopping run into the queue even when interrupt is configured", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.composerPreferences = {
      followUpQueueMode: "interrupt",
      composerEnterBehavior: "enter",
    };
    state.conversations[0]!.run = {
      id: "run-already-stopping",
      messageId: "assistant-already-stopping",
      status: "stopping",
      startedAt: new Date().toISOString(),
    };
    sendHostMessage({ type: "state", state });

    const composer = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Keep this for later" } });
    expect(screen.getByRole("button", { name: "Queue" })).toBeTruthy();
    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });

    expect(posted).toContainEqual(
      expect.objectContaining({
        type: "enqueueFollowUp",
        targetRunId: "run-already-stopping",
        text: "Keep this for later",
      }),
    );
    expect(posted.filter((message) => message.type === "interruptWithFollowUp")).toHaveLength(0);
  });

  it("settles a queued draft from authoritative state when sendResult is lost", async () => {
    vi.useFakeTimers();
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.run = {
      id: "run-lost-receipt",
      messageId: "assistant-lost-receipt",
      status: "streaming",
      startedAt: new Date().toISOString(),
    };
    sendHostMessage({ type: "state", state });

    const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Persist me once" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    const request = posted.find((message) => message.type === "enqueueFollowUp");
    expect(request?.type).toBe("enqueueFollowUp");

    const accepted = structuredClone(state);
    accepted.conversations[0]!.queuedFollowUps = [
      {
        id: (request as { requestId: string }).requestId,
        text: "Persist me once",
        contexts: [],
        automaticContextIds: [],
        createdAt: new Date().toISOString(),
      },
    ];
    sendHostMessage({ type: "state", state: accepted });
    await act(async () => vi.advanceTimersByTime(15_001));

    expect(composer.value).toBe("");
    fireEvent.change(composer, { target: { value: "A distinct next message" } });
    expect(composer.value).toBe("A distinct next message");
  });

  it("edits, removes, and resumes only the active conversation queue", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.queuePaused = true;
    state.conversations[0]!.queuedFollowUps = [
      {
        id: "queued-edit-1",
        text: "Original queued text",
        contexts: [],
        automaticContextIds: [],
        createdAt: new Date().toISOString(),
      },
    ];
    sendHostMessage({ type: "state", state });

    expect(await screen.findByText(/previous turn stopped or failed/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit queued message" }));
    const editor = screen.getByRole("textbox", { name: "Edit queued message" });
    fireEvent.change(editor, { target: { value: "Edited queued text" } });
    fireEvent.keyDown(editor, { key: "Enter", isComposing: true });
    fireEvent.keyDown(editor, { key: "Enter", keyCode: 229 });
    expect(posted.filter((message) => message.type === "updateQueuedFollowUp")).toHaveLength(0);
    expect((editor as HTMLTextAreaElement).value).toBe("Edited queued text");
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(posted).toContainEqual({
      type: "updateQueuedFollowUp",
      conversationId: "conversation-1",
      queueId: "queued-edit-1",
      text: "Edited queued text",
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove queued message" }));
    expect(posted).toContainEqual({
      type: "removeQueuedFollowUp",
      conversationId: "conversation-1",
      queueId: "queued-edit-1",
    });
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(posted).toContainEqual({ type: "resumeQueue", conversationId: "conversation-1" });
  });

  it("makes a stopping turn's Stop button disabled and idempotent", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.run = {
      id: "run-stopping",
      messageId: "assistant-stopping",
      status: "stopping",
      startedAt: new Date().toISOString(),
    };
    sendHostMessage({ type: "state", state });

    const stop = (await screen.findByRole("button", {
      name: "Stop generating",
    })) as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    expect(screen.getByText("Stopping…")).toBeTruthy();
    fireEvent.click(stop);
    fireEvent.click(stop);
    expect(posted.filter((message) => message.type === "stop")).toHaveLength(0);
  });

  it("keeps the exceptional background-generation status visible", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.run = {
      id: "run-background",
      messageId: "assistant-background",
      status: "streaming",
      startedAt: new Date().toISOString(),
      softTimeoutNotified: true,
    };
    sendHostMessage({ type: "state", state });

    expect(
      await screen.findByText(
        "The answer is still generating in the background; keep working here",
      ),
    ).toBeTruthy();
    expect(document.querySelector(".run-status-line--warning")).toBeTruthy();
  });

  it("applies compact streaming updates without replacing historical context bundles", async () => {
    render(<App />);
    const state = makeState();
    state.conversations[0]!.messages.push(
      {
        id: "user-context",
        role: "user",
        markdown: "解释代码",
        status: "complete",
        createdAt: new Date().toISOString(),
        contexts: [makeContext({ id: "stable-context", fileName: "stable.ts" })],
      },
      {
        id: "assistant-stream",
        role: "assistant",
        markdown: "partial stable.ts:1",
        status: "streaming",
        createdAt: new Date().toISOString(),
      },
    );
    state.sourceTraceHints = {
      "conversation-1": {
        "assistant-stream": {
          fileReferences: ["stable.ts:1"],
          sourceSymbols: [],
        },
      },
    };
    state.conversations[0]!.run = {
      id: "run-stream",
      messageId: "assistant-stream",
      status: "streaming",
      startedAt: new Date().toISOString(),
    };
    sendHostMessage({ type: "state", state });

    const contextButton = await screen.findByRole("button", {
      name: "预览上下文: stable.ts",
    });
    expect(document.querySelector(".source-reference")).toBeNull();
    sendHostMessage({
      type: "generationUpdate",
      update: {
        conversationId: "conversation-1",
        messageId: "assistant-stream",
        runId: "run-stream",
        markdown: "compact snapshot stable.ts:1",
        updatedAt: "2026-07-25T00:00:01.000Z",
      },
    });

    expect(await screen.findByText(/compact snapshot stable\.ts:1/u)).toBeTruthy();
    expect(document.querySelector(".source-reference")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "预览上下文: stable.ts",
      }),
    ).toBe(contextButton);
  });

  it("only exposes terminal source hints and ignores a late compact streaming frame", async () => {
    render(<App />);
    const streaming = makeState();
    streaming.locale = "en";
    streaming.conversations[0]!.messages.push(
      {
        id: "user-source-race",
        role: "user",
        markdown: "Locate this code",
        status: "complete",
        createdAt: "2026-07-25T00:00:00.000Z",
        contexts: [
          makeContext({
            id: "source-race-context",
            fileName: "race.ts",
            startLine: 1,
            endLine: 12,
          }),
        ],
      },
      {
        id: "assistant-source-race",
        role: "assistant",
        markdown: "Partial answer at race.ts:4",
        status: "streaming",
        createdAt: "2026-07-25T00:00:01.000Z",
      },
    );
    streaming.sourceTraceHints = {
      "conversation-1": {
        "assistant-source-race": {
          fileReferences: ["race.ts:4"],
          sourceSymbols: [],
        },
      },
    };
    streaming.conversations[0]!.run = {
      id: "run-source-race",
      messageId: "assistant-source-race",
      status: "streaming",
      startedAt: "2026-07-25T00:00:01.000Z",
    };
    sendHostMessage({ type: "state", state: streaming });

    expect(await screen.findByText(/Partial answer at race\.ts:4/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open race.ts:4 in the editor" })).toBeNull();

    const terminal = structuredClone(streaming);
    terminal.conversations[0]!.run = undefined;
    terminal.conversations[0]!.messages[1]!.markdown = "Complete answer at race.ts:4";
    terminal.conversations[0]!.messages[1]!.status = "complete";
    sendHostMessage({ type: "state", state: terminal });

    const sourceAction = await screen.findByRole("button", {
      name: "Open race.ts:4 in the editor",
    });
    expect(screen.getByText(/Complete answer at/u)).toBeTruthy();

    sendHostMessage({
      type: "generationUpdate",
      update: {
        conversationId: "conversation-1",
        messageId: "assistant-source-race",
        runId: "run-source-race",
        markdown: "Late compact answer at race.ts:4",
        updatedAt: "2026-07-25T00:00:03.000Z",
      },
    });

    expect(screen.queryByText(/Late compact answer/u)).toBeNull();
    expect(screen.getByRole("button", { name: "Open race.ts:4 in the editor" })).toBe(sourceAction);
  });

  it("buffers hidden streaming updates, restores the newest one, and never revives it after terminal state", async () => {
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
    let visibilityState: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });

    try {
      render(<App />);
      const state = makeState();
      state.locale = "en";
      state.conversations[0]!.messages.push({
        id: "assistant-hidden",
        role: "assistant",
        markdown: "visible baseline",
        status: "streaming",
        createdAt: "2026-07-25T00:00:00.000Z",
      });
      state.conversations[0]!.run = {
        id: "run-hidden",
        messageId: "assistant-hidden",
        status: "streaming",
        startedAt: "2026-07-25T00:00:00.000Z",
      };
      sendHostMessage({ type: "state", state });
      expect(await screen.findByText("visible baseline")).toBeTruthy();

      visibilityState = "hidden";
      fireEvent(document, new Event("visibilitychange"));
      sendHostMessage({
        type: "generationUpdate",
        update: {
          conversationId: "conversation-1",
          messageId: "assistant-hidden",
          runId: "run-hidden",
          markdown: "newest hidden snapshot",
          updatedAt: "2026-07-25T00:00:01.000Z",
        },
      });
      expect(screen.queryByText("newest hidden snapshot")).toBeNull();
      expect(screen.getByText("visible baseline")).toBeTruthy();

      sendHostMessage({
        type: "state",
        state: {
          ...state,
          activeConversationId: "missing-conversation",
          conversations: [],
        },
      });
      visibilityState = "visible";
      fireEvent(document, new Event("visibilitychange"));
      expect(await screen.findByText("newest hidden snapshot")).toBeTruthy();

      visibilityState = "hidden";
      fireEvent(document, new Event("visibilitychange"));
      sendHostMessage({
        type: "generationUpdate",
        update: {
          conversationId: "conversation-1",
          messageId: "assistant-hidden",
          runId: "run-hidden",
          markdown: "stale hidden snapshot",
          updatedAt: "2026-07-25T00:00:02.000Z",
        },
      });
      const terminal = structuredClone(state);
      terminal.conversations[0]!.run = undefined;
      terminal.conversations[0]!.messages[0]!.markdown = "authoritative complete answer";
      terminal.conversations[0]!.messages[0]!.status = "complete";
      sendHostMessage({ type: "state", state: terminal });

      visibilityState = "visible";
      fireEvent(document, new Event("visibilitychange"));
      expect(await screen.findByText("authoritative complete answer")).toBeTruthy();
      expect(screen.queryByText("stale hidden snapshot")).toBeNull();
    } finally {
      if (visibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", visibilityDescriptor);
      } else {
        Reflect.deleteProperty(document, "visibilityState");
      }
    }
  });

  it("keeps common-length streams structurally rendered without moving a detached reader", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.messages.push(
      {
        id: "user-long-stream",
        role: "user",
        markdown: "Explain the long output",
        status: "complete",
        createdAt: "2026-07-25T00:00:00.000Z",
      },
      {
        id: "assistant-long-stream",
        role: "assistant",
        markdown: "Starting",
        status: "streaming",
        createdAt: "2026-07-25T00:00:01.000Z",
      },
    );
    state.conversations[0]!.run = {
      id: "run-long-stream",
      messageId: "assistant-long-stream",
      status: "streaming",
      startedAt: "2026-07-25T00:00:01.000Z",
    };
    sendHostMessage({ type: "state", state });

    const transcript = await screen.findByRole("main", { name: "Q&A transcript" });
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 2_400 },
      scrollTop: { configurable: true, value: 320, writable: true },
    });
    fireEvent.wheel(transcript, { deltaY: -120 });
    fireEvent.scroll(transcript);

    const commonLengthMarkdown = `## Streaming heading\n\n${"A streamed line.\n".repeat(220)}`;
    expect(commonLengthMarkdown.length).toBeGreaterThan(1_000);
    expect(commonLengthMarkdown.length).toBeLessThan(8_000);
    sendHostMessage({
      type: "generationUpdate",
      update: {
        conversationId: "conversation-1",
        messageId: "assistant-long-stream",
        runId: "run-long-stream",
        markdown: commonLengthMarkdown,
        updatedAt: "2026-07-25T00:00:02.000Z",
      },
    });

    expect(await screen.findByRole("heading", { name: "Streaming heading" })).toBeTruthy();
    const markdownTree = document.querySelector(".streaming-markdown");
    const streamingHeading = screen.getByRole("heading", { name: "Streaming heading" });
    expect(markdownTree?.getAttribute("data-streaming")).toBe("true");
    expect(transcript.scrollTop).toBe(320);

    const terminal = structuredClone(state);
    terminal.conversations[0]!.run = undefined;
    terminal.conversations[0]!.messages[1]!.markdown = commonLengthMarkdown;
    terminal.conversations[0]!.messages[1]!.status = "complete";
    sendHostMessage({ type: "state", state: terminal });

    const terminalHeading = await screen.findByRole("heading", { name: "Streaming heading" });
    expect(terminalHeading).toBe(streamingHeading);
    expect(document.querySelector(".streaming-markdown")).toBe(markdownTree);
    expect(markdownTree?.getAttribute("data-streaming")).toBe("false");
    expect(transcript.scrollTop).toBe(320);
  });

  it("preserves loose-list and reference-link semantics across stream completion", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    const markdown =
      "- First paragraph\n\n  Continued item\n\n- [Second][docs]\n\n[docs]: https://example.com/docs";
    state.conversations[0]!.messages.push({
      id: "assistant-semantic-stream",
      role: "assistant",
      markdown,
      status: "streaming",
      createdAt: new Date().toISOString(),
    });
    state.conversations[0]!.run = {
      id: "run-semantic-stream",
      messageId: "assistant-semantic-stream",
      status: "streaming",
      startedAt: new Date().toISOString(),
    };
    sendHostMessage({ type: "state", state });

    const link = await screen.findByRole("link", { name: "Second" });
    const list = link.closest("ul");
    expect(list?.querySelectorAll(":scope > li")).toHaveLength(2);
    expect(list?.textContent).toContain("Continued item");
    const markdownTree = document.querySelector(".streaming-markdown");

    const complete = structuredClone(state);
    complete.conversations[0]!.run = undefined;
    complete.conversations[0]!.messages[0]!.status = "complete";
    sendHostMessage({ type: "state", state: complete });

    expect(await screen.findByRole("link", { name: "Second" })).toBe(link);
    expect(document.querySelector(".streaming-markdown")).toBe(markdownTree);
    expect(markdownTree?.getAttribute("data-streaming")).toBe("false");
  });

  it("keeps completed heading sections stable while a structured tail streams", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.messages.push({
      id: "assistant-section-stream",
      role: "assistant",
      markdown: "## Stable section\n\n- First\n- Second\n\n## Growing section\n\nInitial tail",
      status: "streaming",
      createdAt: new Date().toISOString(),
    });
    state.conversations[0]!.run = {
      id: "run-section-stream",
      messageId: "assistant-section-stream",
      status: "streaming",
      startedAt: new Date().toISOString(),
    };
    sendHostMessage({ type: "state", state });

    const stableHeading = await screen.findByRole("heading", { name: "Stable section" });
    const stableBlock = stableHeading.closest(".streaming-markdown__block");
    expect(stableBlock).toBeTruthy();
    expect(document.querySelectorAll(".streaming-markdown__block").length).toBeGreaterThan(1);

    sendHostMessage({
      type: "generationUpdate",
      update: {
        conversationId: state.conversations[0]!.id,
        messageId: "assistant-section-stream",
        markdown:
          "## Stable section\n\n- First\n- Second\n\n## Growing section\n\nInitial tail with more output",
        runId: "run-section-stream",
        updatedAt: new Date().toISOString(),
      },
    });

    expect(await screen.findByText("Initial tail with more output")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Stable section" })).toBe(stableHeading);
    expect(stableHeading.closest(".streaming-markdown__block")).toBe(stableBlock);
  });

  it("keeps completed top-level blocks stable across long single-section appends", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    const stableParagraphs = Array.from(
      { length: 180 },
      (_, index) => `Paragraph ${index + 1}: ${"stable detail ".repeat(10)}`,
    ).join("\n\n");
    const markdown =
      `## Single section\n\n${stableParagraphs}\n\n` +
      "- First item\n\n  Continued first item\n\n- Second item\n\n" +
      "> First quote line\n>\n> Second quote line\n\n" +
      "```ts\nconst stable = true;\n```\n\n" +
      "Growing tail";
    expect(markdown.length).toBeGreaterThan(20_000);
    state.conversations[0]!.messages.push({
      id: "assistant-long-single-section",
      role: "assistant",
      markdown,
      status: "streaming",
      createdAt: new Date().toISOString(),
    });
    state.conversations[0]!.run = {
      id: "run-long-single-section",
      messageId: "assistant-long-single-section",
      status: "streaming",
      startedAt: new Date().toISOString(),
    };
    sendHostMessage({ type: "state", state });

    const firstParagraph = await screen.findByText(/^Paragraph 1:/u);
    const list = screen.getByText("Second item").closest("ul");
    const quote = screen.getByText("Second quote line").closest("blockquote");
    const code = screen.getByText(/const stable = true/u).closest("code");
    const firstParagraphBlock = firstParagraph.closest(".streaming-markdown__block");
    const listBlock = list?.closest(".streaming-markdown__block");
    const quoteBlock = quote?.closest(".streaming-markdown__block");
    const codeBlock = code?.closest(".streaming-markdown__block");

    expect(list?.querySelectorAll(":scope > li")).toHaveLength(2);
    expect(list?.textContent).toContain("Continued first item");
    expect(quote?.textContent).toContain("First quote line");
    expect(code?.textContent).toContain("const stable = true;");
    expect(firstParagraphBlock).toBeTruthy();
    expect(listBlock).toBeTruthy();
    expect(quoteBlock).toBeTruthy();
    expect(codeBlock).toBeTruthy();

    sendHostMessage({
      type: "generationUpdate",
      update: {
        conversationId: state.conversations[0]!.id,
        messageId: "assistant-long-single-section",
        markdown: `${markdown} with more output`,
        runId: "run-long-single-section",
        updatedAt: new Date().toISOString(),
      },
    });

    expect(await screen.findByText("Growing tail with more output")).toBeTruthy();
    expect(screen.getByText(/^Paragraph 1:/u)).toBe(firstParagraph);
    expect(screen.getByText("Second item").closest("ul")).toBe(list);
    expect(screen.getByText("Second quote line").closest("blockquote")).toBe(quote);
    expect(screen.getByText(/const stable = true/u).closest("code")).toBe(code);
    expect(firstParagraph.closest(".streaming-markdown__block")).toBe(firstParagraphBlock);
    expect(list?.closest(".streaming-markdown__block")).toBe(listBlock);
    expect(quote?.closest(".streaming-markdown__block")).toBe(quoteBlock);
    expect(code?.closest(".streaming-markdown__block")).toBe(codeBlock);
  });

  it("defers syntax highlighting until the terminal state", async () => {
    render(<App />);
    const state = makeState();
    state.conversations[0]!.messages.push({
      id: "assistant-code-stream",
      role: "assistant",
      markdown: "```ts\nconst answer = 42;\n```",
      status: "streaming",
      createdAt: new Date().toISOString(),
    });
    state.conversations[0]!.run = {
      id: "run-code-stream",
      messageId: "assistant-code-stream",
      status: "streaming",
      startedAt: new Date().toISOString(),
    };
    sendHostMessage({ type: "state", state });

    expect(await screen.findByText(/const answer = 42/)).toBeTruthy();
    expect(document.querySelector(".streaming-markdown")).toBeTruthy();
    expect(document.querySelector("code")).toBeTruthy();
    expect(document.querySelector("code")?.classList.contains("hljs")).toBe(false);

    const complete = structuredClone(state);
    complete.conversations[0]!.run = undefined;
    complete.conversations[0]!.messages[0]!.status = "complete";
    sendHostMessage({ type: "state", state: complete });

    await vi.waitFor(() =>
      expect(document.querySelector("code")?.classList.contains("hljs")).toBe(true),
    );
  });

  it("renders a language toolbar, block copy action and multi-token syntax highlighting", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    const source = [
      "function answer(label: string) {",
      '  const status = "ready";',
      "  return `${label}: ${status} ${42}`;",
      "}",
    ].join("\n");
    state.conversations[0]!.messages.push({
      id: "assistant-colored-code",
      role: "assistant",
      markdown: `\`\`\`ts\n${source}\n\`\`\``,
      status: "complete",
      createdAt: new Date().toISOString(),
    });
    sendHostMessage({ type: "state", state });

    expect(await screen.findByText("TypeScript")).toBeTruthy();
    const block = document.querySelector(".markdown-code-block");
    expect(block).toBeTruthy();
    expect(block?.querySelector("pre code.hljs.language-ts")?.textContent?.trim()).toBe(source);
    expect(block?.querySelector(".hljs-keyword")).toBeTruthy();
    expect(block?.querySelector(".hljs-title")).toBeTruthy();
    expect(block?.querySelector(".hljs-string")).toBeTruthy();
    expect(block?.querySelector(".hljs-number")).toBeTruthy();

    posted.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(posted).toContainEqual({ type: "copy", text: source });
  });

  it("keeps user and assistant turns in transcript order", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.messages.push(
      {
        id: "ordered-user-1",
        role: "user",
        markdown: "First question",
        status: "complete",
        createdAt: "2026-07-25T00:00:00.000Z",
      },
      {
        id: "ordered-assistant-1",
        role: "assistant",
        markdown: "First answer",
        status: "complete",
        createdAt: "2026-07-25T00:00:01.000Z",
      },
      {
        id: "ordered-user-2",
        role: "user",
        markdown: "Second question",
        status: "complete",
        createdAt: "2026-07-25T00:00:02.000Z",
      },
      {
        id: "ordered-assistant-2",
        role: "assistant",
        markdown: "Second answer",
        status: "streaming",
        createdAt: "2026-07-25T00:00:03.000Z",
      },
    );
    sendHostMessage({ type: "state", state });

    const articles = [...document.querySelectorAll<HTMLElement>(".message-list > article")];
    expect(articles.map((article) => article.getAttribute("aria-label"))).toEqual([
      "Your question",
      "Answer",
      "Your question",
      "Answer",
    ]);
    expect(articles.map((article) => article.textContent)).toEqual([
      expect.stringContaining("First question"),
      expect.stringContaining("First answer"),
      expect.stringContaining("Second question"),
      expect.stringContaining("Second answer"),
    ]);
    expect(document.querySelectorAll(".stream-cursor")).toHaveLength(1);

    const streaming = structuredClone(state);
    streaming.conversations[0]!.messages[3]!.markdown = "Second answer, extended";
    sendHostMessage({ type: "state", state: streaming });
    const updatedArticles = [...document.querySelectorAll<HTMLElement>(".message-list > article")];
    expect(updatedArticles).toHaveLength(4);
    for (const [index, article] of updatedArticles.entries()) expect(article).toBe(articles[index]);
    expect(await screen.findByText("Second answer, extended")).toBeTruthy();
  });

  it("shows one quiet streaming indicator at a time", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.messages.push({
      id: "assistant-thinking",
      role: "assistant",
      markdown: "",
      status: "streaming",
      createdAt: "2026-07-25T00:00:00.000Z",
    });
    sendHostMessage({ type: "state", state });

    expect(document.querySelectorAll(".thinking-line")).toHaveLength(1);
    expect(document.querySelector(".stream-cursor")).toBeNull();

    const receiving = structuredClone(state);
    receiving.conversations[0]!.messages[0]!.markdown = "Receiving";
    sendHostMessage({ type: "state", state: receiving });
    expect(await screen.findByText("Receiving")).toBeTruthy();
    expect(document.querySelector(".thinking-line")).toBeNull();
    expect(document.querySelectorAll(".stream-cursor")).toHaveLength(1);
  });

  it("keeps structured run errors outside answer Markdown and copies only answer text", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.messages.push({
      id: "assistant-structured-error",
      role: "assistant",
      markdown: "Partial answer",
      status: "error",
      createdAt: new Date().toISOString(),
      runError: {
        code: "CHATGPT_REMOTE_UNAVAILABLE",
        message: "The background tab did not expose response actions.",
        recoverable: true,
      },
    });
    sendHostMessage({ type: "state", state });

    const status = await screen.findByText("Answer interrupted");
    const markdown = document.querySelector(".assistant-markdown");
    expect(markdown?.textContent).toBe("Partial answer");
    expect(markdown?.textContent).not.toContain("CHATGPT_REMOTE_UNAVAILABLE");
    expect(markdown?.textContent).not.toContain("background tab");
    const alert = status.closest('[role="alert"]');
    const details = within(alert as HTMLElement)
      .getByText("Technical details")
      .closest("details");
    expect(details?.open).toBe(false);
    expect(alert?.querySelector(".message-error-row__copy > span")).toBeNull();
    expect(within(details as HTMLElement).getByText("CHATGPT_REMOTE_UNAVAILABLE")).toBeTruthy();
    expect(
      within(details as HTMLElement).getByText(
        "The background tab did not expose response actions.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(details as HTMLElement).getByText("Technical details"));
    expect(details?.open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(posted).toContainEqual({ type: "copy", text: "Partial answer" });
    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    expect(posted).toContainEqual({
      type: "regenerate",
      conversationId: "conversation-1",
      messageId: "assistant-structured-error",
    });

    const changedError = structuredClone(state);
    changedError.conversations[0]!.messages[0]!.runError = {
      code: "CHATGPT_REMOTE_UNAVAILABLE",
      message: "This failure is not recoverable.",
      recoverable: false,
    };
    sendHostMessage({ type: "state", state: changedError });
    expect(await screen.findByText("Generation failed")).toBeTruthy();
    expect(screen.queryByText("Answer interrupted")).toBeNull();

    const emptyError = structuredClone(state);
    emptyError.conversations[0]!.messages[0]!.markdown = "";
    sendHostMessage({ type: "state", state: emptyError });
    await screen.findByText("No answer received");
    expect(document.querySelector(".thinking-line")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();

    const defensiveComplete = structuredClone(emptyError);
    defensiveComplete.conversations[0]!.messages[0]!.markdown = "Recovered answer";
    defensiveComplete.conversations[0]!.messages[0]!.status = "complete";
    sendHostMessage({ type: "state", state: defensiveComplete });
    expect(await screen.findByText("Recovered answer")).toBeTruthy();
    expect(screen.queryByText("Generation failed")).toBeNull();
    expect(screen.queryByText("Answer interrupted")).toBeNull();
    expect(screen.queryByText("No answer received")).toBeNull();
  });

  it("renders sent code context as compact expandable chips", async () => {
    render(<App />);
    const state = makeState();
    state.conversations[0]!.messages.push({
      id: "user-with-contexts",
      role: "user",
      markdown: "比较这两个实现",
      status: "complete",
      createdAt: new Date().toISOString(),
      contextTransportVersion: 2,
      contexts: [
        makeContext({ id: "context-a", fileName: "first.ts", charCount: 300 }),
        makeContext({ id: "context-b", fileName: "second.ts", charCount: 450 }),
        makeContext({ id: "context-c", fileName: "third.ts", charCount: 600 }),
      ],
    });
    sendHostMessage({ type: "state", state });

    expect(await screen.findByRole("group", { name: "随问题发送的代码上下文" })).toBeTruthy();
    expect(screen.getByText("first.ts")).toBeTruthy();
    expect(screen.getByText("second.ts")).toBeTruthy();
    expect(screen.queryByText("third.ts")).toBeNull();
    expect(screen.queryByText(/1,350 字符/)).toBeNull();
    expect(screen.queryByText("封装为代码上下文")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "预览上下文: first.ts" }));
    expect(screen.getByText(/封装为代码上下文/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "显示更多代码上下文" }));
    expect(screen.getByText("third.ts")).toBeTruthy();
    expect(screen.getByRole("button", { name: "收起代码上下文" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "在编辑器中打开: first.ts, L1–4" }));
    expect(posted).toContainEqual({
      type: "openContext",
      contextId: "context-a",
      conversationId: "conversation-1",
    });
    const userTurn = screen.getByRole("article", { name: "你的问题" });
    fireEvent.click(within(userTurn).getByRole("button", { name: "复制" }));
    expect(posted).toContainEqual({ type: "copy", text: "比较这两个实现" });
  });

  it("keeps the sent context line range visible without expanding its preview", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.messages.push({
      id: "question-with-source-range",
      role: "user",
      markdown: "Explain this range",
      status: "complete",
      createdAt: new Date().toISOString(),
      contexts: [
        makeContext({
          id: "source-range",
          fileName: "06_vector_store.py",
          startLine: 34,
          endLine: 39,
        }),
      ],
    });
    sendHostMessage({ type: "state", state });

    const contexts = await screen.findByRole("group", {
      name: "Code context sent with this question",
    });
    expect(
      within(contexts).getByText("L34\u201339", { selector: ".sent-context__line-range" }),
    ).toBeTruthy();
    expect(contexts.querySelector(".sent-context__details")).toBeNull();
  });

  it("anchors a newly appended user turn at the start of the transcript viewport", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.messages.push(
      {
        id: "user-old",
        role: "user",
        markdown: "Earlier question",
        status: "complete",
        createdAt: "2026-07-25T00:00:00.000Z",
      },
      {
        id: "assistant-old",
        role: "assistant",
        markdown: "Earlier answer",
        status: "complete",
        createdAt: "2026-07-25T00:00:01.000Z",
      },
    );
    sendHostMessage({ type: "state", state });
    await screen.findByText("Earlier answer");

    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
    scrollIntoView.mockClear();
    const next = structuredClone(state);
    next.conversations[0]!.messages.push(
      {
        id: "user-new",
        role: "user",
        markdown: "Newest question",
        status: "complete",
        createdAt: "2026-07-25T00:00:02.000Z",
      },
      {
        id: "assistant-new",
        role: "assistant",
        markdown: "",
        status: "streaming",
        createdAt: "2026-07-25T00:00:03.000Z",
      },
    );
    next.conversations[0]!.run = {
      id: "run-new",
      messageId: "assistant-new",
      status: "starting",
      startedAt: "2026-07-25T00:00:03.000Z",
    };
    sendHostMessage({ type: "state", state: next });

    const questions = await screen.findAllByLabelText("Your question");
    const latestQuestion = questions.at(-1) as HTMLElement;
    expect(latestQuestion.dataset.turnAnchor).toBe("true");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "start",
      inline: "nearest",
    });
  });

  it("preserves a detached reading position when a queued turn is promoted", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.messages.push(
      {
        id: "user-reading",
        role: "user",
        markdown: "Earlier question",
        status: "complete",
        createdAt: "2026-07-25T00:00:00.000Z",
      },
      {
        id: "assistant-reading",
        role: "assistant",
        markdown: "Earlier answer",
        status: "complete",
        createdAt: "2026-07-25T00:00:01.000Z",
      },
    );
    sendHostMessage({ type: "state", state });

    const transcript = screen.getByRole("main", { name: "Q&A transcript" });
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_200 },
      scrollTop: { configurable: true, value: 180, writable: true },
    });
    fireEvent.wheel(transcript, { deltaY: -120 });
    fireEvent.scroll(transcript);
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeTruthy();

    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
    scrollIntoView.mockClear();
    const promoted = structuredClone(state);
    promoted.conversations[0]!.messages.push(
      {
        id: "user-promoted",
        clientRequestId: "queued-request-1",
        role: "user",
        markdown: "Queued follow-up",
        status: "complete",
        createdAt: "2026-07-25T00:00:02.000Z",
      },
      {
        id: "assistant-promoted",
        role: "assistant",
        markdown: "",
        status: "streaming",
        createdAt: "2026-07-25T00:00:03.000Z",
      },
    );
    promoted.conversations[0]!.run = {
      id: "run-promoted",
      messageId: "assistant-promoted",
      status: "starting",
      startedAt: "2026-07-25T00:00:03.000Z",
    };
    sendHostMessage({ type: "state", state: promoted });

    expect(screen.getByText("Queued follow-up")).toBeTruthy();
    expect(transcript.scrollTop).toBe(180);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeTruthy();
  });

  it("shows the Codex-style question rail after four user turns and jumps by prompt", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    for (let index = 1; index <= 3; index += 1) {
      state.conversations[0]!.messages.push({
        id: `question-${index}`,
        role: "user",
        markdown: `Question ${index}`,
        status: "complete",
        createdAt: `2026-07-25T00:00:0${index}.000Z`,
      });
    }
    sendHostMessage({ type: "state", state });
    expect(screen.queryByRole("navigation", { name: "User messages" })).toBeNull();

    const fourthTurn = structuredClone(state);
    fourthTurn.conversations[0]!.messages.push({
      id: "question-4",
      role: "user",
      markdown: "Question 4 with a useful preview",
      status: "complete",
      createdAt: "2026-07-25T00:00:04.000Z",
    });
    sendHostMessage({ type: "state", state: fourthTurn });

    const rail = screen.getByRole("navigation", { name: "User messages" });
    const markers = within(rail).getAllByRole("button");
    expect(markers).toHaveLength(4);
    expect(markers[3]?.getAttribute("title")).toBe("Question 4 with a useful preview");

    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
    scrollIntoView.mockClear();
    fireEvent.click(markers[1]!);
    expect(markers[1]?.getAttribute("aria-current")).toBe("true");
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
      inline: "nearest",
    });
  });

  it("reveals the exact context in a host-selected turn until the user clears it", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.messages.push(
      {
        id: "question-before-trace",
        role: "user",
        markdown: "Earlier question",
        status: "complete",
        createdAt: "2026-07-25T00:00:01.000Z",
      },
      {
        id: "answer-before-trace",
        role: "assistant",
        markdown: "Earlier answer",
        status: "complete",
        createdAt: "2026-07-25T00:00:02.000Z",
      },
      {
        id: "question-trace-target",
        role: "user",
        markdown: "Question that used this selection",
        status: "complete",
        createdAt: "2026-07-25T00:00:03.000Z",
        contexts: [
          makeContext({ id: "trace-context-1", fileName: "first.ts" }),
          makeContext({ id: "trace-context-2", fileName: "second.ts" }),
          makeContext({ id: "trace-context-3", fileName: "matched.ts" }),
        ],
      },
      {
        id: "answer-trace-target",
        role: "assistant",
        markdown: "Target answer",
        status: "complete",
        createdAt: "2026-07-25T00:00:04.000Z",
      },
    );
    sendHostMessage({ type: "state", state });

    const target = screen
      .getAllByRole("article", { name: "Your question" })
      .find((article) => article.textContent?.includes("Question that used this selection"))!;
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
    scrollIntoView.mockClear();

    sendHostMessage({
      type: "revealTurn",
      conversationId: "conversation-1",
      messageId: "question-trace-target",
      contextId: "trace-context-3",
    });

    const label = within(target).getByRole("status");
    expect(label.textContent).toContain("Matched selection");
    expect(label.getAttribute("role")).toBe("status");
    expect(within(label).queryByRole("button")).toBeNull();
    expect(target.classList.contains("message--trace-target")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
      inline: "nearest",
    });
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "nearest",
      inline: "nearest",
    });

    const matchedContext = within(target).getByText("matched.ts").closest(".sent-context");
    expect(matchedContext?.classList.contains("sent-context--trace-target")).toBe(true);
    expect(within(matchedContext as HTMLElement).getByText("Linked")).toBeTruthy();
    const matchedContextOpen = (matchedContext as HTMLElement).querySelector<HTMLButtonElement>(
      ".sent-context__open",
    )!;

    fireEvent.click(within(target).getByRole("button", { name: "Clear selection match" }));
    expect(within(target).queryByText("Matched selection")).toBeNull();
    expect(target.classList.contains("message--trace-target")).toBe(false);
    expect(matchedContext?.classList.contains("sent-context--trace-target")).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(matchedContextOpen));

    const switchedState = structuredClone(state);
    switchedState.activeConversationId = "conversation-2";
    switchedState.modelPicker.conversationId = "conversation-2";
    switchedState.conversations.push({
      id: "conversation-2",
      title: "Another conversation",
      createdAt: "2026-07-25T00:00:05.000Z",
      updatedAt: "2026-07-25T00:00:05.000Z",
      messages: [],
    });
    sendHostMessage({ type: "state", state: switchedState });
    expect(screen.queryByText("Question that used this selection")).toBeNull();

    sendHostMessage({ type: "state", state });
    const remountedTarget = screen
      .getAllByRole("article", { name: "Your question" })
      .find((article) => article.textContent?.includes("Question that used this selection"))!;
    expect(within(remountedTarget).queryByText("Matched selection")).toBeNull();
    expect(remountedTarget.classList.contains("message--trace-target")).toBe(false);
    fireEvent.click(
      within(remountedTarget).getByRole("button", { name: "Show more code context" }),
    );
    expect(
      within(remountedTarget)
        .getByText("matched.ts")
        .closest(".sent-context")
        ?.classList.contains("sent-context--trace-target"),
    ).toBe(false);
  });

  it("keeps actionable warnings visible until dismissal while informational notices expire", async () => {
    vi.useFakeTimers();
    render(<App />);
    sendHostMessage({ type: "state", state: makeState() });

    sendHostMessage({ type: "notice", level: "warning", message: "The source file changed." });
    const warning = screen.getByText("The source file changed.").closest(".toast") as HTMLElement;
    expect(warning).toBeTruthy();

    await act(() => vi.advanceTimersByTimeAsync(8_000));
    expect(screen.getByText("The source file changed.")).toBeTruthy();
    fireEvent.click(within(warning).getByRole("button", { name: "关闭提示" }));
    expect(screen.queryByText("The source file changed.")).toBeNull();

    sendHostMessage({ type: "notice", level: "info", message: "Copied." });
    expect(screen.getByText("Copied.")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(2_600));
    expect(screen.queryByText("Copied.")).toBeNull();
  });

  it("tracks the current prompt in the question rail while the transcript scrolls", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    for (let index = 1; index <= 4; index += 1) {
      state.conversations[0]!.messages.push({
        id: `tracked-question-${index}`,
        role: "user",
        markdown: `Tracked question ${index}`,
        status: "complete",
        createdAt: `2026-07-25T00:00:0${index}.000Z`,
      });
    }
    sendHostMessage({ type: "state", state });

    const transcript = screen.getByRole("main", { name: "Q&A transcript" });
    const questions = screen.getAllByRole("article", { name: "Your question" });
    for (const [index, question] of questions.entries()) {
      Object.defineProperty(question, "offsetTop", {
        configurable: true,
        value: 40 + index * 220,
      });
    }
    Object.defineProperty(transcript, "scrollTop", {
      configurable: true,
      value: 500,
      writable: true,
    });
    Object.defineProperty(transcript, "scrollHeight", {
      configurable: true,
      value: 1_400,
    });
    Object.defineProperty(transcript, "clientHeight", {
      configurable: true,
      value: 400,
    });
    fireEvent.scroll(transcript);

    const markers = within(screen.getByRole("navigation", { name: "User messages" })).getAllByRole(
      "button",
    );
    expect(markers.map((marker) => marker.getAttribute("aria-current"))).toEqual([
      null,
      null,
      "true",
      null,
    ]);
  });

  it("navigates between user prompts with Alt+ArrowUp and Alt+ArrowDown", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    for (let index = 1; index <= 4; index += 1) {
      state.conversations[0]!.messages.push({
        id: `shortcut-question-${index}`,
        role: "user",
        markdown: `Shortcut question ${index}`,
        status: "complete",
        createdAt: `2026-07-25T00:00:0${index}.000Z`,
      });
    }
    sendHostMessage({ type: "state", state });

    const markers = within(screen.getByRole("navigation", { name: "User messages" })).getAllByRole(
      "button",
    );
    expect(markers.at(-1)?.getAttribute("aria-current")).toBe("true");
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
    scrollIntoView.mockClear();

    fireEvent.keyDown(window, { altKey: true, key: "ArrowUp" });
    expect(markers[2]?.getAttribute("aria-current")).toBe("true");
    fireEvent.keyDown(window, { altKey: true, key: "ArrowDown" });
    expect(markers[3]?.getAttribute("aria-current")).toBe("true");
    expect(scrollIntoView).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(window, { altKey: true, ctrlKey: true, key: "ArrowUp" });
    fireEvent.keyDown(window, { altKey: true, key: "ArrowDown" });
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("uses instant transcript navigation when reduced motion is requested", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    for (let index = 1; index <= 4; index += 1) {
      state.conversations[0]!.messages.push({
        id: `reduced-motion-question-${index}`,
        role: "user",
        markdown: `Reduced motion question ${index}`,
        status: "complete",
        createdAt: `2026-07-25T00:00:0${index}.000Z`,
      });
    }
    sendHostMessage({ type: "state", state });

    const originalMatchMedia = window.matchMedia;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
    scrollIntoView.mockClear();
    try {
      const markers = within(
        screen.getByRole("navigation", { name: "User messages" }),
      ).getAllByRole("button");
      fireEvent.click(markers[1]!);
      expect(scrollIntoView).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: "auto", block: "start" }),
      );
    } finally {
      vi.stubGlobal("matchMedia", originalMatchMedia);
    }
  });

  it("keeps a short latest turn viewport without a permanent spacer", async () => {
    vi.useFakeTimers();
    render(<App />);
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
    scrollIntoView.mockClear();
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.messages.push(
      {
        id: "user-short-answer",
        role: "user",
        markdown: "Reply briefly",
        status: "complete",
        createdAt: "2026-07-25T00:00:00.000Z",
      },
      {
        id: "assistant-short-answer",
        role: "assistant",
        markdown: "",
        status: "streaming",
        createdAt: "2026-07-25T00:00:01.000Z",
      },
    );
    state.conversations[0]!.run = {
      id: "run-short-answer",
      messageId: "assistant-short-answer",
      status: "streaming",
      startedAt: "2026-07-25T00:00:01.000Z",
    };
    sendHostMessage({ type: "state", state });

    expect(screen.getByText("Reply briefly")).toBeTruthy();
    expect(document.querySelector(".message--latest-turn")).toBeTruthy();
    expect(document.querySelector(".turn-runway-temporary")).toBeNull();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    const complete = structuredClone(state);
    complete.conversations[0]!.run = undefined;
    complete.conversations[0]!.messages[1]!.markdown = "OK";
    complete.conversations[0]!.messages[1]!.status = "complete";
    sendHostMessage({ type: "state", state: complete });

    expect(screen.getByText("OK")).toBeTruthy();
    expect(document.querySelector(".message--latest-turn")).toBeTruthy();
    expect(document.querySelector(".turn-runway-temporary")).toBeNull();
    expect(
      screen.getByText("Reply briefly").closest<HTMLElement>("[data-turn-anchor]")?.dataset
        .turnAnchor,
    ).toBe("true");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(49));
    expect(document.querySelector(".message--latest-turn")).toBeNull();
  });

  it("does not reserve a permanent runway for completed history ending in a user turn", () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.messages.push({
      id: "user-terminal-only",
      role: "user",
      markdown: "A completed imported prompt",
      status: "complete",
      createdAt: "2026-07-25T00:00:00.000Z",
    });
    sendHostMessage({ type: "state", state });

    expect(screen.getByText("A completed imported prompt")).toBeTruthy();
    expect(document.querySelector(".message--latest-turn")).toBeNull();
    expect(document.querySelector(".turn-runway-temporary")).toBeNull();
  });

  it("follows the tail after an anchored answer grows past the viewport", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.messages.push(
      {
        id: "user-growing-answer",
        role: "user",
        markdown: "Explain this fully",
        status: "complete",
        createdAt: "2026-07-25T00:00:00.000Z",
      },
      {
        id: "assistant-growing-answer",
        role: "assistant",
        markdown: "First paragraph",
        status: "streaming",
        createdAt: "2026-07-25T00:00:01.000Z",
      },
    );
    state.conversations[0]!.run = {
      id: "run-growing-answer",
      messageId: "assistant-growing-answer",
      status: "streaming",
      startedAt: "2026-07-25T00:00:01.000Z",
    };
    sendHostMessage({ type: "state", state });

    const transcript = await screen.findByRole("main", { name: "Q&A transcript" });
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_200 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    vi.spyOn(transcript, "getBoundingClientRect").mockReturnValue({
      bottom: 300,
    } as DOMRect);
    const answer = document.querySelector<HTMLElement>(
      '[data-latest-assistant="true"] .assistant-markdown',
    )!;
    vi.spyOn(answer, "getBoundingClientRect").mockReturnValue({ bottom: 520 } as DOMRect);

    sendHostMessage({
      type: "generationUpdate",
      update: {
        conversationId: "conversation-1",
        messageId: "assistant-growing-answer",
        runId: "run-growing-answer",
        markdown: `First paragraph\n\n${"Growing output. ".repeat(120)}`,
        updatedAt: "2026-07-25T00:00:02.000Z",
      },
    });

    await vi.waitFor(() => expect(transcript.scrollTop).toBe(1_200));
  });

  it("flushes streaming follow with a timeout when background animation frames never run", async () => {
    vi.useFakeTimers();
    const requestAnimationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 41);
    const cancelAnimationFrame = vi.spyOn(window, "cancelAnimationFrame");

    try {
      render(<App />);
      const state = makeState();
      state.locale = "en";
      state.conversations[0]!.messages.push(
        {
          id: "user-background-stream",
          role: "user",
          markdown: "Keep following in the background",
          status: "complete",
          createdAt: "2026-07-25T00:00:00.000Z",
        },
        {
          id: "assistant-background-stream",
          role: "assistant",
          markdown: "First chunk",
          status: "streaming",
          createdAt: "2026-07-25T00:00:01.000Z",
        },
      );
      state.conversations[0]!.run = {
        id: "run-background-stream",
        messageId: "assistant-background-stream",
        status: "streaming",
        startedAt: "2026-07-25T00:00:01.000Z",
      };
      sendHostMessage({ type: "state", state });

      const transcript = screen.getByRole("main", { name: "Q&A transcript" });
      Object.defineProperties(transcript, {
        clientHeight: { configurable: true, value: 300 },
        scrollHeight: { configurable: true, value: 1_200 },
        scrollTop: { configurable: true, value: 0, writable: true },
      });
      vi.spyOn(transcript, "getBoundingClientRect").mockReturnValue({ bottom: 300 } as DOMRect);
      const answer = document.querySelector<HTMLElement>(
        '[data-latest-assistant="true"] .assistant-markdown',
      )!;
      vi.spyOn(answer, "getBoundingClientRect").mockReturnValue({ bottom: 520 } as DOMRect);

      sendHostMessage({
        type: "generationUpdate",
        update: {
          conversationId: "conversation-1",
          messageId: "assistant-background-stream",
          runId: "run-background-stream",
          markdown: `First chunk\n\n${"Still arriving. ".repeat(80)}`,
          updatedAt: "2026-07-25T00:00:02.000Z",
        },
      });
      await act(async () => vi.advanceTimersByTime(48));
      expect(transcript.scrollTop).toBe(1_200);

      Object.defineProperty(transcript, "scrollHeight", {
        configurable: true,
        value: 1_500,
      });
      sendHostMessage({
        type: "generationUpdate",
        update: {
          conversationId: "conversation-1",
          messageId: "assistant-background-stream",
          runId: "run-background-stream",
          markdown: `First chunk\n\n${"Still arriving. ".repeat(160)}`,
          updatedAt: "2026-07-25T00:00:03.000Z",
        },
      });
      await act(async () => vi.advanceTimersByTime(48));
      expect(transcript.scrollTop).toBe(1_500);
      expect(cancelAnimationFrame).toHaveBeenCalledWith(41);
    } finally {
      requestAnimationFrame.mockRestore();
      cancelAnimationFrame.mockRestore();
    }
  });

  it("follows transcript viewport resizes caused by the composer footer", async () => {
    const resizeObservers: Array<{
      callback: ResizeObserverCallback;
      targets: Set<Element>;
    }> = [];
    const previousResizeObserver = globalThis.ResizeObserver;
    class ResizeObserverHarness implements ResizeObserver {
      readonly targets = new Set<Element>();

      constructor(readonly callback: ResizeObserverCallback) {
        resizeObservers.push(this);
      }

      disconnect() {}
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverHarness);

    try {
      render(<App />);
      const state = makeState();
      state.locale = "en";
      state.conversations[0]!.messages.push({
        id: "user-footer-resize",
        role: "user",
        markdown: "Keep the latest output visible",
        status: "complete",
        createdAt: "2026-07-25T00:00:00.000Z",
      });
      sendHostMessage({ type: "state", state });

      const transcript = screen.getByRole("main", { name: "Q&A transcript" });
      Object.defineProperties(transcript, {
        clientHeight: { configurable: true, value: 300 },
        scrollHeight: { configurable: true, value: 1_200 },
        scrollTop: { configurable: true, value: 900, writable: true },
      });
      fireEvent.wheel(transcript, { deltaY: 120 });
      fireEvent.scroll(transcript);

      const transcriptObserver = resizeObservers.find(({ targets }) => targets.has(transcript));
      expect(transcriptObserver).toBeTruthy();
      Object.defineProperty(transcript, "clientHeight", {
        configurable: true,
        value: 220,
      });
      await act(async () => {
        transcriptObserver?.callback([], transcriptObserver as unknown as ResizeObserver);
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(transcript.scrollTop).toBe(1_200);
    } finally {
      if (previousResizeObserver) {
        vi.stubGlobal("ResizeObserver", previousResizeObserver);
      } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
      }
    }
  });

  it("keeps a detached reader still across streaming resize and follows again only after jump", async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    const previousResizeObserver = globalThis.ResizeObserver;
    class ResizeObserverHarness implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }

      disconnect() {}
      observe() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverHarness);

    try {
      render(<App />);
      const state = makeState();
      state.locale = "en";
      state.conversations[0]!.messages.push(
        {
          id: "user-stream",
          role: "user",
          markdown: "Explain this",
          status: "complete",
          createdAt: "2026-07-25T00:00:00.000Z",
        },
        {
          id: "assistant-stream",
          role: "assistant",
          markdown: "First chunk",
          status: "streaming",
          createdAt: "2026-07-25T00:00:01.000Z",
        },
      );
      state.conversations[0]!.run = {
        id: "run-stream",
        messageId: "assistant-stream",
        status: "streaming",
        startedAt: "2026-07-25T00:00:01.000Z",
      };
      sendHostMessage({ type: "state", state });

      const transcript = await screen.findByRole("main", { name: "Q&A transcript" });
      Object.defineProperties(transcript, {
        clientHeight: { configurable: true, value: 300 },
        scrollHeight: { configurable: true, value: 1_200 },
        scrollTop: { configurable: true, value: 260, writable: true },
      });
      fireEvent.wheel(transcript, { deltaY: -120 });
      fireEvent.scroll(transcript);
      expect(screen.getByRole("button", { name: "Jump to latest" })).toBeTruthy();

      await act(async () => {
        for (const callback of resizeCallbacks) {
          callback([], {} as ResizeObserver);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(transcript.scrollTop).toBe(260);

      fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
      expect(transcript.scrollTop).toBe(1_200);

      Object.defineProperty(transcript, "scrollHeight", {
        configurable: true,
        value: 1_500,
      });
      await act(async () => {
        for (const callback of resizeCallbacks) {
          callback([], {} as ResizeObserver);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(transcript.scrollTop).toBe(1_500);
    } finally {
      if (previousResizeObserver) {
        vi.stubGlobal("ResizeObserver", previousResizeObserver);
      } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
      }
    }
  });

  it("restores each conversation's detached reading position when switching back", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.messages.push({
      id: "question-a",
      role: "user",
      markdown: "Conversation A",
      status: "complete",
      createdAt: "2026-07-25T00:00:00.000Z",
    });
    state.conversations.push({
      id: "conversation-2",
      title: "Conversation B",
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:01.000Z",
      messages: [
        {
          id: "question-b",
          role: "user",
          markdown: "Conversation B",
          status: "complete",
          createdAt: "2026-07-25T00:00:01.000Z",
        },
      ],
    });
    sendHostMessage({ type: "state", state });

    const transcript = await screen.findByRole("main", { name: "Q&A transcript" });
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_200 },
      scrollTop: { configurable: true, value: 210, writable: true },
    });
    fireEvent.scroll(transcript);

    Object.defineProperty(transcript, "scrollHeight", {
      configurable: true,
      value: 1_800,
    });
    const selectedB = structuredClone(state);
    selectedB.activeConversationId = "conversation-2";
    selectedB.modelPicker.conversationId = "conversation-2";
    sendHostMessage({ type: "state", state: selectedB });
    expect(transcript.scrollTop).toBe(1_800);

    transcript.scrollTop = 640;
    fireEvent.scroll(transcript);
    Object.defineProperty(transcript, "scrollHeight", {
      configurable: true,
      value: 1_200,
    });
    sendHostMessage({ type: "state", state });
    expect(transcript.scrollTop).toBe(210);
  });

  it("does not force the reader to the latest snapshot and offers a jump control", async () => {
    render(<App />);
    const state = makeState();
    state.conversations[0]!.messages.push(
      {
        id: "user-1",
        role: "user",
        markdown: "请详细解释",
        status: "complete",
        createdAt: new Date().toISOString(),
      },
      {
        id: "assistant-1",
        role: "assistant",
        markdown: "一段较长的回答",
        status: "streaming",
        createdAt: new Date().toISOString(),
      },
    );
    sendHostMessage({ type: "state", state });

    const transcript = await screen.findByRole("main", { name: "问答记录" });
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_200 },
      scrollTop: { configurable: true, value: 120, writable: true },
    });
    fireEvent.wheel(transcript, { deltaY: -120 });
    fireEvent.scroll(transcript);

    const jump = screen.getByRole("button", { name: "回到底部" });
    fireEvent.click(jump);
    expect(transcript.scrollTop).toBe(1_200);
  });

  it("starts a newly selected long conversation at its latest message", async () => {
    render(<App />);
    const state = makeState();
    state.conversations[0]!.messages.push({
      id: "question-a",
      role: "user",
      markdown: "Conversation A",
      status: "complete",
      createdAt: new Date().toISOString(),
    });
    state.conversations.push({
      id: "conversation-2",
      title: "Conversation B",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: "question-b",
          role: "user",
          markdown: "Conversation B latest",
          status: "complete",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    sendHostMessage({ type: "state", state });

    const transcript = await screen.findByRole("main", { name: "问答记录" });
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_800 },
      scrollTop: { configurable: true, value: 140, writable: true },
    });
    fireEvent.scroll(transcript);

    const selected = structuredClone(state);
    selected.activeConversationId = "conversation-2";
    selected.modelPicker.conversationId = "conversation-2";
    sendHostMessage({ type: "state", state: selected });

    expect(transcript.scrollTop).toBe(1_800);
    expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull();
  });

  it("keeps the complete frame mounted when a transient state has no active conversation", async () => {
    render(<App />);
    const state = makeState();
    sendHostMessage({ type: "state", state });

    const composer = await screen.findByRole("textbox");
    const transcript = screen.getByRole("main", { name: "问答记录" });
    fireEvent.change(composer, { target: { value: "保留这条已发送问题" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(screen.getByText("保留这条已发送问题")).toBeTruthy();

    sendHostMessage({
      type: "state",
      state: {
        ...state,
        activeConversationId: "missing-conversation",
        conversations: [],
      },
    });

    expect(screen.getByRole("textbox")).toBe(composer);
    expect(screen.getByRole("main", { name: "问答记录" })).toBe(transcript);
    expect(screen.getByText("保留这条已发送问题")).toBeTruthy();

    const accepted = structuredClone(state);
    accepted.conversations[0]!.messages.push({
      id: "accepted-after-transient-frame",
      role: "user",
      markdown: "保留这条已发送问题",
      status: "complete",
      createdAt: new Date().toISOString(),
    });
    sendHostMessage({ type: "state", state: accepted });
    expect(screen.getAllByText("保留这条已发送问题")).toHaveLength(1);
  });

  it("does not remount the transcript or composer across relay and Project status updates", async () => {
    render(<App />);
    const state = makeState();
    sendHostMessage({ type: "state", state });

    const composer = await screen.findByRole("textbox");
    const transcript = screen.getByRole("main", { name: "问答记录" });

    sendHostMessage({
      type: "state",
      state: {
        ...state,
        backend: {
          ...state.backend,
          authenticated: false,
          connected: false,
          project: { bound: false },
        },
      },
    });
    expect(screen.getByRole("textbox")).toBe(composer);
    expect(screen.getByRole("main", { name: "问答记录" })).toBe(transcript);

    sendHostMessage({ type: "state", state });
    expect(screen.getByRole("textbox")).toBe(composer);
    expect(screen.getByRole("main", { name: "问答记录" })).toBe(transcript);
  });

  it("keeps completed Markdown mounted while replacing only the streaming answer", async () => {
    render(<App />);
    const state = makeState();
    state.conversations[0]!.messages.push(
      {
        id: "assistant-stable",
        role: "assistant",
        markdown: "Stable **answer**",
        status: "complete",
        createdAt: new Date().toISOString(),
      },
      {
        id: "assistant-streaming",
        role: "assistant",
        markdown: "First snapshot",
        status: "streaming",
        createdAt: new Date().toISOString(),
      },
    );
    sendHostMessage({ type: "state", state });

    const stableArticle = (await screen.findByText("answer")).closest("article");
    expect(stableArticle).not.toBeNull();

    sendHostMessage({
      type: "state",
      state: {
        ...state,
        conversations: [
          {
            ...state.conversations[0]!,
            messages: [
              state.conversations[0]!.messages[0]!,
              {
                ...state.conversations[0]!.messages[1]!,
                markdown: "Second snapshot with more text",
              },
            ],
          },
        ],
      },
    });

    expect(screen.getByText("answer").closest("article")).toBe(stableArticle);
    expect(screen.getByText("Second snapshot with more text")).not.toBeNull();
  });

  it("clears rejected-send rollback attachments while a new conversation is opening", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    const attachment = makeContext({ id: "context-a", fileName: "first.ts" });
    state.pendingContexts = [attachment];
    sendHostMessage({ type: "state", state });

    const composer = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    expect(screen.getByRole("region", { name: "Attached code context" })).toBeTruthy();
    expect(screen.getByText("first.ts")).toBeTruthy();
    fireEvent.change(composer, { target: { value: "local draft" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    sendHostMessage({
      type: "sendResult",
      accepted: false,
      conversationId: "conversation-1",
      requestId: "request-00000000-0000-4000-8000-000000000001",
    });
    expect(composer.value).toBe("local draft");
    expect(screen.getByText("first.ts")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(posted).toContainEqual({
      type: "newConversation",
      sourceConversationId: "conversation-1",
    });
    expect(composer.value).toBe("");
    expect(screen.queryByRole("region", { name: "Attached code context" })).toBeNull();
    expect(screen.queryByText("first.ts")).toBeNull();
    expect(screen.getByRole("region", { name: "Ask2GPT home" })).toBeTruthy();

    const now = new Date().toISOString();
    sendHostMessage({
      type: "state",
      state: {
        ...state,
        activeConversationId: "conversation-2",
        pendingContexts: [],
        automaticContextIds: [],
        modelPicker: { ...state.modelPicker, conversationId: "conversation-2" },
        conversations: [
          ...state.conversations,
          {
            id: "conversation-2",
            title: "Second conversation",
            createdAt: now,
            updatedAt: now,
            messages: [],
          },
        ],
      },
    });

    expect(screen.getByRole("textbox")).toBe(composer);
    expect(composer.value).toBe("");
    expect(screen.queryByRole("region", { name: "Attached code context" })).toBeNull();
    expect(screen.queryByText("first.ts")).toBeNull();

    sendHostMessage({ type: "state", state });
    expect(screen.getByText("first.ts")).toBeTruthy();
    expect(composer.value).toBe("local draft");
  });

  it("routes safe Markdown links through the host and neutralizes active URLs", async () => {
    render(<App />);
    const state = makeState();
    state.conversations[0]!.messages.push({
      id: "assistant-1",
      role: "assistant",
      markdown: "[安全链接](https://example.com/docs) [危险链接](javascript:alert(1))",
      status: "complete",
      createdAt: new Date().toISOString(),
    });
    sendHostMessage({ type: "state", state });

    const safe = await screen.findByRole("link", { name: "安全链接" });
    expect(screen.queryByRole("link", { name: "危险链接" })).toBeNull();
    fireEvent.click(safe);
    expect(posted).toContainEqual({
      type: "openExternal",
      url: "https://example.com/docs",
    });
  });

  it("turns plain-text and inline-code file locations into source reference actions", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.messages.push(
      {
        id: "question-source-links",
        role: "user",
        markdown: "Where is this implemented?",
        status: "complete",
        createdAt: "2026-07-25T00:00:01.000Z",
        contexts: [
          makeContext({
            id: "vector-store-source",
            fileName: "06_vector_store.py",
            language: "python",
            startLine: 1,
            endLine: 80,
          }),
        ],
      },
      {
        id: "answer-source-links",
        role: "assistant",
        markdown: "Start at 06_vector_store.py:34, then compare `06_vector_store.py:35-36`.",
        status: "complete",
        createdAt: "2026-07-25T00:00:02.000Z",
      },
    );
    state.sourceTraceHints = {
      "conversation-1": {
        "answer-source-links": {
          fileReferences: ["06_vector_store.py:34", "06_vector_store.py:35-36"],
          sourceSymbols: [],
        },
      },
    };
    sendHostMessage({ type: "state", state });

    const plain = await screen.findByRole("button", {
      name: "Open 06_vector_store.py:34 in the editor",
    });
    const inline = screen.getByRole("button", {
      name: "Open 06_vector_store.py:35-36 in the editor",
    });
    fireEvent.click(plain);
    fireEvent.click(inline);

    expect(posted).toContainEqual({
      type: "openSourceReference",
      conversationId: "conversation-1",
      messageId: "answer-source-links",
      kind: "file-line",
      reference: "06_vector_store.py:34",
    });
    expect(posted).toContainEqual({
      type: "openSourceReference",
      conversationId: "conversation-1",
      messageId: "answer-source-links",
      kind: "file-line",
      reference: "06_vector_store.py:35-36",
    });
  });

  it("does not turn fenced code or existing HTTP links into local source actions", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.messages.push({
      id: "answer-non-source-links",
      role: "assistant",
      markdown:
        "```text\n06_vector_store.py:34\n```\n\n[06_vector_store.py:35](https://example.com/source)",
      status: "complete",
      createdAt: "2026-07-25T00:00:01.000Z",
    });
    sendHostMessage({ type: "state", state });

    const external = await screen.findByRole("link", { name: "06_vector_store.py:35" });
    expect(document.querySelector(".source-reference")).toBeNull();
    expect(screen.getByText("06_vector_store.py:34", { selector: "code" })).toBeTruthy();
    fireEvent.click(external);
    expect(posted).toContainEqual({
      type: "openExternal",
      url: "https://example.com/source",
    });
  });

  it("leaves file and symbol references inert without host authorization", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.messages.push({
      id: "answer-without-source-hints",
      role: "assistant",
      markdown: "See missing.py:10 and `missing.py:11`, then call `missing_helper()`.",
      status: "complete",
      createdAt: "2026-07-25T00:00:01.000Z",
    });
    sendHostMessage({ type: "state", state });

    expect(await screen.findByText(/See missing\.py:10/u)).toBeTruthy();
    expect(screen.getByText("missing.py:11", { selector: "code" })).toBeTruthy();
    expect(screen.getByText("missing_helper()", { selector: "code" })).toBeTruthy();
    expect(document.querySelector(".source-reference")).toBeNull();
  });

  it("links known attached functions while leaving unknown inline code unchanged", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.messages.push(
      {
        id: "question-symbol-link",
        role: "user",
        markdown: "Explain this function",
        status: "complete",
        createdAt: "2026-07-25T00:00:01.000Z",
        contexts: [
          makeContext({
            id: "symbol-source",
            fileName: "06_vector_store.py",
            language: "python",
            content: "def get_embeddings_endpoint():\n    return endpoint",
            startLine: 21,
            endLine: 22,
          }),
        ],
      },
      {
        id: "answer-symbol-link",
        role: "assistant",
        markdown: "Call `get_embeddings_endpoint()`; do not call `unknown_helper()`.",
        status: "complete",
        createdAt: "2026-07-25T00:00:02.000Z",
      },
    );
    state.sourceTraceHints = {
      "conversation-1": {
        "answer-symbol-link": {
          fileReferences: [],
          sourceSymbols: ["get_embeddings_endpoint"],
        },
      },
    };
    sendHostMessage({ type: "state", state });

    const known = await screen.findByRole("button", {
      name: "Find the definition of get_embeddings_endpoint()",
    });
    const unknown = screen.getByText("unknown_helper()", { selector: "code" });
    expect(unknown.closest("button")).toBeNull();
    fireEvent.click(known);
    expect(posted).toContainEqual({
      type: "openSourceReference",
      conversationId: "conversation-1",
      messageId: "answer-symbol-link",
      kind: "symbol",
      reference: "get_embeddings_endpoint()",
    });
  });

  it("does not borrow source authorization across a newer user turn without context", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.conversations[0]!.messages.push(
      {
        id: "older-question-with-source",
        role: "user",
        markdown: "Explain the old source",
        status: "complete",
        createdAt: "2026-07-25T00:00:01.000Z",
        contexts: [
          makeContext({
            id: "older-source",
            fileName: "older.py",
            language: "python",
            content: "def older_helper():\n    return True",
            startLine: 1,
            endLine: 2,
          }),
        ],
      },
      {
        id: "older-answer-with-hints",
        role: "assistant",
        markdown: "See older.py:1 and `older_helper()`.",
        status: "complete",
        createdAt: "2026-07-25T00:00:02.000Z",
      },
      {
        id: "newer-question-without-source",
        role: "user",
        markdown: "What about this new turn?",
        status: "complete",
        createdAt: "2026-07-25T00:00:03.000Z",
      },
      {
        id: "newer-answer-without-hints",
        role: "assistant",
        markdown: "See older.py:1 and `older_helper()`.",
        status: "complete",
        createdAt: "2026-07-25T00:00:04.000Z",
      },
    );
    state.sourceTraceHints = {
      "conversation-1": {
        "older-answer-with-hints": {
          fileReferences: ["older.py:1"],
          sourceSymbols: ["older_helper"],
        },
      },
    };
    sendHostMessage({ type: "state", state });

    const answers = await screen.findAllByRole("article", { name: "Answer" });
    expect(answers[0]!.querySelectorAll(".source-reference")).toHaveLength(2);
    expect(answers[1]!.querySelector(".source-reference")).toBeNull();
    expect(within(answers[1]!).getByText("older_helper()", { selector: "code" })).toBeTruthy();
  });

  it("blocks sending until first-time chat setup completes", async () => {
    render(<App />);
    const state = makeState();
    state.locale = "en";
    state.backend.project = { bound: false };
    state.backend.connection = {
      phase: "project-required",
      since: new Date().toISOString(),
      browserDetected: true,
      hasStoredTrust: true,
    };
    sendHostMessage({ type: "state", state });

    const textbox = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    expect(textbox.disabled).toBe(false);
    fireEvent.change(textbox, { target: { value: "Draft while Project is unbound" } });
    expect(textbox.value).toBe("Draft while Project is unbound");
    const projectStatus = screen.getByText("Preparing the chat").closest("section");
    expect(projectStatus?.getAttribute("role")).toBe("status");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByText(/complete setup/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Continue setup" })).not.toBeNull();
    const sendButton = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    fireEvent.click(sendButton);
    expect(posted).not.toContainEqual(expect.objectContaining({ type: "send" }));
  });

  it("turns a legacy trust mismatch into one non-destructive reconnect path", async () => {
    render(<App />);
    const state = makeState();
    state.backend.connected = false;
    state.backend.authenticated = false;
    state.backend.connection = {
      phase: "trust-mismatch",
      since: new Date().toISOString(),
      browserDetected: true,
      hasStoredTrust: true,
      errorCode: "PAIRING_MISMATCH",
    };
    sendHostMessage({ type: "state", state });

    expect(await screen.findByText("需要重新连接")).toBeTruthy();
    const details = screen.getByText("技术详情").closest("details");
    expect(details?.open).toBe(false);
    fireEvent.click(screen.getByText("技术详情"));
    expect(details?.open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "复制脱敏诊断信息" }));
    expect(posted).toContainEqual({ type: "copyDiagnostics" });
    expect(screen.queryByRole("button", { name: "重新建立连接…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    expect(posted).toContainEqual({ type: "retryConnection" });
  });

  it("explains version mismatch and retries without presenting pairing controls", async () => {
    render(<App />);
    const state = makeState();
    state.backend.connected = false;
    state.backend.authenticated = false;
    state.backend.connection = {
      phase: "version-mismatch",
      since: new Date().toISOString(),
      browserDetected: true,
      hasStoredTrust: true,
      hostVersion: "0.0.0",
      relayVersion: "0.1.7",
      protocolVersion: 8,
      detectedProtocol: "ask2gpt.v9",
      errorCode: "PROTOCOL_MISMATCH",
    };
    sendHostMessage({ type: "state", state });

    expect(await screen.findByText("两个扩展版本不兼容")).toBeTruthy();
    expect(screen.getByText(/从 Chrome 工具栏打开 Ask2GPT Relay/)).toBeTruthy();
    expect(screen.getByText(/草稿和对话不会丢失/)).toBeTruthy();
    fireEvent.click(screen.getByText("技术详情"));
    expect(screen.getByText("Host 版本")).toBeTruthy();
    expect(screen.getByText("0.0.0")).toBeTruthy();
    expect(screen.getByText("Relay 版本")).toBeTruthy();
    expect(screen.getByText("0.1.7")).toBeTruthy();
    expect(screen.getByText("协议")).toBeTruthy();
    expect(screen.getAllByText("ask2gpt.v9")).toHaveLength(1);
    expect(screen.getByText("最近连接")).toBeTruthy();
    expect(screen.queryByText("首次连接 Chrome")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
    expect(posted).toContainEqual({ type: "retryConnection" });
  });
});

function sendHostMessage(message: HostToWebviewMessage) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: message }));
  });
}

function makeState(): AppState {
  const now = new Date().toISOString();
  return {
    activeConversationId: "conversation-1",
    backend: {
      activeRuns: 0,
      authenticated: true,
      connected: true,
      connection: {
        phase: "ready",
        since: now,
        browserDetected: true,
        hasStoredTrust: true,
        lastConnectedAt: now,
      },
      project: { bound: true, name: "Ask2GPT" },
      port: 32_171,
      selectorVersion: 1,
    },
    conversations: [
      {
        id: "conversation-1",
        title: "新对话",
        createdAt: now,
        updatedAt: now,
        messages: [],
      },
    ],
    modelPicker: {
      conversationId: "conversation-1",
      status: "idle",
      options: [],
    },
    locale: "zh-CN",
    pendingContexts: [],
    automaticContextIds: [],
    contextLocked: false,
  };
}

function modelOption(
  mode: "smart" | "fast" | "low" | "medium" | "high" | "very-high" | "pro",
  id: string,
  familyLabel: string,
  selected = false,
) {
  return {
    id,
    label: mode,
    mode,
    modelId: `gpt-${mode}`,
    familyLabel,
    selected,
  };
}

function makeContext(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    id: "context-default",
    kind: "current-file",
    fileName: "example.ts",
    uri: "file:///workspace/example.ts",
    language: "typescript",
    startLine: 1,
    endLine: 4,
    content: "export const answer = 42;",
    charCount: 25,
    unsaved: false,
    ...overrides,
  };
}
