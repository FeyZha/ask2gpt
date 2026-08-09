import { CHROME_EXTENSION_ID, type RelayEnvelope } from "@ask2gpt/protocol";

import { CONTENT_RUNTIME_REVISION } from "../content-runtime-policy";

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | void;

type RegistrationTarget = { kind: "service-worker" } | { kind: "content"; tabId: number };

interface FakeTab {
  id: number;
  url: string;
  status: "loading" | "complete";
  active: boolean;
  discarded: boolean;
  frozen: boolean;
  autoDiscardable: boolean;
  windowId: number;
}

type BeforeTabMessage = (tabId: number, message: unknown) => Promise<void> | void;
type AfterTabMessage = (tabId: number, message: unknown, response: unknown) => Promise<void> | void;
type TabMessageLifecycle = "hidden" | "frozen" | "discarded";
type FakeWindowState = "normal" | "minimized";
interface FakeWindowBounds {
  height: number;
  left: number;
  top: number;
  width: number;
}

const FAKE_VISIBLE_SCREEN = { height: 1_080, left: 0, top: 0, width: 1_920 } as const;
const INVALID_WINDOW_BOUNDS_ERROR =
  "Invalid value for bounds. Bounds must be at least 50% within visible screen space.";

function windowBoundsAreAtLeastHalfVisible(bounds: FakeWindowBounds) {
  const intersectionWidth = Math.max(
    0,
    Math.min(bounds.left + bounds.width, FAKE_VISIBLE_SCREEN.left + FAKE_VISIBLE_SCREEN.width) -
      Math.max(bounds.left, FAKE_VISIBLE_SCREEN.left),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(bounds.top + bounds.height, FAKE_VISIBLE_SCREEN.top + FAKE_VISIBLE_SCREEN.height) -
      Math.max(bounds.top, FAKE_VISIBLE_SCREEN.top),
  );
  return intersectionWidth * intersectionHeight >= (bounds.width * bounds.height) / 2;
}
type DebuggerCommandHandler = (
  target: chrome.debugger.DebuggerSession,
  method: string,
  commandParams?: object,
) => unknown;

interface TabMessageResponseBarrier {
  entered(): void;
  lifecycle: TabMessageLifecycle;
  matches(message: unknown): boolean;
  release(): void;
  tabId: number;
  wait: Promise<void>;
}

interface TabGetBarrier {
  entered(): void;
  release(): void;
  tabId: number;
  wait: Promise<void>;
}

class FakeChromeEvent<Arguments extends unknown[]> {
  private readonly listeners = new Set<(...arguments_: Arguments) => void>();

  readonly addListener = (listener: (...arguments_: Arguments) => void) => {
    this.listeners.add(listener);
  };

  readonly removeListener = (listener: (...arguments_: Arguments) => void) => {
    this.listeners.delete(listener);
  };

  emit(...arguments_: Arguments) {
    for (const listener of [...this.listeners]) listener(...arguments_);
  }
}

type FakeSocketListener = (event: {
  type: string;
  data?: unknown;
  code?: number;
  reason?: string;
  wasClean?: boolean;
}) => void;

/** A browser-WebSocket double whose peer is the test's fake VS Code host. */
export class FakeRelayWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeRelayWebSocket[] = [];

  readonly url: string;
  readonly protocol: string;
  readyState = FakeRelayWebSocket.CONNECTING;
  readonly sent: string[] = [];
  closeCode?: number;
  closeReason?: string;
  onChromeEnvelope?: (envelope: RelayEnvelope) => void;
  private failNextEnvelopeType?: string;
  private readonly listeners = new Map<string, Set<FakeSocketListener>>();

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = String(url);
    this.protocol = Array.isArray(protocols) ? (protocols[0] ?? "") : (protocols ?? "");
    FakeRelayWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: FakeSocketListener) {
    const listeners = this.listeners.get(type) ?? new Set<FakeSocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: FakeSocketListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState !== FakeRelayWebSocket.OPEN) throw new Error("Fake socket is not open.");
    const serialized = typeof data === "string" ? data : String(data);
    const parsed = (() => {
      try {
        return JSON.parse(serialized) as RelayEnvelope;
      } catch {
        return undefined;
      }
    })();
    if (parsed && parsed.type === this.failNextEnvelopeType) {
      const failedType = parsed.type;
      this.failNextEnvelopeType = undefined;
      throw new Error(`Fake socket rejected ${failedType}.`);
    }
    this.sent.push(serialized);
    if (this.onChromeEnvelope) {
      try {
        this.onChromeEnvelope(parsed ?? (JSON.parse(serialized) as RelayEnvelope));
      } catch {
        // Invalid JSON remains visible in `sent` for the test to diagnose.
      }
    }
  }

  failNextSendOfType(type: string) {
    this.failNextEnvelopeType = type;
  }

  close(code = 1_000, reason = "") {
    if (this.readyState === FakeRelayWebSocket.CLOSED) return;
    this.readyState = FakeRelayWebSocket.CLOSED;
    this.closeCode = code;
    this.closeReason = reason;
    this.dispatch("close", undefined, { code, reason, wasClean: true });
  }

  open() {
    if (this.readyState !== FakeRelayWebSocket.CONNECTING) return;
    this.readyState = FakeRelayWebSocket.OPEN;
    this.dispatch("open");
  }

  deliverFromHost(envelope: RelayEnvelope) {
    if (this.readyState !== FakeRelayWebSocket.OPEN) throw new Error("Fake socket is not open.");
    this.dispatch("message", JSON.stringify(envelope));
  }

  envelopesFromChrome(): RelayEnvelope[] {
    return this.sent.flatMap((serialized) => {
      try {
        return [JSON.parse(serialized) as RelayEnvelope];
      } catch {
        return [];
      }
    });
  }

  private dispatch(
    type: string,
    data?: unknown,
    details: { code?: number; reason?: string; wasClean?: boolean } = {},
  ) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ type, ...(data === undefined ? {} : { data }), ...details });
    }
  }
}

/**
 * A deliberately small MV3 integration harness. It preserves the real
 * service-worker/content-script message boundary instead of invoking their
 * internal helpers directly.
 */
export class FakeChromeRelayHarness {
  private static activeHarness: FakeChromeRelayHarness | undefined;

  readonly timeline: string[] = [];
  readonly tabsById = new Map<number, FakeTab>();
  runtimeReloadCalls = 0;
  beforeTabMessage?: BeforeTabMessage;
  afterTabMessage?: AfterTabMessage;
  beforeTabReload?: (tabId: number) => void | Promise<void>;
  scriptInjectionHandler?: (
    tabId: number,
    files: readonly string[],
    world: string,
  ) => void | Promise<void>;
  debuggerCommandHandler?: DebuggerCommandHandler;
  private readonly tabRemoveFailures = new Map<number, number>();
  private failNextLocalStorageWrite = false;

  private readonly serviceWorkerRuntimeListeners = new Set<RuntimeListener>();
  private readonly contentRuntimeListeners = new Map<number, Set<RuntimeListener>>();
  private readonly runtimeOnStartup = new FakeChromeEvent<[]>();
  private readonly runtimeOnInstalled = new FakeChromeEvent<[]>();
  private readonly runtimeOnSuspend = new FakeChromeEvent<[]>();
  private readonly alarmOnAlarm = new FakeChromeEvent<[chrome.alarms.Alarm]>();
  private readonly tabsOnRemoved = new FakeChromeEvent<
    [number, { windowId: number; isWindowClosing: boolean }]
  >();
  private readonly tabsOnUpdated = new FakeChromeEvent<
    [number, Record<string, unknown>, chrome.tabs.Tab]
  >();
  private readonly tabsOnActivated = new FakeChromeEvent<[{ tabId: number; windowId: number }]>();
  private readonly windowsOnFocusChanged = new FakeChromeEvent<[number]>();
  private readonly debuggerOnEvent = new FakeChromeEvent<
    [chrome.debugger.DebuggerSession, string, object | undefined]
  >();
  private readonly debuggerOnDetach = new FakeChromeEvent<
    [chrome.debugger.Debuggee, chrome.debugger.DetachReason]
  >();
  private readonly debuggerAttachedTabs = new Set<number>();
  private readonly debuggerResponseBodies = new Map<
    string,
    { body: string; base64Encoded: boolean }
  >();
  private debuggerPermissionGranted = false;
  private readonly sessionStorage = new Map<string, unknown>();
  private readonly localStorage = new Map<string, unknown>();
  private readonly windowFocusById = new Map<number, boolean>();
  private readonly windowBoundsById = new Map<number, FakeWindowBounds>();
  private readonly windowStateById = new Map<number, FakeWindowState>();
  private readonly windowTypeById = new Map<number, "normal" | "popup">([[1, "normal"]]);
  private readonly existingWindowIds = new Set<number>([1]);
  private readonly implicitComposerReadinessDisabledTabs = new Set<number>();
  private readonly implicitConversationSnapshotDisabledTabs = new Set<number>();
  private readonly pendingTabMessageResponseBarriers = new Set<TabMessageResponseBarrier>();
  private nextTabMessageResponseBarrier?: TabMessageResponseBarrier;
  private nextTabGetBarrier?: TabGetBarrier;
  private nextSessionWriteBarrier?: {
    entered(): void;
    wait: Promise<void>;
    matches(values: Record<string, unknown>): boolean;
  };
  private registrationTarget?: RegistrationTarget;
  private nextTabId = 41;
  private nextWindowId = 2;
  private primaryContentTabId?: number;
  private runtimeSenderUrlOverride?: string;

  installGlobals() {
    FakeChromeRelayHarness.suspendActive();
    FakeChromeRelayHarness.activeHarness = this;
    FakeRelayWebSocket.instances.length = 0;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: FakeRelayWebSocket,
    });
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      writable: true,
      value: this.chromeApi,
    });
  }

  static suspendActive() {
    const active = FakeChromeRelayHarness.activeHarness;
    FakeChromeRelayHarness.activeHarness = undefined;
    active?.releaseAllTabMessageResponses();
    active?.runtimeOnSuspend.emit();
  }

  async importServiceWorker(importer: () => Promise<unknown>) {
    this.registrationTarget = { kind: "service-worker" };
    try {
      await importer();
    } finally {
      this.registrationTarget = undefined;
    }
  }

  async importContentScript(tabId: number, importer: () => Promise<unknown>) {
    if (!this.tabsById.has(tabId)) throw new Error(`Unknown fake tab ${tabId}.`);
    this.primaryContentTabId = tabId;
    this.registrationTarget = { kind: "content", tabId };
    try {
      await importer();
    } finally {
      this.registrationTarget = undefined;
    }
  }

  installTabMessageResponder(tabId: number, responder: (message: unknown) => unknown) {
    if (!this.tabsById.has(tabId)) throw new Error(`Unknown fake tab ${tabId}.`);
    const listeners = this.contentRuntimeListeners.get(tabId) ?? new Set<RuntimeListener>();
    listeners.add((message, _sender, sendResponse) => {
      void Promise.resolve(responder(message)).then((response) =>
        sendResponse(normalizeCurrentContentInspectFixture(message, response)),
      );
      return true;
    });
    this.contentRuntimeListeners.set(tabId, listeners);
  }

  /**
   * Narrow relay fixtures return `{ ok:false }` for commands outside their
   * scenario. Disable this compatibility response in tests that explicitly
   * exercise a missing or outdated composer runtime.
   */
  disableImplicitComposerReadiness(tabId: number) {
    if (!this.tabsById.has(tabId)) throw new Error(`Unknown fake tab ${tabId}.`);
    this.implicitComposerReadinessDisabledTabs.add(tabId);
  }

  /**
   * Disable the stable empty snapshot supplied for narrow transport fixtures.
   * Security tests use this to exercise an unavailable pre-send transcript.
   */
  disableImplicitConversationSnapshot(tabId: number) {
    if (!this.tabsById.has(tabId)) throw new Error(`Unknown fake tab ${tabId}.`);
    this.implicitConversationSnapshotDisabledTabs.add(tabId);
  }

  socketForPort(port = 32_171) {
    const socket = FakeRelayWebSocket.instances.find(
      (candidate) => new URL(candidate.url).port === String(port),
    );
    if (!socket) throw new Error(`No fake relay socket was created for port ${port}.`);
    return socket;
  }

  async waitForSocket(port = 32_171) {
    await waitUntil(() =>
      FakeRelayWebSocket.instances.some(
        (candidate) => new URL(candidate.url).port === String(port),
      ),
    );
    return this.socketForPort(port);
  }

  async waitForCreatedTab(index = 0) {
    await waitUntil(() => this.tabsById.size > index);
    return [...this.tabsById.values()][index]!;
  }

  async sendPopupMessage(message: unknown) {
    return await invokeRuntimeListeners([...this.serviceWorkerRuntimeListeners], message, {
      id: CHROME_EXTENSION_ID,
      url: `chrome-extension://${CHROME_EXTENSION_ID}/popup.html`,
    });
  }

  socketsForPort(port = 32_171) {
    return FakeRelayWebSocket.instances.filter(
      (candidate) => new URL(candidate.url).port === String(port),
    );
  }

  setTabUrl(tabId: number, url: string) {
    const tab = this.requireTab(tabId);
    tab.url = url;
    tab.status = "complete";
    this.timeline.push(`tab-state:${tabId}:${url}`);
  }

  setRuntimeSenderUrlOverride(url: string | undefined) {
    this.runtimeSenderUrlOverride = url;
  }

  setTabFrozen(tabId: number, frozen: boolean) {
    const tab = this.requireTab(tabId);
    tab.frozen = frozen;
    this.timeline.push(`tab-frozen:${tabId}:${frozen}`);
    this.tabsOnUpdated.emit(tabId, { frozen }, this.cloneTab(tab));
    this.releaseRestoredTabMessageResponses(tabId);
  }

  setTabDiscarded(tabId: number, discarded: boolean) {
    const tab = this.requireTab(tabId);
    tab.discarded = discarded;
    this.timeline.push(`tab-discarded:${tabId}:${discarded}`);
    this.tabsOnUpdated.emit(tabId, { discarded }, this.cloneTab(tab));
    this.releaseRestoredTabMessageResponses(tabId);
  }

  setTabHidden(tabId: number, hidden: boolean) {
    const tab = this.requireTab(tabId);
    if (hidden) {
      tab.active = false;
    } else {
      for (const candidate of this.tabsById.values()) {
        if (candidate.windowId === tab.windowId) candidate.active = candidate.id === tabId;
      }
      this.tabsOnActivated.emit({ tabId, windowId: tab.windowId });
    }
    this.timeline.push(`tab-hidden:${tabId}:${hidden}`);
    this.releaseRestoredTabMessageResponses(tabId);
  }

  setWindowFocused(windowId: number, focused: boolean) {
    this.existingWindowIds.add(windowId);
    this.windowFocusById.set(windowId, focused);
    this.timeline.push(`window-state:${windowId}:focused:${String(focused)}`);
    this.windowsOnFocusChanged.emit(focused ? windowId : -1);
  }

  setWindowState(windowId: number, state: FakeWindowState) {
    this.existingWindowIds.add(windowId);
    this.windowStateById.set(windowId, state);
    this.timeline.push(`window-state:${windowId}:state:${state}`);
  }

  windowBounds(windowId: number): FakeWindowBounds {
    return {
      ...(this.windowBoundsById.get(windowId) ?? {
        height: 900,
        left: 100,
        top: 100,
        width: 1_200,
      }),
    };
  }

  failNextTabRemovals(tabId: number, count = 1) {
    this.requireTab(tabId);
    this.tabRemoveFailures.set(tabId, Math.max(1, count));
  }

  failNextLocalWrite() {
    this.failNextLocalStorageWrite = true;
  }

  invalidateContentRuntime(tabId: number) {
    this.requireTab(tabId);
    this.contentRuntimeListeners.delete(tabId);
  }

  setPrimaryDocumentUrl(url: string) {
    if (this.primaryContentTabId === undefined) {
      throw new Error("No primary content-script tab is installed.");
    }
    window.history.pushState({}, "", url);
    this.timeline.push(`document-url:${this.primaryContentTabId}:${url}`);
  }

  emitTabUrlUpdated(tabId: number, url: string) {
    this.timeline.push(`tabs.onUpdated:${tabId}:${url}`);
    this.tabsOnUpdated.emit(tabId, { url }, this.cloneTab(this.requireTab(tabId)));
  }

  emitTabLoadComplete(tabId: number) {
    this.timeline.push(`tabs.onUpdated:${tabId}:complete`);
    this.tabsOnUpdated.emit(tabId, { status: "complete" }, this.cloneTab(this.requireTab(tabId)));
  }

  emitTabActivated(tabId: number) {
    const tab = this.requireTab(tabId);
    for (const candidate of this.tabsById.values()) {
      if (candidate.windowId === tab.windowId) candidate.active = candidate.id === tabId;
    }
    this.timeline.push(`tabs.onActivated:${tabId}:${tab.url}`);
    this.tabsOnActivated.emit({ tabId, windowId: tab.windowId });
    this.releaseRestoredTabMessageResponses(tabId);
  }

  emitAlarm(name: string) {
    this.timeline.push(`alarms.onAlarm:${name}`);
    this.alarmOnAlarm.emit({ name, scheduledTime: Date.now() });
  }

  outboundEnvelopes(socket: FakeRelayWebSocket) {
    return socket.envelopesFromChrome();
  }

  sessionValue(key: string) {
    const value = this.sessionStorage.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  seedSessionValue(key: string, value: unknown) {
    this.sessionStorage.set(key, structuredClone(value));
  }

  pauseNextSessionWrite(matches: (values: Record<string, unknown>) => boolean = () => true) {
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextSessionWriteBarrier = { entered: markEntered, wait, matches };
    return { entered, release };
  }

  pauseNextTabGet(tabId: number) {
    this.requireTab(tabId);
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextTabGetBarrier = { entered: markEntered, release, tabId, wait };
    return { entered, release };
  }

  pauseNextTabMessageResponseWhile(
    tabId: number,
    lifecycle: TabMessageLifecycle,
    matches: (message: unknown) => boolean = () => true,
  ) {
    this.requireTab(tabId);
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier: TabMessageResponseBarrier = {
      entered: markEntered,
      lifecycle,
      matches,
      release,
      tabId,
      wait,
    };
    this.nextTabMessageResponseBarrier = barrier;
    return {
      entered,
      resume: () => this.releaseTabMessageResponseBarrier(barrier),
    };
  }

  localValue(key: string) {
    const value = this.localStorage.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  seedLocalValue(key: string, value: unknown) {
    this.localStorage.set(key, structuredClone(value));
  }

  setDebuggerPermission(granted: boolean) {
    this.debuggerPermissionGranted = granted;
  }

  setDebuggerResponseBody(requestId: string, body: string, base64Encoded = false) {
    this.debuggerResponseBodies.set(requestId, { body, base64Encoded });
  }

  emitDebuggerEvent(tabId: number, method: string, params?: object, sessionId?: string) {
    if (!this.debuggerAttachedTabs.has(tabId)) {
      throw new Error(`Fake debugger is not attached to tab ${tabId}.`);
    }
    this.debuggerOnEvent.emit({ tabId, ...(sessionId ? { sessionId } : {}) }, method, params);
  }

  async waitForEnvelope(
    socket: FakeRelayWebSocket,
    predicate: (envelope: RelayEnvelope) => boolean,
    timeoutMs = 8_000,
  ) {
    let match: RelayEnvelope | undefined;
    try {
      await waitUntil(() => {
        match = socket.envelopesFromChrome().find(predicate);
        return match !== undefined;
      }, timeoutMs);
    } catch {
      throw new Error(
        `Timed out waiting for relay envelope. Timeline: ${JSON.stringify(this.timeline)}; envelopes: ${JSON.stringify(socket.envelopesFromChrome())}`,
      );
    }
    return match!;
  }

  private readonly chromeApi = {
    runtime: {
      id: CHROME_EXTENSION_ID,
      getManifest: () => ({ version: "0.0.1" }),
      getURL: (path: string) => `chrome-extension://${CHROME_EXTENSION_ID}/${path}`,
      reload: () => {
        this.runtimeReloadCalls += 1;
      },
      onStartup: this.runtimeOnStartup,
      onInstalled: this.runtimeOnInstalled,
      onSuspend: this.runtimeOnSuspend,
      onMessage: {
        addListener: (listener: RuntimeListener) => {
          const target = this.registrationTarget;
          if (!target)
            throw new Error("Runtime listener registered outside a fake extension realm.");
          if (target.kind === "service-worker") {
            this.serviceWorkerRuntimeListeners.add(listener);
            return;
          }
          const listeners =
            this.contentRuntimeListeners.get(target.tabId) ?? new Set<RuntimeListener>();
          listeners.add(listener);
          this.contentRuntimeListeners.set(target.tabId, listeners);
        },
      },
      sendMessage: async (message: unknown) => {
        const tabId = this.primaryContentTabId;
        if (tabId === undefined) throw new Error("No content-script sender is installed.");
        const tab = this.requireTab(tabId);
        this.timeline.push(runtimeTimelineLabel(message, tab.url));
        const sender: chrome.runtime.MessageSender = {
          id: CHROME_EXTENSION_ID,
          frameId: 0,
          url: this.runtimeSenderUrlOverride ?? tab.url,
          tab: this.cloneTab(tab),
        };
        return await invokeRuntimeListeners(
          [...this.serviceWorkerRuntimeListeners],
          message,
          sender,
        );
      },
    },
    storage: {
      session: {
        get: async (keys: string | string[]) => {
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            requested.flatMap((key) =>
              this.sessionStorage.has(key)
                ? [[key, structuredClone(this.sessionStorage.get(key))]]
                : [],
            ),
          );
        },
        set: async (values: Record<string, unknown>) => {
          const barrier = this.nextSessionWriteBarrier;
          if (barrier?.matches(values)) {
            this.nextSessionWriteBarrier = undefined;
            barrier.entered();
            await barrier.wait;
          }
          for (const [key, value] of Object.entries(values)) {
            this.sessionStorage.set(key, structuredClone(value));
          }
        },
        remove: async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) this.sessionStorage.delete(key);
        },
      },
      local: {
        get: async (keys: string | string[]) => {
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            requested.flatMap((key) =>
              this.localStorage.has(key)
                ? [[key, structuredClone(this.localStorage.get(key))]]
                : [],
            ),
          );
        },
        set: async (values: Record<string, unknown>) => {
          if (this.failNextLocalStorageWrite) {
            this.failNextLocalStorageWrite = false;
            throw new Error("Fake Chrome rejected a local storage write.");
          }
          for (const [key, value] of Object.entries(values)) {
            this.localStorage.set(key, structuredClone(value));
          }
        },
        remove: async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) this.localStorage.delete(key);
        },
      },
    },
    alarms: {
      create: async (_name: string, _alarmInfo: chrome.alarms.AlarmCreateInfo) => undefined,
      onAlarm: this.alarmOnAlarm,
    },
    permissions: {
      contains: async (request: chrome.permissions.Permissions) =>
        !request.permissions?.includes("debugger") || this.debuggerPermissionGranted,
      request: async (request: chrome.permissions.Permissions) => {
        if (request.permissions?.includes("debugger")) this.debuggerPermissionGranted = true;
        return true;
      },
      remove: async (request: chrome.permissions.Permissions) => {
        if (request.permissions?.includes("debugger")) this.debuggerPermissionGranted = false;
        return true;
      },
    },
    scripting: {
      executeScript: async (injection: {
        target: { tabId: number };
        files?: string[];
        func?: (...args: unknown[]) => unknown;
        args?: unknown[];
        world?: chrome.scripting.ExecutionWorld;
      }) => {
        const tabId = injection.target.tabId;
        const files = injection.files ?? [];
        const world = String(injection.world ?? "ISOLATED");
        const source = files.length > 0 ? files.join(",") : (injection.func?.name ?? "inline");
        this.timeline.push(`scripting.executeScript:${tabId}:${world}:${source}`);
        await this.scriptInjectionHandler?.(tabId, files, world);
        if (injection.func) {
          const result = await injection.func(...(injection.args ?? []));
          return [{ frameId: 0, result }];
        }
        return [];
      },
    },
    debugger: {
      onEvent: this.debuggerOnEvent,
      onDetach: this.debuggerOnDetach,
      attach: async (target: chrome.debugger.Debuggee) => {
        if (!this.debuggerPermissionGranted || target.tabId === undefined) {
          throw new Error("Fake debugger permission denied.");
        }
        if (this.debuggerAttachedTabs.has(target.tabId)) {
          throw new Error("Fake debugger already attached.");
        }
        this.debuggerAttachedTabs.add(target.tabId);
        this.timeline.push(`debugger.attach:${target.tabId}`);
      },
      detach: async (target: chrome.debugger.Debuggee) => {
        if (target.tabId === undefined || !this.debuggerAttachedTabs.delete(target.tabId)) return;
        this.timeline.push(`debugger.detach:${target.tabId}`);
        this.debuggerOnDetach.emit(target, "target_closed" as chrome.debugger.DetachReason);
      },
      sendCommand: async (
        target: chrome.debugger.DebuggerSession,
        method: string,
        commandParams?: object,
      ) => {
        if (target.tabId === undefined || !this.debuggerAttachedTabs.has(target.tabId)) {
          throw new Error("Fake debugger is not attached.");
        }
        this.timeline.push(`debugger.command:${target.tabId}:${method}`);
        this.timeline.push(
          `debugger.command-target:${target.tabId}:${target.sessionId ?? "root"}:${method}`,
        );
        if (this.debuggerCommandHandler) {
          const customResponse = await this.debuggerCommandHandler(target, method, commandParams);
          if (customResponse !== undefined) return customResponse;
        }
        if (method === "Target.getTargetInfo") {
          return { targetInfo: { targetId: `tab-${target.tabId}` } };
        }
        if (
          method === "Input.dispatchMouseEvent" &&
          isRecord(commandParams) &&
          commandParams.type === "mouseReleased" &&
          typeof document !== "undefined"
        ) {
          const markedButtons = [
            ...document.querySelectorAll<HTMLButtonElement>("[data-ask2gpt-main-world-send]"),
          ];
          if (markedButtons.length === 1) markedButtons[0]!.click();
          return {};
        }
        if (method !== "Network.getResponseBody") return {};
        const requestId = isRecord(commandParams) ? commandParams.requestId : undefined;
        if (typeof requestId !== "string") throw new Error("Missing fake request id.");
        const response = this.debuggerResponseBodies.get(requestId);
        if (!response) throw new Error(`Missing fake response body for ${requestId}.`);
        return response;
      },
    },
    tabs: {
      onRemoved: this.tabsOnRemoved,
      onUpdated: this.tabsOnUpdated,
      onActivated: this.tabsOnActivated,
      create: async (properties: chrome.tabs.CreateProperties) => {
        const id = this.nextTabId++;
        const windowId = properties.windowId ?? 1;
        this.existingWindowIds.add(windowId);
        if (properties.active === true) {
          for (const candidate of this.tabsById.values()) {
            if (candidate.windowId === windowId) candidate.active = false;
          }
        }
        const tab: FakeTab = {
          id,
          url: String(properties.url ?? "about:blank"),
          status: "complete",
          active: properties.active === true,
          discarded: false,
          frozen: false,
          autoDiscardable: true,
          windowId,
        };
        this.tabsById.set(id, tab);
        this.timeline.push(`tab-created:${id}:${tab.url}`);
        return this.cloneTab(tab);
      },
      query: async (queryInfo: chrome.tabs.QueryInfo) =>
        [...this.tabsById.values()]
          .filter((tab) => {
            if (queryInfo.active !== undefined && tab.active !== queryInfo.active) return false;
            if (queryInfo.currentWindow === true && tab.windowId !== 1) return false;
            if (queryInfo.windowId !== undefined && tab.windowId !== queryInfo.windowId)
              return false;
            if (queryInfo.url !== undefined) {
              const patterns = Array.isArray(queryInfo.url) ? queryInfo.url : [queryInfo.url];
              if (!patterns.some((pattern) => fakeUrlPatternMatches(String(pattern), tab.url))) {
                return false;
              }
            }
            return true;
          })
          .map((tab) => this.cloneTab(tab)),
      get: async (tabId: number) => {
        const barrier = this.nextTabGetBarrier;
        if (barrier?.tabId === tabId) {
          this.nextTabGetBarrier = undefined;
          this.timeline.push(`tabs.get:suspended:${tabId}`);
          barrier.entered();
          await barrier.wait;
          this.timeline.push(`tabs.get:resumed:${tabId}`);
        }
        return this.cloneTab(this.requireTab(tabId));
      },
      update: async (tabId: number, properties: chrome.tabs.UpdateProperties) => {
        const tab = this.requireTab(tabId);
        if (properties.url !== undefined) {
          tab.url = String(properties.url);
          tab.status = "complete";
          if (this.primaryContentTabId === tabId) window.history.pushState({}, "", tab.url);
          this.tabsOnUpdated.emit(tabId, { url: tab.url }, this.cloneTab(tab));
        }
        if (properties.active !== undefined) {
          if (properties.active) {
            for (const candidate of this.tabsById.values()) {
              if (candidate.windowId === tab.windowId) candidate.active = false;
            }
            tab.active = true;
            const wasFrozen = tab.frozen;
            const wasDiscarded = tab.discarded;
            tab.frozen = false;
            tab.discarded = false;
            this.tabsOnActivated.emit({ tabId, windowId: tab.windowId });
            if (wasFrozen) {
              this.tabsOnUpdated.emit(tabId, { frozen: false }, this.cloneTab(tab));
            }
            if (wasDiscarded) {
              this.tabsOnUpdated.emit(tabId, { discarded: false }, this.cloneTab(tab));
            }
            this.releaseRestoredTabMessageResponses(tabId);
          } else {
            tab.active = false;
          }
          this.timeline.push(`tab-active:${tabId}:${String(properties.active)}`);
        }
        if (properties.autoDiscardable !== undefined) {
          tab.autoDiscardable = properties.autoDiscardable;
          this.timeline.push(`tab-auto-discardable:${tabId}:${String(properties.autoDiscardable)}`);
        }
        return this.cloneTab(tab);
      },
      move: async (tabId: number, moveProperties: chrome.tabs.MoveProperties) => {
        const tab = this.requireTab(tabId);
        const previousWindowId = tab.windowId;
        const nextWindowId = moveProperties.windowId ?? previousWindowId;
        this.existingWindowIds.add(nextWindowId);
        if (tab.active) {
          const fallback = [...this.tabsById.values()].find(
            (candidate) => candidate.windowId === previousWindowId && candidate.id !== tabId,
          );
          if (fallback) fallback.active = true;
        }
        tab.windowId = nextWindowId;
        tab.active = ![...this.tabsById.values()].some(
          (candidate) =>
            candidate.id !== tabId && candidate.windowId === nextWindowId && candidate.active,
        );
        this.timeline.push(`tab-moved:${tabId}:${previousWindowId}:${nextWindowId}`);
        if (tab.active) this.tabsOnActivated.emit({ tabId, windowId: nextWindowId });
        return this.cloneTab(tab);
      },
      reload: async (tabId: number) => {
        const tab = this.requireTab(tabId);
        this.timeline.push(`tabs.reload:${tabId}`);
        await this.beforeTabReload?.(tabId);
        tab.discarded = false;
        tab.status = "complete";
        this.tabsOnUpdated.emit(tabId, { status: "complete" }, this.cloneTab(tab));
        this.releaseRestoredTabMessageResponses(tabId);
      },
      remove: async (tabId: number) => {
        const failuresRemaining = this.tabRemoveFailures.get(tabId) ?? 0;
        if (failuresRemaining > 0) {
          if (failuresRemaining === 1) this.tabRemoveFailures.delete(tabId);
          else this.tabRemoveFailures.set(tabId, failuresRemaining - 1);
          throw new Error(`Fake Chrome refused to close tab ${tabId}.`);
        }
        const removed = this.tabsById.get(tabId);
        if (!removed || !this.tabsById.delete(tabId)) return;
        if (removed.active) {
          const fallback = [...this.tabsById.values()].find(
            (candidate) => candidate.windowId === removed.windowId,
          );
          if (fallback) fallback.active = true;
        }
        this.contentRuntimeListeners.delete(tabId);
        this.implicitComposerReadinessDisabledTabs.delete(tabId);
        this.implicitConversationSnapshotDisabledTabs.delete(tabId);
        this.tabsOnRemoved.emit(tabId, { windowId: removed.windowId, isWindowClosing: false });
        this.releaseRestoredTabMessageResponses(tabId);
      },
      sendMessage: async (tabId: number, message: unknown) => {
        await this.beforeTabMessage?.(tabId, message);
        const listeners = [...(this.contentRuntimeListeners.get(tabId) ?? [])];
        if (listeners.length === 0) throw new Error("Could not establish connection to tab.");
        this.timeline.push(tabMessageTimelineLabel(tabId, message, "request"));
        let response = await invokeRuntimeListeners(listeners, message, {
          id: CHROME_EXTENSION_ID,
        });
        if (
          messageType(message) === "content.composerStatus" &&
          !this.implicitComposerReadinessDisabledTabs.has(tabId) &&
          isRecord(response) &&
          response.ok === false
        ) {
          const tab = this.requireTab(tabId);
          const visible = tab.active;
          response = {
            ok: true,
            ready: visible,
            rawCandidateCount: visible ? 1 : 0,
            readyCandidateCount: visible ? 1 : 0,
            visibilityState: visible ? "visible" : "hidden",
            selectorVersion: CONTENT_RUNTIME_REVISION,
          };
        }
        if (
          messageType(message) === "content.inspectConversation" &&
          !this.implicitConversationSnapshotDisabledTabs.has(tabId) &&
          isRecord(response) &&
          response.ok === false
        ) {
          const tab = this.requireTab(tabId);
          if (isChatGptConversationSurface(tab.url)) {
            response = {
              ok: true,
              remoteUrl: tab.url,
              complete: true,
              historyComplete: true,
              messages: [],
              observedAt: new Date().toISOString(),
              selectorVersion: CONTENT_RUNTIME_REVISION,
            };
          }
        }
        await this.pauseTabMessageResponseIfNeeded(tabId, message);
        await this.afterTabMessage?.(tabId, message, response);
        this.timeline.push(tabMessageTimelineLabel(tabId, message, "response"));
        return response;
      },
    },
    windows: {
      onFocusChanged: this.windowsOnFocusChanged,
      create: async (createData: chrome.windows.CreateData) => {
        if (createData.tabId !== undefined && createData.type === "popup") {
          throw new Error("Tabs can only be moved to and from normal windows.");
        }
        const bounds = {
          height: createData.height ?? 900,
          left: createData.left ?? 100,
          top: createData.top ?? 100,
          width: createData.width ?? 1_200,
        };
        if (!windowBoundsAreAtLeastHalfVisible(bounds)) {
          throw new Error(INVALID_WINDOW_BOUNDS_ERROR);
        }
        const windowId = this.nextWindowId++;
        this.existingWindowIds.add(windowId);
        this.windowFocusById.set(windowId, createData.focused ?? true);
        this.windowStateById.set(
          windowId,
          createData.state === "minimized" ? "minimized" : "normal",
        );
        this.windowTypeById.set(windowId, createData.type === "popup" ? "popup" : "normal");
        this.windowBoundsById.set(windowId, bounds);
        let movedTab: FakeTab | undefined;
        if (createData.tabId !== undefined) {
          movedTab = this.requireTab(createData.tabId);
          const previousWindowId = movedTab.windowId;
          if (movedTab.active) {
            const fallback = [...this.tabsById.values()].find(
              (candidate) =>
                candidate.windowId === previousWindowId && candidate.id !== movedTab?.id,
            );
            if (fallback) fallback.active = true;
          }
          for (const candidate of this.tabsById.values()) {
            if (candidate.windowId === windowId) candidate.active = false;
          }
          movedTab.windowId = windowId;
          movedTab.active = true;
          this.timeline.push(`tab-moved:${movedTab.id}:${previousWindowId}:${windowId}`);
        }
        this.timeline.push(
          `window-created:${windowId}:tab:${String(createData.tabId)}:bounds:${bounds.left},${bounds.top},${bounds.width},${bounds.height}:focused:${String(createData.focused ?? true)}`,
        );
        if (movedTab) this.tabsOnActivated.emit({ tabId: movedTab.id, windowId });
        return {
          id: windowId,
          focused: this.windowFocusById.get(windowId) ?? true,
          state: this.windowStateById.get(windowId) ?? "normal",
          ...this.windowBounds(windowId),
          alwaysOnTop: false,
          incognito: false,
          tabs: movedTab ? [this.cloneTab(movedTab)] : [],
          type: this.windowTypeById.get(windowId) ?? "normal",
        };
      },
      get: async (windowId: number) => {
        if (!this.existingWindowIds.has(windowId))
          throw new Error(`Unknown fake window ${windowId}.`);
        return {
          id: windowId,
          focused: this.windowFocusById.get(windowId) ?? true,
          state: this.windowStateById.get(windowId) ?? "normal",
          ...this.windowBounds(windowId),
          alwaysOnTop: false,
          incognito: false,
          type: this.windowTypeById.get(windowId) ?? "normal",
        };
      },
      update: async (windowId: number, updateInfo: chrome.windows.UpdateInfo) => {
        if (!this.existingWindowIds.has(windowId))
          throw new Error(`Unknown fake window ${windowId}.`);
        const hasBounds = [
          updateInfo.left,
          updateInfo.top,
          updateInfo.width,
          updateInfo.height,
        ].some((value) => value !== undefined);
        if (hasBounds && updateInfo.state !== undefined && updateInfo.state !== "normal") {
          throw new Error("Fake Chrome rejects minimized state combined with window bounds.");
        }
        const currentBounds = this.windowBounds(windowId);
        const nextBounds = {
          height: updateInfo.height ?? currentBounds.height,
          left: updateInfo.left ?? currentBounds.left,
          top: updateInfo.top ?? currentBounds.top,
          width: updateInfo.width ?? currentBounds.width,
        };
        if (hasBounds && !windowBoundsAreAtLeastHalfVisible(nextBounds)) {
          throw new Error(INVALID_WINDOW_BOUNDS_ERROR);
        }
        this.timeline.push(`window-updated:${windowId}:focused:${String(updateInfo.focused)}`);
        if (updateInfo.focused !== undefined) {
          this.windowFocusById.set(windowId, updateInfo.focused);
          this.windowsOnFocusChanged.emit(updateInfo.focused ? windowId : -1);
        }
        if (updateInfo.state !== undefined) {
          if (updateInfo.state !== "normal" && updateInfo.state !== "minimized") {
            throw new Error(`Unsupported fake window state: ${updateInfo.state}`);
          }
          this.windowStateById.set(windowId, updateInfo.state);
          this.timeline.push(`window-updated:${windowId}:state:${updateInfo.state}`);
        }
        if (hasBounds) {
          this.windowBoundsById.set(windowId, nextBounds);
          this.timeline.push(
            `window-updated:${windowId}:bounds:${nextBounds.left},${nextBounds.top},${nextBounds.width},${nextBounds.height}`,
          );
        }
        return {
          id: windowId,
          focused: this.windowFocusById.get(windowId) ?? true,
          state: this.windowStateById.get(windowId) ?? "normal",
          ...this.windowBounds(windowId),
          alwaysOnTop: false,
          incognito: false,
          type: this.windowTypeById.get(windowId) ?? "normal",
        };
      },
      remove: async (windowId: number) => {
        if (!this.existingWindowIds.delete(windowId)) return;
        for (const tab of [...this.tabsById.values()]) {
          if (tab.windowId !== windowId) continue;
          this.tabsById.delete(tab.id);
          this.tabsOnRemoved.emit(tab.id, { windowId, isWindowClosing: true });
        }
        this.windowFocusById.delete(windowId);
        this.windowStateById.delete(windowId);
        this.windowTypeById.delete(windowId);
        this.windowBoundsById.delete(windowId);
        this.timeline.push(`window-removed:${windowId}`);
      },
    },
  } as unknown as typeof chrome;

  private requireTab(tabId: number) {
    const tab = this.tabsById.get(tabId);
    if (!tab) throw new Error(`Unknown fake tab ${tabId}.`);
    return tab;
  }

  private async pauseTabMessageResponseIfNeeded(tabId: number, message: unknown) {
    const barrier = this.nextTabMessageResponseBarrier;
    if (
      !barrier ||
      barrier.tabId !== tabId ||
      !barrier.matches(message) ||
      !tabMatchesLifecycle(this.requireTab(tabId), barrier.lifecycle)
    ) {
      return;
    }
    this.nextTabMessageResponseBarrier = undefined;
    this.pendingTabMessageResponseBarriers.add(barrier);
    this.timeline.push(
      tabMessageLifecycleTimelineLabel(tabId, message, "suspended", barrier.lifecycle),
    );
    barrier.entered();
    await barrier.wait;
    this.pendingTabMessageResponseBarriers.delete(barrier);
    this.timeline.push(
      tabMessageLifecycleTimelineLabel(tabId, message, "resumed", barrier.lifecycle),
    );
  }

  private releaseRestoredTabMessageResponses(tabId: number) {
    const tab = this.tabsById.get(tabId);
    for (const barrier of [...this.pendingTabMessageResponseBarriers]) {
      if (barrier.tabId === tabId && (!tab || !tabMatchesLifecycle(tab, barrier.lifecycle))) {
        this.releaseTabMessageResponseBarrier(barrier);
      }
    }
  }

  private releaseTabMessageResponseBarrier(barrier: TabMessageResponseBarrier) {
    if (this.nextTabMessageResponseBarrier === barrier) {
      this.nextTabMessageResponseBarrier = undefined;
    }
    this.pendingTabMessageResponseBarriers.delete(barrier);
    barrier.release();
  }

  private releaseAllTabMessageResponses() {
    const barriers = [
      ...this.pendingTabMessageResponseBarriers,
      ...(this.nextTabMessageResponseBarrier ? [this.nextTabMessageResponseBarrier] : []),
    ];
    this.nextTabMessageResponseBarrier = undefined;
    this.pendingTabMessageResponseBarriers.clear();
    for (const barrier of barriers) barrier.release();
    this.nextTabGetBarrier?.release();
    this.nextTabGetBarrier = undefined;
  }

  private cloneTab(tab: FakeTab): chrome.tabs.Tab {
    return {
      id: tab.id,
      index: 0,
      pinned: false,
      highlighted: tab.active,
      active: tab.active,
      incognito: false,
      selected: tab.active,
      discarded: tab.discarded,
      autoDiscardable: tab.autoDiscardable,
      frozen: tab.frozen,
      windowId: tab.windowId,
      groupId: -1,
      url: tab.url,
      ...(tab.status === "loading" ? { pendingUrl: tab.url } : {}),
      status: tab.status,
    };
  }
}

function normalizeCurrentContentInspectFixture(message: unknown, response: unknown) {
  if (
    messageType(message) !== "content.inspectConversation" ||
    !isRecord(response) ||
    response.ok !== true ||
    response.selectorVersion !== CONTENT_RUNTIME_REVISION ||
    !Array.isArray(response.messages) ||
    typeof response.remoteUrl !== "string" ||
    typeof response.complete !== "boolean"
  ) {
    return response;
  }
  // Hand-written integration responders created before the current content
  // snapshot contract omitted these two fields. Real revision-16 content
  // always emits both; normalize only current-runtime fake responses so tests
  // exercise the production fail-closed baseline gate instead of stale mocks.
  return {
    ...response,
    ...(response.historyComplete === undefined ? { historyComplete: true } : {}),
    ...(response.observedAt === undefined ? { observedAt: new Date().toISOString() } : {}),
  };
}

function isChatGptConversationSurface(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com") return false;
    const segments = url.pathname.split("/").filter(Boolean);
    return (
      (segments[0] === "c" && segments.length === 2) ||
      (segments[0] === "g" && segments[2] === "project" && segments.length === 3) ||
      (segments[0] === "g" && segments[2] === "c" && segments.length === 4)
    );
  } catch {
    return false;
  }
}

async function invokeRuntimeListeners(
  listeners: RuntimeListener[],
  message: unknown,
  sender: chrome.runtime.MessageSender,
) {
  if (listeners.length === 0) throw new Error("No fake runtime listener accepted the message.");
  for (const listener of listeners) {
    const result = await new Promise<{ accepted: boolean; response?: unknown }>(
      (resolve, reject) => {
        let responseSent = false;
        const sendResponse = (response?: unknown) => {
          if (responseSent) return;
          responseSent = true;
          resolve({ accepted: true, response });
        };
        try {
          const asynchronous = listener(message, sender, sendResponse);
          if (asynchronous !== true && !responseSent) resolve({ accepted: false });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    );
    if (result.accepted) return result.response;
  }
  throw new Error("No fake runtime listener accepted the message.");
}

function runtimeTimelineLabel(message: unknown, tabUrl: string) {
  if (isRecord(message) && message.type === "content.event") {
    return `runtime.content-event:${String(message.eventType)}:${String(message.conversationId)}:${tabUrl}`;
  }
  return `runtime.message:${messageType(message)}:${tabUrl}`;
}

function tabMessageTimelineLabel(tabId: number, message: unknown, phase: "request" | "response") {
  return `tabs.sendMessage:${phase}:${tabId}:${messageType(message)}`;
}

function tabMessageLifecycleTimelineLabel(
  tabId: number,
  message: unknown,
  phase: "suspended" | "resumed",
  lifecycle: TabMessageLifecycle,
) {
  return `tabs.sendMessage:${phase}:${tabId}:${messageType(message)}:${lifecycle}`;
}

function tabMatchesLifecycle(tab: FakeTab, lifecycle: TabMessageLifecycle) {
  if (lifecycle === "hidden") return !tab.active;
  return tab[lifecycle];
}

function messageType(message: unknown) {
  return isRecord(message) && typeof message.type === "string" ? message.type : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fakeUrlPatternMatches(pattern: string, value: string) {
  if (!pattern.includes("*")) return pattern === value;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for fake Chrome integration state.");
}
