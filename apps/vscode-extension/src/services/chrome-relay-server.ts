import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

import {
  CHROME_EXTENSION_ID,
  MAX_RELAY_FRAME_BYTES,
  PROTOCOL_VERSION,
  RELAY_PORTS,
  RELAY_WEBSOCKET_PROTOCOL,
  isChromeToHostMessageType,
  isRelayProductVersionCompatible,
  makeEnvelope,
  safeParseRelayEnvelope,
  type RelayEnvelope,
  type RelayErrorPayload,
  type RelayHelloPayload,
} from "@ask2gpt/protocol";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import { SafeLogger } from "./logger";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const CONNECTION_STALE_MS = 70_000;
const WATCHDOG_INTERVAL_MS = 20_000;
const MAX_OPEN_SOCKETS = 16;
const MAX_REMEMBERED_ENVELOPE_IDS = 2_048;
const NON_REPLAYABLE_ENVELOPE_FINGERPRINT = "";
const START_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000, 10_000] as const;

interface RelayTiming {
  connectionStaleMs: number;
  watchdogIntervalMs: number;
  startRetryDelaysMs?: readonly number[];
}

const defaultRelayTiming: RelayTiming = {
  connectionStaleMs: CONNECTION_STALE_MS,
  watchdogIntervalMs: WATCHDOG_INTERVAL_MS,
};

interface SeenEnvelopeIds {
  readonly fingerprints: Map<string, string>;
  readonly order: string[];
}

type EnvelopeIdDisposition = "new" | "terminal-replay" | "duplicate" | "conflict";

export type RelayConnectionPhase =
  | "starting"
  | "waiting-for-browser"
  | "pairing-required"
  | "authenticating"
  | "syncing"
  | "reconnecting"
  | "version-mismatch"
  | "trust-mismatch"
  | "local-server-error";

export interface RelayConnectionState {
  phase: RelayConnectionPhase;
  since: string;
  browserDetected: boolean;
  hasStoredTrust: boolean;
  hostVersion: string;
  relayVersion?: string;
  protocolVersion: number;
  lastConnectedAt?: string;
  detectedProtocol?: string;
  errorCode?: string;
}

export class ChromeRelayServer {
  private server?: WebSocketServer;
  private startPromise?: Promise<number>;
  private disposePromise?: Promise<void>;
  private authenticatedSocket?: WebSocket;
  private readonly sockets = new Set<WebSocket>();
  private readonly events = new EventEmitter();
  private readonly handshakeTimerBySocket = new WeakMap<WebSocket, NodeJS.Timeout>();
  private readonly lastSeenBySocket = new WeakMap<WebSocket, number>();
  private readonly seenEnvelopeIdsBySocket = new WeakMap<WebSocket, SeenEnvelopeIds>();
  private authoritativeGenerationValue = 0;
  private watchdog?: NodeJS.Timeout;
  private startRetryTimer?: NodeJS.Timeout;
  private startRetryAttempt = 0;
  private disposed = false;
  port?: number;
  private readonly label: string;
  private connectionStateValue: RelayConnectionState;

  constructor(
    readonly instanceId: string,
    label: string,
    readonly hostVersion: string,
    private readonly logger: SafeLogger,
    private readonly timing: RelayTiming = defaultRelayTiming,
  ) {
    this.label =
      label
        .replace(/\p{Cc}+/gu, " ")
        .trim()
        .slice(0, 128) || "VS Code";
    this.connectionStateValue = {
      phase: "starting",
      since: new Date().toISOString(),
      browserDetected: false,
      hasStoredTrust: false,
      hostVersion,
      protocolVersion: PROTOCOL_VERSION,
    };
  }

  get connected() {
    return this.authenticatedSocket?.readyState === WebSocket.OPEN;
  }

  get connectionState(): RelayConnectionState {
    return { ...this.connectionStateValue };
  }

  get authoritativeGeneration() {
    return this.authoritativeGenerationValue;
  }

  start() {
    if (this.disposed) {
      return Promise.reject(new Error("Chrome relay server has been disposed."));
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal()
      .then((port) => {
        this.clearStartRetry();
        return port;
      })
      .catch((error: unknown) => {
        this.startPromise = undefined;
        if (!this.disposed && this.connectionStateValue.phase !== "local-server-error") {
          this.setConnectionState({
            phase: "local-server-error",
            browserDetected: false,
            hasStoredTrust: false,
            errorCode: "RELAY_START_FAILED",
          });
        }
        throw error;
      });
    return this.startPromise;
  }

  async startWithRetry() {
    try {
      return await this.start();
    } catch (error) {
      if (!this.disposed) this.scheduleStartRetry();
      throw error;
    }
  }

  onEnvelope(listener: (envelope: RelayEnvelope) => void) {
    this.events.on("envelope", listener);
    return { dispose: () => this.events.off("envelope", listener) };
  }

  onConnectionChanged(listener: () => void) {
    this.events.on("connection", listener);
    return { dispose: () => this.events.off("connection", listener) };
  }

  send<T>(envelope: RelayEnvelope<T>) {
    const socket = this.authenticatedSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Chrome relay is not connected.");
    }
    const serialized = serializeEnvelope(envelope);
    socket.send(serialized);
  }

  async retryConnection() {
    if (this.port === undefined) {
      this.clearStartRetryTimer();
      await this.startWithRetry();
      return;
    }
    let announced = false;
    for (const socket of this.sockets) {
      if (socket === this.authenticatedSocket || socket.readyState !== WebSocket.OPEN) continue;
      announced = this.sendRelayReady(socket) || announced;
    }
    if (this.connected) return;
    const versionMismatch = this.connectionStateValue.phase === "version-mismatch";
    this.setConnectionState({
      phase: versionMismatch ? "version-mismatch" : announced ? "syncing" : "reconnecting",
      browserDetected: versionMismatch
        ? this.connectionStateValue.browserDetected
        : announced || this.hasWaitingSocket(),
      hasStoredTrust: false,
      errorCode: versionMismatch ? "PROTOCOL_MISMATCH" : undefined,
    });
  }

  dispose() {
    this.disposePromise ??= this.disposeInternal();
    return this.disposePromise;
  }

  private async disposeInternal() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    this.clearStartRetry();
    // start() can still be waiting for the WebSocketServer's listening event.
    // Let that attempt observe disposed and close its just-opened listener
    // before this shutdown is allowed to complete.
    const pendingStart = this.startPromise;
    if (pendingStart) await pendingStart.catch(() => undefined);
    for (const socket of this.sockets) {
      this.clearHandshakeTimer(socket);
      socket.close(1001, "VS Code extension deactivated");
      socket.terminate();
    }
    this.sockets.clear();
    this.authenticatedSocket = undefined;
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
    this.server = undefined;
    this.port = undefined;
    this.events.removeAllListeners();
  }

  private async startInternal() {
    this.setConnectionState({
      phase: "starting",
      browserDetected: false,
      hasStoredTrust: false,
      errorCode: undefined,
    });
    for (const port of RELAY_PORTS) {
      try {
        const server = await this.listen(port);
        if (this.disposed) {
          await closeWebSocketServer(server);
          throw new Error("Chrome relay server has been disposed.");
        }
        this.server = server;
        this.port = port;
        this.setConnectionState({
          phase: "waiting-for-browser",
          browserDetected: false,
          hasStoredTrust: false,
        });
        this.startWatchdog();
        this.logger.info("relay.listening", { port });
        return port;
      } catch (error) {
        if (!isAddressInUse(error)) throw error;
      }
    }
    this.setConnectionState({
      phase: "local-server-error",
      browserDetected: false,
      hasStoredTrust: false,
      errorCode: "PORT_POOL_EXHAUSTED",
    });
    throw new Error("Ask2GPT could not bind a loopback relay port.");
  }

  private scheduleStartRetry() {
    if (this.disposed || this.port !== undefined || this.startRetryTimer) return;
    const delays = this.timing.startRetryDelaysMs ?? START_RETRY_DELAYS_MS;
    const boundedDelays = delays.length > 0 ? delays : START_RETRY_DELAYS_MS;
    const attempt = this.startRetryAttempt;
    const delay = boundedDelays[Math.min(attempt, boundedDelays.length - 1)]!;
    this.startRetryAttempt += 1;
    this.startRetryTimer = setTimeout(() => {
      this.startRetryTimer = undefined;
      void this.startWithRetry().catch((error: unknown) => {
        this.logger.error("relay.start-retry-failed", "RELAY_PORT_UNAVAILABLE", {
          attempt: this.startRetryAttempt,
          name: error instanceof Error ? error.name : "Unknown",
        });
      });
    }, delay);
    this.startRetryTimer.unref();
  }

  private clearStartRetryTimer() {
    if (this.startRetryTimer) clearTimeout(this.startRetryTimer);
    this.startRetryTimer = undefined;
  }

  private clearStartRetry() {
    this.clearStartRetryTimer();
    this.startRetryAttempt = 0;
  }

  private listen(port: number) {
    return new Promise<WebSocketServer>((resolve, reject) => {
      const server = new WebSocketServer({
        host: "127.0.0.1",
        port,
        maxPayload: MAX_RELAY_FRAME_BYTES,
        verifyClient: ({ origin }, done) => {
          const expected = `chrome-extension://${CHROME_EXTENSION_ID}`;
          done(origin === expected, origin === expected ? 101 : 403, "Forbidden");
        },
      });
      const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        server.on("error", (error) => {
          this.logger.error("relay.server-error", "RELAY_SERVER_ERROR", {
            name: error.name,
          });
        });
        server.on("connection", (socket, request) => this.handleConnection(socket, request));
        resolve(server);
      };
      server.once("error", onError);
      server.once("listening", onListening);
    });
  }

  private handleConnection(
    socket: WebSocket,
    request: { headers: { [key: string]: string | string[] | undefined } },
  ) {
    if (this.disposed || this.sockets.size >= MAX_OPEN_SOCKETS) {
      socket.close(1013, "Too many relay connections");
      return;
    }

    const offeredProtocol = request.headers["sec-websocket-protocol"];
    const detectedProtocol = Array.isArray(offeredProtocol)
      ? offeredProtocol.join(",")
      : offeredProtocol;
    const protocols = (detectedProtocol ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!protocols.includes(RELAY_WEBSOCKET_PROTOCOL)) {
      if (!this.connected) {
        this.setConnectionState({
          phase: "version-mismatch",
          browserDetected: true,
          hasStoredTrust: false,
          relayVersion: undefined,
          detectedProtocol: detectedProtocol || "legacy",
          errorCode: "PROTOCOL_MISMATCH",
        });
      }
      this.logger.error("relay.protocol-mismatch", "PROTOCOL_MISMATCH", {
        hostVersion: this.hostVersion,
        protocolVersion: PROTOCOL_VERSION,
        detectedProtocol: detectedProtocol || "legacy",
      });
      socket.close(1002, "Update Ask2GPT Relay");
      return;
    }

    this.sockets.add(socket);
    this.lastSeenBySocket.set(socket, Date.now());
    this.seenEnvelopeIdsBySocket.set(socket, { fingerprints: new Map(), order: [] });
    this.logger.info("relay.socket-open");

    const handshakeTimer = setTimeout(() => {
      if (socket !== this.authenticatedSocket && socket.readyState === WebSocket.OPEN) {
        socket.close(4000, "Relay hello timed out");
      }
    }, HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref();
    this.handshakeTimerBySocket.set(socket, handshakeTimer);

    socket.on("message", (data, isBinary) => {
      this.lastSeenBySocket.set(socket, Date.now());
      void this.handleIncomingMessage(socket, data, isBinary);
    });
    socket.on("pong", () => {
      // Browser WebSocket implementations answer protocol pings without
      // depending on a page/content-script timer. Count that round-trip as
      // liveness when Chrome is occluded by a full-screen VS Code window.
      this.lastSeenBySocket.set(socket, Date.now());
    });
    socket.on("close", (code) => {
      const authoritative = this.authenticatedSocket === socket;
      this.clearHandshakeTimer(socket);
      this.sockets.delete(socket);
      // dispose() closes sockets asynchronously. Do the local cleanup, but do
      // not publish a reconnect transition or write to extension-host services
      // that may already be closing.
      if (this.disposed) return;
      this.logger.info("relay.socket-close", {
        code,
        authoritative,
        category: relayCloseCategory(code),
      });
      if (authoritative) {
        this.authenticatedSocket = undefined;
        this.setConnectionState({
          phase: "reconnecting",
          browserDetected: this.hasWaitingSocket(),
          hasStoredTrust: false,
        });
      }
    });
    socket.on("error", (error) => {
      if (this.disposed) return;
      this.logger.error("relay.socket-error", "RELAY_SOCKET_ERROR", {
        name: error.name,
      });
    });

    this.sendRelayReady(socket);
  }

  private async handleIncomingMessage(socket: WebSocket, data: RawData, isBinary: boolean) {
    if (this.disposed) return;
    try {
      if (isBinary) {
        this.sendError(socket, {
          code: "PROTOCOL_MISMATCH",
          message: "Binary relay frames are not supported.",
          recoverable: false,
        });
        socket.close(1003, "Text frames required");
        return;
      }
      if (rawDataByteLength(data) > MAX_RELAY_FRAME_BYTES) {
        this.sendError(socket, {
          code: "FRAME_TOO_LARGE",
          message: "Relay frame exceeded the 2 MiB limit.",
          recoverable: false,
        });
        socket.close(1009, "Frame too large");
        return;
      }
      await this.handleMessage(socket, rawDataToString(data));
    } catch (error) {
      if (this.disposed) return;
      this.logger.error("relay.message-failed", "RELAY_MESSAGE_FAILED", {
        name: error instanceof Error ? error.name : "Unknown",
      });
      this.sendError(socket, {
        code: "INTERNAL_ERROR",
        message: "Relay message processing failed.",
        recoverable: true,
      });
    }
  }

  private async handleMessage(socket: WebSocket, raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.rejectProtocol(socket, "Relay message was not valid JSON.");
      return;
    }

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      (parsed as { version?: unknown }).version !== PROTOCOL_VERSION
    ) {
      if (!this.connected || socket === this.authenticatedSocket) {
        this.setConnectionState({
          phase: "version-mismatch",
          browserDetected: true,
          hasStoredTrust: false,
          relayVersion: undefined,
          detectedProtocol: `envelope-v${String((parsed as { version?: unknown }).version)}`,
          errorCode: "PROTOCOL_MISMATCH",
        });
      }
      this.rejectProtocol(
        socket,
        `Chrome Relay uses protocol ${String((parsed as { version?: unknown }).version)}; protocol ${PROTOCOL_VERSION} is required.`,
      );
      return;
    }

    const result = safeParseRelayEnvelope(parsed);
    if (!result.success) {
      this.rejectProtocol(
        socket,
        `Relay message did not match protocol version ${PROTOCOL_VERSION}.`,
      );
      return;
    }
    const envelope = result.data as RelayEnvelope;

    if (envelope.instanceId !== this.instanceId) {
      this.rejectProtocol(socket, "Relay instance ID did not match this VS Code window.");
      return;
    }
    const envelopeIdDisposition = this.rememberEnvelope(socket, envelope);
    if (envelopeIdDisposition === "conflict") {
      this.rejectProtocol(socket, "Relay message ID was reused with different content.", false);
      return;
    }
    if (envelopeIdDisposition === "duplicate") {
      this.rejectProtocol(socket, "Duplicate relay message ID was rejected.", false);
      return;
    }

    if (envelope.type === "relay.hello") {
      const payload = envelope.payload as RelayHelloPayload;
      if (payload.chromeExtensionId !== CHROME_EXTENSION_ID) {
        this.rejectProtocol(socket, "Unexpected Chrome extension identity.");
        return;
      }
      if (!isRelayProductVersionCompatible(this.hostVersion, payload.chromeVersion)) {
        this.rejectRelayVersion(socket, payload.chromeVersion);
        return;
      }
      if (socket !== this.authenticatedSocket) {
        if (this.connected) {
          this.clearHandshakeTimer(socket);
          this.logger.info("relay.duplicate-rejected", { relayVersion: payload.chromeVersion });
          socket.close(4003, "Already connected");
          return;
        }
        this.acceptSocket(socket, payload.chromeVersion);
      }
      return;
    }

    if (socket !== this.authenticatedSocket) {
      this.sendError(socket, {
        code: "AUTH_REQUIRED",
        message: "Chrome relay must announce itself before sending commands.",
        recoverable: true,
      });
      return;
    }

    if (!isChromeToHostMessageType(envelope.type)) {
      this.rejectProtocol(socket, "Relay message is not valid in the Chrome-to-host direction.");
      return;
    }
    if (envelope.type === "heartbeat") {
      // Chrome sends both its own periodic keepalive and an acknowledgement
      // for the host-initiated heartbeat. Do not echo it back: both peers
      // initiating an echo would create an unbounded heartbeat loop.
      return;
    }

    this.events.emit("envelope", envelope);
  }

  private rejectRelayVersion(socket: WebSocket, relayVersion: string) {
    // A stray stale scanner must not downgrade a healthy authenticated
    // connection. A mismatch on the active/only route, however, is a hard
    // gate: no application messages may cross versions silently.
    if (!this.connected || socket === this.authenticatedSocket) {
      if (socket === this.authenticatedSocket) this.authenticatedSocket = undefined;
      this.setConnectionState({
        phase: "version-mismatch",
        browserDetected: true,
        hasStoredTrust: false,
        relayVersion,
        detectedProtocol: RELAY_WEBSOCKET_PROTOCOL,
        errorCode: "PROTOCOL_MISMATCH",
      });
    }
    this.logger.error("relay.extension-version-mismatch", "PROTOCOL_MISMATCH", {
      hostVersion: this.hostVersion,
      relayVersion,
      protocolVersion: PROTOCOL_VERSION,
      detectedProtocol: RELAY_WEBSOCKET_PROTOCOL,
    });
    this.rejectProtocol(
      socket,
      `VS Code extension ${this.hostVersion} is not compatible with Chrome Relay ${relayVersion} on ${RELAY_WEBSOCKET_PROTOCOL}.`,
    );
  }

  private acceptSocket(socket: WebSocket, relayVersion: string) {
    if (this.authenticatedSocket && this.authenticatedSocket !== socket) {
      this.authenticatedSocket.close(4002, "Superseded");
    }
    this.authenticatedSocket = socket;
    this.authoritativeGenerationValue += 1;
    this.clearHandshakeTimer(socket);
    const connectedAt = new Date().toISOString();
    this.setConnectionState({
      phase: "syncing",
      browserDetected: true,
      hasStoredTrust: false,
      relayVersion,
      lastConnectedAt: connectedAt,
      detectedProtocol: RELAY_WEBSOCKET_PROTOCOL,
      errorCode: undefined,
    });
    this.logger.info("relay.connected", {
      connectedAt,
      hostVersion: this.hostVersion,
      relayVersion,
      protocolVersion: PROTOCOL_VERSION,
      detectedProtocol: RELAY_WEBSOCKET_PROTOCOL,
    });
  }

  private sendRelayReady(socket: WebSocket) {
    return this.sendTo(
      socket,
      makeEnvelope({
        type: "relay.ready",
        instanceId: this.instanceId,
        payload: { serverLabel: this.label, serverInstanceId: this.instanceId },
      }),
    );
  }

  private rejectProtocol(socket: WebSocket, message: string, close = true) {
    this.sendError(socket, {
      code: "PROTOCOL_MISMATCH",
      message,
      recoverable: false,
    });
    if (close) socket.close(1008, "Protocol violation");
  }

  private sendError(socket: WebSocket, payload: RelayErrorPayload) {
    this.sendTo(
      socket,
      makeEnvelope({
        type: "relay.error",
        instanceId: this.instanceId,
        payload,
      }),
    );
  }

  private sendTo(socket: WebSocket, envelope: RelayEnvelope) {
    if (socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(serializeEnvelope(envelope));
      return true;
    } catch (error) {
      this.logger.error("relay.send-failed", "RELAY_SEND_FAILED", {
        name: error instanceof Error ? error.name : "Unknown",
      });
      return false;
    }
  }

  private rememberEnvelope(socket: WebSocket, envelope: RelayEnvelope): EnvelopeIdDisposition {
    const remembered = this.seenEnvelopeIdsBySocket.get(socket);
    if (!remembered) return "conflict";
    const replayableTerminal = isReplayableTerminalEnvelope(envelope);
    const fingerprint = replayableTerminal
      ? validatedEnvelopeFingerprint(envelope)
      : NON_REPLAYABLE_ENVELOPE_FINGERPRINT;
    const previousFingerprint = remembered.fingerprints.get(envelope.id);
    if (previousFingerprint !== undefined) {
      if (previousFingerprint !== fingerprint) return "conflict";
      return replayableTerminal ? "terminal-replay" : "duplicate";
    }
    remembered.fingerprints.set(envelope.id, fingerprint);
    remembered.order.push(envelope.id);
    if (remembered.order.length > MAX_REMEMBERED_ENVELOPE_IDS) {
      const oldest = remembered.order.shift();
      if (oldest) remembered.fingerprints.delete(oldest);
    }
    return "new";
  }

  private clearHandshakeTimer(socket: WebSocket) {
    const timer = this.handshakeTimerBySocket.get(socket);
    if (timer) clearTimeout(timer);
    this.handshakeTimerBySocket.delete(socket);
  }

  private hasWaitingSocket() {
    return [...this.sockets].some(
      (socket) => socket !== this.authenticatedSocket && socket.readyState === WebSocket.OPEN,
    );
  }

  private setConnectionState(
    next: Pick<RelayConnectionState, "phase" | "browserDetected" | "hasStoredTrust"> &
      Partial<Omit<RelayConnectionState, "phase" | "browserDetected" | "hasStoredTrust">>,
    force = false,
  ) {
    const previous = this.connectionStateValue;
    const value: RelayConnectionState = {
      ...previous,
      ...next,
      since:
        next.since ?? (previous.phase === next.phase ? previous.since : new Date().toISOString()),
    };
    if (
      previous.phase === value.phase &&
      previous.since === value.since &&
      previous.browserDetected === value.browserDetected &&
      previous.hasStoredTrust === value.hasStoredTrust &&
      previous.hostVersion === value.hostVersion &&
      previous.relayVersion === value.relayVersion &&
      previous.protocolVersion === value.protocolVersion &&
      previous.lastConnectedAt === value.lastConnectedAt &&
      previous.detectedProtocol === value.detectedProtocol &&
      previous.errorCode === value.errorCode
    ) {
      if (force) this.events.emit("connection");
      return;
    }
    this.connectionStateValue = value;
    this.events.emit("connection");
  }

  private startWatchdog() {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      const now = Date.now();
      for (const socket of this.sockets) {
        if (socket !== this.authenticatedSocket || socket.readyState !== WebSocket.OPEN) continue;
        if (now - (this.lastSeenBySocket.get(socket) ?? 0) > this.timing.connectionStaleMs) {
          this.logger.error("relay.socket-stale", "RELAY_HEARTBEAT_TIMEOUT");
          socket.terminate();
          continue;
        }
        try {
          // Keepalive is deliberately initiated by the VS Code side too.
          // Chrome 116+ resets an extension service worker's idle timer when a
          // WebSocket message is sent or received; relying only on a Chrome
          // setInterval made full-screen/occlusion throttling a single point
          // of failure.
          socket.ping();
          this.sendTo(
            socket,
            makeEnvelope({
              type: "heartbeat",
              instanceId: this.instanceId,
              payload: { at: new Date(now).toISOString() },
            }),
          );
        } catch (error) {
          this.logger.error("relay.heartbeat-send-failed", "RELAY_SEND_FAILED", {
            name: error instanceof Error ? error.name : "Unknown",
          });
        }
      }
    }, this.timing.watchdogIntervalMs);
    this.watchdog.unref();
  }
}

function closeWebSocketServer(server: WebSocketServer) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function relayCloseCategory(code: number) {
  if (code === 1000 || code === 1001) return "normal";
  if (code === 1002 || code === 1008) return "protocol";
  if (code === 4002) return "superseded";
  if (code === 4003) return "duplicate";
  return "transport";
}

function serializeEnvelope(envelope: RelayEnvelope) {
  const parsed = safeParseRelayEnvelope(envelope);
  if (!parsed.success) {
    throw new Error("Attempted to send an invalid relay envelope.");
  }
  const serialized = JSON.stringify(parsed.data);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RELAY_FRAME_BYTES) {
    throw new Error("Relay frame exceeded the 2 MiB limit.");
  }
  return serialized;
}

function validatedEnvelopeFingerprint(envelope: RelayEnvelope) {
  return createHash("sha256").update(canonicalJson(envelope), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function isReplayableTerminalEnvelope(envelope: RelayEnvelope) {
  return (
    envelope.type === "generation.complete" ||
    envelope.type === "generation.stopped" ||
    (envelope.type === "relay.error" && Boolean(envelope.conversationId && envelope.runId))
  );
}

function rawDataByteLength(data: RawData) {
  if (Array.isArray(data)) {
    return data.reduce((total, part) => total + part.byteLength, 0);
  }
  return data.byteLength;
}

function rawDataToString(data: RawData) {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function isAddressInUse(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EADDRINUSE"
  );
}
