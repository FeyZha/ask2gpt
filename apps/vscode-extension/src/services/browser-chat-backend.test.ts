import { MAX_CONCURRENT_RUNS, makeEnvelope, type RelayEnvelope } from "@ask2gpt/protocol";
import { describe, expect, it, vi } from "vitest";

import type { BackendEvent, SendRequest } from "../types";
import { BrowserChatBackend } from "./browser-chat-backend";
import type { ChromeRelayServer } from "./chrome-relay-server";

describe("BrowserChatBackend", () => {
  it("reports Project-required and blocks new runs until the shared Project is bound", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);
    relay.emitEnvelope(statusEnvelope(relay.instanceId, { bound: false }));

    await expect(backend.getStatus()).resolves.toMatchObject({
      project: { bound: false },
      connection: { phase: "project-required" },
    });
    await expect(backend.send(request("conversation", "run"))).rejects.toThrow("完成连接设置");
    expect(relay.sent.map((envelope) => envelope.type)).toEqual(["relay.status.request"]);
  });

  it("enforces one run per conversation and the global three-run limit", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);

    await backend.send(request("conversation-1", "run-1"));
    await expect(backend.send(request("conversation-1", "run-2"))).rejects.toThrow("已有回答");
    await backend.send(request("conversation-2", "run-2"));
    await backend.send(request("conversation-3", "run-3"));
    await expect(backend.send(request("conversation-4", "run-4"))).rejects.toThrow(
      `${MAX_CONCURRENT_RUNS}`,
    );
    expect((await backend.getStatus()).activeRuns).toBe(3);
  });

  it("prewarms an inactive conversation without reserving a generation slot", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);
    const remoteUrl = "https://chatgpt.com/g/ask2gpt/c/remote-a";

    await backend.prepareConversation("conversation", remoteUrl);

    expect(relay.sent.at(-1)).toMatchObject({
      type: "conversation.open",
      conversationId: "conversation",
      payload: { remoteUrl, active: false },
    });
    expect((await backend.getStatus()).activeRuns).toBe(0);
  });

  it("marks composer-driven preparation as a dispatch intent", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);

    await backend.prepareConversation("conversation", undefined, undefined, true);

    expect(relay.sent.at(-1)).toMatchObject({
      type: "conversation.open",
      conversationId: "conversation",
      payload: { active: false, dispatchIntent: true },
    });
    expect((await backend.getStatus()).activeRuns).toBe(0);
  });

  it("releases the reserved slot when send or regenerate throws", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);

    relay.failNextSend = true;
    await expect(backend.send(request("conversation", "send-run"))).rejects.toThrow("send failed");
    expect((await backend.getStatus()).activeRuns).toBe(0);

    relay.failNextSend = true;
    await expect(backend.regenerate("conversation", "message", "regenerate-run")).rejects.toThrow(
      "send failed",
    );
    expect((await backend.getStatus()).activeRuns).toBe(0);

    await expect(backend.send(request("conversation", "replacement-run"))).resolves.toMatchObject({
      runId: "replacement-run",
    });
  });

  it("does not let stale events or Stop requests affect a newer run", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);
    const events: BackendEvent[] = [];
    backend.onEvent((event) => events.push(event));
    await backend.send(request("conversation", "current-run"));
    const sendsBeforeStop = relay.sent.length;

    relay.emitEnvelope(completeEnvelope("conversation", "stale-run"));
    await backend.stop("conversation", "stale-run");

    expect(events).toHaveLength(0);
    expect(relay.sent).toHaveLength(sendsBeforeStop + 1);
    expect(relay.sent.at(-1)).toMatchObject({
      type: "generation.ack",
      conversationId: "conversation",
      runId: "stale-run",
    });
    expect((await backend.getStatus()).activeRuns).toBe(1);

    await backend.stop("conversation", "current-run");
    expect(relay.sent.at(-1)?.type).toBe("generation.stop");
  });

  it("can stop a recovered run before its first snapshot, but not a finished run", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);

    await backend.stop("conversation", "recovered-run");
    expect(relay.sent.at(-1)).toMatchObject({
      type: "generation.stop",
      conversationId: "conversation",
      runId: "recovered-run",
    });

    const complete = completeEnvelope("conversation", "recovered-run");
    relay.emitEnvelope(complete);
    await backend.acknowledgeTerminal("conversation", "recovered-run", complete.id);
    const sendsAfterCompletion = relay.sent.length;
    await backend.stop("conversation", "recovered-run");
    expect(relay.sent).toHaveLength(sendsAfterCompletion);
  });

  it("releases local concurrency when a conversation is closed while disconnected", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);
    await backend.send(request("conversation", "run"));
    relay.connected = false;

    await expect(backend.closeConversation("conversation")).resolves.toBe(false);

    expect(await backend.getStatus()).toMatchObject({
      connected: false,
      activeRuns: 0,
    });
  });

  it("confirms a tab close only after the correlated relay acknowledgement", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);

    const closing = backend.closeConversation("conversation");
    const request = relay.sent.at(-1)!;
    expect(request).toMatchObject({
      type: "conversation.close",
      conversationId: "conversation",
      payload: { closeTab: true },
    });
    relay.emitEnvelope(
      makeEnvelope({
        type: "conversation.closed",
        instanceId: relay.instanceId,
        conversationId: "conversation",
        payload: {
          requestId: request.id,
          closeTab: true,
          tabDisposition: "closed",
        },
      }),
    );
    await expect(closing).resolves.toBe(true);
  });

  it("retries a rejected tab close and accepts an idempotent already-absent acknowledgement", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);

    const closing = backend.closeConversation("conversation");
    relay.emitEnvelope(
      makeEnvelope({
        type: "relay.error",
        instanceId: relay.instanceId,
        conversationId: "conversation",
        payload: {
          code: "CHATGPT_REMOTE_UNAVAILABLE",
          message: "close failed",
          recoverable: true,
        },
      }),
    );
    await vi.waitFor(() =>
      expect(relay.sent.filter((envelope) => envelope.type === "conversation.close")).toHaveLength(
        2,
      ),
    );
    const retry = relay.sent.filter((envelope) => envelope.type === "conversation.close").at(-1)!;
    relay.emitEnvelope(
      makeEnvelope({
        type: "conversation.closed",
        instanceId: relay.instanceId,
        conversationId: "conversation",
        payload: {
          requestId: retry.id,
          closeTab: true,
          tabDisposition: "already-absent",
        },
      }),
    );
    await expect(closing).resolves.toBe(true);
  });

  it("correlates visible model discovery and selection responses", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);

    const listing = backend.listModels("conversation");
    const listRequest = relay.sent.at(-1)!;
    const listRequestId = (listRequest.payload as { requestId: string }).requestId;
    expect(listRequest.type).toBe("model.list");
    relay.emitEnvelope(
      makeEnvelope({
        type: "model.catalog",
        instanceId: relay.instanceId,
        conversationId: "conversation",
        payload: {
          requestId: listRequestId,
          currentModelId: "visible-fast",
          options: [{ id: "visible-fast", label: "GPT Fast", selected: true }],
        },
      }),
    );
    await expect(listing).resolves.toEqual([
      { id: "visible-fast", label: "GPT Fast", selected: true },
    ]);

    const selecting = backend.selectModel("conversation", "visible-deep");
    const selectRequest = relay.sent.at(-1)!;
    const selectRequestId = (selectRequest.payload as { requestId: string }).requestId;
    expect(selectRequest.type).toBe("model.select");
    relay.emitEnvelope(
      makeEnvelope({
        type: "model.selected",
        instanceId: relay.instanceId,
        conversationId: "conversation",
        payload: {
          requestId: selectRequestId,
          selected: { id: "visible-deep", label: "GPT Thinking", selected: true },
        },
      }),
    );
    await expect(selecting).resolves.toMatchObject({ id: "visible-deep", selected: true });
  });

  it("correlates a transcript-bound canonicalization result before a new run", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);
    const promotion = {
      runId: "completed-run",
      messageId: "assistant-message",
      fromRemoteUrl: "https://chatgpt.com/c/provisional-a",
      terminalMarkdownSha256: "a".repeat(64),
      terminalTranscriptSha256: "b".repeat(64),
      terminalStatus: "complete" as const,
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
    };

    const settlement = backend.settlePendingRemotePromotion("conversation", promotion);
    const check = relay.sent.at(-1)!;
    const requestId = (check.payload as { requestId: string }).requestId;
    expect(check).toMatchObject({
      type: "conversation.canonicalization.check",
      conversationId: "conversation",
      payload: {
        requestId,
        runId: promotion.runId,
        fromRemoteUrl: promotion.fromRemoteUrl,
        terminalMarkdownSha256: promotion.terminalMarkdownSha256,
        terminalTranscriptSha256: promotion.terminalTranscriptSha256,
      },
    });

    relay.emitEnvelope(
      makeEnvelope({
        type: "conversation.canonicalization.result",
        instanceId: relay.instanceId,
        conversationId: "conversation",
        payload: {
          requestId,
          runId: promotion.runId,
          fromRemoteUrl: promotion.fromRemoteUrl,
          terminalMarkdownSha256: promotion.terminalMarkdownSha256,
          terminalTranscriptSha256: promotion.terminalTranscriptSha256,
          status: "unchanged",
          remoteUrl: promotion.fromRemoteUrl,
        },
      }),
    );

    await expect(settlement).resolves.toMatchObject({ status: "unchanged", requestId });
  });

  it("adopts authenticated snapshots after restart and forwards terminal recovery", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);
    const events: BackendEvent[] = [];
    backend.onEvent((event) => events.push(event));

    relay.emitEnvelope(snapshotEnvelope("recovered-conversation", "recovered-run"));
    expect(events.at(-1)).toMatchObject({
      type: "snapshot",
      conversationId: "recovered-conversation",
      runId: "recovered-run",
    });
    expect((await backend.getStatus()).activeRuns).toBe(1);

    const recoveredComplete = completeEnvelope("recovered-conversation", "recovered-run");
    relay.emitEnvelope(recoveredComplete);
    expect(events.at(-1)?.type).toBe("complete");
    expect((await backend.getStatus()).activeRuns).toBe(1);
    await backend.acknowledgeTerminal(
      "recovered-conversation",
      "recovered-run",
      recoveredComplete.id,
    );
    expect((await backend.getStatus()).activeRuns).toBe(0);

    const eventCount = events.length;
    relay.emitEnvelope(snapshotEnvelope("recovered-conversation", "recovered-run"));
    expect(events).toHaveLength(eventCount);
  });

  it("does not keep an already-expired recovered run reserved forever", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);
    relay.emitEnvelope(
      makeEnvelope({
        type: "generation.snapshot",
        instanceId: relay.instanceId,
        conversationId: "conversation",
        runId: "expired-recovered-run",
        payload: {
          markdown: "old partial",
          startedAt: new Date(Date.now() - 31 * 60 * 1_000).toISOString(),
        },
      }),
    );

    await expect(backend.getStatus()).resolves.toMatchObject({ activeRuns: 0 });
    await expect(backend.send(request("conversation", "replacement-run"))).resolves.toMatchObject({
      runId: "replacement-run",
    });
  });

  it("forwards a recovered terminal event even if no snapshot arrived first", () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);
    const events: BackendEvent[] = [];
    backend.onEvent((event) => events.push(event));

    relay.emitEnvelope(completeEnvelope("conversation", "persisted-run"));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "complete",
      conversationId: "conversation",
      runId: "persisted-run",
    });
  });

  it("acknowledges a terminal event only after durable application and re-acks a replay", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);
    const events: BackendEvent[] = [];
    backend.onEvent((event) => events.push(event));
    await backend.send(request("conversation", "run"));
    const complete = completeEnvelope("conversation", "run");

    relay.emitEnvelope(complete);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "complete",
      terminalEventId: complete.id,
    });
    expect(relay.sent.some((envelope) => envelope.type === "generation.ack")).toBe(false);

    await backend.acknowledgeTerminal("conversation", "run", complete.id);
    expect(relay.sent.at(-1)).toMatchObject({
      type: "generation.ack",
      conversationId: "conversation",
      runId: "run",
      payload: { eventId: complete.id },
    });

    const eventCount = events.length;
    relay.emitEnvelope(complete);
    expect(events).toHaveLength(eventCount);
    expect(relay.sent.filter((envelope) => envelope.type === "generation.ack")).toHaveLength(2);
  });

  it("does not mistake a conflicting terminal event for an exact replay", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);
    const events: BackendEvent[] = [];
    backend.onEvent((event) => events.push(event));
    await backend.send(request("conversation", "run"));
    const complete = completeEnvelope("conversation", "run");
    relay.emitEnvelope(complete);
    await backend.acknowledgeTerminal("conversation", "run", complete.id);
    const acknowledgementsBeforeConflict = relay.sent.filter(
      (envelope) => envelope.type === "generation.ack",
    ).length;
    const conflicting = errorEnvelope("conversation", "run");

    relay.emitEnvelope(conflicting);

    expect(events.at(-1)).toMatchObject({
      type: "error",
      conversationId: "conversation",
      runId: "run",
      terminalEventId: conflicting.id,
    });
    expect(relay.sent.filter((envelope) => envelope.type === "generation.ack")).toHaveLength(
      acknowledgementsBeforeConflict,
    );
  });

  it("forwards a validated remote title independently of generation state", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);
    const events: BackendEvent[] = [];
    backend.onEvent((event) => events.push(event));
    const observedAt = new Date().toISOString();

    relay.emitEnvelope(
      makeEnvelope({
        type: "conversation.title",
        instanceId: relay.instanceId,
        conversationId: "conversation",
        payload: {
          title: "Understanding event loops",
          remoteUrl: "https://chatgpt.com/g/project/c/conversation",
          observedAt,
        },
      }),
    );

    expect(events).toEqual([
      {
        type: "title",
        conversationId: "conversation",
        title: "Understanding event loops",
        remoteUrl: "https://chatgpt.com/g/project/c/conversation",
        observedAt,
      },
    ]);
    await expect(backend.getStatus()).resolves.toMatchObject({ activeRuns: 0 });
  });

  it("forwards a conversation history snapshot independently of generation state", () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);
    const events: BackendEvent[] = [];
    backend.onEvent((event) => events.push(event));
    const observedAt = new Date().toISOString();

    relay.emitEnvelope(
      makeEnvelope({
        type: "conversation.snapshot",
        instanceId: relay.instanceId,
        conversationId: "conversation",
        payload: {
          remoteUrl: "https://chatgpt.com/c/remote-conversation",
          title: "Understanding event loops",
          messages: [
            { role: "user", markdown: "What is an event loop?" },
            { role: "assistant", markdown: "It schedules asynchronous work." },
          ],
          observedAt,
          complete: true,
          urlPromotion: {
            runId: "completed-run",
            fromRemoteUrl: "https://chatgpt.com/c/provisional-conversation",
            terminalMarkdownSha256: "a".repeat(64),
          },
        },
      }),
    );

    expect(events).toEqual([
      {
        type: "history",
        conversationId: "conversation",
        remoteUrl: "https://chatgpt.com/c/remote-conversation",
        title: "Understanding event loops",
        messages: [
          { role: "user", markdown: "What is an event loop?" },
          { role: "assistant", markdown: "It schedules asynchronous work." },
        ],
        observedAt,
        complete: true,
        urlPromotion: {
          runId: "completed-run",
          fromRemoteUrl: "https://chatgpt.com/c/provisional-conversation",
          terminalMarkdownSha256: "a".repeat(64),
        },
      },
    ]);
  });

  it("keeps conversation-open errors scoped instead of promoting them to connection status", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);
    const events: BackendEvent[] = [];
    backend.onEvent((event) => events.push(event));

    relay.emitEnvelope(
      makeEnvelope({
        type: "relay.error",
        instanceId: relay.instanceId,
        conversationId: "conversation",
        payload: {
          code: "CHATGPT_REMOTE_UNAVAILABLE",
          message: "ChatGPT 会话页面暂时不可用。",
          recoverable: true,
        },
      }),
    );

    expect(events).toEqual([
      {
        type: "error",
        conversationId: "conversation",
        error: {
          code: "CHATGPT_REMOTE_UNAVAILABLE",
          message: "ChatGPT 会话页面暂时不可用。",
          recoverable: true,
        },
      },
    ]);
    expect((await backend.getStatus()).error).toBeUndefined();

    relay.emitEnvelope(
      makeEnvelope({
        type: "relay.error",
        instanceId: relay.instanceId,
        payload: {
          code: "INTERNAL_ERROR",
          message: "Relay transport failed.",
          recoverable: true,
        },
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { code: "INTERNAL_ERROR" },
    });
    expect((await backend.getStatus()).error?.code).toBe("INTERNAL_ERROR");
  });

  it("correlates run errors and combines local and Chrome-wide concurrency truth", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);
    const events: BackendEvent[] = [];
    backend.onEvent((event) => events.push(event));
    await backend.send(request("conversation", "current-run"));

    const staleError = errorEnvelope("conversation", "stale-run");
    relay.emitEnvelope(staleError);
    expect(events).toHaveLength(0);
    expect(relay.sent.at(-1)).toMatchObject({
      type: "generation.ack",
      conversationId: "conversation",
      runId: "stale-run",
      payload: { eventId: staleError.id },
    });
    expect((await backend.getStatus()).activeRuns).toBe(1);

    relay.emitEnvelope(
      makeEnvelope({
        type: "relay.status",
        instanceId: relay.instanceId,
        payload: {
          connected: false,
          authenticated: false,
          activeRuns: 0,
          project: { bound: true, name: "Ask2GPT" },
          selectorVersion: 17,
        },
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "status",
      status: {
        connected: true,
        authenticated: true,
        activeRuns: 1,
        selectorVersion: 17,
      },
    });

    const currentError = errorEnvelope("conversation", "current-run");
    relay.emitEnvelope(currentError);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      conversationId: "conversation",
      runId: "current-run",
    });
    await backend.acknowledgeTerminal("conversation", "current-run", currentError.id);
    expect(await backend.getStatus()).toMatchObject({
      activeRuns: 0,
      selectorVersion: 17,
    });
  });

  it("reports Chrome-wide runs from other VS Code windows", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);

    relay.emitEnvelope(
      makeEnvelope({
        type: "relay.status",
        instanceId: relay.instanceId,
        payload: {
          connected: true,
          authenticated: true,
          activeRuns: 3,
          project: { bound: true, name: "Ask2GPT" },
          selectorVersion: 1,
        },
      }),
    );

    expect((await backend.getStatus()).activeRuns).toBe(3);
    await expect(backend.send(request("conversation", "run"))).rejects.toThrow(
      `${MAX_CONCURRENT_RUNS}`,
    );
  });

  it("waits for authoritative relay status after reconnect", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);
    const events: BackendEvent[] = [];
    backend.onEvent((event) => events.push(event));

    relay.connected = false;
    relay.emitConnectionChanged();
    expect(events.at(-1)).toMatchObject({
      type: "status",
      status: {
        connected: false,
        authenticated: false,
        project: { bound: true, name: "Ask2GPT" },
      },
    });
    await expect(backend.send(request("conversation", "disconnected-run"))).rejects.toThrow(
      "连接尚未就绪",
    );

    const eventCount = events.length;
    relay.connected = true;
    relay.authoritativeGeneration += 1;
    relay.emitConnectionChanged();
    expect(events).toHaveLength(eventCount + 1);
    expect(events.at(-1)).toMatchObject({
      type: "status",
      status: {
        connected: true,
        authenticated: true,
        connection: { phase: "syncing" },
      },
    });
    await expect(backend.getStatus()).resolves.toMatchObject({
      connected: true,
      authenticated: true,
      project: { bound: true, name: "Ask2GPT" },
      connection: {
        phase: "syncing",
        hostVersion: "0.0.1",
        relayVersion: "0.0.1",
        protocolVersion: 8,
        detectedProtocol: "ask2gpt.v15",
        lastConnectedAt: "2026-01-01T00:00:01.000Z",
      },
    });
    await expect(backend.send(request("conversation", "checking-run"))).rejects.toThrow(
      "正在同步连接状态",
    );
    expect(relay.sent.at(-1)?.type).toBe("relay.status.request");

    relay.emitEnvelope(statusEnvelope(relay.instanceId, { bound: true, name: "Ask2GPT" }));
    expect(events.at(-1)).toMatchObject({
      type: "status",
      status: {
        connected: true,
        authenticated: true,
        project: { bound: true, name: "Ask2GPT" },
      },
    });
    await expect(backend.getStatus()).resolves.toMatchObject({
      connected: true,
      authenticated: true,
    });
  });

  it("replays the exact active command once after an authoritative Relay replacement", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);
    await backend.send(request("conversation", "replay-run"));
    const original = relay.sent.find((envelope) => envelope.type === "conversation.send")!;

    relay.connected = false;
    relay.emitConnectionChanged();
    relay.connected = true;
    relay.authoritativeGeneration += 1;
    relay.emitConnectionChanged();

    expect(relay.sent.filter((envelope) => envelope.type === "conversation.send")).toEqual([
      original,
    ]);
    relay.emitEnvelope(statusEnvelope(relay.instanceId, { bound: true, name: "Ask2GPT" }));
    expect(relay.sent.filter((envelope) => envelope.type === "conversation.send")).toEqual([
      original,
      original,
    ]);

    // Further status refreshes on the same transport generation are not a
    // reason to replay a non-idempotent page command again.
    relay.emitEnvelope(statusEnvelope(relay.instanceId, { bound: true, name: "Ask2GPT" }));
    expect(relay.sent.filter((envelope) => envelope.type === "conversation.send")).toHaveLength(2);

    const terminal = completeEnvelope("conversation", "replay-run");
    relay.emitEnvelope(terminal);
    await backend.acknowledgeTerminal("conversation", "replay-run", terminal.id);
    relay.connected = false;
    relay.emitConnectionChanged();
    relay.connected = true;
    relay.authoritativeGeneration += 1;
    relay.emitConnectionChanged();
    relay.emitEnvelope(statusEnvelope(relay.instanceId, { bound: true, name: "Ask2GPT" }));
    expect(relay.sent.filter((envelope) => envelope.type === "conversation.send")).toHaveLength(2);
  });

  it("retires request-scoped work when the authoritative socket changes without a disconnect event", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);
    const promotion = {
      runId: "completed-run",
      messageId: "assistant-message",
      fromRemoteUrl: "https://chatgpt.com/c/provisional-a",
      terminalMarkdownSha256: "a".repeat(64),
      terminalTranscriptSha256: "b".repeat(64),
      terminalStatus: "complete" as const,
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
    };
    const settlement = backend.settlePendingRemotePromotion("conversation", promotion);
    const listing = backend.listModels("conversation");

    relay.authoritativeGeneration += 1;
    relay.emitConnectionChanged();

    await expect(settlement).rejects.toThrow("connection changed");
    await expect(listing).rejects.toThrow("connection changed");
    await expect(backend.getStatus()).resolves.toMatchObject({
      connected: true,
      connection: { phase: "syncing" },
    });

    relay.emitEnvelope(statusEnvelope(relay.instanceId, { bound: true, name: "Ask2GPT" }));
    const retry = backend.listModels("conversation");
    const requestId = (
      relay.sent.filter((envelope) => envelope.type === "model.list").at(-1)!.payload as {
        requestId: string;
      }
    ).requestId;
    relay.emitEnvelope(
      makeEnvelope({
        type: "model.catalog",
        instanceId: relay.instanceId,
        conversationId: "conversation",
        payload: {
          requestId,
          options: [{ id: "visible-fast", label: "GPT Fast", selected: true }],
        },
      }),
    );
    await expect(retry).resolves.toEqual([
      { id: "visible-fast", label: "GPT Fast", selected: true },
    ]);
  });

  it("recovers when the initial Chrome status arrived before backend construction", async () => {
    vi.useFakeTimers();
    try {
      const relay = new FakeRelay();
      const backend = new BrowserChatBackend(relay as unknown as ChromeRelayServer);

      expect(relay.sent.map((envelope) => envelope.type)).toEqual(["relay.status.request"]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(
        relay.sent.filter((envelope) => envelope.type === "relay.status.request").length,
      ).toBeGreaterThan(1);

      relay.emitEnvelope(statusEnvelope(relay.instanceId, { bound: true, name: "Ask2GPT" }));
      const confirmedRequestCount = relay.sent.filter(
        (envelope) => envelope.type === "relay.status.request",
      ).length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(
        relay.sent.filter((envelope) => envelope.type === "relay.status.request"),
      ).toHaveLength(confirmedRequestCount);
      await expect(backend.getStatus()).resolves.toMatchObject({
        connected: true,
        connection: { phase: "ready" },
      });
      await backend.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the finished-run LRU consistent when a run key is reserved again", async () => {
    const relay = new FakeRelay();
    const backend = createBackend(relay);
    const events: BackendEvent[] = [];
    backend.onEvent((event) => events.push(event));
    let terminal = completeEnvelope("target", "same-run");
    relay.emitEnvelope(terminal);
    await backend.acknowledgeTerminal("target", "same-run", terminal.id);
    for (let index = 0; index < 2_047; index += 1) {
      terminal = completeEnvelope(`other-${index}`, `run-${index}`);
      relay.emitEnvelope(terminal);
      await backend.acknowledgeTerminal(`other-${index}`, `run-${index}`, terminal.id);
    }

    await backend.send(request("target", "same-run"));
    terminal = completeEnvelope("target", "same-run");
    relay.emitEnvelope(terminal);
    await backend.acknowledgeTerminal("target", "same-run", terminal.id);
    terminal = completeEnvelope("new-entry", "new-run");
    relay.emitEnvelope(terminal);
    await backend.acknowledgeTerminal("new-entry", "new-run", terminal.id);
    const eventCount = events.length;

    relay.emitEnvelope(snapshotEnvelope("target", "same-run"));

    expect(events).toHaveLength(eventCount);
  });

  it("keeps Project status synchronization local across an idle reconnect", async () => {
    const relay = new FakeRelay();
    const backend = new BrowserChatBackend(relay as unknown as ChromeRelayServer);
    relay.emitEnvelope(statusEnvelope(relay.instanceId, { bound: false }));

    await expect(backend.send(request("conversation", "run"))).rejects.toThrow("完成连接设置");
    expect((await backend.getStatus()).connection.phase).toBe("project-required");

    relay.authoritativeGeneration += 1;
    relay.emitConnectionChanged();
    expect(relay.sent.map((envelope) => envelope.type)).toEqual([
      "relay.status.request",
      "relay.status.request",
    ]);
  });
});

class FakeRelay {
  readonly instanceId = "instance-test";
  readonly port = 32_171;
  readonly pairing = {
    code: "ABCDEFGH",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  connected = true;
  authoritativeGeneration = 1;
  get connectionState() {
    return {
      phase: this.connected ? ("syncing" as const) : ("reconnecting" as const),
      since: "2026-01-01T00:00:00.000Z",
      browserDetected: true,
      hasStoredTrust: true,
      hostVersion: "0.0.1",
      relayVersion: "0.0.1",
      protocolVersion: 8,
      detectedProtocol: "ask2gpt.v15",
      lastConnectedAt: "2026-01-01T00:00:01.000Z",
    };
  }
  failNextSend = false;
  readonly sent: RelayEnvelope[] = [];
  private readonly envelopeListeners = new Set<(envelope: RelayEnvelope) => void>();
  private readonly connectionListeners = new Set<() => void>();

  onEnvelope(listener: (envelope: RelayEnvelope) => void) {
    this.envelopeListeners.add(listener);
    return { dispose: () => this.envelopeListeners.delete(listener) };
  }

  onConnectionChanged(listener: () => void) {
    this.connectionListeners.add(listener);
    return { dispose: () => this.connectionListeners.delete(listener) };
  }

  send(envelope: RelayEnvelope) {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("send failed");
    }
    this.sent.push(envelope);
  }

  emitEnvelope(envelope: RelayEnvelope) {
    for (const listener of this.envelopeListeners) listener(envelope);
  }

  emitConnectionChanged() {
    for (const listener of this.connectionListeners) listener();
  }
}

function createBackend(relay: FakeRelay) {
  const backend = new BrowserChatBackend(relay as unknown as ChromeRelayServer);
  relay.emitEnvelope(statusEnvelope(relay.instanceId, { bound: true, name: "Ask2GPT" }));
  return backend;
}

function statusEnvelope(
  instanceId: string,
  project: { bound: false } | { bound: true; name: string },
) {
  return makeEnvelope({
    type: "relay.status",
    instanceId,
    payload: {
      connected: true,
      authenticated: true,
      activeRuns: 0,
      project,
      selectorVersion: 1,
    },
  });
}

function request(conversationId: string, runId: string): SendRequest {
  return {
    conversationId,
    runId,
    messageId: `message-${runId}`,
    prompt: "Question",
  };
}

function snapshotEnvelope(conversationId: string, runId: string) {
  return makeEnvelope({
    type: "generation.snapshot",
    instanceId: "instance-test",
    conversationId,
    runId,
    payload: {
      markdown: "partial",
      startedAt: new Date().toISOString(),
    },
  });
}

function completeEnvelope(conversationId: string, runId: string) {
  const now = new Date().toISOString();
  return makeEnvelope({
    type: "generation.complete",
    instanceId: "instance-test",
    conversationId,
    runId,
    payload: {
      markdown: "complete",
      startedAt: now,
      completedAt: now,
    },
  });
}

function errorEnvelope(conversationId: string, runId: string) {
  return makeEnvelope({
    type: "relay.error",
    instanceId: "instance-test",
    conversationId,
    runId,
    payload: {
      code: "CHATGPT_SEND_FAILED" as const,
      message: "failed",
      recoverable: true,
    },
  });
}
