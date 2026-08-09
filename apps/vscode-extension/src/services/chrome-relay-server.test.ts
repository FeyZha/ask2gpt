import {
  CHROME_EXTENSION_ID,
  MAX_RELAY_FRAME_BYTES,
  PROTOCOL_VERSION,
  RELAY_WEBSOCKET_PROTOCOL,
  makeEnvelope,
  safeParseRelayEnvelope,
  type RelayEnvelope,
  type RelayErrorPayload,
} from "@ask2gpt/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type WebSocketServer } from "ws";

import type { BackendEvent } from "../types";
import { BrowserChatBackend } from "./browser-chat-backend";
import { ChromeRelayServer } from "./chrome-relay-server";

const logger = { info: vi.fn(), error: vi.fn() };
const servers: ChromeRelayServer[] = [];
const HOST_EXTENSION_VERSION = "0.1.0";

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.dispose()));
  vi.clearAllMocks();
});

describe("ChromeRelayServer zero-setup connection", () => {
  it("advertises the VS Code route and connects after Chrome announces itself", async () => {
    const server = createServer("window-a");
    const { inbox, ready } = await startAndConnect(server);

    expect(ready).toMatchObject({
      type: "relay.ready",
      instanceId: "window-a",
      payload: { serverLabel: "Test VS Code", serverInstanceId: "window-a" },
    });
    expect(server.connected).toBe(true);
    const connectionState = server.connectionState;
    expect(connectionState).toMatchObject({
      phase: "syncing",
      browserDetected: true,
      hasStoredTrust: false,
      hostVersion: HOST_EXTENSION_VERSION,
      relayVersion: HOST_EXTENSION_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      detectedProtocol: RELAY_WEBSOCKET_PROTOCOL,
    });
    expect(connectionState.lastConnectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    inbox.socket.close();
  });

  it("connects two simultaneously open VS Code windows on distinct ports", async () => {
    const first = createServer("window-a");
    const second = createServer("window-b");
    const [firstPort, secondPort] = await Promise.all([first.start(), second.start()]);

    expect(firstPort).not.toBe(secondPort);
    const [firstInbox, secondInbox] = await Promise.all([connect(firstPort), connect(secondPort)]);
    await announce(firstInbox, "window-a");
    await announce(secondInbox, "window-b");
    await waitFor(() => first.connected && second.connected);

    expect(first.connected).toBe(true);
    expect(second.connected).toBe(true);
  });

  it("reconnects the authoritative Relay after an extension reload without restarting VS Code", async () => {
    const server = createServer("window-a");
    const backend = new BrowserChatBackend(server);
    let phase = (await backend.getStatus()).connection.phase;
    backend.onEvent((event) => {
      if (event.type === "status" && event.status.connection) {
        phase = event.status.connection.phase;
      }
    });
    const { inbox: original } = await startAndConnect(server);
    original.send(statusEnvelope("window-a", 0));
    await waitFor(() => phase === "ready");
    const generationBeforeReload = server.authoritativeGeneration;

    original.socket.close(1001, "Extension reload");
    await waitFor(() => phase === "reconnecting");

    const replacement = await connect(server.port!);
    const ready = await replacement.next();
    await announce(replacement, ready.instanceId, true);
    replacement.send(statusEnvelope("window-a", 0));
    await waitFor(() => phase === "ready");

    expect(server.authoritativeGeneration).toBe(generationBeforeReload + 1);
    expect(await backend.getStatus()).toMatchObject({
      connected: true,
      authenticated: true,
      connection: { phase: "ready", relayVersion: HOST_EXTENSION_VERSION },
    });
    await backend.dispose();
  });

  it("does not publish a disconnect or log after shutdown starts", async () => {
    const server = createServer("window-a");
    const { inbox } = await startAndConnect(server);
    const connectionChanged = vi.fn();
    server.onConnectionChanged(connectionChanged);
    connectionChanged.mockClear();
    logger.info.mockClear();

    await server.dispose();
    await inbox.closed();

    expect(connectionChanged).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith("relay.socket-close", expect.anything());
  });

  it("waits for an in-flight start and closes its late listener during shutdown", async () => {
    const server = createServer("window-a");
    let resolveListen!: (listener: WebSocketServer) => void;
    const closeListener = vi.fn((callback?: (error?: Error) => void) => callback?.());
    const listener = { close: closeListener } as unknown as WebSocketServer;
    const listen = vi.fn(
      () =>
        new Promise<WebSocketServer>((resolve) => {
          resolveListen = resolve;
        }),
    );
    Reflect.set(server, "listen", listen);

    const starting = server.start();
    expect(listen).toHaveBeenCalledOnce();
    let shutdownCompleted = false;
    const shutdown = server.dispose().then(() => {
      shutdownCompleted = true;
    });
    await Promise.resolve();
    expect(shutdownCompleted).toBe(false);

    resolveListen(listener);
    await expect(starting).rejects.toThrow("Chrome relay server has been disposed.");
    await shutdown;

    expect(closeListener).toHaveBeenCalledOnce();
    expect(server.port).toBeUndefined();
    expect(Reflect.get(server, "server")).toBeUndefined();
    expect(logger.info).not.toHaveBeenCalledWith("relay.listening", expect.anything());
  });

  it("automatically retries a transient listener startup failure", async () => {
    vi.useFakeTimers();
    const server = createServer("window-a", {
      connectionStaleMs: 70_000,
      watchdogIntervalMs: 20_000,
      startRetryDelaysMs: [25],
    });
    const startInternal = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("Temporary listener failure."))
      .mockImplementationOnce(async () => {
        Reflect.set(server, "port", 32_171);
        return 32_171;
      });
    Reflect.set(server, "startInternal", startInternal);

    try {
      await expect(server.startWithRetry()).rejects.toThrow("Temporary listener failure.");
      expect(startInternal).toHaveBeenCalledOnce();
      expect(server.connectionState).toMatchObject({
        phase: "local-server-error",
        errorCode: "RELAY_START_FAILED",
      });

      await vi.advanceTimersByTimeAsync(25);

      expect(startInternal).toHaveBeenCalledTimes(2);
      expect(server.port).toBe(32_171);
      expect(Reflect.get(server, "startRetryTimer")).toBeUndefined();
      expect(Reflect.get(server, "startRetryAttempt")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a scheduled listener retry during extension-host shutdown", async () => {
    vi.useFakeTimers();
    const server = createServer("window-a", {
      connectionStaleMs: 70_000,
      watchdogIntervalMs: 20_000,
      startRetryDelaysMs: [25],
    });
    const startInternal = vi
      .fn<() => Promise<number>>()
      .mockRejectedValue(new Error("Listener unavailable."));
    Reflect.set(server, "startInternal", startInternal);

    try {
      await expect(server.startWithRetry()).rejects.toThrow("Listener unavailable.");
      await server.dispose();
      await vi.advanceTimersByTimeAsync(100);

      expect(startInternal).toHaveBeenCalledOnce();
      expect(Reflect.get(server, "startRetryTimer")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a queued message failure after shutdown without logging or replying", async () => {
    const server = createServer("window-a");
    let rejectMessage!: (error: Error) => void;
    const handleMessage = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectMessage = reject;
        }),
    );
    Reflect.set(server, "handleMessage", handleMessage);
    const socket = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as unknown as WebSocket;
    const pendingMessage = (
      server as unknown as {
        handleIncomingMessage(socket: WebSocket, data: Buffer, isBinary: boolean): Promise<void>;
      }
    ).handleIncomingMessage(socket, Buffer.from("{}"), false);
    expect(handleMessage).toHaveBeenCalledOnce();

    await server.dispose();
    rejectMessage(new Error("queued failure"));
    await pendingMessage;

    expect(logger.error).not.toHaveBeenCalledWith(
      "relay.message-failed",
      "RELAY_MESSAGE_FAILED",
      expect.anything(),
    );
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("reconnects two VS Code windows in reverse order after one Relay reload", async () => {
    const first = createServer("window-a");
    const second = createServer("window-b");
    const [firstConnection, secondConnection] = await Promise.all([
      startAndConnect(first),
      startAndConnect(second),
    ]);

    firstConnection.inbox.socket.close(1001, "Extension reload");
    secondConnection.inbox.socket.close(1001, "Extension reload");
    await waitFor(() => !first.connected && !second.connected);

    const secondReplacement = await connect(second.port!);
    const secondReady = await secondReplacement.next();
    await announce(secondReplacement, secondReady.instanceId, true);
    const firstReplacement = await connect(first.port!);
    const firstReady = await firstReplacement.next();
    await announce(firstReplacement, firstReady.instanceId, true);
    await waitFor(() => first.connected && second.connected);

    expect(first.connectionState.relayVersion).toBe(HOST_EXTENSION_VERSION);
    expect(second.connectionState.relayVersion).toBe(HOST_EXTENSION_VERSION);
    expect(first.port).not.toBe(second.port);
  });

  it("routes independent messages from each connected window", async () => {
    const first = createServer("window-a");
    const second = createServer("window-b");
    const [firstConnection, secondConnection] = await Promise.all([
      startAndConnect(first),
      startAndConnect(second),
    ]);
    const firstEvents: RelayEnvelope[] = [];
    const secondEvents: RelayEnvelope[] = [];
    first.onEnvelope((event) => firstEvents.push(event));
    second.onEnvelope((event) => secondEvents.push(event));

    firstConnection.inbox.send(statusEnvelope("window-a", 1));
    secondConnection.inbox.send(statusEnvelope("window-b", 2));
    await waitFor(() => firstEvents.length === 1 && secondEvents.length === 1);

    expect(firstEvents[0]?.instanceId).toBe("window-a");
    expect(secondEvents[0]?.instanceId).toBe("window-b");
  });

  it("rejects non-extension origins", async () => {
    const server = createServer("window-a");
    const port = await server.start();

    await expect(connect(port, "https://example.com")).rejects.toThrow();
    expect(server.connected).toBe(false);
  });

  it("identifies an outdated companion before waiting for a hello", async () => {
    const server = createServer("window-a");
    const port = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: `chrome-extension://${CHROME_EXTENSION_ID}`,
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
      socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      socket.once("error", reject);
    });

    await expect(closed).resolves.toMatchObject({
      code: 1002,
      reason: "Update Ask2GPT Relay",
    });
    expect(server.connectionState).toMatchObject({
      phase: "version-mismatch",
      detectedProtocol: "legacy",
      errorCode: "PROTOCOL_MISMATCH",
    });
  });

  it("rejects authentication when Relay and Host extension versions differ", async () => {
    const server = createServer("window-a");
    const port = await server.start();
    const inbox = await connect(port);
    const ready = await inbox.next();
    expect(ready.type).toBe("relay.ready");

    await announce(inbox, ready.instanceId, true, "0.1.7");

    expect(errorCode(await inbox.next())).toBe("PROTOCOL_MISMATCH");
    await expect(inbox.closed()).resolves.toMatchObject({ code: 1008 });
    expect(server.connected).toBe(false);
    expect(server.connectionState).toMatchObject({
      phase: "version-mismatch",
      hostVersion: HOST_EXTENSION_VERSION,
      relayVersion: "0.1.7",
      protocolVersion: PROTOCOL_VERSION,
      detectedProtocol: RELAY_WEBSOCKET_PROTOCOL,
      errorCode: "PROTOCOL_MISMATCH",
    });
    expect(logger.error).toHaveBeenCalledWith(
      "relay.extension-version-mismatch",
      "PROTOCOL_MISMATCH",
      expect.objectContaining({
        hostVersion: HOST_EXTENSION_VERSION,
        relayVersion: "0.1.7",
        protocolVersion: PROTOCOL_VERSION,
      }),
    );

    await server.retryConnection();
    expect(server.connectionState).toMatchObject({
      phase: "version-mismatch",
      browserDetected: true,
      errorCode: "PROTOCOL_MISMATCH",
      relayVersion: "0.1.7",
    });
  });

  it("accepts only the immediately next Relay during the hot-upgrade window", async () => {
    const server = createServer("window-a");
    const port = await server.start();
    const inbox = await connect(port);
    const ready = await inbox.next();

    await announce(inbox, ready.instanceId, true, "0.1.1");

    await waitFor(() => server.connected);
    expect(server.connectionState).toMatchObject({
      phase: "syncing",
      hostVersion: HOST_EXTENSION_VERSION,
      relayVersion: "0.1.1",
      protocolVersion: PROTOCOL_VERSION,
      detectedProtocol: RELAY_WEBSOCKET_PROTOCOL,
    });
    expect(logger.error).not.toHaveBeenCalledWith(
      "relay.extension-version-mismatch",
      expect.anything(),
      expect.anything(),
    );

    await server.dispose();
  });

  it("rejects a Relay that is more than one release behind", async () => {
    const server = createServer("window-a");
    const port = await server.start();
    const inbox = await connect(port);
    const ready = await inbox.next();

    await announce(inbox, ready.instanceId, true, "0.0.1");

    expect(errorCode(await inbox.next())).toBe("PROTOCOL_MISMATCH");
    await expect(inbox.closed()).resolves.toMatchObject({ code: 1008 });
    expect(server.connected).toBe(false);
    expect(server.connectionState).toMatchObject({
      phase: "version-mismatch",
      hostVersion: HOST_EXTENSION_VERSION,
      relayVersion: "0.0.1",
    });
  });

  it("accepts a 0.1.1 Relay when the 0.1.0 Host is already running", async () => {
    const server = new ChromeRelayServer("window-a", "Test VS Code", "0.1.0", logger as never);
    servers.push(server);
    const port = await server.start();
    const inbox = await connect(port);
    const ready = await inbox.next();

    await announce(inbox, ready.instanceId, true, "0.1.1");

    await waitFor(() => server.connected);
    expect(server.connectionState).toMatchObject({
      phase: "syncing",
      hostVersion: "0.1.0",
      relayVersion: "0.1.1",
      protocolVersion: PROTOCOL_VERSION,
      detectedProtocol: RELAY_WEBSOCKET_PROTOCOL,
    });
  });

  it("keeps a healthy authoritative connection ready while rejecting a stale candidate", async () => {
    const server = createServer("window-a");
    const backend = new BrowserChatBackend(server);
    const statusEvents: BackendEvent[] = [];
    backend.onEvent((event) => {
      if (event.type === "status") statusEvents.push(event);
    });
    const { inbox: healthy } = await startAndConnect(server);
    healthy.send(statusEnvelope("window-a", 0));
    await waitFor(() =>
      statusEvents.some(
        (event) => event.type === "status" && event.status.connection?.phase === "ready",
      ),
    );
    expect((await backend.getStatus()).connection.phase).toBe("ready");
    const stableState = server.connectionState;
    const stableEventCount = statusEvents.length;

    const stale = await connect(server.port!);
    const staleReady = await stale.next();
    expect(staleReady.type).toBe("relay.ready");
    expect((await backend.getStatus()).connection.phase).toBe("ready");

    await announce(stale, staleReady.instanceId, true, "0.0.0");
    expect(errorCode(await stale.next())).toBe("PROTOCOL_MISMATCH");
    await expect(stale.closed()).resolves.toMatchObject({ code: 1008 });

    healthy.send(
      makeEnvelope({
        type: "heartbeat",
        instanceId: "window-a",
        payload: { at: new Date().toISOString() },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(server.connected).toBe(true);
    expect(server.connectionState).toEqual(stableState);
    expect(await backend.getStatus()).toMatchObject({
      connected: true,
      authenticated: true,
      connection: {
        phase: "ready",
        relayVersion: HOST_EXTENSION_VERSION,
      },
    });
    expect(statusEvents).toHaveLength(stableEventCount);

    await backend.dispose();
  });

  it("keeps the healthy authoritative socket when a duplicate compatible scanner arrives", async () => {
    const server = createServer("window-a");
    const { inbox: healthy } = await startAndConnect(server);
    const stableState = server.connectionState;
    const stableGeneration = server.authoritativeGeneration;

    const duplicate = await connect(server.port!);
    const duplicateReady = await duplicate.next();
    await announce(duplicate, duplicateReady.instanceId, true);

    await expect(duplicate.closed()).resolves.toMatchObject({
      code: 4003,
      reason: "Already connected",
    });
    expect(server.connected).toBe(true);
    expect(server.connectionState).toEqual(stableState);
    expect(server.authoritativeGeneration).toBe(stableGeneration);

    healthy.send(
      makeEnvelope({
        type: "heartbeat",
        instanceId: "window-a",
        payload: { at: new Date().toISOString() },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.connectionState).toEqual(stableState);
  });

  it("rejects an envelope for another VS Code window", async () => {
    const server = createServer("window-a");
    const port = await server.start();
    const inbox = await connect(port);
    expect((await inbox.next()).type).toBe("relay.ready");

    inbox.send(
      makeEnvelope({
        type: "relay.hello",
        instanceId: "window-b",
        payload: { chromeExtensionId: CHROME_EXTENSION_ID, chromeVersion: "0.0.1" },
      }),
    );

    expect(errorCode(await inbox.next())).toBe("PROTOCOL_MISMATCH");
    expect(server.connected).toBe(false);
  });

  it("drops duplicate envelope IDs before backend delivery", async () => {
    const server = createServer("window-a");
    const { inbox } = await startAndConnect(server);
    const events: RelayEnvelope[] = [];
    server.onEnvelope((event) => events.push(event));
    const envelope = statusEnvelope("window-a", 0, "same-message-id");

    inbox.send(envelope);
    inbox.send(envelope);
    await waitFor(() => events.length === 1);

    expect(events).toHaveLength(1);
    expect(errorCode(await inbox.next())).toBe("PROTOCOL_MISMATCH");
  });

  it("allows exact run-terminal envelope replays after validation", async () => {
    const server = createServer("window-a");
    const { inbox } = await startAndConnect(server);
    const events: RelayEnvelope[] = [];
    server.onEnvelope((event) => events.push(event));
    const now = new Date().toISOString();
    const terminals = [
      makeEnvelope({
        id: "complete-terminal-id",
        type: "generation.complete",
        instanceId: "window-a",
        conversationId: "conversation-a",
        runId: "run-a",
        payload: { markdown: "complete", startedAt: now, completedAt: now },
      }),
      makeEnvelope({
        id: "stopped-terminal-id",
        type: "generation.stopped",
        instanceId: "window-a",
        conversationId: "conversation-b",
        runId: "run-b",
        payload: { markdown: "stopped", startedAt: now },
      }),
      makeEnvelope({
        id: "error-terminal-id",
        type: "relay.error",
        instanceId: "window-a",
        conversationId: "conversation-c",
        runId: "run-c",
        payload: {
          code: "CHATGPT_COMPOSER_MISSING",
          message: "Composer missing.",
          recoverable: true,
        },
      }),
    ];

    for (const terminal of terminals) {
      inbox.send(terminal);
      inbox.send(terminal);
    }
    await waitFor(() => events.length === terminals.length * 2);

    expect(events.map((event) => event.type)).toEqual([
      "generation.complete",
      "generation.complete",
      "generation.stopped",
      "generation.stopped",
      "relay.error",
      "relay.error",
    ]);
  });

  it("lets the backend re-ack an exact terminal replay without re-emitting it", async () => {
    const server = createServer("window-a");
    const backend = new BrowserChatBackend(server);
    const completeEvents: BackendEvent[] = [];
    backend.onEvent((event) => {
      if (event.type === "complete") completeEvents.push(event);
    });
    const { inbox } = await startAndConnect(server);
    const now = new Date().toISOString();
    const terminal = makeEnvelope({
      id: "durable-terminal-id",
      type: "generation.complete",
      instanceId: "window-a",
      conversationId: "conversation-a",
      runId: "run-a",
      payload: { markdown: "complete", startedAt: now, completedAt: now },
    });

    inbox.send(terminal);
    await waitFor(() => completeEvents.length === 1);
    await backend.acknowledgeTerminal("conversation-a", "run-a", terminal.id);
    const firstAcknowledgement = await nextEnvelopeOfType(inbox, "generation.ack");

    inbox.send(terminal);
    const replayAcknowledgement = await nextEnvelopeOfType(inbox, "generation.ack");

    expect(completeEvents).toHaveLength(1);
    expect(firstAcknowledgement.payload).toMatchObject({ eventId: terminal.id });
    expect(replayAcknowledgement.payload).toMatchObject({ eventId: terminal.id });
    await backend.dispose();
  });

  it("rejects a same-ID terminal replay whose validated content changed", async () => {
    const server = createServer("window-a");
    const { inbox } = await startAndConnect(server);
    const events: RelayEnvelope[] = [];
    server.onEnvelope((event) => events.push(event));
    const now = new Date().toISOString();
    const original = makeEnvelope({
      id: "mutated-terminal-id",
      type: "generation.complete",
      instanceId: "window-a",
      conversationId: "conversation-a",
      runId: "run-a",
      payload: { markdown: "original", startedAt: now, completedAt: now },
    });
    const mutated = makeEnvelope({
      id: original.id,
      type: "generation.complete",
      instanceId: "window-a",
      conversationId: "conversation-a",
      runId: "run-a",
      payload: { markdown: "mutated", startedAt: now, completedAt: now },
    });

    inbox.send(original);
    inbox.send(mutated);

    expect(errorCode(await inbox.next())).toBe("PROTOCOL_MISMATCH");
    expect(events).toEqual([original]);
    expect(server.connected).toBe(true);
  });

  it("does not replay an uncorrelated relay error as a run terminal", async () => {
    const server = createServer("window-a");
    const { inbox } = await startAndConnect(server);
    const events: RelayEnvelope[] = [];
    server.onEnvelope((event) => events.push(event));
    const error = makeEnvelope({
      id: "global-error-id",
      type: "relay.error",
      instanceId: "window-a",
      payload: {
        code: "INTERNAL_ERROR",
        message: "Global relay failure.",
        recoverable: true,
      },
    });

    inbox.send(error);
    inbox.send(error);

    expect(errorCode(await inbox.next())).toBe("PROTOCOL_MISMATCH");
    expect(events).toEqual([error]);
  });

  it("enforces the 2 MiB outbound frame limit by UTF-8 bytes", async () => {
    const server = createServer("window-a");
    await startAndConnect(server);
    const markdown = "界".repeat(Math.ceil(MAX_RELAY_FRAME_BYTES / 3));

    expect(() =>
      server.send(
        makeEnvelope({
          type: "generation.snapshot",
          instanceId: "window-a",
          conversationId: "conversation-a",
          runId: "run-a",
          payload: {
            markdown,
            startedAt: new Date().toISOString(),
          },
        }),
      ),
    ).toThrow("2 MiB");
  });

  it("closes an oversized inbound frame", async () => {
    const server = createServer("window-a");
    const { inbox } = await startAndConnect(server);

    inbox.socket.send("x".repeat(MAX_RELAY_FRAME_BYTES + 1));

    await expect(inbox.closed()).resolves.toMatchObject({ code: 1009 });
  });

  it("keeps a connected window alive with host-initiated heartbeats", async () => {
    const server = createServer("window-a", {
      connectionStaleMs: 1_000,
      watchdogIntervalMs: 20,
    });
    const { inbox } = await startAndConnect(server);

    expect((await inbox.next()).type).toBe("heartbeat");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(server.connected).toBe(true);
  });
});

function createServer(
  instanceId: string,
  timing?: {
    connectionStaleMs: number;
    watchdogIntervalMs: number;
    startRetryDelaysMs?: readonly number[];
  },
) {
  const server = new ChromeRelayServer(
    instanceId,
    "Test VS Code",
    HOST_EXTENSION_VERSION,
    logger as never,
    timing,
  );
  servers.push(server);
  return server;
}

async function startAndConnect(server: ChromeRelayServer) {
  const port = await server.start();
  const inbox = await connect(port);
  const ready = await inbox.next();
  expect(ready.type).toBe("relay.ready");
  await announce(inbox, ready.instanceId, true);
  await waitFor(() => server.connected);
  return { inbox, ready };
}

async function announce(
  inbox: SocketInbox,
  instanceId: string,
  readyAlreadyRead = false,
  relayVersion = HOST_EXTENSION_VERSION,
) {
  if (!readyAlreadyRead) {
    const ready = await inbox.next();
    if (ready.type !== "relay.ready") throw new Error("Expected relay.ready.");
  }
  inbox.send(
    makeEnvelope({
      type: "relay.hello",
      instanceId,
      payload: { chromeExtensionId: CHROME_EXTENSION_ID, chromeVersion: relayVersion },
    }),
  );
}

function statusEnvelope(instanceId: string, activeRuns: number, id?: string) {
  return makeEnvelope({
    id,
    type: "relay.status",
    instanceId,
    payload: { connected: true, activeRuns, selectorVersion: 1 },
  });
}

function connect(port: number, origin = `chrome-extension://${CHROME_EXTENSION_ID}`) {
  return new Promise<SocketInbox>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, RELAY_WEBSOCKET_PROTOCOL, { origin });
    const inbox = new SocketInbox(socket);
    socket.once("open", () => resolve(inbox));
    socket.once("error", reject);
  });
}

class SocketInbox {
  private readonly queue: RelayEnvelope[] = [];
  private readonly waiters: Array<{
    resolve(value: RelayEnvelope): void;
    reject(reason: unknown): void;
    timer: NodeJS.Timeout;
  }> = [];
  private closeResult?: { code: number; reason: string };
  private readonly closeWaiters: Array<(result: { code: number; reason: string }) => void> = [];

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      try {
        const parsed = safeParseRelayEnvelope(JSON.parse(data.toString()) as unknown);
        if (!parsed.success) throw new Error("Invalid relay envelope.");
        const envelope = parsed.data as RelayEnvelope;
        const waiter = this.waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(envelope);
        } else {
          this.queue.push(envelope);
        }
      } catch (error) {
        const waiter = this.waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
      }
    });
    socket.on("close", (code, reason) => {
      this.closeResult = { code, reason: reason.toString() };
      for (const resolve of this.closeWaiters.splice(0)) resolve(this.closeResult);
    });
  }

  send(envelope: RelayEnvelope) {
    this.socket.send(JSON.stringify(envelope));
  }

  next(timeoutMs = 2_000) {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<RelayEnvelope>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("Timed out waiting for relay envelope."));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  closed(timeoutMs = 2_000) {
    if (this.closeResult) return Promise.resolve(this.closeResult);
    return new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for socket close.")),
        timeoutMs,
      );
      this.closeWaiters.push((result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }
}

function errorCode(envelope: RelayEnvelope) {
  expect(envelope.type).toBe("relay.error");
  return (envelope.payload as RelayErrorPayload).code;
}

async function nextEnvelopeOfType(
  inbox: SocketInbox,
  type: RelayEnvelope["type"],
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const envelope = await inbox.next(Math.max(1, deadline - Date.now()));
    if (envelope.type === type) return envelope;
  }
  throw new Error(`Timed out waiting for ${type}.`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out.");
}
