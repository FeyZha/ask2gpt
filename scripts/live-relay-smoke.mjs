import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket, WebSocketServer } from "ws";

import {
  PROTOCOL_VERSION,
  RELAY_WEBSOCKET_PROTOCOL as RELAY_PROTOCOL,
  isRelayProductVersionCompatible,
  makeRelayStatusRequestPayload,
} from "../packages/protocol/src/runtime-contract.mjs";
import { readContentRuntimeRevision } from "./content-runtime-revision.mjs";

class SmokeFailure extends Error {
  constructor(code, hostIndex, stage, reason) {
    super(code);
    this.code = code;
    this.hostIndex = hostIndex;
    this.stage = stage;
    this.reason = reason;
  }
}

const CHROME_EXTENSION_ID = "jieljndeocnmdlfbmfknfgglfaoneceb";
const EXPECTED_ORIGIN = `chrome-extension://${CHROME_EXTENSION_ID}`;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const PORTS = Array.from({ length: 10 }, (_, index) => 32_171 + index);
const ONLY_OK_PROMPT = "\u53ea\u56de\u590d OK";
const FOLLOWUP_OK_PROMPT = "\u518d\u6b21\u53ea\u56de\u590d OK";
const ATTACHMENT_TOKEN = "violet-7294";
const ATTACHMENT_PROMPT = `Read the attached probe.ts file and reply with only the value assigned to ask2gpt_ATTACHMENT_PROBE.`;
const root = path.resolve(import.meta.dirname, "..");
const expectedContentRuntimeRevision = await readContentRuntimeRevision(root);
const manifest = JSON.parse(
  await readFile(path.join(root, "apps", "chrome-extension", "public", "manifest.json"), "utf8"),
);
const expectedRelayVersion = stringArgument("--expected-relay-version") ?? manifest.version;
const connectionTimeoutMs = numberArgument("--connection-timeout-ms", 90_000);
const generationTimeoutMs = numberArgument("--generation-timeout-ms", 180_000);
const defaultTerminalReplayGraceMs = Math.min(generationTimeoutMs, 10_000);
const cleanupReconnectTimeoutMs = Math.min(connectionTimeoutMs, 20_000);
const historyRefreshTimeoutMs = Math.min(generationTimeoutMs, 10_000);
const verifyAttachment = process.argv.includes("--verify-attachment");
const includeModelCatalog = process.argv.includes("--include-model-catalog");
const includeRelayErrorMessages = process.argv.includes("--include-relay-error-messages");
const skipModelCatalog = process.argv.includes("--skip-model-catalog");
const requestedModelId = stringArgument("--model-id");
const resumeRequested = process.argv.includes("--resume-remote-url");
const resumeRemoteUrl = stringArgument("--resume-remote-url");
const startedAt = Date.now();

let currentStage = "validate_arguments";
let hostCount;
let relayVersion;
let activeGenerations = 0;
let peakConcurrentGenerations = 0;
const hosts = [];

async function main() {
  let result;
  try {
    hostCount = boundedIntegerArgument("--host-count", 1, 1, 3);
    assertResumeConfiguration(resumeRemoteUrl, hostCount, verifyAttachment, resumeRequested);
    if (requestedModelId && skipModelCatalog) {
      throw new SmokeFailure("model_id_requires_catalog");
    }

    currentStage = "bind_loopback_ports";
    for (let index = 0; index < hostCount; index += 1) {
      const host = new LiveHost(index);
      hosts.push(host);
      await host.listen();
    }

    currentStage = "connect_and_verify_chrome_relays";
    // The Relay deliberately closes a socket that does not send relay.ready
    // within five seconds. Port discovery is sequential, so waiting for every
    // socket before authenticating the first one makes a three-Host verifier
    // race that safety timeout. Complete each Host handshake as soon as its
    // socket arrives, then wait for all Hosts before starting any generation.
    await Promise.all(
      hosts.map(async (host) => {
        await host.connect(connectionTimeoutMs);
        await host.authenticate();
      }),
    );
    relayVersion = hosts[0]?.relayVersion;
    if (hosts.some((host) => host.relayVersion !== relayVersion)) {
      throw new SmokeFailure("inconsistent_relay_versions");
    }

    currentStage = "verify_content_runtime_revision";
    assertExpectedContentRuntime(hosts, expectedContentRuntimeRevision);

    currentStage = "open_conversations";
    await Promise.all(
      hosts.map((host) => host.openConversation(host.index === 0 ? resumeRemoteUrl : undefined)),
    );

    // All Host workflows start together. Because each connection rejects an
    // envelope carrying another Host's instanceId, completing this phase also
    // verifies independent multi-window routing rather than serialized reuse.
    currentStage = resumeRemoteUrl ? "resume_existing_conversation" : "concurrent_generations";
    const results = resumeRemoteUrl
      ? [await verifyResumedPrimaryHost(hosts[0], resumeRemoteUrl)]
      : await Promise.all(
          hosts.map((host) =>
            host.index === 0 ? verifyPrimaryHost(host) : verifySecondaryHost(host),
          ),
        );
    if (peakConcurrentGenerations < hostCount) {
      throw new SmokeFailure("concurrent_routing_not_observed");
    }
    const verifiedRemoteUrls = results.map((result) => result.remoteUrl);
    if (
      verifiedRemoteUrls.some((remoteUrl) => !isConversationUrl(remoteUrl)) ||
      new Set(verifiedRemoteUrls).size !== hostCount
    ) {
      throw new SmokeFailure("cross_host_conversation_collision");
    }

    // A late Relay error used to arrive after the visible answer had already
    // finished. Keep the sockets alive briefly and require exactly one clean
    // completion for every run before declaring the real-browser smoke green.
    currentStage = "verify_terminal_quiescence";
    await delay(3_000);
    const runDiagnostics = hosts.flatMap((host) => [...host.runDiagnostics.values()]);
    for (const host of hosts) {
      host.stage = currentStage;
      assertCleanHostTerminalEvents(host, results[host.index]?.generations ?? 0);
    }

    const ports = hosts.map((host) => host.port);
    result = {
      ok: true,
      relayVersion,
      protocolVersion: PROTOCOL_VERSION,
      contentRuntimeRevision: expectedContentRuntimeRevision,
      hostCount,
      connectedHosts: hosts.filter((host) => host.authenticated).length,
      uniquePorts: new Set(ports).size,
      ports,
      secondaryRelayPortUsed: ports.some((port) => port !== 32_171),
      generations: results.reduce((sum, result) => sum + result.generations, 0),
      completionEvents: runDiagnostics.reduce((sum, run) => sum + run.generationCompletes, 0),
      generationErrors: runDiagnostics.reduce((sum, run) => sum + run.generationErrors, 0),
      generationStops: runDiagnostics.reduce((sum, run) => sum + run.generationStops, 0),
      cleanTerminalRuns: runDiagnostics.filter(
        (run) =>
          run.generationCompletes === 1 && run.generationErrors === 0 && run.generationStops === 0,
      ).length,
      conversationSends: hosts.reduce((sum, host) => sum + host.conversationSendCount, 0),
      resumedExistingConversation: Boolean(resumeRemoteUrl),
      peakConcurrentGenerations,
      snapshots: hosts.reduce((sum, host) => sum + host.snapshotCount, 0),
      historyMessagesByHost: results.map((result) => result.historyMessages),
      primaryFirstHistoryMessages: results[0]?.firstHistoryMessages,
      verifiedConversationUrls: results.filter((result) => result.urlVerified).length,
      uniqueConversationUrls: new Set(verifiedRemoteUrls).size,
      titlesObserved: hosts.filter((host) => host.titleObserved).length,
      modelCatalogsVerified: results.filter((result) => result.modelVerified).length,
      verifiedProjectBindings: hosts.filter((host) => host.projectBound).length,
      selectorVersions: hosts.map((host) => host.selectorVersion),
      attachmentsVerified: results.filter((result) => result.attachmentVerified).length,
      primaryModelCount: results[0]?.modelCount,
      ...(includeModelCatalog ? { primaryModels: results[0]?.models } : {}),
    };
  } catch (error) {
    const failedHost = error instanceof SmokeFailure ? error.hostIndex : undefined;
    result = {
      ok: false,
      stage: error instanceof SmokeFailure && error.stage ? error.stage : currentStage,
      code: error instanceof SmokeFailure ? error.code : "live_smoke_failed",
      ...(failedHost === undefined ? {} : { failedHost }),
      ...(error instanceof SmokeFailure && error.reason ? { reason: error.reason } : {}),
      relayVersion: relayVersion ?? hosts.find((host) => host.relayVersion)?.relayVersion,
      expectedRelayVersion,
      expectedContentRuntimeRevision,
      protocolVersion: PROTOCOL_VERSION,
      ...(hostCount === undefined ? {} : { hostCount }),
      boundHosts: hosts.filter((host) => host.server).length,
      connectedHosts: hosts.filter((host) => host.socket).length,
      hostDiagnostics: hosts.map((host) => host.diagnostics()),
    };
  } finally {
    currentStage = "cleanup";
    const cleanupResults = await Promise.all(hosts.map((host) => host.cleanup()));
    const cleanupFailedHosts = cleanupResults
      .filter((cleanup) => !cleanup.conversationClosed)
      .map((cleanup) => cleanup.hostIndex);
    if (cleanupFailedHosts.length > 0) {
      result = result?.ok
        ? {
            ...result,
            ok: false,
            stage: "cleanup",
            code: "conversation_cleanup_failed",
            cleanupFailedHosts,
            expectedRelayVersion,
            expectedContentRuntimeRevision,
          }
        : { ...result, cleanupFailedHosts };
    }
    result ??= {
      ok: false,
      stage: "cleanup",
      code: "live_smoke_failed",
      expectedRelayVersion,
      expectedContentRuntimeRevision,
      protocolVersion: PROTOCOL_VERSION,
    };
    if (!result.ok) result.hostDiagnostics = hosts.map((host) => host.diagnostics());
    result.elapsedMs = Date.now() - startedAt;
    printResult(result);
    if (!result.ok) process.exitCode = 1;
  }
}

class LiveHost {
  constructor(
    index,
    {
      cleanupAckTimeoutMs = 10_000,
      runTimeoutMs = generationTimeoutMs,
      terminalReplayGraceMs = defaultTerminalReplayGraceMs,
    } = {},
  ) {
    this.index = index;
    this.instanceId = `live-smoke-${randomUUID()}`;
    this.conversationId = `conversation-${randomUUID()}`;
    this.stage = "created";
    this.inbox = [];
    this.waiters = new Set();
    this.runDiagnostics = new Map();
    this.observedTerminalEventIds = new Set();
    this.runProbeTimers = new Set();
    this.conversationSendCount = 0;
    this.relayErrorCount = 0;
    this.generationStoppedCount = 0;
    this.snapshotCount = 0;
    this.titleObserved = false;
    this.authenticated = false;
    this.conversationOpened = false;
    this.rejectedProtocol = false;
    this.cleanupAckTimeoutMs = cleanupAckTimeoutMs;
    this.runTimeoutMs = runTimeoutMs;
    this.terminalReplayGraceMs = terminalReplayGraceMs;
  }

  async listen() {
    this.stage = "bind_loopback_port";
    for (const port of PORTS) {
      try {
        this.server = await this.listenOnPort(port);
        this.port = port;
        return;
      } catch (error) {
        if (error?.code !== "EADDRINUSE") throw this.annotate(error);
      }
    }
    throw this.failure("relay_port_pool_exhausted");
  }

  listenOnPort(port) {
    return new Promise((resolve, reject) => {
      const candidate = new WebSocketServer({
        host: "127.0.0.1",
        port,
        maxPayload: MAX_FRAME_BYTES,
        verifyClient: ({ origin, req }, done) => {
          const protocols = String(req.headers["sec-websocket-protocol"] || "")
            .split(",")
            .map((value) => value.trim());
          const allowed = origin === EXPECTED_ORIGIN && protocols.includes(RELAY_PROTOCOL);
          if (!allowed && origin === EXPECTED_ORIGIN) this.rejectedProtocol = true;
          done(allowed, allowed ? 101 : 403, "Forbidden");
        },
      });
      candidate.on("connection", (connectedSocket) => {
        if (this.connectionResolver) {
          const resolveConnection = this.connectionResolver;
          this.connectionResolver = undefined;
          resolveConnection(connectedSocket);
        } else if (!this.queuedConnection) {
          this.queuedConnection = connectedSocket;
        } else {
          connectedSocket.close(1013, "Smoke verifier already has a relay");
        }
      });
      const onError = (error) => {
        candidate.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        candidate.removeListener("error", onError);
        resolve(candidate);
      };
      candidate.once("error", onError);
      candidate.once("listening", onListening);
    });
  }

  async connect(timeoutMs) {
    this.stage = "wait_for_chrome_relay";
    const connectedSocket = await this.waitForConnection(timeoutMs);
    this.socket = connectedSocket;
    this.authenticated = false;
    connectedSocket.on("message", (data, isBinary) => this.handleMessage(data, isBinary));
    connectedSocket.on("close", () => {
      if (this.socket !== connectedSocket) return;
      this.authenticated = false;
      this.flushWaiters(this.failure("relay_disconnected"));
    });
    connectedSocket.on("error", () => {
      if (this.socket === connectedSocket) {
        this.flushWaiters(this.failure("relay_socket_error"));
      }
    });
  }

  waitForConnection(timeoutMs) {
    if (this.queuedConnection) {
      const connectedSocket = this.queuedConnection;
      this.queuedConnection = undefined;
      if (connectedSocket.readyState === WebSocket.OPEN) return Promise.resolve(connectedSocket);
      connectedSocket.terminate();
    }
    return new Promise((resolve, reject) => {
      this.connectionReject = reject;
      this.connectionTimer = setTimeout(() => {
        this.connectionResolver = undefined;
        this.connectionReject = undefined;
        this.connectionTimer = undefined;
        reject(
          this.failure(
            this.rejectedProtocol ? "relay_protocol_mismatch" : "chrome_relay_not_detected",
          ),
        );
      }, timeoutMs);
      this.connectionResolver = (connectedSocket) => {
        clearTimeout(this.connectionTimer);
        this.connectionTimer = undefined;
        this.connectionReject = undefined;
        resolve(connectedSocket);
      };
    });
  }

  handleMessage(data, isBinary) {
    if (isBinary || data.byteLength > MAX_FRAME_BYTES) {
      this.socket.close(1009, "Invalid relay frame");
      return;
    }
    let envelope;
    try {
      envelope = JSON.parse(data.toString("utf8"));
    } catch {
      this.socket.close(1007, "Invalid relay JSON");
      return;
    }
    if (
      !envelope ||
      envelope.version !== PROTOCOL_VERSION ||
      envelope.instanceId !== this.instanceId ||
      typeof envelope.type !== "string"
    ) {
      this.socket.close(1008, "Invalid relay envelope");
      return;
    }
    this.observeEnvelope(envelope);
    this.inbox.push(envelope);
    this.flushWaiters();
  }

  async authenticate() {
    this.stage = "verify_runtime_version";
    this.send("relay.ready", {
      serverLabel: `Ask2GPT live verification host ${this.index + 1}`,
      serverInstanceId: this.instanceId,
    });
    const hello = await this.waitForEnvelope((envelope) => envelope.type === "relay.hello", 10_000);
    this.relayVersion = hello.payload?.chromeVersion;
    if (
      hello.payload?.chromeExtensionId !== CHROME_EXTENSION_ID ||
      !isRelayProductVersionCompatible(expectedRelayVersion, this.relayVersion)
    ) {
      throw this.failure("runtime_version_mismatch");
    }
    const status = await this.waitForEnvelope(
      (envelope) => envelope.type === "relay.status" && envelope.payload?.authenticated === true,
      10_000,
    );
    this.selectorVersion = Number.isInteger(status.payload?.selectorVersion)
      ? status.payload.selectorVersion
      : undefined;
    this.projectBound =
      status.payload?.project?.bound === true && status.payload?.project?.name === "Ask2GPT";
    this.authenticated = true;
    this.heartbeat = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.send("heartbeat", { at: new Date().toISOString() });
      }
    }, 20_000);
    this.heartbeat.unref();
  }

  async openConversation(remoteUrl) {
    this.stage = isConversationUrl(remoteUrl)
      ? "open_existing_conversation"
      : "open_new_conversation";
    this.send("conversation.open", isConversationUrl(remoteUrl) ? { remoteUrl } : {}, {
      conversationId: this.conversationId,
    });
    this.conversationOpened = true;
    if (!this.projectBound) {
      const binding = await this.waitForEnvelope(
        (envelope) =>
          (envelope.type === "relay.status" &&
            envelope.payload?.project?.bound === true &&
            envelope.payload?.project?.name === "Ask2GPT") ||
          (envelope.type === "relay.error" && envelope.conversationId === this.conversationId),
        20_000,
      );
      if (binding.type === "relay.error") {
        throw this.failure(
          binding.payload?.code || "ask2gpt_project_not_verified",
          classifyRelayErrorReason(binding.payload),
        );
      }
      this.projectBound = true;
    }
  }

  async verifyResumeConversation(remoteUrl, timeoutMs = generationTimeoutMs) {
    this.stage = "resume_history_gate";
    if (!isConversationUrl(remoteUrl)) throw this.failure("invalid_resume_remote_url");
    if (this.conversationSendCount !== 0) throw this.failure("resume_gate_after_send");
    if (this.relayErrorCount !== 0 || this.generationStoppedCount !== 0) {
      throw this.failure("resume_gate_not_quiescent");
    }

    const initialRelayErrors = this.relayErrorCount;
    const initialStops = this.generationStoppedCount;
    const deadline = Date.now() + timeoutMs;
    let idleVerified = false;
    let latestSnapshot;
    let nextRefreshAt = 0;

    while (Date.now() < deadline) {
      if (this.relayErrorCount !== initialRelayErrors) {
        throw this.failure("resume_gate_relay_error");
      }
      if (this.generationStoppedCount !== initialStops) {
        throw this.failure("resume_gate_generation_stopped");
      }
      if (this.conversationSendCount !== 0) throw this.failure("resume_gate_after_send");

      if (Date.now() >= nextRefreshAt) {
        this.send("conversation.open", { remoteUrl }, { conversationId: this.conversationId });
        this.send("relay.status.request", makeRelayStatusRequestPayload());
        nextRefreshAt = Date.now() + Math.min(historyRefreshTimeoutMs, 2_000);
      }

      let observed;
      try {
        observed = await this.waitForEnvelope(
          (envelope) =>
            envelope.type === "relay.error" ||
            envelope.type === "generation.stopped" ||
            envelope.type === "relay.status" ||
            (envelope.type === "conversation.snapshot" &&
              envelope.conversationId === this.conversationId),
          Math.min(Math.max(1, deadline - Date.now()), Math.max(1, nextRefreshAt - Date.now())),
        );
      } catch (error) {
        if (error instanceof SmokeFailure && error.code === "relay_event_timeout") continue;
        throw error;
      }

      if (observed.type === "relay.error") {
        throw this.failure(
          observed.payload?.code || "resume_gate_relay_error",
          classifyRelayErrorReason(observed.payload),
        );
      }
      if (observed.type === "generation.stopped") {
        throw this.failure("resume_gate_generation_stopped");
      }
      if (observed.type === "relay.status") {
        if (Number(observed.payload?.activeRuns) !== 0) {
          throw this.failure("resume_gate_active_runs_present");
        }
        idleVerified = true;
      } else {
        if (!sameConversationIdentity(observed.payload?.remoteUrl, remoteUrl)) {
          throw this.failure("resume_conversation_url_mismatch");
        }
        latestSnapshot = observed;
        if (observed.payload?.complete === true) {
          assertExactOkHistory(observed.payload.messages, [ONLY_OK_PROMPT], this, {
            code: "resume_history_mismatch",
          });
        }
      }

      if (idleVerified && latestSnapshot?.payload?.complete === true) {
        if (
          this.relayErrorCount !== initialRelayErrors ||
          this.generationStoppedCount !== initialStops ||
          this.conversationSendCount !== 0
        ) {
          throw this.failure("resume_gate_not_quiescent");
        }
        this.latestRemoteUrl = latestSnapshot.payload.remoteUrl;
        return latestSnapshot;
      }
    }

    throw this.failure(
      "resume_history_gate_timeout",
      summarizeHistoryForSmoke(latestSnapshot?.payload?.messages),
    );
  }

  async runQuestion(prompt, remoteUrl, modelId, attachments) {
    const runId = `run-${randomUUID()}`;
    const runDiagnostic = {
      runId,
      stage: this.stage,
      generationSnapshots: 0,
      generationCompletes: 0,
      generationErrors: 0,
      generationStops: 0,
      terminalObserved: false,
      statusSamples: [],
    };
    this.runDiagnostics.set(runId, runDiagnostic);
    this.send(
      "conversation.send",
      {
        prompt,
        messageId: `message-${randomUUID()}`,
        ...(isConversationUrl(remoteUrl) ? { remoteUrl } : {}),
        ...(typeof modelId === "string" ? { modelId } : {}),
        ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
      },
      { conversationId: this.conversationId, runId },
    );
    this.conversationSendCount += 1;
    this.snapshotEvidenceRunId = runId;
    const snapshotProbe = this.startRunSnapshotProbe(runId, remoteUrl);
    activeGenerations += 1;
    peakConcurrentGenerations = Math.max(peakConcurrentGenerations, activeGenerations);
    try {
      const terminal = await this.waitForRunTerminal(runId, snapshotProbe);
      if (terminal.type === "relay.error") {
        throw this.failure(
          terminal.payload?.code || "relay_error",
          classifyRelayErrorReason(terminal.payload),
        );
      }
      if (terminal.type === "generation.stopped") {
        throw this.failure("generation_stopped");
      }
      return terminal;
    } finally {
      this.stopRunSnapshotProbe(snapshotProbe);
      this.finishSnapshotEvidence(runId);
      activeGenerations -= 1;
    }
  }

  async waitForRunTerminal(runId, snapshotProbe) {
    const isRunTerminal = (envelope) =>
      envelope.conversationId === this.conversationId &&
      envelope.runId === runId &&
      ["generation.complete", "generation.stopped", "relay.error"].includes(envelope.type);
    try {
      return await this.waitForEnvelope(isRunTerminal, this.runTimeoutMs);
    } catch (error) {
      if (!(error instanceof SmokeFailure) || error.code !== "relay_event_timeout") throw error;
      this.stopRunSnapshotProbe(snapshotProbe);
      return this.waitForSettledRunTerminalReplay(isRunTerminal, error);
    }
  }

  async waitForSettledRunTerminalReplay(isRunTerminal, timeoutError) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw timeoutError;

    // Drop probe responses that were already buffered, then request one final
    // status/outbox flush. A terminal may arrive before the fresh status (the
    // preferred Relay ordering); otherwise the per-instance activeRuns count
    // must reach zero before this Host enters its bounded replay window.
    this.inbox = this.inbox.filter((envelope) => envelope.type !== "relay.status");
    try {
      this.send("relay.status.request", makeRelayStatusRequestPayload());
    } catch {
      throw timeoutError;
    }

    const deadline = Date.now() + this.terminalReplayGraceMs;
    let observed;
    try {
      observed = await this.waitForEnvelope(
        (envelope) => isRunTerminal(envelope) || envelope.type === "relay.status",
        this.terminalReplayGraceMs,
      );
    } catch (error) {
      if (error instanceof SmokeFailure && error.code === "relay_event_timeout") {
        throw timeoutError;
      }
      throw error;
    }
    if (isRunTerminal(observed)) return observed;
    if (Number(observed.payload?.activeRuns) !== 0) throw timeoutError;

    const remainingMs = Math.max(1, deadline - Date.now());
    try {
      return await this.waitForEnvelope(isRunTerminal, remainingMs);
    } catch (error) {
      if (error instanceof SmokeFailure && error.code === "relay_event_timeout") {
        throw this.failure("terminal_replay_missing_after_run_settled");
      }
      throw error;
    }
  }

  startRunSnapshotProbe(runId, initialRemoteUrl, intervalMs = 5_000) {
    const timer = setInterval(() => {
      const run = this.runDiagnostics.get(runId);
      if (!run || run.terminalObserved) {
        this.stopRunSnapshotProbe(timer);
        return;
      }
      const remoteUrl = isConversationUrl(this.latestRemoteUrl)
        ? this.latestRemoteUrl
        : initialRemoteUrl;
      if (
        !isConversationUrl(remoteUrl) ||
        !this.conversationOpened ||
        !this.authenticated ||
        this.socket?.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      try {
        this.send("relay.status.request", makeRelayStatusRequestPayload());
      } catch {
        // The run's existing terminal waiter owns connection failure reporting.
      }
    }, intervalMs);
    timer.unref();
    this.runProbeTimers.add(timer);
    return timer;
  }

  stopRunSnapshotProbe(timer) {
    if (!timer) return;
    clearInterval(timer);
    this.runProbeTimers.delete(timer);
  }

  async listModels(remoteUrl) {
    const requestId = `model-list-${randomUUID()}`;
    this.send(
      "model.list",
      { requestId, ...(isConversationUrl(remoteUrl) ? { remoteUrl } : {}) },
      { conversationId: this.conversationId },
    );
    const response = await this.waitForEnvelope(
      (envelope) =>
        envelope.conversationId === this.conversationId &&
        ((envelope.type === "model.catalog" && envelope.payload?.requestId === requestId) ||
          envelope.type === "relay.error"),
      generationTimeoutMs,
    );
    if (response.type === "relay.error") {
      throw this.failure(
        response.payload?.code || "model_list_failed",
        classifyRelayErrorReason(response.payload),
      );
    }
    return response.payload;
  }

  async selectModel(modelId, remoteUrl) {
    const requestId = `model-select-${randomUUID()}`;
    this.send(
      "model.select",
      { requestId, modelId, ...(isConversationUrl(remoteUrl) ? { remoteUrl } : {}) },
      { conversationId: this.conversationId },
    );
    const response = await this.waitForEnvelope(
      (envelope) =>
        envelope.conversationId === this.conversationId &&
        ((envelope.type === "model.selected" && envelope.payload?.requestId === requestId) ||
          envelope.type === "relay.error"),
      generationTimeoutMs,
    );
    if (response.type === "relay.error") {
      throw this.failure(
        response.payload?.code || "model_select_failed",
        classifyRelayErrorReason(response.payload),
      );
    }
    return response.payload?.selected;
  }

  async waitForCompleteHistory(
    minimumMessages,
    preferredRemoteUrl,
    evidenceRunId,
    expectedLocalMessages,
  ) {
    const scopedEvidenceRunId =
      typeof evidenceRunId === "string" && this.runDiagnostics.has(evidenceRunId)
        ? evidenceRunId
        : undefined;
    if (scopedEvidenceRunId) this.snapshotEvidenceRunId = scopedEvidenceRunId;
    try {
      const remoteUrl = isConversationUrl(preferredRemoteUrl)
        ? preferredRemoteUrl
        : this.latestRemoteUrl;
      if (!isConversationUrl(remoteUrl)) throw this.failure("conversation_url_missing");

      const deadline = Date.now() + generationTimeoutMs;
      let latestSnapshot;
      while (Date.now() < deadline) {
        const buffered = this.consumeBufferedHistory(
          minimumMessages,
          scopedEvidenceRunId,
          expectedLocalMessages,
        );
        if (buffered.match) return buffered.match;
        latestSnapshot = buffered.latest ?? latestSnapshot;

        // generation.complete is emitted before the Relay's DOM inspection. If
        // that first inspection catches ChatGPT while its transcript is still
        // settling, it can legitimately report complete=false and no later
        // navigation event is guaranteed to trigger another snapshot. Re-open
        // the existing mapping in the background to request a fresh inspection.
        const refreshRemoteUrl = isConversationUrl(this.latestRemoteUrl)
          ? this.latestRemoteUrl
          : remoteUrl;
        const transcriptProof = buildSmokeTranscriptProof(refreshRemoteUrl, expectedLocalMessages);
        this.send(
          "conversation.open",
          { remoteUrl: refreshRemoteUrl, ...(transcriptProof ? { transcriptProof } : {}) },
          { conversationId: this.conversationId },
        );
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;

        let observed;
        try {
          observed = await this.waitForEnvelope(
            (envelope) =>
              envelope.conversationId === this.conversationId &&
              (envelope.type === "conversation.snapshot" || envelope.type === "relay.error"),
            Math.min(historyRefreshTimeoutMs, remaining),
          );
        } catch (error) {
          if (error instanceof SmokeFailure && error.code === "relay_event_timeout") continue;
          throw error;
        }
        if (observed.type === "relay.error") {
          throw this.failure(
            observed.payload?.code || "conversation_snapshot_failed",
            classifyRelayErrorReason(observed.payload),
          );
        }
        latestSnapshot = observed;
        const reconciled = reconcileSmokeHistorySnapshot(
          observed,
          this.conversationId,
          minimumMessages,
          expectedLocalMessages,
          this,
        );
        if (reconciled) return reconciled;
        await delay(Math.min(250, Math.max(0, deadline - Date.now())));
      }
      throw this.failure(
        "conversation_history_timeout",
        summarizeHistoryForSmoke(latestSnapshot?.payload?.messages),
      );
    } finally {
      this.finishSnapshotEvidence(scopedEvidenceRunId);
    }
  }

  consumeBufferedHistory(minimumMessages, evidenceRunId, expectedLocalMessages) {
    let match;
    let latest;
    const retained = [];
    for (const envelope of this.inbox) {
      if (
        envelope.type === "conversation.snapshot" &&
        envelope.conversationId === this.conversationId
      ) {
        latest = envelope;
        if (evidenceRunId) this.recordRunSnapshot(evidenceRunId, envelope.payload);
        const reconciled = reconcileSmokeHistorySnapshot(
          envelope,
          this.conversationId,
          minimumMessages,
          expectedLocalMessages,
          this,
        );
        if (reconciled) match = reconciled;
      } else {
        retained.push(envelope);
      }
    }
    this.inbox = retained;
    return { match, latest };
  }

  finishSnapshotEvidence(runId) {
    if (typeof runId === "string" && this.snapshotEvidenceRunId === runId) {
      this.snapshotEvidenceRunId = undefined;
    }
  }

  recordRunSnapshot(runId, payload) {
    const run = this.runDiagnostics.get(runId);
    if (run) run.latestSnapshot = snapshotDiagnostic(payload);
  }

  observeEnvelope(envelope) {
    this.observedEventTypes ??= new Set();
    this.observedEventTypes.add(envelope.type);
    if (envelope.type === "generation.snapshot") this.snapshotCount += 1;
    const terminalEvent = ["generation.complete", "generation.stopped", "relay.error"].includes(
      envelope.type,
    );
    const terminalEventId = terminalEvent && typeof envelope.id === "string" ? envelope.id : null;
    const duplicateTerminal =
      terminalEventId !== null && this.observedTerminalEventIds.has(terminalEventId);
    if (terminalEventId !== null) this.observedTerminalEventIds.add(terminalEventId);
    const run =
      typeof envelope.runId === "string" ? this.runDiagnostics.get(envelope.runId) : undefined;
    if (envelope.type === "relay.error" && !duplicateTerminal) {
      this.relayErrorCount += 1;
      if (includeRelayErrorMessages) {
        this.lastRelayError = {
          code: typeof envelope.payload?.code === "string" ? envelope.payload.code : "unknown",
          message:
            typeof envelope.payload?.message === "string"
              ? envelope.payload.message.slice(0, 1_000)
              : "",
        };
      }
    }
    if (envelope.type === "generation.stopped" && !duplicateTerminal) {
      this.generationStoppedCount += 1;
    }
    if (run && !duplicateTerminal) {
      if (envelope.type === "generation.snapshot") run.generationSnapshots += 1;
      else if (envelope.type === "generation.complete") {
        run.generationCompletes += 1;
        run.terminalObserved = true;
      } else if (envelope.type === "relay.error") {
        run.generationErrors += 1;
        run.terminalObserved = true;
        const composerDiagnostic = parseComposerErrorDiagnostic(envelope.payload);
        if (composerDiagnostic) run.composerDiagnostic = composerDiagnostic;
      } else if (envelope.type === "generation.stopped") {
        run.generationStops = (run.generationStops ?? 0) + 1;
        run.terminalObserved = true;
      }
    }
    if (envelope.type === "conversation.snapshot" && this.snapshotEvidenceRunId) {
      this.recordRunSnapshot(this.snapshotEvidenceRunId, envelope.payload);
    }
    if (envelope.type === "relay.status" && this.snapshotEvidenceRunId) {
      const activeRun = this.runDiagnostics.get(this.snapshotEvidenceRunId);
      if (activeRun && activeRun.statusSamples.length < 80) {
        activeRun.statusSamples.push({
          activeRuns: Number(envelope.payload?.activeRuns ?? -1),
          elapsedMs: Date.now() - startedAt,
          ...(typeof envelope.payload?.diagnosticStage === "string"
            ? { diagnosticStage: envelope.payload.diagnosticStage }
            : {}),
        });
      }
    }
    if (envelope.type === "conversation.title" || envelope.payload?.title) {
      this.titleObserved = true;
    }
    const candidate = envelope.payload?.remoteUrl;
    if (isConversationUrl(candidate)) this.latestRemoteUrl = candidate;
    if (
      ["generation.complete", "generation.stopped", "relay.error"].includes(envelope.type) &&
      typeof envelope.id === "string" &&
      typeof envelope.conversationId === "string" &&
      typeof envelope.runId === "string"
    ) {
      try {
        this.send(
          "generation.ack",
          { eventId: envelope.id, acknowledgedAt: new Date().toISOString() },
          { conversationId: envelope.conversationId, runId: envelope.runId },
        );
      } catch {
        // A reconnect will replay the durable terminal event and give the
        // verification host another opportunity to acknowledge it.
      }
    }
  }

  send(type, payload, identifiers = {}) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw this.failure("relay_not_connected");
    }
    socket.send(this.serializeEnvelope(type, payload, identifiers));
  }

  async sendAndFlush(type, payload, identifiers = {}) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw this.failure("relay_not_connected");
    }
    const envelope = this.createEnvelope(type, payload, identifiers);
    await new Promise((resolve, reject) => {
      socket.send(JSON.stringify(envelope), (error) => {
        if (error) reject(this.annotate(error));
        else resolve();
      });
    });
    return envelope;
  }

  serializeEnvelope(type, payload, identifiers = {}) {
    return JSON.stringify(this.createEnvelope(type, payload, identifiers));
  }

  createEnvelope(type, payload, identifiers = {}) {
    return {
      version: PROTOCOL_VERSION,
      id: randomUUID(),
      type,
      instanceId: this.instanceId,
      ...identifiers,
      payload,
    };
  }

  waitForEnvelope(predicate, timeoutMs) {
    const bufferedIndex = this.inbox.findIndex(predicate);
    if (bufferedIndex >= 0) return Promise.resolve(this.inbox.splice(bufferedIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(this.failure("relay_event_timeout"));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  flushWaiters(error) {
    for (const waiter of [...this.waiters]) {
      if (error) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.reject(error);
        continue;
      }
      const index = this.inbox.findIndex(waiter.predicate);
      if (index < 0) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(this.inbox.splice(index, 1)[0]);
    }
  }

  async closeConversation() {
    if (!this.conversationOpened) return;
    this.stage = "close_conversation";
    if (!this.authenticated || this.socket?.readyState !== WebSocket.OPEN) {
      await this.reconnectForCleanup();
    }
    const request = await this.sendAndFlush(
      "conversation.close",
      { closeTab: true },
      { conversationId: this.conversationId },
    );
    const acknowledgement = await this.waitForEnvelope(
      (envelope) =>
        envelope.type === "conversation.closed" &&
        envelope.conversationId === this.conversationId &&
        envelope.runId === undefined &&
        envelope.payload?.requestId === request.id,
      this.cleanupAckTimeoutMs,
    );
    if (
      acknowledgement.payload?.closeTab !== true ||
      !["closed", "already-absent"].includes(acknowledgement.payload?.tabDisposition)
    ) {
      throw this.failure("conversation_cleanup_invalid_ack");
    }
    this.conversationOpened = false;
  }

  async reconnectForCleanup() {
    if (this.authenticated && this.socket?.readyState === WebSocket.OPEN) return;
    const previousSocket = this.socket;
    if (previousSocket) {
      await closeSocket(previousSocket).catch(() => undefined);
      if (this.socket === previousSocket) this.socket = undefined;
    }
    this.authenticated = false;
    this.inbox = [];
    await this.connect(cleanupReconnectTimeoutMs);
    await this.authenticate();
  }

  async cleanup() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const timer of [...this.runProbeTimers]) this.stopRunSnapshotProbe(timer);
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = undefined;
    }
    if (this.connectionReject) {
      const rejectConnection = this.connectionReject;
      this.connectionReject = undefined;
      this.connectionResolver = undefined;
      rejectConnection(this.failure("smoke_cleanup"));
    }
    this.flushWaiters(this.failure("smoke_cleanup"));

    let cleanupErrorCode;
    for (let attempt = 0; this.conversationOpened && attempt < 2; attempt += 1) {
      try {
        await this.closeConversation();
      } catch (error) {
        cleanupErrorCode =
          error instanceof SmokeFailure ? error.code : "conversation_cleanup_failed";
        this.authenticated = false;
        const failedSocket = this.socket;
        if (failedSocket) {
          await closeSocket(failedSocket).catch(() => undefined);
          if (this.socket === failedSocket) this.socket = undefined;
        }
      }
    }
    if (this.heartbeat) clearInterval(this.heartbeat);
    try {
      await closeSocket(this.socket);
    } catch {
      // A failed socket close must not skip server and tab cleanup.
    }
    try {
      await closeServer(this.server);
    } catch {
      // Cleanup remains best effort on both successful and failed verification.
    }
    return {
      hostIndex: this.index,
      conversationClosed: !this.conversationOpened,
      ...(cleanupErrorCode && this.conversationOpened ? { errorCode: cleanupErrorCode } : {}),
    };
  }

  diagnostics() {
    return {
      host: this.index,
      stage: this.stage,
      authenticated: this.authenticated,
      socketOpen: this.socket?.readyState === WebSocket.OPEN,
      snapshots: this.snapshotCount,
      titleObserved: this.titleObserved,
      conversationUrlObserved: isConversationUrl(this.latestRemoteUrl),
      projectBound: this.projectBound === true,
      eventTypes: [...(this.observedEventTypes ?? [])].sort(),
      runs: [...this.runDiagnostics.values()].map(
        ({
          runId,
          stage,
          generationSnapshots,
          generationCompletes,
          generationErrors,
          generationStops = 0,
          statusSamples,
          latestSnapshot,
          composerDiagnostic,
        }) => ({
          runId,
          stage,
          generationSnapshots,
          generationCompletes,
          generationErrors,
          generationStops,
          ...(Array.isArray(statusSamples) ? { statusSamples } : {}),
          ...(composerDiagnostic ? { composerDiagnostic: { ...composerDiagnostic } } : {}),
          ...(latestSnapshot
            ? {
                latestSnapshot: {
                  messageCount: latestSnapshot.messageCount,
                  tailRoles: [...latestSnapshot.tailRoles],
                  complete: latestSnapshot.complete,
                },
              }
            : {}),
        }),
      ),
      conversationSends: this.conversationSendCount,
      relayErrors: this.relayErrorCount,
      generationStops: this.generationStoppedCount,
      ...(includeRelayErrorMessages && this.lastRelayError
        ? { lastRelayError: { ...this.lastRelayError } }
        : {}),
      ...(includeModelCatalog && this.models ? { models: this.models } : {}),
    };
  }

  failure(code, reason) {
    return new SmokeFailure(code, this.index, this.stage, reason);
  }

  annotate(error) {
    return error instanceof SmokeFailure
      ? error
      : new SmokeFailure("live_smoke_failed", this.index, this.stage);
  }
}

function classifyRelayErrorReason(payload) {
  if (payload?.code === "CHATGPT_PROJECT_REQUIRED") return "project_required";
  if (payload?.code === "CHATGPT_PROJECT_MISMATCH") return "project_mismatch";
  if (payload?.code === "SELECTOR_INCOMPATIBLE") return "selector_incompatible";
  const message = typeof payload?.message === "string" ? payload.message : "";
  const lifecycle = /Run lifecycle: intent=(\d) submitted=(\d) started=(\d) complete=(\d)/u.exec(
    message,
  );
  if (lifecycle) {
    return `run_lifecycle_i${lifecycle[1]}_s${lifecycle[2]}_r${lifecycle[3]}_c${lifecycle[4]}`;
  }
  if (/已有回答正在生成/u.test(message)) return "tab_run_still_active";
  if (/发送按钮不可用/u.test(message)) return "send_button_unavailable";
  if (/未能建立 ChatGPT 的受信任发送通道/u.test(message)) {
    return "trusted_input_unavailable";
  }
  if (/未确认 ChatGPT 页面已接受本次发送/u.test(message)) {
    return "trusted_input_not_confirmed";
  }
  if (/问题仍保留在输入框中/u.test(message)) return "submission_actuation_ignored";
  if (/主世界发送通道中断/u.test(message)) return "main_world_send_channel_interrupted";
  if (/could not capture a complete, stable pre-send transcript/u.test(message)) {
    if (/baseline-invalidated/u.test(message)) return "transcript_baseline_invalidated";
    if (/inspect-page-mismatch/u.test(message)) return "transcript_page_mismatch";
    if (/inspect-response-missing/u.test(message)) return "transcript_inspection_unavailable";
    if (/inspect-snapshot-invalid/u.test(message)) return "transcript_snapshot_invalid";
    if (/partial-cache/u.test(message)) return "transcript_partial_cache_missing";
    if (/partial-empty/u.test(message)) return "transcript_partial_empty_unattested";
    if (/partial-mismatch/u.test(message)) return "transcript_partial_mismatch";
    if (/baseline-unavailable/u.test(message)) return "transcript_baseline_unavailable";
    if (/baseline-unstable/u.test(message)) return "transcript_baseline_unstable";
    return "transcript_baseline_missing";
  }
  if (/会话页面在发送前检查期间发生了变化/u.test(message)) {
    return "dispatch_page_changed";
  }
  if (/conversation page changed while its composer was being prepared/u.test(message)) {
    return "composer_page_changed";
  }
  if (/did not expose a ready composer/u.test(message)) return "composer_not_ready";
  if (/未确认问题已发送/u.test(message)) return "submission_not_confirmed";
  if (/输入框未接受完整问题/u.test(message)) return "composer_rejected_prompt";
  if (/找不到 ChatGPT 输入框/u.test(message)) return "composer_missing";
  if (/多个可见输入框/u.test(message)) return "multiple_composers";
  if (/多个可用发送按钮/u.test(message)) return "multiple_send_buttons";
  if (/已检查后台 DOM/u.test(message)) return "model_trigger_missing_background_dom";
  if (/没有可见的模型选择控件/u.test(message)) return "model_trigger_missing_legacy";
  if (/模型菜单没有打开/u.test(message)) return "model_menu_not_opened";
  if (/没有提供可识别的可见模型选项/u.test(message)) return "model_options_missing";
  if (/多个模型选择控件/u.test(message)) return "multiple_model_triggers";
  if (/多个可见菜单/u.test(message)) return "multiple_model_menus";
  if (/模型选项标识发生冲突/u.test(message)) return "model_option_identity_collision";
  if (/同时标记了多个当前模型/u.test(message)) return "multiple_current_models";
  if (/当前页面没有显示唯一的 Ask2GPT Project/u.test(message)) {
    return "project_link_not_visible";
  }
  if (/用于发现 Project 的 ChatGPT 页面未在 4 秒内加载完成/u.test(message)) {
    return "project_discovery_content_unavailable";
  }
  if (/新会话尚未创建/u.test(message)) return "project_not_discovered";
  return "unspecified_relay_error";
}

function parseComposerErrorDiagnostic(payload) {
  if (payload?.code !== "SELECTOR_INCOMPATIBLE" && payload?.code !== "CHATGPT_COMPOSER_MISSING") {
    return undefined;
  }
  const message = typeof payload?.message === "string" ? payload.message : "";
  const match =
    /(?:^| )raw=(0|[1-9]|[12]\d|3[0-2]) ready=(0|[1-9]|[12]\d|3[0-2]) visibility=(visible|hidden)$/u.exec(
      message,
    );
  if (!match) return undefined;
  const rawCandidateCount = Number(match[1]);
  const readyCandidateCount = Number(match[2]);
  return {
    rawCandidateCount,
    readyCandidateCount,
    visibilityState: match[3],
  };
}

async function verifyPrimaryHost(host) {
  try {
    let catalog;
    let selectedModelId;
    if (!skipModelCatalog) {
      host.stage = "model_catalog";
      catalog = await host.listModels();
      host.models = catalog.options.map(({ id, label, description, selected }) => ({
        id,
        label,
        ...(description ? { description } : {}),
        selected,
      }));
      const selectedModel = requestedModelId
        ? catalog?.options?.find((option) => option.id === requestedModelId)
        : (catalog?.options?.find((option) => option.id === catalog.currentModelId) ??
          catalog?.options?.find((option) => option.selected));
      if (requestedModelId && !selectedModel) {
        throw host.failure("requested_model_missing", requestedModelId);
      }
      if (!selectedModel?.id) throw host.failure("model_catalog_missing_selection");
      const confirmedModel = await host.selectModel(selectedModel.id);
      if (confirmedModel?.id !== selectedModel.id) {
        throw host.failure("model_selection_not_confirmed");
      }
      selectedModelId = selectedModel.id;
    }

    host.stage = "first_generation";
    const firstRun = await host.runQuestion(ONLY_OK_PROMPT, undefined, selectedModelId);
    const firstExpectedHistory = terminalBackedSmokeHistory([], ONLY_OK_PROMPT, firstRun);
    const firstHistory = await host.waitForCompleteHistory(
      2,
      firstRun.payload?.remoteUrl,
      firstRun.runId,
      firstExpectedHistory,
    );
    assertExactAnswer(firstRun.payload?.markdown, "OK", host);
    assertHistoryTail(firstHistory.payload.messages, [ONLY_OK_PROMPT], host);

    if (!shouldVerifyPrimaryFollowup(hostCount)) throw host.failure("invalid_host_count");

    // Let ChatGPT finish any root -> provisional -> canonical URL transition.
    // This is the transition that previously detached a healthy conversation.
    await delay(5_000);

    host.stage = "followup_generation";
    const followupRemoteUrl = host.latestRemoteUrl;
    if (!isConversationUrl(followupRemoteUrl)) throw host.failure("conversation_url_missing");
    // Mirror the VS Code controller: every send carries the conversation's
    // currently selected account model, including follow-ups. This verifies
    // that the invisible page bridge reapplies the user's choice per request.
    const secondRun = await host.runQuestion(
      FOLLOWUP_OK_PROMPT,
      followupRemoteUrl,
      selectedModelId,
    );
    const secondExpectedHistory = terminalBackedSmokeHistory(
      firstHistory.payload.messages,
      FOLLOWUP_OK_PROMPT,
      secondRun,
    );
    const secondHistory = await host.waitForCompleteHistory(
      4,
      secondRun.payload?.remoteUrl,
      secondRun.runId,
      secondExpectedHistory,
    );
    assertExactAnswer(secondRun.payload?.markdown, "OK", host);
    assertHistoryTail(secondHistory.payload.messages, [ONLY_OK_PROMPT, FOLLOWUP_OK_PROMPT], host);

    let attachmentVerified = false;
    let generations = 2;
    if (verifyAttachment) {
      host.stage = "attachment_generation";
      const attachmentRun = await host.runQuestion(
        ATTACHMENT_PROMPT,
        host.latestRemoteUrl,
        selectedModelId,
        [
          {
            id: `attachment-${randomUUID()}`,
            fileName: "probe.ts",
            mimeType: "text/typescript",
            content: `export const ask2gpt_ATTACHMENT_PROBE = "${ATTACHMENT_TOKEN}";\n`,
          },
        ],
      );
      assertExactAnswer(attachmentRun.payload?.markdown, ATTACHMENT_TOKEN, host);
      attachmentVerified = true;
      generations += 1;
    }

    return {
      generations,
      firstHistoryMessages: firstHistory.payload.messages.length,
      historyMessages: secondHistory.payload.messages.length,
      urlVerified:
        isConversationUrl(firstHistory.payload.remoteUrl) &&
        isConversationUrl(secondHistory.payload.remoteUrl),
      remoteUrl: secondHistory.payload.remoteUrl,
      modelCount: catalog?.options.length ?? 0,
      models: catalog?.options.map(({ id, label, description, selected }) => ({
        id,
        label,
        ...(description ? { description } : {}),
        selected,
      })),
      modelVerified: !skipModelCatalog,
      attachmentVerified,
    };
  } catch (error) {
    throw host.annotate(error);
  }
}

export async function verifyResumedPrimaryHost(host, remoteUrl) {
  try {
    const initialHistory = await host.verifyResumeConversation(remoteUrl);
    if (host.conversationSendCount !== 0) throw host.failure("resume_gate_after_send");

    host.stage = "resume_followup_generation";
    const followupRun = await host.runQuestion(FOLLOWUP_OK_PROMPT, remoteUrl);
    const finalHistory = await host.waitForCompleteHistory(
      4,
      followupRun.payload?.remoteUrl,
      followupRun.runId,
      terminalBackedSmokeHistory(initialHistory.payload.messages, FOLLOWUP_OK_PROMPT, followupRun),
    );
    assertExactAnswer(followupRun.payload?.markdown, "OK", host);
    assertExactOkHistory(finalHistory.payload.messages, [ONLY_OK_PROMPT, FOLLOWUP_OK_PROMPT], host);

    assertCleanHostTerminalEvents(host, 1);
    return {
      generations: 1,
      firstHistoryMessages: initialHistory.payload.messages.length,
      historyMessages: finalHistory.payload.messages.length,
      urlVerified:
        sameConversationIdentity(initialHistory.payload.remoteUrl, remoteUrl) &&
        sameConversationIdentity(finalHistory.payload.remoteUrl, remoteUrl),
      remoteUrl: finalHistory.payload.remoteUrl,
      modelCount: 0,
      modelVerified: false,
      attachmentVerified: false,
      resumedExistingConversation: true,
    };
  } catch (error) {
    throw host.annotate(error);
  }
}

async function verifySecondaryHost(host) {
  try {
    host.stage = "parallel_generation";
    const run = await host.runQuestion(ONLY_OK_PROMPT);
    const history = await host.waitForCompleteHistory(
      2,
      run.payload?.remoteUrl,
      run.runId,
      terminalBackedSmokeHistory([], ONLY_OK_PROMPT, run),
    );
    assertExactAnswer(run.payload?.markdown, "OK", host);
    assertHistoryTail(history.payload.messages, [ONLY_OK_PROMPT], host);
    return {
      generations: 1,
      historyMessages: history.payload.messages.length,
      urlVerified: isConversationUrl(history.payload.remoteUrl),
      remoteUrl: history.payload.remoteUrl,
    };
  } catch (error) {
    throw host.annotate(error);
  }
}

export function assertNonEmptyAssistantAnswer(markdown, host) {
  if (typeof markdown !== "string") throw host.failure("unexpected_model_answer");
  const normalized = markdown.trim();
  if (!normalized || normalized.length > 100_000) {
    throw host.failure("unexpected_model_answer");
  }
}

export function assertExactAnswer(markdown, expected, host) {
  if (typeof markdown !== "string") throw host.failure("unexpected_model_answer");
  if (!isExactNormalizedAnswer(markdown, expected)) {
    throw host.failure("attachment_content_not_observed");
  }
}

export function assertExactOkHistory(
  messages,
  expectedPrompts,
  host,
  { code = "unexpected_conversation_history" } = {},
) {
  const expectedMessageCount = expectedPrompts.length * 2;
  if (!Array.isArray(messages) || messages.length !== expectedMessageCount) {
    throw host.failure(code, summarizeHistoryForSmoke(messages));
  }
  for (let index = 0; index < expectedPrompts.length; index += 1) {
    const userMessage = messages[index * 2];
    const assistantMessage = messages[index * 2 + 1];
    if (
      userMessage?.role !== "user" ||
      userMessage.markdown?.trim() !== expectedPrompts[index] ||
      assistantMessage?.role !== "assistant" ||
      !isExactNormalizedAnswer(assistantMessage.markdown, "OK")
    ) {
      throw host.failure(code, summarizeHistoryForSmoke(messages));
    }
  }
}

function isExactNormalizedAnswer(markdown, expected) {
  if (typeof markdown !== "string") return false;
  const normalized = markdown
    .trim()
    .replace(/[`*_]/gu, "")
    .replace(/[.!\u3002\uff01?\uff1f]+$/u, "")
    .trim();
  return normalized.toLocaleLowerCase() === expected.toLocaleLowerCase();
}

function isCompleteHistorySnapshot(envelope, conversationId, minimumMessages) {
  return (
    envelope.type === "conversation.snapshot" &&
    envelope.conversationId === conversationId &&
    envelope.payload?.complete === true &&
    isConversationUrl(envelope.payload?.remoteUrl) &&
    Array.isArray(envelope.payload?.messages) &&
    envelope.payload.messages.length >= minimumMessages
  );
}

function terminalBackedSmokeHistory(previousMessages, prompt, terminalEnvelope) {
  const markdown = terminalEnvelope?.payload?.markdown;
  return [
    ...(Array.isArray(previousMessages) ? previousMessages : []),
    { role: "user", markdown: prompt },
    { role: "assistant", markdown: typeof markdown === "string" ? markdown : "" },
  ];
}

function buildSmokeTranscriptProof(remoteUrl, messages) {
  if (
    !isConversationUrl(remoteUrl) ||
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages.length > 200 ||
    messages.some(
      (message) =>
        !message ||
        (message.role !== "user" && message.role !== "assistant") ||
        typeof message.markdown !== "string",
    )
  ) {
    return undefined;
  }
  const messageHashes = messages.map((message) => ({
    role: message.role,
    sha256: smokeSha256(JSON.stringify([message.role, message.markdown])),
  }));
  return {
    remoteUrl,
    messageCount: messageHashes.length,
    messageHashes,
    transcriptChainSha256: smokeSha256(
      JSON.stringify(messageHashes.map((message) => [message.role, message.sha256])),
    ),
  };
}

export function reconcileSmokeHistorySnapshot(
  envelope,
  conversationId,
  minimumMessages,
  expectedLocalMessages,
  host,
) {
  if (isCompleteHistorySnapshot(envelope, conversationId, minimumMessages)) return envelope;
  if (
    envelope.type !== "conversation.snapshot" ||
    envelope.conversationId !== conversationId ||
    !isConversationUrl(envelope.payload?.remoteUrl) ||
    !Array.isArray(envelope.payload?.messages) ||
    !Array.isArray(expectedLocalMessages) ||
    expectedLocalMessages.length < minimumMessages ||
    !buildSmokeTranscriptProof(envelope.payload.remoteUrl, expectedLocalMessages)
  ) {
    return undefined;
  }
  const visibleMessages = envelope.payload.messages;
  if (visibleMessages.length === 0) {
    if (envelope.payload.complete === true) {
      throw host.failure("empty_history_marked_complete");
    }
  } else if (!isExactSmokeHistorySuffix(expectedLocalMessages, visibleMessages)) {
    return undefined;
  }
  if (envelope.payload.complete === true && visibleMessages.length < expectedLocalMessages.length) {
    throw host.failure(
      "partial_history_marked_complete",
      summarizeHistoryForSmoke(visibleMessages),
    );
  }
  return {
    ...envelope,
    payload: {
      ...envelope.payload,
      messages: expectedLocalMessages.map((message) => ({ ...message })),
      complete: true,
      reconciledFromPartial: true,
    },
  };
}

function isExactSmokeHistorySuffix(expectedMessages, visibleMessages) {
  if (visibleMessages.length === 0 || visibleMessages.length > expectedMessages.length) {
    return false;
  }
  const offset = expectedMessages.length - visibleMessages.length;
  return visibleMessages.every((visible, index) => {
    const expected = expectedMessages[offset + index];
    if (
      !expected ||
      visible?.role !== expected.role ||
      typeof visible?.markdown !== "string" ||
      typeof expected.markdown !== "string"
    ) {
      return false;
    }
    const actual = visible.markdown.replace(/\r\n?/gu, "\n");
    const wanted = expected.markdown.replace(/\r\n?/gu, "\n");
    return (
      actual === wanted ||
      (!wanted.includes("\u00a0") && actual.replace(/\u00a0/gu, " ") === wanted)
    );
  });
}

function smokeSha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function assertHistoryTail(messages, expectedPrompts, host) {
  const expectedMessageCount = expectedPrompts.length * 2;
  if (!Array.isArray(messages) || messages.length !== expectedMessageCount) {
    throw host.failure("unexpected_conversation_history", summarizeHistoryForSmoke(messages));
  }
  const tail = messages.slice(-expectedMessageCount);
  for (let index = 0; index < expectedPrompts.length; index += 1) {
    const userMessage = tail[index * 2];
    const assistantMessage = tail[index * 2 + 1];
    if (
      userMessage?.role !== "user" ||
      userMessage.markdown?.trim() !== expectedPrompts[index] ||
      assistantMessage?.role !== "assistant"
    ) {
      throw host.failure("unexpected_conversation_history", summarizeHistoryForSmoke(tail));
    }
    assertNonEmptyAssistantAnswer(assistantMessage.markdown, host);
  }
}

function summarizeHistoryForSmoke(messages) {
  if (!Array.isArray(messages)) return "history_not_array";
  return JSON.stringify({
    messageCount: messages.length,
    tailRoles: messages.slice(-6).map((message) => safeMessageRole(message?.role)),
  });
}

function snapshotDiagnostic(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  return {
    messageCount: messages.length,
    tailRoles: messages.slice(-6).map((message) => safeMessageRole(message?.role)),
    complete: payload?.complete === true,
  };
}

function safeMessageRole(value) {
  return value === "user" || value === "assistant" || value === "local-notice" ? value : "unknown";
}

function isConversationUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.origin === "https://chatgpt.com" &&
      (/^\/c\/[^/]+$/.test(url.pathname) || /^\/g\/[^/]+\/c\/[^/]+$/.test(url.pathname))
    );
  } catch {
    return false;
  }
}

function sameConversationIdentity(left, right) {
  if (!isConversationUrl(left) || !isConversationUrl(right)) return false;
  const leftMatch = new URL(left).pathname.match(/\/c\/([^/]+)$/u);
  const rightMatch = new URL(right).pathname.match(/\/c\/([^/]+)$/u);
  return Boolean(leftMatch?.[1] && leftMatch[1] === rightMatch?.[1]);
}

export function assertResumeConfiguration(
  remoteUrl,
  configuredHostCount,
  attachmentEnabled,
  requested = remoteUrl !== undefined,
) {
  if (!requested) return;
  if (!isConversationUrl(remoteUrl)) throw new SmokeFailure("invalid_resume_remote_url");
  if (configuredHostCount !== 1) throw new SmokeFailure("resume_requires_single_host");
  if (attachmentEnabled) throw new SmokeFailure("resume_attachment_not_supported");
}

export function assertCleanHostTerminalEvents(host, expectedSends) {
  const runs = [...host.runDiagnostics.values()];
  const anomalousRun = runs.find(
    (run) =>
      run.generationCompletes !== 1 ||
      run.generationErrors !== 0 ||
      (run.generationStops ?? 0) !== 0,
  );
  if (anomalousRun) {
    throw host.failure(
      "terminal_event_mismatch",
      `completes_${anomalousRun.generationCompletes}_errors_${anomalousRun.generationErrors}_stops_${String(anomalousRun.generationStops ?? 0)}`,
    );
  }
  if (
    runs.length !== expectedSends ||
    host.conversationSendCount !== expectedSends ||
    host.relayErrorCount !== 0 ||
    host.generationStoppedCount !== 0
  ) {
    throw host.failure(
      "smoke_event_count_mismatch",
      `runs_${runs.length}_sends_${host.conversationSendCount}_errors_${host.relayErrorCount}_stops_${host.generationStoppedCount}`,
    );
  }
}

function numberArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value >= 1_000 ? value : fallback;
}

function stringArgument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedIntegerArgument(name, fallback, minimum, maximum) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SmokeFailure("invalid_host_count");
  }
  return value;
}

export function shouldVerifyPrimaryFollowup(configuredHostCount) {
  return (
    Number.isInteger(configuredHostCount) && configuredHostCount >= 1 && configuredHostCount <= 3
  );
}

export function assertExpectedContentRuntime(connectedHosts, expectedRevision) {
  for (const host of connectedHosts) {
    host.stage = "verify_content_runtime_revision";
  }
  const mismatchedHost = connectedHosts.find((host) => host.selectorVersion !== expectedRevision);
  if (!mismatchedHost) return;

  throw mismatchedHost.failure(
    "content_runtime_revision_mismatch",
    `expected_${expectedRevision}_received_${String(mismatchedHost.selectorVersion ?? "missing")}`,
  );
}

async function closeSocket(value) {
  if (!value || value.readyState === WebSocket.CLOSED) return;
  if (value.readyState === WebSocket.OPEN) {
    const closed = new Promise((resolve) => value.once("close", resolve));
    value.close(1000, "Smoke verification complete");
    await Promise.race([closed, delay(500)]);
  }
  if (value.readyState !== WebSocket.CLOSED) value.terminate();
}

async function closeServer(value) {
  if (!value) return;
  for (const client of value.clients) client.terminate();
  await Promise.race([new Promise((resolve) => value.close(() => resolve())), delay(1_000)]);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) await main();

export { LiveHost, classifyRelayErrorReason, parseComposerErrorDiagnostic };
