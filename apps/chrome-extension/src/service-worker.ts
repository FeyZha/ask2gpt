import {
  CHROME_EXTENSION_ID,
  MAX_CONCURRENT_RUNS,
  MAX_CHAT_FILE_ATTACHMENTS,
  MAX_CHAT_FILE_BUNDLE_CHARS,
  MAX_CHAT_FILE_CHARS,
  MAX_RELAY_FRAME_BYTES,
  PROTOCOL_VERSION,
  REMOTE_CANONICALIZATION_WINDOW_MS,
  RELAY_PORTS,
  RELAY_WEBSOCKET_PROTOCOL,
  makeEnvelope,
  isHostToChromeMessageType,
  relayErrorCodes,
  safeParseRelayEnvelope,
  type ConversationClosePayload,
  type ConversationClosedPayload,
  type ConversationCanonicalizationCheckPayload,
  type ConversationCanonicalizationResultPayload,
  type ConversationOpenPayload,
  type ConversationSendPayload,
  type ConversationSnapshotPayload,
  type ConversationTranscriptProof,
  type GenerationRegeneratePayload,
  type GenerationAckPayload,
  type GenerationStopPayload,
  type ChatModelOption,
  type ModelListPayload,
  type ModelSelectPayload,
  type RelayEnvelope,
  type RelayErrorCode,
  type RelayErrorPayload,
} from "@ask2gpt/protocol";

import { parseRelayReadyIdentity, shouldSupersedeRelayConnection } from "./connection-policy";
import { CONTENT_RUNTIME_REVISION, isCompatibleContentRuntime } from "./content-runtime-policy";
import { ConversationResponseDecoder } from "./conversation-response";
import { isTransientAssistantStatus, usableAssistantMarkdown } from "./assistant-response-policy";
import {
  type ActiveRunRecord,
  type CompletedCanonicalizationRecord,
  type PendingEventRecord,
  type TabRecord,
  type TerminalHistoryBarrierRecord,
  classifyActiveRunTab,
  classifyRecoveredRun,
  classifyRestoredRemoteAdoption,
  conversationKey,
  isRunExpired,
  isCompletedCanonicalizationCurrent,
  parseStoredCompletedCanonicalizations,
  parseStoredPendingEvents,
  pendingEventKey,
  parseStoredRuns,
  parseStoredTerminalHistoryBarriers,
  parseStoredTabs,
} from "./relay-state";
import {
  isChatGptPageUrl,
  canonicalProjectScope,
  isRecord,
  isSafeId,
  normalizePromptText,
  normalizeProjectScopedUrl,
  normalizeRemoteConversationUrl,
  normalizeRemoteConversationTitle,
  parseContentEvent,
  parseProjectPageUrl,
  parseProjectRootUrl,
  parseRelayError,
  parseStoredProjectBinding,
  parseStoredTrustedProjectBinding,
  projectScopesMatch,
  reconnectDelay,
  utf8ByteLength,
  type ProjectBinding,
  type ProjectRoute,
  type ValidatedContentEvent,
  RELAY_CONNECT_TIMEOUT_MS,
} from "./security";
import {
  canAttestRecoveredRun,
  canAttributeRecoveredRun,
  canContinueRecoveredRunCanonicalization,
  hasRecoveredRunResponseProgress,
  shouldFailRecoveredRunForMissingAnswer,
  shouldRefreshRecoveredRunRender,
} from "./run-recovery-policy";
import {
  decideMappedTabNavigation,
  entriesForMappedTab,
  expectedConversationNavigationMatches,
  mappingStillOwnsTab,
  preDispatchPageMatches,
  sameChatGptConversationIdentity,
} from "./tab-navigation-policy";

type RelayTransportState = "connecting" | "open" | "authenticated" | "error";
type ProjectSetupReason =
  "LOGIN_REQUIRED" | "PROJECT_NOT_FOUND" | "PROJECT_AMBIGUOUS" | "PAGE_UNAVAILABLE";
type ProjectSetupState =
  | { phase: "idle" }
  | { phase: "working"; startedAt: string }
  | { phase: "error"; reason: ProjectSetupReason };

interface PopupProjectCandidate {
  projectUrl: string;
  scope: string;
  name: string;
}

interface RelayConnection {
  port: number;
  socket: WebSocket;
  backoffAttemptAtConnect: number;
  messageQueue: Promise<void>;
  transportState: RelayTransportState;
  connectTimer?: ReturnType<typeof setTimeout>;
  instanceId?: string;
  authenticated: boolean;
  label?: string;
  lastStatusKey?: string;
}

interface ContentResponse extends Record<string, unknown> {
  ok: boolean;
  ambiguousSubmission?: boolean;
  definitiveFailure?: boolean;
  error?: unknown;
  ready?: boolean;
  rawCandidateCount?: number;
  readyCandidateCount?: number;
  visibilityState?: "visible" | "hidden";
  active?: boolean;
  adopted?: boolean;
  matchedActiveRun?: boolean;
  recoveryTurnMatched?: boolean;
  alreadyStopped?: boolean;
  alreadyCompleted?: boolean;
  markdown?: string;
  remoteUrl?: string;
  title?: string;
  selectorVersion?: number;
  options?: ChatModelOption[];
  currentModelId?: string;
  selected?: ChatModelOption;
  projectUrl?: string;
  scope?: string;
  name?: string;
  runLifecycle?: unknown;
}

interface VisibleConversationSnapshot extends ConversationSnapshotPayload {
  /** Internal DOM evidence; never forwarded over the Relay protocol. */
  historyComplete: boolean;
}

interface DispatchPageValidationRequest {
  type: "content.validateDispatchPage";
  conversationId: string;
  runId: string;
  expectedRemoteUrl: string;
  observedRemoteUrl: string;
}

interface ContentRunLifecycleDiagnostic {
  documentVisible: boolean;
  intentAccepted: boolean;
  submissionConfirmed: boolean;
  networkSubmitted: boolean;
  networkResponseStarted: boolean;
  networkResponseComplete: boolean;
  networkResponseCompleteAgeMs?: number;
  userTurnObserved: boolean;
  responseAttributed: boolean;
  responseObserved: boolean;
  responseActionsPresent: boolean;
  stopVisible: boolean;
  sawStop: boolean;
  assistantAfterUser: boolean;
}

interface RunVisibilityLease {
  key: string;
  parkingWindowId?: number;
  runId: string;
  tabId: number;
  windowId: number;
}

interface ChromeWindowBounds {
  height: number;
  left: number;
  top: number;
  width: number;
}

interface WindowVisibilityLeaseState {
  baselineTabId?: number;
  homeInitiallyFocused: boolean;
  parked: boolean;
  parkingWindowId?: number;
  preferredActiveTabId?: number;
  restoreBounds?: ChromeWindowBounds;
  restoreMinimized: boolean;
  stack: RunVisibilityLease[];
  userIntervened: boolean;
}

interface ContentRecoveryRequest {
  type: "content.recovery.request";
  conversationId: string;
  runId: string;
  selectorVersion: number;
  reason: "network-complete-dom-missing" | "hidden-attributed-stall";
}

interface ContentMainWorldSendRequest {
  type: "content.mainWorldSend.request";
  conversationId: string;
  runId: string;
  selectorVersion: number;
}

interface ExpectedTabActivation {
  expiresAt: number;
  tabId: number;
  token: number;
}

interface RunDispatchTranscriptBaseline {
  runId: string;
  tabId: number;
  remoteUrl: string;
  initialProjectUrl?: string;
  messageCount: number;
  transcriptSha256: string;
  transcriptChainSha256?: string;
}

interface DispatchTranscriptCandidate {
  remoteUrl: string;
  initialProjectUrl?: string;
  messageCount: number;
  transcriptSha256: string;
  transcriptChainSha256?: string;
}

interface PreparedDispatchTranscriptBaseline extends DispatchTranscriptCandidate {
  tabId: number;
  navigationSequence: number;
  preparedAt: number;
}

interface CachedConversationTranscriptFingerprint {
  remoteUrl: string;
  messageCount: number;
  messageHashes: Array<{ role: "user" | "assistant"; sha256: string }>;
  transcriptSha256: string;
  transcriptChainSha256?: string;
  updatedAt: string;
}

// Report the exact content runtime required by this worker.
const SELECTOR_VERSION = CONTENT_RUNTIME_REVISION;
type RelayVisibilityMode = "background" | "foreground";
// Ask2GPT owns its ChatGPT tabs as a background relay surface. The relay may
// briefly activate an owned tab to wake a throttled page, but it must never
// focus the Chrome window automatically while receiving or recovering a run.
const RELAY_VISIBILITY_MODE: RelayVisibilityMode = "background";
const RECONNECT_ALARM = "relay-reconnect";
const TERMINAL_HISTORY_RECOVERY_ALARM = "relay-terminal-history-recovery";
const PROJECT_BINDING_STORAGE_KEY = "projectBindingV6";
const LEGACY_PROJECT_BINDING_STORAGE_KEY = "projectBindingV5";
const PROJECT_BINDING_VERIFICATION_STORAGE_KEY = "projectBindingVerificationV1";
const PROJECT_DISCOVERY_TAB_STORAGE_KEY = "projectDiscoveryTabV1";
const PROJECT_SETUP_STORAGE_KEY = "projectSetupV1";
const RELAY_RELOAD_CHECKPOINT_STORAGE_KEY = "relayReloadCheckpointV1";
const CONVERSATION_TRANSCRIPT_CACHE_STORAGE_KEY = "conversationTranscriptFingerprintsV1";
const RUN_VISIBILITY_LEASE_STORAGE_KEY = "runVisibilityLeasesV1";
const TERMINAL_HISTORY_BARRIER_STORAGE_KEY = "terminalHistoryBarriersV1";
const ENHANCED_BACKGROUND_STORAGE_KEY = "enhancedBackgroundReceptionV1";
const ENHANCED_BACKGROUND_DEFAULT_ENABLED = true;
const RELAY_RELOAD_CHECKPOINT_TTL_MS = 2 * 60_000;
const CONVERSATION_TRANSCRIPT_CACHE_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_CONVERSATION_TRANSCRIPT_CACHE_ENTRIES = 32;
const RELAY_RELOAD_TERMINAL_ACK_WAIT_MS = 2_000;
const PROJECT_INSPECTION_RETRY_MS = 250;
const PROJECT_INSPECTION_RETRY_WINDOW_MS = 3_000;
const EXPLICIT_PROJECT_VERIFICATION_WINDOW_MS = 10_000;
const PROJECT_CREATE_RETRY_WINDOW_MS = 45_000;
// Project creation opens a dialog, waits for ChatGPT to persist it, and may
// then navigate to the new Project home. Do not let the generic short
// message timeout resend this non-idempotent command while that work is in
// progress.
const PROJECT_CREATE_RESPONSE_TIMEOUT_MS = PROJECT_CREATE_RETRY_WINDOW_MS;
const PROJECT_EVIDENCE_VERSION = 2;
const LEGACY_PROJECT_BINDING_STORAGE_KEYS = [
  "projectBindingV4",
  "projectBindingV3",
  "projectBindingV2",
  "projectBindingV1",
] as const;
const REQUIRED_PROJECT_NAME = "Ask2GPT";
const LEGACY_CONNECTION_STORAGE_KEYS = ["relayPairingsV2", "relaySecrets"] as const;
const ACTIVE_RUN_CHECKPOINT_MS = 1_000;
const HISTORY_RELOAD_HYDRATION_GRACE_MS = 20_000;
const COMPOSER_READINESS_WINDOW_MS = 10_000;
// Moving an already-rendered ChatGPT tab between normal windows can expose the
// composer before React has reattached its submission handlers. Require one
// second, delayed readiness proof while the tab is parked. This is entirely
// pre-dispatch: no prompt has been written and no send action has occurred.
const PARKED_COMPOSER_STABILITY_MS = 350;
const CONTENT_SEND_RESPONSE_TIMEOUT_MS = 20_000;
const CONTENT_SEND_WITH_ATTACHMENTS_RESPONSE_TIMEOUT_MS = 150_000;
const CONTENT_MESSAGE_RETRY_WINDOW_MS = 10_000;
const CONTENT_MESSAGE_RESPONSE_TIMEOUT_MS = 1_000;
// A newly opened background ChatGPT tab can expose a ready composer before its
// existing transcript has finished hydrating. Wait briefly for two identical,
// complete snapshots instead of either sending against a partial baseline or
// failing the run after the first transient inspection timeout.
const PRE_DISPATCH_TRANSCRIPT_RETRY_WINDOW_MS = 3_000;
const PRE_DISPATCH_TRANSCRIPT_STABILITY_MS = 120;
const PRE_DISPATCH_TRANSCRIPT_INSPECT_TIMEOUT_MS = 1_000;
const CONTENT_MODEL_COMMAND_TIMEOUT_MS = 15_000;
const TERMINAL_EVENT_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;
const TAB_NAVIGATION_LEASE_MS = 30_000;
const MODEL_CATALOG_TTL_MS = 10 * 60_000;
const PROMPT_INLINE_PRESENTATION_VERSION = 1 as const;

interface EnhancedDebuggerCapture {
  key: string;
  runId: string;
  tabId: number;
  candidateRequests: Map<string, EnhancedNetworkCandidate>;
  requestId?: string;
  requestTarget?: chrome.debugger.DebuggerSession;
  responseDecoder: ConversationResponseDecoder;
  textDecoder: TextDecoder;
  latestMarkdown: string;
  lastPublishedMarkdown: string;
  pendingSnapshotMarkdown?: string;
  snapshotPump?: Promise<void>;
  publishedSnapshotCount: number;
  networkCompletionProbe: string;
  webSocketCompletionProbe: string;
  decodedChars: number;
  childTargetCount: number;
  webSocketFrameCount: number;
  preHandoffWebSocketItems: EnhancedWebSocketItem[];
  preHandoffWebSocketChars: number;
  handoffTopicId?: string;
  autoAttachEnabled: boolean;
  streamStarted: boolean;
  responseMimeType?: string;
  responsePath?: string;
  lastStage: string;
  lastError?: string;
  processing: boolean;
  eventQueue: Promise<void>;
}

interface EnhancedNetworkCandidate {
  url: string;
  target: chrome.debugger.DebuggerSession;
  streamArm: Promise<EnhancedStreamArmResult>;
}

interface EnhancedWebSocketItem {
  topicId: string;
  encodedItem: string;
}

type EnhancedStreamArmResult = { ok: true; response: unknown } | { ok: false; error: string };

const MAX_ENHANCED_RESPONSE_CHARS = 1_500_000;
const MAX_PRE_HANDOFF_WEBSOCKET_ITEMS = 256;
const MAX_PRE_HANDOFF_WEBSOCKET_CHARS = 512_000;
const PARKED_WINDOW_WIDTH = 980;
const PARKED_WINDOW_HEIGHT = 760;
const PARKED_WINDOW_MAX_POSITION_ADJUSTMENT = 256;
const DISPATCH_INTENT_PREWARM_HOLD_MS = 10_000;
const DISPATCH_INTENT_PREWARM_POLL_MS = 50;
const MAIN_WORLD_SEND_ATTRIBUTE = "data-ask2gpt-main-world-send";
const MAIN_WORLD_COMPOSER_ATTRIBUTE = "data-ask2gpt-main-world-composer";
const MAIN_WORLD_SCOPE_ATTRIBUTE = "data-ask2gpt-main-world-scope";

const chromeWithOptionalDebugging = chrome as typeof chrome & {
  debugger?: typeof chrome.debugger;
  permissions?: typeof chrome.permissions;
};

function automaticFocusAllowed(requested: boolean) {
  return requested && RELAY_VISIBILITY_MODE === "foreground";
}

const connections = new Map<number, RelayConnection>();
const reconnectAttempts = new Map<number, number>();
const reconnectTimers = new Map<number, ReturnType<typeof setTimeout>>();
const transientConversationActivationQueues = new Map<number, Promise<void>>();
const windowActivationEpochs = new Map<number, number>();
const runVisibilityLeases = new Map<string, RunVisibilityLease>();
const windowVisibilityLeaseStates = new Map<number, WindowVisibilityLeaseState>();
const parkingWindowOwners = new Map<number, number>();
const dispatchIntentPrewarmDeadlines = new Map<string, number>();
const dispatchIntentPrewarmTasks = new Map<string, Promise<void>>();
const expectedTabActivations = new Map<number, ExpectedTabActivation[]>();
const enhancedDebuggerCaptures = new Map<number, EnhancedDebuggerCapture>();
const enhancedDebuggerDiagnostics = new Map<string, string>();
let enhancedBackgroundEnabled = false;
let nextExpectedTabActivationToken = 1;
let workerSuspended = false;
const conversationTabs = new Map<string, TabRecord>();
const activeRuns = new Map<string, ActiveRunRecord>();
const completedCanonicalizations = new Map<string, CompletedCanonicalizationRecord>();
const terminalHistoryBarriers = new Map<string, TerminalHistoryBarrierRecord>();
const completedInitialAdoptions = new Map<
  string,
  {
    tabId: number;
    promptSha256: string;
    promptInlinePresentationVersion?: 1;
    promptInlinePresentationSha256?: string;
    terminalMarkdownSha256: string;
    terminalStatus: "complete" | "stopped";
    expiresAt: number;
  }
>();
const runPromptFingerprints = new Map<string, string>();
const runDispatchTranscriptBaselines = new Map<string, RunDispatchTranscriptBaseline>();
// Idle-time proof used to turn the two-snapshot send preflight into one fresh
// comparison. This is deliberately memory-only: after an MV3 restart the
// existing fail-closed two-snapshot path remains authoritative.
const preparedDispatchTranscriptBaselines = new Map<string, PreparedDispatchTranscriptBaseline>();
const dispatchTranscriptDiagnostics = new Map<string, string>();
const conversationTranscriptFingerprints = new Map<
  string,
  CachedConversationTranscriptFingerprint
>();
// Memory-only proof that at least one rendered suffix (or a complete
// transcript) matched this exact chain. It lets a freshly parked, visibly
// ready ChatGPT document survive a brief zero-turn virtualization frame
// without weakening the first migration check after an MV3 restart.
const attestedConversationTranscriptChains = new Map<string, string>();
const settledCanonicalizationTombstones = new Set<string>();
interface TerminalHistoryRequirement {
  runId: string;
  markdown: string;
}
interface ConversationSnapshotSync {
  attempts: number;
  pending: Promise<boolean>;
  record: TabRecord;
  requiredTerminal?: TerminalHistoryRequirement;
  rerunRequested: boolean;
}
const conversationSnapshotSyncs = new Map<string, ConversationSnapshotSync>();
const pendingEvents = new Map<string, PendingEventRecord>();
// Terminal records can be visible in memory while their session write is
// still pending. Only committed keys are eligible for WebSocket delivery.
const committedPendingEventKeys = new Set<string>();
const pendingEventRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingEventRetryAttempts = new Map<string, number>();
const closingTabs = new Set<number>();
const projectDiscoveryExpectedProjectNavigations = new Map<number, string>();
const recoveringRuns = new Set<string>();
const conversationCommands = new Map<string, Promise<void>>();
const tabNavigationSequences = new Map<number, number>();
const expectedTabNavigations = new Map<string, { tabId: number; expiresAt: number }>();
const conversationModelSelections = new Map<string, string>();
const forwardedSnapshots = new Map<
  string,
  { runId: string; markdown: string; remoteUrl?: string }
>();
type ForwardedSnapshotRecord = NonNullable<ReturnType<typeof forwardedSnapshots.get>>;
interface ForwardedSnapshotGuard {
  expected: ForwardedSnapshotRecord | undefined;
  exactTranscriptRecovery?: boolean;
}
let lastError: string | undefined;
let projectBinding: ProjectBinding | undefined;
let projectBindingTrusted = false;
let projectBindingVerifiedThisSession = false;
let projectBindingVerificationPromise: Promise<ProjectBinding> | undefined;
let lastProjectInspectionMessage: string | undefined;
let projectDiscoveryTabId: number | undefined;
let projectDiscoveryPromise: Promise<ProjectBinding | undefined> | undefined;
let explicitProjectBindingPromise: Promise<ProjectBinding> | undefined;
let selectedProjectBindingPromise: Promise<ProjectBinding> | undefined;
let projectCreationPromise: Promise<{ binding: ProjectBinding; created: boolean }> | undefined;
let projectSetupState: ProjectSetupState = { phase: "idle" };
let sessionStorageWrite: Promise<void> = Promise.resolve();
let conversationTranscriptFingerprintWrite: Promise<void> = Promise.resolve();
let modelCatalogCache:
  | {
      options: ChatModelOption[];
      defaultModelId?: string;
      expiresAt: number;
    }
  | undefined;
let deferredSessionPersistTimer: ReturnType<typeof setTimeout> | undefined;
let relayReloadPreparationActive = false;
let relayReloadPreparationPromise: Promise<void> | undefined;
let relayRuntimeReloadScheduled = false;
let terminalHistoryRecoveryPromise: Promise<void> | undefined;

const ready = initialize().catch((error: unknown) => {
  lastError = error instanceof Error ? error.message : "Chrome relay initialization failed.";
  scanPorts();
});

chrome.runtime.onStartup.addListener(() => void ready.then(scanPorts));
chrome.runtime.onInstalled.addListener(() => void ready.then(scanPorts));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) void ready.then(scanPorts);
  if (alarm.name === TERMINAL_HISTORY_RECOVERY_ALARM) {
    void ready
      .then(recoverTerminalHistoryBarriers)
      .catch(() => recordBackgroundFailure("Terminal history recovery alarm failed."));
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void ready
    .then(() => handleTabRemoved(tabId))
    .catch(() => recordBackgroundFailure("Tab removal handling failed."));
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const lifecycle = changeInfo as typeof changeInfo & {
    discarded?: boolean;
    frozen?: boolean;
  };
  const navigationSequence = changeInfo.url ? nextTabNavigationSequence(tabId) : undefined;
  if (
    changeInfo.url ||
    changeInfo.status === "complete" ||
    lifecycle.discarded === false ||
    lifecycle.frozen === false
  ) {
    void ready
      .then(async () => {
        if (
          changeInfo.url &&
          !(await handleTabUrlChanged(tabId, changeInfo.url, navigationSequence!))
        ) {
          return;
        }
        if (
          changeInfo.status === "complete" ||
          lifecycle.discarded === false ||
          lifecycle.frozen === false
        ) {
          await recoverReloadedTab(tabId);
        }
      })
      .catch(() => recordBackgroundFailure("Tab navigation handling failed."));
  }
});
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const homeWindowId = parkingWindowOwners.get(windowId) ?? windowId;
  const retainedLease = windowVisibilityLeaseStates.get(homeWindowId)?.stack.at(-1);
  if (!consumeExpectedTabActivation(windowId, tabId) && retainedLease?.tabId !== tabId) {
    markWindowUserIntervened(windowId, tabId);
  }
  void ready
    .then(() => recoverReloadedTab(tabId))
    .catch(() => recordBackgroundFailure("Activated tab recovery failed."));
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  // WINDOW_ID_NONE is reported while focus leaves Chrome. Returning to a
  // leased Chrome window is deliberate user interaction even when the active
  // tab does not change, so terminal cleanup must not steal that tab away.
  if (windowId >= 0) markWindowUserIntervened(windowId);
});

chromeWithOptionalDebugging.debugger?.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined) return;
  enqueueEnhancedDebuggerEvent(source, method, params);
});
chromeWithOptionalDebugging.debugger?.onDetach.addListener((source) => {
  if (source.tabId === undefined) return;
  const capture = enhancedDebuggerCaptures.get(source.tabId);
  if (capture) rememberEnhancedDebuggerDiagnostic(capture);
  enhancedDebuggerCaptures.delete(source.tabId);
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isTrustedPopupSender(sender) && isPopupMessage(message)) {
    void ready
      .then(() => handlePopupMessage(message))
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Popup request failed.",
        });
      });
    return true;
  }

  const dispatchPageValidation = parseDispatchPageValidationRequest(message);
  if (dispatchPageValidation && isTrustedChatGptSender(sender)) {
    void ready
      .then(() =>
        handleDispatchPageValidation(
          dispatchPageValidation,
          sender.tab!.id!,
          sender.url ?? sender.tab!.url,
        ),
      )
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  const recoveryRequest = parseContentRecoveryRequest(message);
  if (recoveryRequest && isTrustedChatGptSender(sender)) {
    void ready
      .then(() =>
        handleContentRecoveryRequest(
          recoveryRequest,
          sender.tab!.id!,
          sender.url ?? sender.tab!.url,
        ),
      )
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  const mainWorldSendRequest = parseContentMainWorldSendRequest(message);
  if (mainWorldSendRequest && isTrustedChatGptSender(sender)) {
    void ready
      .then(() =>
        handleContentMainWorldSendRequest(
          mainWorldSendRequest,
          sender.tab!.id!,
          sender.url ?? sender.tab!.url,
        ),
      )
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, dispatched: false }));
    return true;
  }

  const event = parseContentEvent(message);
  if (event && isTrustedChatGptSender(sender)) {
    let responseSent = false;
    const respond = (accepted: boolean) => {
      if (responseSent) return;
      responseSent = true;
      sendResponse({ ok: accepted });
    };
    void ready
      .then(() =>
        handleContentEvent(event, sender.tab!.id!, undefined, sender.url ?? sender.tab!.url, () =>
          respond(true),
        ),
      )
      .then((accepted) => respond(accepted))
      .catch(() => respond(false));
    return true;
  }
  return false;
});

const heartbeat = setInterval(() => {
  for (const connection of connections.values()) {
    if (connection.authenticated && connection.socket.readyState === WebSocket.OPEN) {
      sendConnection(
        connection,
        makeEnvelope({
          type: "heartbeat",
          instanceId: connection.instanceId!,
          payload: { at: new Date().toISOString() },
        }),
      );
    }
  }
  if (terminalHistoryBarriers.size > 0) {
    void ready
      .then(recoverTerminalHistoryBarriers)
      .catch(() => recordBackgroundFailure("Terminal history heartbeat recovery failed."));
  }
}, 20_000);
void heartbeat;

const activeRunCheckpoint = setInterval(() => {
  const hasAwaitingCanonicalization = [...completedCanonicalizations].some(
    ([key, grant]) => !grant.toRemoteUrl && !settledCanonicalizationTombstones.has(key),
  );
  if (activeRuns.size === 0 && !hasAwaitingCanonicalization) return;
  void ready
    .then(async () => {
      await checkpointActiveRuns();
      await retryPendingCompletedCanonicalizations();
      await pruneCompletedCanonicalizations();
    })
    .catch(() => recordBackgroundFailure("Active run checkpoint failed."));
}, ACTIVE_RUN_CHECKPOINT_MS);
void activeRunCheckpoint;

// MV3 terminates the whole worker realm, which inherently clears these
// timers. The optional event is present in the integration harness (and some
// Chromium event-page runtimes), where explicit disposal prevents a retired
// worker from leaking callbacks into the next runtime instance.
chrome.runtime.onSuspend?.addListener(() => {
  workerSuspended = true;
  relayReloadPreparationActive = true;
  clearInterval(heartbeat);
  clearInterval(activeRunCheckpoint);
  clearReconnectTimers();
  for (const timer of pendingEventRetryTimers.values()) clearTimeout(timer);
  pendingEventRetryTimers.clear();
  pendingEventRetryAttempts.clear();
  runVisibilityLeases.clear();
  windowVisibilityLeaseStates.clear();
  parkingWindowOwners.clear();
  dispatchIntentPrewarmDeadlines.clear();
  dispatchIntentPrewarmTasks.clear();
  runDispatchTranscriptBaselines.clear();
  preparedDispatchTranscriptBaselines.clear();
  dispatchTranscriptDiagnostics.clear();
  expectedTabActivations.clear();
  for (const tabId of enhancedDebuggerCaptures.keys()) {
    void detachEnhancedDebugger(tabId);
  }
  enhancedDebuggerCaptures.clear();
  if (deferredSessionPersistTimer) {
    clearTimeout(deferredSessionPersistTimer);
    deferredSessionPersistTimer = undefined;
  }
  const openConnections = [...connections.values()];
  connections.clear();
  for (const connection of openConnections) {
    clearConnectTimer(connection);
    connection.authenticated = false;
    try {
      connection.socket.close(1001, "Relay service worker suspended");
    } catch {
      // The browser may already have closed the transport while suspending.
    }
  }
});

async function hasDebuggerPermission() {
  const permissions = chromeWithOptionalDebugging.permissions;
  if (!permissions) return false;
  return permissions.contains({ permissions: ["debugger"] }).catch(() => false);
}

function enhancedDebuggerErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 240);
}

function enhancedDebuggerSessionKey(target: chrome.debugger.DebuggerSession) {
  return target.sessionId ?? "root";
}

function enhancedDebuggerRequestKey(target: chrome.debugger.DebuggerSession, requestId: string) {
  return `${enhancedDebuggerSessionKey(target)}\u0000${requestId}`;
}

function enhancedDebuggerDiagnosticSummary(capture: EnhancedDebuggerCapture) {
  const matchedTarget = capture.requestTarget
    ? capture.requestTarget.sessionId
      ? "child"
      : "root"
    : "none";
  return [
    `stage=${capture.lastStage}`,
    `autoAttach=${capture.autoAttachEnabled ? 1 : 0}`,
    `children=${capture.childTargetCount}`,
    `candidates=${capture.candidateRequests.size}`,
    `matched=${matchedTarget}`,
    `stream=${capture.streamStarted ? 1 : 0}`,
    `decodedChars=${capture.decodedChars}`,
    `snapshots=${capture.publishedSnapshotCount}`,
    `handoff=${capture.handoffTopicId ? 1 : 0}`,
    `wsFrames=${capture.webSocketFrameCount}`,
    `bufferedWs=${capture.preHandoffWebSocketItems.length}`,
    `frames=${capture.responseDecoder.diagnosticSummary()}`,
    ...(capture.responseMimeType ? [`mime=${capture.responseMimeType}`] : []),
    ...(capture.responsePath ? [`path=${capture.responsePath}`] : []),
    ...(capture.lastError ? [`error=${capture.lastError}`] : []),
  ].join(" ");
}

function rememberEnhancedDebuggerDiagnostic(capture: EnhancedDebuggerCapture) {
  enhancedDebuggerDiagnostics.set(capture.key, enhancedDebuggerDiagnosticSummary(capture));
  while (enhancedDebuggerDiagnostics.size > 16) {
    const oldest = enhancedDebuggerDiagnostics.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    enhancedDebuggerDiagnostics.delete(oldest);
  }
}

function rememberEnhancedDebuggerStartFailure(key: string, stage: string, error?: unknown) {
  enhancedDebuggerDiagnostics.set(
    key,
    [
      `stage=${stage}`,
      ...(error === undefined ? [] : [`error=${enhancedDebuggerErrorMessage(error)}`]),
    ].join(" "),
  );
}

const ENHANCED_AUTO_ATTACH_OPTIONS = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
} as const;

async function enableEnhancedNetworkTarget(
  target: chrome.debugger.DebuggerSession,
  capture: EnhancedDebuggerCapture,
) {
  const debuggerApi = chromeWithOptionalDebugging.debugger;
  if (!debuggerApi) return;
  await debuggerApi.sendCommand(target, "Network.enable", {
    maxTotalBufferSize: 4 * 1024 * 1024,
    maxResourceBufferSize: 2 * 1024 * 1024,
  });
  capture.lastStage = target.sessionId ? "child-network-enabled" : "root-network-enabled";
  try {
    await debuggerApi.sendCommand(target, "Target.setAutoAttach", ENHANCED_AUTO_ATTACH_OPTIONS);
    capture.autoAttachEnabled = true;
    capture.lastStage = target.sessionId ? "child-auto-attach-enabled" : "auto-attach-enabled";
  } catch (error) {
    capture.lastError = enhancedDebuggerErrorMessage(error);
  }
}

function chatGptNetworkUrl(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      (url.hostname !== "chatgpt.com" && !url.hostname.endsWith(".chatgpt.com"))
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function isChatGptPostRequest(request: Record<string, unknown>) {
  return request.method === "POST" && chatGptNetworkUrl(request.url) !== undefined;
}

function isConversationNetworkResponse(
  response: Record<string, unknown>,
  candidateUrl: string | undefined,
) {
  const url = chatGptNetworkUrl(response.url ?? candidateUrl);
  if (!url) return false;
  const mimeType = typeof response.mimeType === "string" ? response.mimeType.toLowerCase() : "";
  // ChatGPT emits several short JSON POST responses whose paths also contain
  // "conversation" (metadata, queue state, titles, and other bookkeeping).
  // Locking the capture to one of those requests prevents the actual answer
  // stream from being observed. The decoder below consumes SSE, so only claim
  // a request after Chrome identifies the response as an event stream.
  return mimeType.includes("text/event-stream");
}

function decodeEnhancedBase64Chunk(encoded: string, decoder: TextDecoder, stream = true) {
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  return decoder.decode(bytes, { stream });
}

async function armEnhancedResponseStream(
  target: chrome.debugger.DebuggerSession,
  requestId: string,
): Promise<EnhancedStreamArmResult> {
  const debuggerApi = chromeWithOptionalDebugging.debugger;
  if (!debuggerApi) return { ok: false, error: "Debugger API unavailable." };
  try {
    const response = (await debuggerApi.sendCommand(target, "Network.streamResourceContent", {
      requestId,
    })) as unknown;
    return { ok: true, response };
  } catch (error) {
    return { ok: false, error: enhancedDebuggerErrorMessage(error) };
  }
}

function consumeEnhancedResponseText(
  capture: EnhancedDebuggerCapture,
  text: string,
  transport: "network" | "websocket" = "network",
) {
  if (!text) return false;
  capture.decodedChars += text.length;
  if (capture.decodedChars > MAX_ENHANCED_RESPONSE_CHARS) {
    throw new Error("Enhanced ChatGPT response exceeded the capture limit.");
  }
  const previousProbe =
    transport === "websocket" ? capture.webSocketCompletionProbe : capture.networkCompletionProbe;
  const probe = previousProbe + text;
  if (transport === "websocket") capture.webSocketCompletionProbe = probe.slice(-128);
  else capture.networkCompletionProbe = probe.slice(-128);
  const markdown = usableAssistantMarkdown(capture.responseDecoder.push(text) ?? "");
  if (markdown) capture.latestMarkdown = markdown;
  capture.handoffTopicId ??= capture.responseDecoder.streamHandoffTopicId();
  return !previousProbe.includes("[DONE]") && probe.includes("[DONE]");
}

async function publishEnhancedDebuggerSnapshot(
  tabId: number,
  capture: EnhancedDebuggerCapture,
  markdown: string,
) {
  if (
    enhancedDebuggerCaptures.get(tabId) !== capture ||
    !markdown ||
    isTransientAssistantStatus(markdown)
  ) {
    return false;
  }
  const run = activeRuns.get(capture.key);
  const tab = conversationTabs.get(capture.key);
  if (
    !run ||
    run.runId !== capture.runId ||
    run.tabId !== tabId ||
    tab?.tabId !== tabId ||
    run.historyReloadClaimedAt
  ) {
    return false;
  }

  const previous = forwardedSnapshots.get(capture.key);
  if (
    previous?.runId === capture.runId &&
    (previous.markdown === markdown || previous.markdown.length > markdown.length)
  ) {
    return false;
  }

  const event = parseContentEvent({
    type: "content.event",
    eventType: "snapshot",
    conversationId: run.conversationId,
    runId: run.runId,
    markdown,
  });
  if (!event) return false;
  return await handleContentEvent(
    event,
    tabId,
    undefined,
    undefined,
    undefined,
    "enhanced-debugger",
  );
}

function queueEnhancedDebuggerSnapshot(tabId: number, capture: EnhancedDebuggerCapture) {
  const markdown = capture.latestMarkdown;
  if (
    !markdown ||
    markdown === capture.lastPublishedMarkdown ||
    markdown === capture.pendingSnapshotMarkdown
  ) {
    return capture.snapshotPump ?? Promise.resolve();
  }
  if (
    capture.lastPublishedMarkdown.length > markdown.length &&
    capture.lastPublishedMarkdown.startsWith(markdown)
  ) {
    return capture.snapshotPump ?? Promise.resolve();
  }

  capture.pendingSnapshotMarkdown = markdown;
  if (capture.snapshotPump) return capture.snapshotPump;

  const pump = (async () => {
    while (capture.pendingSnapshotMarkdown) {
      const nextMarkdown = capture.pendingSnapshotMarkdown;
      capture.pendingSnapshotMarkdown = undefined;
      if (nextMarkdown === capture.lastPublishedMarkdown) continue;
      try {
        const published = await publishEnhancedDebuggerSnapshot(tabId, capture, nextMarkdown);
        if (published) {
          capture.lastPublishedMarkdown = nextMarkdown;
          capture.publishedSnapshotCount += 1;
          capture.lastStage = "snapshot-published";
        }
      } catch (error) {
        // Streaming remains an optimization. The exact terminal path below is
        // still authoritative if one partial snapshot cannot be forwarded.
        capture.lastStage = "snapshot-publish-failed";
        capture.lastError = enhancedDebuggerErrorMessage(error);
      }
    }
  })();
  capture.snapshotPump = pump;
  void pump.then(() => {
    if (capture.snapshotPump !== pump) return;
    capture.snapshotPump = undefined;
    if (capture.pendingSnapshotMarkdown) void queueEnhancedDebuggerSnapshot(tabId, capture);
  });
  return pump;
}

async function startEnhancedDebuggerCapture(key: string, run: ActiveRunRecord, tabId: number) {
  const debuggerApi = chromeWithOptionalDebugging.debugger;
  enhancedDebuggerDiagnostics.delete(key);
  if (!enhancedBackgroundEnabled) {
    rememberEnhancedDebuggerStartFailure(key, "disabled");
    return false;
  }
  if (!debuggerApi) {
    rememberEnhancedDebuggerStartFailure(key, "debugger-api-unavailable");
    return false;
  }
  const existingCapture = enhancedDebuggerCaptures.get(tabId);
  if (existingCapture?.key === key && existingCapture.runId === run.runId) {
    return true;
  }
  if (existingCapture) {
    rememberEnhancedDebuggerStartFailure(key, "capture-already-active");
    return false;
  }
  if (!(await hasDebuggerPermission())) {
    rememberEnhancedDebuggerStartFailure(key, "permission-unavailable");
    return false;
  }

  try {
    await debuggerApi.attach({ tabId }, "1.3");
    const capture: EnhancedDebuggerCapture = {
      key,
      runId: run.runId,
      tabId,
      candidateRequests: new Map(),
      responseDecoder: new ConversationResponseDecoder(),
      textDecoder: new TextDecoder(),
      latestMarkdown: "",
      lastPublishedMarkdown: "",
      publishedSnapshotCount: 0,
      networkCompletionProbe: "",
      webSocketCompletionProbe: "",
      decodedChars: 0,
      childTargetCount: 0,
      webSocketFrameCount: 0,
      preHandoffWebSocketItems: [],
      preHandoffWebSocketChars: 0,
      autoAttachEnabled: false,
      streamStarted: false,
      lastStage: "attached",
      processing: false,
      eventQueue: Promise.resolve(),
    };
    enhancedDebuggerCaptures.set(tabId, capture);
    await enableEnhancedNetworkTarget({ tabId }, capture);
    return true;
  } catch (error) {
    const capture = enhancedDebuggerCaptures.get(tabId);
    if (capture) {
      capture.lastStage = "attach-failed";
      capture.lastError = enhancedDebuggerErrorMessage(error);
      rememberEnhancedDebuggerDiagnostic(capture);
    } else {
      rememberEnhancedDebuggerStartFailure(key, "attach-failed", error);
    }
    enhancedDebuggerCaptures.delete(tabId);
    await debuggerApi.detach({ tabId }).catch(() => undefined);
    return false;
  }
}

async function wakeEnhancedBackgroundPage(
  key: string,
  run: ActiveRunRecord,
  tabId: number,
  captureReady: Promise<boolean> = startEnhancedDebuggerCapture(key, run, tabId),
) {
  if (!(await captureReady)) return false;
  const capture = enhancedDebuggerCaptures.get(tabId);
  const debuggerApi = chromeWithOptionalDebugging.debugger;
  if (!capture || capture.key !== key || capture.runId !== run.runId || !debuggerApi) return false;

  try {
    // Selecting a tab does not thaw its renderer while the entire Chrome window
    // remains minimized. CDP can move the owned page back to the active lifecycle
    // state without restoring or focusing that window.
    await debuggerApi.sendCommand({ tabId }, "Page.setWebLifecycleState", {
      state: "active",
    });
    capture.lastStage = "dispatch-page-active";
  } catch (error) {
    capture.lastStage = "dispatch-page-activation-failed";
    capture.lastError = enhancedDebuggerErrorMessage(error);
    return false;
  }

  try {
    // Keep React's visibility/focus-dependent scheduler runnable while Chrome is
    // minimized. This is renderer emulation only; it does not focus the OS window.
    await debuggerApi.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", {
      enabled: true,
    });
    capture.lastStage = "dispatch-page-awake";
  } catch (error) {
    // Lifecycle activation is the essential wake-up. Older Chrome versions may
    // not expose focus emulation, so retain the active page and continue probing.
    capture.lastStage = "dispatch-focus-emulation-unavailable";
    capture.lastError = enhancedDebuggerErrorMessage(error);
  }

  try {
    const targetInfoResponse: unknown = await debuggerApi.sendCommand(
      { tabId },
      "Target.getTargetInfo",
    );
    const targetInfo = isRecord(targetInfoResponse) ? targetInfoResponse.targetInfo : undefined;
    const targetId = isRecord(targetInfo) ? targetInfo.targetId : undefined;
    if (typeof targetId !== "string" || targetId.length === 0) {
      throw new Error("Missing owned page target id.");
    }
    await debuggerApi.sendCommand({ tabId }, "Target.activateTarget", { targetId });
    capture.lastStage = "dispatch-target-active";

    // Focus emulation can report a visible document while ChatGPT still leaves
    // its composer non-interactive. Promote the already-owned tab at the page
    // target level before readiness probes; this activates no other tab and does
    // not request operating-system window focus.
    await debuggerApi.sendCommand({ tabId }, "Page.bringToFront");
    capture.lastStage = "dispatch-page-front";
  } catch (error) {
    capture.lastStage = "dispatch-page-front-failed";
    capture.lastError = enhancedDebuggerErrorMessage(error);
    return false;
  }
  return true;
}

async function detachEnhancedDebugger(tabId: number, runId?: string) {
  const capture = enhancedDebuggerCaptures.get(tabId);
  if (runId !== undefined && capture?.runId !== runId) return;
  if (capture) rememberEnhancedDebuggerDiagnostic(capture);
  enhancedDebuggerCaptures.delete(tabId);
  await chromeWithOptionalDebugging.debugger?.detach({ tabId }).catch(() => undefined);
}

async function stopAllEnhancedDebuggerCaptures() {
  await Promise.all(
    [...enhancedDebuggerCaptures.keys()].map((tabId) => detachEnhancedDebugger(tabId)),
  );
}

function enhancedWebSocketPayload(params: Record<string, unknown>) {
  if (!isRecord(params.response) || typeof params.response.payloadData !== "string") {
    return undefined;
  }
  if (params.response.opcode !== 2) return params.response.payloadData;
  try {
    return decodeEnhancedBase64Chunk(params.response.payloadData, new TextDecoder(), false);
  } catch {
    return undefined;
  }
}

function encodedWebSocketItem(value: unknown) {
  if (!isRecord(value)) return undefined;
  const payload = isRecord(value.payload) ? value.payload : undefined;
  const nestedPayload = payload && isRecord(payload.payload) ? payload.payload : undefined;
  return typeof nestedPayload?.encoded_item === "string"
    ? nestedPayload.encoded_item
    : typeof payload?.encoded_item === "string"
      ? payload.encoded_item
      : undefined;
}

function webSocketEncodedItems(payloadData: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadData);
  } catch {
    return [];
  }
  const items: EnhancedWebSocketItem[] = [];
  const frames = Array.isArray(parsed) ? parsed : [parsed];
  for (const frame of frames) {
    if (!isRecord(frame)) continue;
    if (frame.type === "message" && typeof frame.topic_id === "string") {
      const encodedItem = encodedWebSocketItem(frame);
      if (encodedItem) items.push({ topicId: frame.topic_id, encodedItem });
      continue;
    }
    if (
      frame.type !== "reply" ||
      !isRecord(frame.reply) ||
      typeof frame.reply.topic_id !== "string"
    ) {
      continue;
    }
    if (Array.isArray(frame.reply.catchups)) {
      for (const catchup of frame.reply.catchups) {
        const encodedItem = encodedWebSocketItem(catchup);
        if (encodedItem) items.push({ topicId: frame.reply.topic_id, encodedItem });
      }
    }
  }
  return items;
}

function bufferPreHandoffWebSocketItems(
  capture: EnhancedDebuggerCapture,
  items: readonly EnhancedWebSocketItem[],
) {
  for (const item of items) {
    if (item.encodedItem.length > MAX_PRE_HANDOFF_WEBSOCKET_CHARS) continue;
    capture.preHandoffWebSocketItems.push(item);
    capture.preHandoffWebSocketChars += item.encodedItem.length;
    while (
      capture.preHandoffWebSocketItems.length > MAX_PRE_HANDOFF_WEBSOCKET_ITEMS ||
      capture.preHandoffWebSocketChars > MAX_PRE_HANDOFF_WEBSOCKET_CHARS
    ) {
      const removed = capture.preHandoffWebSocketItems.shift();
      if (!removed) break;
      capture.preHandoffWebSocketChars -= removed.encodedItem.length;
    }
  }
}

function consumeBufferedHandoffItems(capture: EnhancedDebuggerCapture) {
  const topicId = capture.handoffTopicId;
  if (!topicId || capture.preHandoffWebSocketItems.length === 0) return false;
  const items = capture.preHandoffWebSocketItems;
  capture.preHandoffWebSocketItems = [];
  capture.preHandoffWebSocketChars = 0;
  let done = false;
  for (const item of items) {
    if (item.topicId !== topicId) continue;
    capture.webSocketFrameCount += 1;
    capture.lastStage = "websocket-buffer-replayed";
    done = consumeEnhancedResponseText(capture, item.encodedItem, "websocket") || done;
  }
  return done;
}

async function handleEnhancedWebSocketPayload(
  tabId: number,
  capture: EnhancedDebuggerCapture,
  payloadData: string,
) {
  const items = webSocketEncodedItems(payloadData);
  if (!capture.handoffTopicId) {
    bufferPreHandoffWebSocketItems(capture, items);
    if (items.length > 0) capture.lastStage = "websocket-buffered-before-handoff";
    return;
  }
  for (const item of items) {
    if (item.topicId !== capture.handoffTopicId) continue;
    if (enhancedDebuggerCaptures.get(tabId) !== capture) return;
    capture.webSocketFrameCount += 1;
    capture.lastStage = "websocket-data";
    const done = consumeEnhancedResponseText(capture, item.encodedItem, "websocket");
    void queueEnhancedDebuggerSnapshot(tabId, capture);
    if (done && capture.latestMarkdown) {
      await finalizeEnhancedDebuggerCapture(tabId, capture, false);
      return;
    }
  }
}

function enqueueEnhancedDebuggerEvent(
  source: chrome.debugger.DebuggerSession,
  method: string,
  params?: object,
) {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  const capture = enhancedDebuggerCaptures.get(tabId);
  if (!capture) return;
  const queued = capture.eventQueue.then(async () => {
    if (enhancedDebuggerCaptures.get(tabId) !== capture) return;
    await handleEnhancedDebuggerEvent(source, method, params);
  });
  capture.eventQueue = queued.catch((error) => {
    if (enhancedDebuggerCaptures.get(tabId) === capture) {
      capture.lastStage = "event-error";
      capture.lastError = enhancedDebuggerErrorMessage(error);
    }
    recordBackgroundFailure(
      "Enhanced background response capture failed; using the default relay.",
    );
  });
}

async function handleEnhancedDebuggerEvent(
  source: chrome.debugger.DebuggerSession,
  method: string,
  params?: object,
) {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  const capture = enhancedDebuggerCaptures.get(tabId);
  if (!capture || capture.processing || !isRecord(params)) return;

  if (method === "Network.webSocketFrameReceived") {
    const payloadData = enhancedWebSocketPayload(params);
    if (payloadData) await handleEnhancedWebSocketPayload(tabId, capture, payloadData);
    return;
  }

  if (method === "Target.attachedToTarget") {
    if (typeof params.sessionId !== "string" || !isRecord(params.targetInfo)) return;
    const type = typeof params.targetInfo.type === "string" ? params.targetInfo.type : "unknown";
    if (type === "browser" || type === "tab" || type === "page") return;
    capture.childTargetCount += 1;
    capture.lastStage = `child-attached:${type}`;
    await enableEnhancedNetworkTarget({ tabId, sessionId: params.sessionId }, capture);
    return;
  }

  if (method === "Network.requestWillBeSent") {
    if (typeof params.requestId !== "string" || !isRecord(params.request)) return;
    if (isChatGptPostRequest(params.request) && typeof params.request.url === "string") {
      const requestKey = enhancedDebuggerRequestKey(source, params.requestId);
      capture.candidateRequests.set(requestKey, {
        url: params.request.url,
        target: source,
        // Chrome only includes response bytes in Network.dataReceived after
        // streamResourceContent has been armed. Waiting for responseReceived is
        // racy for fast SSE responses, so arm every candidate ChatGPT POST at
        // request start and select the event-stream response once headers arrive.
        streamArm: armEnhancedResponseStream(source, params.requestId),
      });
      capture.lastStage = "candidate-post-seen";
      while (capture.candidateRequests.size > 48) {
        const oldest = capture.candidateRequests.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        capture.candidateRequests.delete(oldest);
      }
    }
    return;
  }

  if (method === "Network.responseReceived" && typeof params.requestId === "string") {
    const candidate = capture.candidateRequests.get(
      enhancedDebuggerRequestKey(source, params.requestId),
    );
    if (
      !candidate ||
      !isRecord(params.response) ||
      !isConversationNetworkResponse(params.response, candidate.url) ||
      (capture.requestId !== undefined &&
        (capture.requestId !== params.requestId ||
          enhancedDebuggerSessionKey(capture.requestTarget ?? { tabId }) !==
            enhancedDebuggerSessionKey(source)))
    ) {
      return;
    }
    capture.requestId = params.requestId;
    capture.requestTarget = candidate.target;
    capture.responseMimeType =
      typeof params.response.mimeType === "string"
        ? params.response.mimeType.slice(0, 80)
        : undefined;
    capture.responsePath = chatGptNetworkUrl(params.response.url ?? candidate.url)?.pathname.slice(
      0,
      160,
    );
    capture.lastStage = "response-matched";
    const debuggerApi = chromeWithOptionalDebugging.debugger;
    if (!debuggerApi) return;
    let streamArm = await candidate.streamArm;
    if (enhancedDebuggerCaptures.get(tabId) !== capture) return;
    if (!streamArm.ok) {
      // Retrying after headers is a compatibility fallback for Chrome builds
      // that do not accept the command during requestWillBeSent.
      streamArm = await armEnhancedResponseStream(candidate.target, params.requestId);
    }
    if (streamArm.ok) {
      capture.streamStarted = true;
      capture.lastStage = "stream-started";
      const streamed = streamArm.response;
      if (isRecord(streamed) && typeof streamed.bufferedData === "string") {
        const networkDone = consumeEnhancedResponseText(
          capture,
          decodeEnhancedBase64Chunk(streamed.bufferedData, capture.textDecoder),
        );
        const webSocketDone = consumeBufferedHandoffItems(capture);
        void queueEnhancedDebuggerSnapshot(tabId, capture);
        if (capture.latestMarkdown && (webSocketDone || (networkDone && !capture.handoffTopicId))) {
          await finalizeEnhancedDebuggerCapture(tabId, capture, false);
        }
      }
    } else {
      // Older Chrome builds can reject the experimental streaming command.
      // Keep the debugger attached and use getResponseBody after loadingFinished.
      capture.lastStage = "stream-unavailable";
      capture.lastError = streamArm.error;
    }
    return;
  }

  const eventMatchesRequest =
    params.requestId === capture.requestId &&
    enhancedDebuggerSessionKey(capture.requestTarget ?? { tabId }) ===
      enhancedDebuggerSessionKey(source);

  if (method === "Network.dataReceived" && eventMatchesRequest && typeof params.data === "string") {
    capture.lastStage = "stream-data";
    const networkDone = consumeEnhancedResponseText(
      capture,
      decodeEnhancedBase64Chunk(params.data, capture.textDecoder),
    );
    const webSocketDone = consumeBufferedHandoffItems(capture);
    void queueEnhancedDebuggerSnapshot(tabId, capture);
    if (capture.latestMarkdown && (webSocketDone || (networkDone && !capture.handoffTopicId))) {
      await finalizeEnhancedDebuggerCapture(tabId, capture, false);
    }
    return;
  }

  if (method === "Network.loadingFailed" && eventMatchesRequest) {
    capture.lastStage = "loading-failed";
    capture.lastError =
      typeof params.errorText === "string" ? params.errorText.slice(0, 240) : undefined;
    await detachEnhancedDebugger(tabId, capture.runId);
    return;
  }

  if (method !== "Network.loadingFinished" || !eventMatchesRequest) return;
  // Events for this capture are serialized by eventQueue. By the time the HTTP
  // terminal is handled, every earlier buffered chunk has already exposed any
  // WebSocket handoff; no timer-based race window is required.
  if (enhancedDebuggerCaptures.get(tabId) !== capture || capture.processing) return;
  if (capture.handoffTopicId) {
    capture.lastStage = "handoff-waiting";
    rememberEnhancedDebuggerDiagnostic(capture);
    return;
  }
  capture.lastStage = "loading-finished";
  await finalizeEnhancedDebuggerCapture(tabId, capture, true);
}

async function finalizeEnhancedDebuggerCapture(
  tabId: number,
  capture: EnhancedDebuggerCapture,
  allowWholeBodyFallback: boolean,
) {
  if (enhancedDebuggerCaptures.get(tabId) !== capture || capture.processing) return;
  capture.processing = true;
  const debuggerApi = chromeWithOptionalDebugging.debugger;
  if (!debuggerApi || !capture.requestId || !capture.requestTarget) {
    await detachEnhancedDebugger(tabId, capture.runId);
    return;
  }

  let markdown = capture.latestMarkdown;
  let waitForHandoff = false;
  try {
    const decoderTail = capture.textDecoder.decode();
    if (decoderTail) consumeEnhancedResponseText(capture, decoderTail);
    const finishedMarkdown = usableAssistantMarkdown(capture.responseDecoder.finish() ?? "");
    if (finishedMarkdown) capture.latestMarkdown = finishedMarkdown;
    markdown = capture.latestMarkdown;
    await queueEnhancedDebuggerSnapshot(tabId, capture);
    if (!markdown && allowWholeBodyFallback) {
      const response = (await debuggerApi.sendCommand(
        capture.requestTarget,
        "Network.getResponseBody",
        {
          requestId: capture.requestId,
        },
      )) as unknown;
      if (isRecord(response) && typeof response.body === "string") {
        const responseBody = response.body;
        const body =
          response.base64Encoded === true
            ? decodeEnhancedBase64Chunk(responseBody, new TextDecoder(), false)
            : responseBody;
        if (body.length > MAX_ENHANCED_RESPONSE_CHARS) {
          throw new Error("Enhanced response exceeded the in-memory decoder limit.");
        }
        const fallbackDecoder = new ConversationResponseDecoder();
        const pushedMarkdown = usableAssistantMarkdown(fallbackDecoder.push(body) ?? "");
        const finishedFallbackMarkdown = usableAssistantMarkdown(fallbackDecoder.finish() ?? "");
        markdown = finishedFallbackMarkdown || pushedMarkdown;
        if (markdown) capture.latestMarkdown = markdown;
        const fallbackHandoffTopicId = fallbackDecoder.streamHandoffTopicId();
        if (fallbackHandoffTopicId) {
          // A very short turn can finish its HTTP handoff before the async
          // streamResourceContent command exposes buffered bytes. Preserve the
          // body decoder and keep the debugger attached so already-queued
          // WebSocket frames are consumed by the exact handoff topic.
          capture.responseDecoder = fallbackDecoder;
          capture.handoffTopicId = fallbackHandoffTopicId;
          capture.networkCompletionProbe = body.slice(-128);
          capture.decodedChars = Math.max(capture.decodedChars, body.length);
          const bufferedDone = consumeBufferedHandoffItems(capture);
          markdown = capture.latestMarkdown;
          await queueEnhancedDebuggerSnapshot(tabId, capture);
          capture.lastStage = bufferedDone ? "websocket-buffer-terminal" : "handoff-waiting";
          waitForHandoff = !bufferedDone;
        }
      }
    }
  } catch (error) {
    // The exact-transcript DOM recovery below remains available when Chrome
    // cannot return a completed response body.
    capture.lastStage = "body-read-failed";
    capture.lastError = enhancedDebuggerErrorMessage(error);
  }

  if (waitForHandoff && enhancedDebuggerCaptures.get(tabId) === capture) {
    capture.processing = false;
    rememberEnhancedDebuggerDiagnostic(capture);
    if (capture.latestMarkdown) void queueEnhancedDebuggerSnapshot(tabId, capture);
    return;
  }
  await detachEnhancedDebugger(tabId, capture.runId);

  const run = activeRuns.get(capture.key);
  const tab = conversationTabs.get(capture.key);
  if (!run || run.runId !== capture.runId || run.tabId !== tabId || tab?.tabId !== tabId) return;

  if (!markdown) {
    const expectedRemoteUrl = run.dispatchTranscriptBaseline?.remoteUrl ?? tab.remoteUrl;
    const snapshot = expectedRemoteUrl
      ? await readNetworkCompletedSnapshotForActiveRun(capture.key, run, tab, expectedRemoteUrl)
      : undefined;
    if (snapshot) {
      await settleRunFromCompletedSnapshot(
        capture.key,
        run,
        tab,
        snapshot,
        forwardedSnapshots.get(capture.key),
      );
    }
    return;
  }

  const currentTab = await chrome.tabs.get(tabId).catch(() => undefined);
  const currentRemoteUrl = normalizeRemoteConversationUrl(currentTab?.url);
  const attestedRemoteUrl =
    run.remoteAdoptionStage !== "initial" &&
    tab.remoteUrl &&
    currentRemoteUrl &&
    sameChatGptConversationIdentity(tab.remoteUrl, currentRemoteUrl)
      ? tab.remoteUrl
      : undefined;
  const event = parseContentEvent({
    type: "content.event",
    eventType: "complete",
    conversationId: run.conversationId,
    runId: run.runId,
    markdown,
    ...(attestedRemoteUrl ? { remoteUrl: attestedRemoteUrl } : {}),
  });
  if (!event) return;
  await handleContentEvent(
    event,
    tabId,
    undefined,
    attestedRemoteUrl,
    undefined,
    "enhanced-debugger",
  );
}

async function initialize() {
  const [session, local] = await Promise.all([
    chrome.storage.session.get([
      "conversationTabsV2",
      "activeRunsV2",
      "completedCanonicalizationsV1",
      TERMINAL_HISTORY_BARRIER_STORAGE_KEY,
      "pendingEventsV2",
      RUN_VISIBILITY_LEASE_STORAGE_KEY,
      PROJECT_DISCOVERY_TAB_STORAGE_KEY,
      PROJECT_BINDING_VERIFICATION_STORAGE_KEY,
      PROJECT_SETUP_STORAGE_KEY,
    ]),
    chrome.storage.local.get([
      PROJECT_BINDING_STORAGE_KEY,
      LEGACY_PROJECT_BINDING_STORAGE_KEY,
      RELAY_RELOAD_CHECKPOINT_STORAGE_KEY,
      CONVERSATION_TRANSCRIPT_CACHE_STORAGE_KEY,
      ENHANCED_BACKGROUND_STORAGE_KEY,
      ...LEGACY_PROJECT_BINDING_STORAGE_KEYS,
    ]),
  ]);

  const storedEnhancedBackgroundPreference = local[ENHANCED_BACKGROUND_STORAGE_KEY];
  const enhancedBackgroundRequested =
    storedEnhancedBackgroundPreference === undefined
      ? ENHANCED_BACKGROUND_DEFAULT_ENABLED
      : storedEnhancedBackgroundPreference === true;
  enhancedBackgroundEnabled = enhancedBackgroundRequested && (await hasDebuggerPermission());
  if (local[ENHANCED_BACKGROUND_STORAGE_KEY] === true && !enhancedBackgroundEnabled) {
    await chrome.storage.local
      .set({ [ENHANCED_BACKGROUND_STORAGE_KEY]: false })
      .catch(() => undefined);
  }

  const reloadCheckpoint = parseRelayReloadCheckpoint(local[RELAY_RELOAD_CHECKPOINT_STORAGE_KEY]);
  conversationTranscriptFingerprints.clear();
  attestedConversationTranscriptChains.clear();
  for (const fingerprint of parseStoredConversationTranscriptFingerprints(
    local[CONVERSATION_TRANSCRIPT_CACHE_STORAGE_KEY],
  )) {
    conversationTranscriptFingerprints.set(fingerprint.remoteUrl, fingerprint);
  }

  replaceMap(
    conversationTabs,
    parseStoredTabs(session.conversationTabsV2 ?? reloadCheckpoint?.conversationTabs),
  );
  replaceMap(activeRuns, parseStoredRuns(session.activeRunsV2 ?? reloadCheckpoint?.activeRuns));
  runPromptFingerprints.clear();
  runDispatchTranscriptBaselines.clear();
  preparedDispatchTranscriptBaselines.clear();
  for (const [key, run] of activeRuns) {
    if (run.promptSha256) runPromptFingerprints.set(key, run.promptSha256);
    if (run.dispatchTranscriptBaseline) {
      runDispatchTranscriptBaselines.set(key, {
        runId: run.runId,
        ...run.dispatchTranscriptBaseline,
      });
    }
  }
  replaceMap(
    completedCanonicalizations,
    parseStoredCompletedCanonicalizations(
      session.completedCanonicalizationsV1 ?? reloadCheckpoint?.completedCanonicalizations,
    ),
  );
  replaceMap(
    terminalHistoryBarriers,
    parseStoredTerminalHistoryBarriers(
      session[TERMINAL_HISTORY_BARRIER_STORAGE_KEY] ?? reloadCheckpoint?.terminalHistoryBarriers,
    ),
  );
  replaceMap(pendingEvents, parseStoredPendingEvents(session.pendingEventsV2));
  committedPendingEventKeys.clear();
  const pendingCompleteBarrierCandidates = new Map<string, PendingEventRecord>();
  for (const key of pendingEvents.keys()) committedPendingEventKeys.add(key);
  for (const pending of pendingEvents.values()) {
    if (!isTerminalEvent(pending.event)) continue;
    const key = conversationKey(pending.instanceId, pending.event.conversationId);
    if (activeRuns.get(key)?.runId === pending.event.runId) activeRuns.delete(key);
    const tab = conversationTabs.get(key);
    if (
      pending.event.eventType === "complete" &&
      tab &&
      (pending.tabId === undefined || pending.tabId === tab.tabId)
    ) {
      const prior = pendingCompleteBarrierCandidates.get(key);
      if (!prior || Date.parse(pending.startedAt) >= Date.parse(prior.startedAt)) {
        pendingCompleteBarrierCandidates.set(key, pending);
      }
    }
  }
  for (const [key, pending] of pendingCompleteBarrierCandidates) {
    if (terminalHistoryBarriers.has(key)) continue;
    const tab = conversationTabs.get(key)!;
    terminalHistoryBarriers.set(key, {
      instanceId: pending.instanceId,
      conversationId: pending.event.conversationId,
      runId: pending.event.runId,
      tabId: tab.tabId,
      terminalMarkdownSha256: await sha256Hex(pending.event.markdown ?? ""),
      createdAt: new Date().toISOString(),
    });
  }
  const storedProjectDiscoveryTabId = session[PROJECT_DISCOVERY_TAB_STORAGE_KEY];
  projectDiscoveryTabId =
    Number.isSafeInteger(storedProjectDiscoveryTabId) &&
    Number(storedProjectDiscoveryTabId) >= 0 &&
    ![...conversationTabs.values()].some(
      (record) => record.tabId === Number(storedProjectDiscoveryTabId),
    )
      ? Number(storedProjectDiscoveryTabId)
      : undefined;
  // V1/V2 records could be created from a Project-shaped URL without proving
  // its visible identity. Never migrate those guesses into the verified store.
  const storedTrustedProjectBinding = parseStoredTrustedProjectBinding(
    local[PROJECT_BINDING_STORAGE_KEY],
  );
  const storedLegacyProjectBinding = parseStoredProjectBinding(
    local[LEGACY_PROJECT_BINDING_STORAGE_KEY],
  );
  const validTrustedProjectBinding =
    storedTrustedProjectBinding && isRequiredProjectName(storedTrustedProjectBinding.name)
      ? storedTrustedProjectBinding
      : undefined;
  const validLegacyProjectBinding =
    storedLegacyProjectBinding && isRequiredProjectName(storedLegacyProjectBinding.name)
      ? storedLegacyProjectBinding
      : undefined;
  projectBinding = validTrustedProjectBinding ?? validLegacyProjectBinding;
  projectBindingTrusted = validTrustedProjectBinding !== undefined;
  // V6 records carry provenance from the strict visible-identity verifier and
  // are the durable authority across an ordinary MV3 worker/browser restart.
  // Legacy V5 candidates still require a fresh same-scope verification before
  // they can be used or migrated.
  projectBindingVerifiedThisSession = projectBindingTrusted;
  const storedProjectSetup = parseProjectSetupState(session[PROJECT_SETUP_STORAGE_KEY]);
  projectSetupState = projectBindingTrusted
    ? { phase: "idle" }
    : storedProjectSetup?.phase === "working"
      ? { phase: "error", reason: "PAGE_UNAVAILABLE" }
      : (storedProjectSetup ?? { phase: "idle" });
  await persistProjectSetupState();
  const obsoleteProjectKeys: string[] = [...LEGACY_PROJECT_BINDING_STORAGE_KEYS];
  if (local[PROJECT_BINDING_STORAGE_KEY] !== undefined && !validTrustedProjectBinding) {
    obsoleteProjectKeys.push(PROJECT_BINDING_STORAGE_KEY);
  }
  if (
    local[LEGACY_PROJECT_BINDING_STORAGE_KEY] !== undefined &&
    (!validLegacyProjectBinding || validTrustedProjectBinding)
  ) {
    obsoleteProjectKeys.push(LEGACY_PROJECT_BINDING_STORAGE_KEY);
  }
  await chrome.storage.local
    .remove([
      ...LEGACY_CONNECTION_STORAGE_KEYS,
      ...obsoleteProjectKeys,
      RELAY_RELOAD_CHECKPOINT_STORAGE_KEY,
    ])
    .catch(() => undefined);
  if (projectDiscoveryTabId !== undefined) {
    const storedDiscoveryTab = await chrome.tabs.get(projectDiscoveryTabId).catch(() => undefined);
    if (!isReusableProjectDiscoveryHome(storedDiscoveryTab)) {
      await relinquishProjectDiscoveryTab(projectDiscoveryTabId);
    }
  }
  await reconcileStoredState();
  await restoreStoredRunVisibilityLeases(
    session[RUN_VISIBILITY_LEASE_STORAGE_KEY] ?? reloadCheckpoint?.runVisibilityLeases,
  );
  if (reloadCheckpoint) {
    await persistSession();
    if (projectBinding && projectBindingVerifiedThisSession) {
      await chrome.storage.session.set({
        [PROJECT_BINDING_VERIFICATION_STORAGE_KEY]: {
          version: 1,
          projectUrl: projectBinding.projectUrl,
          boundAt: projectBinding.boundAt,
        },
      });
    }
  }
  await chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
  scanPorts();
  if (reloadCheckpoint) await restoreMappedContentRuntimesAfterRelayReload();
  await recoverAllRuns();
}

async function restoreMappedContentRuntimesAfterRelayReload() {
  const recordsByTabId = new Map<number, [string, TabRecord]>();
  for (const [key, record] of conversationTabs) {
    if (!recordsByTabId.has(record.tabId)) recordsByTabId.set(record.tabId, [key, record]);
  }
  await Promise.all(
    [...recordsByTabId].map(async ([tabId]) => {
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (!tab || !isChatGptPageUrl(tab.url)) return;
      const currentUrl = normalizeRemoteConversationUrl(tab.url);
      if (!currentUrl) return;
      try {
        // chrome.runtime.reload() invalidates content-script extension contexts
        // in already-open pages. Reinstall the idempotent MAIN bridge and the
        // current isolated runtime into each exact owned page without reloading
        // ChatGPT, so its hydrated transcript and minimized-window state survive.
        await installCurrentContentRuntimeFiles(tabId);
      } catch {
        recordBackgroundFailure("Failed to restore a mapped content runtime after Relay reload.");
      }
    }),
  );
}

function scanPorts() {
  if (relayReloadPreparationActive) return;
  for (const port of RELAY_PORTS) {
    const existing = connections.get(port);
    if (
      existing &&
      (existing.socket.readyState === WebSocket.OPEN ||
        existing.socket.readyState === WebSocket.CONNECTING)
    ) {
      continue;
    }
    if (!reconnectTimers.has(port)) connectPort(port);
  }
}

function connectPort(port: number) {
  if (relayReloadPreparationActive) return undefined;
  clearReconnectTimer(port);

  const existing = connections.get(port);
  if (
    existing &&
    (existing.socket.readyState === WebSocket.OPEN ||
      existing.socket.readyState === WebSocket.CONNECTING)
  ) {
    return existing;
  }
  if (existing) {
    clearConnectTimer(existing);
    connections.delete(port);
  }

  let socket: WebSocket;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}`, RELAY_WEBSOCKET_PROTOCOL);
  } catch {
    scheduleReconnect(port);
    return undefined;
  }

  const connection: RelayConnection = {
    port,
    socket,
    backoffAttemptAtConnect: reconnectAttempts.get(port) ?? 0,
    messageQueue: Promise.resolve(),
    transportState: "connecting",
    authenticated: false,
  };
  connections.set(port, connection);

  connection.connectTimer = setTimeout(() => {
    if (
      connections.get(port) !== connection ||
      connection.socket.readyState !== WebSocket.CONNECTING
    ) {
      return;
    }
    connection.transportState = "error";
    connections.delete(port);
    lastError = `VS Code relay connection on port ${port} timed out.`;
    try {
      connection.socket.close(4000, "Relay connection timed out");
    } catch {
      // A browser may reject close() while the opening handshake is still
      // pending. Dropping this stale connection from the map is sufficient;
      // its eventual open/close event is ignored below.
    }
    scheduleReconnect(port);
  }, RELAY_CONNECT_TIMEOUT_MS);

  socket.addEventListener("open", () => {
    if (connections.get(port) !== connection) {
      socket.close(4001, "Stale relay connection");
      return;
    }
    clearConnectTimer(connection);
    connection.transportState = "open";
    // Opening the TCP/WebSocket transport does not prove that the Host and
    // Relay versions are compatible. Keep the accumulated backoff until the
    // full relay.ready/relay.hello handshake authenticates this route;
    // otherwise a stale extension can reconnect and flood logs every second.
    connection.connectTimer = setTimeout(() => {
      if (connections.get(port) !== connection || connection.authenticated) return;
      connection.transportState = "error";
      lastError = `端口 ${port} 已响应，但 VS Code 未在 5 秒内完成 relay.ready 握手。请确认两端版本一致。`;
      connections.delete(port);
      connection.socket.close(4000, "Relay ready timed out");
      scheduleReconnect(port);
    }, RELAY_CONNECT_TIMEOUT_MS);
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      socket.close(1003, "Text frames only");
      return;
    }
    const raw = event.data;
    if (utf8ByteLength(raw) > MAX_RELAY_FRAME_BYTES) {
      lastError = "Relay frame exceeded the 2 MiB limit.";
      socket.close(1009, "Frame too large");
      return;
    }
    const dispatch = connection.messageQueue.then(() => handleRelayMessage(connection, raw));
    if (connection.authenticated) {
      // Authentication is ordered once per connection. After that, the
      // existing per-conversation queue is the correct serialization boundary:
      // a cold tab in one conversation must not block another send or Stop.
      void dispatch.catch(() => handleRelayDispatchFailure(connection));
    } else {
      connection.messageQueue = dispatch.catch(() => handleRelayDispatchFailure(connection));
    }
  });
  socket.addEventListener("close", (event) => {
    clearConnectTimer(connection);
    if (connections.get(port)?.socket !== socket) return;
    if (connection.instanceId) clearPendingEventRetriesForInstance(connection.instanceId);
    const closeDiagnostic = describeVersionMismatchClose(port, event.code, event.reason);
    if (closeDiagnostic) {
      connection.authenticated = false;
      connection.transportState = "error";
      restoreReconnectBackoff(connection);
      if (!lastError?.includes("PROTOCOL_MISMATCH")) lastError = closeDiagnostic;
    }
    if (event.code === 4003) {
      // Another healthy socket already owns this VS Code instance. Avoid a
      // tight duplicate-scanner loop while still retrying soon enough if the
      // authoritative socket disappears during an extension upgrade.
      reconnectAttempts.set(port, Math.max(reconnectAttempts.get(port) ?? 0, 3));
    }
    connections.delete(port);
    scheduleReconnect(port);
  });
  socket.addEventListener("error", () => {
    if (connections.get(port) === connection) connection.transportState = "error";
  });
  return connection;
}

function handleRelayDispatchFailure(connection: RelayConnection) {
  recordBackgroundFailure("Relay message handling failed.");
  if (connection.authenticated && connection.instanceId) {
    sendConnection(
      connection,
      makeEnvelope({
        type: "relay.error",
        instanceId: connection.instanceId,
        payload: {
          code: "INTERNAL_ERROR",
          message: "Chrome relay could not complete the requested operation.",
          recoverable: true,
        } satisfies RelayErrorPayload,
      }),
    );
  }
  connection.authenticated = false;
  connection.socket.close(1011, "Relay operation failed");
}

function scheduleReconnect(port: number) {
  if (relayReloadPreparationActive) return;
  if (reconnectTimers.has(port)) return;
  const attempt = reconnectAttempts.get(port) ?? 0;
  reconnectAttempts.set(port, attempt + 1);
  const timer = setTimeout(() => {
    reconnectTimers.delete(port);
    const existing = connections.get(port);
    if (
      !existing ||
      (existing.socket.readyState !== WebSocket.OPEN &&
        existing.socket.readyState !== WebSocket.CONNECTING)
    ) {
      connectPort(port);
    }
  }, reconnectDelay(attempt));
  reconnectTimers.set(port, timer);
}

function restoreReconnectBackoff(connection: RelayConnection) {
  const currentAttempt = reconnectAttempts.get(connection.port);
  if (currentAttempt === undefined || currentAttempt < connection.backoffAttemptAtConnect) {
    reconnectAttempts.set(connection.port, connection.backoffAttemptAtConnect);
  }
}

function describeVersionMismatchClose(port: number, code: number, reason: string) {
  if (code !== 1002 && !/(?:update|protocol mismatch)/iu.test(reason)) return undefined;
  return `VS Code 与 Chrome Relay 的版本或协议不一致（PROTOCOL_MISMATCH，端口 ${port}）。请同时更新两端，再从 Chrome 工具栏打开 Ask2GPT Relay 并点击“重新加载 Relay”。`;
}

function clearReconnectTimer(port: number) {
  const timer = reconnectTimers.get(port);
  if (timer) clearTimeout(timer);
  reconnectTimers.delete(port);
}

function clearConnectTimer(connection: RelayConnection) {
  if (connection.connectTimer) clearTimeout(connection.connectTimer);
  connection.connectTimer = undefined;
}

function rescanPortsNow(clearPreviousError = true) {
  clearReconnectTimers();
  for (const [port, connection] of connections) {
    if (connection.authenticated) continue;
    clearConnectTimer(connection);
    connections.delete(port);
    try {
      connection.socket.close(4001, "Manual relay rescan");
    } catch {
      // A CONNECTING socket can reject close(); stale events are ignored.
    }
  }
  if (clearPreviousError) lastError = undefined;
  scanPorts();
}

async function handleRelayMessage(connection: RelayConnection, raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    rejectProtocol(connection, undefined, "Relay message was not valid JSON.");
    return;
  }
  const result = safeParseRelayEnvelope(parsed);
  if (!result.success) {
    const parsedVersion = isRecord(parsed) ? parsed.version : undefined;
    if (typeof parsedVersion === "number" && parsedVersion === PROTOCOL_VERSION) {
      rejectProtocol(connection, undefined, "Relay message failed schema validation.");
    } else {
      const detectedVersion =
        typeof parsedVersion === "number" ? `v${String(parsedVersion)}` : "旧版本";
      rejectProtocol(
        connection,
        undefined,
        `VS Code 插件使用 ${detectedVersion} 协议，Chrome Relay 需要 v${PROTOCOL_VERSION}。请同时更新并重新加载两端。`,
      );
    }
    return;
  }
  const envelope = result.data as RelayEnvelope;
  if (!isHostToChromeMessageType(envelope.type)) {
    rejectProtocol(connection, envelope, "Relay message direction is not allowed from VS Code.");
    return;
  }
  if (!connection.authenticated && envelope.type === "relay.ready") {
    const identity = parseRelayReadyIdentity(envelope.instanceId, envelope.payload);
    if (!identity || !pinInstanceId(connection, identity.instanceId)) {
      rejectProtocol(connection, envelope, "VS Code relay identity was inconsistent.");
      return;
    }
    connection.label = identity.label;
    sendConnection(
      connection,
      makeEnvelope({
        type: "relay.hello",
        instanceId: connection.instanceId!,
        payload: {
          chromeExtensionId: chrome.runtime.id as typeof CHROME_EXTENSION_ID,
          chromeVersion: chrome.runtime.getManifest().version,
        },
      }),
    );
    await authenticateConnection(connection);
    return;
  }

  if (envelope.type === "relay.error") {
    if (!pinInstanceId(connection, envelope.instanceId)) return;
    handleHostRelayError(connection, envelope);
    return;
  }
  if (!connection.authenticated) {
    rejectProtocol(
      connection,
      envelope,
      `VS Code 未先发送 relay.ready。请同时更新并重新加载 v${PROTOCOL_VERSION} 两端。`,
    );
    return;
  }
  if (!pinInstanceId(connection, envelope.instanceId)) return;

  if (envelope.conversationId) {
    const key = conversationKey(connection.instanceId!, envelope.conversationId);
    await withConversationCommand(key, async () => {
      await dispatchAuthenticatedEnvelope(connection, envelope);
    });
    return;
  }
  await dispatchAuthenticatedEnvelope(connection, envelope);
}

function handleHostRelayError(connection: RelayConnection, envelope: RelayEnvelope) {
  const payload = parseRelayError(envelope.payload);
  if (!payload) {
    rejectProtocol(connection, envelope, "Invalid relay.error payload.");
    return;
  }

  connection.transportState = "error";
  lastError =
    payload.code === "PROTOCOL_MISMATCH"
      ? `VS Code 与 Chrome Relay 的版本不一致（PROTOCOL_MISMATCH）：${payload.message} 请同时更新两端，再从 Chrome 工具栏打开 Ask2GPT Relay 并点击“重新加载 Relay”。`
      : `${payload.code}: ${payload.message}`;

  if (payload.recoverable) return;

  connection.authenticated = false;
  if (payload.code === "PROTOCOL_MISMATCH") restoreReconnectBackoff(connection);
  connection.socket.close(
    payload.code === "PROTOCOL_MISMATCH" ? 1002 : 1008,
    payload.code === "PROTOCOL_MISMATCH" ? "Protocol mismatch" : "Relay rejected connection",
  );
}

async function dispatchAuthenticatedEnvelope(connection: RelayConnection, envelope: RelayEnvelope) {
  if (
    relayReloadPreparationActive &&
    envelope.type !== "heartbeat" &&
    envelope.type !== "generation.ack" &&
    envelope.type !== "relay.status.request"
  ) {
    if (
      (envelope.type === "conversation.send" || envelope.type === "generation.regenerate") &&
      envelope.conversationId &&
      envelope.runId
    ) {
      await reportRejectedRun(
        connection,
        envelope.conversationId,
        envelope.runId,
        "CHATGPT_REMOTE_UNAVAILABLE",
        "Relay 正在重新加载，本次问题尚未发送。连接恢复后请重试。",
      );
    } else {
      sendError(
        connection,
        envelope,
        "CHATGPT_REMOTE_UNAVAILABLE",
        "Relay 正在重新加载，请等待连接恢复后重试。",
      );
    }
    return;
  }
  if (envelope.type === "heartbeat") {
    // A host-initiated application heartbeat wakes the MV3 service worker
    // even when Chrome is fully occluded. Acknowledge it once; the host does
    // not echo acknowledgements, so this cannot form a ping-pong loop.
    sendConnection(
      connection,
      makeEnvelope({
        type: "heartbeat",
        instanceId: connection.instanceId!,
        payload: { at: new Date().toISOString() },
      }),
    );
    await flushPendingEvents(connection.instanceId!);
    // Host heartbeats are the reliable wake-up source while MV3 timers and
    // the ChatGPT page are both backgrounded. Check active runs here as well
    // as on the best-effort one-second timer so a minimized window cannot
    // leave VS Code showing a partial answer forever.
    await checkpointActiveRuns().catch(() => {
      recordBackgroundFailure("Active run heartbeat recovery failed.");
    });
    await recoverTerminalHistoryBarriers();
  } else if (envelope.type === "conversation.open") {
    await handleOpen(connection, envelope);
  } else if (envelope.type === "conversation.canonicalization.check") {
    await handleCanonicalizationCheck(connection, envelope);
  } else if (envelope.type === "conversation.send") {
    await handleSend(connection, envelope);
  } else if (envelope.type === "generation.stop") {
    await handleStop(connection, envelope);
  } else if (envelope.type === "generation.ack") {
    await handleGenerationAck(connection, envelope);
  } else if (envelope.type === "generation.regenerate") {
    await handleRegenerate(connection, envelope);
  } else if (envelope.type === "model.list") {
    await handleModelList(connection, envelope);
  } else if (envelope.type === "model.select") {
    await handleModelSelect(connection, envelope);
  } else if (envelope.type === "conversation.close") {
    await handleClose(connection, envelope);
  } else if (envelope.type === "relay.status.request") {
    const pendingTerminalKeysBeforeRecovery = new Set(
      [...pendingEvents]
        .filter(
          ([, pending]) =>
            pending.instanceId === connection.instanceId && isTerminalEvent(pending.event),
        )
        .map(([key]) => key),
    );
    // A committed terminal removes its run from `activeRuns` before it is
    // delivered. Flush that durable outbox first so the Host can never observe
    // `activeRuns: 0` and conclude the run is idle before its terminal event is
    // present on the same ordered WebSocket connection.
    try {
      await flushPendingEvents(connection.instanceId!);
    } catch {
      // Transient snapshots are removed after their socket send and then
      // checkpointed. A storage failure at that final step must not suppress
      // the requested status; every committed terminal has already been sent
      // synchronously before `flushPendingEvents` reaches persistence.
      recordBackgroundFailure("Relay outbox flush before requested status failed.");
    }
    // A status poll is also a read-only recovery checkpoint. It never focuses
    // the mapped tab and recoverRun never replays content.send, but it can wake
    // a content runtime whose page timers were suspended while Chrome was
    // occluded.
    await recoverInstanceRuns(connection.instanceId!, { focusOnFailure: false }).catch(() => {
      recordBackgroundFailure("Relay recovery before requested status failed.");
    });
    // Recovery may have committed a terminal. Preserve one socket ordering:
    // terminal event first, then the status that reports no active run.
    await flushPendingEvents(connection.instanceId!, {
      // A transient snapshot that failed the first flush may still be retried;
      // only already-replayed terminals must be suppressed here. Otherwise an
      // unacknowledged terminal would be sent twice by one status request.
      skipKeys: pendingTerminalKeysBeforeRecovery,
    }).catch(() => {
      recordBackgroundFailure("Relay outbox flush after requested recovery failed.");
    });
    sendStatus(connection, true);
  }
}

async function handleGenerationAck(connection: RelayConnection, envelope: RelayEnvelope) {
  const conversationId = requireConversationId(connection, envelope);
  const runId = requireRunId(connection, envelope);
  const payload = envelope.payload as GenerationAckPayload;
  if (!conversationId || !runId) return;

  const match = [...pendingEvents.entries()].find(
    ([, pending]) =>
      pending.instanceId === connection.instanceId &&
      pending.event.conversationId === conversationId &&
      pending.event.runId === runId &&
      pending.eventId === payload.eventId &&
      isTerminalEvent(pending.event),
  );
  if (!match) return;

  const [key] = match;
  pendingEvents.delete(key);
  committedPendingEventKeys.delete(key);
  clearPendingEventRetry(key);
  await persistSession();
}

async function handleModelList(connection: RelayConnection, envelope: RelayEnvelope) {
  const conversationId = requireConversationId(connection, envelope);
  const payload = parseModelListPayload(envelope.payload);
  if (!conversationId || !payload) {
    rejectProtocol(connection, envelope, "Invalid model.list payload.");
    return;
  }
  const key = conversationKey(connection.instanceId!, conversationId);
  const cached = readCachedModelCatalog(key);
  if (cached) {
    sendModelCatalog(connection, conversationId, payload.requestId, cached);
    return;
  }
  if (activeRuns.has(key)) {
    sendError(connection, envelope, "CONVERSATION_BUSY", "回答生成期间不能切换 ChatGPT 模型。");
    return;
  }
  let tabId: number | undefined;
  try {
    tabId = await ensureConversationTab(connection.instanceId!, conversationId, payload.remoteUrl);
    const response = await readAndRememberModelCatalog(key, tabId);
    sendModelCatalog(connection, conversationId, payload.requestId, response);
  } catch (error) {
    await sendCaughtError(connection, envelope, error, "CHATGPT_MODEL_UNAVAILABLE", false, tabId);
  }
}

async function handleModelSelect(connection: RelayConnection, envelope: RelayEnvelope) {
  const conversationId = requireConversationId(connection, envelope);
  const payload = parseModelSelectPayload(envelope.payload);
  if (!conversationId || !payload) {
    rejectProtocol(connection, envelope, "Invalid model.select payload.");
    return;
  }
  const key = conversationKey(connection.instanceId!, conversationId);
  if (activeRuns.has(key)) {
    sendError(connection, envelope, "CONVERSATION_BUSY", "回答生成期间不能切换 ChatGPT 模型。");
    return;
  }
  const catalog = readCachedModelCatalog(key);
  const target = catalog?.options.find((option) => option.id === payload.modelId);
  if (!target) {
    sendError(
      connection,
      envelope,
      "CHATGPT_MODEL_SELECTION_FAILED",
      "所选模式已不在最近同步的 ChatGPT 可用列表中，请重新打开选择器。",
    );
    return;
  }
  let tabId: number | undefined;
  try {
    tabId = await ensureConversationTab(connection.instanceId!, conversationId, payload.remoteUrl);
    const rawResponse = await sendToTab(
      tabId,
      {
        type: "content.model.select",
        option: target,
      },
      {
        totalTimeoutMs: CONTENT_MODEL_COMMAND_TIMEOUT_MS,
        responseTimeoutMs: CONTENT_MODEL_COMMAND_TIMEOUT_MS,
      },
    );
    throwModelContentFailure(rawResponse, "CHATGPT_MODEL_SELECTION_FAILED", tabId);
    const selected = parseModelSelectedResponse(rawResponse);
    if (!selected) {
      throw relayFailure("CHATGPT_MODEL_SELECTION_FAILED", "ChatGPT 没有确认所选模型。", tabId);
    }
    conversationModelSelections.set(key, selected.id);
    sendConnection(
      connection,
      makeEnvelope({
        type: "model.selected",
        instanceId: connection.instanceId!,
        conversationId,
        payload: { requestId: payload.requestId, selected },
      }),
    );
  } catch (error) {
    await sendCaughtError(
      connection,
      envelope,
      error,
      "CHATGPT_MODEL_SELECTION_FAILED",
      false,
      tabId,
    );
  }
}

function rememberModelCatalog(
  key: string,
  catalog: { options: ChatModelOption[]; currentModelId?: string },
) {
  const currentModelId =
    catalog.currentModelId ?? catalog.options.find((option) => option.selected)?.id;
  if (currentModelId) conversationModelSelections.set(key, currentModelId);
  modelCatalogCache = {
    options: catalog.options.map((option) => ({ ...option, selected: false })),
    ...(currentModelId ? { defaultModelId: currentModelId } : {}),
    expiresAt: Date.now() + MODEL_CATALOG_TTL_MS,
  };
}

function readCachedModelCatalog(key: string) {
  if (!modelCatalogCache || modelCatalogCache.expiresAt <= Date.now()) {
    modelCatalogCache = undefined;
    return undefined;
  }
  const currentModelId = conversationModelSelections.get(key) ?? modelCatalogCache.defaultModelId;
  return {
    options: modelCatalogCache.options.map((option) => ({
      ...option,
      selected: option.id === currentModelId,
    })),
    ...(currentModelId ? { currentModelId } : {}),
  };
}

async function readAndRememberModelCatalog(key: string, tabId: number) {
  const rawResponse = await sendToTab(
    tabId,
    { type: "content.model.list" },
    {
      totalTimeoutMs: CONTENT_MODEL_COMMAND_TIMEOUT_MS,
      responseTimeoutMs: CONTENT_MODEL_COMMAND_TIMEOUT_MS,
    },
  );
  throwModelContentFailure(rawResponse, "CHATGPT_MODEL_UNAVAILABLE", tabId);
  const response = parseModelCatalogResponse(rawResponse);
  if (!response) {
    throw relayFailure(
      "CHATGPT_MODEL_UNAVAILABLE",
      "未能从 ChatGPT 当前会话读取有效模型挡位。",
      tabId,
    );
  }
  rememberModelCatalog(key, response);
  return response;
}

function sendModelCatalog(
  connection: RelayConnection,
  conversationId: string,
  requestId: string,
  catalog: { options: ChatModelOption[]; currentModelId?: string },
) {
  sendConnection(
    connection,
    makeEnvelope({
      type: "model.catalog",
      instanceId: connection.instanceId!,
      conversationId,
      payload: { requestId, ...catalog },
    }),
  );
}

async function withConversationCommand<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = conversationCommands.get(key) ?? Promise.resolve();
  let resolveCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  conversationCommands.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    resolveCurrent();
    if (conversationCommands.get(key) === current) {
      conversationCommands.delete(key);
    }
  }
}

async function authenticateConnection(connection: RelayConnection) {
  clearConnectTimer(connection);
  const instanceId = connection.instanceId!;
  for (const other of connections.values()) {
    if (
      other !== connection &&
      other.authenticated &&
      shouldSupersedeRelayConnection(other.instanceId, instanceId)
    ) {
      other.authenticated = false;
      other.socket.close(4002, "Superseded by a newer relay connection");
    }
  }
  connection.authenticated = true;
  connection.transportState = "authenticated";
  reconnectAttempts.delete(connection.port);
  lastError = undefined;
  // A restored terminal is authoritative over the zero-active-run state. Send
  // the durable outbox before readiness so reconnecting Hosts observe the
  // terminal before an idle status on this ordered WebSocket connection.
  try {
    await flushPendingEvents(instanceId);
  } catch {
    recordBackgroundFailure("Relay outbox flush after authentication failed.");
  }
  // Report readiness before any slow ChatGPT-tab recovery so VS Code never looks
  // disconnected while a previous run is being inspected.
  sendStatus(connection, true);
  flushKnownConversationTitles(connection);
  void (async () => {
    try {
      // Reconnects must stay local. Resume only work that was already in
      // flight; do not inspect every known ChatGPT conversation while idle.
      await recoverInstanceRuns(instanceId);
      await recoverTerminalHistoryBarriers();
      if (
        connections.get(connection.port) === connection &&
        connection.authenticated &&
        connection.socket.readyState === WebSocket.OPEN
      ) {
        sendStatus(connection, true);
      }
    } catch {
      recordBackgroundFailure("Relay recovery after authentication failed.");
    }
  })();
}

async function handleOpen(connection: RelayConnection, envelope: RelayEnvelope) {
  const conversationId = requireConversationId(connection, envelope);
  const payload = parseOpenPayload(envelope.payload);
  if (!conversationId || !payload) {
    rejectProtocol(connection, envelope, "Invalid conversation.open payload.");
    return;
  }
  const key = conversationKey(connection.instanceId!, conversationId);
  const grant = completedCanonicalizations.get(key);
  let openRemoteUrl = payload.remoteUrl;
  if (grant?.toRemoteUrl) {
    if (
      payload.remoteUrl &&
      sameChatGptConversationIdentity(grant.toRemoteUrl, payload.remoteUrl)
    ) {
      completedCanonicalizations.delete(key);
      scheduleSessionPersist();
    } else if (
      !payload.remoteUrl ||
      sameChatGptConversationIdentity(grant.fromRemoteUrl, payload.remoteUrl)
    ) {
      // The Host can still know only A after a disconnect. Keep the attested B
      // mapping and resend its proof-bearing snapshot instead of navigating the
      // owned tab back to the provisional URL.
      openRemoteUrl = grant.toRemoteUrl;
    } else {
      completedCanonicalizations.delete(key);
      scheduleSessionPersist();
    }
  } else if (
    grant &&
    payload.remoteUrl &&
    !sameChatGptConversationIdentity(grant.fromRemoteUrl, payload.remoteUrl)
  ) {
    completedCanonicalizations.delete(key);
    scheduleSessionPersist();
  }
  try {
    const tabId = await ensureConversationTab(
      connection.instanceId!,
      conversationId,
      openRemoteUrl,
    );
    const record = conversationTabs.get(key);
    if (record?.tabId === tabId) {
      // Capture this before the initial snapshot read. A slow, not-yet-loaded
      // tab must not turn an old idle prewarm into a surprise parking-window
      // migration if the user minimizes Chrome several seconds later.
      // History refreshes need the same visibility truth as dispatch prewarm:
      // a normal-window but inactive ChatGPT tab can answer messages while its
      // entire transcript remains virtualized. Reading two local Chrome
      // records here is cheap and prevents an empty snapshot from becoming the
      // only result returned to the Host.
      const prewarmVisibility = await readTabDispatchVisibility(tabId);
      if (payload.transcriptProof) {
        prewarmConversationTranscriptProof(record, payload.transcriptProof);
      }
      if (payload.dispatchIntent) {
        // Composer focus/typing is an explicit near-term send signal. Begin the
        // visibility migration immediately and let the background prewarm own
        // the snapshot refresh, so a later generation.send can inherit the
        // already-ready window instead of creating one after the click.
        void prewarmConversationDispatchState(key, record, tabId, prewarmVisibility, true).catch(
          () => recordBackgroundFailure("Failed to prewarm a conversation dispatch window."),
        );
      } else {
        await syncConversationSnapshotFromTab(record, 1);
        // Establish the stable transcript while the user is reading or typing.
        // A minimized ChatGPT renderer can virtualize every transcript turn even
        // while its composer still answers extension messages. Wake only the
        // owned tab in a non-focused parking window during this idle prewarm so
        // the first Send after an MV3/Relay reload does not have to pay for that
        // migration. This preparation stays detached from conversation.open and
        // yields immediately if a real run starts.
        void prewarmConversationDispatchState(key, record, tabId, prewarmVisibility).catch(() =>
          recordBackgroundFailure("Failed to prewarm a conversation transcript baseline."),
        );
      }
    }
    if (payload.active) await focusTab(tabId);
  } catch (error) {
    await sendCaughtError(
      connection,
      envelope,
      error,
      "CHATGPT_REMOTE_UNAVAILABLE",
      payload.active === true,
    );
  }
}

async function handleCanonicalizationCheck(connection: RelayConnection, envelope: RelayEnvelope) {
  const conversationId = requireConversationId(connection, envelope);
  const payload = parseCanonicalizationCheckPayload(envelope.payload);
  if (!conversationId || !payload) {
    rejectProtocol(connection, envelope, "Invalid conversation.canonicalization.check payload.");
    return;
  }

  const key = conversationKey(connection.instanceId!, conversationId);
  let grant = completedCanonicalizations.get(key);
  if (!grant || !canonicalizationCheckMatchesGrant(payload, grant)) {
    if (grant) {
      completedCanonicalizations.delete(key);
      await persistSession();
    }
    sendCanonicalizationResult(connection, conversationId, payload, {
      // Without the matching, unexpired browser-side grant Chrome cannot prove
      // that A has finished canonicalizing, even when the current mapping still
      // happens to display A. Fail closed instead of manufacturing authority.
      status: "expired",
      remoteUrl: payload.fromRemoteUrl,
    });
    return;
  }

  const expiresAt = Date.parse(grant.expiresAt);
  if (grant.toRemoteUrl) {
    const record = conversationTabs.get(key);
    if (record?.tabId === grant.tabId) {
      const snapshot = await readVerifiedPromotionSnapshot(key, record, grant, 3);
      if (snapshot) {
        sendCanonicalizationResult(connection, conversationId, payload, {
          status: "promoted",
          snapshot,
        });
        return;
      }
    }
  }
  while (Date.now() < expiresAt) {
    const record = conversationTabs.get(key);
    if (!record || record.tabId !== grant.tabId) break;
    await syncConversationSnapshotFromTab(record, grant.toRemoteUrl ? 2 : 3);
    grant = completedCanonicalizations.get(key);
    if (!grant || !canonicalizationCheckMatchesGrant(payload, grant)) break;
    if (grant.toRemoteUrl) {
      const snapshot = await readVerifiedPromotionSnapshot(key, record, grant, 3);
      if (snapshot) {
        sendCanonicalizationResult(connection, conversationId, payload, {
          status: "promoted",
          snapshot,
        });
        return;
      }
    }
    await delay(Math.min(250, Math.max(0, expiresAt - Date.now())));
  }

  const record = conversationTabs.get(key);
  const tab = record ? await chrome.tabs.get(record.tabId).catch(() => undefined) : undefined;
  const currentRemoteUrl = normalizeRemoteConversationUrl(tab?.url);
  const unchanged = Boolean(
    record?.remoteUrl &&
    currentRemoteUrl &&
    sameChatGptConversationIdentity(payload.fromRemoteUrl, record.remoteUrl) &&
    sameChatGptConversationIdentity(payload.fromRemoteUrl, currentRemoteUrl),
  );
  const remainingGrant = completedCanonicalizations.get(key);
  if (remainingGrant && canonicalizationCheckMatchesGrant(payload, remainingGrant)) {
    completedCanonicalizations.delete(key);
  }
  if (!unchanged && record && currentRemoteUrl) {
    conversationTabs.delete(key);
    terminalHistoryBarriers.delete(key);
  }
  await persistSession();
  sendCanonicalizationResult(connection, conversationId, payload, {
    status: unchanged ? "unchanged" : "expired",
    remoteUrl: payload.fromRemoteUrl,
  });
}

function sendCanonicalizationResult(
  connection: RelayConnection,
  conversationId: string,
  binding: ConversationCanonicalizationCheckPayload,
  result:
    | Pick<
        Extract<ConversationCanonicalizationResultPayload, { status: "promoted" }>,
        "status" | "snapshot"
      >
    | Pick<
        Extract<ConversationCanonicalizationResultPayload, { status: "unchanged" | "expired" }>,
        "status" | "remoteUrl"
      >,
) {
  sendConnection(
    connection,
    makeEnvelope({
      type: "conversation.canonicalization.result",
      instanceId: connection.instanceId!,
      conversationId,
      payload: { ...binding, ...result } as ConversationCanonicalizationResultPayload,
    }),
  );
}

async function settlePendingPromotionBeforeRun(
  _connection: RelayConnection,
  _envelope: RelayEnvelope,
  key: string,
  requestedRemoteUrl: string | undefined,
) {
  // The mapped Chrome tab and its visible transcript are authoritative. A
  // terminal URL promotion must never turn a healthy mirrored conversation
  // into a permanently blocked local record. Discard legacy v7 settlement
  // state and verify the currently visible page immediately before dispatch.
  const grant = completedCanonicalizations.get(key);
  const record = conversationTabs.get(key);
  const requested = normalizeRemoteConversationUrl(requestedRemoteUrl);
  const preserveGrant = Boolean(
    grant &&
    record &&
    requested &&
    isCompletedCanonicalizationCurrent(grant) &&
    record.tabId === grant.tabId &&
    (sameChatGptConversationIdentity(grant.fromRemoteUrl, requested) ||
      Boolean(
        grant.toRemoteUrl && sameChatGptConversationIdentity(grant.toRemoteUrl, requested),
      )) &&
    Boolean(
      record.remoteUrl &&
      (sameChatGptConversationIdentity(grant.fromRemoteUrl, record.remoteUrl) ||
        Boolean(
          grant.toRemoteUrl && sameChatGptConversationIdentity(grant.toRemoteUrl, record.remoteUrl),
        )),
    ),
  );
  if (!preserveGrant && completedCanonicalizations.delete(key)) scheduleSessionPersist();
  completedInitialAdoptions.delete(key);
  runPromptFingerprints.delete(key);
  settledCanonicalizationTombstones.delete(key);
  return false;
}

async function handleSend(connection: RelayConnection, envelope: RelayEnvelope) {
  const conversationId = requireConversationId(connection, envelope);
  const runId = requireRunId(connection, envelope);
  const payload = parseSendPayload(envelope.payload);
  if (!conversationId || !runId || !payload) {
    rejectProtocol(connection, envelope, "Invalid conversation.send payload.");
    return;
  }

  const key = conversationKey(connection.instanceId!, conversationId);
  if (replayPendingTerminalForRun(connection, conversationId, runId)) return;
  const normalizedPrompt = payload.prompt.trim();
  const promptSha256 = await sha256Hex(normalizedPrompt);
  const inlinePresentation = promptInlinePresentationV1(normalizedPrompt);
  const promptInlinePresentationSha256 =
    inlinePresentation === normalizedPrompt ? undefined : await sha256Hex(inlinePresentation);
  const existingRun = activeRuns.get(key);
  if (existingRun?.runId === runId) {
    // Host reconnects can replay the same non-idempotent command. The exact run
    // is already dispatching/active, so never turn that replay into BUSY and
    // never send the prompt to the page a second time.
    if (existingRun.promptSha256 && existingRun.promptSha256 !== promptSha256) {
      rejectProtocol(connection, envelope, "A duplicate run id carried a different prompt.");
    }
    return;
  }
  if (await settlePendingPromotionBeforeRun(connection, envelope, key, payload.remoteUrl)) return;
  if (existingRun) {
    await reportRejectedRun(
      connection,
      conversationId,
      runId,
      "CONVERSATION_BUSY",
      "该会话已有回答正在生成。",
    );
    return;
  }
  if (activeRuns.size >= MAX_CONCURRENT_RUNS) {
    await reportRejectedRun(
      connection,
      conversationId,
      runId,
      "CONCURRENT_RUN_LIMIT",
      `最多允许 ${MAX_CONCURRENT_RUNS} 个会话同时生成。`,
    );
    return;
  }

  const run: ActiveRunRecord = {
    instanceId: connection.instanceId!,
    conversationId,
    runId,
    phase: "dispatching",
    remoteAdoptionStage:
      (!payload.remoteUrl || !isRemoteConversationPage(payload.remoteUrl)) &&
      !conversationTabs.get(key)?.remoteUrl
        ? "initial"
        : "locked",
    promptSha256,
    ...(promptInlinePresentationSha256
      ? {
          promptInlinePresentationVersion: PROMPT_INLINE_PRESENTATION_VERSION,
          promptInlinePresentationSha256,
        }
      : {}),
    startedAt: new Date().toISOString(),
  };
  releaseTerminalHistoryBarrierForNewRun(key, runId);
  runPromptFingerprints.set(key, promptSha256);
  runDispatchTranscriptBaselines.delete(key);
  activeRuns.set(key, run);
  try {
    await persistSession();
    const tabId = await ensureConversationTab(run.instanceId, conversationId, payload.remoteUrl);
    if (activeRuns.get(key) !== run) return;
    if (conversationTabs.get(key)?.tabId !== tabId) {
      throw relayFailure("CHATGPT_REMOTE_UNAVAILABLE", "会话标签页映射已发生变化。", tabId);
    }
    const mappedRecord = conversationTabs.get(key);
    if (mappedRecord && payload.transcriptProof) {
      prewarmConversationTranscriptProof(mappedRecord, payload.transcriptProof);
    }
    run.tabId = tabId;
    // Tab protection and the durable run checkpoint are independent Chrome
    // operations. Starting them together removes one storage/API round trip
    // from every send without moving the non-idempotent click ahead of either
    // safety barrier.
    await Promise.all([setRunTabProtection(tabId, true), persistSession()]);
    if (activeRuns.get(key) !== run) return;
    if (conversationTabs.get(key)?.tabId !== tabId) {
      throw relayFailure("CHATGPT_REMOTE_UNAVAILABLE", "会话标签页映射已发生变化。", tabId);
    }
    const effectiveModelId = payload.modelId ?? conversationModelSelections.get(key);
    const contentSendTimeout = payload.attachments?.length
      ? CONTENT_SEND_WITH_ATTACHMENTS_RESPONSE_TIMEOUT_MS
      : CONTENT_SEND_RESPONSE_TIMEOUT_MS;
    // Debugger attachment used to begin only after the composer wake-up. Start
    // it now so permission lookup, attachment and Network.enable overlap the
    // page-visibility/readiness path. The same promise is awaited before the
    // click, so no early response frame can be missed.
    const enhancedCapturePreparation = startEnhancedDebuggerCapture(key, run, tabId);
    let response: unknown;
    let contentSendAttempted = false;
    try {
      response = await withComposerReadyForDispatch(
        key,
        run,
        tabId,
        async (composerStatus) => {
          let catalog = readCachedModelCatalog(key);
          const catalogPreparation =
            effectiveModelId && !catalog?.options.some((option) => option.id === effectiveModelId)
              ? readAndRememberModelCatalog(key, tabId)
              : Promise.resolve(catalog);
          // These are independent read-side preparations. Run them together so
          // a cold model catalog, transcript proof, and debugger attachment do
          // not add their latencies serially to the user's click.
          const dispatchBaselinePreparation = rememberRunDispatchTranscriptBaseline(
            key,
            run,
            tabId,
            {
              allowAttestedEmptyPartial: composerStatus.visibilityState === "visible",
            },
          );
          [catalog] = await Promise.all([
            catalogPreparation,
            dispatchBaselinePreparation,
            enhancedCapturePreparation,
          ]);
          const requestedModel = effectiveModelId
            ? catalog?.options.find((option) => option.id === effectiveModelId)
            : undefined;
          if (effectiveModelId && !requestedModel?.modelId) {
            throw relayFailure(
              "CHATGPT_MODEL_SELECTION_FAILED",
              "所选模式已经过期，请重新打开模型选择器后再发送。",
              tabId,
            );
          }
          const dispatchBaseline = runDispatchTranscriptBaselines.get(key);
          if (!dispatchBaseline) {
            const transcriptDiagnostic = dispatchTranscriptDiagnostics.get(key);
            throw relayFailure(
              "CHATGPT_REMOTE_UNAVAILABLE",
              `Ask2GPT could not capture a complete, stable pre-send transcript; the question was not sent.${transcriptDiagnostic ? ` Transcript diagnostic: ${transcriptDiagnostic}.` : ""}`,
              tabId,
            );
          }
          if (activeRuns.get(key) !== run || conversationTabs.get(key)?.tabId !== tabId) {
            throw relayFailure(
              "CHATGPT_REMOTE_UNAVAILABLE",
              "会话页面在发送前检查期间发生了变化；问题尚未发送。",
              tabId,
            );
          }
          const finalDispatchPage = await assertPreDispatchPage(key, run, tabId);
          // The content transaction still owns prompt validation and the exact
          // send control. The worker has already made the exact owned page
          // visible; the page's MAIN world remains the only activation path.
          const contentSendCommand = {
            type: "content.send",
            conversationId,
            runId,
            prompt: payload.prompt,
            ...(payload.attachments?.length ? { attachments: payload.attachments } : {}),
            ...(effectiveModelId
              ? {
                  modelId: requestedModel!.modelId,
                  modelLabel: requestedModel!.familyLabel ?? requestedModel!.label,
                  ...(requestedModel!.reasoningEffort
                    ? { reasoningEffort: requestedModel!.reasoningEffort }
                    : {}),
                }
              : {}),
            allowFirstConversation: finalDispatchPage.allowFirstConversation,
            expectedProjectScope: finalDispatchPage.expectedProjectScope,
            ...(finalDispatchPage.expectedRemoteUrl
              ? { expectedRemoteUrl: finalDispatchPage.expectedRemoteUrl }
              : {}),
          };
          // `content.send` is non-idempotent. From this assignment onward every
          // transport failure is ambiguous and may only enter recovery.
          contentSendAttempted = true;
          const contentResponse: unknown = await sendToTabWithTimeout(
            tabId,
            contentSendCommand,
            contentSendTimeout,
          );
          throwDefinitiveContentSendFailure(contentResponse, tabId);
          assertSuccessfulContentResponse(contentResponse);
          const submittedPromptMessageSha256 =
            isRecord(contentResponse) &&
            typeof contentResponse.submittedPromptMessageSha256 === "string" &&
            /^[a-f0-9]{64}$/u.test(contentResponse.submittedPromptMessageSha256)
              ? contentResponse.submittedPromptMessageSha256
              : undefined;
          if (submittedPromptMessageSha256) {
            run.submittedPromptMessageSha256 = submittedPromptMessageSha256;
          }
          return contentResponse;
        },
        enhancedCapturePreparation,
      );
    } catch (error) {
      if (!contentSendAttempted || isDefinitiveContentSendFailure(error)) throw error;
      if (activeRuns.get(key) !== run) return;
      run.phase = "active";
      await setRunTabProtection(tabId, true);
      await persistSession().catch(() =>
        recordBackgroundFailure("Failed to persist ChatGPT dispatch recovery state."),
      );
      // The active-run checkpoint and an exact content.recovery.request both
      // drive read-only recovery. Do not emit a terminal failure merely because
      // the original response channel timed out, and never resend the prompt.
      return;
    }
    if (!isCompatibleContentRuntime((response as ContentResponse).selectorVersion)) {
      // The send actuation may already have submitted the prompt. Treat a runtime swap
      // after that point exactly like a closed response channel: inspect and
      // recover, but never issue content.send a second time.
      if (activeRuns.get(key) === run) await recoverRun(run);
      if (
        activeRuns.get(key) === run &&
        run.phase === "dispatching" &&
        !run.historyReloadClaimedAt
      ) {
        await failRun(
          run,
          "SELECTOR_INCOMPATIBLE",
          "Ask2GPT updated while ChatGPT was accepting the question; the question was not resent.",
          true,
        );
      }
      return;
    }
    if (activeRuns.get(key) === run) {
      if (effectiveModelId) conversationModelSelections.set(key, effectiveModelId);
      const priorGrant = completedCanonicalizations.get(key);
      if (priorGrant && priorGrant.runId !== run.runId) {
        completedCanonicalizations.delete(key);
      }
      run.phase = "active";
      await persistSession();
    }
  } catch (error) {
    if (activeRuns.get(key) !== run) return;
    const tabId = errorTabId(error) ?? run.tabId;
    await failRun(
      tabId === undefined ? run : { ...run, tabId },
      errorCode(error, "CHATGPT_SEND_FAILED"),
      errorMessage(error, "ChatGPT 页面中转失败。"),
      true,
    );
  }
}

async function handleStop(connection: RelayConnection, envelope: RelayEnvelope) {
  const conversationId = requireConversationId(connection, envelope);
  const runId = requireRunId(connection, envelope);
  const payload = parseStopPayload(envelope.payload);
  if (!conversationId || !runId || !payload) {
    rejectProtocol(connection, envelope, "Invalid generation.stop payload.");
    return;
  }

  const key = conversationKey(connection.instanceId!, conversationId);
  const run = activeRuns.get(key);
  if (!run || run.runId !== runId) {
    const record = conversationTabs.get(key);
    await reportRejectedRun(
      connection,
      conversationId,
      runId,
      "CHATGPT_REMOTE_UNAVAILABLE",
      "无法确认该生成任务仍属于当前 ChatGPT 标签页；未执行停止。",
      true,
      record?.tabId,
    );
    return;
  }
  const record = conversationTabs.get(key);
  if (!record || run.tabId !== record.tabId) {
    await failRun(run, "CHATGPT_REMOTE_UNAVAILABLE", "找不到该生成任务的 ChatGPT 标签页。");
    return;
  }
  try {
    const response = await sendToTab(record.tabId, {
      type: "content.stop",
      conversationId,
      runId,
    });
    assertSuccessfulContentResponse(response);
    if ((response as ContentResponse).alreadyStopped && activeRuns.get(key) === run) {
      await recoverRun(run);
      if (activeRuns.get(key) !== run) return;
      const retry = await sendToTab(record.tabId, {
        type: "content.stop",
        conversationId,
        runId,
      });
      assertSuccessfulContentResponse(retry);
    }
    if (activeRuns.get(key) === run) {
      await recoverRun(run);
    }
  } catch (error) {
    if (activeRuns.get(key) === run) {
      await failRun(
        run,
        errorCode(error, "SELECTOR_INCOMPATIBLE"),
        errorMessage(error, "无法确认当前回答已停止。"),
        true,
      );
    }
  }
}

async function handleRegenerate(connection: RelayConnection, envelope: RelayEnvelope) {
  const conversationId = requireConversationId(connection, envelope);
  const runId = requireRunId(connection, envelope);
  const payload = parseRegeneratePayload(envelope.payload);
  if (!conversationId || !runId || !payload) {
    rejectProtocol(connection, envelope, "Invalid generation.regenerate payload.");
    return;
  }

  const key = conversationKey(connection.instanceId!, conversationId);
  if (replayPendingTerminalForRun(connection, conversationId, runId)) return;
  const existingRun = activeRuns.get(key);
  if (existingRun?.runId === runId) {
    // Regenerate is also non-idempotent. A replay for the same run is already
    // represented by the page observer or durable terminal outbox.
    return;
  }
  if (await settlePendingPromotionBeforeRun(connection, envelope, key, payload.remoteUrl)) return;
  if (existingRun) {
    await reportRejectedRun(
      connection,
      conversationId,
      runId,
      "CONVERSATION_BUSY",
      "该会话已有回答正在生成。",
    );
    return;
  }
  if (activeRuns.size >= MAX_CONCURRENT_RUNS) {
    await reportRejectedRun(
      connection,
      conversationId,
      runId,
      "CONCURRENT_RUN_LIMIT",
      "并发生成已达到上限。",
    );
    return;
  }

  const run: ActiveRunRecord = {
    instanceId: connection.instanceId!,
    conversationId,
    runId,
    phase: "dispatching",
    remoteAdoptionStage: "locked",
    startedAt: new Date().toISOString(),
  };
  releaseTerminalHistoryBarrierForNewRun(key, runId);
  runDispatchTranscriptBaselines.delete(key);
  activeRuns.set(key, run);
  try {
    await persistSession();
    const tabId = await ensureConversationTab(run.instanceId, conversationId, payload.remoteUrl);
    if (activeRuns.get(key) !== run) return;
    if (conversationTabs.get(key)?.tabId !== tabId) {
      throw relayFailure("CHATGPT_REMOTE_UNAVAILABLE", "会话标签页映射已发生变化。", tabId);
    }
    run.tabId = tabId;
    await setRunTabProtection(tabId, true);
    await persistSession();
    if (activeRuns.get(key) !== run) return;
    if (conversationTabs.get(key)?.tabId !== tabId) {
      throw relayFailure("CHATGPT_REMOTE_UNAVAILABLE", "会话标签页映射已发生变化。", tabId);
    }
    let response: unknown;
    try {
      // A regenerate click can succeed even if its response port closes. Send
      // it once, then use only the idempotent recovery inspection.
      response = await withTransientConversationTabActivation(
        key,
        tabId,
        async () => {
          const dispatchPage = await assertPreDispatchPage(key, run, tabId);
          return await sendToTabWithTimeout(
            tabId,
            {
              type: "content.regenerate",
              conversationId,
              runId,
              allowFirstConversation: false,
              expectedProjectScope: dispatchPage.expectedProjectScope,
              ...(dispatchPage.expectedRemoteUrl
                ? { expectedRemoteUrl: dispatchPage.expectedRemoteUrl }
                : {}),
            },
            CONTENT_SEND_RESPONSE_TIMEOUT_MS,
          );
        },
        run,
      );
    } catch {
      if (activeRuns.get(key) !== run) return;
      await recoverRun(run);
      if (activeRuns.get(key) === run && run.phase === "dispatching") {
        await failRun(
          run,
          "CHATGPT_REMOTE_UNAVAILABLE",
          "Unable to confirm whether ChatGPT accepted regeneration; Ask2GPT did not retry it automatically.",
          true,
        );
      }
      return;
    }
    assertSuccessfulContentResponse(response);
    if (activeRuns.get(key) === run) {
      run.phase = "active";
      await persistSession();
    }
  } catch (error) {
    if (activeRuns.get(key) !== run) return;
    const tabId = errorTabId(error) ?? run.tabId;
    await failRun(
      tabId === undefined ? run : { ...run, tabId },
      errorCode(error, "REGENERATE_CONTROL_UNAVAILABLE"),
      errorMessage(error, "无法重新生成当前回答。"),
      true,
    );
  }
}

async function handleClose(connection: RelayConnection, envelope: RelayEnvelope) {
  const conversationId = requireConversationId(connection, envelope);
  const payload = parseClosePayload(envelope.payload);
  if (!conversationId || !payload) {
    rejectProtocol(connection, envelope, "Invalid conversation.close payload.");
    return;
  }

  const key = conversationKey(connection.instanceId!, conversationId);
  const record = conversationTabs.get(key);
  let tabDisposition: ConversationClosedPayload["tabDisposition"] = "left-open";
  if (payload.closeTab) {
    try {
      tabDisposition = record ? await removeOwnedTab(record) : "already-absent";
    } catch (error) {
      await sendCaughtError(
        connection,
        envelope,
        error,
        "CHATGPT_REMOTE_UNAVAILABLE",
        false,
        record?.tabId,
      );
      return;
    }
  }

  const previous = {
    record,
    modelSelection: conversationModelSelections.get(key),
    run: activeRuns.get(key),
    pendingEvents: [...pendingEvents.entries()].filter(
      ([, pending]) =>
        pending.instanceId === connection.instanceId &&
        pending.event.conversationId === conversationId,
    ),
    committedPendingEventKeys: new Set(
      [...pendingEvents.entries()]
        .filter(
          ([pendingKey, pending]) =>
            pending.instanceId === connection.instanceId &&
            pending.event.conversationId === conversationId &&
            committedPendingEventKeys.has(pendingKey),
        )
        .map(([pendingKey]) => pendingKey),
    ),
    forwardedSnapshot: forwardedSnapshots.get(key),
    expectedNavigation: expectedTabNavigations.get(key),
    completedCanonicalization: completedCanonicalizations.get(key),
    completedInitialAdoption: completedInitialAdoptions.get(key),
    terminalHistoryBarrier: terminalHistoryBarriers.get(key),
    runPromptFingerprint: runPromptFingerprints.get(key),
    runDispatchTranscriptBaseline: runDispatchTranscriptBaselines.get(key),
  };
  conversationTabs.delete(key);
  conversationModelSelections.delete(key);
  activeRuns.delete(key);
  for (const [pendingKey] of previous.pendingEvents) {
    pendingEvents.delete(pendingKey);
    committedPendingEventKeys.delete(pendingKey);
    clearPendingEventRetry(pendingKey);
  }
  forwardedSnapshots.delete(key);
  expectedTabNavigations.delete(key);
  completedCanonicalizations.delete(key);
  completedInitialAdoptions.delete(key);
  terminalHistoryBarriers.delete(key);
  runPromptFingerprints.delete(key);
  runDispatchTranscriptBaselines.delete(key);
  preparedDispatchTranscriptBaselines.delete(key);
  try {
    await persistSession();
  } catch {
    if (previous.record) conversationTabs.set(key, previous.record);
    if (previous.modelSelection) {
      conversationModelSelections.set(key, previous.modelSelection);
    }
    if (previous.run) activeRuns.set(key, previous.run);
    for (const [pendingKey, pending] of previous.pendingEvents) {
      pendingEvents.set(pendingKey, pending);
      if (previous.committedPendingEventKeys.has(pendingKey)) {
        committedPendingEventKeys.add(pendingKey);
      }
      if (isTerminalEvent(pending.event)) schedulePendingEventRetry(pendingKey);
    }
    if (previous.forwardedSnapshot) {
      forwardedSnapshots.set(key, previous.forwardedSnapshot);
    }
    if (previous.expectedNavigation) {
      expectedTabNavigations.set(key, previous.expectedNavigation);
    }
    if (previous.completedCanonicalization) {
      completedCanonicalizations.set(key, previous.completedCanonicalization);
    }
    if (previous.completedInitialAdoption) {
      completedInitialAdoptions.set(key, previous.completedInitialAdoption);
    }
    if (previous.terminalHistoryBarrier) {
      terminalHistoryBarriers.set(key, previous.terminalHistoryBarrier);
    }
    if (previous.runPromptFingerprint) {
      runPromptFingerprints.set(key, previous.runPromptFingerprint);
    }
    if (previous.runDispatchTranscriptBaseline) {
      runDispatchTranscriptBaselines.set(key, previous.runDispatchTranscriptBaseline);
    }
    recordBackgroundFailure("Failed to persist conversation close.");
    sendError(
      connection,
      envelope,
      "INTERNAL_ERROR",
      "Conversation cleanup could not be persisted; retrying is safe.",
    );
    return;
  }

  if (previous.run) {
    if (previous.run.tabId !== undefined) {
      await detachEnhancedDebugger(previous.run.tabId, previous.run.runId);
    }
    await releaseRunVisibilityLease(key, previous.run.runId);
  }

  sendConnection(
    connection,
    makeEnvelope({
      type: "conversation.closed",
      instanceId: connection.instanceId!,
      conversationId,
      payload: {
        requestId: envelope.id,
        closeTab: payload.closeTab,
        tabDisposition,
      } satisfies ConversationClosedPayload,
    }),
  );
}

async function handleContentEvent(
  event: ValidatedContentEvent,
  senderTabId: number,
  snapshotGuard?: ForwardedSnapshotGuard,
  senderDocumentUrl?: string,
  acknowledgeCommittedTerminal?: () => void,
  source: "content" | "enhanced-debugger" = "content",
) {
  const run = [...activeRuns.values()].find(
    (candidate) =>
      candidate.conversationId === event.conversationId &&
      candidate.runId === event.runId &&
      candidate.tabId === senderTabId,
  );
  if (!run) return false;
  if (
    event.eventType !== "error" &&
    typeof event.markdown === "string" &&
    isTransientAssistantStatus(event.markdown)
  ) {
    // Both the DOM and the network stream can expose ChatGPT's localized
    // progress label as if it were assistant text. Keep the run alive so the
    // real answer can replace it; acknowledging this event would otherwise
    // make the later answer look like stale history and discard it.
    return false;
  }

  let remoteUrl = event.remoteUrl ? normalizeRemoteConversationUrl(event.remoteUrl) : undefined;
  const senderRemoteUrl = normalizeRemoteConversationUrl(senderDocumentUrl);
  const key = conversationKey(run.instanceId, run.conversationId);
  if (event.remoteUrl !== undefined && !remoteUrl) {
    await failRun(
      run,
      "CHATGPT_REMOTE_UNAVAILABLE",
      "ChatGPT 页面已离开当前会话；已停止读取回答。",
      true,
    );
    return false;
  }
  if (
    event.eventType !== "error" &&
    senderDocumentUrl !== undefined &&
    remoteUrl &&
    (!senderRemoteUrl || senderRemoteUrl !== remoteUrl)
  ) {
    // Reject an event emitted before or after an SPA route transition. The
    // content observer will retry non-terminal snapshots; terminal observers
    // remain alive until their acknowledgement succeeds.
    return false;
  }
  const mappedTab = conversationTabs.get(key);
  if (!mappedTab || mappedTab.tabId !== senderTabId) return false;
  if (run.historyReloadClaimedAt && snapshotGuard?.exactTranscriptRecovery !== true) {
    // The old page observer can race the reload claim, and a rebuilt content
    // runtime can see a repeated latest prompt/answer pair. Neither is allowed
    // to settle a claimed run. Exact transcript expansion is the sole authority
    // until recoverClaimedRunFromExactTranscript completes or times out.
    return false;
  }

  const acceptsDebuggerInitialEventWithoutRoute =
    source === "enhanced-debugger" &&
    (event.eventType === "snapshot" ||
      event.eventType === "complete" ||
      event.eventType === "stopped") &&
    allowsInitialRemoteAdoption(run);
  if (
    event.eventType !== "error" &&
    (!remoteUrl || !isRemoteConversationPage(remoteUrl)) &&
    !acceptsDebuggerInitialEventWithoutRoute
  ) {
    const senderTab = await chrome.tabs.get(senderTabId).catch(() => undefined);
    const senderUrl = normalizeRemoteConversationUrl(senderTab?.url);
    if (
      !senderTab ||
      !isChatGptPageUrl(senderTab.url) ||
      !senderUrl ||
      conversationTabs.get(key) !== mappedTab ||
      activeRuns.get(key) !== run
    ) {
      await failRun(
        run,
        "CHATGPT_REMOTE_UNAVAILABLE",
        "ChatGPT 页面已离开可识别的问答页面；已停止读取回答。",
        true,
      );
      return false;
    }

    if (isRemoteConversationPage(senderUrl)) {
      remoteUrl = senderUrl;
      event.remoteUrl = senderUrl;
    } else if (event.eventType === "snapshot" || event.eventType === "slow") {
      // Keep lastMarkdown unchanged in the content script so its observer will
      // retry after ChatGPT promotes the page to a conversation URL.
      return false;
    } else if (event.eventType !== "complete" && event.eventType !== "stopped") {
      await failRun(
        run,
        "CHATGPT_REMOTE_UNAVAILABLE",
        "ChatGPT 页面已离开当前会话；已停止读取回答。",
        true,
      );
      return false;
    } else if (!allowsInitialRemoteAdoption(run) && !allowsRemoteCanonicalization(run)) {
      // Missing-URL terminal events are accepted only while the exact owned
      // run still has route-adoption authority. Legacy/static recovered runs
      // remain fail closed.
      await failRun(run, "CHATGPT_REMOTE_UNAVAILABLE", "无法验证无会话 URL 的最终回答。", true);
      return false;
    }
  }
  if (remoteUrl) event.remoteUrl = remoteUrl;

  if (remoteUrl && !projectUrlMatchesRecord(mappedTab, remoteUrl)) {
    await failRun(
      run,
      "CHATGPT_PROJECT_MISMATCH",
      "ChatGPT 将本次回答带离了已绑定的 Ask2GPT Project；已停止同步，问题不会被重发。",
      true,
    );
    return false;
  }

  const tab = conversationTabs.get(key);
  if (!tab || tab !== mappedTab || tab.tabId !== senderTabId) return false;

  let shouldPersist = false;
  let committedCompleteHistorySync: Promise<boolean> | undefined;
  let committedCompleteHistoryMarkdown: string | undefined;
  let pendingTerminal: { key: string; record: PendingEventRecord } | undefined;
  if (event.eventType !== "error" && remoteUrl) {
    const senderTab = await chrome.tabs.get(senderTabId).catch(() => undefined);
    const senderTabRemoteUrl = normalizeRemoteConversationUrl(senderTab?.url);
    const exactRecoveryRoute = Boolean(
      snapshotGuard?.exactTranscriptRecovery &&
      exactRecoveryRemoteRouteMatches(mappedTab, senderTabRemoteUrl, remoteUrl),
    );
    if (
      !senderTab ||
      !isChatGptPageUrl(senderTab.url) ||
      (senderTabRemoteUrl !== remoteUrl && !exactRecoveryRoute) ||
      conversationTabs.get(key) !== tab ||
      tab.tabId !== senderTabId
    ) {
      return false;
    }
    // `tabs.Tab.active` only means selected inside a Chrome window. It remains
    // true while VS Code covers Chrome, so it cannot distinguish user
    // navigation from ChatGPT's own SPA redirects. The exact mapped tab and
    // page-side run id already attest this event.
    const redirectAllowed = hasExpectedTabNavigation(key, senderTabId);
    const canonicalization = allowsRemoteCanonicalization(run) ? "attested" : "none";
    const decision = decideMappedTabNavigation({
      eventIsCurrent: true,
      mappedRemoteUrl: tab.remoteUrl,
      observedConversationUrl: remoteUrl,
      initialAdoptionAllowed: allowsInitialRemoteAdoption(run),
      redirectAllowed,
      canonicalization,
    });
    if (decision.action === "detach") {
      conversationTabs.delete(key);
      terminalHistoryBarriers.delete(key);
      expectedTabNavigations.delete(key);
      await failRun(
        run,
        "CHATGPT_REMOTE_UNAVAILABLE",
        "ChatGPT 标签页已离开当前映射的会话。",
        true,
      );
      return false;
    }
    if (decision.action === "adopt" && tab.remoteUrl !== decision.remoteUrl) {
      const wasUnmapped = tab.remoteUrl === undefined;
      const wasDifferentConversation = Boolean(
        tab.remoteUrl && !sameChatGptConversationIdentity(tab.remoteUrl, decision.remoteUrl),
      );
      const requiresTranscriptAttestation =
        (wasUnmapped && allowsInitialRemoteAdoption(run)) ||
        (wasDifferentConversation && allowsRemoteCanonicalization(run));
      const transcriptAttestation = requiresTranscriptAttestation
        ? await activeRunTranscriptMatchesRoute(key, run, tab, decision.remoteUrl, {
            markdown: event.markdown,
            terminal: event.eventType === "complete",
            allowUserOnly: event.eventType === "stopped" && !event.markdown,
          })
        : "attested";
      if (transcriptAttestation !== "attested") {
        // A surviving content script is not sufficient authority for a
        // cross-conversation-id route. A user can navigate the mapped SPA tab
        // while the old observer is still alive. Only the durable pre-send
        // transcript plus this exact prompt proves ChatGPT's own redirect.
        if (transcriptAttestation === "mismatch") {
          await failRun(
            run,
            "CHATGPT_REMOTE_UNAVAILABLE",
            "The ChatGPT tab changed to a different conversation while receiving the answer; the question was not resent.",
            true,
          );
        }
        return false;
      }
      tab.remoteUrl = decision.remoteUrl;
      tab.remoteTitle = undefined;
      shouldPersist = true;
      if (allowsInitialRemoteAdoption(run) && wasUnmapped) {
        promoteDispatchTranscriptBaseline(key, run, tab, decision.remoteUrl);
        lockRemoteAdoption(run);
      } else if (wasDifferentConversation && allowsRemoteCanonicalization(run)) {
        // An initial Project-root send may pass through one provisional
        // conversation id. Consume that one cross-id grant and lock the run;
        // otherwise an identical manual fork could be adopted later.
        promoteDispatchTranscriptBaseline(key, run, tab, decision.remoteUrl);
        lockRemoteAdoption(run);
      } else if (redirectAllowed) {
        clearExpectedTabNavigation(key, senderTabId);
      }
    } else if (tab.remoteUrl && allowsInitialRemoteAdoption(run)) {
      promoteDispatchTranscriptBaseline(key, run, tab, remoteUrl);
      lockRemoteAdoption(run);
      shouldPersist = true;
    }
  }
  if (activeRuns.get(key) !== run || conversationTabs.get(key) !== tab) return false;
  const observesResponse =
    event.eventType === "snapshot" &&
    Boolean(typeof event.markdown === "string" && event.markdown.trim());
  if (observesResponse && run.responseObserved !== true) {
    // Expose the first useful text immediately. The active run and its exact
    // pre-send transcript are already durable; this monotonic recovery hint
    // can be checkpointed off the first-token critical path.
    run.responseObserved = true;
    scheduleSessionPersist();
  }
  // A content.recover response is a point-in-time snapshot. If the normal
  // observer advanced while that response or this handler was awaiting, the
  // newer event owns the stream and the stale recovery result must not rewind
  // (or prematurely complete) it.
  if (snapshotGuard && forwardedSnapshots.get(key) !== snapshotGuard.expected) return false;
  const previousSnapshot = forwardedSnapshots.get(key);
  const duplicateSnapshot =
    event.eventType === "snapshot" &&
    previousSnapshot?.runId === event.runId &&
    previousSnapshot.markdown === event.markdown &&
    previousSnapshot.remoteUrl === event.remoteUrl;
  if (event.eventType === "snapshot" && !duplicateSnapshot) {
    forwardedSnapshots.set(key, {
      runId: event.runId,
      markdown: event.markdown ?? "",
      ...(event.remoteUrl ? { remoteUrl: event.remoteUrl } : {}),
    });
  }

  if (event.eventType !== "error" && event.remoteUrl && tab.remoteUrl !== event.remoteUrl) {
    // The navigation policy above owns all remote URL changes. Reaching this
    // branch means the page event raced a newer mapping decision.
    return false;
  }
  const titleChanged = Boolean(event.title && tab.remoteTitle !== event.title);
  if (event.title) {
    tab.remoteTitle = event.title;
    shouldPersist ||= titleChanged;
  }
  if (isTerminalEvent(event)) {
    const terminalMarkdownSha256 = await sha256Hex(event.markdown ?? "");
    const terminalGrant = await createCompletedCanonicalizationGrant(run, tab, event);
    const promptSha256 = run.promptSha256 ?? runPromptFingerprints.get(key);
    const promptInlinePresentationSha256 = run.promptInlinePresentationSha256;
    const completedInitialAdoption =
      !event.remoteUrl &&
      allowsInitialRemoteAdoption(run) &&
      promptSha256 &&
      (event.eventType === "complete" || event.eventType === "stopped")
        ? {
            tabId: senderTabId,
            promptSha256,
            ...(run.promptInlinePresentationVersion && promptInlinePresentationSha256
              ? {
                  promptInlinePresentationVersion: run.promptInlinePresentationVersion,
                  promptInlinePresentationSha256,
                }
              : {}),
            terminalMarkdownSha256,
            terminalStatus: event.eventType,
            expiresAt: Date.now() + REMOTE_CANONICALIZATION_WINDOW_MS,
          }
        : undefined;

    // Hashing and DOM inspection above yield to other Chrome events. Commit a
    // terminal state only if this exact run still owns this exact mapped tab.
    // A transcript-reload claim also revokes the old observer's authority; only
    // the guarded exact-prefix expansion may commit after that point.
    // conversation.close or a competing terminal event wins by deleting or
    // replacing one of these records, so a stale handler cannot resurrect an
    // outbox entry or delete a newer run.
    if (
      activeRuns.get(key) !== run ||
      conversationTabs.get(key) !== tab ||
      tab.tabId !== senderTabId ||
      (run.historyReloadClaimedAt && snapshotGuard?.exactTranscriptRecovery !== true)
    ) {
      return false;
    }

    if (event.eventType === "complete") {
      terminalHistoryBarriers.set(key, {
        instanceId: run.instanceId,
        conversationId: run.conversationId,
        runId: run.runId,
        tabId: senderTabId,
        terminalMarkdownSha256,
        createdAt: new Date().toISOString(),
      });
    }
    forwardedSnapshots.delete(key);
    if (terminalGrant) completedCanonicalizations.set(key, terminalGrant);
    else completedCanonicalizations.delete(key);
    if (completedInitialAdoption) {
      completedInitialAdoptions.set(key, completedInitialAdoption);
    } else {
      completedInitialAdoptions.delete(key);
    }
    deletePendingTransientEvents(run);
    const record =
      findPendingTerminalEvent(run) ?? createPendingEventRecord(run, event, senderTabId);
    const pendingKey = pendingEventKey(record);
    pendingEvents.set(pendingKey, record);

    // Persist the terminal outbox while the active run still exists. If quota
    // or storage fails, the page receives `ok:false` and can report the same
    // terminal again; neither memory nor the previous checkpoint has lost the
    // recoverable active run.
    await persistSession();

    // The storage write yields. A concurrent close or a different terminal
    // claim may have won while it was running, so claim this run once more
    // before removing it from the active set.
    if (
      activeRuns.get(key) !== run ||
      conversationTabs.get(key) !== tab ||
      pendingEvents.get(pendingKey) !== record
    ) {
      return false;
    }
    committedPendingEventKeys.add(pendingKey);
    if (event.eventType === "complete") {
      // A conversation.open/history sync may already be inspecting the old
      // partial transcript. Mark it dirty at the durable terminal boundary,
      // before later persistence, socket delivery, and visibility restoration
      // can yield. The eventual final sync then joins that exact rerun instead
      // of allowing the stale inspect to settle as the last snapshot.
      committedCompleteHistoryMarkdown = event.markdown ?? "";
      committedCompleteHistorySync = requestConversationSnapshotSyncRerun(tab, 5, {
        runId: run.runId,
        markdown: committedCompleteHistoryMarkdown,
      });
      await advanceConversationTranscriptFingerprintFromTerminal(run, tab, event).catch(() =>
        recordBackgroundFailure("Failed to advance a completed transcript fingerprint."),
      );
    }

    runPromptFingerprints.delete(key);
    runDispatchTranscriptBaselines.delete(key);
    enhancedDebuggerDiagnostics.delete(key);
    settledCanonicalizationTombstones.delete(key);
    activeRuns.delete(key);
    expectedTabNavigations.delete(key);
    pendingTerminal = { key: pendingKey, record };
    shouldPersist = false;
    await persistSession({ broadcast: false }).catch(() => {
      // The preceding checkpoint already contains both the run and terminal
      // outbox. Initialization treats the terminal as authoritative and drops
      // the duplicate active record, so a worker crash remains recoverable.
      recordBackgroundFailure("Failed to persist terminal run settlement.");
    });
  }

  if (pendingTerminal) {
    await detachEnhancedDebugger(senderTabId, run.runId);
    // Recovery can commit a terminal without originating from the live page
    // observer. Stop that exact observer before the Host learns the run is
    // free, otherwise an immediate next question can be rejected by stale
    // content-side state.
    await sendToTabWithTimeout(
      senderTabId,
      {
        type: "content.terminalAck",
        conversationId: run.conversationId,
        runId: run.runId,
      },
      1_000,
    ).catch(() => undefined);
  }

  const connection = authenticatedConnection(run.instanceId);
  if (connection) {
    if (titleChanged && event.title && event.remoteUrl) {
      sendConversationTitle(connection, event.conversationId, event.title, event.remoteUrl);
    }
    if (!duplicateSnapshot) {
      if (pendingTerminal) {
        sendPendingEvent(connection, pendingTerminal.record);
        schedulePendingEventRetry(pendingTerminal.key);
      } else {
        sendContentEvent(connection, run, event);
      }
    }
  } else {
    if (!duplicateSnapshot && !pendingTerminal) {
      const pending = createPendingEventRecord(run, event, senderTabId);
      pendingEvents.set(pendingEventKey(pending), pending);
      scheduleSessionPersist();
    }
  }
  if (pendingTerminal) {
    // Persisting the zero-active-run state above deliberately suppresses its
    // automatic broadcast. Expose that state only after the ordered socket has
    // received the terminal that explains why the run disappeared.
    broadcastStatus();
  }

  if (isTerminalEvent(event)) {
    // The durable outbox and zero-active-run checkpoint are already committed,
    // and the ordered Host terminal has been queued. Resolve the page message
    // now so content-script can stop its old run before VS Code submits the
    // next turn. History refresh and visibility cleanup are idempotent
    // post-commit work and must not hold this acknowledgement open.
    acknowledgeCommittedTerminal?.();
    await finalizeContentTerminalAfterAcknowledgement({
      key,
      run,
      tab,
      senderTabId,
      event,
      committedCompleteHistorySync,
      committedCompleteHistoryMarkdown,
    }).catch(() => recordBackgroundFailure("Failed to finalize a committed content terminal."));
    return true;
  }
  if (shouldPersist) await persistSession();
  return true;
}

async function finalizeContentTerminalAfterAcknowledgement({
  key,
  run,
  tab,
  senderTabId,
  event,
  committedCompleteHistorySync,
  committedCompleteHistoryMarkdown,
}: {
  key: string;
  run: ActiveRunRecord;
  tab: TabRecord;
  senderTabId: number;
  event: ValidatedContentEvent;
  committedCompleteHistorySync?: Promise<boolean>;
  committedCompleteHistoryMarkdown?: string;
}) {
  try {
    if (event.eventType === "error" && automaticFocusAllowed(event.error?.focusTab === true)) {
      await focusTab(senderTabId).catch(() => undefined);
    }
    if (event.eventType === "complete") {
      // The terminal event itself proves that this content runtime is alive.
      // Read the final transcript in place instead of selecting its Chrome tab;
      // the durable terminal-history barrier will perform a bounded wake-up if
      // a later background inspection genuinely stops responding.
      const joinedCommittedRerun = committedCompleteHistorySync
        ? await committedCompleteHistorySync
        : false;
      if (!committedCompleteHistorySync || !joinedCommittedRerun) {
        await syncConversationSnapshotFromTab(tab, 5, {
          runId: run.runId,
          markdown: committedCompleteHistoryMarkdown ?? event.markdown ?? "",
        });
      }
    }
  } finally {
    await releaseRunVisibilityLease(key, run.runId);
    // A new run may have started as soon as the terminal reached the Host.
    // Never undo that run's discard protection from this older cleanup.
    const tabHasNewActiveRun = [...activeRuns.values()].some(
      (candidate) => candidate.tabId === senderTabId,
    );
    if (!tabHasNewActiveRun) await setRunTabProtection(senderTabId, false);
  }
  if (terminalHistoryBarriers.get(key)?.runId === run.runId) {
    await recoverTerminalHistoryBarriers();
  }
  if (!activeRuns.has(key) && conversationTabs.get(key) === tab) {
    void prepareDispatchTranscriptBaseline(key, senderTabId).catch(() =>
      recordBackgroundFailure("Failed to refresh a conversation transcript baseline."),
    );
  }
}

async function recoverAllRuns(skipTabIds: ReadonlySet<number> = new Set()) {
  for (const run of [...activeRuns.values()]) {
    if (run.tabId !== undefined && skipTabIds.has(run.tabId)) continue;
    await recoverRun(run);
  }
}

async function recoverInstanceRuns(instanceId: string, options: { focusOnFailure?: boolean } = {}) {
  for (const run of [...activeRuns.values()]) {
    if (run.instanceId === instanceId) await recoverRun(run, options);
  }
}

async function checkpointActiveRuns() {
  await Promise.all(
    [...activeRuns.values()].map(async (run) => {
      if (run.phase !== "active" || run.tabId === undefined) return;
      const key = conversationKey(run.instanceId, run.conversationId);
      if (activeRuns.get(key) !== run) return;
      const tab = await promiseWithTimeout(
        chrome.tabs.get(run.tabId),
        1_000,
        "Chrome tab inspection timed out.",
      ).catch(() => undefined);
      if (!tab) return;
      const wasMinimized =
        (await chrome.windows.get(tab.windowId).catch(() => undefined))?.state === "minimized";
      const currentUrl = normalizeRemoteConversationUrl(tab.url);
      if (allowsInitialRemoteAdoption(run) && currentUrl && !isRemoteConversationPage(currentUrl)) {
        return;
      }
      await restoreLeasedRunWindowIfMinimized(key, run, tab.windowId);
      if (activeRuns.get(key) !== run || conversationTabs.get(key)?.tabId !== run.tabId) return;
      const action = classifyActiveRunTab(tab);
      if (action === "unfreeze" || action === "reload" || wasMinimized) {
        // A background ChatGPT tab can be frozen/discarded while another tab
        // is active in the same window. Wake the exact owned tab through the
        // bounded internal activation lease even when it is not selected.
        // The lease restores the user's previous tab after the read-only
        // recovery hand-off, so manual navigation is never required.
        const reactivated = await wakeRunTabForRecovery(
          key,
          run,
          run.tabId,
          tab.windowId,
          action === "reload"
            ? async () => {
                // Activating a discarded tab normally reloads it. Keep the
                // explicit reload inside the activation lease so the page is
                // still awake when Chrome starts the refresh.
                await promiseWithTimeout(
                  chrome.tabs.reload(tab.id!),
                  2_000,
                  "Chrome tab reload timed out.",
                ).catch(() => undefined);
              }
            : undefined,
        );
        if (!reactivated) {
          // A user navigation or newer run may have taken ownership while the
          // wake-up was queued. Keep protection in place and let the next
          // checkpoint retry against the still-authoritative mapping.
          await setRunTabProtection(run.tabId, true);
          return;
        }
        if (action === "unfreeze" || (action === "poll" && wasMinimized)) {
          await recoverRun(run, { focusOnFailure: false });
        }
        return;
      }
      await recoverRun(run, { focusOnFailure: false });
    }),
  );
}

async function pruneCompletedCanonicalizations() {
  let changed = false;
  for (const [key, grant] of completedCanonicalizations) {
    if (grant.toRemoteUrl || settledCanonicalizationTombstones.has(key)) continue;
    if (isCompletedCanonicalizationCurrent(grant)) continue;
    const mapped = conversationTabs.get(key);
    const tab = mapped ? await chrome.tabs.get(mapped.tabId).catch(() => undefined) : undefined;
    const currentRemoteUrl = normalizeRemoteConversationUrl(tab?.url);
    const expectedRemoteUrl = grant.toRemoteUrl ?? grant.fromRemoteUrl;
    const stableTombstone = Boolean(
      mapped &&
      mapped.tabId === grant.tabId &&
      mapped.remoteUrl &&
      currentRemoteUrl &&
      sameChatGptConversationIdentity(expectedRemoteUrl, mapped.remoteUrl) &&
      sameChatGptConversationIdentity(expectedRemoteUrl, currentRemoteUrl),
    );
    const awaitingAttestation = Boolean(
      !grant.toRemoteUrl &&
      isCompletedCanonicalizationCurrent(grant) &&
      mapped &&
      mapped.tabId === grant.tabId &&
      mapped.remoteUrl &&
      sameChatGptConversationIdentity(grant.fromRemoteUrl, mapped.remoteUrl) &&
      currentRemoteUrl &&
      !sameChatGptConversationIdentity(grant.fromRemoteUrl, currentRemoteUrl),
    );
    if (stableTombstone) {
      settledCanonicalizationTombstones.add(key);
      continue;
    }
    if (awaitingAttestation) continue;
    if (mapped && currentRemoteUrl) {
      conversationTabs.delete(key);
      terminalHistoryBarriers.delete(key);
    }
    completedCanonicalizations.delete(key);
    settledCanonicalizationTombstones.delete(key);
    changed = true;
  }
  if (changed) await persistSession();
}

async function retryPendingCompletedCanonicalizations() {
  for (const [key, grant] of completedCanonicalizations) {
    if (grant.toRemoteUrl || !isCompletedCanonicalizationCurrent(grant)) continue;
    const record = conversationTabs.get(key);
    if (!record || record.tabId !== grant.tabId) continue;
    const tab = await chrome.tabs.get(record.tabId).catch(() => undefined);
    const remoteUrl = normalizeRemoteConversationUrl(tab?.url);
    if (remoteUrl && !sameChatGptConversationIdentity(grant.fromRemoteUrl, remoteUrl)) {
      await syncConversationSnapshotFromTab(record, 3);
    }
  }
}

async function recoverRun(
  run: ActiveRunRecord,
  { focusOnFailure = false }: { focusOnFailure?: boolean } = {},
) {
  const key = conversationKey(run.instanceId, run.conversationId);
  if (activeRuns.get(key) !== run) return;
  // A terminal event already owns settlement for this run. Re-authentication
  // can race the terminal outbox's first persistence write; starting page
  // recovery in that gap can replace the authoritative error/complete event
  // before it is committed and replayed to the new Host connection.
  if (findPendingTerminalEvent(run)) return;
  if (recoveringRuns.has(key)) return;
  recoveringRuns.add(key);
  try {
    await recoverRunUnlocked(run, key, focusOnFailure);
  } finally {
    recoveringRuns.delete(key);
  }
}

async function recoverRunUnlocked(run: ActiveRunRecord, key: string, focusOnFailure: boolean) {
  if (isRunExpired(run)) {
    await failRun(run, "RESPONSE_TIMEOUT", "等待 ChatGPT 回答超过 30 分钟。");
    return;
  }
  const tab = conversationTabs.get(key);
  if (!tab || (run.tabId !== undefined && run.tabId !== tab.tabId)) {
    await failRun(run, "CHATGPT_REMOTE_UNAVAILABLE", "生成任务对应的标签页已不存在。");
    return;
  }
  run.tabId = tab.tabId;
  try {
    const currentRunTab = await chrome.tabs.get(tab.tabId).catch(() => undefined);
    if (currentRunTab?.autoDiscardable !== false) {
      await setRunTabProtection(tab.tabId, true);
      if (activeRuns.get(key) !== run || conversationTabs.get(key) !== tab) return;
    }
    // A page reload destroys the in-memory content run. From this point on,
    // generic latest-turn recovery is unsafe (the prompt and a short answer
    // such as "OK" may legitimately repeat). Only the durable pre-dispatch
    // transcript prefix may settle or reject the run.
    if (run.historyReloadClaimedAt) {
      await recoverClaimedRunFromExactTranscript(key, run, tab, focusOnFailure);
      return;
    }
    const recoverySnapshotBaseline = forwardedSnapshots.get(key);
    const response = await sendToTab(tab.tabId, {
      type: "content.recover",
      conversationId: run.conversationId,
      runId: run.runId,
      startedAt: run.startedAt,
      ...(run.promptSha256 ? { expectedPromptSha256: run.promptSha256 } : {}),
      ...(run.promptSha256 &&
      run.promptInlinePresentationVersion === PROMPT_INLINE_PRESENTATION_VERSION &&
      run.promptInlinePresentationSha256
        ? {
            expectedPromptInlinePresentationVersion: run.promptInlinePresentationVersion,
            expectedPromptInlinePresentationSha256: run.promptInlinePresentationSha256,
            // The worker reaches this branch only after the persisted run and
            // exact owned tab mapping have both been revalidated. Content must
            // not accept the lossy presentation fingerprint outside that
            // mapped-run recovery boundary.
            allowPromptInlinePresentationMatch: true,
          }
        : {}),
    });
    if (
      activeRuns.get(key) !== run ||
      conversationTabs.get(key) !== tab ||
      run.tabId !== tab.tabId
    ) {
      return;
    }
    assertSuccessfulContentResponse(response);
    const recovered = response as ContentResponse;
    if (!isCompatibleContentRuntime(recovered.selectorVersion)) {
      const baseline = run.dispatchTranscriptBaseline;
      if (baseline) {
        const refreshed = await refreshRunFromExactTranscript(key, run, tab, baseline.remoteUrl);
        if (refreshed.snapshot) {
          await settleRunFromCompletedSnapshot(
            key,
            run,
            tab,
            refreshed.snapshot,
            recoverySnapshotBaseline,
          );
          return;
        }
        // The durable reload claim switches every later checkpoint to exact
        // transcript recovery. Never fall through to content.send or generic
        // latest-turn matching after a submitted run crosses a hot update.
        if (refreshed.claimed || activeRuns.get(key) !== run) return;
      }
      throw relayFailure(
        "SELECTOR_INCOMPATIBLE",
        "The ChatGPT tab is running an older Ask2GPT content runtime and could not be refreshed safely; the question was not resent.",
      );
    }
    if (!canAttributeRecoveredRun(recovered)) {
      throw relayFailure(
        "CHATGPT_REMOTE_UNAVAILABLE",
        "The visible ChatGPT turn does not match the interrupted Ask2GPT run; nothing was resent.",
      );
    }
    const recoveredLifecycle = parseContentRunLifecycleDiagnostic(recovered.runLifecycle);
    const remoteUrl = normalizeRemoteConversationUrl(recovered.remoteUrl);
    const activeInitialPage = Boolean(
      remoteUrl &&
      !isRemoteConversationPage(remoteUrl) &&
      recovered.active === true &&
      allowsInitialRemoteAdoption(run),
    );
    if (!remoteUrl || (!isRemoteConversationPage(remoteUrl) && !activeInitialPage)) {
      throw relayFailure(
        "CHATGPT_REMOTE_UNAVAILABLE",
        "恢复时的 ChatGPT 页面不是可识别的会话页面。",
      );
    }
    if (activeRuns.get(key) !== run || conversationTabs.get(key) !== tab) return;
    if (activeInitialPage) {
      run.phase = "active";
      await persistSession();
      return;
    }
    const recoveredRunCanCanonicalize = canContinueRecoveredRunCanonicalization(recovered);
    const navigation = decideMappedTabNavigation({
      eventIsCurrent: true,
      mappedRemoteUrl: tab.remoteUrl,
      observedConversationUrl: remoteUrl,
      initialAdoptionAllowed: allowsInitialRemoteAdoption(run) && recoveredRunCanCanonicalize,
      redirectAllowed: false,
      canonicalization:
        allowsRemoteCanonicalization(run) && recoveredRunCanCanonicalize ? "attested" : "none",
    });
    if (
      navigation.action === "detach" ||
      navigation.action === "ignore-stale" ||
      navigation.action === "await-attestation"
    ) {
      throw relayFailure(
        "CHATGPT_REMOTE_UNAVAILABLE",
        "恢复时的 ChatGPT 页面已离开当前映射的会话。",
      );
    }
    if (navigation.action === "adopt") {
      const wasUnmapped = tab.remoteUrl === undefined;
      const wasDifferentConversation = Boolean(
        tab.remoteUrl && !sameChatGptConversationIdentity(tab.remoteUrl, navigation.remoteUrl),
      );
      const requiresTranscriptAttestation =
        (wasUnmapped && allowsInitialRemoteAdoption(run)) ||
        (wasDifferentConversation && allowsRemoteCanonicalization(run));
      const transcriptAttestation = requiresTranscriptAttestation
        ? await activeRunTranscriptMatchesRoute(key, run, tab, navigation.remoteUrl, {
            markdown: typeof recovered.markdown === "string" ? recovered.markdown : undefined,
            allowUserOnly:
              recovered.active === true &&
              (recovered.stopVisible === true || recoveredLifecycle?.stopVisible === true) &&
              !recovered.markdown,
          })
        : "attested";
      if (transcriptAttestation !== "attested") {
        if (transcriptAttestation === "defer") {
          run.phase = "active";
          await persistSession();
          return;
        }
        throw relayFailure(
          "CHATGPT_REMOTE_UNAVAILABLE",
          "The ChatGPT tab changed conversations without the exact submitted transcript; nothing was resent.",
        );
      }
      tab.remoteUrl = navigation.remoteUrl;
      tab.remoteTitle = undefined;
      if (allowsInitialRemoteAdoption(run) && wasUnmapped) {
        promoteDispatchTranscriptBaseline(key, run, tab, navigation.remoteUrl);
        lockRemoteAdoption(run);
      } else if (wasDifferentConversation && allowsRemoteCanonicalization(run)) {
        // Consume the sole provisional-to-canonical transition for an initial
        // Project-root run, then reject every further conversation-id change.
        promoteDispatchTranscriptBaseline(key, run, tab, navigation.remoteUrl);
        lockRemoteAdoption(run);
      }
    } else if (tab.remoteUrl && allowsInitialRemoteAdoption(run)) {
      promoteDispatchTranscriptBaseline(key, run, tab, remoteUrl);
      lockRemoteAdoption(run);
    }
    if (!recoveredRunCanCanonicalize && allowsRemoteCanonicalization(run)) {
      // Static recovery without either the exact old observer or a newly
      // adopted single stop control cannot authorize a cross-id redirect.
      lockRemoteAdoption(run);
    }

    const exactPageRunAttested = canAttestRecoveredRun(recovered);
    if (!exactPageRunAttested) {
      if (recovered.active !== true) {
        // `navigation.action === "keep"` already proves this is the exact
        // mapped conversation route. Do not apply the initial cross-ID route
        // adoption gate here: a rebuilt content runtime cannot retain the old
        // run id, but its durable pre-send transcript can still prove the
        // completed same-route turn. The readers below verify the baseline
        // hash, prompt hash, exact +2 suffix, mapping and current tab URL before
        // settling or performing the one allowed read-only reload.
        const exactSnapshot = await readCompletedSnapshotForActiveRun(key, run, tab, remoteUrl);
        if (exactSnapshot) {
          await settleRunFromCompletedSnapshot(
            key,
            run,
            tab,
            exactSnapshot,
            recoverySnapshotBaseline,
          );
          return;
        }
        if (activeRuns.get(key) !== run || conversationTabs.get(key) !== tab) return;
        const refreshed = await refreshRunFromExactTranscript(key, run, tab, remoteUrl);
        if (refreshed.snapshot) {
          await settleRunFromCompletedSnapshot(
            key,
            run,
            tab,
            refreshed.snapshot,
            recoverySnapshotBaseline,
          );
          return;
        }
        // The claim is persisted before the one allowed reload. Every later
        // checkpoint is therefore constrained to exact-prefix recovery.
        if (refreshed.claimed || activeRuns.get(key) !== run) return;
        throw relayFailure(
          "CHATGPT_REMOTE_UNAVAILABLE",
          "The interrupted ChatGPT run could not be restored from its exact transcript; nothing was resent.",
        );
      }
    }

    const recovery = classifyRecoveredRun(
      run.phase,
      recovered.active === true,
      typeof recovered.markdown === "string" ? recovered.markdown : undefined,
    );
    if (recovery === "active") {
      if (canAttestRecoveredRun(recovered)) {
        // A background ChatGPT tab can finish its visible transcript while the
        // page-side run observer remains throttled before it emits the final
        // generation event. Even when a partial snapshot exists, an exact
        // complete transcript may safely supersede it; generic latest-turn
        // markdown is never terminal authority.
        const terminalSnapshot = await readCompletedSnapshotForActiveRun(key, run, tab, remoteUrl);
        if (terminalSnapshot) {
          await settleRunFromCompletedSnapshot(
            key,
            run,
            tab,
            terminalSnapshot,
            recoverySnapshotBaseline,
          );
          return;
        }
      }
      const lifecycle = recoveredLifecycle;
      const startedAt = Date.parse(run.startedAt);
      const elapsed = Number.isFinite(startedAt) ? Date.now() - startedAt : 0;
      if (lifecycle) {
        const recoveryAssessment = {
          assistantAfterUser: lifecycle.assistantAfterUser,
          elapsedMs: elapsed,
          hasVisibleMarkdown: Boolean(
            typeof recovered.markdown === "string" && recovered.markdown.trim(),
          ),
          networkResponseComplete: lifecycle.networkResponseComplete,
          networkResponseStarted: lifecycle.networkResponseStarted,
          responseAttributed: lifecycle.responseAttributed,
          responseObserved: run.responseObserved === true || lifecycle.responseObserved,
          sawStop: lifecycle.sawStop,
          stopVisible: lifecycle.stopVisible,
          submissionConfirmed: lifecycle.submissionConfirmed,
          userTurnObserved: lifecycle.userTurnObserved,
        };
        if (run.responseObserved !== true && hasRecoveredRunResponseProgress(recoveryAssessment)) {
          run.responseObserved = true;
          await persistSession();
          if (activeRuns.get(key) !== run || conversationTabs.get(key) !== tab) return;
        }
        if (
          lifecycle.documentVisible === false &&
          run.dispatchTranscriptBaseline &&
          shouldRefreshRecoveredRunRender({
            assistantAfterUser: lifecycle.assistantAfterUser,
            documentVisible: lifecycle.documentVisible,
            exactRunAttested: canAttestRecoveredRun(recovered),
            generationBusy:
              lifecycle.stopVisible ||
              (lifecycle.networkResponseStarted && !lifecycle.networkResponseComplete),
            hasVisibleMarkdown: recoveryAssessment.hasVisibleMarkdown,
            networkResponseComplete: lifecycle.networkResponseComplete,
            networkResponseCompleteAgeMs: lifecycle.networkResponseCompleteAgeMs,
            refreshAttempted: Boolean(run.historyReloadClaimedAt),
            responseAttributed: lifecycle.responseAttributed,
            responseObserved: run.responseObserved === true || lifecycle.responseObserved,
            stopVisible: lifecycle.stopVisible,
            submissionConfirmed: lifecycle.submissionConfirmed,
            terminalDomEvidence:
              lifecycle.responseActionsPresent || (lifecycle.sawStop && !lifecycle.stopVisible),
            userTurnObserved: lifecycle.userTurnObserved,
          })
        ) {
          const refreshed = await refreshRunFromExactTranscript(key, run, tab, remoteUrl);
          if (refreshed.snapshot) {
            await settleRunFromCompletedSnapshot(
              key,
              run,
              tab,
              refreshed.snapshot,
              recoverySnapshotBaseline,
            );
            return;
          }
          // Claiming is persisted before tabs.reload. Do not continue through
          // the stale pre-reload content response or generic latest-turn
          // recovery; the next checkpoint uses only the exact transcript.
          if (refreshed.claimed || activeRuns.get(key) !== run) return;
        }
        if (
          shouldFailRecoveredRunForMissingAnswer({
            ...recoveryAssessment,
            responseObserved: run.responseObserved === true || lifecycle.responseObserved,
          })
        ) {
          await failRun(
            run,
            "CHATGPT_REMOTE_UNAVAILABLE",
            `ChatGPT did not produce a visible answer for the submitted turn (Run lifecycle: intent=${lifecycle.intentAccepted ? 1 : 0} submitted=${lifecycle.networkSubmitted ? 1 : 0} started=${lifecycle.networkResponseStarted ? 1 : 0} complete=${lifecycle.networkResponseComplete ? 1 : 0} attributed=${lifecycle.responseAttributed ? 1 : 0} sawStop=${lifecycle.sawStop ? 1 : 0}). Ask2GPT did not retry automatically.`,
            focusOnFailure,
          );
          return;
        }
      }
      run.phase = "active";
      if (typeof recovered.markdown === "string" && recovered.markdown) {
        const snapshot = parseContentEvent({
          type: "content.event",
          eventType: "snapshot",
          conversationId: run.conversationId,
          runId: run.runId,
          markdown: recovered.markdown,
          ...(remoteUrl ? { remoteUrl } : {}),
          ...(typeof recovered.title === "string" ? { title: recovered.title } : {}),
        });
        if (!snapshot) {
          throw relayFailure("FRAME_TOO_LARGE", "恢复的回答快照无效或过大。");
        }
        await handleContentEvent(snapshot, tab.tabId, {
          expected: recoverySnapshotBaseline,
        });
      }
      await persistSession();
      return;
    }

    if (recovery === "complete" && typeof recovered.markdown === "string") {
      const complete = parseContentEvent({
        type: "content.event",
        eventType: "complete",
        conversationId: run.conversationId,
        runId: run.runId,
        markdown: recovered.markdown,
        ...(remoteUrl ? { remoteUrl } : {}),
        ...(typeof recovered.title === "string" ? { title: recovered.title } : {}),
      });
      if (!complete) {
        throw relayFailure("FRAME_TOO_LARGE", "恢复的最终回答无效或过大。");
      }
      await handleContentEvent(complete, tab.tabId, {
        expected: recoverySnapshotBaseline,
      });
      return;
    }

    await failRun(
      run,
      "CHATGPT_REMOTE_UNAVAILABLE",
      "无法确认中断前的发送状态；已清理任务以避免占用并发槽。",
      focusOnFailure,
    );
  } catch (error) {
    if (activeRuns.get(key) !== run) return;
    if (run.phase === "active" && isTransientContentRecoveryFailure(error)) {
      // Background pages can temporarily close or stall their message port
      // while Chrome thaws React. Keep the durable run and visibility lease;
      // the next checkpoint or exact content recovery request will inspect it
      // again. This branch is read-only and can never replay content.send.
      await setRunTabProtection(tab.tabId, true);
      return;
    }
    await failRun(
      run,
      errorCode(error, "CHATGPT_REMOTE_UNAVAILABLE"),
      errorMessage(error, "无法恢复 ChatGPT 页面中的生成任务。"),
      focusOnFailure,
    );
  }
}

function parseContentRunLifecycleDiagnostic(
  value: unknown,
): ContentRunLifecycleDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = [
    "intentAccepted",
    "documentVisible",
    "submissionConfirmed",
    "networkSubmitted",
    "networkResponseStarted",
    "networkResponseComplete",
    "userTurnObserved",
    "responseAttributed",
    "responseObserved",
    "stopVisible",
    "sawStop",
    "assistantAfterUser",
  ] as const;
  if (keys.some((key) => typeof record[key] !== "boolean")) return undefined;
  if (
    record.responseActionsPresent !== undefined &&
    typeof record.responseActionsPresent !== "boolean"
  ) {
    return undefined;
  }
  const networkResponseCompleteAgeMs = record.networkResponseCompleteAgeMs;
  if (
    networkResponseCompleteAgeMs !== undefined &&
    (typeof networkResponseCompleteAgeMs !== "number" ||
      !Number.isFinite(networkResponseCompleteAgeMs) ||
      networkResponseCompleteAgeMs < 0)
  ) {
    return undefined;
  }
  return {
    ...(Object.fromEntries(keys.map((key) => [key, record[key]])) as unknown as Omit<
      ContentRunLifecycleDiagnostic,
      "networkResponseCompleteAgeMs"
    >),
    ...(networkResponseCompleteAgeMs === undefined
      ? {}
      : { networkResponseCompleteAgeMs: Number(networkResponseCompleteAgeMs) }),
    responseActionsPresent: record.responseActionsPresent === true,
  };
}

async function failRun(
  run: ActiveRunRecord,
  code: RelayErrorCode,
  message: string,
  focusRequested = false,
) {
  const key = conversationKey(run.instanceId, run.conversationId);
  if (activeRuns.get(key)?.runId !== run.runId) return;
  const liveCapture = run.tabId === undefined ? undefined : enhancedDebuggerCaptures.get(run.tabId);
  const enhancedDiagnostic =
    liveCapture?.runId === run.runId
      ? enhancedDebuggerDiagnosticSummary(liveCapture)
      : enhancedDebuggerDiagnostics.get(key);
  const messageWithDiagnostic =
    enhancedDiagnostic && (code === "CHATGPT_REMOTE_UNAVAILABLE" || code === "RESPONSE_TIMEOUT")
      ? `${message} Enhanced reception diagnostic: ${enhancedDiagnostic}.`
      : message;
  const settled = await queueRunTerminalError(
    run,
    code,
    messageWithDiagnostic,
    focusRequested,
    () => {
      if (activeRuns.get(key)?.runId !== run.runId) return false;
      activeRuns.delete(key);
      runPromptFingerprints.delete(key);
      runDispatchTranscriptBaselines.delete(key);
      completedInitialAdoptions.delete(key);
      forwardedSnapshots.delete(key);
      expectedTabNavigations.delete(key);
      return true;
    },
  );
  if (!settled) return;
  if (run.tabId !== undefined) await detachEnhancedDebugger(run.tabId, run.runId);
  enhancedDebuggerDiagnostics.delete(key);
  await releaseRunVisibilityLease(key, run.runId);
  if (run.tabId !== undefined) await setRunTabProtection(run.tabId, false);
}

async function reportRejectedRun(
  connection: RelayConnection,
  conversationId: string,
  runId: string,
  code: RelayErrorCode,
  message: string,
  focusRequested = false,
  tabId?: number,
) {
  await queueRunTerminalError(
    {
      instanceId: connection.instanceId!,
      conversationId,
      runId,
      phase: "dispatching",
      remoteAdoptionStage: "locked",
      startedAt: new Date().toISOString(),
      ...(tabId === undefined ? {} : { tabId }),
    },
    code,
    message,
    focusRequested,
  );
}

async function queueRunTerminalError(
  run: ActiveRunRecord,
  code: RelayErrorCode,
  message: string,
  focusRequested: boolean,
  settleRun?: () => boolean,
) {
  const effectiveFocusRequested = automaticFocusAllowed(focusRequested);
  const event: ValidatedContentEvent = {
    type: "content.event",
    eventType: "error",
    conversationId: run.conversationId,
    runId: run.runId,
    error: {
      code,
      message: message.slice(0, 1_000),
      recoverable: true,
      focusTab: effectiveFocusRequested,
    },
  };
  deletePendingTransientEvents(run);
  const pending = findPendingTerminalEvent(run) ?? createPendingEventRecord(run, event, run.tabId);
  const pendingKey = pendingEventKey(pending);
  pendingEvents.set(pendingKey, pending);
  try {
    await persistSession();
  } catch (error) {
    if (pendingEvents.get(pendingKey) === pending && !committedPendingEventKeys.has(pendingKey)) {
      pendingEvents.delete(pendingKey);
    }
    throw error;
  }
  if (pendingEvents.get(pendingKey) !== pending || (settleRun && !settleRun())) return false;
  committedPendingEventKeys.add(pendingKey);
  if (settleRun) {
    await persistSession().catch(() => {
      recordBackgroundFailure("Failed to persist failed-run settlement.");
    });
  }
  const connection = authenticatedConnection(run.instanceId);
  if (connection) {
    sendPendingEvent(connection, pending);
  }
  schedulePendingEventRetry(pendingKey);
  if (effectiveFocusRequested && run.tabId !== undefined) {
    await focusTab(run.tabId).catch(() => undefined);
  }
  return true;
}

async function flushPendingEvents(
  instanceId: string,
  { skipKeys = new Set<string>() }: { skipKeys?: ReadonlySet<string> } = {},
) {
  const connection = authenticatedConnection(instanceId);
  if (!connection) return;
  let changed = false;
  for (const [key, pending] of pendingEvents) {
    if (pending.instanceId !== instanceId) continue;
    if (skipKeys.has(key)) continue;
    if (isTerminalEvent(pending.event) && !committedPendingEventKeys.has(key)) continue;
    if (pending.event.title && pending.event.remoteUrl) {
      sendConversationTitle(
        connection,
        pending.event.conversationId,
        pending.event.title,
        pending.event.remoteUrl,
      );
    }
    const sent = sendPendingEvent(connection, pending);
    if (isTerminalEvent(pending.event)) {
      schedulePendingEventRetry(key);
    } else if (sent) {
      pendingEvents.delete(key);
      committedPendingEventKeys.delete(key);
      changed = true;
    }
  }
  if (changed) await persistSession();
}

function createPendingEventRecord(
  run: ActiveRunRecord,
  event: ValidatedContentEvent,
  tabId?: number,
): PendingEventRecord {
  return {
    eventId: crypto.randomUUID(),
    instanceId: run.instanceId,
    startedAt: run.startedAt,
    event,
    ...(tabId === undefined ? {} : { tabId }),
  };
}

function findPendingTerminalEvent(run: ActiveRunRecord) {
  return findPendingTerminalEventByIdentity(run.instanceId, run.conversationId, run.runId);
}

function findPendingTerminalEventByIdentity(
  instanceId: string,
  conversationId: string,
  runId: string,
) {
  return [...pendingEvents.values()].find(
    (pending) =>
      pending.instanceId === instanceId &&
      pending.event.conversationId === conversationId &&
      pending.event.runId === runId &&
      isTerminalEvent(pending.event),
  );
}

function replayPendingTerminalForRun(
  connection: RelayConnection,
  conversationId: string,
  runId: string,
) {
  const pending = findPendingTerminalEventByIdentity(connection.instanceId!, conversationId, runId);
  if (!pending) return false;
  const key = pendingEventKey(pending);
  // An uncommitted record is already being serialized by its content event.
  // Suppress the command replay now; the original handler will deliver it once
  // durable. A committed record can be replayed with its stable event id.
  if (committedPendingEventKeys.has(key)) {
    sendPendingEvent(connection, pending);
    schedulePendingEventRetry(key);
  }
  return true;
}

function deletePendingTransientEvents(run: ActiveRunRecord) {
  for (const [key, pending] of pendingEvents) {
    if (
      pending.instanceId === run.instanceId &&
      pending.event.conversationId === run.conversationId &&
      pending.event.runId === run.runId &&
      !isTerminalEvent(pending.event)
    ) {
      pendingEvents.delete(key);
      committedPendingEventKeys.delete(key);
      clearPendingEventRetry(key);
    }
  }
}

function sendPendingEvent(connection: RelayConnection, pending: PendingEventRecord) {
  const run: ActiveRunRecord = {
    instanceId: pending.instanceId,
    conversationId: pending.event.conversationId,
    runId: pending.event.runId,
    phase: "active",
    remoteAdoptionStage: "locked",
    startedAt: pending.startedAt,
    ...(pending.tabId === undefined ? {} : { tabId: pending.tabId }),
  };
  return sendContentEvent(connection, run, pending.event, pending.eventId);
}

function schedulePendingEventRetry(key: string) {
  const pending = pendingEvents.get(key);
  if (
    !pending ||
    !isTerminalEvent(pending.event) ||
    !committedPendingEventKeys.has(key) ||
    pendingEventRetryTimers.has(key)
  ) {
    return;
  }
  const attempt = pendingEventRetryAttempts.get(key) ?? 0;
  const delay =
    TERMINAL_EVENT_RETRY_DELAYS_MS[Math.min(attempt, TERMINAL_EVENT_RETRY_DELAYS_MS.length - 1)]!;
  pendingEventRetryAttempts.set(key, attempt + 1);
  const timer = setTimeout(() => {
    pendingEventRetryTimers.delete(key);
    void ready
      .then(async () => {
        const current = pendingEvents.get(key);
        if (!current || !isTerminalEvent(current.event)) return;
        const connection = authenticatedConnection(current.instanceId);
        if (!connection) return;
        sendPendingEvent(connection, current);
        schedulePendingEventRetry(key);
      })
      .catch(() => {
        recordBackgroundFailure("Failed to retry a pending terminal event.");
        if (pendingEvents.has(key)) schedulePendingEventRetry(key);
      });
  }, delay);
  pendingEventRetryTimers.set(key, timer);
}

function clearPendingEventRetry(key: string) {
  const timer = pendingEventRetryTimers.get(key);
  if (timer) clearTimeout(timer);
  pendingEventRetryTimers.delete(key);
  pendingEventRetryAttempts.delete(key);
}

function clearPendingEventRetriesForInstance(instanceId: string) {
  for (const [key, pending] of pendingEvents) {
    if (pending.instanceId === instanceId) clearPendingEventRetry(key);
  }
}

function flushKnownConversationTitles(connection: RelayConnection) {
  for (const record of conversationTabs.values()) {
    const pendingPromotion = completedCanonicalizations.get(
      conversationKey(record.instanceId, record.conversationId),
    );
    if (pendingPromotion?.toRemoteUrl) continue;
    if (record.instanceId === connection.instanceId && record.remoteTitle && record.remoteUrl) {
      sendConversationTitle(
        connection,
        record.conversationId,
        record.remoteTitle,
        record.remoteUrl,
      );
    }
  }
}

function sendConversationTitle(
  connection: RelayConnection,
  conversationId: string,
  title: string,
  remoteUrl: string,
) {
  sendConnection(
    connection,
    makeEnvelope({
      type: "conversation.title",
      instanceId: connection.instanceId!,
      conversationId,
      payload: {
        title,
        remoteUrl,
        observedAt: new Date().toISOString(),
      },
    }),
  );
}

function sendContentEvent(
  connection: RelayConnection,
  run: ActiveRunRecord,
  event: ValidatedContentEvent,
  eventId?: string,
) {
  if (event.eventType === "error") {
    return sendConnection(
      connection,
      makeEnvelope({
        ...(eventId ? { id: eventId } : {}),
        type: "relay.error",
        instanceId: run.instanceId,
        conversationId: event.conversationId,
        runId: event.runId,
        payload: event.error!,
      }),
    );
  }
  const relayType =
    event.eventType === "snapshot"
      ? "generation.snapshot"
      : event.eventType === "slow"
        ? "generation.slow"
        : event.eventType === "complete"
          ? "generation.complete"
          : "generation.stopped";
  return sendGenerationEvent(connection, relayType, event, run.startedAt, eventId);
}

function sendGenerationEvent(
  connection: RelayConnection,
  relayType:
    "generation.snapshot" | "generation.slow" | "generation.complete" | "generation.stopped",
  event: Omit<ValidatedContentEvent, "error">,
  startedAt = new Date().toISOString(),
  eventId?: string,
) {
  const terminalGrant =
    event.eventType === "complete" || event.eventType === "stopped"
      ? completedCanonicalizations.get(
          conversationKey(connection.instanceId!, event.conversationId),
        )
      : undefined;
  return sendConnection(
    connection,
    makeEnvelope({
      ...(eventId ? { id: eventId } : {}),
      type: relayType,
      instanceId: connection.instanceId!,
      conversationId: event.conversationId,
      runId: event.runId,
      payload: {
        markdown: event.markdown ?? "",
        remoteUrl: event.remoteUrl,
        startedAt,
        ...(event.eventType === "complete" ? { completedAt: new Date().toISOString() } : {}),
        ...(terminalGrant?.runId === event.runId
          ? { terminalTranscriptSha256: terminalGrant.terminalTranscriptSha256 }
          : {}),
      },
    }),
  );
}

function createProjectBinding(route: ProjectRoute, name: string): ProjectBinding {
  return {
    version: 5,
    provenance: "strict-visible-project-v1",
    projectUrl: route.projectUrl,
    scope: route.scope,
    name,
    boundAt: new Date().toISOString(),
  };
}

function parseRelayReloadCheckpoint(value: unknown) {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.expiresAt !== "string" ||
    !Array.isArray(value.conversationTabs) ||
    !Array.isArray(value.activeRuns) ||
    !Array.isArray(value.completedCanonicalizations)
  ) {
    return undefined;
  }
  const expiresAt = Date.parse(value.expiresAt);
  const now = Date.now();
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + RELAY_RELOAD_CHECKPOINT_TTL_MS + 30_000
  ) {
    return undefined;
  }
  return {
    conversationTabs: value.conversationTabs,
    activeRuns: value.activeRuns,
    completedCanonicalizations: value.completedCanonicalizations,
    terminalHistoryBarriers: Array.isArray(value.terminalHistoryBarriers)
      ? value.terminalHistoryBarriers
      : [],
    projectBindingVerification: value.projectBindingVerification,
    runVisibilityLeases: value.runVisibilityLeases,
  };
}

function parseStoredConversationTranscriptFingerprints(
  value: unknown,
): CachedConversationTranscriptFingerprint[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) return [];
  const now = Date.now();
  const parsed: CachedConversationTranscriptFingerprint[] = [];
  for (const entry of value.entries.slice(0, MAX_CONVERSATION_TRANSCRIPT_CACHE_ENTRIES * 2)) {
    if (
      !isRecord(entry) ||
      typeof entry.remoteUrl !== "string" ||
      !Number.isSafeInteger(entry.messageCount) ||
      Number(entry.messageCount) < 0 ||
      Number(entry.messageCount) > 200 ||
      !Array.isArray(entry.messageHashes) ||
      entry.messageHashes.length !== Number(entry.messageCount) ||
      typeof entry.transcriptSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.transcriptSha256) ||
      typeof entry.updatedAt !== "string"
    ) {
      continue;
    }
    const remoteUrl = normalizeRemoteConversationUrl(entry.remoteUrl);
    const updatedAtMs = Date.parse(entry.updatedAt);
    if (
      !remoteUrl ||
      !isRemoteConversationPage(remoteUrl) ||
      !Number.isFinite(updatedAtMs) ||
      updatedAtMs > now + 30_000 ||
      updatedAtMs < now - CONVERSATION_TRANSCRIPT_CACHE_TTL_MS
    ) {
      continue;
    }
    const messageHashes: CachedConversationTranscriptFingerprint["messageHashes"] = [];
    let valid = true;
    for (const item of entry.messageHashes) {
      if (
        !isRecord(item) ||
        (item.role !== "user" && item.role !== "assistant") ||
        typeof item.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(item.sha256)
      ) {
        valid = false;
        break;
      }
      messageHashes.push({ role: item.role, sha256: item.sha256 });
    }
    if (!valid) continue;
    const transcriptChainSha256 =
      typeof entry.transcriptChainSha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(entry.transcriptChainSha256)
        ? entry.transcriptChainSha256
        : undefined;
    if (entry.transcriptChainSha256 !== undefined && !transcriptChainSha256) continue;
    parsed.push({
      remoteUrl,
      messageCount: Number(entry.messageCount),
      messageHashes,
      transcriptSha256: entry.transcriptSha256,
      ...(transcriptChainSha256 ? { transcriptChainSha256 } : {}),
      updatedAt: entry.updatedAt,
    });
  }
  return parsed
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .filter(
      (candidate, index, entries) =>
        entries.findIndex((entry) =>
          sameChatGptConversationIdentity(entry.remoteUrl, candidate.remoteUrl),
        ) === index,
    )
    .slice(0, MAX_CONVERSATION_TRANSCRIPT_CACHE_ENTRIES);
}

function cachedConversationTranscriptFingerprint(record: TabRecord, remoteUrl: string) {
  return [...conversationTranscriptFingerprints.values()].find(
    (candidate) =>
      sameChatGptConversationIdentity(candidate.remoteUrl, remoteUrl) &&
      projectUrlMatchesRecord(record, candidate.remoteUrl) &&
      Date.parse(candidate.updatedAt) >= Date.now() - CONVERSATION_TRANSCRIPT_CACHE_TTL_MS,
  );
}

async function isStrictCachedTranscriptSuffix(
  record: TabRecord,
  snapshot: VisibleConversationSnapshot,
) {
  const cached = cachedConversationTranscriptFingerprint(record, snapshot.remoteUrl);
  if (
    !cached ||
    snapshot.messages.length === 0 ||
    snapshot.messages.length >= cached.messageCount
  ) {
    return false;
  }
  const offset = cached.messageCount - snapshot.messages.length;
  for (let index = 0; index < snapshot.messages.length; index += 1) {
    const message = snapshot.messages[index]!;
    const expected = cached.messageHashes[offset + index];
    if (!expected || expected.role !== message.role) return false;
    const actualSha256 = await sha256Hex(JSON.stringify([message.role, message.markdown]));
    if (expected.sha256 === actualSha256) continue;
    const rawRenderEquivalent =
      message.role === "assistant"
        ? rawAssistantMarkdownForEscapedIntrawordUnderscores(message.markdown)
        : undefined;
    if (
      !rawRenderEquivalent ||
      expected.sha256 !== (await sha256Hex(JSON.stringify([message.role, rawRenderEquivalent])))
    ) {
      return false;
    }
  }
  return true;
}

async function rememberConversationTranscriptFingerprint(
  record: TabRecord,
  snapshot: VisibleConversationSnapshot,
) {
  if (
    !snapshot.historyComplete ||
    !projectUrlMatchesRecord(record, snapshot.remoteUrl) ||
    !isRemoteConversationPage(snapshot.remoteUrl)
  ) {
    return;
  }
  const messageHashes = await Promise.all(
    snapshot.messages.map(async (message) => ({
      role: message.role,
      sha256: await sha256Hex(JSON.stringify([message.role, message.markdown])),
    })),
  );
  const fingerprint: CachedConversationTranscriptFingerprint = {
    remoteUrl: snapshot.remoteUrl,
    messageCount: snapshot.messages.length,
    messageHashes,
    transcriptSha256: await transcriptSha256(snapshot.messages),
    transcriptChainSha256: await transcriptChainSha256FromMessageHashes(messageHashes),
    updatedAt: new Date().toISOString(),
  };
  await storeConversationTranscriptFingerprint(fingerprint);
  rememberAttestedConversationTranscriptChain(
    fingerprint.remoteUrl,
    fingerprint.transcriptChainSha256!,
  );
}

function prewarmConversationTranscriptProof(record: TabRecord, proof: ConversationTranscriptProof) {
  if (
    !record.remoteUrl ||
    !sameChatGptConversationIdentity(record.remoteUrl, proof.remoteUrl) ||
    !projectUrlMatchesRecord(record, proof.remoteUrl)
  ) {
    return false;
  }
  const cached = cachedConversationTranscriptFingerprint(record, proof.remoteUrl);
  if (
    cached?.transcriptChainSha256 &&
    cached.transcriptChainSha256 !== proof.transcriptChainSha256
  ) {
    forgetAttestedConversationTranscriptChain(proof.remoteUrl);
  }
  // The Host derived these hashes from its durable, successfully synchronized
  // transcript. Install them in memory before the first async storage write so
  // an immediate Send can validate the virtualized visible suffix without
  // waiting for migration or persisting any message text in Chrome.
  void storeConversationTranscriptFingerprint({
    remoteUrl: proof.remoteUrl,
    messageCount: proof.messageCount,
    messageHashes: proof.messageHashes.map((message) => ({ ...message })),
    transcriptSha256: proof.transcriptChainSha256,
    transcriptChainSha256: proof.transcriptChainSha256,
    updatedAt: new Date().toISOString(),
  });
  return true;
}

async function prewarmConversationDispatchState(
  key: string,
  record: TabRecord,
  tabId: number,
  visibility: Awaited<ReturnType<typeof readTabDispatchVisibility>>,
  holdForDispatchIntent = false,
) {
  if (
    workerSuspended ||
    activeRuns.has(key) ||
    conversationTabs.get(key) !== record ||
    record.tabId !== tabId
  ) {
    return;
  }
  const prepare = async (refreshVisibleSnapshot: boolean) => {
    if (activeRuns.has(key) || conversationTabs.get(key) !== record) return;
    // A complete visible snapshot refreshes the content-free fingerprint and
    // its in-memory attestation. A virtualized non-empty suffix is attested by
    // prepareDispatchTranscriptBaseline against the Host-prewarmed hashes.
    if (refreshVisibleSnapshot) await syncConversationSnapshotFromTab(record, 1);
    if (activeRuns.has(key) || conversationTabs.get(key) !== record) return;
    await prepareDispatchTranscriptBaseline(key, tabId);
  };

  if (holdForDispatchIntent && (visibility.inactive || visibility.minimized || visibility.parked)) {
    const requestedDeadline = Date.now() + DISPATCH_INTENT_PREWARM_HOLD_MS;
    dispatchIntentPrewarmDeadlines.set(
      key,
      Math.max(dispatchIntentPrewarmDeadlines.get(key) ?? 0, requestedDeadline),
    );
    const existingTask = dispatchIntentPrewarmTasks.get(key);
    if (existingTask) {
      await existingTask;
      return;
    }

    const task = withConversationTabActiveInHomeWindow(
      key,
      tabId,
      async () => {
        await prepare(true);
        while (
          !workerSuspended &&
          !activeRuns.has(key) &&
          conversationTabs.get(key) === record &&
          record.tabId === tabId
        ) {
          const remainingMs = (dispatchIntentPrewarmDeadlines.get(key) ?? 0) - Date.now();
          if (remainingMs <= 0) return;
          await delay(Math.min(DISPATCH_INTENT_PREWARM_POLL_MS, remainingMs));
        }
      },
      undefined,
      visibility.minimized,
      true,
    );
    dispatchIntentPrewarmTasks.set(key, task);
    try {
      await task;
    } finally {
      if (dispatchIntentPrewarmTasks.get(key) === task) {
        dispatchIntentPrewarmTasks.delete(key);
        dispatchIntentPrewarmDeadlines.delete(key);
      }
    }
    return;
  }

  if (holdForDispatchIntent) {
    // A normal-window renderer needs no prewarm visibility lease. Refreshing
    // its exact transcript and composer state while the user types still
    // removes that work from the eventual send path; the send phase selects it
    // in the same non-focused Chrome window if it is no longer active.
    await prepare(true);
    return;
  }

  if (visibility.inactive || visibility.minimized || visibility.parked) {
    await withConversationTabActiveInHomeWindow(
      key,
      tabId,
      async () => await prepare(true),
      undefined,
      visibility.minimized,
      true,
    );
    return;
  }
  await prepare(false);
}

async function storeConversationTranscriptFingerprint(
  fingerprint: CachedConversationTranscriptFingerprint,
) {
  for (const [storedUrl] of conversationTranscriptFingerprints) {
    if (sameChatGptConversationIdentity(storedUrl, fingerprint.remoteUrl)) {
      conversationTranscriptFingerprints.delete(storedUrl);
    }
  }
  conversationTranscriptFingerprints.set(fingerprint.remoteUrl, fingerprint);
  const entries = [...conversationTranscriptFingerprints.values()]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, MAX_CONVERSATION_TRANSCRIPT_CACHE_ENTRIES);
  conversationTranscriptFingerprints.clear();
  for (const entry of entries) conversationTranscriptFingerprints.set(entry.remoteUrl, entry);
  const write = conversationTranscriptFingerprintWrite
    .catch(() => undefined)
    .then(async () => {
      await chrome.storage.local.set({
        [CONVERSATION_TRANSCRIPT_CACHE_STORAGE_KEY]: { version: 1, entries },
      });
    });
  conversationTranscriptFingerprintWrite = write;
  await write.catch(() =>
    recordBackgroundFailure("Failed to persist a conversation transcript fingerprint."),
  );
}

async function advanceConversationTranscriptFingerprintFromTerminal(
  run: ActiveRunRecord,
  record: TabRecord,
  event: ValidatedContentEvent,
) {
  const baseline = run.dispatchTranscriptBaseline;
  if (
    event.eventType !== "complete" ||
    !event.remoteUrl ||
    !baseline ||
    !run.submittedPromptMessageSha256 ||
    baseline.messageCount + 2 > 200 ||
    !sameChatGptConversationIdentity(baseline.remoteUrl, event.remoteUrl)
  ) {
    return;
  }
  const cached = cachedConversationTranscriptFingerprint(record, baseline.remoteUrl);
  if (!cached || cached.messageCount !== baseline.messageCount) return;
  const cachedChainSha256 =
    cached.transcriptChainSha256 ??
    (await transcriptChainSha256FromMessageHashes(cached.messageHashes));
  const baselineMatchesCache = baseline.transcriptChainSha256
    ? baseline.transcriptChainSha256 === cachedChainSha256
    : baseline.transcriptSha256 === cached.transcriptSha256;
  if (!baselineMatchesCache) return;
  const baselineWasAttested =
    attestedConversationTranscriptChain(baseline.remoteUrl) === cachedChainSha256;

  const messageHashes: CachedConversationTranscriptFingerprint["messageHashes"] = [
    ...cached.messageHashes,
    { role: "user", sha256: run.submittedPromptMessageSha256 },
    {
      role: "assistant",
      sha256: await sha256Hex(JSON.stringify(["assistant", event.markdown ?? ""])),
    },
  ];
  const transcriptChainSha256 = await transcriptChainSha256FromMessageHashes(messageHashes);
  await storeConversationTranscriptFingerprint({
    remoteUrl: event.remoteUrl,
    messageCount: messageHashes.length,
    messageHashes,
    // An incrementally advanced fingerprint has no plaintext transcript by
    // design. Keep the required legacy slot deterministic while all new
    // prefix comparisons prefer the explicit chain field below.
    transcriptSha256: transcriptChainSha256,
    transcriptChainSha256,
    updatedAt: new Date().toISOString(),
  });
  if (baselineWasAttested) {
    rememberAttestedConversationTranscriptChain(event.remoteUrl, transcriptChainSha256);
  }
}

async function cachedBaselineForPartialSnapshot(
  record: TabRecord,
  snapshot: VisibleConversationSnapshot,
  { allowAttestedEmptyPartial = false }: { allowAttestedEmptyPartial?: boolean } = {},
) {
  const diagnosticKey = conversationKey(record.instanceId, record.conversationId);
  if (snapshot.historyComplete || !projectUrlMatchesRecord(record, snapshot.remoteUrl)) {
    dispatchTranscriptDiagnostics.set(
      diagnosticKey,
      `partial-ineligible historyComplete=${String(snapshot.historyComplete)} visible=${snapshot.messages.length}`,
    );
    return undefined;
  }
  // ChatGPT can virtualize older turns and omit the latest assistant action
  // controls even though the conversation is idle and the ready composer is
  // already visible. `snapshot.complete` is therefore not reliable for this
  // narrow pre-dispatch proof. The cached fingerprint is written only from a
  // structurally complete, terminal transcript, and every currently rendered
  // message below must still match its exact suffix. Any new/changed turn,
  // including an in-progress external send, breaks that suffix comparison and
  // keeps the send fail-closed.
  const cached = cachedConversationTranscriptFingerprint(record, snapshot.remoteUrl);
  if (!cached || snapshot.messages.length > cached.messageCount) {
    dispatchTranscriptDiagnostics.set(
      diagnosticKey,
      `partial-cache visible=${snapshot.messages.length} cached=${cached?.messageCount ?? "none"}`,
    );
    return undefined;
  }
  const transcriptChainSha256 =
    cached.transcriptChainSha256 ??
    (await transcriptChainSha256FromMessageHashes(cached.messageHashes));
  if (snapshot.messages.length === 0) {
    if (
      !allowAttestedEmptyPartial ||
      attestedConversationTranscriptChain(snapshot.remoteUrl) !== transcriptChainSha256
    ) {
      dispatchTranscriptDiagnostics.set(
        diagnosticKey,
        `partial-empty allow=${String(allowAttestedEmptyPartial)} attested=${String(attestedConversationTranscriptChain(snapshot.remoteUrl) === transcriptChainSha256)} cached=${cached.messageCount}`,
      );
      return undefined;
    }
  }
  const offset = cached.messageCount - snapshot.messages.length;
  let renderEquivalentMessages = 0;
  for (let index = 0; index < snapshot.messages.length; index += 1) {
    const message = snapshot.messages[index]!;
    const expected = cached.messageHashes[offset + index];
    const actualSha256 = await sha256Hex(JSON.stringify([message.role, message.markdown]));
    const rawRenderEquivalent =
      message.role === "assistant"
        ? rawAssistantMarkdownForEscapedIntrawordUnderscores(message.markdown)
        : undefined;
    const rawRenderEquivalentSha256 = rawRenderEquivalent
      ? await sha256Hex(JSON.stringify([message.role, rawRenderEquivalent]))
      : undefined;
    const renderEquivalentMatch = Boolean(
      expected && rawRenderEquivalentSha256 && expected.sha256 === rawRenderEquivalentSha256,
    );
    if (
      !expected ||
      expected.role !== message.role ||
      (expected.sha256 !== actualSha256 && !renderEquivalentMatch)
    ) {
      dispatchTranscriptDiagnostics.set(
        diagnosticKey,
        `partial-mismatch visible=${snapshot.messages.length} cached=${cached.messageCount} index=${index} expected=${expected?.role ?? "none"}:${expected?.sha256.slice(0, 8) ?? "none"} actual=${message.role}:${actualSha256.slice(0, 8)}`,
      );
      return undefined;
    }
    if (renderEquivalentMatch) renderEquivalentMessages += 1;
  }
  if (snapshot.messages.length > 0) {
    rememberAttestedConversationTranscriptChain(snapshot.remoteUrl, transcriptChainSha256);
  }
  dispatchTranscriptDiagnostics.set(
    diagnosticKey,
    `partial-accepted visible=${snapshot.messages.length} cached=${cached.messageCount} equivalent=${renderEquivalentMessages}`,
  );
  return {
    remoteUrl: snapshot.remoteUrl,
    messageCount: cached.messageCount,
    transcriptSha256: cached.transcriptSha256,
    transcriptChainSha256,
  };
}

function rawAssistantMarkdownForEscapedIntrawordUnderscores(markdown: string) {
  // ChatGPT renders intraword underscores as literal text. serializeAssistant
  // therefore escapes them (`name_value` -> `name\_value`) even when the
  // streamed Markdown used the unescaped, render-equivalent spelling. Keep
  // this equivalence deliberately narrow: structured Markdown and code spans
  // retain byte-exact ownership checks.
  if (
    ["\r", "\n", "`", "[", "]", "*", "<", ">", "~", "|", "#"].some((token) =>
      markdown.includes(token),
    )
  ) {
    return undefined;
  }
  const candidate = markdown.replace(/([\p{L}\p{N}])\\_(?=[\p{L}\p{N}])/gu, "$1_");
  if (candidate === markdown || candidate.includes("\\")) return undefined;
  const withoutSafeUnderscores = candidate.replace(/[\p{L}\p{N}]_(?=[\p{L}\p{N}])/gu, "");
  return withoutSafeUnderscores.includes("_") ? undefined : candidate;
}

function attestedConversationTranscriptChain(remoteUrl: string) {
  for (const [storedUrl, chain] of attestedConversationTranscriptChains) {
    if (sameChatGptConversationIdentity(storedUrl, remoteUrl)) return chain;
  }
}

function rememberAttestedConversationTranscriptChain(remoteUrl: string, chain: string) {
  forgetAttestedConversationTranscriptChain(remoteUrl);
  attestedConversationTranscriptChains.set(remoteUrl, chain);
}

function forgetAttestedConversationTranscriptChain(remoteUrl: string) {
  for (const storedUrl of attestedConversationTranscriptChains.keys()) {
    if (sameChatGptConversationIdentity(storedUrl, remoteUrl)) {
      attestedConversationTranscriptChains.delete(storedUrl);
    }
  }
}

function prepareRelayReload() {
  if (relayReloadPreparationPromise) return relayReloadPreparationPromise;
  relayReloadPreparationActive = true;
  const attempt = performRelayReloadPreparation();
  relayReloadPreparationPromise = attempt;
  void attempt.catch(() => {
    relayReloadPreparationActive = false;
    relayReloadPreparationPromise = undefined;
    // Connections are deliberately sealed before the durable local checkpoint
    // is written. If that write fails, their close handlers ran while reload
    // preparation was active and therefore did not schedule reconnects.
    rescanPortsNow(false);
  });
  return attempt;
}

function scheduleRelayRuntimeReload() {
  if (relayRuntimeReloadScheduled) return;
  relayRuntimeReloadScheduled = true;
  // Capture this worker's runtime object. Test harnesses replace the global
  // `chrome` between workers, and a queued callback must never reload a later
  // worker. In production the capture is equivalent and makes ownership of
  // the one scheduled reload explicit.
  const runtime = chrome.runtime;
  setTimeout(() => runtime.reload(), 0);
}

async function performRelayReloadPreparation() {
  const deadline = Date.now() + RELAY_RELOAD_TERMINAL_ACK_WAIT_MS;
  while (true) {
    const commands = [...conversationCommands.values()];
    if (commands.length > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error("仍有消息正在提交，暂未重新加载 Relay。请等待发送完成后重试。");
      }
      await promiseWithTimeout(
        Promise.all(commands.map(async (command) => await command)),
        remainingMs,
        "仍有消息正在提交，暂未重新加载 Relay。请等待发送完成后重试。",
      );
    }

    const terminalEntries = [...pendingEvents.entries()].filter(([, pending]) =>
      isTerminalEvent(pending.event),
    );
    if (terminalEntries.length === 0 && conversationCommands.size === 0) break;

    const instanceIds = new Set(terminalEntries.map(([, pending]) => pending.instanceId));
    await Promise.all(
      [...instanceIds].map(async (instanceId) => await flushPendingEvents(instanceId)),
    );
    if (Date.now() >= deadline) {
      throw new Error(
        "回答正在保存到 VS Code，暂未重新加载 Relay。请等待几秒后重试，避免丢失回答。",
      );
    }
    await delay(50);
  }

  // Seal the Host channel before taking the checkpoint. New sends now fail on
  // the VS Code side instead of slipping into the gap between checkpoint and
  // chrome.runtime.reload(). Existing page observers are recovered from the
  // active-run checkpoint after the new worker starts.
  clearReconnectTimers();
  for (const connection of connections.values()) {
    clearConnectTimer(connection);
    connection.authenticated = false;
    if (connection.instanceId) clearPendingEventRetriesForInstance(connection.instanceId);
    try {
      connection.socket.close(1012, "Relay reload prepared");
    } catch {
      // A socket can finish closing between the state check and close().
    }
  }
  const projectBindingVerification =
    projectBinding && projectBindingVerifiedThisSession
      ? {
          version: 1,
          projectUrl: projectBinding.projectUrl,
          boundAt: projectBinding.boundAt,
        }
      : undefined;
  await chrome.storage.local.set({
    [RELAY_RELOAD_CHECKPOINT_STORAGE_KEY]: {
      version: 1,
      expiresAt: new Date(Date.now() + RELAY_RELOAD_CHECKPOINT_TTL_MS).toISOString(),
      conversationTabs: [...conversationTabs.values()],
      activeRuns: [...activeRuns.values()],
      completedCanonicalizations: [...completedCanonicalizations.values()],
      terminalHistoryBarriers: [...terminalHistoryBarriers.values()],
      runVisibilityLeases: serializeRunVisibilityLeases(),
      ...(projectBindingVerification ? { projectBindingVerification } : {}),
    },
  });
}

async function saveProjectBinding(binding: ProjectBinding) {
  const trustedBinding: ProjectBinding = {
    ...binding,
    version: 5,
    provenance: "strict-visible-project-v1",
  };
  projectBinding = trustedBinding;
  projectBindingTrusted = true;
  projectBindingVerifiedThisSession = true;
  await Promise.all([
    chrome.storage.local.set({ [PROJECT_BINDING_STORAGE_KEY]: trustedBinding }).then(async () => {
      await chrome.storage.local.remove(LEGACY_PROJECT_BINDING_STORAGE_KEY).catch(() => undefined);
    }),
    chrome.storage.session.set({
      [PROJECT_BINDING_VERIFICATION_STORAGE_KEY]: {
        version: 1,
        projectUrl: trustedBinding.projectUrl,
        boundAt: trustedBinding.boundAt,
      },
    }),
  ]);
  broadcastStatus();
}

async function invalidateProjectBindingVerification() {
  projectBindingVerifiedThisSession = false;
  await chrome.storage.session
    .remove(PROJECT_BINDING_VERIFICATION_STORAGE_KEY)
    .catch(() => undefined);
  broadcastStatus();
}

async function requireVerifiedProjectBinding() {
  if (projectBinding && projectBindingVerifiedThisSession) return projectBinding;
  if (projectBindingVerificationPromise) return await projectBindingVerificationPromise;
  const verification = verifyProjectBindingForCurrentSession();
  projectBindingVerificationPromise = verification;
  try {
    return await verification;
  } catch (error) {
    // A durable V6 binding was established from visible Project identity. A
    // worker restart, a frozen tab, or a temporarily unhydrated sidebar must
    // not turn that one-time choice into a missing binding. Drop only the
    // session proof and retry verification on the next operation.
    await invalidateProjectBindingVerification();
    throw error;
  } finally {
    if (projectBindingVerificationPromise === verification) {
      projectBindingVerificationPromise = undefined;
    }
  }
}

async function verifyProjectBindingForCurrentSession() {
  const storedBinding = projectBinding;
  if (storedBinding) {
    let verified = await verifyStoredProjectBindingFromOpenTabs(storedBinding);
    verified ??= await verifyStoredProjectBindingFromSavedRoot(storedBinding);
    if (verified) {
      await saveProjectBinding(verified);
      return verified;
    }
    throw relayFailure(
      "CHATGPT_REMOTE_UNAVAILABLE",
      `${projectBindingTrusted ? "已保存" : "旧版保存的"} Ask2GPT Project 本次暂时无法验证。${projectInspectionHint()}原记录已保留且不会切换到其他 Project，请确认 ChatGPT 已登录后重试或显式重新绑定。`,
    );
  }
  let discovered = await discoverUnambiguousProjectBinding();
  if (discovered) await cleanupUnusedProjectDiscoveryTab();
  discovered ??= await discoverAsk2GPTProjectFromFreshHome();
  if (discovered) {
    await saveProjectBinding(discovered);
    return discovered;
  }
  throw relayFailure(
    "CHATGPT_PROJECT_REQUIRED",
    `新会话尚未创建：未能确认 Ask2GPT Project。${projectInspectionHint()}请在 Chrome 中确认登录账号和 Project 名称后重试。`,
  );
}

async function verifyStoredProjectBindingFromOpenTabs(binding: ProjectBinding) {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" }).catch(() => []);
  const matchingTabs = tabs.filter((tab) =>
    projectScopesMatch(projectRouteFromTab(tab)?.scope, binding.scope),
  );
  for (const tab of matchingTabs) {
    if (tab.id === undefined) continue;
    const inspected = await inspectProjectTabUntil(tab.id, PROJECT_INSPECTION_RETRY_WINDOW_MS);
    if (
      inspected &&
      projectScopesMatch(inspected.scope, binding.scope) &&
      isRequiredProjectName(inspected.name)
    ) {
      return inspected;
    }
  }
  return undefined;
}

async function verifyStoredProjectBindingFromSavedRoot(binding: ProjectBinding) {
  const tab = await acquireProjectDiscoveryTab(binding.projectUrl);
  if (!tab || tab.id === undefined) return undefined;
  let keepForUser = false;
  let activationLease: ProjectDiscoveryActivationLease | undefined;
  try {
    activationLease = await activateProjectDiscoveryTab(tab);
    const inspected = await inspectProjectTabUntil(
      tab.id,
      PROJECT_INSPECTION_RETRY_WINDOW_MS,
      true,
    );
    return inspected &&
      projectScopesMatch(inspected.scope, binding.scope) &&
      isRequiredProjectName(inspected.name)
      ? inspected
      : undefined;
  } catch (error) {
    const code = errorCode(error, "CHATGPT_REMOTE_UNAVAILABLE");
    keepForUser = code === "CHATGPT_LOGIN_REQUIRED" || code === "CHATGPT_CHALLENGE_REQUIRED";
    if (keepForUser) {
      try {
        await focusTab(tab.id).catch(() => undefined);
      } finally {
        await relinquishProjectDiscoveryTab(tab.id);
      }
    }
    throw error;
  } finally {
    if (!keepForUser) {
      await restoreProjectDiscoveryActivation(activationLease);
      await cleanupProjectDiscoveryTab(tab.id);
    }
  }
}

async function verifyExplicitProjectCandidateFromFreshTab(route: ProjectRoute) {
  const tab = await acquireProjectDiscoveryTab(route.projectUrl);
  if (!tab || tab.id === undefined) return undefined;
  let keepForUser = false;
  let activationLease: ProjectDiscoveryActivationLease | undefined;
  try {
    activationLease = await activateProjectDiscoveryTab(tab);
    await waitForProjectDiscoveryRoute(tab.id);
    const inspected = await inspectProjectTabUntil(
      tab.id,
      EXPLICIT_PROJECT_VERIFICATION_WINDOW_MS,
      true,
    );
    return inspected &&
      projectScopesMatch(inspected.scope, route.scope) &&
      isRequiredProjectName(inspected.name)
      ? inspected
      : undefined;
  } catch (error) {
    const code = errorCode(error, "CHATGPT_REMOTE_UNAVAILABLE");
    keepForUser = code === "CHATGPT_LOGIN_REQUIRED" || code === "CHATGPT_CHALLENGE_REQUIRED";
    if (keepForUser) {
      try {
        await focusTab(tab.id).catch(() => undefined);
      } finally {
        await relinquishProjectDiscoveryTab(tab.id);
      }
      throw error;
    }
    return undefined;
  } finally {
    if (!keepForUser) {
      await restoreProjectDiscoveryActivation(activationLease);
      await cleanupProjectDiscoveryTab(tab.id);
    }
  }
}

async function discoverUnambiguousProjectBinding() {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" }).catch(() => []);
  const inspected = await Promise.all(
    tabs.flatMap((tab) =>
      tab.id === undefined ? [] : [inspectProjectTab(tab.id).catch(() => undefined)],
    ),
  );
  const namedRoutes = new Map<string, ProjectBinding>();
  for (const candidate of inspected) {
    if (candidate && isRequiredProjectName(candidate.name)) {
      namedRoutes.set(canonicalProjectScope(candidate.scope) ?? candidate.scope, candidate);
    }
  }
  return namedRoutes.size === 1 ? [...namedRoutes.values()][0] : undefined;
}

function isExplicitAsk2GPTRouteCandidate(route: ProjectRoute) {
  if (projectScopesMatch(projectBinding?.scope, route.scope)) return true;
  try {
    const scopeSegment = new URL(route.scope).pathname.split("/").filter(Boolean).at(-1);
    const normalizedScopeSegment = scopeSegment?.toLocaleLowerCase();
    return normalizedScopeSegment?.includes("ask2gpt") === true;
  } catch {
    return false;
  }
}

async function verifyUniqueStaleProjectCandidateFromOpenTabs(
  attemptedScopes: ReadonlySet<string>,
  rejectedScopes: ReadonlySet<string>,
) {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" }).catch(() => []);
  const routes = new Map<string, ProjectRoute>();
  for (const tab of tabs) {
    const route = projectRouteFromTab(tab);
    const scope = route ? canonicalProjectScope(route.scope) : undefined;
    if (
      route &&
      scope &&
      !attemptedScopes.has(scope) &&
      !rejectedScopes.has(scope) &&
      isExplicitAsk2GPTRouteCandidate(route)
    ) {
      routes.set(scope, route);
    }
  }
  if (routes.size !== 1) return undefined;
  return await verifyExplicitProjectCandidateFromFreshTab([...routes.values()][0]!);
}

async function discoverAsk2GPTProjectFromFreshHome() {
  if (projectDiscoveryPromise) return await projectDiscoveryPromise;
  const discovery = discoverAsk2GPTProjectFromOwnedHome();
  projectDiscoveryPromise = discovery;
  try {
    return await discovery;
  } finally {
    if (projectDiscoveryPromise === discovery) projectDiscoveryPromise = undefined;
  }
}

async function discoverAsk2GPTProjectFromOwnedHome() {
  const tab = await acquireProjectDiscoveryTab();
  if (!tab || tab.id === undefined) return undefined;
  let keepForUser = false;
  let activationLease: ProjectDiscoveryActivationLease | undefined;
  try {
    activationLease = await activateProjectDiscoveryTab(tab);
    const existing = await inspectProjectTab(tab.id, true).catch(() => undefined);
    if (existing && isRequiredProjectName(existing.name)) return existing;

    if (projectRouteFromTab(tab)) {
      return undefined;
    }

    await waitForProjectDiscoveryHome(tab.id);
    const discoveryDeadline = Date.now() + 10_000;
    let opened = false;
    while (Date.now() < discoveryDeadline) {
      const inspectedHome = await inspectProjectTab(tab.id, true).catch(() => undefined);
      if (inspectedHome && isRequiredProjectName(inspectedHome.name)) return inspectedHome;
      opened = await openAsk2GPTProjectHome(tab.id);
      if (opened) break;
      await delay(250);
    }
    if (!opened) return undefined;
    await waitForProjectDiscoveryRoute(tab.id);
    const inspectedProject = await inspectProjectTab(tab.id, true).catch(() => undefined);
    if (inspectedProject && isRequiredProjectName(inspectedProject.name)) {
      projectDiscoveryExpectedProjectNavigations.set(tab.id, inspectedProject.projectUrl);
      return inspectedProject;
    }
    return undefined;
  } catch (error) {
    const code = errorCode(error, "CHATGPT_REMOTE_UNAVAILABLE");
    keepForUser = code === "CHATGPT_LOGIN_REQUIRED" || code === "CHATGPT_CHALLENGE_REQUIRED";
    if (keepForUser) {
      try {
        await focusTab(tab.id).catch(() => undefined);
      } finally {
        await relinquishProjectDiscoveryTab(tab.id);
      }
    }
    throw error;
  } finally {
    if (!keepForUser) {
      await restoreProjectDiscoveryActivation(activationLease);
      await cleanupProjectDiscoveryTab(tab.id);
    }
  }
}

interface ProjectDiscoveryActivationLease {
  discoveryTabId: number;
  windowId: number;
  previousActiveTabId?: number;
}

async function activateProjectDiscoveryTab(
  tab: Pick<chrome.tabs.Tab, "id" | "windowId">,
): Promise<ProjectDiscoveryActivationLease> {
  if (tab.id === undefined) {
    throw relayFailure("CHATGPT_REMOTE_UNAVAILABLE", "Project 探测标签页无效。");
  }
  let activeTabs: chrome.tabs.Tab[];
  try {
    activeTabs = await promiseWithTimeout(
      chrome.tabs.query({ active: true, windowId: tab.windowId }),
      1_000,
      "Timed out while capturing the active Chrome tab.",
    );
  } catch (error) {
    throw relayFailure(
      "CHATGPT_REMOTE_UNAVAILABLE",
      errorMessage(error, "无法记录 Chrome 当前活动标签页。"),
      tab.id,
    );
  }
  const previousActiveTabId = activeTabs.find((candidate) => candidate.id !== tab.id)?.id;
  const lease: ProjectDiscoveryActivationLease = {
    discoveryTabId: tab.id,
    windowId: tab.windowId,
    ...(previousActiveTabId === undefined ? {} : { previousActiveTabId }),
  };
  try {
    await promiseWithTimeout(
      chrome.tabs.update(tab.id, { active: true }),
      1_000,
      "Timed out while activating the Project discovery tab.",
    );
    return lease;
  } catch (error) {
    await restoreProjectDiscoveryActivation(lease);
    throw relayFailure(
      "CHATGPT_REMOTE_UNAVAILABLE",
      errorMessage(error, "无法临时激活 Project 探测标签页。"),
      tab.id,
    );
  }
}

async function restoreProjectDiscoveryActivation(
  lease: ProjectDiscoveryActivationLease | undefined,
) {
  const previousTabId = lease?.previousActiveTabId;
  if (!lease || previousTabId === undefined || previousTabId === lease.discoveryTabId) return;
  const [activeTabs, discoveryTab] = await Promise.all([
    promiseWithTimeout(
      chrome.tabs.query({ active: true, windowId: lease.windowId }),
      1_000,
      "Timed out while checking the active Chrome tab.",
    ).catch(() => []),
    promiseWithTimeout(
      chrome.tabs.get(lease.discoveryTabId),
      1_000,
      "Timed out while checking the Project discovery tab.",
    ).catch(() => undefined),
  ]);
  if (
    activeTabs[0]?.id !== lease.discoveryTabId ||
    !discoveryTab ||
    !isClosableProjectDiscoveryTab(discoveryTab)
  ) {
    return;
  }
  const previous = await promiseWithTimeout(
    chrome.tabs.get(previousTabId),
    1_000,
    "Timed out while restoring the previous Chrome tab.",
  ).catch(() => undefined);
  if (previous?.id !== previousTabId || previous.windowId !== lease.windowId) return;
  await promiseWithTimeout(
    chrome.tabs.update(previousTabId, { active: true }),
    1_000,
    "Timed out while restoring the previous Chrome tab.",
  ).catch(() => undefined);
}

async function acquireProjectDiscoveryTab(targetUrl = "https://chatgpt.com/") {
  if (projectDiscoveryTabId !== undefined) {
    const existing = await chrome.tabs.get(projectDiscoveryTabId).catch(() => undefined);
    if (isReusableProjectDiscoveryTarget(existing, targetUrl)) return existing!;
    await cleanupProjectDiscoveryTab(projectDiscoveryTabId);
  }
  const created = await chrome.tabs.create({ url: targetUrl, active: false });
  if (created.id !== undefined) {
    projectDiscoveryTabId = created.id;
    if (parseProjectRootUrl(targetUrl)) {
      projectDiscoveryExpectedProjectNavigations.set(
        created.id,
        normalizeRemoteConversationUrl(targetUrl)!,
      );
    }
    await persistProjectDiscoveryTabId().catch(() => {
      recordBackgroundFailure("Failed to persist the Project discovery tab.");
    });
  }
  return created.id === undefined ? undefined : created;
}

async function cleanupProjectDiscoveryTab(tabId: number) {
  const existing = await chrome.tabs.get(tabId).catch(() => undefined);
  if (existing?.id === undefined) {
    projectDiscoveryExpectedProjectNavigations.delete(tabId);
    if (projectDiscoveryTabId === tabId) {
      projectDiscoveryTabId = undefined;
      await persistProjectDiscoveryTabId().catch(() => undefined);
    }
    return;
  }
  if (!isClosableProjectDiscoveryTab(existing)) {
    await relinquishProjectDiscoveryTab(tabId);
    return;
  }
  closingTabs.add(tabId);
  try {
    await chrome.tabs.remove(tabId);
    if (projectDiscoveryTabId === tabId) {
      projectDiscoveryTabId = undefined;
      await persistProjectDiscoveryTabId().catch(() => undefined);
    }
  } catch {
    // Keep the singleton id so a later retry reuses this tab instead of
    // accumulating another probe when Chrome temporarily refuses removal.
  } finally {
    projectDiscoveryExpectedProjectNavigations.delete(tabId);
    closingTabs.delete(tabId);
  }
}

async function cleanupUnusedProjectDiscoveryTab() {
  const tabId = projectDiscoveryTabId;
  if (tabId === undefined) return;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!isReusableProjectDiscoveryHome(tab)) {
    await relinquishProjectDiscoveryTab(tabId);
    return;
  }
  await cleanupProjectDiscoveryTab(tabId);
}

function isReusableProjectDiscoveryHome(tab: chrome.tabs.Tab | undefined) {
  return Boolean(tab && tab.active !== true && isProjectDiscoveryHome(tab));
}

function isReusableProjectDiscoveryTarget(tab: chrome.tabs.Tab | undefined, targetUrl: string) {
  if (!tab || tab.active === true) return false;
  const normalizedTarget = normalizeRemoteConversationUrl(targetUrl);
  const pendingUrl = normalizeRemoteConversationUrl(tab.pendingUrl);
  return (
    normalizeRemoteConversationUrl(tab.url) === normalizedTarget &&
    (pendingUrl === undefined || pendingUrl === normalizedTarget)
  );
}

function isProjectDiscoveryHome(tab: Pick<chrome.tabs.Tab, "url" | "pendingUrl">) {
  const pageUrl = normalizeRemoteConversationUrl(tab.url);
  const pendingUrl = normalizeRemoteConversationUrl(tab.pendingUrl);
  return (
    pageUrl === "https://chatgpt.com/" &&
    (pendingUrl === undefined || pendingUrl === "https://chatgpt.com/")
  );
}

function isClosableProjectDiscoveryTab(tab: chrome.tabs.Tab) {
  if (isProjectDiscoveryHome(tab)) return true;
  if (tab.id === undefined) return false;
  const expectedUrl = projectDiscoveryExpectedProjectNavigations.get(tab.id);
  if (!expectedUrl) return false;
  const pageUrl = normalizeRemoteConversationUrl(tab.url);
  const pendingUrl = normalizeRemoteConversationUrl(tab.pendingUrl);
  return pageUrl === expectedUrl && (pendingUrl === undefined || pendingUrl === expectedUrl);
}

async function relinquishProjectDiscoveryTab(tabId: number) {
  projectDiscoveryExpectedProjectNavigations.delete(tabId);
  if (projectDiscoveryTabId !== tabId) return;
  projectDiscoveryTabId = undefined;
  await persistProjectDiscoveryTabId().catch(() => undefined);
}

async function persistProjectDiscoveryTabId() {
  await chrome.storage.session.set({
    [PROJECT_DISCOVERY_TAB_STORAGE_KEY]: projectDiscoveryTabId ?? null,
  });
}

async function waitForProjectDiscoveryHome(tabId: number) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    const pageUrl = normalizeRemoteConversationUrl(tab.url);
    if (tab.status === "complete" && !isChatGptPageUrl(tab.url)) {
      throw relayFailure("CHATGPT_LOGIN_REQUIRED", "ChatGPT 登录流程需要在 Chrome 中完成。", tabId);
    }
    if (pageUrl === "https://chatgpt.com/") {
      const response: unknown = await sendToTabWithTimeout(
        tabId,
        { type: "content.ping" },
        500,
      ).catch(() => undefined);
      if (
        isRecord(response) &&
        response.ok === true &&
        isCompatibleContentRuntime(response.selectorVersion) &&
        normalizeRemoteConversationUrl(response.pageUrl) === pageUrl
      ) {
        return;
      }
    }
    await delay(100);
  }
  throw relayFailure(
    "CHATGPT_REMOTE_UNAVAILABLE",
    "用于发现 Project 的 ChatGPT 页面未在 15 秒内加载完成。请检查 ChatGPT 登录页或网络状态。",
    tabId,
  );
}

async function openAsk2GPTProjectHome(tabId: number) {
  const response: unknown = await sendToTabWithTimeout(
    tabId,
    { type: "content.openProjectHome" },
    2_000,
  ).catch(() => undefined);
  if (!isRecord(response)) {
    lastProjectInspectionMessage = "Project 控件检查未返回有效结果。";
    return false;
  }
  if (response.ok === true) return true;
  const error = isRecord(response.error) ? response.error : undefined;
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  lastProjectInspectionMessage = message
    ? message.slice(0, 1_000)
    : "Project 控件检查未返回可用诊断。";
  return false;
}

async function waitForProjectDiscoveryRoute(tabId: number) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && !isChatGptPageUrl(tab.url)) {
      throw relayFailure("CHATGPT_LOGIN_REQUIRED", "ChatGPT 登录流程需要在 Chrome 中完成。", tabId);
    }
    const route = projectRouteFromTab(tab);
    const pageUrl = normalizeRemoteConversationUrl(tab.url);
    if (route && tab.status === "complete" && pageUrl) {
      const response: unknown = await sendToTabWithTimeout(
        tabId,
        { type: "content.ping" },
        500,
      ).catch(() => undefined);
      if (
        isRecord(response) &&
        response.ok === true &&
        isCompatibleContentRuntime(response.selectorVersion) &&
        normalizeRemoteConversationUrl(response.pageUrl) === pageUrl
      ) {
        return;
      }
    }
    await delay(100);
  }
  throw relayFailure(
    "CHATGPT_REMOTE_UNAVAILABLE",
    "Ask2GPT Project 页面未在 15 秒内加载完成。请检查 ChatGPT 页面状态后重试。",
    tabId,
  );
}

function projectRouteFromTab(tab: Pick<chrome.tabs.Tab, "url" | "pendingUrl">) {
  return parseProjectPageUrl(tab.url) ?? parseProjectPageUrl(tab.pendingUrl);
}

function parseProjectSetupState(value: unknown): ProjectSetupState | undefined {
  if (!isRecord(value) || typeof value.phase !== "string") return undefined;
  if (value.phase === "idle") return { phase: "idle" };
  if (
    value.phase === "working" &&
    typeof value.startedAt === "string" &&
    Number.isFinite(Date.parse(value.startedAt))
  ) {
    return { phase: "working", startedAt: value.startedAt };
  }
  if (
    value.phase === "error" &&
    ["LOGIN_REQUIRED", "PROJECT_NOT_FOUND", "PROJECT_AMBIGUOUS", "PAGE_UNAVAILABLE"].includes(
      String(value.reason),
    )
  ) {
    return { phase: "error", reason: value.reason as ProjectSetupReason };
  }
  return undefined;
}

async function persistProjectSetupState() {
  await chrome.storage.session
    .set({ [PROJECT_SETUP_STORAGE_KEY]: projectSetupState })
    .catch(() => recordBackgroundFailure("Failed to persist Project setup status."));
}

async function setProjectSetupState(state: ProjectSetupState) {
  projectSetupState = state;
  await persistProjectSetupState();
}

function projectSetupFailureReason(error: unknown): ProjectSetupReason {
  const code = errorCode(error, "CHATGPT_REMOTE_UNAVAILABLE");
  if (code === "CHATGPT_LOGIN_REQUIRED") return "LOGIN_REQUIRED";
  const message = errorMessage(error, "");
  if (message.includes("多个 ChatGPT Project")) return "PROJECT_AMBIGUOUS";
  if (code === "CHATGPT_PROJECT_REQUIRED" || message.includes("没有检测到")) {
    return "PROJECT_NOT_FOUND";
  }
  return "PAGE_UNAVAILABLE";
}

function bindCurrentProjectFromPopup() {
  if (explicitProjectBindingPromise) return explicitProjectBindingPromise;
  const attempt = runExplicitProjectBinding();
  explicitProjectBindingPromise = attempt;
  void attempt
    .finally(() => {
      if (explicitProjectBindingPromise === attempt) explicitProjectBindingPromise = undefined;
    })
    .catch(() => undefined);
  return attempt;
}

function bindSelectedProjectFromPopup(projectUrl: unknown) {
  if (selectedProjectBindingPromise) return selectedProjectBindingPromise;
  const attempt = runProjectBinding(async () => {
    const route = parseProjectRootUrl(projectUrl);
    if (!route || route.projectUrl !== projectUrl) {
      throw relayFailure("CHATGPT_PROJECT_REQUIRED", "请选择一个有效的 ChatGPT Project。");
    }
    const candidates = await listVisibleProjectCandidates();
    const selected = candidates.find((candidate) => candidate.scope === route.scope);
    if (!selected) {
      throw relayFailure(
        "CHATGPT_PROJECT_REQUIRED",
        "没有找到刚才选择的 Project。请重新打开 Project 后再检测。",
      );
    }
    return createProjectBinding(route, selected.name);
  });
  selectedProjectBindingPromise = attempt;
  void attempt
    .finally(() => {
      if (selectedProjectBindingPromise === attempt) selectedProjectBindingPromise = undefined;
    })
    .catch(() => undefined);
  return attempt;
}

function createDedicatedProjectFromPopup() {
  if (projectCreationPromise) return projectCreationPromise;
  let created = false;
  const attempt = (async () => {
    const binding = await runProjectBinding(async () => {
      const tab = await getProjectCreationTab();
      if (tab.id === undefined) {
        throw relayFailure("CHATGPT_REMOTE_UNAVAILABLE", "无法打开 ChatGPT 页面。 ");
      }
      const response = await sendToTab(
        tab.id,
        { type: "content.createProject" },
        {
          totalTimeoutMs: PROJECT_CREATE_RETRY_WINDOW_MS,
          responseTimeoutMs: PROJECT_CREATE_RESPONSE_TIMEOUT_MS,
        },
      );
      const candidate = parseCreatedProjectResponse(response);
      created = candidate.created;
      return createProjectBinding(candidate, candidate.name);
    });
    return { binding, created };
  })();
  projectCreationPromise = attempt;
  void attempt
    .finally(() => {
      if (projectCreationPromise === attempt) projectCreationPromise = undefined;
    })
    .catch(() => undefined);
  return attempt;
}

async function getProjectCreationTab() {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" }).catch(() => []);
  const candidates = [...tabs].sort(
    (left, right) => Number(right.active === true) - Number(left.active === true),
  );
  for (const tab of candidates) {
    if (tab.id === undefined) continue;
    const response: unknown = await sendToTabWithTimeout(
      tab.id,
      { type: "content.ping" },
      1_000,
    ).catch((): undefined => undefined);
    if (
      isRecord(response) &&
      response.ok === true &&
      isCompatibleContentRuntime(response.selectorVersion)
    ) {
      return tab;
    }
  }
  return await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
}

function parseCreatedProjectResponse(response: unknown) {
  if (!isRecord(response) || response.ok !== true) {
    const error = isRecord(response) && isRecord(response.error) ? response.error : undefined;
    const code =
      error &&
      typeof error.code === "string" &&
      (relayErrorCodes as readonly string[]).includes(error.code)
        ? (error.code as RelayErrorCode)
        : "CHATGPT_PROJECT_REQUIRED";
    const message =
      error && typeof error.message === "string"
        ? error.message
        : "ChatGPT 没有完成 Ask2GPT Project 创建。";
    throw relayFailure(code, message);
  }
  const route = parseProjectRootUrl(response.projectUrl);
  const name = typeof response.name === "string" ? response.name.trim() : "";
  if (
    !route ||
    response.selectorVersion !== SELECTOR_VERSION ||
    response.projectEvidenceVersion !== PROJECT_EVIDENCE_VERSION ||
    name !== REQUIRED_PROJECT_NAME ||
    (response.created !== true && response.created !== false)
  ) {
    throw relayFailure(
      "CHATGPT_PROJECT_REQUIRED",
      "ChatGPT 没有返回可验证的 Ask2GPT Project。请保持页面打开后重试。",
    );
  }
  return { ...route, name, created: response.created };
}

async function listVisibleProjectCandidates(): Promise<PopupProjectCandidate[]> {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" }).catch(() => []);
  const responses = await Promise.all(
    tabs.flatMap((tab) =>
      tab.id === undefined
        ? []
        : [
            sendToTabWithTimeout(tab.id, { type: "content.listProjects" }, 2_000).catch(
              () => undefined,
            ),
          ],
    ),
  );
  const candidates = new Map<string, PopupProjectCandidate>();
  for (const response of responses) {
    if (
      !isRecord(response) ||
      response.ok !== true ||
      !isCompatibleContentRuntime(response.selectorVersion) ||
      response.projectEvidenceVersion !== PROJECT_EVIDENCE_VERSION ||
      !Array.isArray(response.projects)
    ) {
      continue;
    }
    for (const value of response.projects) {
      if (!isRecord(value)) continue;
      const route = parseProjectRootUrl(value.projectUrl);
      const name = typeof value.name === "string" ? value.name.trim() : "";
      if (
        !route ||
        route.scope !== value.scope ||
        name.length < 1 ||
        name.length > 120 ||
        /[\p{Cc}\p{Cf}]/u.test(name)
      ) {
        continue;
      }
      candidates.set(route.scope, { ...route, name });
    }
  }
  return [...candidates.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.projectUrl.localeCompare(right.projectUrl),
  );
}

async function runProjectBinding(resolveBinding: () => Promise<ProjectBinding>) {
  await setProjectSetupState({ phase: "working", startedAt: new Date().toISOString() });
  try {
    const binding = await resolveBinding();
    await saveProjectBinding(binding);
    await setProjectSetupState({ phase: "idle" });
    return binding;
  } catch (error) {
    await setProjectSetupState({ phase: "error", reason: projectSetupFailureReason(error) });
    throw error;
  }
}

async function runExplicitProjectBinding() {
  return await runProjectBinding(resolveExplicitProjectBinding);
}

async function resolveExplicitProjectBinding() {
  const [activeTab] = await chrome.tabs
    .query({ active: true, currentWindow: true })
    .catch(() => []);
  const activeRoute = activeTab ? projectRouteFromTab(activeTab) : undefined;
  let activeProjectInspection: ProjectBinding | undefined;
  const attemptedFreshScopes = new Set<string>();
  const rejectedScopes = new Set<string>();
  if (activeRoute && activeTab?.id !== undefined) {
    const activeInspectionOutcome = await inspectProjectTabUntilOutcome(
      activeTab.id,
      PROJECT_INSPECTION_RETRY_WINDOW_MS,
      true,
    );
    activeProjectInspection =
      activeInspectionOutcome.kind === "verified" ? activeInspectionOutcome.binding : undefined;
    if (
      activeProjectInspection &&
      projectScopesMatch(activeProjectInspection.scope, activeRoute.scope) &&
      isRequiredProjectName(activeProjectInspection.name)
    ) {
      await cleanupUnusedProjectDiscoveryTab();
      return activeProjectInspection;
    }
    if (activeInspectionOutcome.kind === "mismatch") {
      rejectedScopes.add(canonicalProjectScope(activeRoute.scope) ?? activeRoute.scope);
    }
    if (
      activeInspectionOutcome.kind === "unavailable" &&
      isExplicitAsk2GPTRouteCandidate(activeRoute)
    ) {
      attemptedFreshScopes.add(canonicalProjectScope(activeRoute.scope) ?? activeRoute.scope);
      const freshlyVerified = await verifyExplicitProjectCandidateFromFreshTab(activeRoute);
      if (freshlyVerified) return freshlyVerified;
    }
  }

  // The popup may be opened from a Chrome window whose active tab belongs to a
  // different Project. A verified Ask2GPT page in another window is a
  // stronger signal than whichever tab happened to own popup focus, so keep
  // looking before reporting an active-tab mismatch.
  const discovered = await discoverUnambiguousProjectBinding();
  if (discovered) {
    await cleanupUnusedProjectDiscoveryTab();
    return discovered;
  }

  // Reloading an unpacked extension does not update content scripts already
  // attached to open pages. A route hint may nominate one candidate for a
  // fresh, strict verification, but it is never accepted as identity evidence.
  const freshlyVerifiedOpenCandidate = await verifyUniqueStaleProjectCandidateFromOpenTabs(
    attemptedFreshScopes,
    rejectedScopes,
  );
  if (freshlyVerifiedOpenCandidate) return freshlyVerifiedOpenCandidate;

  if (activeRoute) {
    throw new Error(
      activeProjectInspection
        ? `当前标签页属于“${activeProjectInspection.name}”，不是 Ask2GPT Project。已同时检查其他 Chrome 窗口，但没有找到可验证的 Ask2GPT Project。`
        : `无法确认当前 Project 是 Ask2GPT。${projectInspectionHint()}已同时检查其他 Chrome 窗口，请确认 ChatGPT 登录账号和 Project 名称后重试。`,
    );
  }

  const projectTabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" }).catch(() => []);
  const projectScopes = new Set(
    projectTabs.flatMap((tab) => {
      const route = projectRouteFromTab(tab);
      const scope = route ? canonicalProjectScope(route.scope) : undefined;
      return scope ? [scope] : [];
    }),
  );
  if (projectScopes.size > 1) {
    throw new Error(
      "检测到多个 ChatGPT Project。请切换到要用于 Ask2GPT 的 Project 标签页，再点击一次绑定。",
    );
  }

  // With no active Project and no ambiguous set of open Project routes, a
  // Relay-owned home tab may locate the one exact sidebar entry. The directory
  // bridge remains fixed-endpoint and strict-schema; URLs alone are never
  // accepted as identity evidence.
  const discoveredFromFreshHome = await discoverAsk2GPTProjectFromFreshHome();
  if (discoveredFromFreshHome) return discoveredFromFreshHome;

  throw new Error(
    `没有检测到可验证的 Ask2GPT Project。${projectInspectionHint()}请确认当前 ChatGPT 登录账号和 Project 名称后重试。`,
  );
}

type ProjectInspectionOutcome =
  { kind: "verified"; binding: ProjectBinding } | { kind: "mismatch" } | { kind: "unavailable" };

async function inspectProjectTabOutcome(
  tabId: number,
  allowDirectoryRefresh = false,
): Promise<ProjectInspectionOutcome> {
  const response: unknown = await sendToTabWithTimeout(
    tabId,
    { type: allowDirectoryRefresh ? "content.discoverProject" : "content.inspectProject" },
    2_000,
  );
  if (!isRecord(response)) return { kind: "unavailable" };
  if (response.ok !== true) {
    const error = isRecord(response.error) ? response.error : undefined;
    if (error?.code === "CHATGPT_PROJECT_MISMATCH") return { kind: "mismatch" };
    const message = typeof error?.message === "string" ? error.message.trim() : "";
    if (message) lastProjectInspectionMessage = message.slice(0, 1_000);
    return { kind: "unavailable" };
  }
  const route = parseProjectRootUrl(response.projectUrl);
  if (
    !route ||
    response.projectEvidenceVersion !== PROJECT_EVIDENCE_VERSION ||
    response.scope !== route.scope ||
    typeof response.name !== "string" ||
    response.name !== response.name.trim() ||
    response.name.length < 1 ||
    response.name.length > 120 ||
    /\p{Cc}/u.test(response.name)
  ) {
    return { kind: "unavailable" };
  }
  lastProjectInspectionMessage = undefined;
  return { kind: "verified", binding: createProjectBinding(route, response.name) };
}

async function inspectProjectTab(tabId: number, allowDirectoryRefresh = false) {
  const outcome = await inspectProjectTabOutcome(tabId, allowDirectoryRefresh);
  return outcome.kind === "verified" ? outcome.binding : undefined;
}

async function inspectProjectTabUntil(
  tabId: number,
  timeoutMs: number,
  allowDirectoryRefresh = false,
) {
  const outcome = await inspectProjectTabUntilOutcome(tabId, timeoutMs, allowDirectoryRefresh);
  return outcome.kind === "verified" ? outcome.binding : undefined;
}

async function inspectProjectTabUntilOutcome(
  tabId: number,
  timeoutMs: number,
  allowDirectoryRefresh = false,
): Promise<ProjectInspectionOutcome> {
  const deadline = Date.now() + timeoutMs;
  do {
    const outcome = await inspectProjectTabOutcome(tabId, allowDirectoryRefresh).catch(
      (): ProjectInspectionOutcome => ({ kind: "unavailable" }),
    );
    if (outcome.kind !== "unavailable") return outcome;
    if (Date.now() >= deadline) return outcome;
    await delay(PROJECT_INSPECTION_RETRY_MS);
  } while (Date.now() < deadline);
  return { kind: "unavailable" };
}

function projectInspectionHint() {
  return lastProjectInspectionMessage ? `${lastProjectInspectionMessage} ` : "";
}

async function adoptVisibleAsk2GPTProject(tabId: number) {
  if (projectBinding && projectBindingVerifiedThisSession) return;
  const inspected = await inspectProjectTab(tabId).catch(() => undefined);
  if (inspected && isRequiredProjectName(inspected.name)) {
    await saveProjectBinding(inspected);
  }
}

function isRequiredProjectName(value: string) {
  const normalized = value.trim().toLocaleLowerCase();
  return normalized === REQUIRED_PROJECT_NAME.toLocaleLowerCase();
}

function projectRouteForRecord(record: TabRecord): ProjectRoute | undefined {
  if (!record.projectScope) return undefined;
  const route = parseProjectRootUrl(`${record.projectScope}project`);
  return route && projectScopesMatch(route.scope, record.projectScope) ? route : undefined;
}

function projectUrlMatchesRecord(record: TabRecord, value: string | undefined) {
  const route = projectRouteForRecord(record);
  if (!route) return false;
  return Boolean(value && normalizeProjectScopedUrl(value, route));
}

async function findReusableUntrackedConversationTab(
  requestedConversationUrl: string | undefined,
  targetProjectRoute: ProjectRoute,
) {
  if (!requestedConversationUrl) return undefined;
  const reservedTabIds = new Set([...conversationTabs.values()].map((record) => record.tabId));
  if (projectDiscoveryTabId !== undefined) reservedTabIds.add(projectDiscoveryTabId);
  const candidates = (await chrome.tabs.query({ url: "https://chatgpt.com/*" }))
    .filter((tab): tab is chrome.tabs.Tab & { id: number } => {
      if (tab.id === undefined || reservedTabIds.has(tab.id) || !isChatGptPageUrl(tab.url)) {
        return false;
      }
      const currentUrl = normalizeRemoteConversationUrl(tab.url);
      const currentRoute = currentUrl ? parseProjectPageUrl(currentUrl) : undefined;
      return Boolean(
        currentUrl &&
        currentRoute &&
        isRemoteConversationPage(currentUrl) &&
        sameChatGptConversationIdentity(currentUrl, requestedConversationUrl) &&
        projectScopesMatch(currentRoute.scope, targetProjectRoute.scope),
      );
    })
    .sort(
      (left, right) =>
        Number(left.active) - Number(right.active) ||
        Number(left.discarded === true) - Number(right.discarded === true) ||
        (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0) ||
        right.id - left.id,
    );
  return candidates[0];
}

async function ensureConversationTab(
  instanceId: string,
  conversationId: string,
  remoteUrl?: string,
) {
  const normalizedRemoteUrl =
    remoteUrl === undefined ? undefined : normalizeRemoteConversationUrl(remoteUrl);
  if (remoteUrl !== undefined && !normalizedRemoteUrl) {
    throw relayFailure(
      "CHATGPT_REMOTE_UNAVAILABLE",
      "本地会话 URL 不是可识别的 ChatGPT 页面；未打开或发送。",
    );
  }
  const targetProjectRoute = await requireVerifiedProjectBinding();
  if (normalizedRemoteUrl) {
    const requestedRoute = parseProjectPageUrl(normalizedRemoteUrl);
    if (!requestedRoute || !projectScopesMatch(requestedRoute.scope, targetProjectRoute.scope)) {
      throw relayFailure(
        "CHATGPT_PROJECT_MISMATCH",
        requestedRoute
          ? "该本地会话属于另一个 ChatGPT Project；已保留本地历史，未打开或发送。请新建 Ask2GPT 会话。"
          : "该本地会话没有可验证的 Ask2GPT Project 归属；已保留本地历史，未打开或发送。请新建 Ask2GPT 会话。",
      );
    }
  }
  const targetUrl = normalizedRemoteUrl ?? targetProjectRoute.projectUrl;
  const requestedConversationUrl =
    normalizedRemoteUrl && isRemoteConversationPage(normalizedRemoteUrl)
      ? normalizedRemoteUrl
      : undefined;
  const key = conversationKey(instanceId, conversationId);
  const existing = conversationTabs.get(key);
  if (existing) {
    if (existing.remoteUrl) {
      const existingRemoteRoute = parseProjectPageUrl(existing.remoteUrl);
      if (
        !existingRemoteRoute ||
        !projectScopesMatch(existingRemoteRoute?.scope, targetProjectRoute.scope) ||
        (existing.projectScope !== undefined &&
          !projectScopesMatch(existing.projectScope, targetProjectRoute.scope))
      ) {
        throw relayFailure(
          "CHATGPT_PROJECT_MISMATCH",
          "该会话现有的 ChatGPT 映射不属于当前 Ask2GPT Project；已保留本地历史和原映射，未导航或发送。",
          existing.tabId,
        );
      }
    }
    const tab = await promiseWithTimeout(
      chrome.tabs.get(existing.tabId),
      1_000,
      "Chrome tab inspection timed out.",
    ).catch(() => undefined);
    if (tab?.id !== undefined && isChatGptPageUrl(tab.url)) {
      // A conversation that already has a remote mapping stays pinned to that
      // conversation. The Host can briefly carry an older provisional URL,
      // but a user manually browsing this owned tab to another /c/... page
      // must never silently rebind the local Ask2GPT conversation.
      const mappedConversationUrl = existing.remoteUrl ?? requestedConversationUrl;
      const mappedTargetUrl = mappedConversationUrl ?? targetProjectRoute.projectUrl;
      const currentUrl = normalizeRemoteConversationUrl(tab.url);
      const currentConversationUrl =
        currentUrl && isRemoteConversationPage(currentUrl) ? currentUrl : undefined;
      const enforcedProjectRoute = targetProjectRoute;
      const currentProjectUrl =
        currentUrl && enforcedProjectRoute
          ? normalizeProjectScopedUrl(currentUrl, enforcedProjectRoute)
          : undefined;
      // An existing owned tab is the live remote session. Do not navigate it
      // backwards merely because VS Code persisted an older provisional URL.
      if (
        currentUrl &&
        currentProjectUrl &&
        ((currentConversationUrl &&
          mappedConversationUrl &&
          sameChatGptConversationIdentity(currentConversationUrl, mappedConversationUrl)) ||
          (!mappedConversationUrl && currentUrl === mappedTargetUrl))
      ) {
        if (!projectScopesMatch(existing.projectScope, enforcedProjectRoute.scope)) {
          existing.projectScope = enforcedProjectRoute.scope;
          await persistSession();
        }
        if (tab.discarded) await chrome.tabs.reload(tab.id);
        const readyUrl = await waitForTab(
          key,
          tab.id,
          mappedConversationUrl ?? mappedTargetUrl,
          Boolean(mappedConversationUrl),
        );
        await adoptReadyConversationUrl(key, existing, readyUrl);
        await adoptVisibleAsk2GPTProject(tab.id);
        return tab.id;
      }
      if (
        !existing.remoteUrl &&
        !projectScopesMatch(existing.projectScope, targetProjectRoute.scope)
      ) {
        // A prewarmed Project root has no remote conversation to preserve. It
        // may safely follow a newly verified binding, but the authoritative
        // scope always comes from that binding rather than from remoteUrl.
        existing.projectScope = targetProjectRoute.scope;
        await persistSession();
      }
      grantExpectedTabNavigation(key, tab.id);
      await chrome.tabs.update(tab.id, { url: mappedTargetUrl, active: false });
      if (existing.remoteUrl !== mappedConversationUrl) existing.remoteTitle = undefined;
      existing.remoteUrl = mappedConversationUrl;
      existing.projectScope = targetProjectRoute.scope;
      await persistSession();
      let readyUrl: string;
      try {
        readyUrl = await waitForTab(key, tab.id, mappedTargetUrl, Boolean(mappedConversationUrl));
      } finally {
        clearExpectedTabNavigation(key, tab.id);
      }
      await adoptReadyConversationUrl(key, existing, readyUrl);
      await adoptVisibleAsk2GPTProject(tab.id);
      return tab.id;
    }
    conversationTabs.delete(key);
    terminalHistoryBarriers.delete(key);
    expectedTabNavigations.delete(key);
    await persistSession();
  }

  // chrome://extensions reload clears chrome.storage.session without closing
  // the Relay's existing ChatGPT pages. Re-adopt an untracked tab only when it
  // displays the exact requested conversation inside the verified Project.
  // This preserves lazy startup while avoiding a new cold tab for every manual
  // extension reload.
  const reusableTab = await findReusableUntrackedConversationTab(
    requestedConversationUrl,
    targetProjectRoute,
  );
  if (reusableTab) {
    conversationTabs.set(key, {
      owned: true,
      instanceId,
      conversationId,
      tabId: reusableTab.id,
      remoteUrl: requestedConversationUrl,
      projectScope: targetProjectRoute.scope,
      createdAt: new Date().toISOString(),
    });
    await persistSession();
    const readyUrl = await waitForTab(key, reusableTab.id, requestedConversationUrl, true);
    const record = conversationTabs.get(key);
    if (record?.tabId === reusableTab.id) await adoptReadyConversationUrl(key, record, readyUrl);
    await adoptVisibleAsk2GPTProject(reusableTab.id);
    return reusableTab.id;
  }

  const tab = await chrome.tabs.create({
    url: targetUrl,
    active: false,
  });
  if (tab.id === undefined) {
    throw relayFailure("CHATGPT_REMOTE_UNAVAILABLE", "Chrome 未创建 ChatGPT 标签页。");
  }
  conversationTabs.set(key, {
    owned: true,
    instanceId,
    conversationId,
    tabId: tab.id,
    ...(requestedConversationUrl ? { remoteUrl: requestedConversationUrl } : {}),
    projectScope: targetProjectRoute.scope,
    createdAt: new Date().toISOString(),
  });
  grantExpectedTabNavigation(key, tab.id);
  await persistSession();
  let readyUrl: string;
  try {
    readyUrl = await waitForTab(key, tab.id, targetUrl, Boolean(requestedConversationUrl));
  } finally {
    clearExpectedTabNavigation(key, tab.id);
  }
  const record = conversationTabs.get(key);
  if (record?.tabId === tab.id) await adoptReadyConversationUrl(key, record, readyUrl);
  await adoptVisibleAsk2GPTProject(tab.id);
  return tab.id;
}

async function waitForTab(
  key: string,
  tabId: number,
  expectedUrl?: string,
  allowConversationRedirect = false,
) {
  const deadline = Date.now() + 20_000;
  let retryDelay = 50;
  let contentRuntimeReloaded = false;
  let contentRuntimeMissingSince: number | undefined;
  while (Date.now() < deadline) {
    const tab = await promiseWithTimeout(
      chrome.tabs.get(tabId),
      1_000,
      "Chrome tab inspection timed out.",
    ).catch(() => undefined);
    if (!tab) {
      await delay(retryDelay);
      retryDelay = Math.min(400, retryDelay * 2);
      continue;
    }
    const currentUrl = normalizeRemoteConversationUrl(tab.url);
    const expectedUrlMatches = expectedConversationNavigationMatches(
      expectedUrl,
      currentUrl,
      allowConversationRedirect,
    );
    let staleContentRuntimeObserved = false;
    let missingContentRuntimeObserved = false;
    if (isChatGptPageUrl(tab.url) && currentUrl && expectedUrlMatches) {
      try {
        const response: unknown = await sendToTabWithTimeout(
          tabId,
          { type: "content.ping" },
          1_000,
        );
        if (
          isRecord(response) &&
          response.ok === true &&
          normalizeRemoteConversationUrl(response.pageUrl) === currentUrl
        ) {
          if (isCompatibleContentRuntime(response.selectorVersion)) return currentUrl;
          staleContentRuntimeObserved = true;
        } else {
          missingContentRuntimeObserved = true;
        }
      } catch {
        missingContentRuntimeObserved = true;
      }
    }
    if (missingContentRuntimeObserved && tab.status === "complete") {
      contentRuntimeMissingSince ??= Date.now();
    } else {
      contentRuntimeMissingSince = undefined;
    }
    const contentRuntimeUnresponsive = Boolean(
      contentRuntimeMissingSince !== undefined && Date.now() - contentRuntimeMissingSince >= 500,
    );
    if (
      (staleContentRuntimeObserved || contentRuntimeUnresponsive) &&
      !contentRuntimeReloaded &&
      currentUrl !== undefined &&
      tab.status === "complete"
    ) {
      const currentOwnedTab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (
        conversationTabs.get(key)?.tabId !== tabId ||
        normalizeRemoteConversationUrl(currentOwnedTab?.url) !== currentUrl
      ) {
        throw relayFailure(
          "CHATGPT_REMOTE_UNAVAILABLE",
          "The mapped ChatGPT tab changed while Ask2GPT was refreshing its content runtime.",
          tabId,
        );
      }
      // Updating an unpacked extension disconnects content scripts already
      // installed in open pages. Reinstall the current bridge/runtime into an
      // otherwise healthy page first so its hydrated transcript is preserved.
      // An explicitly stale responding runtime still requires an exact reload
      // because two live message listeners could race to answer the worker.
      contentRuntimeReloaded = true;
      const injected = contentRuntimeUnresponsive
        ? await injectOwnedContentRuntime(key, tabId, currentUrl)
        : false;
      if (!injected) await refreshOwnedContentRuntime(key, tabId, currentUrl);
      retryDelay = 50;
      contentRuntimeMissingSince = undefined;
      continue;
    }
    if (tab.status === "complete") {
      if (!isChatGptPageUrl(tab.url)) {
        throw relayFailure(
          "CHATGPT_LOGIN_REQUIRED",
          "ChatGPT 登录流程需要在 Chrome 中完成。",
          tabId,
        );
      }
      if (!currentUrl) {
        throw relayFailure(
          "CHATGPT_REMOTE_UNAVAILABLE",
          "ChatGPT 标签页没有停留在可识别的问答页面。",
          tabId,
        );
      }
      if (expectedUrl && !expectedUrlMatches) {
        throw relayFailure(
          "CHATGPT_REMOTE_UNAVAILABLE",
          "ChatGPT 标签页没有打开请求的远端会话。",
          tabId,
        );
      }
      // The URL is correct, but the isolated content script is not ready yet.
    }
    await delay(retryDelay);
    retryDelay = Math.min(400, retryDelay * 2);
  }
  throw relayFailure("CHATGPT_REMOTE_UNAVAILABLE", "ChatGPT 页面未在 20 秒内加载完成。", tabId);
}

function ownedContentRuntimeTranscriptHydrated(
  key: string,
  expectedUrl: string,
  inspection: unknown,
) {
  const record = conversationTabs.get(key);
  const expectsConversation = isRemoteConversationPage(expectedUrl);
  const snapshot = expectsConversation ? parseVisibleConversationSnapshot(inspection) : undefined;
  return expectsConversation
    ? Boolean(
        record &&
        snapshot?.historyComplete &&
        sameChatGptConversationIdentity(expectedUrl, snapshot.remoteUrl) &&
        projectUrlMatchesRecord(record, snapshot.remoteUrl),
      )
    : parseEmptyInitialProjectTranscript(inspection, expectedUrl) === expectedUrl;
}

async function installCurrentContentRuntimeFiles(tabId: number) {
  const scripting = (
    chrome as typeof chrome & { scripting?: Pick<typeof chrome.scripting, "executeScript"> }
  ).scripting;
  if (!scripting) return false;
  // The MAIN-world bridge is idempotent through its page-global Symbol guard.
  // Installing both files also supports pages that predate the extension, while
  // preserving the already-hydrated React transcript and the user's window state.
  await promiseWithTimeout(
    scripting.executeScript({
      target: { tabId },
      files: ["page-model-bridge.js"],
      world: "MAIN",
      injectImmediately: true,
    }),
    3_000,
    "Timed out while restoring the Ask2GPT page bridge.",
  );
  await promiseWithTimeout(
    scripting.executeScript({
      target: { tabId },
      files: ["content-script.js"],
      world: "ISOLATED",
      injectImmediately: true,
    }),
    3_000,
    "Timed out while restoring the Ask2GPT content runtime.",
  );
  return true;
}

async function injectOwnedContentRuntime(key: string, tabId: number, expectedUrl: string) {
  const currentOwnedTab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (
    conversationTabs.get(key)?.tabId !== tabId ||
    normalizeRemoteConversationUrl(currentOwnedTab?.url) !== expectedUrl
  ) {
    throw relayFailure(
      "CHATGPT_REMOTE_UNAVAILABLE",
      "The mapped ChatGPT tab changed while Ask2GPT was restoring its content runtime.",
      tabId,
    );
  }
  if (!(await installCurrentContentRuntimeFiles(tabId))) return false;
  const deadline = Date.now() + 5_000;
  let lastPing = "none";
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (
      conversationTabs.get(key)?.tabId !== tabId ||
      normalizeRemoteConversationUrl(tab?.url) !== expectedUrl
    ) {
      throw relayFailure(
        "CHATGPT_REMOTE_UNAVAILABLE",
        "The mapped ChatGPT tab changed while Ask2GPT was restoring its content runtime.",
        tabId,
      );
    }
    const response: unknown = await sendToTabWithTimeout(
      tabId,
      { type: "content.ping" },
      1_000,
    ).catch(() => undefined);
    lastPing = isRecord(response)
      ? `ok=${String(response.ok)} url=${String(response.pageUrl)} revision=${String(response.selectorVersion)}`
      : String(response);
    if (
      isRecord(response) &&
      response.ok === true &&
      normalizeRemoteConversationUrl(response.pageUrl) === expectedUrl &&
      isCompatibleContentRuntime(response.selectorVersion)
    ) {
      return true;
    }
    await delay(100);
  }
  throw new Error(`The injected Ask2GPT runtime did not become ready. ping=[${lastPing}]`);
}

async function refreshOwnedContentRuntime(key: string, tabId: number, expectedUrl: string) {
  const reloadAndAwaitFreshRuntime = async () => {
    await promiseWithTimeout(
      chrome.tabs.reload(tabId),
      5_000,
      "Timed out while refreshing the Ask2GPT content runtime.",
    );
    const deadline = Date.now() + 12_000;
    let rendererWakeAttempted = false;
    while (Date.now() < deadline) {
      const currentOwnedTab = await chrome.tabs.get(tabId).catch(() => undefined);
      const currentUrl = normalizeRemoteConversationUrl(currentOwnedTab?.url);
      if (conversationTabs.get(key)?.tabId !== tabId || currentUrl !== expectedUrl) {
        throw relayFailure(
          "CHATGPT_REMOTE_UNAVAILABLE",
          "The mapped ChatGPT tab changed while Ask2GPT was refreshing its content runtime.",
          tabId,
        );
      }
      if (currentOwnedTab?.status === "complete") {
        const response: unknown = await sendToTabWithTimeout(
          tabId,
          { type: "content.ping" },
          1_000,
        ).catch(() => undefined);
        if (
          isRecord(response) &&
          response.ok === true &&
          normalizeRemoteConversationUrl(response.pageUrl) === expectedUrl &&
          isCompatibleContentRuntime(response.selectorVersion)
        ) {
          if (!rendererWakeAttempted) {
            rendererWakeAttempted = true;
            const run = activeRuns.get(key);
            if (run && enhancedBackgroundEnabled) {
              await wakeEnhancedBackgroundPage(key, run, tabId);
            }
          }
          const inspection: unknown = await sendToTabWithTimeout(
            tabId,
            { type: "content.inspectConversation" },
            1_000,
          ).catch(() => undefined);
          if (ownedContentRuntimeTranscriptHydrated(key, expectedUrl, inspection)) return;
        }
      }
      await delay(100);
    }
    throw relayFailure(
      "CHATGPT_REMOTE_UNAVAILABLE",
      "The refreshed ChatGPT page did not start the current Ask2GPT content runtime.",
      tabId,
    );
  };

  // Chrome can defer a page reload indefinitely while its entire window is
  // minimized. Wake only the exact owned tab behind the current application,
  // wait for the new runtime handshake, and restore the original Chrome state.
  if (enhancedBackgroundEnabled && (await isTabWindowMinimized(tabId))) {
    await withTransientConversationTabActivation(
      key,
      tabId,
      reloadAndAwaitFreshRuntime,
      undefined,
      true,
    );
    return;
  }
  await reloadAndAwaitFreshRuntime();
}

async function assertPreDispatchPage(key: string, run: ActiveRunRecord, tabId: number) {
  const record = conversationTabs.get(key);
  if (!record || record.tabId !== tabId || activeRuns.get(key) !== run) {
    throw relayFailure("CHATGPT_REMOTE_UNAVAILABLE", "会话标签页映射已发生变化。", tabId);
  }
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (
    !tab?.url ||
    !mappingStillOwnsTab(conversationTabs.get(key), record, tabId) ||
    activeRuns.get(key) !== run
  ) {
    throw relayFailure("CHATGPT_REMOTE_UNAVAILABLE", "发送前无法确认会话标签页。", tabId);
  }
  const currentPageUrl = normalizeRemoteConversationUrl(tab.url);
  if (!projectUrlMatchesRecord(record, currentPageUrl)) {
    throw relayFailure(
      "CHATGPT_PROJECT_MISMATCH",
      "发送前 ChatGPT 页面不属于已绑定的 Ask2GPT Project；未提交问题。",
      tabId,
    );
  }
  // This is the last check before a non-idempotent send. It must never adopt
  // whatever conversation happens to be visible: a user can navigate the
  // owned tab between ensureConversationTab() and this check. New and
  // canonical URLs are adopted only from run-attributed content events.
  if (
    !preDispatchPageMatches({
      mappedRemoteUrl: record.remoteUrl,
      currentPageUrl,
      allowFirstConversation: allowsInitialRemoteAdoption(run),
    })
  ) {
    throw relayFailure(
      "CHATGPT_REMOTE_UNAVAILABLE",
      "发送前 ChatGPT 页面已离开当前映射的会话；未提交问题。",
      tabId,
    );
  }
  return {
    expectedRemoteUrl: record.remoteUrl,
    expectedProjectScope: record.projectScope!,
    allowFirstConversation: allowsInitialRemoteAdoption(run),
  };
}

async function handleDispatchPageValidation(
  request: DispatchPageValidationRequest,
  senderTabId: number,
  senderUrl: string | undefined,
) {
  const matches = [...activeRuns.entries()].filter(
    ([, candidate]) =>
      candidate.conversationId === request.conversationId &&
      candidate.runId === request.runId &&
      candidate.tabId === senderTabId,
  );
  if (matches.length !== 1) return { ok: false };
  const [key, run] = matches[0]!;
  if (run.phase !== "dispatching") return { ok: false };

  const record = conversationTabs.get(key);
  const grant = completedCanonicalizations.get(key);
  const senderRemoteUrl = normalizeRemoteConversationUrl(senderUrl);
  if (
    !record ||
    record.tabId !== senderTabId ||
    activeRuns.get(key) !== run ||
    !grant ||
    grant.instanceId !== run.instanceId ||
    grant.conversationId !== run.conversationId ||
    grant.runId === run.runId ||
    grant.tabId !== senderTabId ||
    !isCompletedCanonicalizationCurrent(grant) ||
    !sameChatGptConversationIdentity(grant.fromRemoteUrl, request.expectedRemoteUrl) ||
    sameChatGptConversationIdentity(request.expectedRemoteUrl, request.observedRemoteUrl) ||
    senderRemoteUrl !== request.observedRemoteUrl ||
    !projectUrlMatchesRecord(record, request.expectedRemoteUrl) ||
    !projectUrlMatchesRecord(record, request.observedRemoteUrl) ||
    !record.remoteUrl ||
    (!sameChatGptConversationIdentity(record.remoteUrl, request.expectedRemoteUrl) &&
      !(
        grant.toRemoteUrl &&
        sameChatGptConversationIdentity(grant.toRemoteUrl, request.observedRemoteUrl) &&
        sameChatGptConversationIdentity(record.remoteUrl, request.observedRemoteUrl)
      )) ||
    Boolean(
      grant.toRemoteUrl &&
      !sameChatGptConversationIdentity(grant.toRemoteUrl, request.observedRemoteUrl),
    )
  ) {
    return { ok: false };
  }

  const inspect = async (navigationSequence: number | undefined) => {
    const tab = await chrome.tabs.get(senderTabId).catch(() => undefined);
    if (
      !tab?.url ||
      activeRuns.get(key) !== run ||
      run.phase !== "dispatching" ||
      conversationTabs.get(key) !== record ||
      completedCanonicalizations.get(key) !== grant ||
      tabNavigationSequences.get(senderTabId) !== navigationSequence ||
      normalizeRemoteConversationUrl(tab.url) !== request.observedRemoteUrl
    ) {
      return undefined;
    }
    const response: unknown = await sendToTabWithTimeout(
      senderTabId,
      { type: "content.inspectConversation" },
      2_000,
    ).catch(() => undefined);
    if (
      activeRuns.get(key) !== run ||
      run.phase !== "dispatching" ||
      conversationTabs.get(key) !== record ||
      completedCanonicalizations.get(key) !== grant ||
      tabNavigationSequences.get(senderTabId) !== navigationSequence
    ) {
      return undefined;
    }
    const snapshot = parseVisibleConversationSnapshot(response);
    if (!snapshot || snapshot.remoteUrl !== request.observedRemoteUrl) {
      return undefined;
    }
    if (!(await snapshotMatchesCompletedCanonicalization(snapshot, grant))) return undefined;
    const currentTab = await chrome.tabs.get(senderTabId).catch(() => undefined);
    if (
      !currentTab?.url ||
      activeRuns.get(key) !== run ||
      run.phase !== "dispatching" ||
      conversationTabs.get(key) !== record ||
      completedCanonicalizations.get(key) !== grant ||
      tabNavigationSequences.get(senderTabId) !== navigationSequence ||
      normalizeRemoteConversationUrl(currentTab.url) !== request.observedRemoteUrl
    ) {
      return undefined;
    }
    return snapshot;
  };

  // tabs.onUpdated can trail the SPA's location change. Restart the complete
  // proof when that same B navigation notification arrives mid-validation;
  // never authorize from samples taken across two navigation sequences.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const navigationSequence = tabNavigationSequences.get(senderTabId);
    if (!(await inspect(navigationSequence))) continue;
    await delay(100);
    const verifiedSnapshot = await inspect(navigationSequence);
    if (!verifiedSnapshot) continue;

    grant.toRemoteUrl = request.observedRemoteUrl;
    record.remoteUrl = request.observedRemoteUrl;
    if (verifiedSnapshot.title) record.remoteTitle = verifiedSnapshot.title;
    settledCanonicalizationTombstones.delete(key);
    await persistSession();
    const finalTab = await chrome.tabs.get(senderTabId).catch(() => undefined);
    const ownershipStillMatches = Boolean(
      finalTab?.url &&
      activeRuns.get(key) === run &&
      run.phase === "dispatching" &&
      conversationTabs.get(key) === record &&
      completedCanonicalizations.get(key) === grant &&
      normalizeRemoteConversationUrl(finalTab.url) === request.observedRemoteUrl,
    );
    if (!ownershipStillMatches) return { ok: false };
    if (tabNavigationSequences.get(senderTabId) === navigationSequence) {
      return { ok: true, expectedRemoteUrl: request.observedRemoteUrl };
    }
  }
  return { ok: false };
}

async function handleContentMainWorldSendRequest(
  request: ContentMainWorldSendRequest,
  senderTabId: number,
  senderUrl: string | undefined,
) {
  const matches = [...activeRuns.entries()].filter(
    ([, candidate]) =>
      candidate.conversationId === request.conversationId &&
      candidate.runId === request.runId &&
      candidate.tabId === senderTabId,
  );
  if (matches.length !== 1) {
    return { ok: false, dispatched: false, attempted: false, reason: "run-match" };
  }

  const [key, run] = matches[0]!;
  const record = conversationTabs.get(key);
  const tab = await chrome.tabs.get(senderTabId).catch(() => undefined);
  const senderRemoteUrl = normalizeRemoteConversationUrl(senderUrl);
  const tabRemoteUrl = normalizeRemoteConversationUrl(tab?.url);
  const baseline = runDispatchTranscriptBaselines.get(key);
  const scripting = (
    chrome as typeof chrome & { scripting?: Pick<typeof chrome.scripting, "executeScript"> }
  ).scripting;
  if (!record) {
    return { ok: false, dispatched: false, attempted: false, reason: "run-state-record" };
  }
  if (record.tabId !== senderTabId || run.tabId !== senderTabId) {
    return { ok: false, dispatched: false, attempted: false, reason: "run-state-tab" };
  }
  if (activeRuns.get(key) !== run || run.phase !== "dispatching") {
    return { ok: false, dispatched: false, attempted: false, reason: "run-state-active" };
  }
  if (!tab?.url || !isChatGptPageUrl(tab.url)) {
    return { ok: false, dispatched: false, attempted: false, reason: "run-state-url" };
  }
  // `MessageSender.url` identifies the document that received the content
  // script. ChatGPT changes conversations with History API navigation, so that
  // value can remain the project root while `tabs.get().url` already contains
  // the current conversation. Require both URLs to remain inside the exact
  // bound project; strict string equality would reject every later turn.
  if (!senderRemoteUrl || !projectUrlMatchesRecord(record, senderRemoteUrl)) {
    return { ok: false, dispatched: false, attempted: false, reason: "run-state-sender" };
  }
  if (!projectUrlMatchesRecord(record, tabRemoteUrl)) {
    return { ok: false, dispatched: false, attempted: false, reason: "run-state-project" };
  }
  if (!baseline || baseline.runId !== run.runId || baseline.tabId !== senderTabId) {
    return { ok: false, dispatched: false, attempted: false, reason: "run-state-baseline" };
  }
  if (!scripting) {
    return { ok: false, dispatched: false, attempted: false, reason: "run-state-scripting" };
  }
  if (tab.active !== true) {
    return { ok: false, dispatched: false, attempted: false, reason: "tab-inactive" };
  }

  const chromeWindow = await chrome.windows.get(tab.windowId).catch(() => undefined);
  if (!chromeWindow) {
    return { ok: false, dispatched: false, attempted: false, reason: "window-missing" };
  }
  // Live Chrome verification proves that ChatGPT ignores programmatic and CDP
  // activation inside a second, non-focused parking window. The dispatch path
  // must first return to the owned home window and make this exact tab visible.
  if (parkingWindowOwners.has(tab.windowId)) {
    return { ok: false, dispatched: false, attempted: false, reason: "temporary-window" };
  }

  // Current ChatGPT builds accept a synthetic page click for a brand-new
  // conversation but ignore the same activation for a follow-up. Always cross
  // the final boundary with one trusted pointer click, regardless of whether
  // Chrome currently owns OS focus.
  const trustedPointer = await prepareTrustedComposerPointer(key, run, senderTabId);
  if (!trustedPointer) {
    return { ok: false, dispatched: false, attempted: false, reason: "debugger-unavailable" };
  }

  let dispatchStage = "main-world-validation";
  let pointerPressed = false;
  try {
    dispatchStage = "page-bring-to-front";
    if (trustedPointer.capture) trustedPointer.capture.lastStage = "dispatch-page-front";
    await trustedPointer.debuggerApi.sendCommand({ tabId: senderTabId }, "Page.bringToFront");
    const frontTab = await chrome.tabs.get(senderTabId).catch(() => undefined);
    if (frontTab?.active !== true) {
      return { ok: false, dispatched: false, attempted: false, reason: "tab-not-front" };
    }
    dispatchStage = "main-world-validation";
    const results = await promiseWithTimeout(
      scripting.executeScript({
        target: { tabId: senderTabId },
        world: "MAIN",
        injectImmediately: true,
        func: activateMarkedComposerSendInMainWorld,
        args: [
          request.runId,
          MAIN_WORLD_SCOPE_ATTRIBUTE,
          MAIN_WORLD_COMPOSER_ATTRIBUTE,
          MAIN_WORLD_SEND_ATTRIBUTE,
        ],
      }),
      2_000,
      "Timed out while activating ChatGPT's owned send button in the page MAIN world.",
    );
    const result =
      results.length === 1 && results[0]?.frameId === 0 ? results[0].result : undefined;
    if (
      isRecord(result) &&
      result.status === "pointer-ready" &&
      typeof result.x === "number" &&
      Number.isFinite(result.x) &&
      typeof result.y === "number" &&
      Number.isFinite(result.y)
    ) {
      if (
        activeRuns.get(key) !== run ||
        conversationTabs.get(key) !== record ||
        (enhancedDebuggerCaptures.get(senderTabId)?.runId !== run.runId &&
          !trustedPointer.detachAfter)
      ) {
        return { ok: false, dispatched: false, attempted: false, reason: "run-changed" };
      }
      const activeDispatchTab = await chrome.tabs.get(senderTabId).catch(() => undefined);
      if (activeDispatchTab?.active !== true) {
        return {
          ok: false,
          dispatched: false,
          attempted: false,
          reason: "tab-left-front",
        };
      }
      dispatchStage = "pointer-move";
      if (trustedPointer.capture) trustedPointer.capture.lastStage = "dispatch-pointer-moved";
      await trustedPointer.debuggerApi.sendCommand(
        { tabId: senderTabId },
        "Input.dispatchMouseEvent",
        {
          type: "mouseMoved",
          x: result.x,
          y: result.y,
          button: "none",
          buttons: 0,
          pointerType: "mouse",
        },
      );
      dispatchStage = "pointer-press";
      pointerPressed = true;
      if (trustedPointer.capture) trustedPointer.capture.lastStage = "dispatch-pointer-pressed";
      // MAIN world already proved a unique, enabled and unobscured run-owned
      // button at this exact point. From mousePressed onward the outcome is
      // ambiguous and no code path may retry the action.
      await trustedPointer.debuggerApi.sendCommand(
        { tabId: senderTabId },
        "Input.dispatchMouseEvent",
        {
          type: "mousePressed",
          x: result.x,
          y: result.y,
          button: "left",
          buttons: 1,
          clickCount: 1,
          pointerType: "mouse",
        },
      );
      dispatchStage = "pointer-release";
      await trustedPointer.debuggerApi.sendCommand(
        { tabId: senderTabId },
        "Input.dispatchMouseEvent",
        {
          type: "mouseReleased",
          x: result.x,
          y: result.y,
          button: "left",
          buttons: 0,
          clickCount: 1,
          pointerType: "mouse",
        },
      );
      if (trustedPointer.capture) trustedPointer.capture.lastStage = "dispatch-pointer-released";
      return { ok: true, dispatched: true, attempted: true };
    }
    return {
      ok: false,
      dispatched: false,
      attempted: false,
      reason: typeof result === "string" ? result : "pointer-target",
    };
  } catch {
    return {
      ok: false,
      dispatched: false,
      attempted: pointerPressed,
      reason: dispatchStage,
    };
  } finally {
    if (trustedPointer?.detachAfter) {
      await trustedPointer.debuggerApi.detach({ tabId: senderTabId }).catch(() => undefined);
    }
  }
}

async function prepareTrustedComposerPointer(key: string, run: ActiveRunRecord, tabId: number) {
  const debuggerApi = chromeWithOptionalDebugging.debugger;
  if (!debuggerApi) return undefined;
  const capture = enhancedDebuggerCaptures.get(tabId);
  if (capture?.key === key && capture.runId === run.runId && capture.tabId === tabId) {
    return { capture, debuggerApi, detachAfter: false } as const;
  }
  try {
    // Enhanced reception may be explicitly disabled. A short-lived debugger
    // session performs only this one guarded pointer action and enables no
    // Network domains before detaching immediately after release.
    await debuggerApi.attach({ tabId }, "1.3");
    return { debuggerApi, detachAfter: true } as const;
  } catch {
    return undefined;
  }
}

async function activateMarkedComposerSendInMainWorld(
  runId: string,
  scopeAttribute: string,
  composerAttribute: string,
  sendAttribute: string,
) {
  const noticeSelector = '[data-testid="modal-conversation-history-rate-limit"]';
  const isRendered = (element: HTMLElement) => {
    for (let current: HTMLElement | null = element; current; current = current.parentElement) {
      if (current.hidden || current.hasAttribute("inert")) return false;
      const style = getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.opacity === "0"
      ) {
        return false;
      }
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const dismissLateConversationHistoryNotice = async () => {
    const notices = [...document.querySelectorAll<HTMLElement>(noticeSelector)].filter(isRendered);
    if (notices.length === 0) return undefined;
    if (notices.length !== 1) return "notice-count" as const;
    const notice = notices[0]!;
    const buttons = [...notice.querySelectorAll<HTMLButtonElement>("button")].filter(
      (button) =>
        isRendered(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true",
    );
    if (buttons.length !== 1) return "notice-controls" as const;
    // This exact ChatGPT notice can mount after the isolated-world preflight.
    // Its sole confirmation is safe to acknowledge; no generic dialog or send
    // control is ever clicked here.
    buttons[0]!.click();
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      if (!notice.isConnected || !isRendered(notice)) return undefined;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    return "notice-open" as const;
  };
  const noticeFailure = await dismissLateConversationHistoryNotice();
  if (noticeFailure) return noticeFailure;

  let lastOcclusionDiagnostic = "unknown";
  const readTarget = () => {
    const scopes = [...document.querySelectorAll<HTMLElement>(`[${scopeAttribute}]`)].filter(
      (element) => element.getAttribute(scopeAttribute) === runId,
    );
    const composers = [...document.querySelectorAll<HTMLElement>(`[${composerAttribute}]`)].filter(
      (element) => element.getAttribute(composerAttribute) === runId,
    );
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(`[${sendAttribute}]`)].filter(
      (element) => element.getAttribute(sendAttribute) === runId,
    );
    if (scopes.length !== 1 || composers.length !== 1 || buttons.length !== 1) {
      return "marker-count" as const;
    }
    const scope = scopes[0]!;
    const composer = composers[0]!;
    const button = buttons[0]!;
    const contentEditable = composer.getAttribute("contenteditable");
    if (
      !(scope instanceof HTMLElement) ||
      !scope.isConnected ||
      !(composer instanceof HTMLElement) ||
      !composer.isConnected ||
      (!(composer instanceof HTMLTextAreaElement) &&
        !composer.isContentEditable &&
        contentEditable !== "true" &&
        contentEditable !== "plaintext-only") ||
      !(button instanceof HTMLButtonElement) ||
      !button.isConnected ||
      button.disabled ||
      button.getAttribute("aria-disabled") === "true" ||
      !scope.contains(composer) ||
      !scope.contains(button) ||
      (button.form !== null && !button.form.contains(composer))
    ) {
      return "invalid-ownership" as const;
    }
    const rect = button.getBoundingClientRect();
    if (
      !Number.isFinite(rect.left) ||
      !Number.isFinite(rect.top) ||
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height) ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      return "invalid-geometry" as const;
    }
    let x = rect.left + rect.width / 2;
    let y = rect.top + rect.height / 2;
    if (typeof document.elementFromPoint === "function") {
      const points = [
        [0.5, 0.5],
        [0.25, 0.5],
        [0.75, 0.5],
        [0.5, 0.25],
        [0.5, 0.75],
      ] as const;
      let safePoint: { x: number; y: number } | undefined;
      const occluders = new Set<string>();
      for (const [horizontalRatio, verticalRatio] of points) {
        const candidateX = rect.left + rect.width * horizontalRatio;
        const candidateY = rect.top + rect.height * verticalRatio;
        const hit = document.elementFromPoint(candidateX, candidateY);
        if (hit instanceof Element && (hit === button || button.contains(hit))) {
          safePoint = { x: candidateX, y: candidateY };
          break;
        }
        if (!(hit instanceof Element)) {
          occluders.add("none");
          continue;
        }
        const testId = (hit.getAttribute("data-testid") ?? "")
          .replace(/[^a-zA-Z0-9_-]/gu, "")
          .slice(0, 40);
        const role = (hit.getAttribute("role") ?? "").replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 24);
        const className = [...hit.classList]
          .slice(0, 2)
          .map((value) => value.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 32))
          .filter(Boolean)
          .join("-");
        const style = getComputedStyle(hit);
        occluders.add(
          [
            hit.tagName.toLowerCase(),
            testId,
            role,
            className,
            style.position.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 16),
            style.pointerEvents.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 16),
          ]
            .filter(Boolean)
            .join("-")
            .slice(0, 48),
        );
      }
      if (!safePoint) {
        lastOcclusionDiagnostic = [...occluders].slice(0, 3).join("+") || "unknown";
        return "occluded" as const;
      }
      x = safePoint.x;
      y = safePoint.y;
    }
    return { height: rect.height, status: "pointer-sample" as const, width: rect.width, x, y };
  };

  // ChatGPT animates the follow-up send control into place after the editor
  // commit. A point that is valid on the first frame can miss a few milliseconds
  // later. Four matching samples prevent that race without ever actuating the
  // control during stabilization.
  const stableSampleCount = 4;
  const sampleIntervalMs = 75;
  const deadline = Date.now() + 1_200;
  let previous: { height: number; width: number; x: number; y: number } | undefined;
  let matchingSamples = 0;
  let transientFailure: "invalid-geometry" | "occluded" | undefined;
  while (Date.now() <= deadline) {
    const sample = readTarget();
    if (typeof sample === "string") {
      if (sample !== "invalid-geometry" && sample !== "occluded") return sample;
      transientFailure = sample;
      previous = undefined;
      matchingSamples = 0;
      await new Promise<void>((resolve) => setTimeout(resolve, sampleIntervalMs));
      continue;
    }
    transientFailure = undefined;
    const matchesPrevious =
      previous !== undefined &&
      Math.abs(previous.x - sample.x) <= 0.5 &&
      Math.abs(previous.y - sample.y) <= 0.5 &&
      Math.abs(previous.width - sample.width) <= 0.5 &&
      Math.abs(previous.height - sample.height) <= 0.5;
    matchingSamples = matchesPrevious ? matchingSamples + 1 : 1;
    previous = sample;
    if (matchingSamples >= stableSampleCount) {
      // MAIN world never activates the control itself. The worker uses this
      // exact validated point for one trusted CDP mouse sequence and never
      // retries after mousePressed, whose outcome is necessarily ambiguous.
      return { status: "pointer-ready", x: sample.x, y: sample.y };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, sampleIntervalMs));
  }
  return transientFailure === "occluded"
    ? `occluded-${lastOcclusionDiagnostic}`.slice(0, 64)
    : (transientFailure ?? "unstable-geometry");
}

async function handleContentRecoveryRequest(
  request: ContentRecoveryRequest,
  senderTabId: number,
  senderUrl: string | undefined,
) {
  const matches = [...activeRuns.entries()].filter(
    ([, candidate]) =>
      candidate.conversationId === request.conversationId &&
      candidate.runId === request.runId &&
      candidate.tabId === senderTabId,
  );
  if (matches.length !== 1) return { ok: false };

  const [key, run] = matches[0]!;
  const record = conversationTabs.get(key);
  const tab = await chrome.tabs.get(senderTabId).catch(() => undefined);
  const senderRemoteUrl = normalizeRemoteConversationUrl(senderUrl);
  const tabRemoteUrl = normalizeRemoteConversationUrl(tab?.url);
  if (
    !record ||
    record.tabId !== senderTabId ||
    activeRuns.get(key) !== run ||
    run.tabId !== senderTabId ||
    !tab?.url ||
    !isChatGptPageUrl(tab.url) ||
    !senderRemoteUrl ||
    !projectUrlMatchesRecord(record, senderRemoteUrl) ||
    !projectUrlMatchesRecord(record, tabRemoteUrl)
  ) {
    return { ok: false };
  }

  // This message is emitted only by the exact content runtime after its own
  // response watchdog has observed a stalled render. It authorizes inspection
  // and exact-transcript recovery, never another non-idempotent send.
  if (run.phase === "dispatching") {
    run.phase = "active";
    await persistSession();
    if (activeRuns.get(key) !== run || conversationTabs.get(key) !== record) {
      return { ok: false };
    }
  }
  await setRunTabProtection(senderTabId, true);
  // A selected tab in an unfocused window, or an inactive tab in a focused
  // window, can keep serving extension messages while React remains frozen.
  // Wake the exact owned tab for a bounded read-only recovery pass and restore
  // the user's previous tab afterwards. No path below can invoke content.send.
  await withTransientConversationTabActivation(key, senderTabId, async () => {
    await recoverRun(run, { focusOnFailure: false });
    if (activeRuns.get(key) === run && !findPendingTerminalEvent(run)) {
      await delay(request.reason === "hidden-attributed-stall" ? 300 : 150);
      await recoverRun(run, { focusOnFailure: false });
    }
  });
  return { ok: activeRuns.get(key) === run || findPendingTerminalEvent(run) !== undefined };
}

async function adoptReadyConversationUrl(key: string, record: TabRecord, readyUrl: string) {
  if (!isRemoteConversationPage(readyUrl) || conversationTabs.get(key) !== record) return;
  if (record.remoteUrl === readyUrl) return;
  record.remoteUrl = readyUrl;
  record.remoteTitle = undefined;
  await persistSession();
}

interface ComposerReadinessStatus {
  ready: boolean;
  rawCandidateCount: number;
  readyCandidateCount: number;
  primaryOwnership?: boolean;
  primaryVisible?: boolean;
  primaryVisibilityBlocker?: string;
  primaryWritable?: boolean;
  viewportHeight?: number;
  viewportWidth?: number;
  visibilityState: "visible" | "hidden";
}

async function withComposerReadyForDispatch<T>(
  key: string,
  run: ActiveRunRecord,
  tabId: number,
  operation: (status: ComposerReadinessStatus, windowMinimized: boolean) => Promise<T>,
  enhancedCapturePreparation: Promise<boolean> = startEnhancedDebuggerCapture(key, run, tabId),
): Promise<T> {
  // A normal-window background tab can keep answering extension messages while
  // its document timers and React submission path are frozen. When the content
  // runtime reports a hidden document (or cannot answer from an inactive tab),
  // select that exact owned tab in its original, non-focused Chrome window.
  // A minimized window is restored at Chrome's own valid restore bounds for
  // the run, then minimized again at terminal cleanup. Neither path focuses
  // the OS window.
  let enhancedWakeAttempt: Promise<boolean> | undefined;
  const prepareEnhancedRenderer = async () => {
    if (!enhancedBackgroundEnabled) return false;
    enhancedWakeAttempt ??= wakeEnhancedBackgroundPage(key, run, tabId, enhancedCapturePreparation);
    return await enhancedWakeAttempt;
  };
  const runReadyOperation = async (status: ComposerReadinessStatus, windowMinimized: boolean) => {
    // Keep lifecycle/focus preparation adjacent to the one non-idempotent
    // MAIN-world validation. The page-owned button remains the only target.
    await prepareEnhancedRenderer();
    return await operation(status, windowMinimized);
  };
  await assertPreDispatchPage(key, run, tabId);
  const visibility = await readTabDispatchVisibility(tabId);
  const mapped = conversationTabs.get(key);
  const runWithVisibleLease = async (temporarilyRestoreMinimizedWindow: boolean) => {
    return await withConversationTabActiveInHomeWindow(
      key,
      tabId,
      async () => {
        await prepareEnhancedRenderer();
        const deadline = Date.now() + COMPOSER_READINESS_WINDOW_MS;
        let lastStatus: ComposerReadinessStatus | undefined;
        while (Date.now() < deadline) {
          await assertPreDispatchPage(key, run, tabId);
          lastStatus = await readComposerReadiness(tabId);
          if (lastStatus?.ready && lastStatus.visibilityState === "visible") {
            // A window move can leave the old composer visible for one task
            // while ChatGPT reattaches its page-owned submit handlers. A
            // delayed second proof prevents a single programmatic activation
            // from being silently ignored. This remains before content.send,
            // so it cannot introduce a duplicate-submission path.
            await delay(PARKED_COMPOSER_STABILITY_MS);
            await assertPreDispatchPage(key, run, tabId);
            const stableStatus = await readComposerReadiness(tabId);
            if (stableStatus?.ready && stableStatus.visibilityState === "visible") {
              return await runReadyOperation(stableStatus, false);
            }
            lastStatus = stableStatus;
          }
          await delay(100);
        }
        const incompatibleVisibleComposer = Boolean(
          lastStatus?.visibilityState === "visible" && lastStatus.rawCandidateCount > 0,
        );
        throw relayFailure(
          incompatibleVisibleComposer ? "SELECTOR_INCOMPATIBLE" : "CHATGPT_REMOTE_UNAVAILABLE",
          incompatibleVisibleComposer
            ? `ChatGPT composer ownership is ambiguous; the question was not sent. ${composerReadinessDiagnostic(lastStatus!)}`
            : "ChatGPT did not expose a ready composer while its background tab was parked; the question was not sent.",
          tabId,
        );
      },
      run,
      temporarilyRestoreMinimizedWindow,
    );
  };
  // Focus emulation can make an inactive renderer report document.visibilityState
  // as visible. That is sufficient for inspection, but ChatGPT still rejects a
  // follow-up actuation until this exact tab is selected in its own Chrome
  // window. Chrome's tab.active flag is authoritative at the send boundary.
  if (
    mapped?.tabId === tabId &&
    (visibility.inactive || visibility.minimized || visibility.parked)
  ) {
    return await runWithVisibleLease(visibility.minimized);
  }
  let backgroundStatus = await readComposerReadiness(tabId);
  if (backgroundStatus?.ready && backgroundStatus.visibilityState === "visible") {
    // An idle transcript prewarm can have this tab selected while its queued
    // activation scope is still preparing to restore the user's previous tab.
    // Enter the same per-window lease queue and re-prove readiness there so
    // that restoration cannot race the later non-idempotent content.send.
    return await runWithVisibleLease(false);
  }
  if (
    mapped?.tabId === tabId &&
    (backgroundStatus?.visibilityState === "hidden" ||
      (backgroundStatus === undefined && visibility.inactive))
  ) {
    return await runWithVisibleLease(true);
  }

  if (enhancedBackgroundEnabled) {
    await prepareEnhancedRenderer();
    backgroundStatus = await readComposerReadiness(tabId);
    if (backgroundStatus?.ready && backgroundStatus.visibilityState === "visible") {
      return await runWithVisibleLease(false);
    }
    if (
      mapped?.tabId === tabId &&
      (backgroundStatus?.visibilityState === "hidden" ||
        (backgroundStatus === undefined && visibility.inactive))
    ) {
      return await runWithVisibleLease(true);
    }
  }

  return await withConversationTabActiveInHomeWindow(
    key,
    tabId,
    async () => {
      // The probe is a mandatory wake-up handshake. A missing response must not
      // be interpreted as readiness: a frozen page can leave sendMessage pending
      // while Chrome later resumes and clicks an already-abandoned command.
      // content.send still performs the final fail-closed ownership checks.
      const deadline = Date.now() + COMPOSER_READINESS_WINDOW_MS;
      let lastStatus: ComposerReadinessStatus | undefined;
      while (Date.now() < deadline) {
        // The user can navigate the leased tab while React is hydrating. Keep
        // ownership checks authoritative throughout the wait and stop before
        // any click when the Project or conversation changes.
        await assertPreDispatchPage(key, run, tabId);
        lastStatus = await readComposerReadiness(tabId);
        const currentlyMinimized = await isTabWindowMinimized(tabId);
        if (lastStatus?.ready && (lastStatus.visibilityState === "visible" || currentlyMinimized)) {
          return await runReadyOperation(lastStatus, currentlyMinimized);
        }
        await delay(150);
      }
      const message = !lastStatus
        ? "ChatGPT 页面没有响应发送前就绪检查；问题尚未发送。"
        : lastStatus.visibilityState !== "visible"
          ? "ChatGPT 页面仍处于后台冻结状态；问题尚未发送。"
          : "ChatGPT 输入框尚未完成加载；问题尚未发送。";
      const incompatibleVisibleComposer = Boolean(
        lastStatus?.visibilityState === "visible" && lastStatus.rawCandidateCount > 0,
      );
      throw relayFailure(
        incompatibleVisibleComposer ? "SELECTOR_INCOMPATIBLE" : "CHATGPT_REMOTE_UNAVAILABLE",
        incompatibleVisibleComposer
          ? `ChatGPT composer ownership is ambiguous; the question was not sent. ${composerReadinessDiagnostic(lastStatus!)}`
          : message,
        tabId,
      );
    },
    run,
  );
}

async function readTabDispatchVisibility(tabId: number) {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (tab?.windowId === undefined) return { inactive: false, minimized: false, parked: false };
  const homeWindowId = parkingWindowOwners.get(tab.windowId) ?? tab.windowId;
  const chromeWindow = await chrome.windows.get(homeWindowId).catch(() => undefined);
  const leaseState = windowVisibilityLeaseStates.get(homeWindowId);
  return {
    inactive: tab.active !== true,
    minimized: tab.windowId === homeWindowId && chromeWindow?.state === "minimized",
    parked: Boolean(leaseState?.parked && !leaseState.userIntervened),
  };
}

async function isTabWindowMinimized(tabId: number) {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (tab?.windowId === undefined) return false;
  return (await chrome.windows.get(tab.windowId).catch(() => undefined))?.state === "minimized";
}

async function readComposerReadiness(tabId: number): Promise<ComposerReadinessStatus | undefined> {
  const response: unknown = await sendToTabWithTimeout(
    tabId,
    { type: "content.composerStatus" },
    1_000,
  ).catch(() => undefined);
  if (
    !isRecord(response) ||
    response.ok !== true ||
    typeof response.ready !== "boolean" ||
    !isCompatibleContentRuntime(response.selectorVersion)
  ) {
    return undefined;
  }
  const rawCandidateCount = parseComposerCandidateCount(response.rawCandidateCount);
  const readyCandidateCount = parseComposerCandidateCount(response.readyCandidateCount);
  const visibilityState = response.visibilityState;
  if (
    rawCandidateCount === undefined ||
    readyCandidateCount === undefined ||
    (visibilityState !== "visible" && visibilityState !== "hidden")
  ) {
    return undefined;
  }
  const viewportHeight = parseComposerViewportDimension(response.viewportHeight);
  const viewportWidth = parseComposerViewportDimension(response.viewportWidth);
  return {
    ready: response.ready,
    rawCandidateCount,
    readyCandidateCount,
    ...(typeof response.primaryOwnership === "boolean"
      ? { primaryOwnership: response.primaryOwnership }
      : {}),
    ...(typeof response.primaryVisible === "boolean"
      ? { primaryVisible: response.primaryVisible }
      : {}),
    ...(typeof response.primaryVisibilityBlocker === "string" &&
    /^(?:aria-hidden|display|geometry|hidden|inert|missing|none|opacity|outside|pointer|visibility)$/u.test(
      response.primaryVisibilityBlocker,
    )
      ? { primaryVisibilityBlocker: response.primaryVisibilityBlocker }
      : {}),
    ...(typeof response.primaryWritable === "boolean"
      ? { primaryWritable: response.primaryWritable }
      : {}),
    ...(viewportHeight === undefined ? {} : { viewportHeight }),
    ...(viewportWidth === undefined ? {} : { viewportWidth }),
    visibilityState,
  };
}

function parseComposerCandidateCount(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 32
    ? Number(value)
    : undefined;
}

function parseComposerViewportDimension(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 20_000
    ? Number(value)
    : undefined;
}

function composerReadinessDiagnostic(status: ComposerReadinessStatus) {
  const primary =
    status.primaryWritable === undefined ||
    status.primaryOwnership === undefined ||
    status.primaryVisible === undefined
      ? ""
      : ` primary=w${Number(status.primaryWritable)}o${Number(status.primaryOwnership)}v${Number(status.primaryVisible)}`;
  const viewport =
    status.viewportWidth === undefined || status.viewportHeight === undefined
      ? ""
      : ` viewport=${status.viewportWidth}x${status.viewportHeight}`;
  const blocker = status.primaryVisibilityBlocker
    ? ` blocker=${status.primaryVisibilityBlocker}`
    : "";
  return `raw=${status.rawCandidateCount} ready=${status.readyCandidateCount} visibility=${status.visibilityState}${primary}${blocker}${viewport}`;
}

async function withTransientConversationTabActivation<T>(
  key: string,
  tabId: number,
  operation: () => Promise<T>,
  retainedRun?: ActiveRunRecord,
  useTemporaryParkingWindow = false,
  handoffToStartedRun = false,
): Promise<T> {
  const initialTab = await promiseWithTimeout(
    chrome.tabs.get(tabId),
    1_000,
    "Chrome tab inspection timed out.",
  );
  const initialWindowId = initialTab.windowId;
  const homeWindowId = parkingWindowOwners.get(initialWindowId) ?? initialWindowId;
  return await withWindowActivationQueue(homeWindowId, async () => {
    if (conversationTabs.get(key)?.tabId !== tabId) {
      throw relayFailure(
        "CHATGPT_REMOTE_UNAVAILABLE",
        "The conversation page changed while its composer was being prepared; the question was not sent.",
        tabId,
      );
    }

    let state = windowVisibilityLeaseStates.get(homeWindowId);
    const [homeActiveTabs, inspectedHomeWindow, currentTab] = await Promise.all([
      promiseWithTimeout(
        chrome.tabs.query({ active: true, windowId: homeWindowId }),
        1_000,
        "Timed out while capturing the active Chrome tab.",
      ),
      promiseWithTimeout(
        chrome.windows.get(homeWindowId),
        1_000,
        "Timed out while inspecting the Chrome window.",
      ),
      promiseWithTimeout(chrome.tabs.get(tabId), 1_000, "Chrome tab inspection timed out."),
    ]);
    const previousActiveTabId =
      state?.baselineTabId ?? homeActiveTabs.find((candidate) => candidate.id !== tabId)?.id;
    const wasMinimized =
      inspectedHomeWindow.state === "minimized" || state?.restoreMinimized === true;
    const restoreBounds = state?.restoreBounds ?? chromeWindowBounds(inspectedHomeWindow);
    let parkingWindowId =
      state?.parked && !state.userIntervened ? state.parkingWindowId : undefined;
    let parked =
      parkingWindowId !== undefined &&
      currentTab.windowId === parkingWindowId &&
      parkingWindowOwners.get(parkingWindowId) === homeWindowId;

    if (
      !state?.userIntervened &&
      (useTemporaryParkingWindow || parked || parkingWindowId !== undefined)
    ) {
      parkingWindowId = await placeTabInTemporaryParkingWindow(
        homeWindowId,
        tabId,
        parkingWindowId,
        previousActiveTabId,
        restoreBounds,
      );
      parked = true;
      parkingWindowOwners.set(parkingWindowId, homeWindowId);
      if (!state) {
        state = {
          ...(previousActiveTabId !== undefined ? { baselineTabId: previousActiveTabId } : {}),
          homeInitiallyFocused: inspectedHomeWindow.focused !== false,
          parked: true,
          parkingWindowId,
          ...(restoreBounds ? { restoreBounds } : {}),
          restoreMinimized: wasMinimized,
          stack: [],
          userIntervened: false,
        };
        windowVisibilityLeaseStates.set(homeWindowId, state);
      } else {
        state.parked = true;
        state.parkingWindowId = parkingWindowId;
        state.restoreMinimized ||= wasMinimized;
        state.restoreBounds ??= restoreBounds;
      }
    }

    const workingWindowId =
      parked && parkingWindowId !== undefined ? parkingWindowId : homeWindowId;
    const activeWorkingTabs = await promiseWithTimeout(
      chrome.tabs.query({ active: true, windowId: workingWindowId }),
      1_000,
      "Timed out while checking the active Relay tab.",
    );
    const targetWasActive = activeWorkingTabs.some((candidate) => candidate.id === tabId);
    const workingTab = await chrome.tabs.get(tabId);
    if (!targetWasActive) {
      await updateTabWithInternalActivation(
        workingWindowId,
        tabId,
        { active: true, autoDiscardable: false },
        "Timed out while waking the ChatGPT conversation tab.",
      );
    } else if (workingTab.discarded === true || workingTab.frozen === true) {
      await updateTabWithInternalActivation(
        workingWindowId,
        tabId,
        { active: true, autoDiscardable: false },
        "Timed out while thawing the ChatGPT conversation tab.",
        true,
      );
    }

    const ownedActivationEpoch = windowActivationEpoch(homeWindowId);
    let keepTargetActive = false;
    const runForVisibilityHandoff = () => {
      if (retainedRun) return retainedRun;
      if (!handoffToStartedRun) return undefined;
      const startedRun = activeRuns.get(key);
      return startedRun && (startedRun.tabId === undefined || startedRun.tabId === tabId)
        ? startedRun
        : undefined;
    };
    try {
      const result = await operation();
      const visibilityRun = runForVisibilityHandoff();
      if (
        visibilityRun &&
        (handoffToStartedRun || (isRecord(result) && result.ok === true) || result === true) &&
        activeRuns.get(key) === visibilityRun
      ) {
        keepTargetActive = await retainRunVisibilityLease(
          key,
          visibilityRun,
          tabId,
          homeWindowId,
          previousActiveTabId,
          ownedActivationEpoch,
          wasMinimized,
          restoreBounds,
          parked,
          workingWindowId,
          parkingWindowId,
        );
      }
      return result;
    } catch (error) {
      const visibilityRun = runForVisibilityHandoff();
      if (visibilityRun && activeRuns.get(key) === visibilityRun) {
        keepTargetActive = await retainRunVisibilityLease(
          key,
          visibilityRun,
          tabId,
          homeWindowId,
          previousActiveTabId,
          ownedActivationEpoch,
          wasMinimized,
          restoreBounds,
          parked,
          workingWindowId,
          parkingWindowId,
        );
      }
      throw error;
    } finally {
      if (!keepTargetActive && parked && parkingWindowId !== undefined) {
        const currentState = windowVisibilityLeaseStates.get(homeWindowId);
        const restoreTabId = currentState?.userIntervened
          ? (currentState.preferredActiveTabId ?? tabId)
          : previousActiveTabId;
        await returnTabFromTemporaryParkingWindow(
          tabId,
          homeWindowId,
          parkingWindowId,
          restoreTabId,
        ).catch(() => undefined);
        if (currentState?.stack.length === 0) {
          currentState.parked = false;
          delete currentState.parkingWindowId;
          windowVisibilityLeaseStates.delete(homeWindowId);
          parkingWindowOwners.delete(parkingWindowId);
          await closeTemporaryParkingWindow(parkingWindowId);
        }
      } else if (
        !keepTargetActive &&
        !parked &&
        !targetWasActive &&
        previousActiveTabId !== undefined
      ) {
        const [currentActive, previousTab, targetTab, currentWindow] = await Promise.all([
          chrome.tabs.query({ active: true, windowId: homeWindowId }).catch(() => []),
          chrome.tabs.get(previousActiveTabId).catch(() => undefined),
          chrome.tabs.get(tabId).catch(() => undefined),
          chrome.windows.get(homeWindowId).catch(() => undefined),
        ]);
        if (
          windowActivationEpoch(homeWindowId) === ownedActivationEpoch &&
          currentActive[0]?.id === tabId &&
          targetTab?.windowId === homeWindowId &&
          previousTab?.windowId === homeWindowId &&
          (!useTemporaryParkingWindow || currentWindow?.focused === false)
        ) {
          await updateTabWithInternalActivation(
            homeWindowId,
            previousActiveTabId,
            { active: true },
            "Timed out while restoring the previous Chrome tab.",
          ).catch(() => undefined);
        }
      }
    }
  });
}

async function placeTabInTemporaryParkingWindow(
  homeWindowId: number,
  tabId: number,
  existingParkingWindowId: number | undefined,
  previousActiveTabId: number | undefined,
  restoreBounds: ChromeWindowBounds | undefined,
) {
  if (!restoreBounds) {
    throw relayFailure(
      "CHATGPT_REMOTE_UNAVAILABLE",
      "Chrome did not expose restorable window bounds; the question was not sent.",
      tabId,
    );
  }
  const parkingBounds = temporaryParkingBounds(restoreBounds);
  if (existingParkingWindowId !== undefined) {
    const existingWindow = await chrome.windows.get(existingParkingWindowId).catch(() => undefined);
    if (isSafeTemporaryParkingWindow(existingWindow, parkingBounds)) {
      const expectedHomeActivation =
        previousActiveTabId !== undefined
          ? registerExpectedTabActivation(homeWindowId, previousActiveTabId)
          : undefined;
      try {
        await moveTabToWindow(tabId, existingParkingWindowId);
      } catch (error) {
        if (expectedHomeActivation) {
          removeExpectedTabActivation(homeWindowId, expectedHomeActivation.token);
        }
        throw error;
      }
      parkingWindowOwners.set(existingParkingWindowId, homeWindowId);
      return existingParkingWindowId;
    }
    parkingWindowOwners.delete(existingParkingWindowId);
  }

  try {
    // Moving an inactive tab out of its home window can make Chrome re-emit an
    // activation for the already selected user tab. Treat that browser-owned
    // side effect as part of this lease, not as user intervention.
    const expectedHomeActivation =
      previousActiveTabId !== undefined
        ? registerExpectedTabActivation(homeWindowId, previousActiveTabId)
        : undefined;
    const createdWindow = await promiseWithTimeout(
      chrome.windows.create({
        focused: false,
        state: "normal",
        tabId,
        // Keep a desktop-sized content viewport. ChatGPT's compact responsive
        // layout can expose its composer while unmounting every transcript
        // turn, which prevents an exact pre-send suffix check. focused:false
        // keeps this temporary normal window behind the user's foreground
        // application. Chrome forbids moving tabs to or from popup windows.
        type: "normal",
        ...parkingBounds,
      }),
      2_000,
      "Timed out while creating the temporary Relay window.",
    ).catch((error) => {
      if (expectedHomeActivation) {
        removeExpectedTabActivation(homeWindowId, expectedHomeActivation.token);
      }
      throw error;
    });
    if (
      !createdWindow ||
      createdWindow.id === undefined ||
      !isSafeTemporaryParkingWindow(createdWindow, parkingBounds)
    ) {
      const observedWindow = createdWindow
        ? `state=${createdWindow.state ?? "unknown"} focused=${String(createdWindow.focused)} bounds=${String(createdWindow.left)},${String(createdWindow.top)},${String(createdWindow.width)},${String(createdWindow.height)} type=${createdWindow.type ?? "unknown"}`
        : "missing";
      throw relayFailure(
        "CHATGPT_REMOTE_UNAVAILABLE",
        `Chrome could not create a safe temporary Relay window; the question was not sent. expected=${parkingBounds.left},${parkingBounds.top},${parkingBounds.width},${parkingBounds.height} observed=${observedWindow}`,
        tabId,
      );
    }
    const parkingWindowId = createdWindow.id;
    // Chrome can deliver the temporary window's target activation just after
    // windows.create resolves. Keep this expectation for one microtask only: a
    // longer lease could swallow a real user selection of the Relay tab.
    const expectedParkingActivation = registerExpectedTabActivation(parkingWindowId, tabId);
    queueMicrotask(() =>
      removeExpectedTabActivation(parkingWindowId, expectedParkingActivation.token),
    );
    parkingWindowOwners.set(parkingWindowId, homeWindowId);
    const movedTab = await chrome.tabs.get(tabId);
    if (movedTab.windowId !== parkingWindowId) {
      throw relayFailure(
        "CHATGPT_REMOTE_UNAVAILABLE",
        "Chrome did not move the Relay tab into its temporary window; the question was not sent.",
        tabId,
      );
    }
    const activeTabs = await chrome.tabs.query({ active: true, windowId: parkingWindowId });
    if (activeTabs[0]?.id !== tabId) {
      await updateTabWithInternalActivation(
        parkingWindowId,
        tabId,
        { active: true, autoDiscardable: false },
        "Timed out while activating the temporary Relay tab.",
      );
    }
    return parkingWindowId;
  } catch (error) {
    const movedTab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (movedTab?.windowId !== undefined && movedTab.windowId !== homeWindowId) {
      const failedParkingWindowId = movedTab.windowId;
      await returnTabFromTemporaryParkingWindow(
        tabId,
        homeWindowId,
        failedParkingWindowId,
        previousActiveTabId,
      ).catch(() => undefined);
      parkingWindowOwners.delete(failedParkingWindowId);
      await closeTemporaryParkingWindow(failedParkingWindowId);
    }
    throw error;
  }
}

function isSafeTemporaryParkingWindow(
  chromeWindow: chrome.windows.Window | undefined,
  expectedBounds: ChromeWindowBounds,
): chromeWindow is chrome.windows.Window & { id: number } {
  return Boolean(
    chromeWindow &&
    chromeWindow.id !== undefined &&
    chromeWindow.focused === false &&
    chromeWindow.state === "normal" &&
    chromeWindow.type === "normal" &&
    chromeWindow.left !== undefined &&
    chromeWindow.top !== undefined &&
    chromeWindow.width !== undefined &&
    chromeWindow.height !== undefined &&
    chromeWindow.width >= expectedBounds.width &&
    chromeWindow.width <= expectedBounds.width + PARKED_WINDOW_MAX_POSITION_ADJUSTMENT &&
    chromeWindow.height >= expectedBounds.height &&
    chromeWindow.height <= expectedBounds.height + PARKED_WINDOW_MAX_POSITION_ADJUSTMENT &&
    Math.abs(chromeWindow.left - expectedBounds.left) <= PARKED_WINDOW_MAX_POSITION_ADJUSTMENT &&
    Math.abs(chromeWindow.top - expectedBounds.top) <= PARKED_WINDOW_MAX_POSITION_ADJUSTMENT,
  );
}

function temporaryParkingBounds(homeBounds: ChromeWindowBounds): ChromeWindowBounds {
  return {
    height: Math.min(homeBounds.height, PARKED_WINDOW_HEIGHT),
    // Reuse the minimized window's valid restore position. Chrome rejects a
    // newly created window that begins wholly off-screen, while focused:false
    // preserves the user's foreground application and z-order.
    left: homeBounds.left,
    top: homeBounds.top,
    width: Math.min(homeBounds.width, PARKED_WINDOW_WIDTH),
  };
}

async function moveTabToWindow(tabId: number, windowId: number) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId !== windowId) {
    const expectedActivation = registerExpectedTabActivation(windowId, tabId);
    try {
      await promiseWithTimeout(
        chrome.tabs.move(tabId, { index: -1, windowId }),
        2_000,
        "Timed out while moving the Relay tab into its temporary window.",
      );
    } catch (error) {
      removeExpectedTabActivation(windowId, expectedActivation.token);
      throw error;
    }
  }
  const activeTabs = await chrome.tabs.query({ active: true, windowId });
  if (activeTabs[0]?.id !== tabId) {
    await updateTabWithInternalActivation(
      windowId,
      tabId,
      { active: true, autoDiscardable: false },
      "Timed out while activating the temporary Relay tab.",
    );
  }
}

async function returnTabFromTemporaryParkingWindow(
  tabId: number,
  homeWindowId: number,
  parkingWindowId: number,
  restoreTabId: number | undefined,
) {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (tab?.windowId === parkingWindowId) {
    const expectedActivation = registerExpectedTabActivation(homeWindowId, tabId);
    try {
      await promiseWithTimeout(
        chrome.tabs.move(tabId, { index: -1, windowId: homeWindowId }),
        2_000,
        "Timed out while returning the Relay tab to its Chrome window.",
      );
    } catch (error) {
      removeExpectedTabActivation(homeWindowId, expectedActivation.token);
      throw error;
    }
  }
  if (restoreTabId !== undefined) {
    const restoreTab = await chrome.tabs.get(restoreTabId).catch(() => undefined);
    if (restoreTab?.windowId === homeWindowId) {
      await updateTabWithInternalActivation(
        homeWindowId,
        restoreTabId,
        { active: true },
        "Timed out while restoring the previous Chrome tab.",
      ).catch(() => undefined);
    }
  }
}

async function closeTemporaryParkingWindow(windowId: number) {
  const remainingTabs = await chrome.tabs.query({ windowId }).catch(() => []);
  if (remainingTabs.length > 0) return;
  await chrome.windows.remove(windowId).catch(() => undefined);
}

async function withConversationTabActiveInHomeWindow<T>(
  key: string,
  tabId: number,
  operation: () => Promise<T>,
  retainedRun?: ActiveRunRecord,
  temporarilyRestoreMinimizedWindow = false,
  handoffToStartedRun = false,
): Promise<T> {
  const tab = await promiseWithTimeout(
    chrome.tabs.get(tabId),
    1_000,
    "Chrome tab inspection timed out.",
  );
  const windowId = tab.windowId;
  return await withWindowActivationQueue(windowId, async () => {
    if (conversationTabs.get(key)?.tabId !== tabId) {
      throw relayFailure(
        "CHATGPT_REMOTE_UNAVAILABLE",
        "会话页面在输入区准备期间发生了变化；问题尚未发送。",
        tabId,
      );
    }
    const [activeTabs, inspectedWindow] = await Promise.all([
      promiseWithTimeout(
        chrome.tabs.query({ active: true, windowId }),
        1_000,
        "Timed out while capturing the active Chrome tab.",
      ),
      promiseWithTimeout(
        chrome.windows.get(windowId),
        1_000,
        "Timed out while inspecting the Chrome window.",
      ),
    ]);
    const previousActiveTabId = activeTabs.find((candidate) => candidate.id !== tabId)?.id;
    const targetWasActive = activeTabs.some((candidate) => candidate.id === tabId);
    const wasMinimized = inspectedWindow.state === "minimized";
    const existingLeaseState = windowVisibilityLeaseStates.get(windowId);
    const restoreMinimized = wasMinimized || existingLeaseState?.restoreMinimized === true;
    const restoreBounds = existingLeaseState?.restoreBounds ?? chromeWindowBounds(inspectedWindow);
    let parked = Boolean(existingLeaseState?.parked && !existingLeaseState.userIntervened);
    if (wasMinimized && temporarilyRestoreMinimizedWindow) {
      if (!restoreBounds) {
        throw relayFailure(
          "CHATGPT_REMOTE_UNAVAILABLE",
          "Chrome did not expose restorable window bounds; the question was not sent.",
          tabId,
        );
      }
      await parkMinimizedChromeWindow(windowId, tabId, restoreBounds);
      parked = true;
    }
    // The minimized-send path has restored the normal window behind the user's
    // foreground application. Selecting the exact owned tab now wakes React
    // without focusing Chrome.
    if (!targetWasActive) {
      await updateTabWithInternalActivation(
        windowId,
        tabId,
        { active: true, autoDiscardable: false },
        "Timed out while waking the ChatGPT conversation tab.",
      );
    } else if (tab.discarded === true || tab.frozen === true) {
      await updateTabWithInternalActivation(
        windowId,
        tabId,
        { active: true, autoDiscardable: false },
        "Timed out while thawing the ChatGPT conversation tab.",
        true,
      );
    }
    const ownedActivationEpoch = windowActivationEpoch(windowId);
    let keepTargetActive = false;
    const runForVisibilityHandoff = () => {
      if (retainedRun) return retainedRun;
      if (!handoffToStartedRun) return undefined;
      const startedRun = activeRuns.get(key);
      return startedRun && (startedRun.tabId === undefined || startedRun.tabId === tabId)
        ? startedRun
        : undefined;
    };
    try {
      const result = await operation();
      const visibilityRun = runForVisibilityHandoff();
      if (
        visibilityRun &&
        (handoffToStartedRun || (isRecord(result) && result.ok === true) || result === true) &&
        activeRuns.get(key) === visibilityRun
      ) {
        keepTargetActive = await retainRunVisibilityLease(
          key,
          visibilityRun,
          tabId,
          windowId,
          previousActiveTabId,
          ownedActivationEpoch,
          restoreMinimized,
          restoreBounds,
          parked,
        );
      }
      return result;
    } catch (error) {
      // Keep the exact tab runnable until the caller classifies the failure.
      // For content.send, the response port may time out after actuation; the
      // caller persists the at-most-once recovery barrier and never replays it.
      // Pre-dispatch failures immediately release this lease through failRun.
      const visibilityRun = runForVisibilityHandoff();
      if (visibilityRun && activeRuns.get(key) === visibilityRun) {
        keepTargetActive = await retainRunVisibilityLease(
          key,
          visibilityRun,
          tabId,
          windowId,
          previousActiveTabId,
          ownedActivationEpoch,
          restoreMinimized,
          restoreBounds,
          parked,
        );
      }
      throw error;
    } finally {
      if (
        !keepTargetActive &&
        (!wasMinimized || temporarilyRestoreMinimizedWindow) &&
        !targetWasActive &&
        previousActiveTabId !== undefined
      ) {
        const [currentActive, previousTab, targetTab, currentWindow] = await Promise.all([
          promiseWithTimeout(
            chrome.tabs.query({ active: true, windowId }),
            1_000,
            "Timed out while checking the active Chrome tab.",
          ).catch(() => []),
          promiseWithTimeout(
            chrome.tabs.get(previousActiveTabId),
            1_000,
            "Timed out while checking the previous Chrome tab.",
          ).catch(() => undefined),
          promiseWithTimeout(
            chrome.tabs.get(tabId),
            1_000,
            "Timed out while checking the ChatGPT conversation tab.",
          ).catch(() => undefined),
          chrome.windows.get(windowId).catch(() => undefined),
        ]);
        if (
          windowActivationEpoch(windowId) === ownedActivationEpoch &&
          currentActive[0]?.id === tabId &&
          targetTab?.windowId === windowId &&
          previousTab?.windowId === windowId &&
          (!wasMinimized || currentWindow?.focused === false)
        ) {
          await updateTabWithInternalActivation(
            windowId,
            previousActiveTabId,
            { active: true },
            "Timed out while restoring the previous Chrome tab.",
          ).catch(() => undefined);
        }
      }
      if (
        !keepTargetActive &&
        restoreMinimized &&
        windowActivationEpoch(windowId) === ownedActivationEpoch
      ) {
        const currentWindow = await chrome.windows.get(windowId).catch(() => undefined);
        if (currentWindow?.focused === false && currentWindow.state !== "minimized") {
          await minimizeParkedChromeWindow(windowId, restoreBounds).catch(() => undefined);
        }
      }
    }
  });
}

async function withWindowActivationQueue<T>(windowId: number, operation: () => Promise<T>) {
  const previousTail = transientConversationActivationQueues.get(windowId) ?? Promise.resolve();
  const scheduled = previousTail.catch(() => undefined).then(operation);
  const tail = scheduled.then(
    () => undefined,
    () => undefined,
  );
  transientConversationActivationQueues.set(windowId, tail);
  try {
    return await scheduled;
  } finally {
    if (transientConversationActivationQueues.get(windowId) === tail) {
      transientConversationActivationQueues.delete(windowId);
    }
  }
}

async function parkMinimizedChromeWindow(
  windowId: number,
  tabId: number,
  restoreBounds: ChromeWindowBounds | undefined,
) {
  try {
    // Chrome rejects extension-provided bounds unless at least half of the
    // window intersects a current display. Reuse Chrome's own restore bounds
    // instead of guessing display coordinates, which is also robust when a
    // monitor is detached while the browser is minimized.
    const parkedWindow = await promiseWithTimeout(
      chrome.windows.update(windowId, {
        drawAttention: false,
        focused: false,
        state: "normal",
      }),
      1_500,
      "Timed out while restoring the minimized Relay window.",
    );
    if (parkedWindow.focused !== false || parkedWindow.state !== "normal") {
      throw relayFailure(
        "CHATGPT_REMOTE_UNAVAILABLE",
        "Chrome could not restore the minimized Relay window without taking focus; the question was not sent.",
        tabId,
      );
    }
  } catch (error) {
    const currentWindow = await chrome.windows.get(windowId).catch(() => undefined);
    if (currentWindow?.focused === false) {
      await minimizeParkedChromeWindow(windowId, restoreBounds).catch(() => undefined);
    } else if (restoreBounds) {
      await chrome.windows.update(windowId, restoreBounds).catch(() => undefined);
    }
    if (hasRelayFailureCode(error) && error instanceof Error) throw error;
    throw relayFailure(
      "CHATGPT_REMOTE_UNAVAILABLE",
      "Chrome could not safely prepare the minimized Relay window without taking focus. Restore Chrome once, then retry.",
      tabId,
    );
  }
}

async function minimizeParkedChromeWindow(
  windowId: number,
  restoreBounds: ChromeWindowBounds | undefined,
) {
  let chromeWindow = await chrome.windows.get(windowId).catch(() => undefined);
  if (chromeWindow?.focused !== false) return;
  if (chromeWindow.state !== "minimized") {
    chromeWindow = await chrome.windows.update(windowId, {
      drawAttention: false,
      focused: false,
      state: "minimized",
    });
  }
  if (!restoreBounds) return;
  const resized = await chrome.windows.update(windowId, restoreBounds);
  if (resized.state !== "minimized") {
    await chrome.windows.update(windowId, {
      drawAttention: false,
      focused: false,
      state: "minimized",
    });
  }
}

async function restoreTemporaryParkingWindowForUser(
  homeWindowId: number,
  state: WindowVisibilityLeaseState,
  extraLease?: RunVisibilityLease,
) {
  const parkingWindowId = state.parkingWindowId;
  if (parkingWindowId === undefined) return;
  const leases = [
    ...state.stack,
    ...(extraLease && !state.stack.some((entry) => entry.key === extraLease.key)
      ? [extraLease]
      : []),
  ];
  for (const lease of leases) {
    await returnTabFromTemporaryParkingWindow(
      lease.tabId,
      homeWindowId,
      parkingWindowId,
      undefined,
    ).catch(() => undefined);
    delete lease.parkingWindowId;
    const current = runVisibilityLeases.get(lease.key);
    if (current) delete current.parkingWindowId;
  }
  const visibleLease = state.stack.at(-1) ?? extraLease;
  const preferredTab =
    state.preferredActiveTabId === undefined
      ? undefined
      : await chrome.tabs.get(state.preferredActiveTabId).catch(() => undefined);
  const tabToShow = preferredTab?.windowId === homeWindowId ? preferredTab.id : visibleLease?.tabId;
  if (tabToShow !== undefined) {
    await updateTabWithInternalActivation(
      homeWindowId,
      tabToShow,
      tabToShow === visibleLease?.tabId
        ? { active: true, autoDiscardable: false }
        : { active: true },
      "Timed out while restoring the Chrome tab selected by the user.",
    ).catch(() => undefined);
  }
  parkingWindowOwners.delete(parkingWindowId);
  await closeTemporaryParkingWindow(parkingWindowId);
  state.parked = false;
  delete state.parkingWindowId;
  state.restoreMinimized = false;
}

async function retainRunVisibilityLease(
  key: string,
  run: ActiveRunRecord,
  tabId: number,
  windowId: number,
  previousActiveTabId: number | undefined,
  ownedActivationEpoch: number,
  restoredMinimizedWindow: boolean,
  restoreBounds: ChromeWindowBounds | undefined,
  parked: boolean,
  workingWindowId = windowId,
  parkingWindowId?: number,
) {
  const [chromeWindow, currentActive] = await Promise.all([
    promiseWithTimeout(
      chrome.windows.get(workingWindowId),
      1_000,
      "Timed out while checking the Chrome window.",
    ).catch(() => undefined),
    promiseWithTimeout(
      chrome.tabs.query({ active: true, windowId: workingWindowId }),
      1_000,
      "Timed out while checking the active Chrome tab.",
    ).catch(() => []),
  ]);
  if (
    chromeWindow?.focused !== false ||
    currentActive[0]?.id !== tabId ||
    windowActivationEpoch(windowId) !== ownedActivationEpoch ||
    activeRuns.get(key) !== run ||
    conversationTabs.get(key)?.tabId !== tabId
  ) {
    return false;
  }

  let state = windowVisibilityLeaseStates.get(windowId);
  if (!state || state.stack.length === 0) {
    // A completed idle prewarm can briefly leave a stackless visibility state
    // while Chrome reports a user tab activation. The first real run must take
    // a fresh baseline from the tab that is active now; otherwise the stale
    // `userIntervened` bit would suppress terminal restoration after Relay
    // selects its owned tab.
    state = {
      baselineTabId: previousActiveTabId,
      homeInitiallyFocused: false,
      parked,
      ...(parkingWindowId !== undefined ? { parkingWindowId } : {}),
      ...(restoreBounds ? { restoreBounds } : {}),
      restoreMinimized: restoredMinimizedWindow,
      stack: [],
      userIntervened: false,
    };
    windowVisibilityLeaseStates.set(windowId, state);
  } else if (restoredMinimizedWindow) {
    state.restoreMinimized = true;
    state.parked ||= parked;
    state.parkingWindowId ??= parkingWindowId;
    state.restoreBounds ??= restoreBounds;
  }

  const prior = runVisibilityLeases.get(key);
  if (prior) {
    const priorState = windowVisibilityLeaseStates.get(prior.windowId);
    if (priorState) priorState.stack = priorState.stack.filter((entry) => entry.key !== key);
  }
  const lease = {
    key,
    ...(parkingWindowId !== undefined ? { parkingWindowId } : {}),
    runId: run.runId,
    tabId,
    windowId,
  } satisfies RunVisibilityLease;
  state.stack = [...state.stack.filter((entry) => entry.key !== key), lease];
  runVisibilityLeases.set(key, lease);
  await persistSession();
  return true;
}

function serializeRunVisibilityLeases() {
  return {
    version: 4,
    windows: [...windowVisibilityLeaseStates.entries()].map(([windowId, state]) => ({
      windowId,
      ...(state.baselineTabId !== undefined ? { baselineTabId: state.baselineTabId } : {}),
      homeInitiallyFocused: state.homeInitiallyFocused,
      parked: state.parked,
      ...(state.parkingWindowId !== undefined ? { parkingWindowId: state.parkingWindowId } : {}),
      ...(state.restoreBounds ? { restoreBounds: state.restoreBounds } : {}),
      restoreMinimized: state.restoreMinimized,
      userIntervened: state.userIntervened,
      stack: state.stack.map((entry) => ({ ...entry })),
    })),
  };
}

async function restoreStoredRunVisibilityLeases(value: unknown) {
  runVisibilityLeases.clear();
  windowVisibilityLeaseStates.clear();
  parkingWindowOwners.clear();
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4) ||
    !Array.isArray(value.windows)
  ) {
    return;
  }

  const seenKeys = new Set<string>();
  for (const rawWindow of value.windows.slice(0, 16)) {
    if (
      !isRecord(rawWindow) ||
      !Number.isSafeInteger(rawWindow.windowId) ||
      Number(rawWindow.windowId) < 0 ||
      (rawWindow.restoreMinimized !== undefined &&
        typeof rawWindow.restoreMinimized !== "boolean") ||
      (rawWindow.parked !== undefined && typeof rawWindow.parked !== "boolean") ||
      (rawWindow.parkingWindowId !== undefined &&
        (!Number.isSafeInteger(rawWindow.parkingWindowId) ||
          Number(rawWindow.parkingWindowId) < 0)) ||
      (value.version === 4 && typeof rawWindow.homeInitiallyFocused !== "boolean") ||
      typeof rawWindow.userIntervened !== "boolean" ||
      !Array.isArray(rawWindow.stack) ||
      rawWindow.stack.length < 1 ||
      rawWindow.stack.length > 16
    ) {
      continue;
    }
    const windowId = Number(rawWindow.windowId);
    const baselineTabId =
      rawWindow.baselineTabId === undefined
        ? undefined
        : Number.isSafeInteger(rawWindow.baselineTabId) && Number(rawWindow.baselineTabId) >= 0
          ? Number(rawWindow.baselineTabId)
          : undefined;
    if (rawWindow.baselineTabId !== undefined && baselineTabId === undefined) continue;
    const restoreBounds = parseStoredWindowBounds(rawWindow.restoreBounds);
    const parked = value.version === 3 && rawWindow.parked === true;
    const parkingWindowId =
      parked && rawWindow.parkingWindowId !== undefined
        ? Number(rawWindow.parkingWindowId)
        : undefined;
    if (rawWindow.restoreBounds !== undefined && !restoreBounds) continue;
    if (parked && (parkingWindowId === undefined || !restoreBounds)) continue;

    const stack: RunVisibilityLease[] = [];
    let valid = true;
    for (const rawLease of rawWindow.stack) {
      if (
        !isRecord(rawLease) ||
        typeof rawLease.key !== "string" ||
        rawLease.key.length < 1 ||
        rawLease.key.length > 512 ||
        !isSafeId(rawLease.runId) ||
        !Number.isSafeInteger(rawLease.tabId) ||
        Number(rawLease.tabId) < 0 ||
        rawLease.windowId !== windowId ||
        (rawLease.parkingWindowId !== undefined &&
          (!Number.isSafeInteger(rawLease.parkingWindowId) ||
            Number(rawLease.parkingWindowId) < 0)) ||
        seenKeys.has(rawLease.key)
      ) {
        valid = false;
        break;
      }
      const tabId = Number(rawLease.tabId);
      const run = activeRuns.get(rawLease.key);
      const mapped = conversationTabs.get(rawLease.key);
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      const leaseParkingWindowId =
        rawLease.parkingWindowId === undefined ? undefined : Number(rawLease.parkingWindowId);
      if (
        run?.runId !== rawLease.runId ||
        run.tabId !== tabId ||
        mapped?.tabId !== tabId ||
        leaseParkingWindowId !== parkingWindowId ||
        tab?.windowId !== (parkingWindowId ?? windowId)
      ) {
        valid = false;
        break;
      }
      stack.push({
        key: rawLease.key,
        ...(parkingWindowId !== undefined ? { parkingWindowId } : {}),
        runId: rawLease.runId,
        tabId,
        windowId,
      });
    }
    if (!valid || stack.length === 0) continue;

    const [chromeWindow, parkingWindow, currentActive, baselineTab] = await Promise.all([
      chrome.windows.get(windowId).catch(() => undefined),
      parkingWindowId === undefined
        ? Promise.resolve(undefined)
        : chrome.windows.get(parkingWindowId).catch(() => undefined),
      chrome.tabs.query({ active: true, windowId: parkingWindowId ?? windowId }).catch(() => []),
      baselineTabId === undefined
        ? Promise.resolve(undefined)
        : chrome.tabs.get(baselineTabId).catch(() => undefined),
    ]);
    if (
      !chromeWindow ||
      (parkingWindowId !== undefined &&
        (!restoreBounds ||
          !isSafeTemporaryParkingWindow(parkingWindow, temporaryParkingBounds(restoreBounds)))) ||
      currentActive[0]?.id !== stack.at(-1)?.tabId ||
      (baselineTabId !== undefined && baselineTab?.windowId !== windowId)
    ) {
      continue;
    }

    const state: WindowVisibilityLeaseState = {
      ...(baselineTabId !== undefined ? { baselineTabId } : {}),
      homeInitiallyFocused: value.version === 4 && rawWindow.homeInitiallyFocused === true,
      parked,
      ...(parkingWindowId !== undefined ? { parkingWindowId } : {}),
      ...(restoreBounds ? { restoreBounds } : {}),
      restoreMinimized: rawWindow.restoreMinimized === true,
      stack,
      userIntervened:
        rawWindow.userIntervened ||
        ((value.version !== 4 || rawWindow.homeInitiallyFocused !== true) &&
          chromeWindow.focused !== false) ||
        (parkingWindow !== undefined && parkingWindow.focused !== false),
    };
    windowVisibilityLeaseStates.set(windowId, state);
    if (parkingWindowId !== undefined) parkingWindowOwners.set(parkingWindowId, windowId);
    for (const lease of stack) {
      seenKeys.add(lease.key);
      runVisibilityLeases.set(lease.key, lease);
    }
  }
}

function parseStoredWindowBounds(value: unknown): ChromeWindowBounds | undefined {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.left) ||
    !Number.isSafeInteger(value.top) ||
    !Number.isSafeInteger(value.width) ||
    !Number.isSafeInteger(value.height) ||
    Math.abs(Number(value.left)) > 100_000 ||
    Math.abs(Number(value.top)) > 100_000 ||
    Number(value.width) < 1 ||
    Number(value.width) > 20_000 ||
    Number(value.height) < 1 ||
    Number(value.height) > 20_000
  ) {
    return undefined;
  }
  return {
    height: Number(value.height),
    left: Number(value.left),
    top: Number(value.top),
    width: Number(value.width),
  };
}

function chromeWindowBounds(chromeWindow: chrome.windows.Window) {
  return parseStoredWindowBounds(chromeWindow);
}

async function releaseRunVisibilityLease(key: string, runId: string) {
  const initialLease = runVisibilityLeases.get(key);
  if (!initialLease || initialLease.runId !== runId) return;
  await withWindowActivationQueue(initialLease.windowId, async () => {
    const lease = runVisibilityLeases.get(key);
    if (!lease || lease.runId !== runId || lease.windowId !== initialLease.windowId) return;
    runVisibilityLeases.delete(key);
    const state = windowVisibilityLeaseStates.get(lease.windowId);
    if (!state) return;
    state.stack = state.stack.filter((entry) => {
      if (entry.key === key) return false;
      const current = runVisibilityLeases.get(entry.key);
      const active = activeRuns.get(entry.key);
      const mapped = conversationTabs.get(entry.key);
      return (
        current === entry &&
        active?.runId === entry.runId &&
        active.tabId === entry.tabId &&
        mapped?.tabId === entry.tabId
      );
    });

    if (state.parked && state.parkingWindowId !== undefined) {
      const parkingWindowId = state.parkingWindowId;
      const [homeWindow, parkingWindow] = await Promise.all([
        chrome.windows.get(lease.windowId).catch(() => undefined),
        chrome.windows.get(parkingWindowId).catch(() => undefined),
      ]);
      if (
        (!state.homeInitiallyFocused && homeWindow?.focused !== false) ||
        parkingWindow?.focused !== false
      ) {
        state.userIntervened = true;
      }
      if (state.userIntervened) {
        await restoreTemporaryParkingWindowForUser(lease.windowId, state, lease).catch(() =>
          recordBackgroundFailure("Failed to restore the Relay window for the user."),
        );
      } else {
        await returnTabFromTemporaryParkingWindow(
          lease.tabId,
          lease.windowId,
          parkingWindowId,
          state.baselineTabId,
        ).catch(() =>
          recordBackgroundFailure("Failed to return the Relay tab to its minimized window."),
        );
        const nextLease = state.stack.at(-1);
        if (nextLease?.parkingWindowId === parkingWindowId) {
          await updateTabWithInternalActivation(
            parkingWindowId,
            nextLease.tabId,
            { active: true, autoDiscardable: false },
            "Timed out while restoring the active temporary Relay tab.",
          ).catch(() => undefined);
        }
      }
      if (state.stack.length === 0) {
        windowVisibilityLeaseStates.delete(lease.windowId);
        parkingWindowOwners.delete(parkingWindowId);
        await closeTemporaryParkingWindow(parkingWindowId);
      }
      await persistSession();
      return;
    }

    const chromeWindow = await chrome.windows.get(lease.windowId).catch(() => undefined);
    if (chromeWindow?.focused !== false) state.userIntervened = true;
    if (state.userIntervened) {
      if (state.stack.length === 0) windowVisibilityLeaseStates.delete(lease.windowId);
      await persistSession();
      return;
    }

    const nextLease = state.stack.at(-1);
    const restoreTabId = nextLease?.tabId ?? state.baselineTabId;
    const currentActive = await promiseWithTimeout(
      chrome.tabs.query({ active: true, windowId: lease.windowId }),
      1_000,
      "Timed out while checking the active Chrome tab.",
    ).catch(() => []);
    if (currentActive[0]?.id !== lease.tabId && currentActive[0]?.id !== restoreTabId) {
      state.userIntervened = true;
    } else if (restoreTabId !== undefined && currentActive[0]?.id !== restoreTabId) {
      const restoreTab = await chrome.tabs.get(restoreTabId).catch(() => undefined);
      if (restoreTab?.windowId === lease.windowId) {
        await updateTabWithInternalActivation(
          lease.windowId,
          restoreTabId,
          { active: true },
          "Timed out while restoring the previous Chrome tab.",
        ).catch(() => undefined);
      }
    }
    if (state.stack.length === 0 && state.restoreMinimized && !state.userIntervened) {
      const currentWindow = await chrome.windows.get(lease.windowId).catch(() => undefined);
      if (currentWindow?.focused === false) {
        await minimizeParkedChromeWindow(lease.windowId, state.restoreBounds).catch(() =>
          recordBackgroundFailure("Failed to restore the minimized Chrome window."),
        );
      }
    }
    if (state.stack.length === 0) windowVisibilityLeaseStates.delete(lease.windowId);
    await persistSession();
  });
}

async function updateTabWithInternalActivation(
  windowId: number,
  tabId: number,
  properties: chrome.tabs.UpdateProperties,
  timeoutMessage: string,
  expectSameTabActivation = false,
) {
  let expectedActivation: ExpectedTabActivation | undefined;
  if (properties.active === true) {
    const currentActive = await chrome.tabs
      .query({ active: true, windowId })
      .catch(() => [] as chrome.tabs.Tab[]);
    if (currentActive[0]?.id !== tabId || expectSameTabActivation) {
      expectedActivation = registerExpectedTabActivation(windowId, tabId);
    }
  }
  try {
    return await promiseWithTimeout(chrome.tabs.update(tabId, properties), 2_000, timeoutMessage);
  } catch (error) {
    if (expectedActivation) removeExpectedTabActivation(windowId, expectedActivation.token);
    throw error;
  }
}

async function restoreLeasedRunWindowIfMinimized(
  key: string,
  run: ActiveRunRecord,
  windowId: number,
) {
  const lease = runVisibilityLeases.get(key);
  const homeWindowId = parkingWindowOwners.get(windowId) ?? windowId;
  const state = windowVisibilityLeaseStates.get(homeWindowId);
  if (
    !lease ||
    lease.runId !== run.runId ||
    lease.tabId !== run.tabId ||
    lease.windowId !== homeWindowId ||
    !state ||
    state.userIntervened
  ) {
    return;
  }
  if (state.parked && state.parkingWindowId !== undefined) {
    const parkingWindow = await chrome.windows.get(state.parkingWindowId).catch(() => undefined);
    if (parkingWindow?.state === "minimized" && parkingWindow.focused === false) {
      await chrome.windows
        .update(state.parkingWindowId, {
          drawAttention: false,
          focused: false,
          state: "normal",
        })
        .catch(() => recordBackgroundFailure("Failed to restore the temporary Relay window."));
    }
    return;
  }
  const chromeWindow = await chrome.windows.get(homeWindowId).catch(() => undefined);
  if (chromeWindow?.state !== "minimized" || chromeWindow.focused !== false) return;
  state.restoreMinimized = true;
  await persistSession().catch(() =>
    recordBackgroundFailure("Failed to persist Relay window restoration state."),
  );
}

async function wakeRunTabForRecovery(
  key: string,
  run: ActiveRunRecord,
  tabId: number,
  windowId: number,
  wakeOperation?: () => Promise<void>,
) {
  if (
    activeRuns.get(key) !== run ||
    run.tabId !== tabId ||
    conversationTabs.get(key)?.tabId !== tabId
  ) {
    return false;
  }

  // Chromium only thaws a frozen/discarded document when its tab is selected.
  // The transient activation helper already serializes same-window wake-ups,
  // marks its activation as internal, handles minimized windows without
  // focusing them, and restores the user's previous tab afterwards. Keeping
  // this operation read-only is important: the prompt was already submitted
  // and recovery must never replay content.send.
  return await withTransientConversationTabActivation(
    key,
    tabId,
    async () => {
      const currentTab = await chrome.tabs.get(tabId).catch(() => undefined);
      const stillOwnsTab = Boolean(
        currentTab?.windowId === windowId &&
        activeRuns.get(key) === run &&
        run.tabId === tabId &&
        conversationTabs.get(key)?.tabId === tabId,
      );
      if (!stillOwnsTab) return false;
      if (wakeOperation) await wakeOperation();
      return true;
    },
    run,
  );
}

async function sendToTab(
  tabId: number,
  message: unknown,
  options: { totalTimeoutMs?: number; responseTimeoutMs?: number } = {},
): Promise<unknown> {
  const totalTimeoutMs = options.totalTimeoutMs ?? CONTENT_MESSAGE_RETRY_WINDOW_MS;
  const responseTimeoutMs = options.responseTimeoutMs ?? CONTENT_MESSAGE_RESPONSE_TIMEOUT_MS;
  const deadline = Date.now() + totalTimeoutMs;
  let retryDelay = 50;
  let lastFailure: unknown;
  while (Date.now() < deadline) {
    try {
      return await sendToTabWithTimeout(
        tabId,
        message,
        Math.max(1, Math.min(responseTimeoutMs, deadline - Date.now())),
      );
    } catch (error) {
      lastFailure = error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await delay(Math.min(retryDelay, remainingMs));
      retryDelay = Math.min(400, retryDelay * 2);
    }
  }
  throw lastFailure instanceof Error
    ? lastFailure
    : relayFailure("CHATGPT_REMOTE_UNAVAILABLE", "ChatGPT page is not ready.", tabId);
}

async function setRunTabProtection(tabId: number, active: boolean) {
  if (workerSuspended) return;
  const properties: chrome.tabs.UpdateProperties = { autoDiscardable: !active };
  // Visibility coordination owns every activation so it can capture the
  // user's baseline tab before Chrome unfreezes/discards a hidden run page.
  // Protection itself only controls automatic discarding.
  await promiseWithTimeout(
    chrome.tabs.update(tabId, properties),
    2_000,
    "Chrome tab protection timed out.",
  ).catch(() => recordBackgroundFailure("Failed to update run tab protection."));
}

async function sendToTabWithTimeout(tabId: number, message: unknown, timeoutMs: number) {
  if (workerSuspended) throw new Error("Relay service worker is suspended.");
  return await promiseWithTimeout(
    chrome.tabs.sendMessage(tabId, message),
    timeoutMs,
    "ChatGPT page inspection timed out.",
  );
}

async function promiseWithTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function syncConversationSnapshotFromTab(
  record: TabRecord,
  attempts: number,
  requiredTerminal?: TerminalHistoryRequirement,
) {
  const key = conversationKey(record.instanceId, record.conversationId);
  const existing = conversationSnapshotSyncs.get(key);
  if (existing) {
    upgradeConversationSnapshotSync(existing, record, attempts, requiredTerminal);
    return await existing.pending;
  }

  const sync: ConversationSnapshotSync = {
    attempts,
    pending: Promise.resolve(false),
    record,
    ...(requiredTerminal ? { requiredTerminal } : {}),
    rerunRequested: false,
  };
  sync.pending = (async () => {
    let result = false;
    do {
      sync.rerunRequested = false;
      result = await syncConversationSnapshotFromTabUnlocked(sync);
    } while (sync.rerunRequested);
    return result;
  })();
  conversationSnapshotSyncs.set(key, sync);
  try {
    return await sync.pending;
  } finally {
    if (conversationSnapshotSyncs.get(key) === sync) conversationSnapshotSyncs.delete(key);
  }
}

function requestConversationSnapshotSyncRerun(
  record: TabRecord,
  attempts: number,
  requiredTerminal?: TerminalHistoryRequirement,
) {
  const existing = conversationSnapshotSyncs.get(
    conversationKey(record.instanceId, record.conversationId),
  );
  if (!existing) return undefined;
  upgradeConversationSnapshotSync(existing, record, attempts, requiredTerminal);
  return existing.pending;
}

function upgradeConversationSnapshotSync(
  sync: ConversationSnapshotSync,
  record: TabRecord,
  attempts: number,
  requiredTerminal?: TerminalHistoryRequirement,
) {
  sync.record = record;
  sync.attempts = Math.max(sync.attempts, attempts);
  if (requiredTerminal) {
    sync.requiredTerminal = requiredTerminal;
  }
  sync.rerunRequested = true;
}

function releaseTerminalHistoryBarrierForNewRun(key: string, runId: string) {
  const barrier = terminalHistoryBarriers.get(key);
  if (barrier && barrier.runId !== runId) terminalHistoryBarriers.delete(key);

  const sync = conversationSnapshotSyncs.get(key);
  if (sync?.requiredTerminal && sync.requiredTerminal.runId !== runId) {
    delete sync.requiredTerminal;
    sync.rerunRequested = true;
  }
}

async function syncConversationSnapshotFromTabUnlocked(sync: ConversationSnapshotSync) {
  const { attempts, record } = sync;
  if (attempts < 1) return false;
  const key = conversationKey(record.instanceId, record.conversationId);
  const tabId = record.tabId;
  const retryDelays = [0, 250, 500, 1_000, 2_000] as const;
  const attemptLimit = Math.min(attempts, retryDelays.length);
  for (let index = 0; index < attemptLimit; index += 1) {
    if (retryDelays[index]) await delay(retryDelays[index]!);
    if (conversationTabs.get(key) !== record) return false;

    let response: unknown;
    try {
      response = await sendToTabWithTimeout(tabId, { type: "content.inspectConversation" }, 2_000);
    } catch {
      continue;
    }
    if (!mappingStillOwnsTab(conversationTabs.get(key), record, tabId)) return false;
    const candidate = parseVisibleConversationSnapshot(response);
    if (!candidate) continue;
    if (!projectUrlMatchesRecord(record, candidate.remoteUrl)) continue;
    // ChatGPT can report response actions for the latest turn while older
    // turns remain virtualized. A rendered strict suffix that matches the
    // content-free, Host-prewarmed fingerprint is current and useful, but it
    // is never an authoritative full-history replacement.
    const strictCachedSuffix = await isStrictCachedTranscriptSuffix(record, candidate);
    const activeRun = activeRuns.get(key);
    const completedInitialAdoption = completedInitialAdoptions.get(key);
    const completedInitialAdoptionMatches = Boolean(
      !activeRun &&
      !record.remoteUrl &&
      completedInitialAdoption &&
      completedInitialAdoption.tabId === tabId &&
      completedInitialAdoption.expiresAt > Date.now() &&
      (await snapshotMatchesCompletedInitialAdoption(candidate, completedInitialAdoption)),
    );
    const completedGrant = completedCanonicalizations.get(key);
    const completedTranscriptMatches = Boolean(
      !activeRun &&
      completedGrant &&
      completedGrant.tabId === tabId &&
      isCompletedCanonicalizationCurrent(completedGrant) &&
      (await snapshotMatchesCompletedCanonicalization(candidate, completedGrant)),
    );
    const completedHistoryMatches = Boolean(
      completedTranscriptMatches &&
      completedGrant &&
      (sameChatGptConversationIdentity(completedGrant.fromRemoteUrl, candidate.remoteUrl) ||
        Boolean(
          completedGrant.toRemoteUrl &&
          sameChatGptConversationIdentity(completedGrant.toRemoteUrl, candidate.remoteUrl),
        )),
    );
    const completedPromotionMatches = Boolean(
      completedTranscriptMatches &&
      completedGrant &&
      record.remoteUrl &&
      sameChatGptConversationIdentity(completedGrant.fromRemoteUrl, record.remoteUrl) &&
      (completedGrant.toRemoteUrl
        ? sameChatGptConversationIdentity(completedGrant.toRemoteUrl, candidate.remoteUrl)
        : !sameChatGptConversationIdentity(completedGrant.fromRemoteUrl, candidate.remoteUrl) &&
          completedTranscriptMatches),
    );

    const requiredTerminal = sync.requiredTerminal;
    const latestMessage = candidate.messages.at(-1);
    const terminalHistoryAttested =
      requiredTerminal !== undefined &&
      candidate.historyComplete &&
      latestMessage?.role === "assistant" &&
      latestMessage.markdown === requiredTerminal.markdown;
    const publishedComplete =
      !strictCachedSuffix &&
      (candidate.complete ||
        completedHistoryMatches ||
        completedPromotionMatches ||
        terminalHistoryAttested);
    if (requiredTerminal && !terminalHistoryAttested) continue;

    const terminalHistoryBarrier = terminalHistoryBarriers.get(key);
    let terminalHistoryBarrierAttested = terminalHistoryBarrier === undefined;
    if (
      terminalHistoryBarrier &&
      terminalHistoryBarrier.tabId === tabId &&
      (publishedComplete || strictCachedSuffix) &&
      candidate.historyComplete &&
      latestMessage?.role === "assistant"
    ) {
      const latestMarkdownSha256 = await sha256Hex(latestMessage.markdown);
      terminalHistoryBarrierAttested =
        terminalHistoryBarriers.get(key) === terminalHistoryBarrier &&
        latestMarkdownSha256 === terminalHistoryBarrier.terminalMarkdownSha256;
    }
    if (
      sync.requiredTerminal !== requiredTerminal ||
      terminalHistoryBarriers.get(key) !== terminalHistoryBarrier
    ) {
      sync.rerunRequested = true;
      continue;
    }
    if (!terminalHistoryBarrierAttested) continue;

    if (completedPromotionMatches && completedGrant && !completedGrant.toRemoteUrl) {
      completedGrant.toRemoteUrl = candidate.remoteUrl;
    }
    const navigation = decideMappedTabNavigation({
      eventIsCurrent: true,
      mappedRemoteUrl: record.remoteUrl,
      observedConversationUrl: candidate.remoteUrl,
      // As with cross-id redirects, a generic snapshot cannot prove ownership
      // of an active run. Initial adoption requires the completed prompt and
      // terminal hashes; active runs adopt through exact content events.
      initialAdoptionAllowed: completedInitialAdoptionMatches,
      redirectAllowed: hasExpectedTabNavigation(key, tabId),
      // A generic DOM snapshot has no page-side run identity. Cross-id
      // redirects for active runs are adopted by handleContentEvent; this path
      // accepts only a completed run's full transcript grant.
      canonicalization: completedPromotionMatches ? "attested" : "none",
    });
    if (navigation.action === "detach" || navigation.action === "await-attestation") {
      // The visible tab was manually moved to another ChatGPT conversation.
      // Preserve both the local mapping and the remote page; selecting or
      // sending from this Ask2GPT conversation will navigate its owned tab
      // back to the fixed URL instead of importing unrelated history.
      continue;
    }
    const acceptedRemoteUrl =
      navigation.action === "adopt" ? navigation.remoteUrl : candidate.remoteUrl;
    if (completedInitialAdoptionMatches) completedInitialAdoptions.delete(key);

    const remoteChanged = record.remoteUrl !== acceptedRemoteUrl;
    const changed =
      remoteChanged || (candidate.title !== undefined && record.remoteTitle !== candidate.title);
    record.remoteUrl = acceptedRemoteUrl;
    if (candidate.title) record.remoteTitle = candidate.title;
    if (remoteChanged) {
      completedCanonicalizations.delete(key);
      settledCanonicalizationTombstones.delete(key);
    }
    if (candidate.historyComplete && publishedComplete) {
      await rememberConversationTranscriptFingerprint(record, candidate);
    }

    const connection = authenticatedConnection(record.instanceId);
    const delivered = Boolean(
      connection &&
      sendConversationSnapshot(connection, record.conversationId, {
        ...candidate,
        // `generation.complete` is scoped to the exact run and mapped tab.
        // Upgrade a hidden DOM snapshot only when its structurally complete
        // transcript and terminal answer still match that persisted grant.
        complete: publishedComplete,
      }),
    );
    let terminalHistoryBarrierCleared = false;
    if (
      delivered &&
      terminalHistoryBarrier &&
      terminalHistoryBarriers.get(key) === terminalHistoryBarrier
    ) {
      terminalHistoryBarriers.delete(key);
      terminalHistoryBarrierCleared = true;
    }
    if (changed || terminalHistoryBarrierCleared) await persistSession();
    return delivered;
  }
  // A URL notification commonly arrives before the replacement page and its
  // content script are ready. Keep the fail-closed A mapping and grant until
  // the full canonicalization window expires; onUpdated/checkpoint will retry.
  return false;
}

async function recoverTerminalHistoryBarriers() {
  if (workerSuspended || terminalHistoryBarriers.size === 0) return;
  if (terminalHistoryRecoveryPromise) return await terminalHistoryRecoveryPromise;

  const recovery = (async () => {
    let removedStaleBarrier = false;
    let retryNeeded = false;
    for (const [key, barrier] of [...terminalHistoryBarriers]) {
      if (!authenticatedConnection(barrier.instanceId)) continue;
      const record = conversationTabs.get(key);
      if (!record || record.tabId !== barrier.tabId) {
        if (terminalHistoryBarriers.get(key) === barrier) {
          terminalHistoryBarriers.delete(key);
          removedStaleBarrier = true;
        }
        continue;
      }
      if (activeRuns.has(key)) continue;

      try {
        const delivered = await withTransientConversationTabActivation(
          key,
          barrier.tabId,
          async () => await syncConversationSnapshotFromTab(record, 5),
        );
        if (!delivered && terminalHistoryBarriers.get(key) === barrier) retryNeeded = true;
      } catch {
        if (terminalHistoryBarriers.get(key) === barrier) retryNeeded = true;
      }
    }
    if (removedStaleBarrier) await persistSession();
    if (retryNeeded) {
      // A named one-shot alarm survives MV3 suspension and is replaced, not
      // duplicated, by later failed attempts. Host/outbound heartbeats also
      // retry sooner while the worker remains alive.
      await chrome.alarms.create(TERMINAL_HISTORY_RECOVERY_ALARM, {
        delayInMinutes: 0.5,
      });
    }
  })();
  terminalHistoryRecoveryPromise = recovery;
  try {
    await recovery;
  } finally {
    if (terminalHistoryRecoveryPromise === recovery) terminalHistoryRecoveryPromise = undefined;
  }
}

function sendConversationSnapshot(
  connection: RelayConnection,
  conversationId: string,
  snapshot: VisibleConversationSnapshot,
) {
  return sendConnection(
    connection,
    makeEnvelope({
      type: "conversation.snapshot",
      instanceId: connection.instanceId!,
      conversationId,
      payload: {
        remoteUrl: snapshot.remoteUrl,
        ...(snapshot.title ? { title: snapshot.title } : {}),
        messages: snapshot.messages,
        observedAt: snapshot.observedAt,
        complete: snapshot.complete,
      } satisfies ConversationSnapshotPayload,
    }),
  );
}

async function focusTab(tabId: number) {
  if (workerSuspended) return;
  const inspected = await chrome.tabs.get(tabId);
  const windowId = inspected.windowId;
  // Focusing is an explicit user/error-recovery action. Mark it before any
  // activation so a later run terminal cannot immediately restore the old tab.
  markWindowUserIntervened(windowId, tabId);
  await withWindowActivationQueue(windowId, async () => {
    await updateTabWithInternalActivation(
      windowId,
      tabId,
      { active: true },
      "Timed out while focusing the ChatGPT tab.",
    );
    await chrome.windows.update(windowId, { focused: true });
  });
}

async function removeOwnedTab(record: TabRecord): Promise<"closed" | "already-absent"> {
  const tab = await chrome.tabs.get(record.tabId).catch(() => undefined);
  if (tab?.id === undefined) return "already-absent";
  if (!isChatGptPageUrl(tab.url)) {
    throw relayFailure(
      "CHATGPT_REMOTE_UNAVAILABLE",
      "The mapped tab is no longer a ChatGPT page; it was not closed.",
      record.tabId,
    );
  }
  closingTabs.add(tab.id);
  try {
    await chrome.tabs.remove(tab.id);
    return "closed";
  } catch (error) {
    throw relayFailure(
      "CHATGPT_REMOTE_UNAVAILABLE",
      errorMessage(error, "Chrome did not close the mapped ChatGPT tab."),
      record.tabId,
    );
  } finally {
    closingTabs.delete(tab.id);
  }
}

async function handleTabRemoved(tabId: number) {
  projectDiscoveryExpectedProjectNavigations.delete(tabId);
  if (projectDiscoveryTabId === tabId) {
    projectDiscoveryTabId = undefined;
    await persistProjectDiscoveryTabId().catch(() => undefined);
  }
  tabNavigationSequences.delete(tabId);
  clearExpectedTabNavigationsForTab(tabId);
  clearCompletedCanonicalizationsForTab(tabId, true);
  for (const [key, grant] of completedInitialAdoptions) {
    if (grant.tabId === tabId) completedInitialAdoptions.delete(key);
  }
  if (closingTabs.delete(tabId)) return;
  const records = entriesForMappedTab([...conversationTabs.entries()], tabId);
  for (const [key, record] of records) {
    if (!mappingStillOwnsTab(conversationTabs.get(key), record, tabId)) continue;
    conversationTabs.delete(key);
    preparedDispatchTranscriptBaselines.delete(key);
    terminalHistoryBarriers.delete(key);
    const run = activeRuns.get(key);
    if (run) {
      await failRun(run, "CHATGPT_REMOTE_UNAVAILABLE", "ChatGPT 标签页已被关闭。");
    }
    if (record.remoteUrl) {
      // Keep the remote URL in the VS Code conversation; only the ephemeral tab
      // ownership record is removed here.
    }
  }
  if (records.length > 0) await persistSession();
}

async function handleTabUrlChanged(tabId: number, url: string, navigationSequence: number) {
  const currentTab = await chrome.tabs.get(tabId).catch(() => undefined);
  const eventIsCurrent =
    tabNavigationSequences.get(tabId) === navigationSequence &&
    Boolean(currentTab?.url && sameTabNavigationUrl(currentTab.url, url));
  if (!eventIsCurrent) return false;

  const records = entriesForMappedTab([...conversationTabs.entries()], tabId);
  if (records.length === 0) return true;
  const currentUrl = currentTab!.url!;
  if (!isChatGptPageUrl(currentUrl)) {
    for (const [key, record] of records) {
      if (!mappingStillOwnsTab(conversationTabs.get(key), record, tabId)) continue;
      conversationTabs.delete(key);
      terminalHistoryBarriers.delete(key);
      expectedTabNavigations.delete(key);
      completedCanonicalizations.delete(key);
      const run = activeRuns.get(key);
      if (run) {
        run.tabId = tabId;
        await failRun(
          run,
          "CHATGPT_LOGIN_REQUIRED",
          "ChatGPT 标签页已离开 chatgpt.com，请在 Chrome 中完成登录后重试。",
          true,
        );
      }
    }
    await persistSession();
    return true;
  }

  const remoteUrl = normalizeRemoteConversationUrl(currentUrl);
  if (!remoteUrl) {
    for (const [key, record] of records) {
      if (!mappingStillOwnsTab(conversationTabs.get(key), record, tabId)) continue;
      conversationTabs.delete(key);
      terminalHistoryBarriers.delete(key);
      expectedTabNavigations.delete(key);
      completedCanonicalizations.delete(key);
      const run = activeRuns.get(key);
      if (run) {
        run.tabId = tabId;
        await failRun(
          run,
          "CHATGPT_REMOTE_UNAVAILABLE",
          "ChatGPT 标签页已离开可识别的问答页面。",
          true,
        );
      }
    }
    await persistSession();
    return true;
  }
  let changed = false;
  for (const [key, record] of records) {
    if (!mappingStillOwnsTab(conversationTabs.get(key), record, tabId)) continue;
    const run = activeRuns.get(key);
    if (!projectUrlMatchesRecord(record, remoteUrl)) {
      conversationTabs.delete(key);
      terminalHistoryBarriers.delete(key);
      expectedTabNavigations.delete(key);
      completedCanonicalizations.delete(key);
      changed = true;
      if (run) {
        run.tabId = tabId;
        await failRun(
          run,
          "CHATGPT_PROJECT_MISMATCH",
          `ChatGPT 标签页已离开绑定的 Ask2GPT Project；已停止同步。当前路径：${new URL(remoteUrl).pathname}，绑定范围：${new URL(record.projectScope ?? "https://chatgpt.com/").pathname}。`,
          true,
        );
      }
      continue;
    }
    const observedConversationUrl = isRemoteConversationPage(remoteUrl) ? remoteUrl : undefined;
    // A URL update alone is never used to detach or rebind a healthy owned
    // tab. ChatGPT can replace provisional ids at any time. The full visible
    // transcript inspected below is the authoritative rebind signal.
    if (!observedConversationUrl || !record.remoteUrl) {
      continue;
    }
    if (!sameChatGptConversationIdentity(record.remoteUrl, observedConversationUrl)) {
      if (
        run &&
        run.tabId === tabId &&
        !allowsInitialRemoteAdoption(run) &&
        !allowsRemoteCanonicalization(run)
      ) {
        conversationTabs.delete(key);
        terminalHistoryBarriers.delete(key);
        expectedTabNavigations.delete(key);
        completedCanonicalizations.delete(key);
        changed = true;
        run.tabId = tabId;
        await failRun(
          run,
          "CHATGPT_REMOTE_UNAVAILABLE",
          "The owned ChatGPT tab moved to a different conversation while receiving the answer; the question was not resent.",
          true,
        );
      }
      continue;
    }
    const redirectAllowed = hasExpectedTabNavigation(key, tabId);
    const decision = decideMappedTabNavigation({
      eventIsCurrent: true,
      mappedRemoteUrl: record.remoteUrl,
      observedConversationUrl,
      initialAdoptionAllowed: Boolean(
        run && run.tabId === tabId && allowsInitialRemoteAdoption(run),
      ),
      redirectAllowed,
      canonicalization: "none",
    });
    if (decision.action === "await-attestation") continue;
    if (decision.action === "detach") {
      conversationTabs.delete(key);
      terminalHistoryBarriers.delete(key);
      expectedTabNavigations.delete(key);
      completedCanonicalizations.delete(key);
      changed = true;
      if (run) {
        run.tabId = tabId;
        await failRun(
          run,
          "CHATGPT_REMOTE_UNAVAILABLE",
          "ChatGPT 标签页已离开当前映射的会话。",
          true,
        );
      }
      continue;
    }
    if (decision.action === "adopt" && record.remoteUrl !== decision.remoteUrl) {
      const previousRemoteUrl = record.remoteUrl;
      const wasUnmapped = record.remoteUrl === undefined;
      const wasDifferentConversation = Boolean(
        record.remoteUrl && !sameChatGptConversationIdentity(record.remoteUrl, decision.remoteUrl),
      );
      record.remoteUrl = decision.remoteUrl;
      record.remoteTitle = undefined;
      changed = true;
      const completedGrant = completedCanonicalizations.get(key);
      const preservesCompletedGrant = Boolean(
        !run &&
        completedGrant &&
        previousRemoteUrl &&
        sameChatGptConversationIdentity(completedGrant.fromRemoteUrl, previousRemoteUrl) &&
        !wasDifferentConversation,
      );
      if (completedGrant && !preservesCompletedGrant) {
        completedCanonicalizations.delete(key);
      }
      if (run && allowsInitialRemoteAdoption(run) && wasUnmapped) {
        lockRemoteAdoption(run);
      } else if (run && wasDifferentConversation && allowsRemoteCanonicalization(run)) {
        // Keep tracking the exact run through further ChatGPT redirects.
      } else if (redirectAllowed) {
        clearExpectedTabNavigation(key, tabId);
      }
    } else if (record.remoteUrl && run && allowsInitialRemoteAdoption(run)) {
      lockRemoteAdoption(run);
      changed = true;
    }
  }
  if (changed) await persistSession();
  if (isRemoteConversationPage(remoteUrl)) {
    await Promise.all(
      records.map(async ([key, record]) => {
        if (conversationTabs.get(key) === record) await syncConversationSnapshotFromTab(record, 5);
      }),
    );
  }
  return true;
}

async function recoverReloadedTab(tabId: number) {
  const records = entriesForMappedTab([...conversationTabs.entries()], tabId);
  for (const [key, record] of records) {
    if (!mappingStillOwnsTab(conversationTabs.get(key), record, tabId)) continue;
    const run = activeRuns.get(key);
    // A dispatching run owns a tab before the original send call. Recovering it
    // here would race that send and could turn a valid prompt into an orphan.
    if (run?.phase === "active" && run.tabId === tabId) {
      const currentTab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (conversationTabs.get(key) !== record || activeRuns.get(key) !== run) continue;
      const currentUrl = normalizeRemoteConversationUrl(currentTab?.url);
      if (allowsInitialRemoteAdoption(run) && currentUrl && !isRemoteConversationPage(currentUrl)) {
        continue;
      }
      await recoverRun(run, { focusOnFailure: false });
    }
    await syncConversationSnapshotFromTab(record, 1);
  }
}

async function reconcileStoredState() {
  let changed = false;
  for (const [key, record] of [...conversationTabs]) {
    const tab = await chrome.tabs.get(record.tabId).catch(() => undefined);
    const isMappedChatGptTab = Boolean(
      tab?.id && isChatGptPageUrl(tab.url) && normalizeRemoteConversationUrl(tab.url),
    );
    if (!isMappedChatGptTab) {
      conversationTabs.delete(key);
      terminalHistoryBarriers.delete(key);
      expectedTabNavigations.delete(key);
      completedCanonicalizations.delete(key);
      changed = true;
    }
  }
  for (const [key, barrier] of [...terminalHistoryBarriers]) {
    const tab = conversationTabs.get(key);
    const activeRun = activeRuns.get(key);
    if (
      !tab ||
      tab.tabId !== barrier.tabId ||
      (activeRun !== undefined && activeRun.runId !== barrier.runId)
    ) {
      terminalHistoryBarriers.delete(key);
      changed = true;
    }
  }
  if (completedCanonicalizations.size > 0) {
    // These are legacy v7 Host/Relay timer handshakes. The current visible
    // transcript will re-establish the URL without deleting a healthy tab.
    completedCanonicalizations.clear();
    settledCanonicalizationTombstones.clear();
    changed = true;
  }
  for (const run of [...activeRuns.values()]) {
    const key = conversationKey(run.instanceId, run.conversationId);
    if (isRunExpired(run)) {
      await failRun(run, "RESPONSE_TIMEOUT", "恢复时发现生成任务已超过 30 分钟。");
      changed = true;
      continue;
    }
    const tab = conversationTabs.get(key);
    if (!tab || (run.tabId !== undefined && run.tabId !== tab.tabId)) {
      await failRun(run, "CHATGPT_REMOTE_UNAVAILABLE", "恢复时找不到该会话对应的 ChatGPT 标签页。");
      changed = true;
    } else {
      const restoredAdoption = classifyRestoredRemoteAdoption(run, Boolean(tab.remoteUrl));
      if (restoredAdoption === "fail") {
        conversationTabs.delete(key);
        terminalHistoryBarriers.delete(key);
        expectedTabNavigations.delete(key);
        run.tabId = tab.tabId;
        await failRun(
          run,
          "CHATGPT_REMOTE_UNAVAILABLE",
          "恢复时无法验证该生成任务的远端会话映射。",
        );
        changed = true;
        continue;
      }
      if (restoredAdoption === "lock") {
        lockRemoteAdoption(run);
        changed = true;
      }
      run.tabId = tab.tabId;
      await setRunTabProtection(tab.tabId, true);
    }
  }
  if (changed) await persistSession();
}

async function handlePopupMessage(message: Record<string, unknown>) {
  if (message.type === "popup.status") {
    // Opening or polling the popup is an explicit user recovery signal. Bypass
    // idle backoff so newly opened VS Code windows are discovered immediately.
    rescanPortsNow(false);
    return {
      connected: [...connections.values()].some((connection) => connection.authenticated),
      scanning: [...connections.values()].some(
        (connection) => connection.socket.readyState === WebSocket.CONNECTING,
      ),
      project: projectBinding
        ? projectBindingTrusted
          ? {
              bound: true as const,
              name: projectBinding.name,
              projectUrl: projectBinding.projectUrl,
            }
          : { bound: false as const }
        : { bound: false as const },
      projectSetup: projectBindingTrusted ? ({ phase: "idle" } as const) : projectSetupState,
      backgroundReception: {
        enhancedEnabled: enhancedBackgroundEnabled,
        permissionGranted: await hasDebuggerPermission(),
      },
      lastError,
      servers: [...connections.values()]
        .filter((connection) => connection.socket.readyState === WebSocket.OPEN)
        .map(({ port, instanceId, authenticated, label, transportState }) => ({
          port,
          instanceId,
          authenticated,
          label,
          transportState,
        })),
    };
  }
  if (message.type === "popup.rescan") {
    rescanPortsNow();
    return { ok: true };
  }
  if (message.type === "popup.setEnhancedBackground") {
    if (typeof message.enabled !== "boolean") return { ok: false };
    const permissionGranted = await hasDebuggerPermission();
    if (message.enabled && !permissionGranted) {
      return { ok: false, permissionRequired: true, enabled: false, permissionGranted: false };
    }
    enhancedBackgroundEnabled = message.enabled;
    await chrome.storage.local.set({
      [ENHANCED_BACKGROUND_STORAGE_KEY]: enhancedBackgroundEnabled,
    });
    if (!enhancedBackgroundEnabled) await stopAllEnhancedDebuggerCaptures();
    return {
      ok: true,
      enabled: enhancedBackgroundEnabled,
      permissionGranted,
    };
  }
  if (message.type === "popup.listProjects") {
    return { ok: true, projects: await listVisibleProjectCandidates() };
  }
  if (message.type === "popup.prepareReload") {
    await prepareRelayReload();
    // The popup may close as soon as the click completes. The worker owns the
    // reload so a successfully sealed/checkpointed Relay cannot be stranded.
    scheduleRelayRuntimeReload();
    return { ok: true, reloadScheduled: true };
  }
  if (message.type === "popup.bindCurrentProject") {
    const binding = await bindCurrentProjectFromPopup();
    return {
      ok: true,
      project: {
        bound: true,
        name: REQUIRED_PROJECT_NAME,
        projectUrl: binding.projectUrl,
      },
    };
  }
  if (message.type === "popup.bindProject") {
    try {
      const binding = await bindSelectedProjectFromPopup(message.projectUrl);
      return {
        ok: true,
        project: {
          bound: true,
          name: binding.name,
          projectUrl: binding.projectUrl,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Project 关联失败。",
        projectSetup: projectSetupState,
      };
    }
  }
  if (message.type === "popup.openChatGpt") {
    const mode = message.mode === "create" ? "create" : "open";
    if (mode === "create") {
      try {
        const result = await createDedicatedProjectFromPopup();
        return {
          ok: true,
          created: result.created,
          project: {
            bound: true,
            name: result.binding.name,
            projectUrl: result.binding.projectUrl,
          },
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Ask2GPT Project 创建失败。",
          projectSetup: projectSetupState,
        };
      }
    }
    await chrome.tabs.create({
      url: projectBindingTrusted
        ? (projectBinding?.projectUrl ?? "https://chatgpt.com/")
        : "https://chatgpt.com/",
      active: true,
    });
    return { ok: true };
  }
  return { ok: false };
}

function sendStatus(connection: RelayConnection, force = false) {
  const instanceId = connection.instanceId!;
  const payload = {
    connected: true,
    authenticated: true,
    activeRuns: [...activeRuns.values()].filter((run) => run.instanceId === instanceId).length,
    selectorVersion: SELECTOR_VERSION,
    project:
      projectBinding && projectBindingTrusted
        ? { bound: true as const, name: projectBinding.name }
        : { bound: false as const },
  };
  const statusKey = JSON.stringify(payload);
  if (!force && connection.lastStatusKey === statusKey) return;
  connection.lastStatusKey = statusKey;
  sendConnection(
    connection,
    makeEnvelope({
      type: "relay.status",
      instanceId,
      payload,
    }),
  );
}

function sendError(
  connection: RelayConnection,
  source: RelayEnvelope,
  code: RelayErrorCode,
  message: string,
  focusTab = false,
) {
  sendConnection(
    connection,
    makeEnvelope({
      type: "relay.error",
      instanceId: connection.instanceId ?? source.instanceId,
      conversationId: source.conversationId,
      runId: source.runId,
      payload: { code, message: message.slice(0, 1_000), recoverable: true, focusTab },
    }),
  );
}

async function sendCaughtError(
  connection: RelayConnection,
  source: RelayEnvelope,
  error: unknown,
  fallbackCode: RelayErrorCode,
  focusRequested = false,
  fallbackTabId?: number,
) {
  const effectiveFocusRequested = automaticFocusAllowed(focusRequested);
  sendError(
    connection,
    source,
    errorCode(error, fallbackCode),
    errorMessage(error, "ChatGPT 页面中转失败。"),
    effectiveFocusRequested,
  );
  const tabId = errorTabId(error) ?? fallbackTabId;
  if (effectiveFocusRequested && tabId !== undefined) {
    await focusTab(tabId).catch(() => undefined);
  }
}

function rejectProtocol(
  connection: RelayConnection,
  source: RelayEnvelope | undefined,
  message: string,
) {
  lastError = message.slice(0, 1_000);
  const instanceId = connection.instanceId ?? source?.instanceId;
  if (instanceId) {
    sendConnection(
      connection,
      makeEnvelope({
        type: "relay.error",
        instanceId,
        conversationId: source?.conversationId,
        runId: source?.runId,
        payload: {
          code: "PROTOCOL_MISMATCH",
          message,
          recoverable: false,
        } satisfies RelayErrorPayload,
      }),
    );
  }
  connection.socket.close(1008, "Protocol mismatch");
}

function sendConnection(connection: RelayConnection, envelope: RelayEnvelope) {
  if (connection.socket.readyState !== WebSocket.OPEN) return false;
  const serialized = JSON.stringify(envelope);
  if (utf8ByteLength(serialized) > MAX_RELAY_FRAME_BYTES) {
    connection.socket.close(1009, "Frame too large");
    return false;
  }
  try {
    connection.socket.send(serialized);
    return true;
  } catch {
    connection.transportState = "error";
    return false;
  }
}

function pinInstanceId(connection: RelayConnection, instanceId: string) {
  if (!isSafeId(instanceId)) {
    rejectProtocol(connection, undefined, "Unsafe VS Code instance identifier.");
    return false;
  }
  if (connection.instanceId && connection.instanceId !== instanceId) {
    rejectProtocol(connection, undefined, "VS Code instance changed after connection pinning.");
    return false;
  }
  connection.instanceId = instanceId;
  return true;
}

function requireConversationId(connection: RelayConnection, envelope: RelayEnvelope) {
  if (!isSafeId(envelope.conversationId)) {
    rejectProtocol(connection, envelope, "Invalid conversation identifier.");
    return undefined;
  }
  return envelope.conversationId;
}

function requireRunId(connection: RelayConnection, envelope: RelayEnvelope) {
  if (!isSafeId(envelope.runId)) {
    rejectProtocol(connection, envelope, "Invalid run identifier.");
    return undefined;
  }
  return envelope.runId;
}

function parseOpenPayload(value: unknown): ConversationOpenPayload | undefined {
  if (
    !isRecord(value) ||
    (value.active !== undefined && typeof value.active !== "boolean") ||
    (value.dispatchIntent !== undefined && typeof value.dispatchIntent !== "boolean")
  ) {
    return undefined;
  }
  const remoteUrl = parseOptionalRemoteUrl(value);
  if (remoteUrl === false) return undefined;
  const transcriptProof = parseConversationTranscriptProof(value.transcriptProof);
  if (
    transcriptProof === false ||
    (transcriptProof &&
      (!remoteUrl || !sameChatGptConversationIdentity(transcriptProof.remoteUrl, remoteUrl)))
  ) {
    return undefined;
  }
  return {
    ...(remoteUrl ? { remoteUrl } : {}),
    ...(value.active === undefined ? {} : { active: value.active }),
    ...(value.dispatchIntent === undefined ? {} : { dispatchIntent: value.dispatchIntent }),
    ...(transcriptProof ? { transcriptProof } : {}),
  };
}

function parseSendPayload(value: unknown): ConversationSendPayload | undefined {
  if (
    !isRecord(value) ||
    !isSafeId(value.messageId) ||
    (value.modelId !== undefined && !isSafeId(value.modelId))
  ) {
    return undefined;
  }
  const prompt = normalizePromptText(value.prompt);
  if (prompt === undefined) return undefined;
  const attachments = parseChatFileAttachments(value.attachments);
  if (attachments === false) return undefined;
  const remoteUrl = parseOptionalRemoteUrl(value);
  if (remoteUrl === false) return undefined;
  const transcriptProof = parseConversationTranscriptProof(value.transcriptProof);
  if (
    transcriptProof === false ||
    (transcriptProof &&
      (!remoteUrl || !sameChatGptConversationIdentity(transcriptProof.remoteUrl, remoteUrl)))
  ) {
    return undefined;
  }
  return {
    prompt,
    messageId: value.messageId,
    ...(typeof value.modelId === "string" ? { modelId: value.modelId } : {}),
    ...(attachments?.length ? { attachments } : {}),
    ...(remoteUrl ? { remoteUrl } : {}),
    ...(transcriptProof ? { transcriptProof } : {}),
  };
}

function parseConversationTranscriptProof(
  value: unknown,
): ConversationTranscriptProof | undefined | false {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.messageCount) ||
    Number(value.messageCount) < 0 ||
    Number(value.messageCount) > 200 ||
    !Array.isArray(value.messageHashes) ||
    value.messageHashes.length !== Number(value.messageCount) ||
    value.messageHashes.length > 200 ||
    typeof value.transcriptChainSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.transcriptChainSha256)
  ) {
    return false;
  }
  const remoteUrl = normalizeRemoteConversationUrl(value.remoteUrl);
  if (!remoteUrl || !isRemoteConversationPage(remoteUrl)) return false;
  const messageHashes: ConversationTranscriptProof["messageHashes"] = [];
  for (const item of value.messageHashes) {
    if (
      !isRecord(item) ||
      (item.role !== "user" && item.role !== "assistant") ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.sha256)
    ) {
      return false;
    }
    messageHashes.push({ role: item.role, sha256: item.sha256 });
  }
  return {
    remoteUrl,
    messageCount: messageHashes.length,
    messageHashes,
    transcriptChainSha256: value.transcriptChainSha256,
  };
}

function parseChatFileAttachments(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_CHAT_FILE_ATTACHMENTS) return false as const;
  let totalChars = 0;
  const attachments: NonNullable<ConversationSendPayload["attachments"]> = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !isSafeId(item.id) ||
      typeof item.fileName !== "string" ||
      item.fileName.length < 1 ||
      item.fileName.length > 240 ||
      item.fileName !== item.fileName.trim() ||
      /[\\/\p{Cc}\p{Cf}]/u.test(item.fileName) ||
      typeof item.mimeType !== "string" ||
      item.mimeType.length < 1 ||
      item.mimeType.length > 120 ||
      item.mimeType !== item.mimeType.trim() ||
      typeof item.content !== "string" ||
      item.content.length > MAX_CHAT_FILE_CHARS
    ) {
      return false as const;
    }
    totalChars += item.content.length;
    if (totalChars > MAX_CHAT_FILE_BUNDLE_CHARS) return false as const;
    attachments.push({
      id: item.id,
      fileName: item.fileName,
      mimeType: item.mimeType,
      content: item.content,
    });
  }
  return attachments;
}

function parseStopPayload(value: unknown): GenerationStopPayload | undefined {
  if (
    !isRecord(value) ||
    typeof value.requestedAt !== "string" ||
    !Number.isFinite(Date.parse(value.requestedAt))
  ) {
    return undefined;
  }
  return { requestedAt: value.requestedAt };
}

function parseRegeneratePayload(value: unknown): GenerationRegeneratePayload | undefined {
  if (!isRecord(value) || !isSafeId(value.messageId)) return undefined;
  const remoteUrl = parseOptionalRemoteUrl(value);
  if (remoteUrl === false) return undefined;
  return { messageId: value.messageId, ...(remoteUrl ? { remoteUrl } : {}) };
}

function parseModelListPayload(value: unknown): ModelListPayload | undefined {
  if (!isRecord(value) || !isSafeId(value.requestId)) return undefined;
  const remoteUrl = parseOptionalRemoteUrl(value);
  if (remoteUrl === false) return undefined;
  return { requestId: value.requestId, ...(remoteUrl ? { remoteUrl } : {}) };
}

function parseModelSelectPayload(value: unknown): ModelSelectPayload | undefined {
  if (!isRecord(value) || !isSafeId(value.requestId) || !isSafeId(value.modelId)) {
    return undefined;
  }
  const remoteUrl = parseOptionalRemoteUrl(value);
  if (remoteUrl === false) return undefined;
  return {
    requestId: value.requestId,
    modelId: value.modelId,
    ...(remoteUrl ? { remoteUrl } : {}),
  };
}

function parseCanonicalizationCheckPayload(
  value: unknown,
): ConversationCanonicalizationCheckPayload | undefined {
  if (
    !isRecord(value) ||
    !isSafeId(value.requestId) ||
    !isSafeId(value.runId) ||
    typeof value.fromRemoteUrl !== "string" ||
    typeof value.terminalMarkdownSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.terminalMarkdownSha256) ||
    typeof value.terminalTranscriptSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.terminalTranscriptSha256)
  ) {
    return undefined;
  }
  const fromRemoteUrl = normalizeRemoteConversationUrl(value.fromRemoteUrl);
  if (!fromRemoteUrl || !isRemoteConversationPage(fromRemoteUrl)) return undefined;
  return {
    requestId: value.requestId,
    runId: value.runId,
    fromRemoteUrl,
    terminalMarkdownSha256: value.terminalMarkdownSha256,
    terminalTranscriptSha256: value.terminalTranscriptSha256,
  };
}

function canonicalizationCheckMatchesGrant(
  payload: ConversationCanonicalizationCheckPayload,
  grant: CompletedCanonicalizationRecord,
) {
  return (
    payload.runId === grant.runId &&
    sameChatGptConversationIdentity(payload.fromRemoteUrl, grant.fromRemoteUrl) &&
    payload.terminalMarkdownSha256 === grant.terminalMarkdownSha256 &&
    payload.terminalTranscriptSha256 === grant.terminalTranscriptSha256
  );
}

function parseClosePayload(value: unknown): ConversationClosePayload | undefined {
  return isRecord(value) && typeof value.closeTab === "boolean"
    ? { closeTab: value.closeTab }
    : undefined;
}

function parseOptionalRemoteUrl(value: Record<string, unknown>): string | false | undefined {
  if (value.remoteUrl === undefined) return undefined;
  return normalizeRemoteConversationUrl(value.remoteUrl) ?? false;
}

function isRemoteConversationPage(value: string) {
  const url = new URL(value);
  if (/^\/c\/[^/]+$/.test(url.pathname)) return true;
  const segments = url.pathname.split("/").filter(Boolean);
  return (
    segments.length === 4 &&
    segments[0] === "g" &&
    segments[2] === "c" &&
    segments.every((segment) => segment.length > 0)
  );
}

function parseVisibleConversationSnapshot(value: unknown): VisibleConversationSnapshot | undefined {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    typeof value.remoteUrl !== "string" ||
    !Array.isArray(value.messages) ||
    value.messages.length > 200 ||
    typeof value.observedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    typeof value.complete !== "boolean" ||
    (value.historyComplete !== undefined && typeof value.historyComplete !== "boolean")
  ) {
    return undefined;
  }
  const remoteUrl = normalizeRemoteConversationUrl(value.remoteUrl);
  if (!remoteUrl || !isRemoteConversationPage(remoteUrl)) return undefined;
  const title =
    value.title === undefined ? undefined : normalizeRemoteConversationTitle(value.title);
  if (value.title !== undefined && !title) return undefined;

  const messages: ConversationSnapshotPayload["messages"] = [];
  let totalBytes = 0;
  for (const item of value.messages) {
    if (
      !isRecord(item) ||
      (item.role !== "user" && item.role !== "assistant") ||
      typeof item.markdown !== "string" ||
      item.markdown.length > 200_000
    ) {
      return undefined;
    }
    totalBytes += utf8ByteLength(item.markdown);
    if (totalBytes > MAX_RELAY_FRAME_BYTES - 64 * 1024) return undefined;
    messages.push({ role: item.role, markdown: item.markdown });
  }
  return {
    remoteUrl,
    ...(title ? { title } : {}),
    messages,
    observedAt: value.observedAt,
    complete: value.complete,
    historyComplete:
      typeof value.historyComplete === "boolean" ? value.historyComplete : value.complete,
  };
}

function parseModelCatalogResponse(value: unknown) {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.options)) return undefined;
  if (value.options.length < 1 || value.options.length > 20) return undefined;
  const options = value.options.map(parseVisibleModelOption);
  if (options.some((option) => option === undefined)) return undefined;
  const validOptions = options as ChatModelOption[];
  if (new Set(validOptions.map((option) => option.id)).size !== validOptions.length)
    return undefined;
  if (validOptions.filter((option) => option.selected).length > 1) return undefined;
  const currentModelId = value.currentModelId;
  if (
    currentModelId !== undefined &&
    (!isSafeId(currentModelId) || !validOptions.some((option) => option.id === currentModelId))
  ) {
    return undefined;
  }
  return {
    options: validOptions,
    ...(currentModelId ? { currentModelId } : {}),
  };
}

function parseModelSelectedResponse(value: unknown) {
  if (!isRecord(value) || value.ok !== true) return undefined;
  const selected = parseVisibleModelOption(value.selected);
  return selected?.selected ? ({ ...selected, selected: true } as const) : undefined;
}

function parseVisibleModelOption(value: unknown): ChatModelOption | undefined {
  if (
    !isRecord(value) ||
    !isSafeId(value.id) ||
    typeof value.label !== "string" ||
    value.label.length < 1 ||
    value.label.length > 80 ||
    value.label !== value.label.trim() ||
    /[\p{Cc}\p{Cf}]/u.test(value.label) ||
    typeof value.selected !== "boolean"
  ) {
    return undefined;
  }
  if (
    value.description !== undefined &&
    (typeof value.description !== "string" ||
      value.description.length < 1 ||
      value.description.length > 160 ||
      value.description !== value.description.trim() ||
      /[\p{Cc}\p{Cf}]/u.test(value.description))
  ) {
    return undefined;
  }
  if (
    (value.mode !== undefined &&
      !["smart", "fast", "low", "medium", "high", "very-high", "pro"].includes(
        String(value.mode),
      )) ||
    (value.modelId !== undefined && !isSafeId(value.modelId)) ||
    (value.familyLabel !== undefined && !isSafeModelText(value.familyLabel, 80)) ||
    (value.secondaryLabel !== undefined && !isSafeModelText(value.secondaryLabel, 24)) ||
    (value.reasoningEffort !== undefined &&
      !["min", "standard", "extended", "max"].includes(String(value.reasoningEffort)))
  ) {
    return undefined;
  }
  return {
    id: value.id,
    label: value.label,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.mode === "string" ? { mode: value.mode as ChatModelOption["mode"] } : {}),
    ...(typeof value.modelId === "string" ? { modelId: value.modelId } : {}),
    ...(typeof value.familyLabel === "string" ? { familyLabel: value.familyLabel } : {}),
    ...(typeof value.secondaryLabel === "string" ? { secondaryLabel: value.secondaryLabel } : {}),
    ...(typeof value.reasoningEffort === "string"
      ? { reasoningEffort: value.reasoningEffort as ChatModelOption["reasoningEffort"] }
      : {}),
    selected: value.selected,
  };
}

function isSafeModelText(value: unknown, maxLength: number) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

function throwModelContentFailure(value: unknown, fallback: RelayErrorCode, tabId: number) {
  if (!isRecord(value) || value.ok !== false || !isRecord(value.error)) return;
  const code = errorCode(value.error, fallback);
  const message =
    typeof value.error.message === "string" && value.error.message.length > 0
      ? value.error.message.slice(0, 1_000)
      : "ChatGPT model control failed.";
  throw relayFailure(code, message, tabId);
}

function assertSuccessfulContentResponse(value: unknown): asserts value is ContentResponse {
  if (!isRecord(value) || value.ok !== true) {
    throw relayFailure("SELECTOR_INCOMPATIBLE", "ChatGPT 页面拒绝了中转操作。");
  }
  if (
    value.markdown !== undefined &&
    (typeof value.markdown !== "string" || utf8ByteLength(value.markdown) > MAX_RELAY_FRAME_BYTES)
  ) {
    throw relayFailure("FRAME_TOO_LARGE", "ChatGPT 页面返回了过大的回答。");
  }
  if (
    (value.active !== undefined && typeof value.active !== "boolean") ||
    (value.remoteUrl !== undefined && typeof value.remoteUrl !== "string") ||
    (value.title !== undefined && !normalizeRemoteConversationTitle(value.title))
  ) {
    throw relayFailure("SELECTOR_INCOMPATIBLE", "ChatGPT 页面返回了无效状态。");
  }
}

function throwDefinitiveContentSendFailure(value: unknown, tabId: number) {
  if (
    !isRecord(value) ||
    value.ok !== false ||
    value.definitiveFailure !== true ||
    !isRecord(value.error)
  ) {
    return;
  }
  const failure = relayFailure(
    errorCode(value.error, "SELECTOR_INCOMPATIBLE"),
    typeof value.error.message === "string" && value.error.message.length > 0
      ? value.error.message.slice(0, 1_000)
      : "ChatGPT rejected the page transaction before submission.",
    tabId,
  );
  Object.assign(failure, { definitiveContentFailure: true as const });
  throw failure;
}

function isDefinitiveContentSendFailure(error: unknown) {
  return Boolean(
    isRecord(error) &&
    "definitiveContentFailure" in error &&
    error.definitiveContentFailure === true,
  );
}

function relayFailure(code: RelayErrorCode, message: string, tabId?: number) {
  return Object.assign(new Error(message), {
    code,
    ...(tabId === undefined ? {} : { tabId }),
  });
}

function hasRelayFailureCode(error: unknown): error is { code: RelayErrorCode } {
  return Boolean(
    isRecord(error) &&
    typeof error.code === "string" &&
    (relayErrorCodes as readonly string[]).includes(error.code),
  );
}

function isTransientContentRecoveryFailure(error: unknown) {
  if (hasRelayFailureCode(error) || !(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return [
    "timed out",
    "message port",
    "message channel closed",
    "receiving end does not exist",
    "could not establish connection",
    "context invalidated",
    "service worker is suspended",
  ].some((fragment) => message.includes(fragment));
}

function errorCode(error: unknown, fallback: RelayErrorCode): RelayErrorCode {
  if (hasRelayFailureCode(error)) {
    return error.code as RelayErrorCode;
  }
  return fallback;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function errorTabId(error: unknown) {
  if (isRecord(error) && Number.isSafeInteger(error.tabId) && Number(error.tabId) >= 0) {
    return Number(error.tabId);
  }
  return undefined;
}

function isTerminalEvent(event: ValidatedContentEvent) {
  return ["complete", "stopped", "error"].includes(event.eventType);
}

function authenticatedConnection(instanceId: string) {
  return [...connections.values()].find(
    (connection) =>
      connection.authenticated &&
      connection.instanceId === instanceId &&
      connection.socket.readyState === WebSocket.OPEN,
  );
}

function isPopupMessage(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    [
      "popup.status",
      "popup.rescan",
      "popup.setEnhancedBackground",
      "popup.listProjects",
      "popup.prepareReload",
      "popup.bindCurrentProject",
      "popup.bindProject",
      "popup.openChatGpt",
    ].includes(value.type)
  );
}

function isTrustedPopupSender(sender: chrome.runtime.MessageSender) {
  return (
    sender.id === chrome.runtime.id &&
    sender.tab === undefined &&
    sender.url === chrome.runtime.getURL("popup.html")
  );
}

function parseDispatchPageValidationRequest(
  value: unknown,
): DispatchPageValidationRequest | undefined {
  if (
    !isRecord(value) ||
    value.type !== "content.validateDispatchPage" ||
    !isSafeId(value.conversationId) ||
    !isSafeId(value.runId)
  ) {
    return undefined;
  }
  const expectedRemoteUrl = normalizeRemoteConversationUrl(value.expectedRemoteUrl);
  const observedRemoteUrl = normalizeRemoteConversationUrl(value.observedRemoteUrl);
  if (
    !expectedRemoteUrl ||
    !observedRemoteUrl ||
    !isRemoteConversationPage(expectedRemoteUrl) ||
    !isRemoteConversationPage(observedRemoteUrl) ||
    expectedRemoteUrl !== value.expectedRemoteUrl ||
    observedRemoteUrl !== value.observedRemoteUrl
  ) {
    return undefined;
  }
  return {
    type: "content.validateDispatchPage",
    conversationId: value.conversationId,
    runId: value.runId,
    expectedRemoteUrl,
    observedRemoteUrl,
  };
}

function parseContentMainWorldSendRequest(value: unknown): ContentMainWorldSendRequest | undefined {
  if (
    !isRecord(value) ||
    value.type !== "content.mainWorldSend.request" ||
    !isSafeId(value.conversationId) ||
    !isSafeId(value.runId) ||
    !isCompatibleContentRuntime(value.selectorVersion) ||
    Object.keys(value).length !== 4
  ) {
    return undefined;
  }
  return {
    type: "content.mainWorldSend.request",
    conversationId: value.conversationId,
    runId: value.runId,
    selectorVersion: value.selectorVersion,
  };
}

function parseContentRecoveryRequest(value: unknown): ContentRecoveryRequest | undefined {
  if (
    !isRecord(value) ||
    value.type !== "content.recovery.request" ||
    !isSafeId(value.conversationId) ||
    !isSafeId(value.runId) ||
    !isCompatibleContentRuntime(value.selectorVersion) ||
    (value.reason !== "network-complete-dom-missing" && value.reason !== "hidden-attributed-stall")
  ) {
    return undefined;
  }
  return {
    type: "content.recovery.request",
    conversationId: value.conversationId,
    runId: value.runId,
    selectorVersion: value.selectorVersion,
    reason: value.reason,
  };
}

function isTrustedChatGptSender(sender: chrome.runtime.MessageSender) {
  return Boolean(
    sender.id === chrome.runtime.id &&
    sender.tab?.id !== undefined &&
    (sender.frameId === undefined || sender.frameId === 0) &&
    isChatGptPageUrl(sender.url ?? sender.tab.url),
  );
}

async function persistSession({ broadcast = true }: { broadcast?: boolean } = {}) {
  if (workerSuspended) return;
  if (deferredSessionPersistTimer) {
    clearTimeout(deferredSessionPersistTimer);
    deferredSessionPersistTimer = undefined;
  }
  // Chrome event handlers may overlap. Serialize writes and take the snapshot
  // when a write actually runs so an older completion cannot overwrite newer
  // tab/run state.
  const next = sessionStorageWrite
    .catch(() => undefined)
    .then(async () => {
      if (workerSuspended) return;
      await chrome.storage.session.set({
        conversationTabsV2: [...conversationTabs.values()],
        activeRunsV2: [...activeRuns.values()],
        completedCanonicalizationsV1: [...completedCanonicalizations.values()],
        [TERMINAL_HISTORY_BARRIER_STORAGE_KEY]: [...terminalHistoryBarriers.values()],
        pendingEventsV2: [...pendingEvents.values()],
        [RUN_VISIBILITY_LEASE_STORAGE_KEY]: serializeRunVisibilityLeases(),
      });
      if (broadcast) broadcastStatus();
    });
  sessionStorageWrite = next;
  await next;
}

function scheduleSessionPersist() {
  if (workerSuspended) return;
  if (deferredSessionPersistTimer) return;
  deferredSessionPersistTimer = setTimeout(() => {
    deferredSessionPersistTimer = undefined;
    void persistSession().catch(() =>
      recordBackgroundFailure("Failed to checkpoint pending relay events."),
    );
  }, 500);
}

function broadcastStatus() {
  for (const connection of connections.values()) {
    if (
      connection.authenticated &&
      connection.instanceId &&
      connection.socket.readyState === WebSocket.OPEN
    ) {
      sendStatus(connection);
    }
  }
}

function replaceMap<K, V>(target: Map<K, V>, source: Map<K, V>) {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function clearReconnectTimers() {
  for (const timer of reconnectTimers.values()) clearTimeout(timer);
  reconnectTimers.clear();
}

function nextTabNavigationSequence(tabId: number) {
  const next = (tabNavigationSequences.get(tabId) ?? 0) + 1;
  tabNavigationSequences.set(tabId, next);
  return next;
}

function nextWindowActivationEpoch(windowId: number) {
  const next = (windowActivationEpochs.get(windowId) ?? 0) + 1;
  windowActivationEpochs.set(windowId, next);
  return next;
}

function windowActivationEpoch(windowId: number) {
  return windowActivationEpochs.get(windowId) ?? 0;
}

function registerExpectedTabActivation(windowId: number, tabId: number) {
  const expected: ExpectedTabActivation = {
    expiresAt: Date.now() + 5_000,
    tabId,
    token: nextExpectedTabActivationToken++,
  };
  const pending = expectedTabActivations.get(windowId) ?? [];
  expectedTabActivations.set(windowId, [...pending, expected]);
  setTimeout(() => removeExpectedTabActivation(windowId, expected.token), 5_000);
  return expected;
}

function removeExpectedTabActivation(windowId: number, token: number) {
  const pending = expectedTabActivations.get(windowId);
  if (!pending) return;
  const next = pending.filter((candidate) => candidate.token !== token);
  if (next.length > 0) expectedTabActivations.set(windowId, next);
  else expectedTabActivations.delete(windowId);
}

function consumeExpectedTabActivation(windowId: number, tabId: number) {
  const pending = expectedTabActivations.get(windowId);
  if (!pending) return false;
  const now = Date.now();
  const match = pending.find((candidate) => candidate.expiresAt > now && candidate.tabId === tabId);
  const next = pending.filter(
    (candidate) => candidate.expiresAt > now && candidate.token !== match?.token,
  );
  if (next.length > 0) expectedTabActivations.set(windowId, next);
  else expectedTabActivations.delete(windowId);
  return match !== undefined;
}

function markWindowUserIntervened(windowId: number, activeTabId?: number) {
  const homeWindowId = parkingWindowOwners.get(windowId) ?? windowId;
  nextWindowActivationEpoch(homeWindowId);
  const state = windowVisibilityLeaseStates.get(homeWindowId);
  if (!state) return;
  if (activeTabId !== undefined) state.preferredActiveTabId = activeTabId;
  if (state.userIntervened) return;
  state.userIntervened = true;
  void (
    state.parked
      ? (async () => {
          if (state.parkingWindowId === undefined) {
            if (state.restoreBounds) {
              await chrome.windows.update(homeWindowId, {
                ...state.restoreBounds,
                drawAttention: false,
                focused: true,
              });
            }
            state.parked = false;
            state.restoreMinimized = false;
          } else {
            if (windowId !== homeWindowId) {
              await chrome.windows.update(homeWindowId, {
                drawAttention: false,
                focused: true,
                state: "normal",
              });
            }
            await restoreTemporaryParkingWindowForUser(homeWindowId, state);
          }
        })().catch(() =>
          recordBackgroundFailure("Failed to restore the temporary Relay window for the user."),
        )
      : Promise.resolve()
  )
    .then(() => persistSession())
    .catch(() => recordBackgroundFailure("Failed to persist Chrome visibility intervention."));
}

function allowsInitialRemoteAdoption(run: ActiveRunRecord) {
  return run.remoteAdoptionStage === "initial";
}

function allowsRemoteCanonicalization(run: ActiveRunRecord) {
  // Authority comes from the exact mapped tab + page-side run id and lasts
  // until that run reaches a terminal state. A wall-clock window made long
  // answers fail even though the content observer was still valid.
  return run.remoteAdoptionStage === "canonicalizing";
}

function lockRemoteAdoption(run: ActiveRunRecord) {
  run.remoteAdoptionStage = "locked";
  delete run.canonicalizationExpiresAt;
}

async function createCompletedCanonicalizationGrant(
  run: ActiveRunRecord,
  tab: TabRecord,
  event: ValidatedContentEvent,
): Promise<CompletedCanonicalizationRecord | undefined> {
  const initialDispatchBaseline = run.dispatchTranscriptBaseline;
  const completedInitialRunCanCanonicalize = Boolean(
    initialDispatchBaseline?.initialProjectUrl && initialDispatchBaseline.messageCount === 0,
  );
  if (
    (event.eventType !== "complete" && event.eventType !== "stopped") ||
    !event.remoteUrl ||
    (!allowsRemoteCanonicalization(run) && !completedInitialRunCanCanonicalize) ||
    tab.tabId !== run.tabId ||
    !sameChatGptConversationIdentity(tab.remoteUrl ?? event.remoteUrl, event.remoteUrl)
  ) {
    return undefined;
  }
  const response: unknown = await sendToTabWithTimeout(
    tab.tabId,
    { type: "content.inspectConversation" },
    2_000,
  ).catch(() => undefined);
  const snapshot = parseVisibleConversationSnapshot(response);
  if (
    !snapshot?.historyComplete ||
    !sameChatGptConversationIdentity(snapshot.remoteUrl, event.remoteUrl)
  ) {
    return undefined;
  }
  const terminalMarkdown = event.markdown ?? "";
  const latest = snapshot.messages.at(-1);
  const terminalMatches =
    event.eventType === "complete"
      ? latest?.role === "assistant" && latest.markdown === terminalMarkdown
      : latest?.role === "user" && terminalMarkdown === "";
  if (!terminalMatches) return undefined;

  return {
    instanceId: run.instanceId,
    conversationId: run.conversationId,
    runId: run.runId,
    tabId: tab.tabId,
    fromRemoteUrl: event.remoteUrl,
    terminalMarkdownSha256: await sha256Hex(terminalMarkdown),
    terminalTranscriptSha256: await transcriptSha256(snapshot.messages),
    terminalStatus: event.eventType,
    expiresAt: new Date(Date.now() + REMOTE_CANONICALIZATION_WINDOW_MS).toISOString(),
  };
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameDispatchTranscriptCandidate(
  left: DispatchTranscriptCandidate | undefined,
  right: DispatchTranscriptCandidate | undefined,
) {
  return Boolean(
    left &&
    right &&
    left.remoteUrl === right.remoteUrl &&
    left.initialProjectUrl === right.initialProjectUrl &&
    left.messageCount === right.messageCount &&
    sameTranscriptProof(left, right),
  );
}

async function inspectDispatchTranscriptCandidate(
  tab: TabRecord,
  tabId: number,
  { allowAttestedEmptyPartial = false }: { allowAttestedEmptyPartial?: boolean } = {},
) {
  const diagnosticKey = conversationKey(tab.instanceId, tab.conversationId);
  const currentTab = await chrome.tabs.get(tabId).catch(() => undefined);
  const currentPageUrl = normalizeRemoteConversationUrl(currentTab?.url);
  if (!currentPageUrl || !projectUrlMatchesRecord(tab, currentPageUrl)) {
    dispatchTranscriptDiagnostics.set(diagnosticKey, "inspect-page-mismatch");
    return;
  }
  const response: unknown = await sendToTabWithTimeout(
    tabId,
    { type: "content.inspectConversation" },
    PRE_DISPATCH_TRANSCRIPT_INSPECT_TIMEOUT_MS,
  ).catch(() => undefined);
  if (!isRecord(response) || !isCompatibleContentRuntime(response.selectorVersion)) {
    dispatchTranscriptDiagnostics.set(diagnosticKey, "inspect-response-missing");
    return;
  }

  const snapshot = tab.remoteUrl ? parseVisibleConversationSnapshot(response) : undefined;
  const initialProjectUrl = tab.remoteUrl
    ? undefined
    : parseEmptyInitialProjectTranscript(response, currentPageUrl);
  const validExistingConversation = Boolean(
    tab.remoteUrl &&
    snapshot?.historyComplete &&
    sameChatGptConversationIdentity(tab.remoteUrl, snapshot.remoteUrl) &&
    projectUrlMatchesRecord(tab, snapshot.remoteUrl),
  );
  if (validExistingConversation || initialProjectUrl) {
    const remoteUrl = snapshot?.remoteUrl ?? initialProjectUrl!;
    const messages = snapshot?.messages ?? [];
    dispatchTranscriptDiagnostics.set(diagnosticKey, `full-accepted count=${messages.length}`);
    return {
      remoteUrl,
      ...(initialProjectUrl ? { initialProjectUrl } : {}),
      messageCount: messages.length,
      transcriptSha256: await transcriptSha256(messages),
      transcriptChainSha256: await transcriptChainSha256(messages),
    } satisfies DispatchTranscriptCandidate;
  }
  if (
    tab.remoteUrl &&
    snapshot &&
    sameChatGptConversationIdentity(tab.remoteUrl, snapshot.remoteUrl)
  ) {
    return await cachedBaselineForPartialSnapshot(tab, snapshot, {
      allowAttestedEmptyPartial,
    });
  }
  dispatchTranscriptDiagnostics.set(diagnosticKey, "inspect-snapshot-invalid");
}

async function prepareDispatchTranscriptBaseline(key: string, tabId: number) {
  const tab = conversationTabs.get(key);
  if (!tab || tab.tabId !== tabId || activeRuns.has(key)) return;
  const navigationSequence = tabNavigationSequences.get(tabId) ?? 0;
  const deadline = Date.now() + PRE_DISPATCH_TRANSCRIPT_RETRY_WINDOW_MS;
  let previousCandidate: DispatchTranscriptCandidate | undefined;

  while (Date.now() <= deadline) {
    if (
      activeRuns.has(key) ||
      conversationTabs.get(key) !== tab ||
      tab.tabId !== tabId ||
      (tabNavigationSequences.get(tabId) ?? 0) !== navigationSequence
    ) {
      return;
    }
    const candidate = await inspectDispatchTranscriptCandidate(tab, tabId);
    if (sameDispatchTranscriptCandidate(candidate, previousCandidate)) {
      if (
        candidate &&
        !activeRuns.has(key) &&
        conversationTabs.get(key) === tab &&
        (tabNavigationSequences.get(tabId) ?? 0) === navigationSequence
      ) {
        preparedDispatchTranscriptBaselines.set(key, {
          ...candidate,
          tabId,
          navigationSequence,
          preparedAt: Date.now(),
        });
      }
      return;
    }
    previousCandidate = candidate;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return;
    await delay(Math.min(PRE_DISPATCH_TRANSCRIPT_STABILITY_MS, remainingMs));
  }
}

async function rememberRunDispatchTranscriptBaseline(
  key: string,
  run: ActiveRunRecord,
  tabId: number,
  { allowAttestedEmptyPartial = false }: { allowAttestedEmptyPartial?: boolean } = {},
) {
  const tab = conversationTabs.get(key);
  if (!tab || tab.tabId !== tabId || activeRuns.get(key) !== run) {
    dispatchTranscriptDiagnostics.set(
      key,
      `baseline-unavailable tab=${String(Boolean(tab))} mapped=${String(tab?.tabId === tabId)} active=${String(activeRuns.get(key) === run)}`,
    );
    return;
  }
  const navigationSequence = tabNavigationSequences.get(tabId) ?? 0;
  const deadline = Date.now() + PRE_DISPATCH_TRANSCRIPT_RETRY_WINDOW_MS;
  const prepared = preparedDispatchTranscriptBaselines.get(key);
  let previousCandidate: DispatchTranscriptCandidate | undefined =
    prepared?.tabId === tabId && prepared.navigationSequence === navigationSequence
      ? prepared
      : undefined;
  if (prepared && !previousCandidate) preparedDispatchTranscriptBaselines.delete(key);
  let stableCandidate: typeof previousCandidate;

  while (Date.now() <= deadline) {
    if (
      activeRuns.get(key) !== run ||
      conversationTabs.get(key) !== tab ||
      run.tabId !== tabId ||
      (tabNavigationSequences.get(tabId) ?? 0) !== navigationSequence
    ) {
      dispatchTranscriptDiagnostics.set(key, "baseline-invalidated");
      return;
    }
    const candidate = await inspectDispatchTranscriptCandidate(tab, tabId, {
      allowAttestedEmptyPartial,
    });
    if (sameDispatchTranscriptCandidate(candidate, previousCandidate)) {
      stableCandidate = candidate;
      break;
    }
    previousCandidate = candidate;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return;
    await delay(Math.min(PRE_DISPATCH_TRANSCRIPT_STABILITY_MS, remainingMs));
  }
  if (!stableCandidate) {
    const lastDiagnostic = dispatchTranscriptDiagnostics.get(key) ?? "none";
    dispatchTranscriptDiagnostics.set(key, `baseline-unstable last=${lastDiagnostic}`);
    return;
  }
  preparedDispatchTranscriptBaselines.delete(key);
  const baselineRemoteUrl = stableCandidate.remoteUrl;
  if (
    activeRuns.get(key) !== run ||
    conversationTabs.get(key) !== tab ||
    run.tabId !== tabId ||
    (tabNavigationSequences.get(tabId) ?? 0) !== navigationSequence ||
    normalizeRemoteConversationUrl((await chrome.tabs.get(tabId).catch(() => undefined))?.url) !==
      baselineRemoteUrl
  ) {
    return;
  }
  const baseline: RunDispatchTranscriptBaseline = {
    runId: run.runId,
    tabId,
    remoteUrl: baselineRemoteUrl,
    ...(stableCandidate.initialProjectUrl
      ? { initialProjectUrl: stableCandidate.initialProjectUrl }
      : {}),
    messageCount: stableCandidate.messageCount,
    transcriptSha256: stableCandidate.transcriptSha256,
    ...(stableCandidate.transcriptChainSha256
      ? { transcriptChainSha256: stableCandidate.transcriptChainSha256 }
      : {}),
  };
  if (
    activeRuns.get(key) === run &&
    conversationTabs.get(key) === tab &&
    run.tabId === tabId &&
    (tabNavigationSequences.get(tabId) ?? 0) === navigationSequence &&
    normalizeRemoteConversationUrl((await chrome.tabs.get(tabId).catch(() => undefined))?.url) ===
      baselineRemoteUrl
  ) {
    runDispatchTranscriptBaselines.set(key, baseline);
    run.dispatchTranscriptBaseline = {
      tabId: baseline.tabId,
      remoteUrl: baseline.remoteUrl,
      ...(baseline.initialProjectUrl ? { initialProjectUrl: baseline.initialProjectUrl } : {}),
      messageCount: baseline.messageCount,
      transcriptSha256: baseline.transcriptSha256,
      ...(baseline.transcriptChainSha256
        ? { transcriptChainSha256: baseline.transcriptChainSha256 }
        : {}),
    };
    // Persist before the non-idempotent content.send. If MV3 is replaced after
    // the click, recovery still has the exact pre-dispatch transcript prefix
    // and never has to guess from a repeated prompt/answer pair.
    await persistSession();
    if (
      activeRuns.get(key) === run &&
      conversationTabs.get(key) === tab &&
      run.tabId === tabId &&
      runDispatchTranscriptBaselines.get(key) === baseline &&
      (tabNavigationSequences.get(tabId) ?? 0) === navigationSequence &&
      normalizeRemoteConversationUrl((await chrome.tabs.get(tabId).catch(() => undefined))?.url) ===
        baselineRemoteUrl
    ) {
      return baseline;
    }
    if (runDispatchTranscriptBaselines.get(key) === baseline) {
      runDispatchTranscriptBaselines.delete(key);
      delete run.dispatchTranscriptBaseline;
    }
  }
}

function parseEmptyInitialProjectTranscript(value: unknown, expectedProjectUrl: string) {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !isCompatibleContentRuntime(value.selectorVersion) ||
    value.historyComplete !== true ||
    !Array.isArray(value.messages) ||
    value.messages.length !== 0 ||
    typeof value.observedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt))
  ) {
    return undefined;
  }
  const remoteUrl = normalizeRemoteConversationUrl(value.remoteUrl);
  if (!remoteUrl || remoteUrl !== expectedProjectUrl || !parseProjectRootUrl(remoteUrl)) {
    return undefined;
  }
  return remoteUrl;
}

function promoteDispatchTranscriptBaseline(
  key: string,
  run: ActiveRunRecord,
  tab: TabRecord,
  remoteUrl: string,
) {
  const baseline = runDispatchTranscriptBaselines.get(key);
  const persisted = run.dispatchTranscriptBaseline;
  if (
    !baseline ||
    baseline.runId !== run.runId ||
    !persisted ||
    activeRuns.get(key) !== run ||
    conversationTabs.get(key) !== tab ||
    tab.tabId !== baseline.tabId ||
    tab.remoteUrl !== remoteUrl ||
    persisted.tabId !== baseline.tabId ||
    persisted.messageCount !== baseline.messageCount ||
    !sameTranscriptProof(persisted, baseline) ||
    !projectUrlMatchesRecord(tab, baseline.remoteUrl) ||
    !projectUrlMatchesRecord(tab, remoteUrl)
  ) {
    return;
  }
  baseline.remoteUrl = remoteUrl;
  persisted.remoteUrl = remoteUrl;
}

async function activeRunTranscriptMatchesRoute(
  key: string,
  run: ActiveRunRecord,
  tab: TabRecord,
  expectedRemoteUrl: string,
  evidence: {
    markdown?: string;
    terminal?: boolean;
    allowUserOnly?: boolean;
  } = {},
): Promise<"attested" | "defer" | "mismatch"> {
  const baseline =
    runDispatchTranscriptBaselines.get(key) ??
    (run.dispatchTranscriptBaseline
      ? { runId: run.runId, ...run.dispatchTranscriptBaseline }
      : undefined);
  if (
    !run.promptSha256 ||
    !baseline ||
    baseline.runId !== run.runId ||
    !allowsInitialRemoteAdoption(run) ||
    !baseline.initialProjectUrl ||
    baseline.messageCount !== 0 ||
    baseline.transcriptSha256 !== (await transcriptSha256([]))
  ) {
    return "mismatch";
  }
  if (
    baseline.tabId !== tab.tabId ||
    activeRuns.get(key) !== run ||
    conversationTabs.get(key) !== tab ||
    run.tabId !== tab.tabId
  ) {
    return "defer";
  }

  const navigationSequence = tabNavigationSequences.get(tab.tabId) ?? 0;
  const response: unknown = await sendToTabWithTimeout(
    tab.tabId,
    { type: "content.inspectConversation" },
    2_000,
  ).catch(() => undefined);
  if (activeRuns.get(key) !== run || conversationTabs.get(key) !== tab || run.tabId !== tab.tabId) {
    return "defer";
  }
  const snapshot = parseVisibleConversationSnapshot(response);
  if (!snapshot || !snapshot.historyComplete) return "defer";
  if (
    !projectUrlMatchesRecord(tab, snapshot.remoteUrl) ||
    (snapshot.messages.length !== baseline.messageCount + 1 &&
      snapshot.messages.length !== baseline.messageCount + 2)
  ) {
    return "mismatch";
  }
  if (snapshot.remoteUrl !== expectedRemoteUrl) return "defer";

  const user = snapshot.messages[baseline.messageCount];
  const assistant = snapshot.messages[baseline.messageCount + 1];
  if (
    user?.role !== "user" ||
    (assistant !== undefined && assistant.role !== "assistant") ||
    !(await dispatchBaselineMatchesMessages(
      baseline,
      snapshot.messages.slice(0, baseline.messageCount),
    ))
  ) {
    return "mismatch";
  }
  if (!assistant && !evidence.allowUserOnly) return "defer";
  if (
    typeof evidence.markdown === "string" &&
    evidence.markdown.length > 0 &&
    (!assistant ||
      (evidence.terminal
        ? assistant.markdown !== evidence.markdown
        : assistant.markdown !== evidence.markdown &&
          !assistant.markdown.startsWith(evidence.markdown)))
  ) {
    return "mismatch";
  }
  if (evidence.terminal && (!snapshot.complete || !assistant)) return "defer";
  const userPromptSha256 = await sha256Hex(user.markdown);
  const submittedPromptPresentationSha256 =
    isRecord(response) &&
    response.activeRunId === run.runId &&
    typeof response.submittedPromptPresentationSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(response.submittedPromptPresentationSha256)
      ? response.submittedPromptPresentationSha256
      : undefined;
  const promptMatches =
    userPromptSha256 === run.promptSha256 ||
    (run.promptInlinePresentationVersion === PROMPT_INLINE_PRESENTATION_VERSION &&
      Boolean(run.promptInlinePresentationSha256) &&
      userPromptSha256 === run.promptInlinePresentationSha256) ||
    userPromptSha256 === submittedPromptPresentationSha256;
  if (!promptMatches) return "mismatch";

  // Inspection and hashing both yield. Re-check the exact run, mapping,
  // baseline object, and browser URL before granting route adoption.
  const currentTab = await chrome.tabs.get(tab.tabId).catch(() => undefined);
  const currentBaseline = runDispatchTranscriptBaselines.get(key);
  return activeRuns.get(key) === run &&
    conversationTabs.get(key) === tab &&
    run.tabId === tab.tabId &&
    (!currentBaseline || currentBaseline === baseline) &&
    (tabNavigationSequences.get(tab.tabId) ?? 0) === navigationSequence &&
    exactRecoveryRemoteRouteMatches(
      tab,
      normalizeRemoteConversationUrl(currentTab?.url),
      snapshot.remoteUrl,
    )
    ? "attested"
    : "defer";
}

async function settleRunFromCompletedSnapshot(
  key: string,
  run: ActiveRunRecord,
  tab: TabRecord,
  snapshot: ConversationSnapshotPayload,
  expected: ForwardedSnapshotRecord | undefined,
) {
  if (activeRuns.get(key) !== run || conversationTabs.get(key) !== tab) return;
  const terminal = snapshot.messages.at(-1);
  const complete = terminal
    ? parseContentEvent({
        type: "content.event",
        eventType: "complete",
        conversationId: run.conversationId,
        runId: run.runId,
        markdown: terminal.markdown,
        remoteUrl: snapshot.remoteUrl,
        ...(snapshot.title ? { title: snapshot.title } : {}),
      })
    : undefined;
  if (!complete) {
    throw relayFailure("FRAME_TOO_LARGE", "Recovered final answer was invalid or too large.");
  }
  await handleContentEvent(complete, tab.tabId, {
    expected,
    exactTranscriptRecovery: true,
  });
}

async function recoverClaimedRunFromExactTranscript(
  key: string,
  run: ActiveRunRecord,
  tab: TabRecord,
  focusOnFailure: boolean,
) {
  const claimedAt = Date.parse(run.historyReloadClaimedAt ?? "");
  const baseline = run.dispatchTranscriptBaseline;
  const currentTab = await chrome.tabs.get(tab.tabId).catch(() => undefined);
  const currentUrl = normalizeRemoteConversationUrl(currentTab?.url);
  const mappedUrl = normalizeRemoteConversationUrl(tab.remoteUrl);
  const exactAuthority = Boolean(
    baseline &&
    Number.isFinite(claimedAt) &&
    baseline.tabId === tab.tabId &&
    run.tabId === tab.tabId &&
    exactRecoveryRemoteRouteMatches(tab, currentUrl, baseline.remoteUrl) &&
    (mappedUrl === baseline.remoteUrl ||
      (mappedUrl !== undefined && sameChatGptConversationIdentity(mappedUrl, baseline.remoteUrl))),
  );
  if (!exactAuthority) {
    await failRun(
      run,
      "CHATGPT_REMOTE_UNAVAILABLE",
      "The ChatGPT tab changed while Ask2GPT was restoring the exact submitted turn; the question was not resent.",
      focusOnFailure,
    );
    return;
  }

  const snapshot = await readCompletedSnapshotForActiveRun(key, run, tab, baseline!.remoteUrl);
  if (snapshot) {
    await settleRunFromCompletedSnapshot(key, run, tab, snapshot, forwardedSnapshots.get(key));
    return;
  }
  if (activeRuns.get(key) !== run || conversationTabs.get(key) !== tab) return;

  if (Date.now() - claimedAt < HISTORY_RELOAD_HYDRATION_GRACE_MS) {
    run.phase = "active";
    await persistSession();
    return;
  }
  await failRun(
    run,
    "CHATGPT_REMOTE_UNAVAILABLE",
    "ChatGPT completed the network response, but the exact submitted turn was still unavailable after one safe history refresh. Ask2GPT did not resend the question.",
    focusOnFailure,
  );
}

async function refreshRunFromExactTranscript(
  key: string,
  run: ActiveRunRecord,
  tab: TabRecord,
  expectedRemoteUrl: string,
): Promise<{ claimed: boolean; snapshot?: ConversationSnapshotPayload }> {
  const baseline = run.dispatchTranscriptBaseline;
  if (
    !baseline ||
    baseline.tabId !== tab.tabId ||
    run.tabId !== tab.tabId ||
    baseline.remoteUrl !== expectedRemoteUrl ||
    normalizeRemoteConversationUrl(tab.remoteUrl) !== baseline.remoteUrl ||
    activeRuns.get(key) !== run ||
    conversationTabs.get(key) !== tab
  ) {
    return { claimed: false };
  }
  const currentTab = await chrome.tabs.get(tab.tabId).catch(() => undefined);
  if (
    activeRuns.get(key) !== run ||
    conversationTabs.get(key) !== tab ||
    run.tabId !== tab.tabId ||
    !exactRecoveryRemoteRouteMatches(
      tab,
      normalizeRemoteConversationUrl(currentTab?.url),
      baseline.remoteUrl,
    ) ||
    findPendingTerminalEvent(run)
  ) {
    return { claimed: false };
  }

  // Persist the claim before tabs.reload. A worker replacement in the narrow
  // gap may conservatively fail this run later, but can never reload (or send)
  // it twice.
  run.historyReloadClaimedAt = new Date().toISOString();
  await persistSession();
  if (
    activeRuns.get(key) !== run ||
    conversationTabs.get(key) !== tab ||
    run.tabId !== tab.tabId ||
    !exactRecoveryRemoteRouteMatches(
      tab,
      normalizeRemoteConversationUrl(
        (await chrome.tabs.get(tab.tabId).catch(() => undefined))?.url,
      ),
      baseline.remoteUrl,
    )
  ) {
    return { claimed: true };
  }

  const reloadAndInspect = async () => {
    await promiseWithTimeout(
      chrome.tabs.reload(tab.tabId),
      5_000,
      "Timed out while refreshing the completed ChatGPT conversation.",
    );
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (activeRuns.get(key) !== run || conversationTabs.get(key) !== tab) return undefined;
      await delay(250);
      const snapshot = await readCompletedSnapshotForActiveRun(key, run, tab, baseline.remoteUrl);
      if (snapshot) return snapshot;
    }
    return undefined;
  };

  await setRunTabProtection(tab.tabId, true);
  try {
    // Hydration depends on the target tab being active, not merely on its
    // Chrome window having focus. The activation helper is a no-op when the
    // Relay tab is already selected and otherwise restores the user's tab
    // unless they intervene during the bounded recovery lease.
    const snapshot = await withTransientConversationTabActivation(key, tab.tabId, reloadAndInspect);
    return snapshot ? { claimed: true, snapshot } : { claimed: true };
  } catch {
    // The durable claim keeps subsequent checkpoints in exact-transcript mode.
    // They will either observe the hydrated history or fail after the bounded
    // grace window; the non-idempotent send path is never called again.
    return { claimed: true };
  }
}

async function readCompletedSnapshotForActiveRun(
  key: string,
  run: ActiveRunRecord,
  tab: TabRecord,
  expectedRemoteUrl: string,
) {
  return await readExactTranscriptSnapshotForActiveRun(key, run, tab, expectedRemoteUrl, true);
}

async function readNetworkCompletedSnapshotForActiveRun(
  key: string,
  run: ActiveRunRecord,
  tab: TabRecord,
  expectedRemoteUrl: string,
) {
  return await readExactTranscriptSnapshotForActiveRun(key, run, tab, expectedRemoteUrl, false);
}

async function readExactTranscriptSnapshotForActiveRun(
  key: string,
  run: ActiveRunRecord,
  tab: TabRecord,
  expectedRemoteUrl: string,
  requireTerminalUiEvidence: boolean,
): Promise<ConversationSnapshotPayload | undefined> {
  const baseline =
    runDispatchTranscriptBaselines.get(key) ??
    (run.dispatchTranscriptBaseline
      ? { runId: run.runId, ...run.dispatchTranscriptBaseline }
      : undefined);
  if (
    !run.promptSha256 ||
    !baseline ||
    baseline.runId !== run.runId ||
    baseline.tabId !== tab.tabId ||
    !sameChatGptConversationIdentity(baseline.remoteUrl, expectedRemoteUrl) ||
    activeRuns.get(key) !== run ||
    conversationTabs.get(key) !== tab ||
    run.tabId !== tab.tabId
  ) {
    return undefined;
  }
  const response: unknown = await sendToTabWithTimeout(
    tab.tabId,
    { type: "content.inspectConversation" },
    2_000,
  ).catch(() => undefined);
  if (activeRuns.get(key) !== run || conversationTabs.get(key) !== tab || run.tabId !== tab.tabId) {
    return undefined;
  }
  const snapshot = parseVisibleConversationSnapshot(response);
  if (
    !snapshot ||
    (requireTerminalUiEvidence && !snapshot.complete) ||
    !snapshot.historyComplete ||
    snapshot.messages.length !== baseline.messageCount + 2 ||
    !projectUrlMatchesRecord(tab, snapshot.remoteUrl) ||
    !sameChatGptConversationIdentity(expectedRemoteUrl, snapshot.remoteUrl)
  ) {
    return undefined;
  }
  const terminalIndex = snapshot.messages.length - 1;
  const terminal = snapshot.messages[terminalIndex];
  const user = snapshot.messages[terminalIndex - 1];
  if (terminal?.role !== "assistant" || !terminal.markdown.trim() || user?.role !== "user") {
    return undefined;
  }
  const userPromptSha256 = await sha256Hex(user.markdown);
  const baselineStillPrefixesSnapshot = await dispatchBaselineMatchesMessages(
    baseline,
    snapshot.messages.slice(0, baseline.messageCount),
  );
  const promptMatches =
    userPromptSha256 === run.promptSha256 ||
    (run.promptInlinePresentationVersion === PROMPT_INLINE_PRESENTATION_VERSION &&
      Boolean(run.promptInlinePresentationSha256) &&
      userPromptSha256 === run.promptInlinePresentationSha256);
  if (!baselineStillPrefixesSnapshot || !promptMatches) return undefined;

  // Hashing and page inspection both yield. Revalidate the exact run, mapping,
  // tab URL, and inspected transcript route immediately before settlement.
  const currentTab = await chrome.tabs.get(tab.tabId).catch(() => undefined);
  if (
    activeRuns.get(key) !== run ||
    conversationTabs.get(key) !== tab ||
    runDispatchTranscriptBaselines.get(key) !== baseline ||
    run.tabId !== tab.tabId ||
    !exactRecoveryRemoteRouteMatches(
      tab,
      normalizeRemoteConversationUrl(currentTab?.url),
      snapshot.remoteUrl,
    )
  ) {
    return undefined;
  }
  return snapshot;
}

function exactRecoveryRemoteRouteMatches(
  tab: TabRecord,
  currentUrl: string | undefined,
  expectedConversationUrl: string,
) {
  if (!currentUrl) return false;
  if (
    currentUrl === expectedConversationUrl ||
    sameChatGptConversationIdentity(currentUrl, expectedConversationUrl)
  ) {
    return true;
  }

  // ChatGPT can briefly expose the bound Project home while a background or
  // minimized document is rebuilding. This route is only a read-only
  // recovery allowance: the inspected transcript must still carry the exact
  // expected conversation URL before the run can settle.
  const route = projectRouteForRecord(tab);
  return Boolean(
    route &&
    !isRemoteConversationPage(currentUrl) &&
    normalizeProjectScopedUrl(currentUrl, route) === route.projectUrl,
  );
}

// Keep this byte-for-byte aligned with prompt-presentation.ts version 1. The
// content script is emitted as a classic script; importing one implementation
// from both entrypoints would make Vite extract a shared ESM chunk that Chrome
// cannot load as a classic content script.
function promptInlinePresentationV1(value: string) {
  return value
    .replace(/\s+/gu, " ")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/([\\`[\]*_])/gu, "\\$1")
    .trim();
}

async function transcriptSha256(messages: ConversationSnapshotPayload["messages"]) {
  return await sha256Hex(
    JSON.stringify(messages.map((message) => [message.role, message.markdown])),
  );
}

async function transcriptChainSha256(messages: ConversationSnapshotPayload["messages"]) {
  const messageHashes = await Promise.all(
    messages.map(async (message) => ({
      role: message.role,
      sha256: await sha256Hex(JSON.stringify([message.role, message.markdown])),
    })),
  );
  return await transcriptChainSha256FromMessageHashes(messageHashes);
}

async function transcriptChainSha256FromMessageHashes(
  messageHashes: readonly { role: "user" | "assistant"; sha256: string }[],
) {
  return await sha256Hex(
    JSON.stringify(messageHashes.map((message) => [message.role, message.sha256])),
  );
}

function sameTranscriptProof(
  left: { transcriptSha256: string; transcriptChainSha256?: string },
  right: { transcriptSha256: string; transcriptChainSha256?: string },
) {
  return left.transcriptChainSha256 && right.transcriptChainSha256
    ? left.transcriptChainSha256 === right.transcriptChainSha256
    : left.transcriptSha256 === right.transcriptSha256;
}

async function dispatchBaselineMatchesMessages(
  baseline: { transcriptSha256: string; transcriptChainSha256?: string },
  messages: ConversationSnapshotPayload["messages"],
) {
  return baseline.transcriptChainSha256
    ? baseline.transcriptChainSha256 === (await transcriptChainSha256(messages))
    : baseline.transcriptSha256 === (await transcriptSha256(messages));
}

async function snapshotMatchesCompletedCanonicalization(
  snapshot: VisibleConversationSnapshot,
  record: CompletedCanonicalizationRecord,
) {
  if (!snapshot.historyComplete) return false;
  const transcriptFingerprint = await transcriptSha256(snapshot.messages).catch(() => undefined);
  if (transcriptFingerprint !== record.terminalTranscriptSha256) return false;

  const latestMessage = snapshot.messages.at(-1);
  if (latestMessage?.role === "assistant") {
    return (
      (await sha256Hex(latestMessage.markdown).catch(() => undefined)) ===
      record.terminalMarkdownSha256
    );
  }
  return (
    record.terminalStatus === "stopped" &&
    latestMessage?.role === "user" &&
    (await sha256Hex("").catch(() => undefined)) === record.terminalMarkdownSha256
  );
}

async function snapshotMatchesCompletedInitialAdoption(
  snapshot: ConversationSnapshotPayload,
  record: {
    promptSha256: string;
    promptInlinePresentationVersion?: 1;
    promptInlinePresentationSha256?: string;
    terminalMarkdownSha256: string;
    terminalStatus: "complete" | "stopped";
  },
) {
  if (!snapshot.complete) return false;
  const terminalIndex = snapshot.messages.length - 1;
  const terminal = snapshot.messages[terminalIndex];
  const user =
    record.terminalStatus === "complete"
      ? [...snapshot.messages.slice(0, terminalIndex)]
          .reverse()
          .find((message) => message.role === "user")
      : terminal?.role === "user"
        ? terminal
        : undefined;
  if (!user) return false;
  const exactPromptMatched = (await sha256Hex(user.markdown)) === record.promptSha256;
  const inlinePresentationPromptMatched = Boolean(
    !exactPromptMatched &&
    record.promptInlinePresentationVersion === PROMPT_INLINE_PRESENTATION_VERSION &&
    record.promptInlinePresentationSha256 &&
    (await sha256Hex(user.markdown)) === record.promptInlinePresentationSha256,
  );
  if (!exactPromptMatched && !inlinePresentationPromptMatched) return false;
  if (record.terminalStatus === "stopped") {
    return (await sha256Hex("")) === record.terminalMarkdownSha256;
  }
  return Boolean(
    terminal?.role === "assistant" &&
    (await sha256Hex(terminal.markdown)) === record.terminalMarkdownSha256,
  );
}

function clearCompletedCanonicalizationsForTab(tabId: number, includeDelivered = false) {
  let changed = false;
  for (const [key, record] of completedCanonicalizations) {
    if (record.tabId !== tabId || (!includeDelivered && record.toRemoteUrl)) continue;
    completedCanonicalizations.delete(key);
    changed = true;
  }
  return changed;
}

async function pendingUrlPromotionForSnapshot(
  key: string,
  tab: TabRecord,
  snapshot: VisibleConversationSnapshot,
) {
  const record = completedCanonicalizations.get(key);
  if (!record?.toRemoteUrl) return undefined;

  const currentTab = await chrome.tabs.get(tab.tabId).catch(() => undefined);
  const valid =
    record.instanceId === tab.instanceId &&
    record.conversationId === tab.conversationId &&
    record.tabId === tab.tabId &&
    Boolean(tab.remoteUrl) &&
    sameChatGptConversationIdentity(record.toRemoteUrl, tab.remoteUrl!) &&
    sameChatGptConversationIdentity(record.toRemoteUrl, snapshot.remoteUrl) &&
    normalizeRemoteConversationUrl(currentTab?.url) === snapshot.remoteUrl;
  if (!valid || !(await snapshotMatchesCompletedCanonicalization(snapshot, record))) {
    return undefined;
  }

  return {
    runId: record.runId,
    fromRemoteUrl: record.fromRemoteUrl,
    terminalMarkdownSha256: record.terminalMarkdownSha256,
    terminalTranscriptSha256: record.terminalTranscriptSha256,
  };
}

async function readVerifiedPromotionSnapshot(
  key: string,
  tab: TabRecord,
  grant: CompletedCanonicalizationRecord,
  attempts: number,
) {
  const retryDelays = [0, 250, 500] as const;
  for (let index = 0; index < Math.min(attempts, retryDelays.length); index += 1) {
    if (retryDelays[index]) await delay(retryDelays[index]!);
    if (
      conversationTabs.get(key) !== tab ||
      completedCanonicalizations.get(key) !== grant ||
      !grant.toRemoteUrl
    ) {
      return undefined;
    }
    const response: unknown = await sendToTabWithTimeout(
      tab.tabId,
      { type: "content.inspectConversation" },
      2_000,
    ).catch(() => undefined);
    const snapshot = parseVisibleConversationSnapshot(response);
    if (!snapshot) continue;
    const proof = await pendingUrlPromotionForSnapshot(key, tab, snapshot);
    if (proof) {
      const { historyComplete: _historyComplete, ...relaySnapshot } = snapshot;
      return { ...relaySnapshot, urlPromotion: proof };
    }
  }
  return undefined;
}

function grantExpectedTabNavigation(
  key: string,
  tabId: number,
  durationMs = TAB_NAVIGATION_LEASE_MS,
) {
  expectedTabNavigations.set(key, {
    tabId,
    expiresAt: Date.now() + durationMs,
  });
}

function clearExpectedTabNavigation(key: string, tabId: number) {
  if (expectedTabNavigations.get(key)?.tabId === tabId) expectedTabNavigations.delete(key);
}

function hasExpectedTabNavigation(key: string, tabId: number) {
  const lease = expectedTabNavigations.get(key);
  if (!lease) return false;
  if (lease.tabId !== tabId || lease.expiresAt <= Date.now()) {
    expectedTabNavigations.delete(key);
    return false;
  }
  return true;
}

function clearExpectedTabNavigationsForTab(tabId: number) {
  for (const [key, lease] of expectedTabNavigations) {
    if (lease.tabId === tabId) expectedTabNavigations.delete(key);
  }
}

function sameTabNavigationUrl(currentUrl: string, eventUrl: string) {
  const currentRemoteUrl = normalizeRemoteConversationUrl(currentUrl);
  const eventRemoteUrl = normalizeRemoteConversationUrl(eventUrl);
  if (currentRemoteUrl || eventRemoteUrl) return currentRemoteUrl === eventRemoteUrl;
  try {
    const current = new URL(currentUrl);
    const event = new URL(eventUrl);
    current.hash = "";
    event.hash = "";
    return current.href === event.href;
  } catch {
    return currentUrl === eventUrl;
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordBackgroundFailure(message: string) {
  // Deliberately avoid forwarding exception objects: browser/DOM errors can
  // contain page text or URLs. The popup only needs a stable diagnostic label.
  lastError = message;
}

if (chrome.runtime.id !== CHROME_EXTENSION_ID || PROTOCOL_VERSION !== 15) {
  console.warn("Ask2GPT Relay build identity mismatch.");
}
