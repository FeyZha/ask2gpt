import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import {
  MAX_CONCURRENT_RUNS,
  makeEnvelope,
  type ChatModelOption,
  type ConversationCanonicalizationResultPayload,
  type ConversationClosedPayload,
  type ConversationLeasePurpose,
  type ConversationReleasedPayload,
  type ConversationReleaseReason,
  type ConversationSnapshotPayload,
  type ConversationTitlePayload,
  type ConversationTranscriptProof,
  type GenerationCompletePayload,
  type GenerationSnapshotPayload,
  type GenerationStoppedPayload,
  type ModelCatalogPayload,
  type ModelSelectedPayload,
  type PendingRemotePromotion,
  type RelayEnvelope,
  type RelayErrorPayload,
  type RelayStatusPayload,
} from "@ask2gpt/protocol";

import type {
  BackendEvent,
  BackendStatus,
  ChatBackend,
  ConnectionStatus,
  RunHandle,
  SendRequest,
} from "../types";
import { ChromeRelayServer } from "./chrome-relay-server";

const RUN_COMMAND_REPLAY_WINDOW_MS = 30 * 60 * 1_000;
const TAB_LEASE_MINIMUM_RELAY_VERSION = [0, 1, 2] as const;

export class BrowserChatBackend implements ChatBackend {
  private readonly events = new EventEmitter();
  private readonly activeRuns = new Map<string, string>();
  private readonly activeRunStartedAt = new Map<string, number>();
  private readonly activeRunCommands = new Map<string, RelayEnvelope>();
  private readonly finishedRunKeys = new Map<
    string,
    { acknowledgeAll: boolean; eventIds: Set<string> }
  >();
  private readonly canonicalizationRequests = new Map<
    string,
    {
      conversationId: string;
      timer: NodeJS.Timeout;
      resolve: (result: ConversationCanonicalizationResultPayload) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly modelRequests = new Map<
    string,
    {
      conversationId: string;
      timer: NodeJS.Timeout;
      resolve: (value: ChatModelOption[] | ChatModelOption) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly closeRequests = new Map<
    string,
    {
      conversationId: string;
      timer: NodeJS.Timeout;
      resolve: (acknowledged: boolean) => void;
    }
  >();
  private readonly releaseRequests = new Map<
    string,
    {
      conversationId: string;
      purpose: ConversationLeasePurpose;
      reason: ConversationReleaseReason;
      timer: NodeJS.Timeout;
      resolve: (acknowledged: boolean) => void;
    }
  >();
  private readonly relaySubscription: { dispose(): void };
  private readonly connectionSubscription: { dispose(): void };
  private selectorVersion = 1;
  private reportedActiveRuns = 0;
  private project: RelayStatusPayload["project"];
  private statusConfirmedForConnection = false;
  private observedRelayGeneration: number;
  private statusRequestTimer?: NodeJS.Timeout;
  private statusRequestAttempt = 0;
  private disposed = false;
  private lastError?: RelayErrorPayload;

  constructor(private readonly relay: ChromeRelayServer) {
    this.observedRelayGeneration = relay.authoritativeGeneration;
    this.relaySubscription = relay.onEnvelope((envelope) => this.handleEnvelope(envelope));
    this.connectionSubscription = relay.onConnectionChanged(() => {
      // Transport connection becomes observable before Chrome finishes restoring
      // its run state. Wait for relay.status before declaring the connection
      // ready instead of briefly enabling stale state after a reconnect.
      const authoritativeGenerationChanged =
        relay.authoritativeGeneration !== this.observedRelayGeneration;
      this.observedRelayGeneration = relay.authoritativeGeneration;
      if (!relay.connected || authoritativeGenerationChanged) {
        this.statusConfirmedForConnection = false;
      }
      if (!relay.connected) this.clearStatusRequestRetry();
      if (!relay.connected) this.reportedActiveRuns = 0;
      if (!relay.connected || authoritativeGenerationChanged) {
        const reason = authoritativeGenerationChanged
          ? "The connection changed before the request completed."
          : "The connection closed before the request completed.";
        this.rejectCanonicalizationRequests(
          new Error(`${reason} The conversation could not be confirmed.`),
        );
        this.rejectModelRequests(new Error(`${reason} Models could not be refreshed.`));
        this.resolveReleaseRequests(false);
        this.resolveCloseRequests(false);
      }
      if (relay.connectionState.phase === "syncing") {
        this.lastError = undefined;
      }
      this.emit({
        type: "status",
        status: {
          connected: relay.connected,
          authenticated: relay.connected,
          activeRuns: this.activeRuns.size,
          selectorVersion: this.selectorVersion,
          project: this.project,
          connection: this.getConnectionStatus(),
        },
      });
      if (relay.connected && !this.statusConfirmedForConnection) this.requestRelayStatus();
    });
    // Chrome may reconnect between relay.start() completing and this backend
    // subscribing. Explicitly request the current snapshot so a missed first
    // relay.status can never leave the UI stuck in "syncing".
    if (relay.connected) this.requestRelayStatus();
  }

  async getStatus(): Promise<BackendStatus> {
    return this.getStatusSnapshot();
  }

  private getStatusSnapshot(): BackendStatus {
    this.pruneExpiredRuns();
    const connected = this.relay.connected;
    const connection = this.getConnectionStatus();
    return {
      connected,
      authenticated: connected,
      activeRuns:
        connected && this.statusConfirmedForConnection
          ? Math.max(this.activeRuns.size, this.reportedActiveRuns)
          : this.activeRuns.size,
      port: this.relay.port,
      selectorVersion: this.selectorVersion,
      project: this.project,
      error: this.lastError,
      connection,
    };
  }

  private getConnectionStatus(): ConnectionStatus {
    const connected = this.relay.connected;
    // Tests and third-party backend adapters created before the explicit
    // connection state can omit this property. Keep a safe transition state
    // instead of throwing while they migrate.
    const relayState = this.relay.connectionState ?? {
      phase: "waiting-for-browser" as const,
      since: new Date().toISOString(),
      browserDetected: false,
      hasStoredTrust: false,
    };
    const phase: ConnectionStatus["phase"] = connected
      ? this.statusConfirmedForConnection
        ? this.project?.bound === false
          ? "project-required"
          : "ready"
        : "syncing"
      : relayState.phase;
    return { ...relayState, phase };
  }

  async prepareConversation(
    conversationId: string,
    remoteUrl?: string,
    transcriptProof?: ConversationTranscriptProof,
    dispatchIntent = false,
  ): Promise<void> {
    this.assertReady();
    const supportsTabLeases = this.supportsTabLeases();
    this.relay.send(
      makeEnvelope({
        type: "conversation.open",
        instanceId: this.relay.instanceId,
        conversationId,
        payload: {
          remoteUrl,
          active: false,
          dispatchIntent,
          ...(supportsTabLeases ? { purpose: dispatchIntent ? "dispatch" : "view" } : {}),
          transcriptProof,
        },
      }),
    );
  }

  async settlePendingRemotePromotion(
    conversationId: string,
    promotion: PendingRemotePromotion,
  ): Promise<ConversationCanonicalizationResultPayload> {
    this.assertReady();
    const requestId = randomUUID();
    const remainingMs = Date.parse(promotion.expiresAt) - Date.now();
    const timeoutMs = Math.min(32_000, Math.max(2_000, remainingMs + 2_000));

    return new Promise<ConversationCanonicalizationResultPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.canonicalizationRequests.delete(requestId);
        reject(new Error("Timed out while preparing the conversation."));
      }, timeoutMs);
      timer.unref();
      this.canonicalizationRequests.set(requestId, {
        conversationId,
        timer,
        resolve,
        reject,
      });
      try {
        this.relay.send(
          makeEnvelope({
            type: "conversation.canonicalization.check",
            instanceId: this.relay.instanceId,
            conversationId,
            payload: {
              requestId,
              runId: promotion.runId,
              fromRemoteUrl: promotion.fromRemoteUrl,
              terminalMarkdownSha256: promotion.terminalMarkdownSha256,
              terminalTranscriptSha256: promotion.terminalTranscriptSha256,
            },
          }),
        );
      } catch (error) {
        clearTimeout(timer);
        this.canonicalizationRequests.delete(requestId);
        reject(error instanceof Error ? error : new Error("Canonicalization check failed."));
      }
    });
  }

  async send(request: SendRequest): Promise<RunHandle> {
    this.assertReady();
    this.pruneExpiredRuns();
    if (this.activeRuns.has(request.conversationId)) {
      throw new Error("该会话已有回答正在生成。");
    }
    if (Math.max(this.activeRuns.size, this.reportedActiveRuns) >= MAX_CONCURRENT_RUNS) {
      throw new Error(`最多允许 ${MAX_CONCURRENT_RUNS} 个会话同时生成回答。`);
    }

    const envelope = makeEnvelope({
      type: "conversation.send",
      instanceId: this.relay.instanceId,
      conversationId: request.conversationId,
      runId: request.runId,
      payload: {
        prompt: request.prompt,
        attachments: request.attachments,
        remoteUrl: request.remoteUrl,
        messageId: request.messageId,
        modelId: request.modelId,
        transcriptProof: request.transcriptProof,
      },
    });
    this.reserveRun(request.conversationId, request.runId, envelope);
    this.sendReservedRun(request.conversationId, request.runId, envelope);

    return {
      conversationId: request.conversationId,
      runId: request.runId,
      startedAt: new Date().toISOString(),
    };
  }

  async stop(conversationId: string, runId: string): Promise<void> {
    // A late Stop click must never stop a newer run in the same ChatGPT tab.
    const activeRunId = this.activeRuns.get(conversationId);
    if (activeRunId && activeRunId !== runId) return;
    if (!activeRunId && this.hasFinishedRun(conversationId, runId)) return;
    this.assertConnected();
    this.relay.send(
      makeEnvelope({
        type: "generation.stop",
        instanceId: this.relay.instanceId,
        conversationId,
        runId,
        payload: { requestedAt: new Date().toISOString() },
      }),
    );
  }

  async regenerate(
    conversationId: string,
    messageId: string,
    runId: string,
    remoteUrl?: string,
  ): Promise<RunHandle> {
    this.assertReady();
    this.pruneExpiredRuns();
    if (this.activeRuns.has(conversationId)) {
      throw new Error("该会话已有回答正在生成。");
    }
    if (Math.max(this.activeRuns.size, this.reportedActiveRuns) >= MAX_CONCURRENT_RUNS) {
      throw new Error(`最多允许 ${MAX_CONCURRENT_RUNS} 个会话同时生成回答。`);
    }

    const envelope = makeEnvelope({
      type: "generation.regenerate",
      instanceId: this.relay.instanceId,
      conversationId,
      runId,
      payload: { messageId, remoteUrl },
    });
    this.reserveRun(conversationId, runId, envelope);
    this.sendReservedRun(conversationId, runId, envelope);
    return { conversationId, runId, startedAt: new Date().toISOString() };
  }

  async listModels(conversationId: string, remoteUrl?: string): Promise<ChatModelOption[]> {
    return this.requestModels(conversationId, "model.list", undefined, remoteUrl) as Promise<
      ChatModelOption[]
    >;
  }

  async selectModel(
    conversationId: string,
    modelId: string,
    remoteUrl?: string,
  ): Promise<ChatModelOption> {
    return this.requestModels(
      conversationId,
      "model.select",
      modelId,
      remoteUrl,
    ) as Promise<ChatModelOption>;
  }

  async closeConversation(conversationId: string): Promise<boolean> {
    const runId = this.activeRuns.get(conversationId);
    if (runId) this.rememberFinishedRun(conversationId, runId);
    if (runId) this.releaseRun(conversationId, runId);
    if (!this.relay.connected) return false;
    for (let attempt = 0; attempt < 2 && this.relay.connected; attempt += 1) {
      if (await this.requestConversationClose(conversationId)) return true;
    }
    return false;
  }

  async releaseConversation(
    conversationId: string,
    purpose: ConversationLeasePurpose = "view",
    reason: ConversationReleaseReason = "inactive",
  ): Promise<boolean> {
    if (!this.relay.connected || !this.supportsTabLeases()) return false;
    return this.requestConversationRelease(conversationId, purpose, reason);
  }

  async acknowledgeTerminal(conversationId: string, runId: string, eventId: string) {
    this.releaseRun(conversationId, runId);
    this.rememberFinishedRun(conversationId, runId, eventId);
    this.sendTerminalAcknowledgement(conversationId, runId, eventId);
  }

  onEvent(listener: (event: BackendEvent) => void) {
    this.events.on("event", listener);
    return { dispose: () => this.events.off("event", listener) };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearStatusRequestRetry();
    this.rejectCanonicalizationRequests(new Error("Browser backend was disposed."));
    this.rejectModelRequests(new Error("Browser backend was disposed."));
    this.resolveReleaseRequests(false);
    this.resolveCloseRequests(false);
    this.relaySubscription.dispose();
    this.connectionSubscription.dispose();
    this.events.removeAllListeners();
  }

  private supportsTabLeases() {
    const relayVersion = this.relay.connectionState.relayVersion;
    if (!relayVersion) return false;
    const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(relayVersion);
    if (!match) return false;
    const version = match.slice(1).map(Number);
    const minimum = TAB_LEASE_MINIMUM_RELAY_VERSION;
    return version[0] === minimum[0] && version[1] === minimum[1] && version[2]! >= minimum[2];
  }

  private handleEnvelope(envelope: RelayEnvelope) {
    const conversationId = envelope.conversationId;
    const runId = envelope.runId;
    if (envelope.type === "relay.status") {
      const status = envelope.payload as RelayStatusPayload;
      const confirmsNewConnection = !this.statusConfirmedForConnection;
      this.statusConfirmedForConnection = true;
      this.clearStatusRequestRetry();
      this.statusRequestAttempt = 0;
      this.lastError = undefined;
      this.selectorVersion = status.selectorVersion;
      this.reportedActiveRuns = status.activeRuns;
      this.project = status.project;
      this.emit({
        type: "status",
        status: {
          ...status,
          connected: this.relay.connected,
          authenticated: this.relay.connected,
          activeRuns: Math.max(this.activeRuns.size, status.activeRuns),
          connection: this.getConnectionStatus(),
        },
      });
      if (confirmsNewConnection) this.replayActiveRunCommands();
      return;
    }
    if (envelope.type === "conversation.canonicalization.result") {
      if (!conversationId || runId) return;
      const payload = envelope.payload as ConversationCanonicalizationResultPayload;
      const pending = this.canonicalizationRequests.get(payload.requestId);
      if (!pending || pending.conversationId !== conversationId) return;
      clearTimeout(pending.timer);
      this.canonicalizationRequests.delete(payload.requestId);
      pending.resolve(payload);
      return;
    }
    if (envelope.type === "model.catalog") {
      if (!conversationId || runId) return;
      const payload = envelope.payload as ModelCatalogPayload;
      const pending = this.modelRequests.get(payload.requestId);
      if (!pending || pending.conversationId !== conversationId) return;
      clearTimeout(pending.timer);
      this.modelRequests.delete(payload.requestId);
      pending.resolve(payload.options);
      return;
    }
    if (envelope.type === "model.selected") {
      if (!conversationId || runId) return;
      const payload = envelope.payload as ModelSelectedPayload;
      const pending = this.modelRequests.get(payload.requestId);
      if (!pending || pending.conversationId !== conversationId) return;
      clearTimeout(pending.timer);
      this.modelRequests.delete(payload.requestId);
      pending.resolve(payload.selected);
      return;
    }
    if (envelope.type === "conversation.closed") {
      if (!conversationId || runId) return;
      const payload = envelope.payload as ConversationClosedPayload;
      const pending = this.closeRequests.get(payload.requestId);
      if (!pending || pending.conversationId !== conversationId) return;
      clearTimeout(pending.timer);
      this.closeRequests.delete(payload.requestId);
      pending.resolve(
        payload.closeTab === true &&
          (payload.tabDisposition === "closed" || payload.tabDisposition === "already-absent"),
      );
      return;
    }
    if (envelope.type === "conversation.released") {
      if (!conversationId || runId) return;
      const payload = envelope.payload as ConversationReleasedPayload;
      const pending = this.releaseRequests.get(payload.requestId);
      if (
        !pending ||
        pending.conversationId !== conversationId ||
        pending.purpose !== payload.purpose ||
        pending.reason !== payload.reason
      ) {
        return;
      }
      clearTimeout(pending.timer);
      this.releaseRequests.delete(payload.requestId);
      pending.resolve(true);
      return;
    }
    if (envelope.type === "conversation.title") {
      if (!conversationId || runId) return;
      const payload = envelope.payload as ConversationTitlePayload;
      this.emit({
        type: "title",
        conversationId,
        title: payload.title,
        remoteUrl: payload.remoteUrl,
        observedAt: payload.observedAt,
      });
      return;
    }
    if (envelope.type === "conversation.snapshot") {
      if (!conversationId || runId) return;
      const payload = envelope.payload as ConversationSnapshotPayload;
      this.emit({
        type: "history",
        conversationId,
        remoteUrl: payload.remoteUrl,
        title: payload.title,
        messages: payload.messages,
        observedAt: payload.observedAt,
        complete: payload.complete,
        ...(payload.urlPromotion ? { urlPromotion: payload.urlPromotion } : {}),
      });
      return;
    }
    if (envelope.type === "relay.error") {
      const error = envelope.payload as RelayErrorPayload;
      if (conversationId && runId) {
        const activeRunId = this.activeRuns.get(conversationId);
        if (this.isFinishedTerminalEvent(conversationId, runId, envelope.id)) {
          this.sendTerminalAcknowledgement(conversationId, runId, envelope.id);
          return;
        }
        if (activeRunId && activeRunId !== runId) {
          this.sendTerminalAcknowledgement(conversationId, runId, envelope.id);
          return;
        }
        this.emit({
          type: "error",
          conversationId,
          runId,
          terminalEventId: envelope.id,
          error,
        });
      } else if (conversationId && !runId) {
        const pendingRelease = [...this.releaseRequests.entries()].find(
          ([, request]) => request.conversationId === conversationId,
        );
        if (pendingRelease) {
          const [requestId, request] = pendingRelease;
          clearTimeout(request.timer);
          this.releaseRequests.delete(requestId);
          request.resolve(false);
          return;
        }
        const pendingClose = [...this.closeRequests.entries()].find(
          ([, request]) => request.conversationId === conversationId,
        );
        if (pendingClose) {
          const [requestId, request] = pendingClose;
          clearTimeout(request.timer);
          this.closeRequests.delete(requestId);
          request.resolve(false);
          return;
        }
        const pendingModel = [...this.modelRequests.entries()].find(
          ([, request]) => request.conversationId === conversationId,
        );
        if (pendingModel) {
          const [requestId, request] = pendingModel;
          clearTimeout(request.timer);
          this.modelRequests.delete(requestId);
          request.reject(Object.assign(new Error(error.message), { code: error.code }));
          return;
        }
        // conversation.open/prewarm failures belong to that conversation.
        // Promoting them to backend status would render the same problem both
        // as a global connection alert and as a later run error.
        this.emit({ type: "error", conversationId, error });
      } else if (!runId) {
        this.lastError = error;
        this.emit({ type: "error", error });
      }
      return;
    }
    if (!conversationId || !runId) return;
    const activeRunId = this.activeRuns.get(conversationId);
    const terminalEnvelope =
      envelope.type === "generation.complete" || envelope.type === "generation.stopped";
    if (terminalEnvelope && this.isFinishedTerminalEvent(conversationId, runId, envelope.id)) {
      this.sendTerminalAcknowledgement(conversationId, runId, envelope.id);
      return;
    }
    if (terminalEnvelope && activeRunId && activeRunId !== runId) {
      this.sendTerminalAcknowledgement(conversationId, runId, envelope.id);
      return;
    }
    if (activeRunId && activeRunId !== runId) return;
    if (!activeRunId) {
      if (!terminalEnvelope && this.hasFinishedRun(conversationId, runId)) return;
      // After a VS Code restart, active run IDs only exist in encrypted controller
      // state. Adopt the first authenticated non-terminal event; the controller
      // remains the final authority and filters unknown conversation/run pairs.
      if (
        (envelope.type === "generation.snapshot" || envelope.type === "generation.slow") &&
        this.activeRuns.size < MAX_CONCURRENT_RUNS
      ) {
        this.activeRuns.set(conversationId, runId);
        const startedAt = Date.parse(
          String((envelope.payload as Partial<GenerationSnapshotPayload>).startedAt ?? ""),
        );
        this.activeRunStartedAt.set(
          this.runKey(conversationId, runId),
          Number.isFinite(startedAt) ? startedAt : Date.now(),
        );
      }
    }

    if (envelope.type === "generation.snapshot") {
      const payload = envelope.payload as GenerationSnapshotPayload;
      this.emit({
        type: "snapshot",
        conversationId,
        runId,
        markdown: payload.markdown,
        remoteUrl: payload.remoteUrl,
      });
      return;
    }
    if (envelope.type === "generation.slow") {
      const payload = envelope.payload as Partial<GenerationSnapshotPayload>;
      this.emit({
        type: "slow",
        conversationId,
        runId,
        remoteUrl: payload.remoteUrl,
      });
      return;
    }
    if (envelope.type === "generation.complete") {
      const payload = envelope.payload as GenerationCompletePayload;
      this.emit({
        type: "complete",
        conversationId,
        runId,
        markdown: payload.markdown,
        remoteUrl: payload.remoteUrl,
        terminalTranscriptSha256: payload.terminalTranscriptSha256,
        terminalEventId: envelope.id,
      });
      return;
    }
    if (envelope.type === "generation.stopped") {
      const payload = envelope.payload as GenerationStoppedPayload;
      this.emit({
        type: "stopped",
        conversationId,
        runId,
        markdown: payload.markdown,
        remoteUrl: payload.remoteUrl,
        terminalTranscriptSha256: payload.terminalTranscriptSha256,
        terminalEventId: envelope.id,
      });
    }
  }

  private sendTerminalAcknowledgement(conversationId: string, runId: string, eventId: string) {
    if (!this.relay.connected) return;
    try {
      this.relay.send(
        makeEnvelope({
          type: "generation.ack",
          instanceId: this.relay.instanceId,
          conversationId,
          runId,
          payload: { eventId, acknowledgedAt: new Date().toISOString() },
        }),
      );
    } catch {
      // The Relay keeps the terminal event in its durable outbox and will
      // replay it after the authoritative connection is available again.
    }
  }

  private assertConnected() {
    if (!this.relay.connected) {
      throw new Error("连接尚未就绪，请稍后重新检查。");
    }
  }

  private requestRelayStatus() {
    if (this.disposed || !this.relay.connected || this.statusConfirmedForConnection) return;
    try {
      this.relay.send(
        makeEnvelope({
          type: "relay.status.request",
          instanceId: this.relay.instanceId,
          payload: { requestedAt: new Date().toISOString() },
        }),
      );
    } catch {
      // The authoritative socket may have changed between the connected check
      // and send. The retry below follows the next healthy generation.
    }
    this.scheduleStatusRequestRetry();
  }

  private scheduleStatusRequestRetry() {
    if (this.statusRequestTimer || this.disposed || this.statusConfirmedForConnection) return;
    const delays = [250, 500, 1_000, 2_000, 5_000] as const;
    const delay = delays[Math.min(this.statusRequestAttempt, delays.length - 1)]!;
    this.statusRequestAttempt += 1;
    this.statusRequestTimer = setTimeout(() => {
      this.statusRequestTimer = undefined;
      this.requestRelayStatus();
    }, delay);
    this.statusRequestTimer.unref();
  }

  private clearStatusRequestRetry() {
    if (this.statusRequestTimer) clearTimeout(this.statusRequestTimer);
    this.statusRequestTimer = undefined;
  }

  private assertReady() {
    if (!this.relay.connected) {
      throw new Error("连接尚未就绪，请稍后重新检查。");
    }
    if (!this.statusConfirmedForConnection) {
      throw new Error("正在同步连接状态，请稍后重试。");
    }
    if (this.project?.bound === false) {
      throw new Error("请先完成连接设置，再重试。");
    }
  }

  private reserveRun(conversationId: string, runId: string, envelope: RelayEnvelope) {
    this.finishedRunKeys.delete(this.runKey(conversationId, runId));
    this.activeRuns.set(conversationId, runId);
    this.activeRunStartedAt.set(this.runKey(conversationId, runId), Date.now());
    this.activeRunCommands.set(this.runKey(conversationId, runId), envelope);
  }

  private sendReservedRun(conversationId: string, runId: string, envelope: RelayEnvelope) {
    try {
      this.relay.send(envelope);
    } catch (error) {
      this.releaseRun(conversationId, runId);
      throw error;
    }
  }

  private replayActiveRunCommands() {
    this.pruneExpiredRuns();
    for (const [conversationId, runId] of this.activeRuns) {
      const envelope = this.activeRunCommands.get(this.runKey(conversationId, runId));
      if (!envelope) continue;
      try {
        // Chrome checkpoints a run before touching the page and treats an
        // identical conversation/run command as idempotent. Replaying only
        // after the replacement socket's authoritative status therefore
        // closes the transport-loss window without submitting twice.
        this.relay.send(envelope);
      } catch {
        // Keep the exact command reserved. A later authoritative connection
        // will retry it; clearing it here would strand the controller run.
      }
    }
  }

  private releaseRun(conversationId: string, runId: string) {
    const key = this.runKey(conversationId, runId);
    if (this.activeRuns.get(conversationId) === runId) {
      this.activeRuns.delete(conversationId);
    }
    this.activeRunStartedAt.delete(key);
    this.activeRunCommands.delete(key);
  }

  private pruneExpiredRuns(now = Date.now()) {
    for (const [conversationId, runId] of this.activeRuns) {
      const key = this.runKey(conversationId, runId);
      const startedAt = this.activeRunStartedAt.get(key);
      if (startedAt !== undefined && now - startedAt >= RUN_COMMAND_REPLAY_WINDOW_MS) {
        this.releaseRun(conversationId, runId);
      }
    }
  }

  private emit(event: BackendEvent) {
    this.events.emit("event", event);
  }

  private rememberFinishedRun(conversationId: string, runId: string, eventId?: string) {
    const key = this.runKey(conversationId, runId);
    const record = this.finishedRunKeys.get(key) ?? {
      acknowledgeAll: false,
      eventIds: new Set<string>(),
    };
    if (eventId) {
      record.eventIds.add(eventId);
      if (record.eventIds.size > 8) {
        const oldest = record.eventIds.values().next().value;
        if (oldest) record.eventIds.delete(oldest);
      }
    } else {
      record.acknowledgeAll = true;
    }
    // Map insertion order gives us a bounded LRU without a second structure
    // that can become inconsistent when a key is reserved again.
    this.finishedRunKeys.delete(key);
    this.finishedRunKeys.set(key, record);
    if (this.finishedRunKeys.size > 2_048) {
      const oldest = this.finishedRunKeys.keys().next().value;
      if (oldest) this.finishedRunKeys.delete(oldest);
    }
  }

  private hasFinishedRun(conversationId: string, runId: string) {
    return this.finishedRunKeys.has(this.runKey(conversationId, runId));
  }

  private isFinishedTerminalEvent(conversationId: string, runId: string, eventId: string) {
    const record = this.finishedRunKeys.get(this.runKey(conversationId, runId));
    return Boolean(record && (record.acknowledgeAll || record.eventIds.has(eventId)));
  }

  private rejectCanonicalizationRequests(error: Error) {
    for (const pending of this.canonicalizationRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.canonicalizationRequests.clear();
  }

  private requestConversationClose(conversationId: string): Promise<boolean> {
    const envelope = makeEnvelope({
      type: "conversation.close",
      instanceId: this.relay.instanceId,
      conversationId,
      payload: { closeTab: true },
    });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.closeRequests.delete(envelope.id);
        resolve(false);
      }, 3_000);
      timer.unref();
      this.closeRequests.set(envelope.id, { conversationId, timer, resolve });
      try {
        this.relay.send(envelope);
      } catch {
        clearTimeout(timer);
        this.closeRequests.delete(envelope.id);
        resolve(false);
      }
    });
  }

  private requestConversationRelease(
    conversationId: string,
    purpose: ConversationLeasePurpose,
    reason: ConversationReleaseReason,
  ): Promise<boolean> {
    const envelope = makeEnvelope({
      type: "conversation.release",
      instanceId: this.relay.instanceId,
      conversationId,
      payload: { purpose, reason },
    });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.releaseRequests.delete(envelope.id);
        resolve(false);
      }, 3_000);
      timer.unref();
      this.releaseRequests.set(envelope.id, {
        conversationId,
        purpose,
        reason,
        timer,
        resolve,
      });
      try {
        this.relay.send(envelope);
      } catch {
        clearTimeout(timer);
        this.releaseRequests.delete(envelope.id);
        resolve(false);
      }
    });
  }

  private resolveCloseRequests(acknowledged: boolean) {
    for (const pending of this.closeRequests.values()) {
      clearTimeout(pending.timer);
      pending.resolve(acknowledged);
    }
    this.closeRequests.clear();
  }

  private resolveReleaseRequests(acknowledged: boolean) {
    for (const pending of this.releaseRequests.values()) {
      clearTimeout(pending.timer);
      pending.resolve(acknowledged);
    }
    this.releaseRequests.clear();
  }

  private requestModels(
    conversationId: string,
    type: "model.list" | "model.select",
    modelId?: string,
    remoteUrl?: string,
  ): Promise<ChatModelOption[] | ChatModelOption> {
    this.assertReady();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.modelRequests.delete(requestId);
        reject(
          Object.assign(new Error("Timed out while refreshing models."), {
            code: "CHATGPT_MODEL_UNAVAILABLE",
          }),
        );
      }, 20_000);
      timer.unref();
      this.modelRequests.set(requestId, { conversationId, timer, resolve, reject });
      try {
        this.relay.send(
          type === "model.list"
            ? makeEnvelope({
                type,
                instanceId: this.relay.instanceId,
                conversationId,
                payload: { requestId, remoteUrl },
              })
            : makeEnvelope({
                type,
                instanceId: this.relay.instanceId,
                conversationId,
                payload: { requestId, modelId: modelId!, remoteUrl },
              }),
        );
      } catch (error) {
        clearTimeout(timer);
        this.modelRequests.delete(requestId);
        reject(error instanceof Error ? error : new Error("Model request failed."));
      }
    });
  }

  private rejectModelRequests(error: Error) {
    for (const pending of this.modelRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.modelRequests.clear();
  }

  private runKey(conversationId: string, runId: string) {
    return `${conversationId}:${runId}`;
  }
}
