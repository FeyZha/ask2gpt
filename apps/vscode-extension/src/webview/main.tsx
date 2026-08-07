import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import {
  MAX_INLINE_CONTEXT_BUNDLE_CHARS,
  MAX_INLINE_CONTEXT_CHARS,
  type ChatModelOption,
  type Conversation,
  type ConversationMessage,
  type ContextSnapshot,
  type QueuedFollowUp,
} from "@ask2gpt/protocol";

import type { AppState, ConnectionPhase, GenerationViewUpdate, ModelPickerState } from "../types";
import {
  ArchiveIcon,
  ChevronIcon,
  CloseIcon,
  CodeIcon,
  CopyIcon,
  EditIcon,
  FileIcon,
  FilesIcon,
  HistoryIcon,
  MoreIcon,
  PlusIcon,
  RefreshIcon,
  SendIcon,
  StopIcon,
  TrashIcon,
} from "./icons";
import { normalizeExternalHttpUrl } from "./external-url";
import { buildChatGptModelMenu } from "./model-menu";
import { nextStreamingMarkdown, streamingMarkdownFrameStep } from "./stream-smoothing";
import { onHostMessage, postMessage } from "./vscode";
import "./styles.css";

const copyLabel = { "zh-CN": "复制", en: "Copy" } as const;
const COMPOSER_DISPATCH_PREWARM_THROTTLE_MS = 3_000;

function readInitialAppState() {
  const element = document.getElementById("ask2gpt-initial-state");
  if (!element) return undefined;
  const json = element.textContent;
  element.remove();
  if (!json) return undefined;
  try {
    return JSON.parse(json) as AppState;
  } catch {
    return undefined;
  }
}

function hasActiveConversation(state: AppState) {
  return state.conversations.some((conversation) => conversation.id === state.activeConversationId);
}

function applyGenerationUpdate(state: AppState, update: GenerationViewUpdate) {
  const target = state.conversations.find(
    (conversation) =>
      conversation.id === update.conversationId && conversation.run?.id === update.runId,
  );
  if (!target?.messages.some((message) => message.id === update.messageId)) return state;

  const conversations = state.conversations
    .map((conversation) => {
      if (conversation.id !== update.conversationId || conversation.run?.id !== update.runId) {
        return conversation;
      }
      return {
        ...conversation,
        updatedAt: update.updatedAt,
        messages: conversation.messages.map((message) =>
          message.id === update.messageId
            ? {
                ...message,
                markdown: update.markdown,
                status: "streaming" as const,
                runError: undefined,
              }
            : message,
        ),
        run: { ...conversation.run, status: "streaming" as const },
      };
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { ...state, conversations };
}

interface OptimisticComposerSend {
  baselineMessageIds: Set<string>;
  contexts: ContextSnapshot[];
  conversationId: string;
  createdAt: string;
  requestId: string;
  text: string;
}

function hasAuthoritativeUserMessage(
  conversation: Conversation,
  optimistic: OptimisticComposerSend,
) {
  return conversation.messages.some(
    (message) =>
      message.role === "user" &&
      (message.clientRequestId === optimistic.requestId ||
        (!optimistic.baselineMessageIds.has(message.id) &&
          message.markdown === optimistic.text.trim())),
  );
}

function reconcileOptimisticSends(current: Map<string, OptimisticComposerSend>, state: AppState) {
  let next: Map<string, OptimisticComposerSend> | undefined;
  for (const [conversationId, optimistic] of current) {
    const conversation = state.conversations.find((item) => item.id === conversationId);
    if (conversation && !hasAuthoritativeUserMessage(conversation, optimistic)) continue;
    next ??= new Map(current);
    next.delete(conversationId);
  }
  return next ?? current;
}

function withOptimisticUserMessage(
  conversation: Conversation,
  optimistic: OptimisticComposerSend | undefined,
) {
  if (
    !optimistic ||
    optimistic.conversationId !== conversation.id ||
    hasAuthoritativeUserMessage(conversation, optimistic)
  ) {
    return conversation;
  }
  const message: ConversationMessage = {
    id: `optimistic-user:${optimistic.requestId}`,
    clientRequestId: optimistic.requestId,
    role: "user",
    markdown: optimistic.text.trim(),
    status: "complete",
    createdAt: optimistic.createdAt,
    ...(optimistic.contexts.length > 0 ? { contexts: optimistic.contexts } : {}),
  };
  return { ...conversation, messages: [...conversation.messages, message] };
}

export function App() {
  const [appState, setAppState] = useState<AppState | undefined>(readInitialAppState);
  const appStateRef = useRef<AppState | undefined>(appState);
  const authoritativeStateRevisionRef = useRef(0);
  const hiddenGenerationUpdatesRef = useRef(new Map<string, GenerationViewUpdate>());
  const [optimisticSends, setOptimisticSends] = useState(
    () => new Map<string, OptimisticComposerSend>(),
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [composerFocusRevision, setComposerFocusRevision] = useState(0);
  const [pendingNewConversationSourceId, setPendingNewConversationSourceId] = useState<string>();
  const pendingNewConversationSourceIdRef = useRef<string | undefined>(undefined);
  const [notice, setNotice] = useState<{ level: string; message: string }>();
  const [sendResults, setSendResults] = useState<
    Array<{ accepted: boolean; conversationId: string; requestId: string; revision: number }>
  >([]);
  const sendResultRevisionRef = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const historyTriggerRef = useRef<HTMLButtonElement>(null);
  const pendingConversationFocusIdRef = useRef<string | undefined>(undefined);
  const noticeTimerRef = useRef<number | undefined>(undefined);
  const conversationScrollMemoryRef = useRef(new Map<string, ConversationScrollState>());
  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    queueMicrotask(() => historyTriggerRef.current?.focus());
  }, []);
  const acceptSend = useCallback(() => setContextOpen(false), []);
  const toggleContext = useCallback(() => setContextOpen((value) => !value), []);
  const startNewConversation = useCallback((sourceConversationId: string) => {
    if (pendingNewConversationSourceIdRef.current) return;
    pendingNewConversationSourceIdRef.current = sourceConversationId;
    setPendingNewConversationSourceId(sourceConversationId);
    setHistoryOpen(false);
    setContextOpen(false);
    postMessage({ type: "newConversation", sourceConversationId });
  }, []);
  const selectConversation = useCallback((conversationId: string) => {
    setHistoryOpen(false);
    setContextOpen(false);
    if (appStateRef.current?.activeConversationId === conversationId) {
      pendingConversationFocusIdRef.current = undefined;
      setComposerFocusRevision((revision) => revision + 1);
      return;
    }
    pendingConversationFocusIdRef.current = conversationId;
    postMessage({ type: "selectConversation", conversationId });
  }, []);
  const beginOptimisticSend = useCallback((optimistic: OptimisticComposerSend) => {
    setOptimisticSends((current) => {
      const next = new Map(current);
      next.set(optimistic.conversationId, optimistic);
      return next;
    });
  }, []);
  const rejectOptimisticSend = useCallback((conversationId: string, requestId: string) => {
    setOptimisticSends((current) => {
      const optimistic = current.get(conversationId);
      if (!optimistic || optimistic.requestId !== requestId) return current;
      const next = new Map(current);
      next.delete(conversationId);
      return next;
    });
  }, []);

  useEffect(() => {
    const commitGenerationUpdates = (updates: GenerationViewUpdate[], urgent = false) => {
      if (updates.length === 0) return;
      const authoritativeRevision = authoritativeStateRevisionRef.current;
      const commit = () => {
        setAppState((current) => {
          if (!current || authoritativeStateRevisionRef.current !== authoritativeRevision) {
            return current;
          }
          const next = updates.reduce(applyGenerationUpdate, current);
          appStateRef.current = next;
          return next;
        });
      };
      if (urgent) commit();
      else startTransition(commit);
    };
    const restoreHiddenGenerations = () => {
      if (document.visibilityState !== "visible") return;
      const updates = [...hiddenGenerationUpdatesRef.current.values()];
      hiddenGenerationUpdatesRef.current.clear();
      // A retained webview may have been suspended while its sidebar was
      // hidden. Commit the newest compact frame synchronously on restoration;
      // a newer authoritative state still wins through the revision guard.
      commitGenerationUpdates(updates, true);
    };
    const dispose = onHostMessage((message) => {
      if (message.type === "state") {
        // State is atomic. Ignore an incomplete migration/initialization frame
        // as a whole: accepting only its revision boundary would discard
        // hidden generation updates even though the complete rendered frame is
        // deliberately retained.
        if (!hasActiveConversation(message.state)) return;
        // Full state carries authoritative send acceptance, context hand-off,
        // terminal status and rollback. The Extension Host already coalesces
        // these snapshots, so a dense Markdown stream must not starve them.
        authoritativeStateRevisionRef.current += 1;
        hiddenGenerationUpdatesRef.current.clear();
        appStateRef.current = message.state;
        setAppState(message.state);
        setOptimisticSends((current) => reconcileOptimisticSends(current, message.state));
      }
      if (message.type === "generationUpdate") {
        if (document.visibilityState !== "visible") {
          hiddenGenerationUpdatesRef.current.set(
            `${message.update.conversationId}:${message.update.messageId}`,
            message.update,
          );
        } else {
          commitGenerationUpdates([message.update]);
        }
      }
      if (message.type === "notice") {
        setNotice({ level: message.level, message: message.message });
        if (noticeTimerRef.current !== undefined) {
          window.clearTimeout(noticeTimerRef.current);
        }
        noticeTimerRef.current = window.setTimeout(() => {
          noticeTimerRef.current = undefined;
          setNotice(undefined);
        }, 2600);
      }
      if (message.type === "focusComposer") {
        setHistoryOpen(false);
        setContextOpen(false);
        setComposerFocusRevision((revision) => revision + 1);
      }
      if (message.type === "sendResult") {
        const revision = ++sendResultRevisionRef.current;
        setSendResults((current) => [
          ...current.slice(-31),
          {
            accepted: message.accepted,
            conversationId: message.conversationId,
            requestId: message.requestId,
            revision,
          },
        ]);
      }
    });
    document.addEventListener("visibilitychange", restoreHiddenGenerations);
    return () => {
      dispose();
      document.removeEventListener("visibilitychange", restoreHiddenGenerations);
      hiddenGenerationUpdatesRef.current.clear();
      if (noticeTimerRef.current !== undefined) {
        window.clearTimeout(noticeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    postMessage({ type: "ready" });
  }, []);

  useEffect(() => {
    const handleNewConversationShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.altKey ||
        event.shiftKey ||
        (!event.ctrlKey && !event.metaKey) ||
        event.key.toLowerCase() !== "n"
      ) {
        return;
      }
      const state = appStateRef.current;
      if (!state || !hasActiveConversation(state)) return;
      event.preventDefault();
      startNewConversation(state.activeConversationId);
    };
    window.addEventListener("keydown", handleNewConversationShortcut);
    return () => window.removeEventListener("keydown", handleNewConversationShortcut);
  }, [startNewConversation]);

  useEffect(() => {
    if (composerFocusRevision === 0) return;
    queueMicrotask(() => composerRef.current?.focus());
  }, [composerFocusRevision]);

  useEffect(() => {
    setContextOpen(false);
  }, [appState?.activeConversationId]);

  useEffect(() => {
    if (
      pendingNewConversationSourceId &&
      appState?.activeConversationId !== pendingNewConversationSourceId
    ) {
      pendingNewConversationSourceIdRef.current = undefined;
      setPendingNewConversationSourceId(undefined);
      setComposerFocusRevision((revision) => revision + 1);
    }
  }, [appState?.activeConversationId, pendingNewConversationSourceId]);

  useEffect(() => {
    const requestedId = pendingConversationFocusIdRef.current;
    if (!requestedId || appState?.activeConversationId !== requestedId) return;
    pendingConversationFocusIdRef.current = undefined;
    setComposerFocusRevision((revision) => revision + 1);
  }, [appState?.activeConversationId]);

  useEffect(() => {
    if (!pendingNewConversationSourceId) return;
    const timer = window.setTimeout(() => {
      pendingNewConversationSourceIdRef.current = undefined;
      setPendingNewConversationSourceId(undefined);
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [pendingNewConversationSourceId]);

  const connectionMode = getConnectionMode(appState?.backend.connection.phase ?? "starting");
  const showConnectionNotice = useStableConnectionNotice(connectionMode);
  const preserveReadyComposer = useReadyComposerGrace(
    appState?.backend.connection.phase ?? "starting",
    showConnectionNotice,
  );

  if (!appState) return <LoadingShell />;

  const active = appState.conversations.find(
    (conversation) => conversation.id === appState.activeConversationId,
  );
  // selectRenderableState guarantees this. Keeping the guard local also
  // protects production bundles from malformed extension-host messages
  // without ever clearing a previously rendered frame.
  if (!active) return <LoadingShell />;
  const activeOptimisticSend = optimisticSends.get(active.id);
  const t = strings[appState.locale];
  const newConversationPending = pendingNewConversationSourceId === active.id;
  const presentedActive: Conversation = newConversationPending
    ? {
        id: active.id,
        title: t.newConversation,
        createdAt: active.createdAt,
        updatedAt: active.updatedAt,
        messages: [],
      }
    : active;
  const renderedActive = withOptimisticUserMessage(
    presentedActive,
    newConversationPending ? undefined : activeOptimisticSend,
  );
  const homeVisible = !hasVisibleConversationMessages(renderedActive);
  const connection = getConnectionPresentation(appState);
  const backendReady = appState.backend.connection.phase === "ready";

  return (
    <div className="app-shell">
      <Header
        conversation={presentedActive}
        historyOpen={historyOpen}
        historyTriggerRef={historyTriggerRef}
        onHistory={() => setHistoryOpen((value) => !value)}
        onNew={() => startNewConversation(active.id)}
        historyLabel={t.history}
        newLabel={t.newConversation}
      />

      {showConnectionNotice && <ConnectionNotice presentation={connection} state={appState} />}

      <main
        aria-busy={newConversationPending || Boolean(active.run) || Boolean(activeOptimisticSend)}
        aria-label={t.transcript}
        className="message-scroll"
      >
        {homeVisible ? (
          <HomeState
            activeId={active.id}
            conversations={appState.conversations}
            key={`home:${renderedActive.id}`}
            locale={appState.locale}
            onSelect={selectConversation}
            onViewAll={() => setHistoryOpen(true)}
          />
        ) : (
          <MessageList
            conversation={renderedActive}
            key={`thread:${renderedActive.id}`}
            locale={appState.locale}
            scrollMemory={conversationScrollMemoryRef.current}
          />
        )}
      </main>
      <Composer
        conversations={appState.conversations}
        conversation={presentedActive}
        composerPreferences={appState.composerPreferences}
        inputRef={composerRef}
        locale={appState.locale}
        contexts={newConversationPending ? [] : getPendingContexts(appState)}
        automaticContextIds={newConversationPending ? [] : appState.automaticContextIds}
        contextLocked={newConversationPending || appState.contextLocked}
        contextOpen={contextOpen}
        focusRequestRevision={composerFocusRevision}
        backendReady={backendReady}
        preserveReadyPresentation={preserveReadyComposer}
        connection={connection}
        onAccepted={acceptSend}
        onOptimisticSend={beginOptimisticSend}
        onOptimisticRejected={rejectOptimisticSend}
        onContextToggle={toggleContext}
        dispatchingConversationIds={appState.dispatchingConversationIds ?? []}
        sendResults={sendResults}
        modelPicker={appState.modelPicker}
        newConversationPending={newConversationPending}
      />

      {historyOpen && (
        <HistoryPanel
          activeId={active.id}
          conversations={appState.conversations}
          dispatchingConversationIds={appState.dispatchingConversationIds ?? []}
          locale={appState.locale}
          onClose={closeHistory}
          onSelect={selectConversation}
        />
      )}

      {notice && (
        <div
          aria-live="assertive"
          className={`toast toast--${notice.level}`}
          role={notice.level === "error" ? "alert" : "status"}
        >
          {notice.message}
        </div>
      )}
    </div>
  );
}

type ConnectionMode = "hidden" | "progress" | "error";

function getConnectionMode(phase: ConnectionPhase): ConnectionMode {
  if (phase === "ready") return "hidden";
  if (
    phase === "starting" ||
    phase === "authenticating" ||
    phase === "syncing" ||
    phase === "reconnecting"
  ) {
    return "progress";
  }
  return "error";
}

function useStableConnectionNotice(mode: ConnectionMode) {
  const [visible, setVisible] = useState(mode === "error");

  useEffect(() => {
    if (mode === "hidden") {
      setVisible(false);
      return;
    }
    if (mode === "error" || visible) {
      setVisible(true);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), 800);
    return () => window.clearTimeout(timer);
  }, [mode, visible]);

  return visible;
}

function useReadyComposerGrace(phase: ConnectionPhase, connectionNoticeVisible: boolean) {
  const [hasSeenReady, setHasSeenReady] = useState(phase === "ready");

  useEffect(() => {
    if (phase === "ready") setHasSeenReady(true);
  }, [phase]);

  return (
    hasSeenReady && !connectionNoticeVisible && (phase === "reconnecting" || phase === "syncing")
  );
}

function LoadingShell() {
  return (
    <div aria-busy="true" aria-label="Loading Ask2GPT" className="app-shell app-shell--loading">
      <header className="app-header">
        <div className="conversation-toolbar">
          <span className="loading-line loading-line--title" />
        </div>
      </header>
      <main className="message-scroll" />
      <footer className="composer-region">
        <div className="composer loading-composer" />
      </footer>
    </div>
  );
}

function getPendingContexts(state: AppState): ContextSnapshot[] {
  return state.pendingContexts;
}

function getMessageContexts(message: ConversationMessage): ContextSnapshot[] {
  return message.contexts ?? [];
}

function visibleConversationMessages(conversation: Conversation) {
  return conversation.messages.filter((message) => message.role !== "local-notice");
}

function hasVisibleConversationMessages(conversation: Conversation) {
  return conversation.messages.some((message) => message.role !== "local-notice");
}

function userTurnScrollIdentity(message: ConversationMessage) {
  return message.clientRequestId ?? message.id;
}

function messageContextsEqual(previous: ConversationMessage, next: ConversationMessage) {
  return previous.contexts === next.contexts;
}

function contextKey(context: ContextSnapshot) {
  return context.id;
}

function contextChipTitle(context: ContextSnapshot) {
  if (context.kind !== "selection") return context.fileName;
  const compact = context.content.replace(/\s+/gu, " ").trim();
  if (!compact) return context.fileName;
  const excerpt = compact.length > 96 ? `${compact.slice(0, 95)}…` : compact;
  return `“${excerpt}”`;
}

function contextDeliveryModes(contexts: readonly ContextSnapshot[]) {
  let inlineChars = 0;
  return new Map(
    contexts.map((context) => {
      const inline =
        context.content.length <= MAX_INLINE_CONTEXT_CHARS &&
        inlineChars + context.content.length <= MAX_INLINE_CONTEXT_BUNDLE_CHARS;
      if (inline) inlineChars += context.content.length;
      return [context.id, inline ? "inline" : "file"] as const;
    }),
  );
}

function Header({
  conversation,
  historyTriggerRef,
  historyOpen,
  onHistory,
  onNew,
  historyLabel,
  newLabel,
}: {
  conversation: Conversation;
  historyTriggerRef: React.RefObject<HTMLButtonElement | null>;
  historyOpen: boolean;
  onHistory: () => void;
  onNew: () => void;
  historyLabel: string;
  newLabel: string;
}) {
  return (
    <header className="app-header">
      <div className="conversation-toolbar">
        <h1 className="conversation-heading" title={conversation.title}>
          <button
            aria-expanded={historyOpen}
            aria-haspopup="dialog"
            aria-label={`${conversation.title} · ${historyLabel}`}
            className="conversation-heading__trigger"
            onClick={onHistory}
            ref={historyTriggerRef}
            title={historyLabel}
            type="button"
          >
            <HistoryIcon className="conversation-heading__history-icon" />
            <span className="title-text" key={conversation.id}>
              {conversation.title}
            </span>
            <ChevronIcon className="conversation-heading__chevron" />
          </button>
        </h1>
        <div className="header-actions">
          <IconButton label={newLabel} onClick={onNew}>
            <PlusIcon />
          </IconButton>
        </div>
      </div>
    </header>
  );
}

type ConnectionTone = "working" | "error";
type ConnectionAction = "retry-connection" | "open-chatgpt";

interface ConnectionPresentation {
  action?: ConnectionAction;
  actionLabel?: string;
  composerHint: string;
  detail: string;
  phase: ConnectionPhase;
  title: string;
  tone: ConnectionTone;
}

function getConnectionPresentation(state: AppState): ConnectionPresentation {
  const t = strings[state.locale];
  const phase = state.backend.connection.phase;
  const errorCode = state.backend.connection.errorCode ?? state.backend.error?.code;
  const base = { phase } as const;

  switch (phase) {
    case "starting":
      return {
        ...base,
        composerHint: t.composerWaitingForConnection,
        detail: t.directConnectionStartingDetail,
        title: t.directConnectionStartingTitle,
        tone: "working",
      };
    case "waiting-for-browser":
      return {
        ...base,
        action: "retry-connection",
        actionLabel: t.checkAgain,
        composerHint: t.composerWaitingForBrowser,
        detail: t.directBrowserUnavailableDetail,
        title: t.directBrowserUnavailableTitle,
        tone: "error",
      };
    case "pairing-required":
      return {
        ...base,
        action: "retry-connection",
        actionLabel: t.reconnect,
        composerHint: t.composerWaitingForConnection,
        detail: t.directConnectionRefreshDetail,
        title: t.directConnectionRefreshTitle,
        tone: "error",
      };
    case "authenticating":
      return {
        ...base,
        composerHint: t.composerAuthenticating,
        detail: t.directConnectionStartingDetail,
        title: t.directConnectionStartingTitle,
        tone: "working",
      };
    case "syncing":
      return {
        ...base,
        composerHint: t.composerSyncing,
        detail: t.directSyncingDetail,
        title: t.directSyncingTitle,
        tone: "working",
      };
    case "project-required":
      return {
        ...base,
        action: "open-chatgpt",
        actionLabel: t.openChatGptProject,
        composerHint: t.projectComposerBlocked,
        detail: t.projectInstruction,
        title: t.projectRequiredTitle,
        // The loopback transport is already healthy here. Present Project
        // setup as a distinct, non-error step so users do not keep trying to
        // repair a connection that is already established.
        tone: "working",
      };
    case "ready":
      return {
        ...base,
        composerHint: t.noAgent,
        detail: t.connectionReadyDetail,
        title: t.connectionReady,
        tone: "working",
      };
    case "reconnecting":
      return {
        ...base,
        composerHint: t.composerReconnecting,
        detail: t.directReconnectingDetail,
        title: t.directReconnectingTitle,
        tone: "working",
      };
    case "version-mismatch":
      return {
        ...base,
        action: "retry-connection",
        actionLabel: t.checkAgain,
        composerHint: t.composerVersionMismatch,
        detail: t.versionMismatchDetail,
        title: t.versionMismatchTitle,
        tone: "error",
      };
    case "trust-mismatch":
      return {
        ...base,
        action: "retry-connection",
        actionLabel: t.reconnect,
        composerHint: t.composerTrustMismatch,
        detail: t.directConnectionRefreshDetail,
        title: t.directConnectionRefreshTitle,
        tone: "error",
      };
    case "local-server-error":
      return {
        ...base,
        action: "retry-connection",
        actionLabel: t.checkAgain,
        composerHint: t.composerLocalServerError,
        detail: t.localServerErrorDetail,
        title: t.localServerErrorTitle,
        tone: "error",
      };
    case "attention": {
      const loginRequired = errorCode === "CHATGPT_LOGIN_REQUIRED";
      const projectMismatch = errorCode === "CHATGPT_PROJECT_MISMATCH";
      return {
        ...base,
        action: "open-chatgpt",
        actionLabel: loginRequired
          ? t.openLoginPage
          : projectMismatch
            ? t.openChatGptProject
            : t.goHandleInChatGpt,
        composerHint: t.composerAttention,
        detail: loginRequired
          ? t.loginRequiredDetail
          : projectMismatch
            ? t.projectMismatchDetail
            : t.attentionDetail,
        title: loginRequired
          ? t.loginRequiredTitle
          : projectMismatch
            ? t.projectMismatchTitle
            : t.attentionTitle,
        tone: "error",
      };
    }
  }
}

function ConnectionNotice({
  presentation,
  state,
}: {
  presentation: ConnectionPresentation;
  state: AppState;
}) {
  const t = strings[state.locale];
  const connection = state.backend.connection;
  const titleId = `connection-title-${presentation.phase}`;

  const runPrimaryAction = () => {
    switch (presentation.action) {
      case "retry-connection":
        postMessage({ type: "retryConnection" });
        return;
      case "open-chatgpt":
        postMessage({ type: "openChatGpt" });
        return;
    }
  };

  return (
    <section
      aria-labelledby={titleId}
      className={`connection-center connection-center--${presentation.tone}`}
      role={presentation.tone === "error" ? "alert" : "status"}
    >
      <div className="connection-center__summary">
        <span
          aria-hidden="true"
          className={`connection-center__glyph connection-center__glyph--${presentation.tone}`}
        />
        <div className="connection-center__copy">
          <strong id={titleId}>{presentation.title}</strong>
          <p>{presentation.detail}</p>
        </div>
        {presentation.action && presentation.actionLabel && (
          <button className="connection-primary-action" onClick={runPrimaryAction}>
            {presentation.actionLabel}
          </button>
        )}
      </div>

      {presentation.tone === "error" && (
        <details className="connection-details">
          <summary>{t.technicalDetails}</summary>
          <dl>
            <div>
              <dt>{t.connectionPhase}</dt>
              <dd>{presentation.phase}</dd>
            </div>
            <div>
              <dt>{t.chromeCompanion}</dt>
              <dd>{connection.browserDetected ? t.detected : t.notDetected}</dd>
            </div>
            {state.backend.port !== undefined && (
              <div>
                <dt>{t.localPort}</dt>
                <dd>{state.backend.port}</dd>
              </div>
            )}
            <div>
              <dt>{t.hostVersion}</dt>
              <dd>{connection.hostVersion ?? t.notAvailable}</dd>
            </div>
            <div>
              <dt>{t.relayVersion}</dt>
              <dd>{connection.relayVersion ?? t.notAvailable}</dd>
            </div>
            <div>
              <dt>{t.protocol}</dt>
              <dd>
                {connection.protocolVersion === undefined
                  ? t.notAvailable
                  : `ask2gpt.v${connection.protocolVersion}`}
              </dd>
            </div>
            {connection.detectedProtocol && (
              <div>
                <dt>{t.detectedProtocol}</dt>
                <dd>{connection.detectedProtocol}</dd>
              </div>
            )}
            {connection.errorCode && (
              <div>
                <dt>{t.errorCode}</dt>
                <dd>{connection.errorCode}</dd>
              </div>
            )}
            <div>
              <dt>{t.lastConnected}</dt>
              <dd>
                {connection.lastConnectedAt
                  ? formatDate(connection.lastConnectedAt, state.locale)
                  : t.notAvailable}
              </dd>
            </div>
            {state.backend.error?.message && (
              <div>
                <dt>{t.errorDetail}</dt>
                <dd>{state.backend.error.message}</dd>
              </div>
            )}
          </dl>
          <div className="connection-details__actions">
            <button onClick={() => postMessage({ type: "copyDiagnostics" })}>
              {t.copyDiagnostics}
            </button>
          </div>
        </details>
      )}
    </section>
  );
}

function HomeState({
  activeId,
  conversations,
  locale,
  onSelect,
  onViewAll,
}: {
  activeId: string;
  conversations: Conversation[];
  locale: AppState["locale"];
  onSelect: (conversationId: string) => void;
  onViewAll: () => void;
}) {
  const t = strings[locale];
  const history = conversations.filter(
    (conversation) =>
      !conversation.archivedAt &&
      conversation.id !== activeId &&
      hasVisibleConversationMessages(conversation),
  );
  const recent = history.slice(0, 3);
  return (
    <section
      aria-label={t.home}
      className="home-state conversation-view"
      data-conversation-id={activeId}
    >
      {recent.length > 0 ? (
        <div className="home-history">
          <h2 className="home-history__heading">{t.tasks}</h2>
          <div className="home-history__list" role="list">
            {recent.map((conversation) => (
              <div key={conversation.id} role="listitem">
                <button
                  className="home-history__row"
                  onClick={() => onSelect(conversation.id)}
                  type="button"
                >
                  <span>{conversation.title}</span>
                  <time dateTime={conversation.updatedAt}>
                    {formatRelativeTime(conversation.updatedAt, locale)}
                  </time>
                </button>
              </div>
            ))}
          </div>
          {history.length > recent.length && (
            <button className="home-history__all" onClick={onViewAll} type="button">
              {t.viewAll} ({history.length})
              <ChevronIcon />
            </button>
          )}
        </div>
      ) : null}
    </section>
  );
}

type ConversationScrollMode = "turn-anchor" | "tail-follow" | "detached";

interface ConversationScrollState {
  mode: ConversationScrollMode;
  top: number;
}

interface ScheduledScrollFollow {
  animationFrameId?: number;
  timeoutId?: number;
}

type UserScrollDirection = "away" | "toward" | "direct";

interface UserScrollIntent {
  direction: UserScrollDirection;
  lastAt: number;
}

const SCROLL_TAIL_THRESHOLD_PX = 24;
const SCROLL_FOLLOW_FALLBACK_MS = 48;
const USER_SCROLL_INTENT_TTL_MS = 1_000;
const USER_MESSAGE_NAVIGATION_MIN_ITEMS = 4;

function keyboardScrollDirection(
  event: KeyboardEvent,
  scroller: HTMLElement,
): Exclude<UserScrollDirection, "direct"> | undefined {
  if (event.defaultPrevented || event.repeat) return undefined;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    target !== scroller &&
    (target.isContentEditable ||
      target.closest("input, select, textarea") ||
      ((event.key === " " || event.key === "Spacebar") &&
        target.closest('button, [role="button"]')))
  ) {
    return undefined;
  }
  switch (event.key) {
    case "ArrowUp":
    case "Home":
    case "PageUp":
      return "away";
    case " ":
    case "Spacebar":
      return event.shiftKey ? "away" : "toward";
    case "ArrowDown":
    case "End":
    case "PageDown":
      return "toward";
    default:
      return undefined;
  }
}

function MessageList({
  conversation,
  locale,
  scrollMemory,
}: {
  conversation: Conversation;
  locale: AppState["locale"];
  scrollMemory: Map<string, ConversationScrollState>;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeConversationIdRef = useRef(conversation.id);
  const scrollModeRef = useRef<ConversationScrollMode>("tail-follow");
  const scheduledScrollFollowRef = useRef<ScheduledScrollFollow | undefined>(undefined);
  const lastProgrammaticTopRef = useRef<number | undefined>(undefined);
  const userScrollIntentRef = useRef<UserScrollIntent | undefined>(undefined);
  const lastTouchYRef = useRef<number | undefined>(undefined);
  const knownUserIdsRef = useRef(new Map<string, Set<string>>());
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const t = strings[locale];
  const visibleMessages = useMemo(
    () => visibleConversationMessages(conversation),
    [conversation.messages],
  );
  const userMessages = useMemo(
    () => visibleMessages.filter((message) => message.role === "user"),
    [visibleMessages],
  );
  const [activeUserMessageId, setActiveUserMessageId] = useState<string>();
  const visibleMessagesRef = useRef(visibleMessages);
  visibleMessagesRef.current = visibleMessages;
  const lastUserId = useMemo(
    () => [...visibleMessages].reverse().find((message) => message.role === "user")?.id,
    [visibleMessages],
  );
  const lastAssistantId = useMemo(
    () => [...visibleMessages].reverse().find((message) => message.role === "assistant")?.id,
    [visibleMessages],
  );
  const previousUserIds = useMemo(() => {
    const result = new Map<string, string | undefined>();
    let previousUserId: string | undefined;
    for (const message of visibleMessages) {
      result.set(message.id, previousUserId);
      if (message.role === "user") previousUserId = message.id;
    }
    return result;
  }, [visibleMessages]);
  const latestMessage = visibleMessages.at(-1);
  const latestAssistantBelongsToTurn = Boolean(
    lastAssistantId && previousUserIds.get(lastAssistantId) === lastUserId,
  );
  const hasActiveTurn =
    Boolean(conversation.run) ||
    (latestMessage?.role === "user" && latestMessage.id.startsWith("optimistic-user:"));
  const [runwayConversationId, setRunwayConversationId] = useState<string | undefined>(() =>
    hasActiveTurn ? conversation.id : undefined,
  );
  // Retain the live turn runway for one final layout pass so a short answer
  // does not jump when it settles. Completed history must not keep a permanent
  // viewport-sized spacer when the user returns later.
  useLayoutEffect(() => {
    if (hasActiveTurn) {
      setRunwayConversationId(conversation.id);
      return;
    }
    const timer = window.setTimeout(() => {
      setRunwayConversationId((current) => (current === conversation.id ? undefined : current));
    }, SCROLL_FOLLOW_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [conversation.id, hasActiveTurn]);
  const hasTurnRunway = runwayConversationId === conversation.id;
  const latestTurnRef = useRef({
    active: Boolean(conversation.run),
    lastUserId,
  });
  latestTurnRef.current = {
    active: Boolean(conversation.run),
    lastUserId,
  };

  const saveScrollState = useCallback(
    (scroller: HTMLElement, mode = scrollModeRef.current) => {
      scrollMemory.set(activeConversationIdRef.current, {
        mode,
        top: scroller.scrollTop,
      });
    },
    [scrollMemory],
  );

  const updateActiveUserMessage = useCallback((scroller: HTMLElement) => {
    const list = listRef.current;
    if (!list) return;
    const viewportTop = scroller.scrollTop + 32;
    let activeId: string | undefined;
    for (const element of list.querySelectorAll<HTMLElement>("[data-user-message-id]")) {
      const id = element.dataset.userMessageId;
      if (!id) continue;
      if (activeId === undefined || element.offsetTop <= viewportTop) activeId = id;
      if (element.offsetTop > viewportTop) break;
    }
    if (activeId) {
      setActiveUserMessageId((current) => (current === activeId ? current : activeId));
    }
  }, []);

  const applyScrollTop = useCallback(
    (scroller: HTMLElement, top: number, mode: ConversationScrollMode) => {
      scrollModeRef.current = mode;
      scroller.scrollTop = top;
      lastProgrammaticTopRef.current = scroller.scrollTop;
      saveScrollState(scroller, mode);
      setShowScrollToBottom(
        mode !== "tail-follow" &&
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight >
            SCROLL_TAIL_THRESHOLD_PX,
      );
    },
    [saveScrollState],
  );

  const anchorLatestTurn = useCallback(() => {
    const list = listRef.current;
    const scroller = list?.parentElement;
    const anchor = list?.querySelector<HTMLElement>('[data-turn-anchor="true"]');
    if (!scroller || !anchor) return;

    scrollModeRef.current = "turn-anchor";
    if (typeof anchor.scrollIntoView === "function") {
      anchor.scrollIntoView({ behavior: "auto", block: "start", inline: "nearest" });
    } else {
      scroller.scrollTop = Math.max(0, anchor.offsetTop - 18);
    }
    lastProgrammaticTopRef.current = scroller.scrollTop;
    saveScrollState(scroller, "turn-anchor");
    setShowScrollToBottom(
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > SCROLL_TAIL_THRESHOLD_PX,
    );
  }, [saveScrollState]);

  const jumpToUserMessage = useCallback(
    (messageId: string) => {
      const list = listRef.current;
      const scroller = list?.parentElement;
      const target = [
        ...(list?.querySelectorAll<HTMLElement>("[data-user-message-id]") ?? []),
      ].find((element) => element.dataset.userMessageId === messageId);
      if (!scroller || !target) return;
      scrollModeRef.current = "detached";
      setActiveUserMessageId(messageId);
      target.scrollIntoView({
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "start",
        inline: "nearest",
      });
      queueMicrotask(() => {
        saveScrollState(scroller, "detached");
        setShowScrollToBottom(
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight >
            SCROLL_TAIL_THRESHOLD_PX,
        );
      });
    },
    [saveScrollState],
  );

  useEffect(() => {
    const handleUserMessageNavigation = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
        document.querySelector('[aria-modal="true"]')
      ) {
        return;
      }
      const currentIndex = Math.max(
        0,
        userMessages.findIndex((message) => message.id === activeUserMessageId),
      );
      const nextIndex =
        event.key === "ArrowUp"
          ? Math.max(0, currentIndex - 1)
          : Math.min(userMessages.length - 1, currentIndex + 1);
      const nextMessage = userMessages[nextIndex];
      if (!nextMessage || nextIndex === currentIndex) return;
      event.preventDefault();
      jumpToUserMessage(nextMessage.id);
    };
    window.addEventListener("keydown", handleUserMessageNavigation);
    return () => window.removeEventListener("keydown", handleUserMessageNavigation);
  }, [activeUserMessageId, jumpToUserMessage, userMessages]);

  const cancelScheduledFollow = useCallback(() => {
    const scheduled = scheduledScrollFollowRef.current;
    if (!scheduled) return;
    scheduledScrollFollowRef.current = undefined;
    if (
      scheduled.animationFrameId !== undefined &&
      typeof window.cancelAnimationFrame === "function"
    ) {
      window.cancelAnimationFrame(scheduled.animationFrameId);
    }
    if (scheduled.timeoutId !== undefined) window.clearTimeout(scheduled.timeoutId);
  }, []);

  const scheduleFollowOutput = useCallback(() => {
    if (scheduledScrollFollowRef.current) return;
    const scheduled: ScheduledScrollFollow = {};
    scheduledScrollFollowRef.current = scheduled;
    const follow = () => {
      if (scheduledScrollFollowRef.current !== scheduled) return;
      cancelScheduledFollow();
      const scroller = listRef.current?.parentElement;
      if (!scroller) return;
      if (scrollModeRef.current === "tail-follow") {
        applyScrollTop(scroller, scroller.scrollHeight, "tail-follow");
        updateActiveUserMessage(scroller);
        return;
      }
      if (scrollModeRef.current === "turn-anchor" && latestTurnRef.current.active) {
        const latestAnswer = listRef.current?.querySelector<HTMLElement>(
          '[data-latest-assistant="true"] .assistant-markdown',
        );
        if (
          latestAnswer &&
          latestAnswer.getBoundingClientRect().bottom >
            scroller.getBoundingClientRect().bottom - SCROLL_TAIL_THRESHOLD_PX
        ) {
          applyScrollTop(scroller, scroller.scrollHeight, "tail-follow");
          updateActiveUserMessage(scroller);
          return;
        }
      }
      saveScrollState(scroller);
      updateActiveUserMessage(scroller);
      setShowScrollToBottom(
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight >
          SCROLL_TAIL_THRESHOLD_PX,
      );
    };
    if (typeof window.requestAnimationFrame === "function") {
      scheduled.animationFrameId = window.requestAnimationFrame(follow);
      // VS Code Webviews and Chrome throttle requestAnimationFrame while the
      // document is hidden. The timeout prevents a dormant frame from keeping
      // this scheduler latched and dropping every later streaming update.
      scheduled.timeoutId = window.setTimeout(follow, SCROLL_FOLLOW_FALLBACK_MS);
    } else {
      scheduled.timeoutId = window.setTimeout(follow, 0);
    }
  }, [applyScrollTop, cancelScheduledFollow, saveScrollState, updateActiveUserMessage]);

  useLayoutEffect(() => {
    cancelScheduledFollow();
    userScrollIntentRef.current = undefined;
    lastTouchYRef.current = undefined;
    activeConversationIdRef.current = conversation.id;
    knownUserIdsRef.current.set(
      conversation.id,
      new Set(
        visibleMessagesRef.current
          .filter((message) => message.role === "user")
          .map(userTurnScrollIdentity),
      ),
    );
    const scroller = listRef.current?.parentElement;
    if (!scroller) return;
    const saved = scrollMemory.get(conversation.id);
    if (saved) {
      applyScrollTop(scroller, saved.top, saved.mode);
    } else if (latestTurnRef.current.active && latestTurnRef.current.lastUserId) {
      anchorLatestTurn();
    } else {
      applyScrollTop(scroller, scroller.scrollHeight, "tail-follow");
    }
    updateActiveUserMessage(scroller);
  }, [
    anchorLatestTurn,
    applyScrollTop,
    cancelScheduledFollow,
    conversation.id,
    scrollMemory,
    updateActiveUserMessage,
  ]);

  useEffect(() => {
    setActiveUserMessageId((current) =>
      current && userMessages.some((message) => message.id === current)
        ? current
        : userMessages.at(-1)?.id,
    );
  }, [conversation.id, userMessages]);

  useLayoutEffect(() => {
    const knownUserIds = knownUserIdsRef.current.get(conversation.id) ?? new Set<string>();
    const nextUserMessages = visibleMessages.filter((message) => message.role === "user");
    const nextUserIds = nextUserMessages.map(userTurnScrollIdentity);
    const newUserMessages = nextUserMessages.filter(
      (message) => !knownUserIds.has(userTurnScrollIdentity(message)),
    );
    const hasNewUserTurn = newUserMessages.length > 0;
    const hasDirectOptimisticTurn = newUserMessages.some((message) =>
      message.id.startsWith("optimistic-user:"),
    );
    knownUserIdsRef.current.set(conversation.id, new Set(nextUserIds));
    // A queued follow-up can become the next user turn while the reader is
    // inspecting an earlier answer. Preserve that explicit reading lock;
    // only an attached/following viewport should move to the new turn.
    if (hasNewUserTurn && (scrollModeRef.current !== "detached" || hasDirectOptimisticTurn)) {
      anchorLatestTurn();
    }
  }, [anchorLatestTurn, conversation.id, visibleMessages]);

  useEffect(() => {
    const scroller = listRef.current?.parentElement;
    if (!scroller) return;
    const markUserIntent = (direction: UserScrollDirection) => {
      userScrollIntentRef.current = { direction, lastAt: Date.now() };
      cancelScheduledFollow();
      const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (direction !== "toward" || distanceFromBottom > SCROLL_TAIL_THRESHOLD_PX) {
        scrollModeRef.current = "detached";
        saveScrollState(scroller, "detached");
      }
      setShowScrollToBottom(
        scrollModeRef.current !== "tail-follow" && distanceFromBottom > SCROLL_TAIL_THRESHOLD_PX,
      );
    };
    const updateScrollState = () => {
      updateActiveUserMessage(scroller);
      const intent = userScrollIntentRef.current;
      const hasCurrentUserIntent =
        intent !== undefined && Date.now() - intent.lastAt <= USER_SCROLL_INTENT_TTL_MS;
      if (
        !hasCurrentUserIntent &&
        lastProgrammaticTopRef.current !== undefined &&
        Math.abs(scroller.scrollTop - lastProgrammaticTopRef.current) <= 1
      ) {
        lastProgrammaticTopRef.current = undefined;
        saveScrollState(scroller);
        return;
      }
      lastProgrammaticTopRef.current = undefined;
      const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (hasCurrentUserIntent) {
        intent.lastAt = Date.now();
        scrollModeRef.current =
          distanceFromBottom <= SCROLL_TAIL_THRESHOLD_PX ? "tail-follow" : "detached";
      }
      saveScrollState(scroller);
      setShowScrollToBottom(
        scrollModeRef.current !== "tail-follow" && distanceFromBottom > SCROLL_TAIL_THRESHOLD_PX,
      );
    };
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      markUserIntent(event.deltaY < 0 ? "away" : "toward");
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.target === scroller) markUserIntent("direct");
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const direction = keyboardScrollDirection(event, scroller);
      if (direction) markUserIntent(direction);
    };
    const handleTouchStart = (event: TouchEvent) => {
      lastTouchYRef.current = event.touches.length === 1 ? event.touches[0]?.clientY : undefined;
    };
    const handleTouchMove = (event: TouchEvent) => {
      const previousY = lastTouchYRef.current;
      const nextY = event.touches.length === 1 ? event.touches[0]?.clientY : undefined;
      lastTouchYRef.current = nextY;
      if (previousY === undefined || nextY === undefined || Math.abs(nextY - previousY) < 8) return;
      markUserIntent(nextY > previousY ? "away" : "toward");
    };
    const clearTouch = () => {
      lastTouchYRef.current = undefined;
    };
    scroller.addEventListener("wheel", handleWheel, { passive: true });
    scroller.addEventListener("pointerdown", handlePointerDown, { passive: true });
    scroller.addEventListener("keydown", handleKeyDown);
    scroller.addEventListener("touchstart", handleTouchStart, { passive: true });
    scroller.addEventListener("touchmove", handleTouchMove, { passive: true });
    scroller.addEventListener("touchend", clearTouch, { passive: true });
    scroller.addEventListener("touchcancel", clearTouch, { passive: true });
    scroller.addEventListener("scroll", updateScrollState, { passive: true });
    return () => {
      scroller.removeEventListener("wheel", handleWheel);
      scroller.removeEventListener("pointerdown", handlePointerDown);
      scroller.removeEventListener("keydown", handleKeyDown);
      scroller.removeEventListener("touchstart", handleTouchStart);
      scroller.removeEventListener("touchmove", handleTouchMove);
      scroller.removeEventListener("touchend", clearTouch);
      scroller.removeEventListener("touchcancel", clearTouch);
      scroller.removeEventListener("scroll", updateScrollState);
    };
  }, [cancelScheduledFollow, conversation.id, saveScrollState, updateActiveUserMessage]);

  useEffect(() => {
    scheduleFollowOutput();
  }, [
    visibleMessages.length,
    conversation.messages.at(-1)?.markdown,
    conversation.messages.at(-1)?.status,
    scheduleFollowOutput,
  ]);

  useEffect(() => {
    const list = listRef.current;
    const scroller = list?.parentElement;
    if (!list || !scroller) return;
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleFollowOutput);
    observer?.observe(list);
    // The composer lives in the adjacent grid row. Its height changes resize
    // the transcript without resizing the message list, so observe the scroll
    // viewport as well to keep a followed tail visible above the footer.
    observer?.observe(scroller);
    window.addEventListener("resize", scheduleFollowOutput);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", scheduleFollowOutput);
    };
  }, [conversation.id, scheduleFollowOutput]);

  useEffect(() => () => cancelScheduledFollow(), [cancelScheduledFollow]);

  return (
    <>
      {userMessages.length >= USER_MESSAGE_NAVIGATION_MIN_ITEMS && (
        <nav aria-label={t.userMessages} className="user-message-navigation">
          {userMessages.map((message, index) => {
            const preview = message.markdown.replace(/\s+/gu, " ").trim() || t.yourQuestion;
            const compactPreview = preview.length > 96 ? `${preview.slice(0, 95)}…` : preview;
            return (
              <button
                aria-current={message.id === activeUserMessageId ? "true" : undefined}
                aria-label={`${t.jumpToQuestion} ${index + 1}: ${compactPreview}`}
                className="user-message-navigation__item"
                key={message.id}
                onClick={() => jumpToUserMessage(message.id)}
                title={compactPreview}
                type="button"
              >
                <span aria-hidden="true" className="user-message-navigation__marker" />
              </button>
            );
          })}
        </nav>
      )}
      <div
        className="message-list conversation-view"
        data-conversation-id={conversation.id}
        ref={listRef}
      >
        {visibleMessages.map((message) => {
          return (
            <MessageCard
              conversationId={conversation.id}
              isLatestAssistant={message.id === lastAssistantId}
              key={message.id}
              locale={locale}
              message={message}
              reserveTurnViewport={
                hasTurnRunway && latestAssistantBelongsToTurn && message.id === lastAssistantId
              }
              turnAnchor={message.id === lastUserId}
            />
          );
        })}
        {hasActiveTurn && !latestAssistantBelongsToTurn && (
          <div aria-hidden="true" className="turn-runway-temporary" />
        )}
      </div>
      {showScrollToBottom && (
        <button
          className="scroll-to-bottom"
          onClick={() => {
            const scroller = listRef.current?.parentElement;
            if (scroller) {
              applyScrollTop(scroller, scroller.scrollHeight, "tail-follow");
            }
            setShowScrollToBottom(false);
          }}
          type="button"
        >
          <ChevronIcon />
          <span>{t.scrollToBottom}</span>
        </button>
      )}
    </>
  );
}

interface MessageCardProps {
  conversationId: string;
  isLatestAssistant: boolean;
  locale: AppState["locale"];
  message: ConversationMessage;
  reserveTurnViewport: boolean;
  turnAnchor: boolean;
}

function useSmoothedStreamingMarkdown(content: string, streaming: boolean) {
  const [visible, setVisible] = useState(content);
  const visibleRef = useRef(content);
  const shouldAnimate =
    streaming &&
    document.visibilityState === "visible" &&
    !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    if (!shouldAnimate || !content.startsWith(visibleRef.current)) {
      visibleRef.current = content;
      setVisible(content);
      return;
    }
    if (visibleRef.current === content) return;

    let cancelled = false;
    let animationFrameId: number | undefined;
    let timeoutId: number | undefined;
    const step = streamingMarkdownFrameStep(visibleRef.current, content);
    const tick = () => {
      animationFrameId = undefined;
      timeoutId = undefined;
      if (cancelled) return;
      const next = nextStreamingMarkdown(visibleRef.current, content, step);
      visibleRef.current = next;
      setVisible(next);
      if (next !== content) schedule();
    };
    const schedule = () => {
      if (typeof window.requestAnimationFrame === "function") {
        animationFrameId = window.requestAnimationFrame(tick);
      } else {
        timeoutId = window.setTimeout(tick, 16);
      }
    };
    schedule();

    return () => {
      cancelled = true;
      if (animationFrameId !== undefined) window.cancelAnimationFrame(animationFrameId);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [content, shouldAnimate]);

  return shouldAnimate && content.startsWith(visible) ? visible : content;
}

const MessageCard = memo(function MessageCard({
  conversationId,
  isLatestAssistant,
  locale,
  message,
  reserveTurnViewport,
  turnAnchor,
}: MessageCardProps) {
  const t = strings[locale];
  const displayMarkdown = useSmoothedStreamingMarkdown(
    message.markdown,
    message.role === "assistant" && message.status === "streaming",
  );

  if (message.role === "user") {
    const contexts = getMessageContexts(message);
    return (
      <article
        aria-label={t.yourQuestion}
        className="message message--user"
        data-turn-anchor={turnAnchor ? "true" : undefined}
        data-user-message-id={message.id}
      >
        {contexts.length > 0 && (
          <SentContextList contexts={contexts} conversationId={conversationId} locale={locale} />
        )}
        <div className="user-copy">{message.markdown}</div>
        <div className="message-actions message-actions--user">
          <IconButton
            label={copyLabel[locale]}
            onClick={() => postMessage({ type: "copy", text: message.markdown })}
          >
            <CopyIcon />
          </IconButton>
        </div>
      </article>
    );
  }

  const visibleRunError = message.status === "error" ? message.runError : undefined;
  const errorStatus = visibleRunError
    ? visibleRunError.recoverable
      ? message.markdown
        ? t.answerInterrupted
        : t.answerMissing
      : t.failed
    : message.status === "error"
      ? t.failed
      : undefined;
  const recoverableError = Boolean(visibleRunError?.recoverable);
  const retry = () =>
    postMessage({
      type: "regenerate",
      conversationId,
      messageId: message.id,
    });

  return (
    <article
      aria-label={t.answer}
      className={`message message--assistant message--${message.status} ${
        reserveTurnViewport ? "message--latest-turn" : ""
      }`}
      data-latest-assistant={isLatestAssistant ? "true" : undefined}
    >
      <div className="assistant-markdown">
        {displayMarkdown ? (
          <Markdown
            content={displayMarkdown}
            locale={locale}
            streaming={message.status === "streaming"}
          />
        ) : message.status === "streaming" ? (
          <div aria-hidden="true" className="thinking-line">
            <span />
            <span />
            <span />
          </div>
        ) : null}
        {message.status === "streaming" && displayMarkdown && <span className="stream-cursor" />}
      </div>
      {errorStatus && (
        <div className="message-error-row" role="alert">
          <div className="message-error-row__copy">
            <strong>{errorStatus}</strong>
            {visibleRunError && (
              <details>
                <summary>{t.technicalDetails}</summary>
                <span>{visibleRunError.message}</span>
                <code>{visibleRunError.code}</code>
              </details>
            )}
          </div>
          {isLatestAssistant && recoverableError && (
            <button className="message-retry" onClick={retry} type="button">
              {t.retry}
            </button>
          )}
        </div>
      )}
      {message.status !== "streaming" && (
        <div className="message-actions">
          {message.markdown.length > 0 && (
            <IconButton
              label={copyLabel[locale]}
              onClick={() => postMessage({ type: "copy", text: message.markdown })}
            >
              <CopyIcon />
            </IconButton>
          )}
          {isLatestAssistant && !recoverableError && (
            <IconButton label={t.regenerate} onClick={retry}>
              <RefreshIcon />
            </IconButton>
          )}
          {message.status === "stopped" && (
            <span className="message-status message-status--stopped">{t.stopped}</span>
          )}
        </div>
      )}
    </article>
  );
}, areMessageCardsEqual);

function areMessageCardsEqual(previous: MessageCardProps, next: MessageCardProps) {
  return (
    previous.conversationId === next.conversationId &&
    previous.isLatestAssistant === next.isLatestAssistant &&
    previous.locale === next.locale &&
    previous.reserveTurnViewport === next.reserveTurnViewport &&
    previous.turnAnchor === next.turnAnchor &&
    previous.message.id === next.message.id &&
    previous.message.role === next.message.role &&
    previous.message.status === next.message.status &&
    previous.message.markdown === next.message.markdown &&
    runErrorsEqual(previous.message.runError, next.message.runError) &&
    messageContextsEqual(previous.message, next.message)
  );
}

function runErrorsEqual(
  previous: ConversationMessage["runError"],
  next: ConversationMessage["runError"],
) {
  return (
    previous === next ||
    (previous?.code === next?.code &&
      previous?.message === next?.message &&
      previous?.recoverable === next?.recoverable &&
      previous?.focusTab === next?.focusTab)
  );
}

const markdownRehypePlugins = [rehypeSanitize, rehypeHighlight];
const markdownRemarkPlugins = [remarkGfm];
const markdownComponents: Record<AppState["locale"], Components> = {
  "zh-CN": {
    a: ({ children, href }) => <ExternalLink href={href}>{children}</ExternalLink>,
    img: ({ alt, src }) => <ExternalLink href={src}>{alt || "图片链接"}</ExternalLink>,
  },
  en: {
    a: ({ children, href }) => <ExternalLink href={href}>{children}</ExternalLink>,
    img: ({ alt, src }) => <ExternalLink href={src}>{alt || "Image link"}</ExternalLink>,
  },
};

const StreamingMarkdownBlock = memo(function StreamingMarkdownBlock({
  content,
  highlight,
  locale,
}: {
  content: string;
  highlight: boolean;
  locale: AppState["locale"];
}) {
  return (
    <div className="streaming-markdown__block">
      <ReactMarkdown
        components={markdownComponents[locale]}
        rehypePlugins={highlight ? markdownRehypePlugins : undefined}
        remarkPlugins={markdownRemarkPlugins}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

type MarkdownBlockKind =
  "fence" | "heading" | "indented-code" | "list" | "paragraph" | "quote" | "thematic-break";

function topLevelFenceMarker(line: string) {
  return /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
}

function isClosingFence(line: string, fence: { character: string; length: number }) {
  const marker = /^\s{0,3}(`{3,}|~{3,})[ \t]*(?:\r?\n)?$/u.exec(line)?.[1];
  return marker?.[0] === fence.character && marker.length >= fence.length;
}

function markdownBlockKind(line: string): MarkdownBlockKind {
  if (/^\s{0,3}#{1,6}(?:[ \t]+|$)/u.test(line)) return "heading";
  if (topLevelFenceMarker(line)) return "fence";
  if (/^\s{0,3}>/u.test(line)) return "quote";
  if (/^\s{0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/u.test(line)) return "list";
  if (/^(?: {4}|\t)/u.test(line)) return "indented-code";
  if (/^\s{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})(?:\r?\n)?$/u.test(line)) {
    return "thematic-break";
  }
  return "paragraph";
}

function splitTopLevelMarkdownBlocks(content: string) {
  const blocks: string[] = [];
  const lines = content.match(/.*(?:\r?\n|$)/gu) ?? [content];
  let block = "";
  let kind: MarkdownBlockKind | undefined;
  let fence: { character: string; length: number } | undefined;
  let followsBlankLine = false;

  const finishBlock = () => {
    if (block) blocks.push(block);
    block = "";
    kind = undefined;
    fence = undefined;
    followsBlankLine = false;
  };

  const startBlock = (line: string) => {
    kind = markdownBlockKind(line);
    block = line;
    if (kind === "fence") {
      const marker = topLevelFenceMarker(line)!;
      fence = { character: marker[0]!, length: marker.length };
    }
  };

  for (const line of lines) {
    if (!line) continue;
    const blank = /^\s*\r?\n$/u.test(line);

    if (!kind) {
      if (!blank) startBlock(line);
      continue;
    }

    if (kind === "fence") {
      block += line;
      if (fence && isClosingFence(line, fence)) finishBlock();
      continue;
    }

    if (blank) {
      block += line;
      if (kind === "paragraph" || kind === "heading" || kind === "thematic-break") {
        finishBlock();
      } else {
        followsBlankLine = true;
      }
      continue;
    }

    if (kind === "heading" || kind === "thematic-break") {
      finishBlock();
      startBlock(line);
      continue;
    }

    if (kind === "list" && followsBlankLine) {
      const nextKind = markdownBlockKind(line);
      const continuesList = nextKind === "list" || /^(?:[ \t]+)\S/u.test(line);
      if (!continuesList) {
        finishBlock();
        startBlock(line);
        continue;
      }
    } else if (kind === "quote" && followsBlankLine && !/^\s{0,3}>/u.test(line)) {
      finishBlock();
      startBlock(line);
      continue;
    } else if (kind === "indented-code" && !/^(?: {4}|\t)/u.test(line)) {
      finishBlock();
      startBlock(line);
      continue;
    } else if (kind === "paragraph") {
      const nextKind = markdownBlockKind(line);
      if (nextKind === "heading" || nextKind === "fence" || nextKind === "quote") {
        finishBlock();
        startBlock(line);
        continue;
      }
    }

    block += line;
    followsBlankLine = false;
  }

  if (block) blocks.push(block);
  return blocks.length > 0 ? blocks : [content];
}

function splitStableMarkdownBlocks(content: string) {
  // Reference definitions and raw HTML can affect nodes outside their local
  // textual block, so retain one parser tree for those uncommon documents.
  // For ordinary streamed Markdown, completed top-level blocks are immutable:
  // a continuous list/quote stays together, an open fence stays in the tail,
  // and only that unfinished tail is reparsed as new text arrives.
  if (
    /^\s{0,3}\[[^\]]+\]:\s*\S+/mu.test(content) ||
    /\[[^\]]+\]\s*\[[^\]]*\]/u.test(content) ||
    /^\s{0,3}<[A-Za-z!/]/mu.test(content)
  ) {
    return [content];
  }
  return splitTopLevelMarkdownBlocks(content);
}

const Markdown = memo(function Markdown({
  content,
  locale,
  streaming,
}: {
  content: string;
  locale: AppState["locale"];
  streaming: boolean;
}) {
  // Use one stable block tree for both streaming and terminal states. Complete
  // blocks retain their React identity while only the growing tail is parsed;
  // terminal syntax highlighting updates fenced blocks without replacing the
  // whole answer DOM.
  return (
    <div className="streaming-markdown" data-streaming={streaming ? "true" : "false"}>
      {splitStableMarkdownBlocks(content).map((block, index) => (
        <StreamingMarkdownBlock
          content={block}
          highlight={!streaming && /(?:```|~~~)/u.test(block)}
          key={index}
          locale={locale}
        />
      ))}
    </div>
  );
});

function ExternalLink({ children, href }: { children: React.ReactNode; href?: string }) {
  const normalized = normalizeExternalHttpUrl(href);
  if (!normalized) return <span>{children}</span>;
  return (
    <a
      href={normalized}
      onClick={(event) => {
        event.preventDefault();
        postMessage({ type: "openExternal", url: normalized });
      }}
      rel="noreferrer"
    >
      {children}
    </a>
  );
}

function SentContextList({
  conversationId,
  contexts,
  locale,
}: {
  conversationId: string;
  contexts: ContextSnapshot[];
  locale: AppState["locale"];
}) {
  const t = strings[locale];
  const [showAll, setShowAll] = useState(false);
  const delivery = contextDeliveryModes(contexts);
  const visibleContexts = showAll ? contexts : contexts.slice(0, 2);
  const hiddenCount = Math.max(0, contexts.length - visibleContexts.length);
  return (
    <div aria-label={t.sentContexts} className="sent-context-list" role="group">
      {visibleContexts.map((context) => (
        <ContextBadge
          context={context}
          conversationId={conversationId}
          delivery={delivery.get(context.id) ?? "inline"}
          key={contextKey(context)}
          locale={locale}
        />
      ))}
      {contexts.length > 2 && (
        <button
          aria-expanded={showAll}
          aria-label={showAll ? t.showFewerContexts : t.showMoreContexts}
          className="sent-context-list__more"
          onClick={() => setShowAll((value) => !value)}
          type="button"
        >
          {showAll ? t.showLess : `+${hiddenCount}`}
        </button>
      )}
    </div>
  );
}

function ContextBadge({
  context,
  conversationId,
  delivery,
  locale,
}: {
  context: ContextSnapshot;
  conversationId: string;
  delivery: "inline" | "file";
  locale: AppState["locale"];
}) {
  const [expanded, setExpanded] = useState(false);
  const t = strings[locale];
  const previewId = useId();
  return (
    <div className="sent-context">
      <div className="sent-context__header">
        <button
          aria-label={`${t.openContext}: ${context.fileName}, L${context.startLine}–${context.endLine}`}
          className="sent-context__open"
          onClick={() =>
            postMessage({
              type: "openContext",
              conversationId,
              contextId: contextKey(context),
            })
          }
          type="button"
        >
          {context.kind === "selection" ? <CodeIcon /> : <FileIcon />}
          <span>{context.fileName}</span>
        </button>
        <button
          aria-controls={previewId}
          aria-expanded={expanded}
          aria-label={`${t.previewContext}: ${context.fileName}`}
          className="sent-context__preview-toggle"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          <ChevronIcon className={expanded ? "rotated" : ""} />
        </button>
      </div>
      {expanded && (
        <div className="sent-context__details" id={previewId}>
          <small>
            L{context.startLine}–{context.endLine}
            {" · "}
            {context.charCount.toLocaleString()} {t.characters}
            {context.unsaved ? ` · ${t.unsaved}` : ""}
            {` · ${delivery === "file" ? t.sentAsFile : t.sentInline}`}
          </small>
          <pre>{context.content}</pre>
        </div>
      )}
    </div>
  );
}

const SEND_RESULT_FAILSAFE_MS = 15_000;

interface PendingComposerSend {
  automaticContextIds: string[];
  baselineMessageIds: Set<string>;
  conversationId: string;
  contexts: ContextSnapshot[];
  draft: string;
  handedOff: boolean;
  hostAccepted: boolean;
  kind: "send" | "queue" | "interrupt";
  observedDispatch: boolean;
  requestId: string;
  timeoutId?: number;
}

type FollowUpAction = "queue" | "interrupt";

const DEFAULT_COMPOSER_PREFERENCES = {
  followUpQueueMode: "queue",
  composerEnterBehavior: "enter",
} as const;

function effectiveFollowUpAction(
  conversation: Conversation,
  configured: FollowUpAction,
  opposite: boolean,
): FollowUpAction {
  // Once a stop is already in flight, another interrupt could arrive after
  // the queued turn has started. Force this edge into the run-bound queue.
  if (conversation.run?.status === "stopping") return "queue";
  if (!opposite) return configured;
  return configured === "queue" ? "interrupt" : "queue";
}

function composerOppositeShortcut() {
  return "Ctrl/Cmd+Shift+Enter";
}

interface ComposerContextRollback {
  automaticContextIds: string[];
  contexts: ContextSnapshot[];
}

interface ComposerSendResult {
  accepted: boolean;
  conversationId: string;
  requestId: string;
  revision: number;
}

function QueuedFollowUpList({
  conversation,
  locale,
  locked,
}: {
  conversation: Conversation;
  locale: AppState["locale"];
  locked: boolean;
}) {
  const queued = conversation.queuedFollowUps ?? [];
  const [editingId, setEditingId] = useState<string>();
  const [editingText, setEditingText] = useState("");
  const t = strings[locale];

  useEffect(() => {
    if (editingId && !queued.some((item) => item.id === editingId)) {
      setEditingId(undefined);
      setEditingText("");
    }
  }, [editingId, queued]);
  useEffect(() => {
    setEditingId(undefined);
    setEditingText("");
  }, [conversation.id]);

  if (queued.length === 0) return null;

  const beginEdit = (item: QueuedFollowUp) => {
    setEditingId(item.id);
    setEditingText(item.text);
  };
  const finishEdit = (item: QueuedFollowUp) => {
    const text = editingText.trim();
    if (!text) return;
    postMessage({
      type: "updateQueuedFollowUp",
      conversationId: conversation.id,
      queueId: item.id,
      text,
    });
    setEditingId(undefined);
    setEditingText("");
  };

  return (
    <section aria-label={t.queuedFollowUps} className="queued-follow-ups">
      <div className="queued-follow-ups__header">
        <span>
          {t.queuedFollowUps} · {queued.length}
        </span>
        {conversation.queuePaused && (
          <button
            className="queued-follow-ups__resume"
            disabled={locked}
            onClick={() => postMessage({ type: "resumeQueue", conversationId: conversation.id })}
            type="button"
          >
            <RefreshIcon />
            {t.resumeQueue}
          </button>
        )}
      </div>
      {conversation.queuePaused && <p className="queued-follow-ups__paused">{t.queuePaused}</p>}
      <div className="queued-follow-ups__list">
        {queued.map((item) => (
          <div className="queued-follow-up" key={item.id}>
            {editingId === item.id ? (
              <div className="queued-follow-up__editor">
                <textarea
                  aria-label={t.editQueuedFollowUp}
                  autoFocus
                  maxLength={20_000}
                  onChange={(event) => setEditingText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
                      return;
                    }
                    if (event.key === "Escape") {
                      setEditingId(undefined);
                      setEditingText("");
                    }
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      finishEdit(item);
                    }
                  }}
                  rows={2}
                  value={editingText}
                />
                <div className="queued-follow-up__edit-actions">
                  <button onClick={() => finishEdit(item)} type="button">
                    {t.save}
                  </button>
                  <button
                    onClick={() => {
                      setEditingId(undefined);
                      setEditingText("");
                    }}
                    type="button"
                  >
                    {t.cancel}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <span className="queued-follow-up__text">{item.text}</span>
                <div className="queued-follow-up__actions">
                  <button
                    aria-label={t.editQueuedFollowUp}
                    disabled={locked}
                    onClick={() => beginEdit(item)}
                    title={t.editQueuedFollowUp}
                    type="button"
                  >
                    <EditIcon />
                  </button>
                  <button
                    aria-label={t.removeQueuedFollowUp}
                    disabled={locked}
                    onClick={() =>
                      postMessage({
                        type: "removeQueuedFollowUp",
                        conversationId: conversation.id,
                        queueId: item.id,
                      })
                    }
                    title={t.removeQueuedFollowUp}
                    type="button"
                  >
                    <TrashIcon />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function Composer({
  backendReady,
  composerPreferences,
  connection,
  conversations,
  conversation,
  dispatchingConversationIds,
  inputRef,
  locale,
  contexts,
  automaticContextIds,
  contextLocked,
  contextOpen,
  focusRequestRevision,
  onAccepted,
  onContextToggle,
  onOptimisticRejected,
  onOptimisticSend,
  preserveReadyPresentation,
  sendResults,
  modelPicker,
  newConversationPending,
}: {
  backendReady: boolean;
  composerPreferences: AppState["composerPreferences"];
  connection: ConnectionPresentation;
  conversations: Conversation[];
  conversation: Conversation;
  dispatchingConversationIds: string[];
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  locale: AppState["locale"];
  contexts: ContextSnapshot[];
  automaticContextIds: string[];
  contextLocked: boolean;
  contextOpen: boolean;
  focusRequestRevision: number;
  onAccepted: () => void;
  onContextToggle: () => void;
  onOptimisticRejected: (conversationId: string, requestId: string) => void;
  onOptimisticSend: (optimistic: OptimisticComposerSend) => void;
  preserveReadyPresentation: boolean;
  sendResults: ComposerSendResult[];
  modelPicker: ModelPickerState;
  newConversationPending: boolean;
}) {
  const [text, setText] = useState("");
  const [pendingRevision, setPendingRevision] = useState(0);
  const draftsByConversationRef = useRef(new Map<string, string>());
  const pendingByConversationRef = useRef(new Map<string, PendingComposerSend>());
  const contextRollbacksByConversationRef = useRef(new Map<string, ComposerContextRollback>());
  const hiddenContextIdsByConversationRef = useRef(new Map<string, Set<string>>());
  const dispatchPrewarmAtByConversationRef = useRef(new Map<string, number>());
  const processedSendResultRevisionRef = useRef(0);
  const conversationIdRef = useRef(conversation.id);
  const activeConversationIdRef = useRef(conversation.id);
  activeConversationIdRef.current = conversation.id;
  const contextTriggerRef = useRef<HTMLButtonElement>(null);
  const regionRef = useRef<HTMLElement>(null);
  const contextMenuId = useId();
  const composerDescriptionId = useId();
  const t = strings[locale];
  const preferences = composerPreferences ?? DEFAULT_COMPOSER_PREFERENCES;
  // The optimistic New chat frame deliberately reuses the source conversation
  // until the Extension Host publishes the new id. Never let source-scoped
  // draft state leak into that blank frame: a rejected send can leave a
  // context rollback behind even though the contexts prop is already empty.
  const activePending = newConversationPending
    ? undefined
    : pendingByConversationRef.current.get(conversation.id);
  const submitting = Boolean(activePending);
  const submissionReadOnly = Boolean(activePending && !activePending.hostAccepted);
  const contextRollback = newConversationPending
    ? undefined
    : contextRollbacksByConversationRef.current.get(conversation.id);
  const hiddenContextIds = newConversationPending
    ? undefined
    : hiddenContextIdsByConversationRef.current.get(conversation.id);
  const restoredOrAuthoritativeContexts = contextRollback?.contexts ?? contexts;
  const visibleContexts = newConversationPending
    ? []
    : activePending
      ? []
      : hiddenContextIds
        ? restoredOrAuthoritativeContexts.filter(
            (context) => !hiddenContextIds.has(contextKey(context)),
          )
        : restoredOrAuthoritativeContexts;
  const sourceAutomaticContextIds = contextRollback?.automaticContextIds ?? automaticContextIds;
  const visibleAutomaticContextIds = sourceAutomaticContextIds.filter((id) =>
    visibleContexts.some((context) => contextKey(context) === id),
  );
  const runBusy = Boolean(conversation.run);
  const followUpAction = effectiveFollowUpAction(
    conversation,
    preferences.followUpQueueMode,
    false,
  );
  const oppositeShortcut = composerOppositeShortcut();
  const busy = newConversationPending || runBusy || submitting;
  const presentComposerAsReady = backendReady || preserveReadyPresentation;
  const connectionRecovering =
    runBusy && (connection.phase === "reconnecting" || connection.phase === "syncing");
  const runStatus = connectionRecovering
    ? t.runRecovering
    : conversation.run?.status === "stopping"
      ? t.runStopping
      : conversation.run?.softTimeoutNotified
        ? t.runBackground
        : undefined;
  const runStatusTone = connectionRecovering
    ? "recovering"
    : conversation.run?.softTimeoutNotified
      ? "warning"
      : conversation.run?.status === "stopping"
        ? "stopping"
        : "progress";

  const requestDispatchPrewarm = useCallback(() => {
    if (newConversationPending || !backendReady || runBusy || submitting) return;
    const now = Date.now();
    const previous = dispatchPrewarmAtByConversationRef.current.get(conversation.id) ?? 0;
    if (now - previous < COMPOSER_DISPATCH_PREWARM_THROTTLE_MS) return;
    dispatchPrewarmAtByConversationRef.current.set(conversation.id, now);
    postMessage({ type: "prepareConversation", conversationId: conversation.id });
  }, [backendReady, conversation.id, newConversationPending, runBusy, submitting]);

  useEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    const updateHeight = () => {
      document.documentElement.style.setProperty(
        "--composer-height",
        `${Math.ceil(region.getBoundingClientRect().height)}px`,
      );
    };
    updateHeight();
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updateHeight);
    observer?.observe(region);
    window.addEventListener("resize", updateHeight);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateHeight);
      document.documentElement.style.removeProperty("--composer-height");
    };
  }, []);

  useLayoutEffect(() => {
    if (conversationIdRef.current === conversation.id) return;
    conversationIdRef.current = conversation.id;
    setText(draftsByConversationRef.current.get(conversation.id) ?? "");
  }, [conversation.id]);

  const refreshPendingState = useCallback(() => {
    setPendingRevision((current) => current + 1);
  }, []);

  const settlePendingSend = useCallback(
    (pending: PendingComposerSend, accepted: boolean) => {
      if (pendingByConversationRef.current.get(pending.conversationId) !== pending) return;
      pendingByConversationRef.current.delete(pending.conversationId);
      if (pending.timeoutId !== undefined) window.clearTimeout(pending.timeoutId);

      if (accepted) {
        if (pending.contexts.length > 0) {
          hiddenContextIdsByConversationRef.current.set(
            pending.conversationId,
            new Set(pending.contexts.map(contextKey)),
          );
        }
        contextRollbacksByConversationRef.current.delete(pending.conversationId);
      } else {
        contextRollbacksByConversationRef.current.set(pending.conversationId, {
          automaticContextIds: pending.automaticContextIds,
          contexts: pending.contexts,
        });
        hiddenContextIdsByConversationRef.current.delete(pending.conversationId);
        onOptimisticRejected(pending.conversationId, pending.requestId);
      }

      const storedDraft = draftsByConversationRef.current.get(pending.conversationId) ?? "";
      const nextDraft = accepted
        ? storedDraft
        : storedDraft.length === 0
          ? pending.draft
          : storedDraft;
      draftsByConversationRef.current.set(pending.conversationId, nextDraft);

      if (activeConversationIdRef.current === pending.conversationId) {
        setText(nextDraft);
        queueMicrotask(() => inputRef.current?.focus());
      }
      refreshPendingState();
    },
    [inputRef, onOptimisticRejected, refreshPendingState],
  );

  const handOffPendingSend = useCallback((pending: PendingComposerSend) => {
    pending.handedOff = true;
  }, []);

  useEffect(() => {
    for (const result of sendResults) {
      if (result.revision <= processedSendResultRevisionRef.current) continue;
      processedSendResultRevisionRef.current = result.revision;
      const pending = pendingByConversationRef.current.get(result.conversationId);
      if (!pending || pending.requestId !== result.requestId) continue;
      if (result.accepted) {
        pending.hostAccepted = true;
        if (pending.kind !== "send") {
          settlePendingSend(pending, true);
          continue;
        }
        // The host receipt owns this request id, so the user can immediately
        // prepare a follow-up draft while authoritative state catches up. Keep
        // the pending slot itself until that state arrives so Enter cannot
        // dispatch a second request into the same conversation prematurely.
        refreshPendingState();
      } else {
        settlePendingSend(pending, false);
      }
    }
  }, [refreshPendingState, sendResults, settlePendingSend]);

  useEffect(() => {
    let changed = false;
    const rollback = contextRollbacksByConversationRef.current.get(conversation.id);
    if (
      rollback &&
      rollback.contexts.length === contexts.length &&
      rollback.contexts.every(
        (context, index) => contextKey(context) === contextKey(contexts[index]!),
      )
    ) {
      contextRollbacksByConversationRef.current.delete(conversation.id);
      changed = true;
    }
    const hiddenIds = hiddenContextIdsByConversationRef.current.get(conversation.id);
    if (hiddenIds && !contexts.some((context) => hiddenIds.has(contextKey(context)))) {
      hiddenContextIdsByConversationRef.current.delete(conversation.id);
      changed = true;
    }
    if (changed) refreshPendingState();
  }, [contexts, conversation.id, pendingRevision, refreshPendingState]);

  useEffect(() => {
    const dispatching = new Set(dispatchingConversationIds);
    for (const pending of pendingByConversationRef.current.values()) {
      const target = conversations.find((item) => item.id === pending.conversationId);
      if (!target) continue;
      const acceptedQueue = target.queuedFollowUps?.some((item) => item.id === pending.requestId);
      const correlatedMessage = target.messages.some(
        (message) => message.role === "user" && message.clientRequestId === pending.requestId,
      );
      if (pending.kind !== "send") {
        // Either representation is authoritative: queued state owns the item,
        // while clientRequestId survives its promotion into a user message.
        // This closes the lost-sendResult path without text-based guesses.
        if (acceptedQueue || correlatedMessage) settlePendingSend(pending, true);
        continue;
      }
      const isActive = target.id === conversation.id;
      const isDispatching = dispatching.has(target.id) || (isActive && contextLocked);
      if (isDispatching) pending.observedDispatch = true;

      const acceptedMessage = target.messages.some(
        (message) =>
          message.role === "user" &&
          (message.clientRequestId === pending.requestId ||
            (!pending.baselineMessageIds.has(message.id) &&
              message.markdown === pending.draft.trim())),
      );
      const hasAcceptedState = Boolean(target.run) || acceptedMessage;
      // For the active conversation, an empty pending-context list is the
      // durable hand-off signal. Inactive conversations are already hidden;
      // preserve their rollback backup while clearing only their own slot.
      if (hasAcceptedState && (!isActive || contexts.length === 0)) {
        handOffPendingSend(pending);
      }

      if (!isDispatching && hasAcceptedState && (pending.observedDispatch || acceptedMessage)) {
        settlePendingSend(pending, true);
      } else if (!isDispatching && pending.observedDispatch && !hasAcceptedState) {
        // A dispatch that once existed but no longer has its optimistic
        // user/run state was rolled back. Restore only that conversation.
        settlePendingSend(pending, false);
      }
    }
  }, [
    contextLocked,
    contexts.length,
    conversation.id,
    conversations,
    dispatchingConversationIds,
    handOffPendingSend,
    settlePendingSend,
  ]);

  useEffect(() => {
    const existingIds = new Set(conversations.map((item) => item.id));
    let removedPending = false;
    for (const [conversationId, pending] of pendingByConversationRef.current) {
      if (existingIds.has(conversationId)) continue;
      if (pending.timeoutId !== undefined) window.clearTimeout(pending.timeoutId);
      pendingByConversationRef.current.delete(conversationId);
      draftsByConversationRef.current.delete(conversationId);
      contextRollbacksByConversationRef.current.delete(conversationId);
      hiddenContextIdsByConversationRef.current.delete(conversationId);
      removedPending = true;
    }
    for (const conversationId of draftsByConversationRef.current.keys()) {
      if (!existingIds.has(conversationId)) draftsByConversationRef.current.delete(conversationId);
    }
    for (const conversationId of contextRollbacksByConversationRef.current.keys()) {
      if (!existingIds.has(conversationId)) {
        contextRollbacksByConversationRef.current.delete(conversationId);
      }
    }
    for (const conversationId of hiddenContextIdsByConversationRef.current.keys()) {
      if (!existingIds.has(conversationId)) {
        hiddenContextIdsByConversationRef.current.delete(conversationId);
      }
    }
    if (removedPending) refreshPendingState();
  }, [conversations, refreshPendingState]);

  const closeContextMenu = useCallback(() => {
    onContextToggle();
    queueMicrotask(() => contextTriggerRef.current?.focus());
  }, [onContextToggle]);

  const send = (oppositeFollowUp = false) => {
    if (
      !text.trim() ||
      newConversationPending ||
      submitting ||
      (!runBusy && !backendReady) ||
      pendingByConversationRef.current.has(conversation.id)
    )
      return;
    const kind = runBusy
      ? effectiveFollowUpAction(conversation, preferences.followUpQueueMode, oppositeFollowUp)
      : "send";
    const targetRunId = conversation.run?.id;
    const requestId = crypto.randomUUID();
    const capturedContexts = visibleContexts.map((context) => ({ ...context }));
    const baselineMessageIds = new Set(conversation.messages.map((message) => message.id));
    const pending: PendingComposerSend = {
      automaticContextIds: [...visibleAutomaticContextIds],
      baselineMessageIds,
      conversationId: conversation.id,
      contexts: capturedContexts,
      draft: text,
      handedOff: false,
      hostAccepted: false,
      kind,
      observedDispatch: false,
      requestId,
    };
    pending.timeoutId = window.setTimeout(() => {
      const current = pendingByConversationRef.current.get(pending.conversationId);
      // If no authoritative state ever arrived, unlock without losing the
      // draft. An explicit accepted receipt proves that the host owns this
      // exact request, so only authoritative state may release its slot; an
      // arbitrary timeout could let a delayed first state consume a same-text
      // follow-up. Once hand-off happened, likewise keep the rollback backup
      // until the host publishes an explicit terminal dispatch state.
      if (current !== pending || pending.handedOff) return;
      pending.timeoutId = undefined;
      if (pending.hostAccepted) return;
      settlePendingSend(pending, false);
    }, SEND_RESULT_FAILSAFE_MS);
    draftsByConversationRef.current.set(conversation.id, "");
    contextRollbacksByConversationRef.current.delete(conversation.id);
    hiddenContextIdsByConversationRef.current.delete(conversation.id);
    pendingByConversationRef.current.set(conversation.id, pending);
    setText("");
    refreshPendingState();
    onAccepted();
    if (kind === "send") {
      onOptimisticSend({
        baselineMessageIds,
        contexts: capturedContexts,
        conversationId: conversation.id,
        createdAt: new Date().toISOString(),
        requestId,
        text,
      });
      postMessage({ type: "send", conversationId: conversation.id, requestId, text });
    } else if (kind === "queue" && targetRunId) {
      postMessage({
        type: "enqueueFollowUp",
        conversationId: conversation.id,
        requestId,
        targetRunId,
        text,
      });
    } else if (targetRunId) {
      postMessage({
        type: "interruptWithFollowUp",
        conversationId: conversation.id,
        requestId,
        targetRunId,
        text,
      });
    }
  };

  const composerPlaceholder = newConversationPending
    ? t.composerPlaceholder
    : !presentComposerAsReady
      ? connection.composerHint
      : submitting
        ? t.composerWorking
        : runBusy
          ? followUpAction === "queue"
            ? t.nextQuestion
            : t.interruptNextQuestion
          : !hasVisibleConversationMessages(conversation)
            ? t.composerPlaceholder
            : t.composerFollowUpPlaceholder;
  const submitLabel = runBusy
    ? followUpAction === "queue"
      ? t.queue
      : t.interruptAndSend
    : t.send;
  const submitTitle = runBusy
    ? followUpAction === "queue"
      ? `${t.queueDetail} · ${oppositeShortcut} ${t.useInterruptOnce}`
      : `${t.interruptDetail} · ${oppositeShortcut} ${t.useQueueOnce}`
    : t.send;
  const composerKeyboardHint =
    preferences.composerEnterBehavior === "cmdAlways"
      ? t.composerKeyboardHintCmdAlways
      : preferences.composerEnterBehavior === "cmdIfMultiline"
        ? t.composerKeyboardHintCmdIfMultiline
        : t.composerKeyboardHint;

  return (
    <footer aria-label={t.composerRegion} className="composer-region" ref={regionRef}>
      <QueuedFollowUpList conversation={conversation} locale={locale} locked={contextLocked} />
      {runStatus && (
        <div
          aria-live="polite"
          className={`run-status-line run-status-line--${runStatusTone}`}
          role="status"
        >
          <span aria-hidden="true" className="run-status-line__dot" />
          <span>{runStatus}</span>
        </div>
      )}
      <div className={`composer ${busy ? "composer--busy" : ""}`}>
        {visibleContexts.length > 0 && (
          <PendingContextList
            automaticContextIds={visibleAutomaticContextIds}
            conversationId={conversation.id}
            contexts={visibleContexts}
            dismissRevision={focusRequestRevision}
            locked={contextLocked}
            locale={locale}
          />
        )}
        <textarea
          aria-busy={submitting}
          aria-describedby={composerDescriptionId}
          aria-label={t.composerLabel}
          maxLength={20_000}
          onChange={(event) => {
            const nextText = event.target.value;
            draftsByConversationRef.current.set(conversation.id, nextText);
            setText(nextText);
            if (nextText.trim()) requestDispatchPrewarm();
          }}
          onPointerDown={requestDispatchPrewarm}
          onKeyDown={(event) => {
            if (event.key === "Escape" && contextOpen) {
              event.preventDefault();
              onContextToggle();
              return;
            }
            if (
              event.key !== "Enter" ||
              submitting ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229 ||
              event.altKey
            )
              return;

            const modifierPressed = event.ctrlKey || event.metaKey;
            const oppositeFollowUp = runBusy && modifierPressed && event.shiftKey;
            if (oppositeFollowUp) {
              event.preventDefault();
              send(true);
              return;
            }
            if (event.shiftKey) return;

            const shouldSubmit =
              modifierPressed ||
              preferences.composerEnterBehavior === "enter" ||
              (preferences.composerEnterBehavior === "cmdIfMultiline" && !/[\r\n]/.test(text));
            if (!shouldSubmit) return;
            event.preventDefault();
            send(false);
          }}
          placeholder={composerPlaceholder}
          readOnly={newConversationPending || submissionReadOnly}
          ref={inputRef}
          rows={1}
          value={newConversationPending ? "" : text}
        />
        <div className="composer-toolbar">
          <div className="context-menu-wrap">
            <button
              aria-controls={contextMenuId}
              aria-expanded={contextOpen}
              aria-haspopup="menu"
              aria-label={t.context}
              className="composer-tool-button"
              disabled={newConversationPending || submitting || contextLocked}
              onClick={onContextToggle}
              ref={contextTriggerRef}
              title={t.addContext}
            >
              <PlusIcon />
              <span>{t.context}</span>
            </button>
            {contextOpen && (
              <ContextMenu
                conversationId={conversation.id}
                id={contextMenuId}
                locale={locale}
                onClose={closeContextMenu}
              />
            )}
          </div>
          <span className="sr-only" id={composerDescriptionId}>
            {presentComposerAsReady ? composerKeyboardHint : connection.composerHint}
          </span>
          <ModelPicker busy={busy} locale={locale} picker={modelPicker} />
          {runBusy && !text.trim() ? (
            <button
              aria-label={t.stop}
              className="send-button send-button--stop"
              disabled={conversation.run?.status === "stopping"}
              onClick={() =>
                postMessage({
                  type: "stop",
                  conversationId: conversation.id,
                  targetRunId: conversation.run!.id,
                })
              }
            >
              <StopIcon />
            </button>
          ) : (
            <button
              aria-label={submitLabel}
              className={`send-button ${preserveReadyPresentation ? "send-button--connection-grace" : ""}`}
              data-follow-up-action={runBusy ? followUpAction : undefined}
              disabled={
                newConversationPending || (!runBusy && !backendReady) || !text.trim() || submitting
              }
              onClick={() => send(false)}
              title={submitTitle}
            >
              <SendIcon />
            </button>
          )}
        </div>
      </div>
    </footer>
  );
}

function ModelPicker({
  busy,
  locale,
  picker,
}: {
  busy: boolean;
  locale: AppState["locale"];
  picker: ModelPickerState;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"modes" | "families">("modes");
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const familyMenuId = useId();
  const t = strings[locale];
  const selectedModelId = picker.currentModelId;
  const menu = useMemo(
    () => buildChatGptModelMenu(picker.options, selectedModelId),
    [picker.options, selectedModelId],
  );
  const current = menu.current;
  const modeLabels = chatGptModeLabels[locale];
  const modeGroupLabels = chatGptModeGroupLabels[locale];
  const haveOptions = menu.modes.length > 0;
  const triggerLabel = current
    ? modelTriggerLabel(current, modeLabels) || t.currentChatGptModel
    : t.currentChatGptModel;

  useEffect(() => {
    setOpen(false);
    setView("modes");
  }, [picker.conversationId]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  useEffect(() => {
    if (!open || !haveOptions) return;
    queueMicrotask(() => {
      const selected = menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
      const first = menuRef.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]');
      (selected ?? first)?.focus();
    });
  }, [haveOptions, open, view]);

  const openPicker = () => {
    if (busy) return;
    setOpen((value) => {
      if (!value) setView("modes");
      return !value;
    });
  };

  const closePicker = () => {
    setOpen(false);
    setView("modes");
    queueMicrotask(() => triggerRef.current?.focus());
  };

  const select = (modelId: string) => {
    if (modelId !== selectedModelId) {
      postMessage({ type: "selectModel", conversationId: picker.conversationId, modelId });
    }
    closePicker();
  };

  const renderModeChoice = ({ key, option, secondaryLabel }: (typeof menu.modes)[number]) => {
    const selected = option.id === selectedModelId;
    return (
      <button
        aria-checked={selected}
        className="model-picker__option"
        data-model-mode={key}
        key={option.id}
        onClick={() => select(option.id)}
        role="menuitemradio"
        tabIndex={selected ? 0 : -1}
        type="button"
      >
        <span className="model-picker__label">
          <strong>{modeLabels[key]}</strong>
          {secondaryLabel && <small>{secondaryLabel}</small>}
        </span>
        <span aria-hidden="true" className="model-picker__check">
          {selected ? "✓" : ""}
        </span>
      </button>
    );
  };

  return (
    <div className="model-picker" ref={wrapRef}>
      <button
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t.modelPicker}
        className="model-picker__trigger"
        disabled={busy}
        onClick={openPicker}
        ref={triggerRef}
        title={t.modelPicker}
        type="button"
      >
        <span>{triggerLabel}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div
          aria-label={t.chooseModel}
          className={`model-picker__menu model-picker__menu--${view}`}
          id={menuId}
          onKeyDown={(event) => {
            if (event.key === "Tab") {
              setOpen(false);
              setView("modes");
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              if (view === "families") setView("modes");
              else closePicker();
              return;
            }
            if (event.key === "ArrowLeft" && view === "families") {
              event.preventDefault();
              setView("modes");
              return;
            }
            if (
              event.key === "ArrowRight" &&
              document.activeElement?.classList.contains("model-picker__family-entry")
            ) {
              event.preventDefault();
              setView("families");
              return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            const items = [
              ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"], [role="menuitemradio"]',
              ) ?? []),
            ].filter((item) => !item.disabled);
            if (items.length === 0) return;
            event.preventDefault();
            const currentIndex = Math.max(
              0,
              items.indexOf(document.activeElement as HTMLButtonElement),
            );
            const nextIndex =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : event.key === "ArrowDown"
                    ? (currentIndex + 1) % items.length
                    : (currentIndex - 1 + items.length) % items.length;
            items[nextIndex]?.focus();
          }}
          ref={menuRef}
          role="menu"
        >
          {haveOptions ? (
            view === "modes" ? (
              <>
                {menu.modeGroups.map((group) => (
                  <div
                    aria-label={group.key === "reasoning" ? modeGroupLabels.reasoning : undefined}
                    className={`model-picker__group model-picker__group--${group.key}`}
                    key={group.key}
                    role={group.key === "reasoning" ? "group" : undefined}
                  >
                    {group.key === "reasoning" && (
                      <div className="model-picker__group-label">{modeGroupLabels.reasoning}</div>
                    )}
                    {group.choices.map(renderModeChoice)}
                  </div>
                ))}
                {menu.families.length > 0 && (
                  <>
                    <div aria-hidden="true" className="model-picker__separator" />
                    <button
                      aria-controls={familyMenuId}
                      aria-expanded="false"
                      aria-haspopup="menu"
                      className="model-picker__option model-picker__family-entry"
                      onClick={() => setView("families")}
                      role="menuitem"
                      tabIndex={-1}
                      type="button"
                    >
                      <span className="model-picker__label">
                        <strong>{menu.currentFamily ?? menu.families[0]!.label}</strong>
                      </span>
                      <ChevronIcon className="model-picker__submenu-arrow" />
                    </button>
                  </>
                )}
              </>
            ) : (
              <div className="model-picker__submenu" id={familyMenuId} role="none">
                <button
                  className="model-picker__back"
                  onClick={() => setView("modes")}
                  role="menuitem"
                  tabIndex={-1}
                  type="button"
                >
                  <ChevronIcon />
                  <span>{t.chooseModel}</span>
                </button>
                <div aria-hidden="true" className="model-picker__separator" />
                {menu.families.map((family) => (
                  <button
                    aria-checked={family.selected}
                    className="model-picker__option"
                    key={family.label}
                    onClick={() => select(family.option.id)}
                    role="menuitemradio"
                    tabIndex={family.selected ? 0 : -1}
                    type="button"
                  >
                    <span className="model-picker__label">
                      <strong>{family.label}</strong>
                    </span>
                    <span aria-hidden="true" className="model-picker__check">
                      {family.selected ? "✓" : ""}
                    </span>
                  </button>
                ))}
              </div>
            )
          ) : picker.status === "unavailable" || picker.status === "error" ? (
            <div className="model-picker__message" role="status">
              <span>{t.modelUnavailable}</span>
              <button
                onClick={() =>
                  postMessage({ type: "listModels", conversationId: picker.conversationId })
                }
                type="button"
              >
                {t.retryModels}
              </button>
            </div>
          ) : (
            <div className="model-picker__message" role="status">
              <span className="model-picker__spinner" />
              <span>{t.readingModels}</span>
            </div>
          )}
        </div>
      )}
      <span aria-live="polite" className="sr-only" role="status">
        {picker.errorCode ? t.modelUnavailable : `${t.modelApplied}: ${triggerLabel}`}
      </span>
    </div>
  );
}

const chatGptModeLabels = {
  "zh-CN": {
    smart: "智能",
    fast: "极速",
    low: "轻度",
    medium: "中",
    high: "高",
    "very-high": "极高",
    pro: "Pro",
  },
  en: {
    smart: "Smart",
    fast: "Instant",
    low: "Light",
    medium: "Medium",
    high: "High",
    "very-high": "Extra High",
    pro: "Pro",
  },
} as const;

const chatGptModeGroupLabels = {
  "zh-CN": {
    reasoning: "推理",
  },
  en: {
    reasoning: "Reasoning",
  },
} as const;

function compactFamilyLabel(value: string | undefined) {
  return value?.replace(/^GPT-/u, "") ?? "";
}

function modelTriggerLabel(option: ChatModelOption, labels: Record<string, string>) {
  const family = compactFamilyLabel(option.familyLabel);
  const showsMode = option.mode === "smart" || option.mode === "fast";
  const mode = option.mode ? labels[option.mode] : undefined;
  return [family, showsMode || !family ? mode : undefined].filter(Boolean).join(" ").trim();
}

function PendingContextList({
  automaticContextIds,
  conversationId,
  contexts,
  dismissRevision,
  locked,
  locale,
}: {
  automaticContextIds: string[];
  conversationId: string;
  contexts: ContextSnapshot[];
  dismissRevision: number;
  locked: boolean;
  locale: AppState["locale"];
}) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [previewContextId, setPreviewContextId] = useState<string>();
  const reviewRef = useRef<HTMLDivElement>(null);
  const reviewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const reviewId = useId();
  const previewId = useId();
  const t = strings[locale];
  const automaticIds = new Set(automaticContextIds);
  const totalChars = contexts.reduce((total, context) => total + context.charCount, 0);
  const delivery = contextDeliveryModes(contexts);
  const previewContext = contexts.find((context) => context.id === previewContextId);

  const closeReview = useCallback((restoreFocus: boolean) => {
    setReviewOpen(false);
    setPreviewContextId(undefined);
    if (restoreFocus) queueMicrotask(() => reviewTriggerRef.current?.focus());
  }, []);

  useLayoutEffect(() => {
    if (dismissRevision === 0) return;
    closeReview(false);
  }, [closeReview, dismissRevision]);

  useEffect(() => {
    if (!reviewOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (reviewRef.current?.contains(event.target as Node)) return;
      setReviewOpen(false);
      setPreviewContextId(undefined);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [reviewOpen]);

  useEffect(() => {
    if (!reviewOpen) return;
    queueMicrotask(() => reviewRef.current?.focus());
  }, [reviewOpen]);

  return (
    <section aria-label={t.attachedContexts} className="context-stack">
      <div className="context-stack__chips">
        {contexts.slice(0, 1).map((context) => (
          <div className={`context-chip context-chip--${context.kind}`} key={contextKey(context)}>
            <button
              aria-label={`${t.openContext}: ${context.fileName}, L${context.startLine}–${context.endLine}`}
              className="context-chip__main"
              onClick={() =>
                postMessage({
                  type: "openContext",
                  conversationId,
                  contextId: contextKey(context),
                })
              }
              type="button"
            >
              <span className="context-chip__icon">
                {context.kind === "selection" ? <CodeIcon /> : <FileIcon />}
              </span>
              <span className="context-chip__copy">
                <strong title={contextChipTitle(context)}>{context.fileName}</strong>
                <small>
                  L{context.startLine}–{context.endLine} · {context.charCount.toLocaleString()}{" "}
                  {t.characters}
                  {context.unsaved ? ` · ${t.unsaved}` : ""}
                </small>
              </span>
            </button>
            <IconButton
              disabled={locked}
              label={`${t.removeContext}: ${context.fileName}`}
              onClick={() =>
                postMessage({
                  type: "removeContext",
                  conversationId,
                  contextId: contextKey(context),
                })
              }
            >
              <CloseIcon />
            </IconButton>
          </div>
        ))}
        {contexts.length > 1 && (
          <button
            aria-label={`${t.reviewContexts}: +${contexts.length - 1}`}
            aria-controls={reviewId}
            aria-expanded={reviewOpen}
            aria-haspopup="dialog"
            className="context-chip context-chip--more"
            onClick={(event) => {
              reviewTriggerRef.current = event.currentTarget;
              setReviewOpen(true);
              setPreviewContextId(undefined);
            }}
            type="button"
          >
            +{contexts.length - 1}
          </button>
        )}
      </div>
      {reviewOpen && (
        <div
          aria-label={t.reviewContexts}
          className="context-review"
          id={reviewId}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            closeReview(true);
          }}
          ref={reviewRef}
          role="dialog"
          tabIndex={-1}
        >
          <div className="context-review__header">
            <strong>{t.reviewContexts}</strong>
            <span>
              {contexts.length} {t.contextItems} · {totalChars.toLocaleString()} {t.characters}
            </span>
            <IconButton label={t.closeContextReview} onClick={() => closeReview(true)}>
              <CloseIcon />
            </IconButton>
          </div>
          <div className="context-stack__items" role="list">
            {contexts.map((context) => (
              <PendingContextRow
                conversationId={conversationId}
                context={context}
                delivery={delivery.get(context.id) ?? "inline"}
                expanded={previewContextId === context.id}
                automatic={automaticIds.has(context.id)}
                key={contextKey(context)}
                locked={locked}
                locale={locale}
                onPreview={() =>
                  setPreviewContextId((current) =>
                    current === context.id ? undefined : context.id,
                  )
                }
                previewId={previewId}
              />
            ))}
          </div>
          {previewContext && (
            <pre className="context-preview context-review__preview" id={previewId}>
              {previewContext.content}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}

function PendingContextRow({
  automatic,
  conversationId,
  context,
  delivery,
  expanded,
  locked,
  locale,
  onPreview,
  previewId,
}: {
  automatic: boolean;
  conversationId: string;
  context: ContextSnapshot;
  delivery: "inline" | "file";
  expanded: boolean;
  locked: boolean;
  locale: AppState["locale"];
  onPreview: () => void;
  previewId: string;
}) {
  const t = strings[locale];
  return (
    <div className="context-row" role="listitem">
      <button
        aria-label={`${t.openContext}: ${context.fileName}, L${context.startLine}–${context.endLine}`}
        className="context-row__main"
        onClick={() =>
          postMessage({
            type: "openContext",
            conversationId,
            contextId: contextKey(context),
          })
        }
        type="button"
      >
        <span className="context-row__icon">
          {context.kind === "selection" ? <CodeIcon /> : <FileIcon />}
        </span>
        <span className="context-row__copy">
          <strong>{context.fileName}</strong>
          <small>
            {automatic ? `${t.defaultContext} · ` : ""}
            {context.language} · L{context.startLine}–{context.endLine} ·{" "}
            {context.charCount.toLocaleString()}
            {context.unsaved ? ` · ${t.unsaved}` : ""}
            {` · ${delivery === "file" ? t.sentAsFile : t.sentInline}`}
          </small>
        </span>
      </button>
      <button
        aria-controls={expanded ? previewId : undefined}
        aria-expanded={expanded}
        aria-label={`${t.previewContext}: ${context.fileName}`}
        className="context-row__preview-toggle"
        onClick={onPreview}
        type="button"
      >
        <ChevronIcon className={expanded ? "rotated" : ""} />
      </button>
      <IconButton
        disabled={locked}
        label={`${t.removeContext}: ${context.fileName}`}
        onClick={() =>
          postMessage({
            type: "removeContext",
            conversationId,
            contextId: contextKey(context),
          })
        }
      >
        <CloseIcon />
      </IconButton>
    </div>
  );
}

function ContextMenu({
  conversationId,
  id,
  locale,
  onClose,
}: {
  conversationId: string;
  id: string;
  locale: AppState["locale"];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const t = strings[locale];

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const handlePointerDown = (event: PointerEvent) => {
      const menuWrap = menuRef.current?.parentElement;
      if (!menuWrap || menuWrap.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [onClose]);

  return (
    <div
      aria-label={t.contextMenu}
      className="context-menu"
      id={id}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const items = [
          ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
        ];
        if (items.length === 0) return;
        event.preventDefault();
        const currentIndex = Math.max(
          0,
          items.indexOf(document.activeElement as HTMLButtonElement),
        );
        const nextIndex =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : event.key === "ArrowDown"
                ? (currentIndex + 1) % items.length
                : (currentIndex - 1 + items.length) % items.length;
        items[nextIndex]?.focus();
      }}
      ref={menuRef}
      role="menu"
    >
      <button
        onClick={() => {
          postMessage({ type: "attachCurrentFile", conversationId });
          onClose();
        }}
        role="menuitem"
      >
        <FileIcon />
        <span>
          <strong>{t.currentFile}</strong>
          <small>{t.fileDetail}</small>
        </span>
      </button>
      <div aria-hidden="true" className="context-menu__separator" />
      <button
        onClick={() => {
          postMessage({ type: "attachFiles", conversationId });
          onClose();
        }}
        role="menuitem"
      >
        <FilesIcon />
        <span>
          <strong>{t.chooseFiles}</strong>
          <small>{t.filesDetail}</small>
        </span>
      </button>
    </div>
  );
}

function HistoryPanel({
  activeId,
  conversations,
  dispatchingConversationIds,
  locale,
  onClose,
  onSelect,
}: {
  activeId: string;
  conversations: Conversation[];
  dispatchingConversationIds: string[];
  locale: AppState["locale"];
  onClose: () => void;
  onSelect: (conversationId: string) => void;
}) {
  const [view, setView] = useState<"recent" | "archived">("recent");
  const [lastArchived, setLastArchived] = useState<{ id: string; title: string }>();
  const [pendingArchive, setPendingArchive] = useState<{ id: string; title: string }>();
  const [pendingRestore, setPendingRestore] = useState<{
    activate: boolean;
    id: string;
  }>();
  const [menuConversationId, setMenuConversationId] = useState<string>();
  const [renamingConversationId, setRenamingConversationId] = useState<string>();
  const [renameValue, setRenameValue] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const t = strings[locale];
  const recentConversations = conversations.filter(
    (conversation) => !conversation.archivedAt && hasVisibleConversationMessages(conversation),
  );
  const archivedConversations = conversations.filter(
    (conversation) => conversation.archivedAt && hasVisibleConversationMessages(conversation),
  );
  const visibleConversations = view === "recent" ? recentConversations : archivedConversations;

  const restoreConversation = (conversationId: string, activate: boolean) => {
    if (pendingRestore?.id === conversationId) return;
    postMessage({ type: "unarchiveConversation", activate, conversationId });
    setPendingRestore({ activate, id: conversationId });
  };

  useEffect(() => {
    if (!pendingArchive) return;
    const conversation = conversations.find((item) => item.id === pendingArchive.id);
    if (!conversation?.archivedAt) return;
    setLastArchived(pendingArchive);
    setPendingArchive(undefined);
  }, [conversations, pendingArchive]);

  useEffect(() => {
    if (!pendingArchive) return;
    const timer = window.setTimeout(() => setPendingArchive(undefined), 5_000);
    return () => window.clearTimeout(timer);
  }, [pendingArchive]);

  useEffect(() => {
    if (!pendingRestore) return;
    const conversation = conversations.find((item) => item.id === pendingRestore.id);
    if (!conversation || conversation.archivedAt) return;
    if (lastArchived?.id === pendingRestore.id) setLastArchived(undefined);
    const activate = pendingRestore.activate;
    setPendingRestore(undefined);
    if (activate) onClose();
  }, [conversations, lastArchived, onClose, pendingRestore]);

  useEffect(() => {
    if (!pendingRestore) return;
    const timer = window.setTimeout(() => setPendingRestore(undefined), 5_000);
    return () => window.clearTimeout(timer);
  }, [pendingRestore]);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    setMenuConversationId(undefined);
    setRenamingConversationId(undefined);
  }, [view]);

  useEffect(() => {
    if (!renamingConversationId) return;
    queueMicrotask(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [renamingConversationId]);

  const beginRename = (conversation: Conversation) => {
    setMenuConversationId(undefined);
    setRenameValue(conversation.title);
    setRenamingConversationId(conversation.id);
  };

  const finishRename = (conversationId: string) => {
    const title = renameValue.trim();
    if (title) {
      postMessage({ type: "renameConversation", conversationId, title });
    }
    setRenamingConversationId(undefined);
    setRenameValue("");
  };

  return (
    <div
      className="history-overlay"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <aside
        aria-labelledby={titleId}
        aria-modal="true"
        className="history-panel"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== "Tab" || !panelRef.current) return;
          const focusable = [
            ...panelRef.current.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
            ),
          ];
          if (focusable.length === 0) {
            event.preventDefault();
            panelRef.current.focus();
            return;
          }
          const first = focusable[0]!;
          const last = focusable.at(-1)!;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="history-header">
          <h2 id={titleId}>{t.history}</h2>
          <IconButton label={t.close} onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </div>
        <div aria-label={t.historyViews} className="history-tabs" role="tablist">
          <button
            aria-selected={view === "recent"}
            onClick={() => setView("recent")}
            role="tab"
            type="button"
          >
            {t.recentChats}
          </button>
          <button
            aria-selected={view === "archived"}
            onClick={() => setView("archived")}
            role="tab"
            type="button"
          >
            {t.archivedChats}
            {archivedConversations.length > 0 ? ` (${archivedConversations.length})` : ""}
          </button>
        </div>
        <div aria-label={t.tasks} className="history-list" role="list">
          {visibleConversations.length === 0 ? (
            <p className="history-empty">
              {view === "recent" ? t.noRecentConversations : t.noArchivedConversations}
            </p>
          ) : (
            visibleConversations.map((conversation, index) => {
              const busy = Boolean(
                conversation.run ||
                conversation.queuedFollowUps?.length ||
                dispatchingConversationIds.includes(conversation.id),
              );
              const renaming = renamingConversationId === conversation.id;
              return (
                <div
                  className={`history-row ${conversation.id === activeId ? "history-row--active" : ""}`}
                  key={conversation.id}
                  role="listitem"
                >
                  {renaming ? (
                    <form
                      className="history-row__rename"
                      onSubmit={(event) => {
                        event.preventDefault();
                        finishRename(conversation.id);
                      }}
                    >
                      <input
                        aria-label={t.conversationName}
                        maxLength={80}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Escape") return;
                          event.preventDefault();
                          setRenamingConversationId(undefined);
                        }}
                        ref={renameInputRef}
                        value={renameValue}
                      />
                      <button disabled={!renameValue.trim()} type="submit">
                        {t.save}
                      </button>
                      <button onClick={() => setRenamingConversationId(undefined)} type="button">
                        {t.cancel}
                      </button>
                    </form>
                  ) : (
                    <button
                      aria-current={conversation.id === activeId ? "true" : undefined}
                      className="history-row__main"
                      disabled={view === "archived" && pendingRestore?.id === conversation.id}
                      onClick={() => {
                        if (view === "archived") {
                          restoreConversation(conversation.id, true);
                        } else {
                          onSelect(conversation.id);
                        }
                      }}
                      title={view === "archived" ? t.restoreConversation : conversation.title}
                    >
                      <span className="history-title">{conversation.title}</span>
                      <time dateTime={conversation.updatedAt}>
                        {formatRelativeTime(conversation.updatedAt, locale)}
                      </time>
                    </button>
                  )}
                  {!renaming && (
                    <div className="history-row__actions">
                      <IconButton
                        label={`${t.conversationActions}: ${conversation.title}`}
                        onClick={() =>
                          setMenuConversationId((current) =>
                            current === conversation.id ? undefined : conversation.id,
                          )
                        }
                      >
                        <MoreIcon />
                      </IconButton>
                      {menuConversationId === conversation.id && (
                        <HistoryConversationMenu
                          align={
                            visibleConversations.length > 2 &&
                            index >= visibleConversations.length - 2
                              ? "above"
                              : "below"
                          }
                          busy={busy}
                          conversation={conversation}
                          locale={locale}
                          onArchive={() => {
                            postMessage({
                              type: "archiveConversation",
                              conversationId: conversation.id,
                            });
                            setPendingArchive({
                              id: conversation.id,
                              title: conversation.title,
                            });
                            setMenuConversationId(undefined);
                          }}
                          onClose={() => setMenuConversationId(undefined)}
                          onDelete={() => {
                            postMessage({
                              type: "deleteConversation",
                              conversationId: conversation.id,
                            });
                            setMenuConversationId(undefined);
                          }}
                          onRename={() => beginRename(conversation)}
                          onRestore={() => {
                            restoreConversation(conversation.id, false);
                            setMenuConversationId(undefined);
                          }}
                          pending={
                            pendingArchive?.id === conversation.id ||
                            pendingRestore?.id === conversation.id
                          }
                          view={view}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
        {lastArchived && (
          <div aria-live="polite" className="history-undo" role="status">
            <span title={lastArchived.title}>{t.chatArchived}</span>
            <button
              disabled={pendingRestore?.id === lastArchived.id}
              onClick={() => restoreConversation(lastArchived.id, false)}
              type="button"
            >
              {t.undo}
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}

function HistoryConversationMenu({
  align,
  busy,
  conversation,
  locale,
  onArchive,
  onClose,
  onDelete,
  onRename,
  onRestore,
  pending,
  view,
}: {
  align: "above" | "below";
  busy: boolean;
  conversation: Conversation;
  locale: AppState["locale"];
  onArchive: () => void;
  onClose: () => void;
  onDelete: () => void;
  onRename: () => void;
  onRestore: () => void;
  pending: boolean;
  view: "recent" | "archived";
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const t = strings[locale];

  useEffect(() => {
    queueMicrotask(() => menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
    const closeOutside = (event: PointerEvent) => {
      const wrap = menuRef.current?.parentElement;
      if (!wrap?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [onClose]);

  return (
    <div
      aria-label={
        confirmDelete
          ? `${t.confirmDeleteConversation}: ${conversation.title}`
          : `${t.conversationActions}: ${conversation.title}`
      }
      className={`history-conversation-menu history-conversation-menu--${align} ${
        confirmDelete ? "history-conversation-menu--confirm" : ""
      }`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          if (confirmDelete) setConfirmDelete(false);
          else onClose();
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const items = [
          ...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
        ];
        if (items.length === 0) return;
        event.preventDefault();
        const currentIndex = Math.max(
          0,
          items.indexOf(document.activeElement as HTMLButtonElement),
        );
        const nextIndex =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : event.key === "ArrowDown"
                ? (currentIndex + 1) % items.length
                : (currentIndex - 1 + items.length) % items.length;
        items[nextIndex]?.focus();
      }}
      ref={menuRef}
      role={confirmDelete ? "alertdialog" : "menu"}
    >
      {confirmDelete ? (
        <>
          <p>{t.confirmDeleteConversation}</p>
          <div className="history-conversation-menu__confirm-actions">
            <button onClick={() => setConfirmDelete(false)} type="button">
              {t.cancel}
            </button>
            <button className="danger-action" onClick={onDelete} type="button">
              {t.delete}
            </button>
          </div>
        </>
      ) : (
        <>
          <button onClick={onRename} role="menuitem" type="button">
            <EditIcon />
            <span>{t.rename}</span>
          </button>
          {view === "recent" ? (
            <button disabled={busy || pending} onClick={onArchive} role="menuitem" type="button">
              <ArchiveIcon />
              <span>{t.archiveConversation}</span>
            </button>
          ) : (
            <button disabled={pending} onClick={onRestore} role="menuitem" type="button">
              <RefreshIcon />
              <span>{t.restoreConversation}</span>
            </button>
          )}
          <div aria-hidden="true" className="history-conversation-menu__separator" />
          <button
            className="danger-action"
            disabled={busy || pending}
            onClick={() => setConfirmDelete(true)}
            role="menuitem"
            type="button"
          >
            <TrashIcon />
            <span>{t.delete}</span>
          </button>
        </>
      )}
    </div>
  );
}

function IconButton({
  children,
  disabled,
  expanded,
  label,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  expanded?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-expanded={expanded}
      aria-label={label}
      className="icon-button"
      disabled={disabled}
      onClick={onClick}
      title={label}
    >
      {children}
    </button>
  );
}

function formatDate(value: string, locale: AppState["locale"]) {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatRelativeTime(value: string, locale: AppState["locale"]) {
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  if (elapsed < 60_000) return formatter.format(0, "second");
  if (elapsed < 60 * 60_000) return formatter.format(-Math.floor(elapsed / 60_000), "minute");
  if (elapsed < 24 * 60 * 60_000) {
    return formatter.format(-Math.floor(elapsed / (60 * 60_000)), "hour");
  }
  if (elapsed < 7 * 24 * 60 * 60_000) {
    return formatter.format(-Math.floor(elapsed / (24 * 60 * 60_000)), "day");
  }
  return formatDate(value, locale);
}

const strings = {
  "zh-CN": {
    brandName: "Ask2GPT",
    home: "Ask2GPT 首页",
    tasks: "聊天",
    localHistory: "跨设备同步",
    noRecentConversations: "开始聊天后，最近聊天会显示在这里。",
    noArchivedConversations: "归档的聊天会显示在这里。",
    viewAll: "查看全部",
    modelPicker: "选择模型",
    chooseModel: "模型",
    currentChatGptModel: "当前模型",
    modelUnavailable: "暂时无法更新模型，将继续使用当前模型。",
    retryModels: "重试",
    readingModels: "正在后台准备模型…",
    syncingModels: "正在后台同步，不影响继续输入",
    applyingModel: "正在应用到下一条消息",
    modelApplied: "已选择模式",
    cachedModels: "使用最近模型列表；连接恢复后自动更新",
    directConnectionStartingTitle: "正在连接",
    directConnectionStartingDetail: "正在建立连接，通常只需几秒。",
    directBrowserUnavailableTitle: "连接不可用",
    directBrowserUnavailableDetail: "请确认 Ask2GPT 浏览器组件已启用，然后重新检查。",
    directConnectionRefreshTitle: "需要重新连接",
    directConnectionRefreshDetail:
      "请从 Chrome 工具栏重新加载 Ask2GPT Relay，然后重新连接；草稿和对话不会丢失。",
    directSyncingTitle: "正在准备会话",
    directSyncingDetail: "连接已建立，正在同步当前会话状态。",
    directReconnectingTitle: "正在恢复连接",
    directReconnectingDetail: "正在自动重连；问题不会被重复发送。",
    reconnect: "重新连接",
    syncLocal: "尚未同步",
    syncPending: "等待同步",
    syncInProgress: "正在同步",
    syncComplete: "已同步",
    syncError: "同步异常",
    localTitle: "本地标题",
    connectionReady: "可以提问",
    connectionConnecting: "正在连接",
    connectionSetupNeeded: "需要设置",
    connectionProblem: "连接异常",
    connectionAttention: "需要处理",
    connectionReadyDetail: "已就绪，可以提问。",
    projectRequiredTitle: "正在准备会话",
    versionMismatchTitle: "两个扩展版本不兼容",
    versionMismatchDetail:
      "从 Chrome 工具栏打开 Ask2GPT Relay 并选择“重新加载 Relay”，然后在 VS Code 运行 Developer: Reload Window。草稿和对话不会丢失。",
    localServerErrorTitle: "无法启动本机连接",
    localServerErrorDetail: "本机连接端口不可用。关闭不再使用的 VS Code 窗口后重新检测。",
    attentionTitle: "需要你在浏览器中完成操作",
    attentionDetail: "请在打开的页面完成登录、验证或其他提示；当前问题尚未发送。",
    loginRequiredTitle: "请先完成登录",
    loginRequiredDetail: "登录完成后返回 Ask2GPT，连接会自动恢复；当前问题尚未发送。",
    projectMismatchTitle: "关联会话已发生变化",
    projectMismatchDetail:
      "同步已暂停且不会自动重发问题。请打开此前关联的会话，或重新连接当前会话。",
    checkAgain: "重新检查",
    retryNow: "立即重试",
    generateNewCode: "重新连接",
    openLoginPage: "打开登录页",
    goHandleInChatGpt: "前往处理",
    connectionCode: "连接状态",
    codeExpiresAt: "最近检查",
    technicalDetails: "技术详情",
    connectionPhase: "连接阶段",
    chromeCompanion: "Chrome 伴生扩展",
    detected: "已发现",
    notDetected: "未发现",
    savedConnection: "已保存连接",
    available: "有",
    notAvailable: "无",
    localPort: "本机端口",
    hostVersion: "Host 版本",
    relayVersion: "Relay 版本",
    protocol: "协议",
    detectedProtocol: "检测到的协议",
    errorCode: "错误码",
    errorDetail: "错误详情",
    lastConnected: "最近连接",
    rebuildConnection: "重新检查连接…",
    composerWaitingForConnection: "连接建立后即可发送；可以先输入问题…",
    composerWaitingForBrowser: "连接恢复后即可发送；可以先输入问题…",
    composerAuthenticating: "连接建立后即可发送；可以先输入问题…",
    composerSyncing: "状态同步完成后即可发送；可以先输入问题…",
    composerReconnecting: "连接恢复后即可发送；无需额外设置…",
    composerVersionMismatch: "更新并重新加载两个扩展后即可发送…",
    composerTrustMismatch: "恢复本机连接后即可发送；草稿会保留…",
    composerLocalServerError: "本机连接恢复后即可发送；草稿会保留…",
    composerAttention: "完成页面操作后即可发送；草稿会保留…",
    projectInstruction: "正在恢复会话设置；首次使用时，请在打开的页面完成一次设置。",
    openChatGptProject: "继续设置",
    projectComposerBlocked: "完成首次设置后即可提问",
    backendError: "需要完成页面操作",
    transcript: "问答记录",
    openChatGpt: "打开浏览器会话",
    yourQuestion: "你的问题",
    answer: "回答",
    regenerate: "重新生成",
    retry: "重试",
    stopped: "已停止",
    failed: "生成失败",
    answerInterrupted: "回答已中断",
    answerMissing: "未收到回答",
    attachedContext: "已附加上下文",
    attachedContexts: "已附加的代码上下文",
    defaultContext: "代码上下文",
    sentContexts: "随问题发送的代码上下文",
    attached: "已附加",
    contextItems: "项",
    characters: "字符",
    showMoreContexts: "显示更多代码上下文",
    showFewerContexts: "收起代码上下文",
    showLess: "收起",
    sentAsFile: "作为代码文件发送",
    sentInline: "内联到问题",
    fileAttachments: "个文件",
    inlineContexts: "个内联片段",
    reviewContexts: "审阅代码上下文",
    closeContextReview: "关闭上下文审阅",
    previewContext: "预览上下文",
    openContext: "在编辑器中打开",
    removeContext: "移除上下文",
    unsaved: "未保存",
    composerLabel: "向 Ask2GPT 提问",
    composerKeyboardHint: "按 Enter 发送，Shift+Enter 换行",
    composerKeyboardHintCmdIfMultiline: "单行按 Enter 发送；多行按 Ctrl/Cmd+Enter 发送",
    composerKeyboardHintCmdAlways: "按 Ctrl/Cmd+Enter 发送，Enter 换行",
    composerPlaceholder: "描述任务，或询问代码与架构…",
    composerFollowUpPlaceholder: "补充要求，或提出下一步修改…",
    composerWorking: "正在处理…",
    generating: "正在生成回答…",
    generatingStatus: "回答正在生成",
    nextQuestion: "输入后按 Enter，加入下一条…",
    interruptNextQuestion: "输入后停止当前回答并发送…",
    queuedFollowUps: "已排队",
    queuePaused: "当前回答已停止或失败；队列已暂停，不会自动发送。",
    resumeQueue: "继续队列",
    editQueuedFollowUp: "编辑排队消息",
    removeQueuedFollowUp: "移除排队消息",
    sending: "正在发送…",
    stillGenerating: "回答仍在生成；会话将保持连接…",
    runSubmitting: "正在提交…",
    runWaiting: "已提交，等待回答",
    runReceiving: "正在接收回答",
    runBackground: "回答仍在后台生成；无需打开浏览器",
    runRecovering: "正在自动恢复连接；不会重复发送",
    runStopping: "正在停止…",
    addContext: "添加上下文",
    currentFile: "当前文件",
    fileDetail: "读取当前编辑器缓冲区",
    chooseFiles: "选择文件…",
    filesDetail: "显式选择并打包多个代码文件",
    context: "上下文",
    contextMenu: "选择上下文",
    composerRegion: "问题输入",
    noAgent: "不使用 Agent",
    stop: "停止生成",
    send: "发送",
    queue: "排队",
    interruptAndSend: "停止后发送",
    queueDetail: "排队：当前回答结束后发送",
    interruptDetail: "停止当前回答，然后发送这条消息",
    useInterruptOnce: "临时改为停止后发送",
    useQueueOnce: "临时改为排队",
    scrollToBottom: "回到底部",
    userMessages: "用户问题",
    jumpToQuestion: "跳转到问题",
    history: "最近聊天",
    localOnly: "仅本地管理",
    close: "关闭",
    newConversation: "新聊天",
    conversationActions: "聊天操作",
    archiveConversation: "归档聊天",
    restoreConversation: "恢复聊天",
    historyViews: "聊天视图",
    recentChats: "最近",
    archivedChats: "已归档",
    chatArchived: "聊天已归档",
    undo: "撤销",
    save: "保存",
    rename: "重命名",
    conversationName: "会话名称",
    delete: "删除",
    confirmDeleteConversation: "永久删除这条聊天？",
    confirm: "确认",
    cancel: "取消",
    copyDiagnostics: "复制脱敏诊断信息",
  },
  en: {
    brandName: "Ask2GPT",
    home: "Ask2GPT home",
    tasks: "Chats",
    localHistory: "Synced across devices",
    noRecentConversations: "Your recent chats will appear here after you start chatting.",
    noArchivedConversations: "Archived chats will appear here.",
    viewAll: "View all",
    modelPicker: "Choose model",
    chooseModel: "Model",
    currentChatGptModel: "Current model",
    modelUnavailable: "Models cannot be updated right now. The current model stays active.",
    retryModels: "Retry",
    readingModels: "Preparing models in the background…",
    syncingModels: "Syncing in the background; you can keep typing",
    applyingModel: "Applying to the next message",
    modelApplied: "Mode selected",
    cachedModels: "Using the recent list; it will refresh when the connection recovers",
    directConnectionStartingTitle: "Connecting",
    directConnectionStartingDetail:
      "Establishing the connection. This normally takes a few seconds.",
    directBrowserUnavailableTitle: "Connection unavailable",
    directBrowserUnavailableDetail:
      "Make sure the Ask2GPT browser companion is enabled, then check again.",
    directConnectionRefreshTitle: "Reconnect required",
    directConnectionRefreshDetail:
      "Reload Ask2GPT Relay from the Chrome toolbar, then reconnect. Drafts and chats are preserved.",
    directSyncingTitle: "Preparing the chat",
    directSyncingDetail: "The connection is ready and the current conversation is syncing.",
    directReconnectingTitle: "Restoring the connection",
    directReconnectingDetail: "Reconnecting automatically. Your question will not be sent twice.",
    reconnect: "Reconnect",
    syncLocal: "Not synced yet",
    syncPending: "Waiting to sync",
    syncInProgress: "Syncing",
    syncComplete: "Synced",
    syncError: "Sync issue",
    localTitle: "Local title",
    connectionReady: "Ready to ask",
    connectionConnecting: "Connecting",
    connectionSetupNeeded: "Setup needed",
    connectionProblem: "Connection issue",
    connectionAttention: "Needs attention",
    connectionReadyDetail: "Ready. You can ask a question.",
    projectRequiredTitle: "Preparing the chat",
    versionMismatchTitle: "The two extensions are incompatible",
    versionMismatchDetail:
      "Open Ask2GPT Relay from the Chrome toolbar and select Reload Relay, then run Developer: Reload Window in VS Code. Drafts and chats are preserved.",
    localServerErrorTitle: "The local connection could not start",
    localServerErrorDetail:
      "The local connection ports are unavailable. Close unused VS Code windows and check again.",
    attentionTitle: "Complete an action in the browser",
    attentionDetail:
      "Complete sign-in, verification, or another prompt on the opened page. Your question has not been sent.",
    loginRequiredTitle: "Complete sign-in",
    loginRequiredDetail:
      "Return to Ask2GPT after signing in; the connection will resume automatically. Nothing was sent.",
    projectMismatchTitle: "The linked chat changed",
    projectMismatchDetail:
      "Sync paused and the question will not be replayed. Open the previously linked chat or reconnect the current one.",
    checkAgain: "Check again",
    retryNow: "Retry now",
    generateNewCode: "Reconnect",
    openLoginPage: "Open sign-in",
    goHandleInChatGpt: "Open required tab",
    connectionCode: "Connection status",
    codeExpiresAt: "Last checked",
    technicalDetails: "Technical details",
    connectionPhase: "Connection phase",
    chromeCompanion: "Chrome companion",
    detected: "Detected",
    notDetected: "Not detected",
    savedConnection: "Saved connection",
    available: "Available",
    notAvailable: "Unavailable",
    localPort: "Local port",
    hostVersion: "Host version",
    relayVersion: "Relay version",
    protocol: "Protocol",
    detectedProtocol: "Detected protocol",
    errorCode: "Error code",
    errorDetail: "Error detail",
    lastConnected: "Last connected",
    rebuildConnection: "Check connection again…",
    composerWaitingForConnection: "You can draft now and send when the connection is ready…",
    composerWaitingForBrowser: "Send when the connection recovers; you can keep drafting…",
    composerAuthenticating: "Send when the connection is ready; keep drafting…",
    composerSyncing: "You can send when status sync completes; keep drafting…",
    composerReconnecting: "Send after reconnection; no setup is required…",
    composerVersionMismatch: "Update and reload both extensions before sending…",
    composerTrustMismatch: "Restore the local connection to send; your draft is safe…",
    composerLocalServerError: "Restore the local connection to send; your draft is safe…",
    composerAttention: "Complete the page action to send; your draft is safe…",
    projectInstruction:
      "Restoring the chat setup. On first use, complete setup once on the opened page.",
    openChatGptProject: "Continue setup",
    projectComposerBlocked: "Complete first-time setup to ask a question",
    backendError: "A page action is required",
    transcript: "Q&A transcript",
    openChatGpt: "Open browser chat",
    yourQuestion: "Your question",
    answer: "Answer",
    regenerate: "Regenerate",
    retry: "Retry",
    stopped: "Stopped",
    failed: "Generation failed",
    answerInterrupted: "Answer interrupted",
    answerMissing: "No answer received",
    attachedContext: "Attached context",
    attachedContexts: "Attached code context",
    defaultContext: "Code context",
    sentContexts: "Code context sent with this question",
    attached: "Attached",
    contextItems: "items",
    characters: "characters",
    showMoreContexts: "Show more code context",
    showFewerContexts: "Show fewer code contexts",
    showLess: "Show less",
    sentAsFile: "sent as a code file",
    sentInline: "inlined in the question",
    fileAttachments: "files",
    inlineContexts: "inline snippets",
    reviewContexts: "Review code context",
    closeContextReview: "Close context review",
    previewContext: "Preview context",
    openContext: "Open in editor",
    removeContext: "Remove context",
    unsaved: "Unsaved",
    composerLabel: "Ask Ask2GPT",
    composerKeyboardHint: "Press Enter to send, Shift+Enter for a new line",
    composerKeyboardHintCmdIfMultiline:
      "Enter sends a single line; Ctrl/Cmd+Enter sends a multiline draft",
    composerKeyboardHintCmdAlways: "Press Ctrl/Cmd+Enter to send; Enter inserts a new line",
    composerPlaceholder: "Describe a task or ask about code…",
    composerFollowUpPlaceholder: "Add a requirement or request the next change…",
    composerWorking: "Working…",
    generating: "Generating an answer…",
    generatingStatus: "Answer generation in progress",
    nextQuestion: "Press Enter to queue the next message…",
    interruptNextQuestion: "Send to stop the current answer and continue…",
    queuedFollowUps: "Queued",
    queuePaused: "The previous turn stopped or failed. The queue is paused.",
    resumeQueue: "Resume",
    editQueuedFollowUp: "Edit queued message",
    removeQueuedFollowUp: "Remove queued message",
    sending: "Sending…",
    stillGenerating: "The answer is still generating; the chat remains connected…",
    runSubmitting: "Submitting…",
    runWaiting: "Submitted; waiting for an answer",
    runReceiving: "Receiving the answer",
    runBackground: "The answer is still generating in the background; keep working here",
    runRecovering: "Restoring the connection automatically; this will not resend",
    runStopping: "Stopping…",
    addContext: "Add context",
    currentFile: "Current file",
    fileDetail: "Read the active editor buffer",
    chooseFiles: "Choose files…",
    filesDetail: "Explicitly select and bundle code files",
    context: "Context",
    contextMenu: "Choose context",
    composerRegion: "Question input",
    noAgent: "No agent actions",
    stop: "Stop generating",
    send: "Send",
    queue: "Queue",
    interruptAndSend: "Stop and send",
    queueDetail: "Queue: send after the current answer finishes",
    interruptDetail: "Stop the current answer, then send this message",
    useInterruptOnce: "to stop and send once",
    useQueueOnce: "to queue once",
    scrollToBottom: "Jump to latest",
    userMessages: "User messages",
    jumpToQuestion: "Jump to question",
    history: "Recent chats",
    localOnly: "Local management only",
    close: "Close",
    newConversation: "New chat",
    conversationActions: "Chat actions",
    archiveConversation: "Archive chat",
    restoreConversation: "Restore chat",
    historyViews: "Chat views",
    recentChats: "Recent",
    archivedChats: "Archived",
    chatArchived: "Chat archived",
    undo: "Undo",
    save: "Save",
    rename: "Rename",
    conversationName: "Conversation name",
    delete: "Delete",
    confirmDeleteConversation: "Permanently delete this chat?",
    confirm: "Confirm",
    cancel: "Cancel",
    copyDiagnostics: "Copy redacted diagnostics",
  },
} as const;

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(<App />);
}
