import { z } from "zod";

import {
  PROTOCOL_VERSION,
  RELAY_STATUS_REQUEST_TYPE,
  RELAY_WEBSOCKET_PROTOCOL,
  isRelayProductVersionCompatible,
  isRelayStatusRequestPayload,
  makeRelayStatusRequestPayload,
  type RelayStatusRequestPayload,
} from "./runtime-contract.mjs";

export {
  PROTOCOL_VERSION,
  RELAY_STATUS_REQUEST_TYPE,
  RELAY_WEBSOCKET_PROTOCOL,
  isRelayProductVersionCompatible,
  isRelayStatusRequestPayload,
  makeRelayStatusRequestPayload,
};
export type { RelayStatusRequestPayload };

// Version 14 adds a content-free transcript proof that the Host can prewarm
// before dispatch. Version 13 added durable terminal delivery acknowledgements.
// Product versions are matched during relay.hello, with only explicitly
// reviewed hot-upgrade pairs accepted.
export const RELAY_PORTS = Object.freeze(Array.from({ length: 10 }, (_, index) => 32_171 + index));
export const MAX_RELAY_FRAME_BYTES = 2 * 1024 * 1024;
export const MAX_CONCURRENT_RUNS = 3;
export const MAX_CHAT_FILE_ATTACHMENTS = 8;
export const MAX_CHAT_FILE_CHARS = 40_000;
export const MAX_CHAT_FILE_BUNDLE_CHARS = 60_000;
export const MAX_INLINE_CONTEXT_CHARS = 6_000;
export const MAX_INLINE_CONTEXT_BUNDLE_CHARS = 12_000;
// Migration-only compatibility for records written before 0.1.9. New runs use
// the lifetime of the exact owned-tab run and do not start this short timer.
export const REMOTE_CANONICALIZATION_WINDOW_MS = 30_000;
export const CHROME_EXTENSION_ID = "jieljndeocnmdlfbmfknfgglfaoneceb";

export const relayMessageTypes = [
  "relay.hello",
  "relay.ready",
  "heartbeat",
  "relay.status",
  RELAY_STATUS_REQUEST_TYPE,
  "conversation.open",
  "conversation.canonicalization.check",
  "conversation.canonicalization.result",
  "conversation.title",
  "conversation.snapshot",
  "conversation.send",
  "conversation.close",
  "conversation.closed",
  "model.list",
  "model.catalog",
  "model.select",
  "model.selected",
  "generation.snapshot",
  "generation.slow",
  "generation.complete",
  "generation.ack",
  "generation.stop",
  "generation.stopped",
  "generation.regenerate",
  "relay.error",
] as const;

export const chromeToHostMessageTypes = [
  "relay.hello",
  "heartbeat",
  "relay.status",
  "conversation.canonicalization.result",
  "conversation.title",
  "conversation.snapshot",
  "conversation.closed",
  "model.catalog",
  "model.selected",
  "generation.snapshot",
  "generation.slow",
  "generation.complete",
  "generation.stopped",
  "relay.error",
] as const;

export const hostToChromeMessageTypes = [
  "relay.ready",
  "heartbeat",
  RELAY_STATUS_REQUEST_TYPE,
  "conversation.open",
  "conversation.canonicalization.check",
  "conversation.send",
  "conversation.close",
  "model.list",
  "model.select",
  "generation.stop",
  "generation.ack",
  "generation.regenerate",
  "relay.error",
] as const;

export type RelayMessageType = (typeof relayMessageTypes)[number];
export type ChromeToHostMessageType = (typeof chromeToHostMessageTypes)[number];
export type HostToChromeMessageType = (typeof hostToChromeMessageTypes)[number];

export const relayErrorCodes = [
  "AUTH_REQUIRED",
  "AUTH_FAILED",
  "PAIRING_MISMATCH",
  "PAIRING_CODE_INVALID",
  "PAIRING_CODE_EXPIRED",
  "PROTOCOL_MISMATCH",
  "FRAME_TOO_LARGE",
  "CHROME_DISCONNECTED",
  "CONCURRENT_RUN_LIMIT",
  "CONVERSATION_BUSY",
  "CHATGPT_LOGIN_REQUIRED",
  "CHATGPT_CHALLENGE_REQUIRED",
  "CHATGPT_PROJECT_REQUIRED",
  "CHATGPT_PROJECT_MISMATCH",
  "CHATGPT_COMPOSER_MISSING",
  "CHATGPT_ATTACHMENT_FAILED",
  "CHATGPT_SEND_FAILED",
  "CHATGPT_REMOTE_UNAVAILABLE",
  "CHATGPT_MODEL_UNAVAILABLE",
  "CHATGPT_MODEL_SELECTION_FAILED",
  "REGENERATE_CONTROL_UNAVAILABLE",
  "RESPONSE_TIMEOUT",
  "SELECTOR_INCOMPATIBLE",
  "INTERNAL_ERROR",
] as const;

export type RelayErrorCode = (typeof relayErrorCodes)[number];

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  // ":" is intentionally excluded because the Chrome relay joins IDs with a colon.
  .regex(/^[A-Za-z0-9._-]+$/, "Identifier contains unsupported characters.");
const timestampSchema = z.string().datetime({ offset: true });
const chatGptUrlSchema = z
  .string()
  .url()
  .max(4_096)
  .refine(isAllowedChatGptUrl, "Only https://chatgpt.com URLs are allowed.");
const optionalChatGptUrlSchema = chatGptUrlSchema.optional();
const chatGptConversationUrlSchema = chatGptUrlSchema.refine(
  (value) => isChatGptConversationUrl(value),
  "Only canonical ChatGPT conversation URLs are allowed.",
);
const markdownSchema = z.string().max(MAX_RELAY_FRAME_BYTES);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const conversationTitleSchema = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value), {
    message: "Conversation title must be trimmed and contain no control characters.",
  })
  .refine((value) => !isGenericConversationTitle(value), {
    message: "Generic ChatGPT placeholders are not conversation titles.",
  });
export const relayErrorPayloadSchema = z
  .object({
    code: z.enum(relayErrorCodes),
    message: z.string().min(1).max(4_096),
    recoverable: z.boolean(),
    focusTab: z.boolean().optional(),
  })
  .strict();

const heartbeatPayloadSchema = z.object({ at: timestampSchema }).strict();
const relayStatusPayloadSchema = z
  .object({
    connected: z.boolean(),
    authenticated: z.boolean().optional(),
    activeRuns: z.number().int().min(0).max(MAX_CONCURRENT_RUNS),
    selectorVersion: z.number().int().min(1).max(1_000_000),
    project: z
      .discriminatedUnion("bound", [
        z.object({ bound: z.literal(false) }).strict(),
        z.object({ bound: z.literal(true), name: z.string().min(1).max(120) }).strict(),
      ])
      .optional(),
  })
  .strict();
const relayStatusRequestPayloadSchema = z.custom<RelayStatusRequestPayload>(
  isRelayStatusRequestPayload,
  "Invalid relay status request payload.",
);
const runtimeVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/, "Runtime version contains unsafe characters.");
const relayHelloPayloadSchema = z
  .object({
    chromeExtensionId: z.literal(CHROME_EXTENSION_ID),
    chromeVersion: runtimeVersionSchema,
  })
  .strict();
const relayReadyPayloadSchema = z
  .object({
    serverLabel: z.string().min(1).max(256),
    serverInstanceId: identifierSchema,
  })
  .strict();
const conversationTranscriptMessageProofSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    sha256: sha256Schema,
  })
  .strict();
const conversationTranscriptProofSchema = z
  .object({
    remoteUrl: chatGptConversationUrlSchema,
    messageCount: z.number().int().min(0).max(200),
    messageHashes: z.array(conversationTranscriptMessageProofSchema).max(200),
    transcriptChainSha256: sha256Schema,
  })
  .strict()
  .refine((proof) => proof.messageCount === proof.messageHashes.length, {
    message: "Transcript proof count does not match its message hashes.",
    path: ["messageCount"],
  });
const conversationOpenPayloadSchema = z
  .object({
    remoteUrl: optionalChatGptUrlSchema,
    active: z.boolean().optional(),
    dispatchIntent: z.boolean().optional(),
    transcriptProof: conversationTranscriptProofSchema.optional(),
  })
  .strict();
const conversationTitlePayloadSchema = z
  .object({
    title: conversationTitleSchema,
    remoteUrl: chatGptConversationUrlSchema,
    observedAt: timestampSchema,
  })
  .strict();
const conversationUrlPromotionProofSchema = z
  .object({
    runId: identifierSchema,
    fromRemoteUrl: chatGptConversationUrlSchema,
    terminalMarkdownSha256: sha256Schema,
    terminalTranscriptSha256: sha256Schema.optional(),
  })
  .strict();
const conversationSnapshotPayloadSchema = z
  .object({
    remoteUrl: chatGptConversationUrlSchema,
    title: conversationTitleSchema.optional(),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            markdown: z.string().max(200_000),
          })
          .strict(),
      )
      .max(200),
    observedAt: timestampSchema,
    complete: z.boolean(),
    urlPromotion: conversationUrlPromotionProofSchema.optional(),
  })
  .strict();
const conversationCanonicalizationCheckPayloadSchema = z
  .object({
    requestId: identifierSchema,
    runId: identifierSchema,
    fromRemoteUrl: chatGptConversationUrlSchema,
    terminalMarkdownSha256: sha256Schema,
    terminalTranscriptSha256: sha256Schema,
  })
  .strict();
const canonicalizationResultBindingShape = {
  requestId: identifierSchema,
  runId: identifierSchema,
  fromRemoteUrl: chatGptConversationUrlSchema,
  terminalMarkdownSha256: sha256Schema,
  terminalTranscriptSha256: sha256Schema,
};
const conversationCanonicalizationResultPayloadSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...canonicalizationResultBindingShape,
      status: z.literal("promoted"),
      snapshot: conversationSnapshotPayloadSchema.refine(
        (snapshot) => snapshot.complete && snapshot.urlPromotion !== undefined,
        "A promoted canonicalization result requires a complete proof-bearing snapshot.",
      ),
    })
    .strict(),
  z
    .object({
      ...canonicalizationResultBindingShape,
      status: z.enum(["unchanged", "expired"]),
      remoteUrl: chatGptConversationUrlSchema,
    })
    .strict(),
]);
const promptSchema = z
  .string()
  .transform((value) => value.replace(/\r\n?/g, "\n"))
  .pipe(z.string().min(1).max(100_000));
const modelIdSchema = identifierSchema.max(64);
const chatFileAttachmentSchema = z
  .object({
    id: identifierSchema,
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .refine((value) => !/[\\/\p{Cc}\p{Cf}]/u.test(value), {
        message: "Attachment filename is unsafe.",
      }),
    mimeType: z.string().trim().min(1).max(120),
    content: z.string().max(MAX_CHAT_FILE_CHARS),
  })
  .strict();
const conversationSendPayloadSchema = z
  .object({
    prompt: promptSchema,
    remoteUrl: optionalChatGptUrlSchema,
    messageId: identifierSchema,
    modelId: modelIdSchema.optional(),
    transcriptProof: conversationTranscriptProofSchema.optional(),
    attachments: z
      .array(chatFileAttachmentSchema)
      .max(MAX_CHAT_FILE_ATTACHMENTS)
      .refine(
        (attachments) =>
          attachments.reduce((total, attachment) => total + attachment.content.length, 0) <=
          MAX_CHAT_FILE_BUNDLE_CHARS,
        "Attachment bundle is too large.",
      )
      .optional(),
  })
  .strict();
const conversationClosePayloadSchema = z.object({ closeTab: z.boolean() }).strict();
const conversationClosedPayloadSchema = z
  .object({
    requestId: identifierSchema,
    closeTab: z.boolean(),
    tabDisposition: z.enum(["closed", "already-absent", "left-open"]),
  })
  .strict();
const generationSnapshotPayloadSchema = z
  .object({
    markdown: markdownSchema,
    remoteUrl: optionalChatGptUrlSchema,
    startedAt: timestampSchema,
  })
  .strict();
const generationCompletePayloadSchema = generationSnapshotPayloadSchema
  .extend({
    completedAt: timestampSchema,
    terminalTranscriptSha256: sha256Schema.optional(),
  })
  .strict();
const generationStoppedPayloadSchema = generationSnapshotPayloadSchema
  .extend({ terminalTranscriptSha256: sha256Schema.optional() })
  .strict();
const generationAckPayloadSchema = z
  .object({
    eventId: identifierSchema,
    acknowledgedAt: timestampSchema,
  })
  .strict();
const generationStopPayloadSchema = z.object({ requestedAt: timestampSchema }).strict();
const generationRegeneratePayloadSchema = z
  .object({
    messageId: identifierSchema,
    remoteUrl: optionalChatGptUrlSchema,
  })
  .strict();
const modelOptionSchema = z
  .object({
    id: modelIdSchema,
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(160).optional(),
    mode: z.enum(["smart", "fast", "low", "medium", "high", "very-high", "pro"]).optional(),
    modelId: modelIdSchema.optional(),
    familyLabel: z.string().trim().min(1).max(80).optional(),
    secondaryLabel: z.string().trim().min(1).max(24).optional(),
    reasoningEffort: z.enum(["min", "standard", "extended", "max"]).optional(),
    selected: z.boolean(),
  })
  .strict();
const modelListPayloadSchema = z
  .object({
    requestId: identifierSchema,
    remoteUrl: optionalChatGptUrlSchema,
  })
  .strict();
const modelCatalogPayloadSchema = z
  .object({
    requestId: identifierSchema,
    options: z.array(modelOptionSchema).min(1).max(20),
    currentModelId: modelIdSchema.optional(),
  })
  .strict();
const modelSelectPayloadSchema = z
  .object({
    requestId: identifierSchema,
    modelId: modelIdSchema,
    remoteUrl: optionalChatGptUrlSchema,
  })
  .strict();
const modelSelectedPayloadSchema = z
  .object({
    requestId: identifierSchema,
    selected: modelOptionSchema.extend({ selected: z.literal(true) }).strict(),
  })
  .strict();

const baseEnvelopeShape = {
  version: z.literal(PROTOCOL_VERSION),
  id: identifierSchema,
  instanceId: identifierSchema,
};
const conversationShape = { conversationId: identifierSchema };
const runShape = { ...conversationShape, runId: identifierSchema };

export const relayEnvelopeSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...baseEnvelopeShape,
      type: z.literal("relay.hello"),
      payload: relayHelloPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      type: z.literal("relay.ready"),
      payload: relayReadyPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      type: z.literal("heartbeat"),
      payload: heartbeatPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      type: z.literal("relay.status"),
      payload: relayStatusPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      type: z.literal(RELAY_STATUS_REQUEST_TYPE),
      payload: relayStatusRequestPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      ...conversationShape,
      type: z.literal("conversation.open"),
      payload: conversationOpenPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      ...conversationShape,
      type: z.literal("conversation.canonicalization.check"),
      payload: conversationCanonicalizationCheckPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      ...conversationShape,
      type: z.literal("conversation.canonicalization.result"),
      payload: conversationCanonicalizationResultPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      ...conversationShape,
      type: z.literal("conversation.title"),
      payload: conversationTitlePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      ...conversationShape,
      type: z.literal("conversation.snapshot"),
      payload: conversationSnapshotPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      ...runShape,
      type: z.literal("conversation.send"),
      payload: conversationSendPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      ...conversationShape,
      type: z.literal("conversation.close"),
      payload: conversationClosePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      ...conversationShape,
      type: z.literal("conversation.closed"),
      payload: conversationClosedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      ...conversationShape,
      type: z.literal("model.list"),
      payload: modelListPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      ...conversationShape,
      type: z.literal("model.catalog"),
      payload: modelCatalogPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      ...conversationShape,
      type: z.literal("model.select"),
      payload: modelSelectPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      ...conversationShape,
      type: z.literal("model.selected"),
      payload: modelSelectedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      ...runShape,
      type: z.literal("generation.snapshot"),
      payload: generationSnapshotPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      ...runShape,
      type: z.literal("generation.slow"),
      payload: generationSnapshotPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      ...runShape,
      type: z.literal("generation.complete"),
      payload: generationCompletePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      ...runShape,
      type: z.literal("generation.ack"),
      payload: generationAckPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      ...runShape,
      type: z.literal("generation.stop"),
      payload: generationStopPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      ...runShape,
      type: z.literal("generation.stopped"),
      payload: generationStoppedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      ...runShape,
      type: z.literal("generation.regenerate"),
      payload: generationRegeneratePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...baseEnvelopeShape,
      type: z.literal("relay.error"),
      conversationId: identifierSchema.optional(),
      runId: identifierSchema.optional(),
      payload: relayErrorPayloadSchema,
    })
    .strict()
    .refine((value) => !value.runId || value.conversationId, {
      message: "runId requires conversationId.",
      path: ["runId"],
    }),
]);

export interface RelayEnvelope<T = unknown> {
  version: typeof PROTOCOL_VERSION;
  id: string;
  type: RelayMessageType;
  instanceId: string;
  conversationId?: string;
  runId?: string;
  payload: T;
}

export interface RelayErrorPayload {
  code: RelayErrorCode;
  message: string;
  recoverable: boolean;
  focusTab?: boolean;
}

export interface RelayStatusPayload {
  connected: boolean;
  authenticated?: boolean;
  activeRuns: number;
  selectorVersion: number;
  project?: { bound: false } | { bound: true; name: string };
}

export interface RelayHelloPayload {
  chromeExtensionId: typeof CHROME_EXTENSION_ID;
  chromeVersion: string;
}

export interface RelayReadyPayload {
  serverLabel: string;
  serverInstanceId: string;
}

export interface ConversationOpenPayload {
  remoteUrl?: string;
  active?: boolean;
  dispatchIntent?: boolean;
  transcriptProof?: ConversationTranscriptProof;
}

export interface ConversationTranscriptProof {
  remoteUrl: string;
  messageCount: number;
  messageHashes: Array<{ role: "user" | "assistant"; sha256: string }>;
  transcriptChainSha256: string;
}

export interface ConversationTitlePayload {
  title: string;
  remoteUrl: string;
  observedAt: string;
}

export interface ConversationSnapshotPayload {
  remoteUrl: string;
  title?: string;
  messages: Array<{ role: "user" | "assistant"; markdown: string }>;
  observedAt: string;
  complete: boolean;
  urlPromotion?: ConversationUrlPromotionProof;
}

export interface ConversationUrlPromotionProof {
  runId: string;
  fromRemoteUrl: string;
  terminalMarkdownSha256: string;
  terminalTranscriptSha256?: string;
}

export interface ConversationCanonicalizationCheckPayload {
  requestId: string;
  runId: string;
  fromRemoteUrl: string;
  terminalMarkdownSha256: string;
  terminalTranscriptSha256: string;
}

type ConversationCanonicalizationResultBinding = ConversationCanonicalizationCheckPayload;

export type ConversationCanonicalizationResultPayload =
  | (ConversationCanonicalizationResultBinding & {
      status: "promoted";
      snapshot: ConversationSnapshotPayload;
    })
  | (ConversationCanonicalizationResultBinding & {
      status: "unchanged" | "expired";
      remoteUrl: string;
    });

export interface ConversationSendPayload {
  prompt: string;
  remoteUrl?: string;
  messageId: string;
  modelId?: string;
  transcriptProof?: ConversationTranscriptProof;
  attachments?: ChatFileAttachment[];
}

export interface ChatFileAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  content: string;
}

export interface ConversationClosePayload {
  closeTab: boolean;
}

export interface ConversationClosedPayload {
  requestId: string;
  closeTab: boolean;
  tabDisposition: "closed" | "already-absent" | "left-open";
}

export interface ChatModelOption {
  id: string;
  label: string;
  description?: string;
  mode?: ChatModelMode;
  modelId?: string;
  familyLabel?: string;
  secondaryLabel?: string;
  reasoningEffort?: ChatReasoningEffort;
  selected: boolean;
}

export type ChatModelMode = "smart" | "fast" | "low" | "medium" | "high" | "very-high" | "pro";
export type ChatReasoningEffort = "min" | "standard" | "extended" | "max";

export interface ModelListPayload {
  requestId: string;
  remoteUrl?: string;
}

export interface ModelCatalogPayload {
  requestId: string;
  options: ChatModelOption[];
  currentModelId?: string;
}

export interface ModelSelectPayload {
  requestId: string;
  modelId: string;
  remoteUrl?: string;
}

export interface ModelSelectedPayload {
  requestId: string;
  selected: ChatModelOption & { selected: true };
}

export interface GenerationSnapshotPayload {
  markdown: string;
  remoteUrl?: string;
  startedAt: string;
}

export interface GenerationCompletePayload extends GenerationSnapshotPayload {
  completedAt: string;
  terminalTranscriptSha256?: string;
}

export interface GenerationStoppedPayload extends GenerationSnapshotPayload {
  terminalTranscriptSha256?: string;
}

export interface GenerationAckPayload {
  eventId: string;
  acknowledgedAt: string;
}

export interface GenerationStopPayload {
  requestedAt: string;
}

export interface GenerationRegeneratePayload {
  messageId: string;
  remoteUrl?: string;
}

export type ContextKind = "selection" | "current-file" | "file";

export interface ContextSnapshot {
  id: string;
  kind: ContextKind;
  fileName: string;
  uri: string;
  language: string;
  startLine: number;
  endLine: number;
  content: string;
  charCount: number;
  unsaved: boolean;
}

export type MessageRole = "user" | "assistant" | "local-notice";
export type MessageStatus = "complete" | "streaming" | "stopped" | "error";
export type RunStatus = "starting" | "streaming" | "stopping" | "error";

export interface ConversationMessage {
  id: string;
  /** Correlates a UI submit with durable state after a lost host receipt. */
  clientRequestId?: string;
  role: MessageRole;
  markdown: string;
  status: MessageStatus;
  createdAt: string;
  contexts?: ContextSnapshot[];
  /** Version 2 keeps code context out of visible prompt text and sends it as files. */
  contextTransportVersion?: 2;
  /** Run-scoped transport failure; markdown remains answer content only. */
  runError?: RelayErrorPayload;
  terminalReceipt?: {
    eventId: string;
    runId: string;
    terminalType: "complete" | "stopped" | "error";
  };
}

export interface RunState {
  id: string;
  messageId: string;
  status: RunStatus;
  startedAt: string;
  softTimeoutNotified?: boolean;
  remoteAdoptionStage?: "initial" | "canonicalizing" | "locked";
  canonicalizationExpiresAt?: string;
  /** A run-scoped interrupt intent promotes the queued follow-up after this exact stop. */
  resumeQueueAfterStop?: boolean;
}

export interface PendingRemotePromotion {
  runId: string;
  messageId: string;
  fromRemoteUrl: string;
  terminalMarkdownSha256: string;
  terminalTranscriptSha256: string;
  terminalStatus: "complete" | "stopped";
  expiresAt: string;
}

/** A follow-up captured while the current turn is still running. */
export interface QueuedFollowUp {
  id: string;
  text: string;
  contexts: ContextSnapshot[];
  automaticContextIds: string[];
  selectedModelId?: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  /** Local-only archive marker. Archiving never removes the remote ChatGPT conversation. */
  archivedAt?: string;
  remoteUrl?: string;
  selectedModelId?: string;
  syncStatus?: "local" | "syncing" | "synced" | "partial" | "error";
  titleSource?: "local" | "chatgpt";
  lastSyncedAt?: string;
  pendingRemotePromotion?: PendingRemotePromotion;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
  run?: RunState;
  queuedFollowUps?: QueuedFollowUp[];
  /** Stopped and failed terminal turns pause automatic queue promotion. */
  queuePaused?: boolean;
}

export function parseRelayEnvelope(input: unknown): RelayEnvelope {
  return relayEnvelopeSchema.parse(input) as RelayEnvelope;
}

export function safeParseRelayEnvelope(input: unknown) {
  return relayEnvelopeSchema.safeParse(input);
}

export function isRelayIdentifier(input: unknown): input is string {
  return identifierSchema.safeParse(input).success;
}

export function isChromeToHostMessageType(type: RelayMessageType): type is ChromeToHostMessageType {
  return (chromeToHostMessageTypes as readonly RelayMessageType[]).includes(type);
}

export function isHostToChromeMessageType(type: RelayMessageType): type is HostToChromeMessageType {
  return (hostToChromeMessageTypes as readonly RelayMessageType[]).includes(type);
}

export function makeEnvelope<T>(
  input: Omit<RelayEnvelope<T>, "version" | "id"> & { id?: string },
): RelayEnvelope<T> {
  return {
    ...input,
    version: PROTOCOL_VERSION,
    id: input.id ?? crypto.randomUUID(),
  };
}

function isAllowedChatGptUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.origin === "https://chatgpt.com" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      (url.pathname === "/" ||
        /^\/c\/[^/]+\/?$/.test(url.pathname) ||
        isConservativeProjectPath(url.pathname))
    );
  } catch {
    return false;
  }
}

function isChatGptConversationUrl(value: string) {
  try {
    const url = new URL(value);
    if (
      url.origin !== "https://chatgpt.com" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname.endsWith("/")
    ) {
      return false;
    }
    if (/^\/c\/[^/]+$/.test(url.pathname)) return true;
    const segments = url.pathname.split("/").filter(Boolean);
    return (
      segments.length === 4 &&
      segments[0] === "g" &&
      segments[2] === "c" &&
      segments.every(isSafePathSegment)
    );
  } catch {
    return false;
  }
}

const GENERIC_CONVERSATION_TITLES = new Set([
  "chatgpt",
  "new chat",
  "new conversation",
  "temporary chat",
  "untitled",
  "ask anything",
  "skip to content",
  "skip to main content",
  "jump to content",
  "jump to main content",
  "main content",
  "新对话",
  "新聊天",
  "临时聊天",
  "未命名",
  "跳至内容",
  "跳到内容",
  "跳至主要内容",
  "跳到主要内容",
  "主要内容",
  "跳至內容",
  "跳到內容",
  "跳至主要內容",
  "跳到主要內容",
  "主要內容",
]);

export function isGenericConversationTitle(value: string) {
  return GENERIC_CONVERSATION_TITLES.has(value.replace(/\s+/gu, " ").trim().toLocaleLowerCase());
}

function isConservativeProjectPath(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 3 || !segments.every(isSafePathSegment)) return false;
  if (segments.at(-1) === "project") return true;
  return segments.length >= 4 && segments.at(-2) === "c";
}

function isSafePathSegment(segment: string) {
  if (segment.length < 1 || segment.length > 256 || segment.includes("\\")) return false;
  try {
    const decoded = decodeURIComponent(segment);
    return decoded !== "." && decoded !== ".." && !decoded.includes("/") && !decoded.includes("\\");
  } catch {
    return false;
  }
}
