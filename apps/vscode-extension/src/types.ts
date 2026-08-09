import type {
  ChatModelOption,
  ChatFileAttachment,
  ContextSnapshot,
  Conversation,
  ConversationCanonicalizationResultPayload,
  ConversationMessage,
  ConversationLeasePurpose,
  ConversationReleaseReason,
  ConversationSnapshotPayload,
  ConversationTranscriptProof,
  PendingRemotePromotion,
  RelayErrorPayload,
  RelayStatusPayload,
} from "@ask2gpt/protocol";

import type { ComposerPreferences } from "./composer-preferences";

export type ConnectionPhase =
  | "starting"
  | "waiting-for-browser"
  | "pairing-required"
  | "authenticating"
  | "syncing"
  | "project-required"
  | "ready"
  | "reconnecting"
  | "version-mismatch"
  | "trust-mismatch"
  | "local-server-error"
  | "attention";

export interface ConnectionStatus {
  phase: ConnectionPhase;
  since: string;
  browserDetected: boolean;
  hasStoredTrust: boolean;
  hostVersion?: string;
  relayVersion?: string;
  protocolVersion?: number;
  lastConnectedAt?: string;
  detectedProtocol?: string;
  errorCode?: string;
}

export interface BackendStatus {
  connected: boolean;
  authenticated: boolean;
  activeRuns: number;
  port?: number;
  selectorVersion: number;
  project?: RelayStatusPayload["project"];
  error?: RelayErrorPayload;
  connection: ConnectionStatus;
}

export interface SendRequest {
  conversationId: string;
  messageId: string;
  runId: string;
  prompt: string;
  attachments?: ChatFileAttachment[];
  remoteUrl?: string;
  modelId?: string;
  transcriptProof?: ConversationTranscriptProof;
}

export interface RunHandle {
  conversationId: string;
  runId: string;
  startedAt: string;
}

export type BackendEvent =
  | {
      type: "title";
      conversationId: string;
      title: string;
      remoteUrl: string;
      observedAt: string;
    }
  | ({
      type: "history";
      conversationId: string;
    } & ConversationSnapshotPayload)
  | {
      type: "snapshot";
      conversationId: string;
      runId: string;
      markdown: string;
      remoteUrl?: string;
    }
  | {
      type: "complete";
      conversationId: string;
      runId: string;
      markdown: string;
      remoteUrl?: string;
      terminalTranscriptSha256?: string;
      terminalEventId: string;
    }
  | {
      type: "slow";
      conversationId: string;
      runId: string;
      remoteUrl?: string;
    }
  | {
      type: "stopped";
      conversationId: string;
      runId: string;
      markdown?: string;
      remoteUrl?: string;
      terminalTranscriptSha256?: string;
      terminalEventId: string;
    }
  | {
      type: "error";
      conversationId?: string;
      runId?: string;
      terminalEventId?: string;
      error: RelayErrorPayload;
    }
  | {
      type: "status";
      status: RelayStatusPayload & { connection?: ConnectionStatus };
    };

export interface ChatBackend {
  getStatus(): Promise<BackendStatus>;
  prepareConversation(
    conversationId: string,
    remoteUrl?: string,
    transcriptProof?: ConversationTranscriptProof,
    dispatchIntent?: boolean,
  ): Promise<void>;
  settlePendingRemotePromotion(
    conversationId: string,
    promotion: PendingRemotePromotion,
  ): Promise<ConversationCanonicalizationResultPayload>;
  send(request: SendRequest): Promise<RunHandle>;
  stop(conversationId: string, runId: string): Promise<void>;
  regenerate(
    conversationId: string,
    messageId: string,
    runId: string,
    remoteUrl?: string,
  ): Promise<RunHandle>;
  listModels(conversationId: string, remoteUrl?: string): Promise<ChatModelOption[]>;
  selectModel(
    conversationId: string,
    modelId: string,
    remoteUrl?: string,
  ): Promise<ChatModelOption>;
  /** Relinquishes an idle page lease without deleting conversation or run state. */
  releaseConversation?(
    conversationId: string,
    purpose?: ConversationLeasePurpose,
    reason?: ConversationReleaseReason,
  ): Promise<boolean>;
  closeConversation(conversationId: string): Promise<boolean>;
  acknowledgeTerminal(conversationId: string, runId: string, eventId: string): Promise<void>;
  onEvent(listener: (event: BackendEvent) => void): { dispose(): void };
  dispose(): Promise<void>;
}

export interface ModelPickerState {
  conversationId: string;
  status: "idle" | "loading" | "ready" | "selecting" | "unavailable" | "error";
  options: ChatModelOption[];
  currentModelId?: string;
  errorCode?: string;
  syncing?: boolean;
  stale?: boolean;
}

export interface SourceTraceHint {
  /** Exact textual references proven to address this turn's attached context. */
  fileReferences: string[];
  /** Definition names proven to exist inside this turn's attached snapshots. */
  sourceSymbols: string[];
}

export interface AppState {
  activeConversationId: string;
  conversations: Conversation[];
  pendingContexts: ContextSnapshot[];
  automaticContextIds: string[];
  contextLocked: boolean;
  /** Conversation-scoped dispatch locks let the webview preserve drafts safely across switches. */
  dispatchingConversationIds?: string[];
  backend: BackendStatus;
  modelPicker: ModelPickerState;
  /** Optional for compatibility with retained webviews created by an older host. */
  composerPreferences?: ComposerPreferences;
  /** Host-derived, non-persisted source affordances scoped by conversation and message ID. */
  sourceTraceHints?: Record<string, Record<string, SourceTraceHint>>;
  locale: "zh-CN" | "en";
}

export interface GenerationViewUpdate {
  conversationId: string;
  messageId: string;
  runId: string;
  markdown: string;
  updatedAt: string;
}

export type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "newConversation"; sourceConversationId: string }
  | { type: "selectConversation"; conversationId: string }
  | { type: "renameConversation"; conversationId: string; title: string }
  | { type: "archiveConversation"; conversationId: string }
  | { type: "unarchiveConversation"; activate: boolean; conversationId: string }
  | { type: "deleteConversation"; conversationId: string }
  | { type: "prepareConversation"; conversationId: string }
  | { type: "send"; conversationId: string; requestId: string; text: string }
  | {
      type: "enqueueFollowUp";
      conversationId: string;
      requestId: string;
      targetRunId: string;
      text: string;
    }
  | {
      type: "interruptWithFollowUp";
      conversationId: string;
      requestId: string;
      targetRunId: string;
      text: string;
    }
  | { type: "updateQueuedFollowUp"; conversationId: string; queueId: string; text: string }
  | { type: "removeQueuedFollowUp"; conversationId: string; queueId: string }
  | { type: "resumeQueue"; conversationId: string }
  | { type: "stop"; conversationId: string; targetRunId: string }
  | { type: "regenerate"; conversationId: string; messageId: string }
  | { type: "attachSelection"; conversationId: string }
  | { type: "attachNotebookCell"; conversationId: string }
  | { type: "attachCurrentFile"; conversationId: string }
  | { type: "attachFiles"; conversationId: string }
  | { type: "removeContext"; conversationId: string; contextId: string }
  | { type: "openContext"; conversationId: string; contextId: string }
  | {
      type: "openSourceReference";
      conversationId: string;
      messageId: string;
      kind: "file-line" | "symbol";
      reference: string;
    }
  | { type: "copy"; text: string }
  | { type: "retryConnection" }
  | { type: "openChatGpt" }
  | { type: "openExternal"; url: string }
  | { type: "listModels"; conversationId: string }
  | { type: "selectModel"; conversationId: string; modelId: string }
  | { type: "copyDiagnostics" };

export type HostToWebviewMessage =
  | { type: "state"; state: AppState }
  | { type: "generationUpdate"; update: GenerationViewUpdate }
  | { type: "notice"; level: "info" | "warning" | "error"; message: string }
  | { type: "sendResult"; accepted: boolean; conversationId: string; requestId: string }
  | { type: "focusComposer" }
  | { type: "revealTurn"; conversationId: string; messageId: string; contextId?: string };

export function latestUserMessage(messages: ConversationMessage[]) {
  return [...messages].reverse().find((message) => message.role === "user");
}
