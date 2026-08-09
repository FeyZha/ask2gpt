import { REMOTE_CANONICALIZATION_WINDOW_MS } from "@ask2gpt/protocol";

import {
  isRecord,
  isSafeId,
  normalizeRemoteConversationUrl,
  normalizeRemoteConversationTitle,
  parseContentEvent,
  parseProjectPageUrl,
  parseProjectRootUrl,
  type ValidatedContentEvent,
} from "./security";

export type TabProvenance = "created" | "borrowed" | "legacy-unknown";

export interface TabRecord {
  /**
   * `false` is reserved for an adopted user tab. Older Relay versions require
   * `owned === true`, so they fail closed instead of closing a borrowed page
   * after a binary downgrade.
   */
  owned: boolean;
  instanceId: string;
  conversationId: string;
  tabId: number;
  remoteUrl?: string;
  remoteTitle?: string;
  projectScope?: string;
  createdAt: string;
  /**
   * How the Relay obtained the tab. This remains optional until every runtime
   * constructor has migrated; absence is always treated as legacy-unknown and
   * must never authorize recycling or closing a tab.
   */
  provenance?: TabProvenance;
  /** Monotonic generation used to reject work from a previous tab lease. */
  leaseEpoch?: number;
  /** Most recent time the tab was used by its current lease. */
  lastUsedAt?: string;
  /** Present only after the current lease has become safely idle. */
  idleSince?: string;
  /** Durable request to return this lease to the managed pool once it is safe. */
  releaseRequestedAt?: string;
  /** Monotonic marker that permanently removes the tab from automatic management. */
  userClaimedAt?: string;
}

export interface ActiveRunRecord {
  instanceId: string;
  conversationId: string;
  runId: string;
  tabId?: number;
  phase: "dispatching" | "active";
  remoteAdoptionStage: "initial" | "canonicalizing" | "locked";
  canonicalizationExpiresAt?: string;
  promptSha256?: string;
  promptInlinePresentationVersion?: 1;
  promptInlinePresentationSha256?: string;
  /** Exact rendered user-message hash used to advance a content-free transcript chain. */
  submittedPromptMessageSha256?: string;
  /** Once true, this exact run emitted non-empty assistant text. */
  responseObserved?: true;
  /** Durable pre-dispatch transcript authority used after a page/worker reload. */
  dispatchTranscriptBaseline?: {
    tabId: number;
    remoteUrl: string;
    initialProjectUrl?: string;
    messageCount: number;
    transcriptSha256: string;
    transcriptChainSha256?: string;
  };
  /** Claimed before the exact mapped tab is reloaded; at most one reload per run. */
  historyReloadClaimedAt?: string;
  startedAt: string;
}

export interface PendingEventRecord {
  eventId: string;
  instanceId: string;
  tabId?: number;
  startedAt: string;
  event: ValidatedContentEvent;
}

export interface CompletedCanonicalizationRecord {
  instanceId: string;
  conversationId: string;
  runId: string;
  tabId: number;
  fromRemoteUrl: string;
  toRemoteUrl?: string;
  terminalMarkdownSha256: string;
  terminalTranscriptSha256: string;
  terminalStatus: "complete" | "stopped";
  expiresAt: string;
}

export interface TerminalHistoryBarrierRecord {
  instanceId: string;
  conversationId: string;
  runId: string;
  tabId: number;
  terminalMarkdownSha256: string;
  createdAt: string;
}

export const HARD_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const EMPTY_TRANSCRIPT_SHA256 = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

const LEGACY_NON_CONVERSATION_TITLES = new Set([
  "skip to content",
  "jump to content",
  "跳到内容",
  "跳至内容",
  "跳到內容",
  "跳至內容",
]);

export function classifyActiveRunTab(tab: { discarded?: boolean; frozen?: boolean }) {
  if (tab.discarded) return "reload" as const;
  if (tab.frozen) return "unfreeze" as const;
  return "poll" as const;
}

export function conversationKey(instanceId: string, conversationId: string) {
  return JSON.stringify([instanceId, conversationId]);
}

export function pendingEventKey(record: PendingEventRecord) {
  const deliveryKey = isTerminalContentEvent(record.event)
    ? record.eventId
    : `latest-${record.event.eventType}`;
  return JSON.stringify([
    record.instanceId,
    record.event.conversationId,
    record.event.runId,
    deliveryKey,
  ]);
}

function isTerminalContentEvent(event: ValidatedContentEvent) {
  return ["complete", "stopped", "error"].includes(event.eventType);
}

export function isRunExpired(run: ActiveRunRecord, now = Date.now()) {
  const startedAt = Date.parse(run.startedAt);
  const elapsed = now - startedAt;
  return !Number.isFinite(startedAt) || elapsed < -60_000 || elapsed >= HARD_RUN_TIMEOUT_MS;
}

export function classifyRecoveredRun(
  phase: ActiveRunRecord["phase"],
  pageActive: boolean,
  markdown: string | undefined,
): "active" | "complete" | "fail" {
  if (pageActive) return "active";
  if (phase === "active" && typeof markdown === "string" && markdown.length > 0) {
    return "complete";
  }
  return "fail";
}

export function classifyRestoredRemoteAdoption(
  run: ActiveRunRecord,
  hasMappedRemoteUrl: boolean,
  _now = Date.now(),
): "keep" | "lock" | "fail" {
  if (run.remoteAdoptionStage === "initial") {
    // The exact page-side run must attest recovery before any route is used,
    // so merely having observed a provisional URL is not a reason to revoke
    // the still-running conversation.
    return "keep";
  }
  if (!hasMappedRemoteUrl) return "fail";
  // A restored canonicalizing run is still governed by the 30-minute run
  // timeout. Its page-side run attestation, not a short URL timer, decides
  // whether cross-id ChatGPT redirects remain valid.
  return "keep";
}

export function parseStoredTabs(value: unknown) {
  const result = new Map<string, TabRecord>();
  if (!Array.isArray(value)) return result;
  const seenTabs = new Set<number>();
  for (const item of value) {
    const record = parseTabRecord(item);
    if (!record || seenTabs.has(record.tabId)) continue;
    seenTabs.add(record.tabId);
    result.set(conversationKey(record.instanceId, record.conversationId), record);
  }
  return result;
}

export function parseStoredRuns(value: unknown) {
  const result = new Map<string, ActiveRunRecord>();
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    const record = parseRunRecord(item);
    if (!record) continue;
    result.set(conversationKey(record.instanceId, record.conversationId), record);
    if (result.size >= 3) break;
  }
  return result;
}

export function parseStoredPendingEvents(value: unknown) {
  const result = new Map<string, PendingEventRecord>();
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    if (
      !isRecord(item) ||
      !isSafeId(item.instanceId) ||
      (item.tabId !== undefined && (!Number.isSafeInteger(item.tabId) || Number(item.tabId) < 0))
    ) {
      continue;
    }
    const event = parseContentEvent(item.event);
    if (!event) continue;
    const record: PendingEventRecord = {
      eventId: isSafeId(item.eventId) ? item.eventId : event.runId,
      instanceId: item.instanceId,
      startedAt: isIsoDate(item.startedAt) ? item.startedAt : new Date().toISOString(),
      event,
      ...(item.tabId === undefined ? {} : { tabId: Number(item.tabId) }),
    };
    result.set(pendingEventKey(record), record);
  }
  return result;
}

export function parseStoredCompletedCanonicalizations(value: unknown) {
  const result = new Map<string, CompletedCanonicalizationRecord>();
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    const record = parseCompletedCanonicalizationRecord(item);
    if (!record) continue;
    result.set(conversationKey(record.instanceId, record.conversationId), record);
  }
  return result;
}

export function parseStoredTerminalHistoryBarriers(value: unknown) {
  const result = new Map<string, TerminalHistoryBarrierRecord>();
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    if (
      !isRecord(item) ||
      !isSafeId(item.instanceId) ||
      !isSafeId(item.conversationId) ||
      !isSafeId(item.runId) ||
      !Number.isSafeInteger(item.tabId) ||
      Number(item.tabId) < 0 ||
      typeof item.terminalMarkdownSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.terminalMarkdownSha256) ||
      !isIsoDate(item.createdAt)
    ) {
      continue;
    }
    const record: TerminalHistoryBarrierRecord = {
      instanceId: item.instanceId,
      conversationId: item.conversationId,
      runId: item.runId,
      tabId: Number(item.tabId),
      terminalMarkdownSha256: item.terminalMarkdownSha256,
      createdAt: item.createdAt,
    };
    result.set(conversationKey(record.instanceId, record.conversationId), record);
  }
  return result;
}

export function isCompletedCanonicalizationCurrent(
  record: CompletedCanonicalizationRecord,
  now = Date.now(),
) {
  const expiresAt = Date.parse(record.expiresAt);
  return (
    Number.isFinite(expiresAt) &&
    expiresAt > now &&
    expiresAt <= now + REMOTE_CANONICALIZATION_WINDOW_MS
  );
}

function parseTabRecord(value: unknown): TabRecord | undefined {
  if (
    !isRecord(value) ||
    typeof value.owned !== "boolean" ||
    !isSafeId(value.instanceId) ||
    !isSafeId(value.conversationId) ||
    !Number.isSafeInteger(value.tabId) ||
    Number(value.tabId) < 0 ||
    !isIsoDate(value.createdAt)
  ) {
    return undefined;
  }
  const normalizedRemoteUrl =
    value.remoteUrl === undefined ? undefined : normalizeRemoteConversationUrl(value.remoteUrl);
  if (value.remoteUrl !== undefined && !normalizedRemoteUrl) return undefined;
  const remoteUrl =
    normalizedRemoteUrl && isConversationRemoteUrl(normalizedRemoteUrl)
      ? normalizedRemoteUrl
      : undefined;
  const normalizedRemoteTitle =
    value.remoteTitle === undefined
      ? undefined
      : normalizeRemoteConversationTitle(value.remoteTitle);
  const remoteTitle =
    normalizedRemoteTitle &&
    !LEGACY_NON_CONVERSATION_TITLES.has(normalizedRemoteTitle.toLocaleLowerCase())
      ? normalizedRemoteTitle
      : undefined;
  // A persisted title is only display metadata. Keep an otherwise valid
  // conversation mapping when an older Relay stored a generic or malformed
  // title, but never let a title make a non-conversation URL recoverable.
  if (value.remoteTitle !== undefined && !remoteUrl) return undefined;
  const projectScope = parseProjectScope(value.projectScope);
  if (value.projectScope !== undefined && !projectScope) return undefined;
  if (projectScope && remoteUrl && parseProjectPageUrl(remoteUrl)?.scope !== projectScope) {
    return undefined;
  }
  const provenance =
    value.provenance === undefined ? "legacy-unknown" : parseTabProvenance(value.provenance);
  const leaseEpoch = value.leaseEpoch === undefined ? 0 : parseLeaseEpoch(value.leaseEpoch);
  const lastUsedAt = value.lastUsedAt === undefined ? value.createdAt : value.lastUsedAt;
  if (
    !provenance ||
    (provenance === "borrowed" ? value.owned !== false : value.owned !== true) ||
    leaseEpoch === undefined ||
    !isIsoDate(lastUsedAt) ||
    (value.idleSince !== undefined && !isIsoDate(value.idleSince)) ||
    (value.releaseRequestedAt !== undefined && !isIsoDate(value.releaseRequestedAt)) ||
    (value.userClaimedAt !== undefined && !isIsoDate(value.userClaimedAt))
  ) {
    return undefined;
  }
  return {
    owned: provenance !== "borrowed",
    instanceId: value.instanceId,
    conversationId: value.conversationId,
    tabId: Number(value.tabId),
    createdAt: value.createdAt,
    ...(remoteUrl ? { remoteUrl } : {}),
    ...(remoteTitle ? { remoteTitle } : {}),
    ...(projectScope ? { projectScope } : {}),
    provenance,
    leaseEpoch,
    lastUsedAt,
    ...(typeof value.idleSince === "string" ? { idleSince: value.idleSince } : {}),
    ...(typeof value.releaseRequestedAt === "string"
      ? { releaseRequestedAt: value.releaseRequestedAt }
      : {}),
    ...(typeof value.userClaimedAt === "string" ? { userClaimedAt: value.userClaimedAt } : {}),
  };
}

function parseTabProvenance(value: unknown): TabProvenance | undefined {
  if (value === "created" || value === "borrowed" || value === "legacy-unknown") return value;
  return undefined;
}

function parseLeaseEpoch(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return undefined;
  return Number(value);
}

function parseProjectScope(value: unknown) {
  if (typeof value !== "string") return undefined;
  const route = parseProjectRootUrl(`${value}project`);
  return route?.scope === value ? value : undefined;
}

function isConversationRemoteUrl(value: string) {
  const pathname = new URL(value).pathname;
  if (/^\/c\/[^/]+$/.test(pathname)) return true;
  const segments = pathname.split("/").filter(Boolean);
  return segments.length === 4 && segments[0] === "g" && segments[2] === "c";
}

function parseRunRecord(value: unknown): ActiveRunRecord | undefined {
  if (
    !isRecord(value) ||
    !isSafeId(value.instanceId) ||
    !isSafeId(value.conversationId) ||
    !isSafeId(value.runId) ||
    !["dispatching", "active"].includes(String(value.phase)) ||
    !isIsoDate(value.startedAt) ||
    (value.responseObserved !== undefined && value.responseObserved !== true) ||
    (value.historyReloadClaimedAt !== undefined && !isIsoDate(value.historyReloadClaimedAt)) ||
    (value.tabId !== undefined && (!Number.isSafeInteger(value.tabId) || Number(value.tabId) < 0))
  ) {
    return undefined;
  }
  const remoteAdoptionStage = parseRemoteAdoptionStage(value);
  if (!remoteAdoptionStage) return undefined;
  const canonicalizationExpiresAt = isIsoDate(value.canonicalizationExpiresAt)
    ? value.canonicalizationExpiresAt
    : undefined;
  const promptSha256 =
    typeof value.promptSha256 === "string" && /^[a-f0-9]{64}$/.test(value.promptSha256)
      ? value.promptSha256
      : undefined;
  if (value.promptSha256 !== undefined && !promptSha256) return undefined;
  const promptInlinePresentationVersion =
    value.promptInlinePresentationVersion === 1 ? value.promptInlinePresentationVersion : undefined;
  const promptInlinePresentationSha256 =
    typeof value.promptInlinePresentationSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.promptInlinePresentationSha256)
      ? value.promptInlinePresentationSha256
      : undefined;
  const submittedPromptMessageSha256 =
    typeof value.submittedPromptMessageSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.submittedPromptMessageSha256)
      ? value.submittedPromptMessageSha256
      : undefined;
  if (
    (value.promptInlinePresentationVersion !== undefined && !promptInlinePresentationVersion) ||
    (value.promptInlinePresentationSha256 !== undefined && !promptInlinePresentationSha256) ||
    Boolean(promptInlinePresentationVersion) !== Boolean(promptInlinePresentationSha256) ||
    (promptInlinePresentationSha256 && !promptSha256) ||
    (value.submittedPromptMessageSha256 !== undefined && !submittedPromptMessageSha256)
  ) {
    return undefined;
  }
  const dispatchTranscriptBaseline = parseDispatchTranscriptBaseline(
    value.dispatchTranscriptBaseline,
  );
  if (
    (value.dispatchTranscriptBaseline !== undefined && !dispatchTranscriptBaseline) ||
    (dispatchTranscriptBaseline &&
      value.tabId !== undefined &&
      dispatchTranscriptBaseline.tabId !== Number(value.tabId)) ||
    (value.historyReloadClaimedAt !== undefined && !dispatchTranscriptBaseline)
  ) {
    return undefined;
  }
  return {
    instanceId: value.instanceId,
    conversationId: value.conversationId,
    runId: value.runId,
    phase: value.phase as ActiveRunRecord["phase"],
    remoteAdoptionStage,
    ...(canonicalizationExpiresAt ? { canonicalizationExpiresAt } : {}),
    ...(promptSha256 ? { promptSha256 } : {}),
    ...(promptInlinePresentationVersion
      ? {
          promptInlinePresentationVersion,
          promptInlinePresentationSha256: promptInlinePresentationSha256!,
        }
      : {}),
    ...(submittedPromptMessageSha256 ? { submittedPromptMessageSha256 } : {}),
    ...(value.responseObserved === true ? { responseObserved: true as const } : {}),
    ...(dispatchTranscriptBaseline ? { dispatchTranscriptBaseline } : {}),
    ...(typeof value.historyReloadClaimedAt === "string"
      ? { historyReloadClaimedAt: value.historyReloadClaimedAt }
      : {}),
    startedAt: value.startedAt,
    ...(value.tabId === undefined ? {} : { tabId: Number(value.tabId) }),
  };
}

function parseDispatchTranscriptBaseline(
  value: unknown,
): ActiveRunRecord["dispatchTranscriptBaseline"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const remoteUrl = normalizeRemoteConversationUrl(value.remoteUrl);
  const initialProjectUrl =
    value.initialProjectUrl === undefined
      ? undefined
      : normalizeRemoteConversationUrl(value.initialProjectUrl);
  const initialProjectRoute = initialProjectUrl
    ? parseProjectRootUrl(initialProjectUrl)
    : undefined;
  const remoteProjectRoute = remoteUrl ? parseProjectPageUrl(remoteUrl) : undefined;
  const transcriptChainSha256 =
    typeof value.transcriptChainSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(value.transcriptChainSha256)
      ? value.transcriptChainSha256
      : undefined;
  if (
    !Number.isSafeInteger(value.tabId) ||
    Number(value.tabId) < 0 ||
    !remoteUrl ||
    (value.initialProjectUrl !== undefined &&
      (!initialProjectUrl ||
        !initialProjectRoute ||
        !remoteProjectRoute ||
        initialProjectRoute.scope !== remoteProjectRoute.scope)) ||
    !Number.isSafeInteger(value.messageCount) ||
    Number(value.messageCount) < 0 ||
    Number(value.messageCount) > 10_000 ||
    (value.initialProjectUrl !== undefined && Number(value.messageCount) !== 0) ||
    (value.initialProjectUrl !== undefined && value.transcriptSha256 !== EMPTY_TRANSCRIPT_SHA256) ||
    typeof value.transcriptSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.transcriptSha256) ||
    (value.transcriptChainSha256 !== undefined && !transcriptChainSha256)
  ) {
    return undefined;
  }
  return {
    tabId: Number(value.tabId),
    remoteUrl,
    ...(initialProjectUrl ? { initialProjectUrl } : {}),
    messageCount: Number(value.messageCount),
    transcriptSha256: value.transcriptSha256,
    ...(transcriptChainSha256 ? { transcriptChainSha256 } : {}),
  };
}

function parseCompletedCanonicalizationRecord(
  value: unknown,
): CompletedCanonicalizationRecord | undefined {
  if (
    !isRecord(value) ||
    !isSafeId(value.instanceId) ||
    !isSafeId(value.conversationId) ||
    !isSafeId(value.runId) ||
    !Number.isSafeInteger(value.tabId) ||
    Number(value.tabId) < 0 ||
    typeof value.fromRemoteUrl !== "string" ||
    typeof value.terminalMarkdownSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.terminalMarkdownSha256) ||
    typeof value.terminalTranscriptSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.terminalTranscriptSha256) ||
    (value.terminalStatus !== "complete" && value.terminalStatus !== "stopped") ||
    !isIsoDate(value.expiresAt)
  ) {
    return undefined;
  }
  const fromRemoteUrl = normalizeRemoteConversationUrl(value.fromRemoteUrl);
  if (!fromRemoteUrl || !isConversationRemoteUrl(fromRemoteUrl)) return undefined;
  const toRemoteUrl =
    value.toRemoteUrl === undefined ? undefined : normalizeRemoteConversationUrl(value.toRemoteUrl);
  if (
    value.toRemoteUrl !== undefined &&
    (!toRemoteUrl ||
      !isConversationRemoteUrl(toRemoteUrl) ||
      sameConversationIdentity(fromRemoteUrl, toRemoteUrl))
  ) {
    return undefined;
  }
  return {
    instanceId: value.instanceId,
    conversationId: value.conversationId,
    runId: value.runId,
    tabId: Number(value.tabId),
    fromRemoteUrl,
    ...(toRemoteUrl ? { toRemoteUrl } : {}),
    terminalMarkdownSha256: value.terminalMarkdownSha256,
    terminalTranscriptSha256: value.terminalTranscriptSha256,
    terminalStatus: value.terminalStatus,
    expiresAt: value.expiresAt,
  };
}

function sameConversationIdentity(left: string, right: string) {
  const conversationId = (value: string) => {
    const segments = new URL(value).pathname.split("/").filter(Boolean);
    if (segments.length === 2 && segments[0] === "c") return segments[1];
    if (segments.length === 4 && segments[0] === "g" && segments[2] === "c") {
      return segments[3];
    }
    return undefined;
  };
  return conversationId(left) === conversationId(right);
}

function parseRemoteAdoptionStage(
  value: Record<string, unknown>,
): ActiveRunRecord["remoteAdoptionStage"] | undefined {
  if (["initial", "canonicalizing", "locked"].includes(String(value.remoteAdoptionStage))) {
    return value.remoteAdoptionStage as ActiveRunRecord["remoteAdoptionStage"];
  }
  if (value.remoteAdoptionStage !== undefined) return undefined;
  // Upgrade a legacy in-flight record without an explicit adoption stage
  // conservatively. A run which had not yet observed its first /c route can
  // still do so; every other legacy run stays locked because its
  // canonicalization history is unknowable.
  return value.allowRemoteAdoption === true ? "initial" : "locked";
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    value.length <= 32 &&
    Number.isFinite(Date.parse(value))
  );
}
