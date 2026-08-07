import { createRequire } from "node:module";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  ChatModelOption,
  ContextSnapshot,
  Conversation,
  ConversationCanonicalizationResultPayload,
  PendingRemotePromotion,
} from "@ask2gpt/protocol";

import type { ContextService } from "./services/context-service";
import type { ConversationStore, ConversationStoreLoadReport } from "./services/conversation-store";
import type { SafeLogger } from "./services/logger";
import type {
  BackendEvent,
  BackendStatus,
  ChatBackend,
  HostToWebviewMessage,
  SendRequest,
  WebviewToHostMessage,
} from "./types";

const contextNavigationMock = vi.hoisted(() => ({
  openContextFromState: vi.fn(async () => undefined),
}));

vi.mock("vscode", () => ({
  commands: { executeCommand: vi.fn(async () => undefined) },
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

import { Ask2GPTController } from "./controller";
import { Ask2GPTViewProvider } from "./webview-provider";

type TestWindow = Window & typeof globalThis;
interface TestDom {
  window: TestWindow;
}

const jsdomRuntime: unknown = createRequire(import.meta.url)("jsdom");
const JSDOM = (
  jsdomRuntime as {
    JSDOM: new (html?: string, options?: { pretendToBeVisual?: boolean; url?: string }) => TestDom;
  }
).JSDOM;

let App: typeof import("./webview/main").App;
let act: typeof import("@testing-library/react").act;
let cleanup: typeof import("@testing-library/react").cleanup;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;
let screen: typeof import("@testing-library/react").screen;
let activeHarness: FullStoryHarness | undefined;
const harnesses: FullStoryHarness[] = [];
let dom: TestDom;

beforeAll(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "https://ask2gpt.test/",
  });
  installDomGlobals(dom.window);
  const testingLibrary = await import("@testing-library/react");
  ({ act, cleanup, fireEvent, render, screen } = testingLibrary);
  vi.stubGlobal("acquireVsCodeApi", () => ({
    getState: () => undefined,
    postMessage: (message: WebviewToHostMessage) => activeHarness?.receiveFromReact(message),
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
  ({ App } = await import("./webview/main"));
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

afterEach(async () => {
  cleanup();
  activeHarness = undefined;
  await Promise.all(harnesses.splice(0).map(async (harness) => harness.dispose()));
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Controller to Webview full story", () => {
  it("renders one submitted question, cumulative streaming frames, and an immutable terminal answer", async () => {
    const harness = await createHarness();
    renderHarness(harness);

    const question = "Only reply with the final integration answer";
    await submitQuestion(question);

    await vi.waitFor(() => expect(harness.backend.sent).toHaveLength(1));
    const request = harness.backend.sent[0]!;
    expect(harness.hostMessages.filter((message) => message.type === "send")).toHaveLength(1);
    expect(screen.getAllByText(question)).toHaveLength(1);
    expect(
      harness.controller
        .getState()
        .conversations[0]?.messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);

    harness.backend.emit({
      type: "snapshot",
      conversationId: request.conversationId,
      runId: request.runId,
      markdown: "First cumulative fragment",
    });
    expect(await screen.findByText("First cumulative fragment")).toBeTruthy();

    harness.backend.emit({
      type: "snapshot",
      conversationId: request.conversationId,
      runId: request.runId,
      markdown: "First cumulative fragment and the second fragment",
    });
    expect(
      await screen.findByText("First cumulative fragment and the second fragment"),
    ).toBeTruthy();
    expect(screen.queryByText("First cumulative fragment")).toBeNull();

    harness.backend.emit({
      type: "complete",
      conversationId: request.conversationId,
      runId: request.runId,
      terminalEventId: "terminal-full-story-complete",
      markdown: "Final integration answer is complete.",
    });

    expect(await screen.findByText("Final integration answer is complete.")).toBeTruthy();
    await vi.waitFor(() =>
      expect(harness.backend.terminalAcknowledgements).toContainEqual({
        conversationId: request.conversationId,
        runId: request.runId,
        eventId: "terminal-full-story-complete",
      }),
    );

    harness.backend.emit({
      type: "error",
      conversationId: request.conversationId,
      runId: request.runId,
      terminalEventId: "terminal-full-story-late-error",
      error: {
        code: "CHATGPT_REMOTE_UNAVAILABLE",
        message: "Late transport error that must stay invisible",
        recoverable: true,
      },
    });
    harness.backend.emit({
      type: "snapshot",
      conversationId: request.conversationId,
      runId: request.runId,
      markdown: "stale snapshot after completion",
    });

    await vi.waitFor(() =>
      expect(harness.backend.terminalAcknowledgements).toContainEqual({
        conversationId: request.conversationId,
        runId: request.runId,
        eventId: "terminal-full-story-late-error",
      }),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));

    const finalConversation = harness.controller.getState().conversations[0]!;
    const finalAssistant = finalConversation.messages.find(
      (message) => message.role === "assistant",
    )!;
    expect(finalConversation.run).toBeUndefined();
    expect(finalAssistant).toMatchObject({
      markdown: "Final integration answer is complete.",
      status: "complete",
    });
    expect(finalAssistant.runError).toBeUndefined();
    expect(screen.getAllByText(question)).toHaveLength(1);
    expect(screen.getByText("Final integration answer is complete.")).toBeTruthy();
    expect(screen.queryByText("Late transport error that must stay invisible")).toBeNull();
    expect(screen.queryByText("stale snapshot after completion")).toBeNull();
  });

  it("recovers a hidden renderer from a stuck compact post without user interaction", async () => {
    const harness = await createHarness({ deliveryTimeoutMs: 150 });
    renderHarness(harness);

    const question = "Finish even while the sidebar is hidden";
    await submitQuestion(question);
    await vi.waitFor(() => expect(harness.backend.sent).toHaveLength(1));
    const request = harness.backend.sent[0]!;
    await vi.waitFor(() =>
      expect(
        harness.deliveredMessages.some(
          (message) =>
            message.type === "state" &&
            message.state.conversations.some(
              (conversation) => conversation.run?.id === request.runId,
            ),
        ),
      ).toBe(true),
    );

    harness.setHidden(true);
    harness.backend.emit({
      type: "snapshot",
      conversationId: request.conversationId,
      runId: request.runId,
      markdown: "hidden cumulative fragment one",
    });
    await vi.waitFor(() =>
      expect(
        harness.deliveredMessages.some(
          (message) =>
            message.type === "generationUpdate" &&
            message.update.markdown === "hidden cumulative fragment one",
        ),
      ).toBe(true),
    );
    expect(screen.queryByText("hidden cumulative fragment one")).toBeNull();

    harness.hangNextGeneration();
    harness.backend.emit({
      type: "snapshot",
      conversationId: request.conversationId,
      runId: request.runId,
      markdown: "hidden cumulative fragment two that gets stuck",
    });
    await vi.waitFor(() =>
      expect(harness.hungMessage).toMatchObject({
        type: "generationUpdate",
        update: { markdown: "hidden cumulative fragment two that gets stuck" },
      }),
    );

    harness.backend.emit({
      type: "complete",
      conversationId: request.conversationId,
      runId: request.runId,
      terminalEventId: "terminal-hidden-stuck-complete",
      markdown: "Complete answer delivered after automatic recovery.",
    });

    await vi.waitFor(() =>
      expect(harness.logger.error).toHaveBeenCalledWith(
        "webview.post-timeout",
        "WEBVIEW_POST_TIMEOUT",
        expect.objectContaining({ messageType: "generationUpdate", timeoutMs: 150 }),
      ),
    );
    await vi.waitFor(() =>
      expect(
        harness.deliveredMessages.some(
          (message) =>
            message.type === "state" &&
            message.state.conversations.some((conversation) =>
              conversation.messages.some(
                (item) =>
                  item.role === "assistant" &&
                  item.status === "complete" &&
                  item.markdown === "Complete answer delivered after automatic recovery.",
              ),
            ),
        ),
      ).toBe(true),
    );
    expect(screen.queryByText("Complete answer delivered after automatic recovery.")).toBeNull();

    // Visibility restoration is a VS Code lifecycle event, not a chat action.
    // The buffered terminal state must render without a click, scroll, or retry.
    harness.setHidden(false);
    expect(
      await screen.findByText("Complete answer delivered after automatic recovery."),
    ).toBeTruthy();

    // Simulate Chromium settling the timed-out post after the terminal frame.
    // Both the Provider attempt identity and React run correlation must keep it stale.
    harness.releaseHungGeneration(true);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));

    expect(screen.getAllByText(question)).toHaveLength(1);
    expect(screen.getByText("Complete answer delivered after automatic recovery.")).toBeTruthy();
    expect(screen.queryByText("hidden cumulative fragment one")).toBeNull();
    expect(screen.queryByText("hidden cumulative fragment two that gets stuck")).toBeNull();
    expect(harness.backend.sent).toHaveLength(1);
  });
});

class FullStoryHarness {
  readonly backend = new FakeBackend();
  readonly store = new FakeStore();
  readonly logger = { info: vi.fn(), error: vi.fn() };
  readonly hostMessages: WebviewToHostMessage[] = [];
  readonly attemptedMessages: HostToWebviewMessage[] = [];
  readonly deliveredMessages: HostToWebviewMessage[] = [];
  readonly view: {
    visible: boolean;
    show: ReturnType<typeof vi.fn>;
    onDidChangeVisibility: ReturnType<typeof vi.fn>;
    onDidDispose: ReturnType<typeof vi.fn>;
    webview: {
      asWebviewUri(value: unknown): unknown;
      cspSource: string;
      html: string;
      onDidReceiveMessage: ReturnType<typeof vi.fn>;
      options: Record<string, unknown>;
      postMessage: ReturnType<typeof vi.fn>;
    };
  };
  readonly controller: Ask2GPTController;
  readonly provider: Ask2GPTViewProvider;
  hungMessage?: HostToWebviewMessage;

  private hostReceiver?: (message: unknown) => void;
  private visibilityListener?: () => void;
  private disposeListener?: () => void;
  private hangGeneration = false;
  private hungResolve?: (delivered: boolean) => void;
  private visibilityState: DocumentVisibilityState = "visible";
  private readonly originalVisibility = Object.getOwnPropertyDescriptor(
    document,
    "visibilityState",
  );

  constructor(deliveryTimeoutMs: number) {
    const workspaceState = new Map<string, unknown>();
    const extensionContext = {
      workspaceState: {
        get: (key: string) => workspaceState.get(key),
        update: (key: string, value: unknown) => {
          workspaceState.set(key, value);
          return Promise.resolve();
        },
      },
    };
    const contextService = {
      captureSelection: () => contextSnapshot(),
      captureCurrentFile: () => contextSnapshot(),
      captureFiles: async () => [contextSnapshot()],
    };
    this.controller = new Ask2GPTController(
      extensionContext as never,
      this.store as unknown as ConversationStore,
      contextService as unknown as ContextService,
      this.backend,
      this.logger as unknown as SafeLogger,
      "full-story-instance",
    );

    const webview = {
      asWebviewUri: (value: unknown) => value,
      cspSource: "test-source",
      html: "",
      onDidReceiveMessage: vi.fn((listener: (message: unknown) => void) => {
        this.hostReceiver = listener;
        return { dispose: vi.fn() };
      }),
      options: {} as Record<string, unknown>,
      postMessage: vi.fn((message: HostToWebviewMessage) => this.postToReact(message)),
    };
    this.view = {
      visible: true,
      show: vi.fn(),
      onDidChangeVisibility: vi.fn((listener: () => void) => {
        this.visibilityListener = listener;
        return { dispose: vi.fn() };
      }),
      onDidDispose: vi.fn((listener: () => void) => {
        this.disposeListener = listener;
        return { dispose: vi.fn() };
      }),
      webview,
    };
    this.provider = new Ask2GPTViewProvider(
      { path: "extension" } as never,
      this.controller,
      this.logger as unknown as SafeLogger,
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
      deliveryTimeoutMs,
    );
  }

  receiveFromReact(message: WebviewToHostMessage) {
    this.hostMessages.push(structuredClone(message));
    this.hostReceiver?.(message);
  }

  hangNextGeneration() {
    this.hangGeneration = true;
  }

  releaseHungGeneration(deliverLate: boolean) {
    const message = this.hungMessage;
    const resolve = this.hungResolve;
    this.hungMessage = undefined;
    this.hungResolve = undefined;
    if (deliverLate && message) this.dispatchToReact(message);
    resolve?.(true);
  }

  setHidden(hidden: boolean) {
    this.visibilityState = hidden ? "hidden" : "visible";
    this.view.visible = !hidden;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => this.visibilityState,
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    this.visibilityListener?.();
  }

  async dispose() {
    this.releaseHungGeneration(false);
    this.provider.dispose();
    await this.controller.dispose();
    if (this.originalVisibility) {
      Object.defineProperty(document, "visibilityState", this.originalVisibility);
    } else {
      Reflect.deleteProperty(document, "visibilityState");
    }
  }

  private postToReact(message: HostToWebviewMessage): Promise<boolean> {
    const cloned = structuredClone(message);
    this.attemptedMessages.push(cloned);
    if (this.hangGeneration && cloned.type === "generationUpdate") {
      this.hangGeneration = false;
      this.hungMessage = cloned;
      return new Promise<boolean>((resolve) => {
        this.hungResolve = resolve;
      });
    }
    this.deliveredMessages.push(cloned);
    this.dispatchToReact(cloned);
    return Promise.resolve(true);
  }

  private dispatchToReact(message: HostToWebviewMessage) {
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: message }));
    });
  }
}

async function createHarness(options: { deliveryTimeoutMs?: number } = {}) {
  const harness = new FullStoryHarness(options.deliveryTimeoutMs ?? 100);
  harnesses.push(harness);
  await harness.controller.initialize();
  harness.provider.resolveWebviewView(harness.view as never);
  return harness;
}

function renderHarness(harness: FullStoryHarness) {
  document.body.innerHTML = "";
  const initialState = extractInitialState(harness.view.webview.html);
  const script = document.createElement("script");
  script.id = "ask2gpt-initial-state";
  script.type = "application/json";
  script.textContent = initialState;
  document.body.append(script);
  activeHarness = harness;
  render(<App />);
}

async function submitQuestion(question: string) {
  const composer = (await screen.findByRole("textbox", {
    name: "Ask Ask2GPT",
  })) as HTMLTextAreaElement;
  fireEvent.change(composer, { target: { value: question } });
  fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });
}

function extractInitialState(html: string) {
  const match = html.match(/<script id="ask2gpt-initial-state"[^>]*>([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error("Provider HTML did not include the initial AppState");
  return match[1];
}

class FakeStore {
  readonly saved: Conversation[] = [];

  loadAll() {
    return Promise.resolve([] as Conversation[]);
  }

  getLoadReport(): ConversationStoreLoadReport {
    return {
      records: 0,
      recoveredFromBackup: 0,
      unreadable: 0,
      migrated: 0,
      repairFailures: 0,
      migrationFailures: 0,
    };
  }

  save(conversation: Conversation) {
    this.saved.push(structuredClone(conversation));
    return Promise.resolve();
  }

  delete() {
    return Promise.resolve();
  }
}

class FakeBackend implements ChatBackend {
  readonly sent: SendRequest[] = [];
  readonly prepared: Array<{ conversationId: string; remoteUrl?: string }> = [];
  readonly terminalAcknowledgements: Array<{
    conversationId: string;
    runId: string;
    eventId: string;
  }> = [];
  private listener?: (event: BackendEvent) => void;
  private readonly status: BackendStatus = {
    connected: true,
    authenticated: true,
    activeRuns: 0,
    selectorVersion: 1,
    project: { bound: true, name: "Ask2GPT" },
    connection: {
      phase: "ready",
      since: "2026-08-01T00:00:00.000Z",
      browserDetected: true,
      hasStoredTrust: true,
    },
  };

  getStatus() {
    return Promise.resolve(structuredClone(this.status));
  }

  prepareConversation(conversationId: string, remoteUrl?: string) {
    this.prepared.push({ conversationId, remoteUrl });
    return Promise.resolve();
  }

  settlePendingRemotePromotion(
    _conversationId: string,
    promotion: PendingRemotePromotion,
  ): Promise<ConversationCanonicalizationResultPayload> {
    return Promise.resolve({
      requestId: "full-story-canonicalization",
      runId: promotion.runId,
      fromRemoteUrl: promotion.fromRemoteUrl,
      terminalMarkdownSha256: promotion.terminalMarkdownSha256,
      terminalTranscriptSha256: promotion.terminalTranscriptSha256,
      status: "unchanged",
      remoteUrl: promotion.fromRemoteUrl,
    });
  }

  send(request: SendRequest) {
    this.sent.push(structuredClone(request));
    return Promise.resolve({
      conversationId: request.conversationId,
      runId: request.runId,
      startedAt: new Date().toISOString(),
    });
  }

  stop() {
    return Promise.resolve();
  }

  regenerate(conversationId: string, _messageId: string, runId: string) {
    return Promise.resolve({ conversationId, runId, startedAt: new Date().toISOString() });
  }

  listModels(): Promise<ChatModelOption[]> {
    return Promise.resolve([]);
  }

  selectModel(_conversationId: string, modelId: string): Promise<ChatModelOption> {
    return Promise.resolve({ id: modelId, label: modelId, selected: true });
  }

  closeConversation() {
    return Promise.resolve(true);
  }

  acknowledgeTerminal(conversationId: string, runId: string, eventId: string) {
    this.terminalAcknowledgements.push({ conversationId, runId, eventId });
    return Promise.resolve();
  }

  onEvent(listener: (event: BackendEvent) => void) {
    this.listener = listener;
    return { dispose: () => (this.listener = undefined) };
  }

  dispose() {
    return Promise.resolve();
  }

  emit(event: BackendEvent) {
    this.listener?.(event);
  }
}

function contextSnapshot(): ContextSnapshot {
  return {
    id: "full-story-context",
    kind: "selection",
    fileName: "example.ts",
    uri: "file:///example.ts",
    language: "typescript",
    startLine: 1,
    endLine: 1,
    content: "const answer = 42;",
    charCount: 18,
    unsaved: false,
  };
}

function installDomGlobals(window: TestWindow) {
  const globals: Record<string, unknown> = {
    window,
    self: window,
    document: window.document,
    navigator: window.navigator,
    Node: window.Node,
    Text: window.Text,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLButtonElement: window.HTMLButtonElement,
    SVGElement: window.SVGElement,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    Event: window.Event,
    MessageEvent: window.MessageEvent,
    CustomEvent: window.CustomEvent,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    FocusEvent: window.FocusEvent,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    vi.stubGlobal(key, value);
  }
}
