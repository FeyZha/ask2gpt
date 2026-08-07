import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { WebSocket } from "ws";

import {
  LiveHost,
  assertCleanHostTerminalEvents,
  assertExactAnswer,
  assertExactOkHistory,
  assertExpectedContentRuntime,
  assertHistoryTail,
  assertNonEmptyAssistantAnswer,
  assertResumeConfiguration,
  classifyRelayErrorReason,
  parseComposerErrorDiagnostic,
  reconcileSmokeHistorySnapshot,
  shouldVerifyPrimaryFollowup,
  verifyResumedPrimaryHost,
} from "./live-relay-smoke.mjs";

test("history reconciliation preserves terminal-backed local messages for safe partial renders", () => {
  const host = new LiveHost(0);
  host.stage = "followup_generation";
  const expected = [
    { role: "user", markdown: "First" },
    { role: "assistant", markdown: "OK" },
    { role: "user", markdown: "Second" },
    { role: "assistant", markdown: "OK" },
  ];
  const envelope = (messages, complete = false) => ({
    type: "conversation.snapshot",
    conversationId: "conversation-a",
    payload: {
      remoteUrl: "https://chatgpt.com/g/ask2gpt/c/remote-a",
      messages,
      complete,
    },
  });

  const empty = reconcileSmokeHistorySnapshot(envelope([]), "conversation-a", 4, expected, host);
  assert.equal(empty?.payload.reconciledFromPartial, true);
  assert.deepEqual(empty?.payload.messages, expected);

  const suffix = reconcileSmokeHistorySnapshot(
    envelope(expected.slice(-2)),
    "conversation-a",
    4,
    expected,
    host,
  );
  assert.deepEqual(suffix?.payload.messages, expected);

  assert.equal(
    reconcileSmokeHistorySnapshot(
      envelope([
        { role: "user", markdown: "Unrelated" },
        { role: "assistant", markdown: "Answer" },
      ]),
      "conversation-a",
      4,
      expected,
      host,
    ),
    undefined,
  );
  assert.throws(
    () =>
      reconcileSmokeHistorySnapshot(
        envelope(expected.slice(-2), true),
        "conversation-a",
        4,
        expected,
        host,
      ),
    (error) => error?.code === "partial_history_marked_complete",
  );
});

test("live smoke rejects a stale content runtime before opening conversations", () => {
  const current = new LiveHost(0);
  current.selectorVersion = 14;
  const stale = new LiveHost(1);
  stale.selectorVersion = 13;

  assert.doesNotThrow(() => assertExpectedContentRuntime([current], 14));
  assert.throws(
    () => assertExpectedContentRuntime([current, stale], 14),
    (error) =>
      error?.code === "content_runtime_revision_mismatch" &&
      error?.hostIndex === 1 &&
      error?.stage === "verify_content_runtime_revision" &&
      error?.reason === "expected_14_received_13",
  );
});

test("live smoke reports a missing content runtime revision clearly", () => {
  const host = new LiveHost(0);

  assert.throws(
    () => assertExpectedContentRuntime([host], 14),
    (error) =>
      error?.code === "content_runtime_revision_mismatch" &&
      error?.reason === "expected_14_received_missing",
  );
});

test("multi-host smoke keeps the primary follow-up and history verification", () => {
  for (const hostCount of [1, 2, 3]) {
    assert.equal(shouldVerifyPrimaryFollowup(hostCount), true);
  }
  assert.equal(shouldVerifyPrimaryFollowup(0), false);
  assert.equal(shouldVerifyPrimaryFollowup(4), false);
});

test("model-independent smoke accepts a complete non-empty assistant response", () => {
  const host = new LiveHost(0);
  host.stage = "first_generation";

  assert.doesNotThrow(() => assertNonEmptyAssistantAnswer("A valid completed answer.", host));
  assert.throws(
    () => assertNonEmptyAssistantAnswer("   ", host),
    (error) => error?.code === "unexpected_model_answer",
  );
});

test("only-OK probes require an exact normalized OK answer", () => {
  const host = new LiveHost(0);
  host.stage = "first_generation";

  for (const answer of ["OK", "**OK**", "`OK`!", "ok。"]) {
    assert.doesNotThrow(() => assertExactAnswer(answer, "OK", host));
  }
  assert.throws(
    () => assertExactAnswer("OK，已经完成。", "OK", host),
    (error) => error?.code === "attachment_content_not_observed",
  );
});

test("history verification accepts non-empty model-dependent answers", () => {
  const host = new LiveHost(0);
  host.stage = "first_generation";

  assert.doesNotThrow(() =>
    assertHistoryTail(
      [
        { role: "user", markdown: "probe" },
        { role: "assistant", markdown: "A complete answer that is not the word OK." },
      ],
      ["probe"],
      host,
    ),
  );
});

test("history verification rejects duplicate or cross-session prefix messages", () => {
  const host = new LiveHost(0);
  host.stage = "followup_generation";

  assert.throws(
    () =>
      assertHistoryTail(
        [
          { role: "user", markdown: "stale probe" },
          { role: "assistant", markdown: "stale answer" },
          { role: "user", markdown: "probe" },
          { role: "assistant", markdown: "OK" },
        ],
        ["probe"],
        host,
      ),
    (error) => error?.code === "unexpected_conversation_history",
  );
});

test("resume mode accepts only one valid existing conversation and no attachment probe", () => {
  const remoteUrl = "https://chatgpt.com/g/g-p-project/c/resume-safe";

  assert.doesNotThrow(() => assertResumeConfiguration(undefined, 3, true));
  assert.doesNotThrow(() => assertResumeConfiguration(remoteUrl, 1, false));
  assert.throws(
    () => assertResumeConfiguration(undefined, 1, false, true),
    (error) => error?.code === "invalid_resume_remote_url",
  );
  assert.throws(
    () => assertResumeConfiguration("https://example.com/c/resume-safe", 1, false),
    (error) => error?.code === "invalid_resume_remote_url",
  );
  assert.throws(
    () => assertResumeConfiguration(remoteUrl, 2, false),
    (error) => error?.code === "resume_requires_single_host",
  );
  assert.throws(
    () => assertResumeConfiguration(remoteUrl, 1, true),
    (error) => error?.code === "resume_attachment_not_supported",
  );
});

test("resume history requires exact OK answers and rejects extra transcript entries", () => {
  const host = new LiveHost(0);
  const prompt = "\u53ea\u56de\u590d OK";

  assert.doesNotThrow(() =>
    assertExactOkHistory(
      [
        { role: "user", markdown: prompt },
        { role: "assistant", markdown: "**OK**!" },
      ],
      [prompt],
      host,
    ),
  );
  assert.throws(
    () =>
      assertExactOkHistory(
        [
          { role: "user", markdown: prompt },
          { role: "assistant", markdown: "OK" },
          { role: "user", markdown: "stale" },
          { role: "assistant", markdown: "OK" },
        ],
        [prompt],
        host,
      ),
    (error) => error?.code === "unexpected_conversation_history",
  );
});

test("resume workflow gates the only remaining send on exact idle history", async () => {
  const host = new LiveHost(0, { runTimeoutMs: 500 });
  const remoteUrl = "https://chatgpt.com/g/g-p-project/c/resume-success";
  const sent = [];
  host.projectBound = true;
  host.authenticated = true;
  host.socket = {
    readyState: WebSocket.OPEN,
    send(value) {
      sent.push(JSON.parse(value));
    },
  };
  await host.openConversation(remoteUrl);

  const verification = verifyResumedPrimaryHost(host, remoteUrl);
  await waitUntil(() => sent.some((envelope) => envelope.type === "relay.status.request"));
  assert.equal(sent.filter((envelope) => envelope.type === "conversation.send").length, 0);

  deliverEnvelope(host, {
    type: "conversation.snapshot",
    conversationId: host.conversationId,
    payload: {
      remoteUrl,
      complete: true,
      messages: [
        { role: "user", markdown: "\u53ea\u56de\u590d OK" },
        { role: "assistant", markdown: "OK" },
      ],
    },
  });
  deliverEnvelope(host, {
    type: "relay.status",
    payload: { activeRuns: 0 },
  });

  await waitUntil(() => sent.some((envelope) => envelope.type === "conversation.send"));
  const sends = sent.filter((envelope) => envelope.type === "conversation.send");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].payload.prompt, "\u518d\u6b21\u53ea\u56de\u590d OK");
  assert.equal(sends[0].payload.remoteUrl, remoteUrl);

  deliverEnvelope(host, {
    id: "resume-terminal",
    type: "generation.complete",
    conversationId: host.conversationId,
    runId: sends[0].runId,
    payload: { markdown: "OK", remoteUrl },
  });
  deliverEnvelope(host, {
    type: "conversation.snapshot",
    conversationId: host.conversationId,
    payload: {
      remoteUrl,
      complete: true,
      messages: [
        { role: "user", markdown: "\u53ea\u56de\u590d OK" },
        { role: "assistant", markdown: "OK" },
        { role: "user", markdown: "\u518d\u6b21\u53ea\u56de\u590d OK" },
        { role: "assistant", markdown: "OK" },
      ],
    },
  });

  const result = await verification;
  assert.equal(result.generations, 1);
  assert.equal(result.firstHistoryMessages, 2);
  assert.equal(result.historyMessages, 4);
  assert.equal(result.urlVerified, true);
  assert.equal(host.conversationSendCount, 1);
  assert.equal(host.relayErrorCount, 0);
  assert.equal(host.generationStoppedCount, 0);
  assertCleanHostTerminalEvents(host, 1);
});

test("resume gate never sends when the existing conversation is active", async () => {
  const host = new LiveHost(0);
  const remoteUrl = "https://chatgpt.com/c/resume-active";
  const sent = [];
  host.socket = {
    readyState: WebSocket.OPEN,
    send(value) {
      sent.push(JSON.parse(value));
    },
  };

  const gate = host.verifyResumeConversation(remoteUrl, 200);
  await waitUntil(() => sent.some((envelope) => envelope.type === "relay.status.request"));
  deliverEnvelope(host, { type: "relay.status", payload: { activeRuns: 1 } });

  await assert.rejects(gate, (error) => error?.code === "resume_gate_active_runs_present");
  assert.equal(sent.filter((envelope) => envelope.type === "conversation.send").length, 0);
});

test("resume gate does not accept incomplete history before a relay error", async () => {
  const host = new LiveHost(0);
  const remoteUrl = "https://chatgpt.com/c/resume-incomplete";
  const sent = [];
  host.socket = {
    readyState: WebSocket.OPEN,
    send(value) {
      sent.push(JSON.parse(value));
    },
  };

  const gate = host.verifyResumeConversation(remoteUrl, 500);
  await waitUntil(() => sent.some((envelope) => envelope.type === "relay.status.request"));
  deliverEnvelope(host, {
    type: "conversation.snapshot",
    conversationId: host.conversationId,
    payload: {
      remoteUrl,
      complete: false,
      messages: [
        { role: "user", markdown: "\u53ea\u56de\u590d OK" },
        { role: "assistant", markdown: "OK" },
      ],
    },
  });
  deliverEnvelope(host, { type: "relay.status", payload: { activeRuns: 0 } });
  await delay(20);
  assert.equal(sent.filter((envelope) => envelope.type === "conversation.send").length, 0);

  deliverEnvelope(host, {
    type: "relay.error",
    conversationId: host.conversationId,
    payload: { code: "TEST_RESUME_ERROR", message: "secret", recoverable: true },
  });
  await assert.rejects(gate, (error) => error?.code === "TEST_RESUME_ERROR");
  assert.equal(sent.filter((envelope) => envelope.type === "conversation.send").length, 0);
});

test("terminal integrity rejects duplicate sends and stopped generations", () => {
  const duplicateSendHost = new LiveHost(0);
  duplicateSendHost.conversationSendCount = 2;
  duplicateSendHost.runDiagnostics.set("run-one", {
    generationCompletes: 1,
    generationErrors: 0,
    generationStops: 0,
  });
  assert.throws(
    () => assertCleanHostTerminalEvents(duplicateSendHost, 1),
    (error) => error?.code === "smoke_event_count_mismatch",
  );

  const stoppedHost = new LiveHost(0);
  stoppedHost.conversationSendCount = 1;
  stoppedHost.generationStoppedCount = 1;
  stoppedHost.runDiagnostics.set("run-stopped", {
    generationCompletes: 0,
    generationErrors: 0,
    generationStops: 1,
  });
  assert.throws(
    () => assertCleanHostTerminalEvents(stoppedHost, 1),
    (error) => error?.code === "terminal_event_mismatch",
  );
});

test("follow-up probes remain read-only and diagnostics never include transcript text", async (t) => {
  const host = new LiveHost(0);
  const runId = "run-followup-test";
  const remoteUrl = "https://chatgpt.com/c/followup-test";
  const sent = [];
  host.runDiagnostics.set(runId, {
    runId,
    stage: "followup_generation",
    generationSnapshots: 0,
    generationCompletes: 0,
    generationErrors: 0,
    terminalObserved: false,
  });
  host.snapshotEvidenceRunId = runId;
  host.latestRemoteUrl = remoteUrl;
  host.conversationOpened = true;
  host.authenticated = true;
  host.socket = {
    readyState: WebSocket.OPEN,
    send(value) {
      sent.push(JSON.parse(value));
    },
  };

  const timer = host.startRunSnapshotProbe(runId, remoteUrl, 10);
  t.after(() => host.stopRunSnapshotProbe(timer));
  await waitUntil(() => sent.length >= 2);
  assert.ok(sent.every((envelope) => envelope.type === "relay.status.request"));
  assert.ok(
    sent.every(
      (envelope) =>
        typeof envelope.payload?.requestedAt === "string" &&
        Number.isFinite(Date.parse(envelope.payload.requestedAt)),
    ),
  );

  host.observeEnvelope({
    type: "conversation.snapshot",
    conversationId: host.conversationId,
    payload: {
      remoteUrl,
      complete: false,
      messages: [
        { role: "user", markdown: "SECRET_PROMPT" },
        { role: "SECRET_ROLE", markdown: "SECRET_ANSWER" },
      ],
    },
  });
  host.observeEnvelope({
    type: "generation.snapshot",
    conversationId: host.conversationId,
    runId,
    payload: { markdown: "SECRET_STREAM", remoteUrl },
  });
  host.observeEnvelope({
    id: "terminal-smoke-event",
    type: "generation.complete",
    conversationId: host.conversationId,
    runId,
    payload: { markdown: "SECRET_COMPLETE", remoteUrl },
  });

  const probesAtTerminal = sent.length;
  assert.deepEqual(
    sent.filter((envelope) => envelope.type === "generation.ack"),
    [
      {
        version: sent.at(-1).version,
        id: sent.at(-1).id,
        type: "generation.ack",
        instanceId: host.instanceId,
        conversationId: host.conversationId,
        runId,
        payload: {
          eventId: "terminal-smoke-event",
          acknowledgedAt: sent.at(-1).payload.acknowledgedAt,
        },
      },
    ],
  );
  await delay(30);
  assert.equal(sent.length, probesAtTerminal);
  assert.equal(host.runProbeTimers.size, 0);

  const run = host.diagnostics().runs.find((candidate) => candidate.runId === runId);
  assert.deepEqual(run, {
    runId,
    stage: "followup_generation",
    generationSnapshots: 1,
    generationCompletes: 1,
    generationErrors: 0,
    generationStops: 0,
    latestSnapshot: {
      messageCount: 2,
      tailRoles: ["user", "unknown"],
      complete: false,
    },
  });
  const serialized = JSON.stringify(host.diagnostics());
  for (const secret of ["SECRET_PROMPT", "SECRET_ANSWER", "SECRET_STREAM", "SECRET_COMPLETE"]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("run-scoped relay errors increment only the redacted generation error counter", () => {
  const host = new LiveHost(0);
  const runId = "run-error-test";
  host.runDiagnostics.set(runId, {
    runId,
    stage: "followup_generation",
    generationSnapshots: 0,
    generationCompletes: 0,
    generationErrors: 0,
    terminalObserved: false,
  });
  host.observeEnvelope({
    type: "relay.error",
    conversationId: host.conversationId,
    runId,
    payload: { code: "TEST_ERROR", message: "SECRET_ERROR_DETAIL" },
  });

  assert.deepEqual(host.diagnostics().runs[0], {
    runId,
    stage: "followup_generation",
    generationSnapshots: 0,
    generationCompletes: 0,
    generationErrors: 1,
    generationStops: 0,
  });
  assert.equal(JSON.stringify(host.diagnostics()).includes("SECRET_ERROR_DETAIL"), false);
});

test("same-ID terminal replays are acknowledged every time but counted once", () => {
  const host = new LiveHost(0);
  const runId = "run-terminal-replay-test";
  const sent = [];
  host.socket = {
    readyState: WebSocket.OPEN,
    send(value) {
      sent.push(JSON.parse(value));
    },
  };
  host.runDiagnostics.set(runId, {
    runId,
    stage: "first_generation",
    generationSnapshots: 0,
    generationCompletes: 0,
    generationErrors: 0,
    terminalObserved: false,
  });
  const terminal = {
    id: "durable-terminal-event",
    type: "generation.complete",
    conversationId: host.conversationId,
    runId,
    payload: { markdown: "OK" },
  };

  host.observeEnvelope(terminal);
  host.observeEnvelope(terminal);

  assert.equal(host.runDiagnostics.get(runId)?.generationCompletes, 1);
  assert.deepEqual(
    sent
      .filter((envelope) => envelope.type === "generation.ack")
      .map((envelope) => envelope.payload.eventId),
    ["durable-terminal-event", "durable-terminal-event"],
  );
});

test("a per-instance settled run gets one bounded chance to replay its terminal", async () => {
  const host = new LiveHost(0, { runTimeoutMs: 20, terminalReplayGraceMs: 100 });
  const sent = [];
  host.socket = {
    readyState: WebSocket.OPEN,
    send(value) {
      sent.push(JSON.parse(value));
    },
  };

  const running = host.runQuestion("probe");
  await waitUntil(() => sent.some((envelope) => envelope.type === "relay.status.request"));
  const request = sent.find((envelope) => envelope.type === "conversation.send");
  assert.ok(request?.runId);

  deliverEnvelope(host, {
    type: "relay.status",
    payload: { activeRuns: 0 },
  });
  deliverEnvelope(host, {
    id: "replayed-terminal-event",
    type: "generation.complete",
    conversationId: host.conversationId,
    runId: request.runId,
    payload: { markdown: "OK", remoteUrl: "https://chatgpt.com/c/replayed-terminal" },
  });

  const terminal = await running;
  assert.equal(terminal.id, "replayed-terminal-event");
  assert.equal(host.runDiagnostics.get(request.runId)?.generationCompletes, 1);
  assert.equal(sent.filter((envelope) => envelope.type === "relay.status.request").length, 1);
});

test("a settled run reports a specific failure when its terminal replay is missing", async () => {
  const host = new LiveHost(0, { runTimeoutMs: 20, terminalReplayGraceMs: 50 });
  const sent = [];
  host.socket = {
    readyState: WebSocket.OPEN,
    send(value) {
      sent.push(JSON.parse(value));
    },
  };

  const running = host.runQuestion("probe");
  await waitUntil(() => sent.some((envelope) => envelope.type === "relay.status.request"));
  deliverEnvelope(host, {
    type: "relay.status",
    payload: { activeRuns: 0 },
  });

  await assert.rejects(
    running,
    (error) => error?.code === "terminal_replay_missing_after_run_settled",
  );
});

test("a per-instance active run does not extend the generation timeout", async () => {
  const host = new LiveHost(0, { runTimeoutMs: 20, terminalReplayGraceMs: 100 });
  const sent = [];
  host.socket = {
    readyState: WebSocket.OPEN,
    send(value) {
      sent.push(JSON.parse(value));
    },
  };

  const running = host.runQuestion("probe");
  await waitUntil(() => sent.some((envelope) => envelope.type === "relay.status.request"));
  const request = sent.find((envelope) => envelope.type === "conversation.send");
  assert.ok(request?.runId);
  deliverEnvelope(host, {
    type: "relay.status",
    payload: { activeRuns: 1 },
  });

  await assert.rejects(running, (error) => error?.code === "relay_event_timeout");
  assert.equal(host.snapshotEvidenceRunId, undefined);

  // Cleanup can settle the run and inspect a complete transcript. Neither is
  // evidence that the run had completed before its active timeout.
  deliverEnvelope(host, {
    type: "relay.status",
    payload: { activeRuns: 0 },
  });
  deliverEnvelope(host, {
    type: "conversation.snapshot",
    conversationId: host.conversationId,
    payload: {
      remoteUrl: "https://chatgpt.com/c/cleanup-only-snapshot",
      complete: true,
      messages: [
        { role: "user", markdown: "probe" },
        { role: "assistant", markdown: "OK" },
      ],
    },
  });

  const diagnostic = host.runDiagnostics.get(request.runId);
  assert.deepEqual(
    diagnostic.statusSamples.map((sample) => sample.activeRuns),
    [1],
  );
  assert.equal(diagnostic.latestSnapshot, undefined);
});

test("history evidence is scoped to its run and released before cleanup", async () => {
  const host = new LiveHost(0);
  const runId = "run-history-evidence";
  const remoteUrl = "https://chatgpt.com/c/history-evidence";
  host.runDiagnostics.set(runId, {
    runId,
    stage: "first_generation",
    generationSnapshots: 0,
    generationCompletes: 1,
    generationErrors: 0,
    terminalObserved: true,
    statusSamples: [],
  });
  host.inbox.push({
    type: "conversation.snapshot",
    conversationId: host.conversationId,
    payload: {
      remoteUrl,
      complete: true,
      messages: [
        { role: "user", markdown: "probe" },
        { role: "assistant", markdown: "OK" },
      ],
    },
  });

  await host.waitForCompleteHistory(2, remoteUrl, runId);
  assert.equal(host.snapshotEvidenceRunId, undefined);
  assert.equal(host.runDiagnostics.get(runId)?.latestSnapshot?.messageCount, 2);

  host.observeEnvelope({
    type: "conversation.snapshot",
    conversationId: host.conversationId,
    payload: {
      remoteUrl,
      complete: true,
      messages: [
        { role: "user", markdown: "probe" },
        { role: "assistant", markdown: "OK" },
        { role: "user", markdown: "cleanup" },
        { role: "assistant", markdown: "not run evidence" },
      ],
    },
  });
  assert.equal(host.runDiagnostics.get(runId)?.latestSnapshot?.messageCount, 2);
});

test("conversation cleanup remains pending until the correlated close acknowledgement arrives", async () => {
  const host = new LiveHost(0, { cleanupAckTimeoutMs: 200 });
  const sent = [];
  host.conversationOpened = true;
  host.authenticated = true;
  host.socket = {
    readyState: WebSocket.OPEN,
    send(value, callback) {
      sent.push(JSON.parse(value));
      callback?.();
    },
  };

  const closing = host.closeConversation();
  await delay(20);
  assert.equal(host.conversationOpened, true);
  const request = sent.find((envelope) => envelope.type === "conversation.close");
  assert.ok(request);

  deliverEnvelope(host, {
    type: "conversation.closed",
    conversationId: host.conversationId,
    payload: {
      requestId: "unrelated-request",
      closeTab: true,
      tabDisposition: "closed",
    },
  });
  await delay(20);
  assert.equal(host.conversationOpened, true);

  deliverEnvelope(host, {
    type: "conversation.closed",
    conversationId: host.conversationId,
    payload: {
      requestId: request.id,
      closeTab: true,
      tabDisposition: "closed",
    },
  });
  await closing;
  assert.equal(host.conversationOpened, false);
});

test("conversation cleanup has a hard acknowledgement timeout and remains retryable", async () => {
  const host = new LiveHost(0, { cleanupAckTimeoutMs: 20 });
  host.conversationOpened = true;
  host.authenticated = true;
  host.socket = {
    readyState: WebSocket.OPEN,
    send(_value, callback) {
      callback?.();
    },
  };

  await assert.rejects(host.closeConversation(), (error) => error?.code === "relay_event_timeout");
  assert.equal(host.conversationOpened, true);
});

test("Project relay failures expose only fixed reason codes", () => {
  const secret = "SECRET_PROJECT_g-p-private/c/private-conversation";
  const results = [
    {
      reason: classifyRelayErrorReason({
        code: "CHATGPT_PROJECT_REQUIRED",
        message: `Missing ${secret}`,
      }),
    },
    {
      reason: classifyRelayErrorReason({
        code: "CHATGPT_PROJECT_MISMATCH",
        message: `Wrong ${secret}`,
      }),
    },
  ];

  assert.deepEqual(results, [{ reason: "project_required" }, { reason: "project_mismatch" }]);
  assert.equal(JSON.stringify(results).includes(secret), false);
});

test("selector failures expose a fixed reason code without page text", () => {
  const secret = "SECRET_SELECTOR_PAGE_TEXT";
  const reason = classifyRelayErrorReason({
    code: "SELECTOR_INCOMPATIBLE",
    message: `Unexpected page structure ${secret}`,
  });

  assert.equal(reason, "selector_incompatible");
  assert.equal(JSON.stringify({ reason }).includes(secret), false);
});

test("trusted-input failures expose only fixed reason codes", () => {
  const secret = "SECRET_PROMPT_TEXT";
  const cases = [
    ["Chrome 未能建立 ChatGPT 的受信任发送通道；问题尚未提交。", "trusted_input_unavailable"],
    [
      "Chrome 未确认 ChatGPT 页面已接受本次发送；Ask2GPT 未自动重试。",
      "trusted_input_not_confirmed",
    ],
    ["ChatGPT 未接受本次发送；问题仍保留在输入框中。", "submission_actuation_ignored"],
    ["ChatGPT 页面的主世界发送通道中断。", "main_world_send_channel_interrupted"],
  ];

  const reasons = cases.map(([message, expected]) => {
    const reason = classifyRelayErrorReason({
      code: "CHATGPT_SEND_FAILED",
      message: `${message} ${secret}`,
    });
    assert.equal(reason, expected);
    return reason;
  });

  assert.equal(JSON.stringify(reasons).includes(secret), false);
});

test("pre-send transcript failures expose only fixed reason codes", () => {
  const secret = "SECRET_PROJECT_g-p-private/c/private-conversation";
  const cases = [
    ["baseline-unstable last=inspect-response-missing", "transcript_inspection_unavailable"],
    ["baseline-unstable last=inspect-snapshot-invalid", "transcript_snapshot_invalid"],
    [
      "baseline-unstable last=partial-cache visible=0 cached=none",
      "transcript_partial_cache_missing",
    ],
    [
      "baseline-unstable last=partial-empty allow=true attested=false cached=2",
      "transcript_partial_empty_unattested",
    ],
    ["baseline-unstable last=partial-mismatch visible=2 cached=2", "transcript_partial_mismatch"],
    ["baseline-invalidated", "transcript_baseline_invalidated"],
  ];

  const reasons = cases.map(([diagnostic, expected]) => {
    const reason = classifyRelayErrorReason({
      code: "CHATGPT_REMOTE_UNAVAILABLE",
      message: `Ask2GPT could not capture a complete, stable pre-send transcript; the question was not sent. Transcript diagnostic: ${diagnostic}. ${secret}`,
    });
    assert.equal(reason, expected);
    return reason;
  });

  assert.equal(JSON.stringify(reasons).includes(secret), false);
});

test("selector diagnostics expose only bounded composer counts", () => {
  const secret = "SECRET_SELECTOR_PAGE_TEXT";
  const diagnostic = parseComposerErrorDiagnostic({
    code: "SELECTOR_INCOMPATIBLE",
    message: `ChatGPT structure changed ${secret} raw=2 ready=0 visibility=visible`,
  });

  assert.deepEqual(diagnostic, {
    rawCandidateCount: 2,
    readyCandidateCount: 0,
    visibilityState: "visible",
  });
  assert.equal(JSON.stringify(diagnostic).includes(secret), false);
  assert.equal(
    parseComposerErrorDiagnostic({
      code: "SELECTOR_INCOMPATIBLE",
      message: "raw=99 ready=0 visibility=visible",
    }),
    undefined,
  );
});

test("Project relay failures cannot be reclassified from attacker-controlled lifecycle text", () => {
  const secret = "SECRET_PROJECT_g-p-private/c/private-conversation";
  const reason = classifyRelayErrorReason({
    code: "CHATGPT_PROJECT_REQUIRED",
    message: `Run lifecycle: intent=1 submitted=1 started=0 complete=0 ${secret}`,
  });

  assert.equal(reason, "project_required");
  assert.equal(JSON.stringify({ reason }).includes(secret), false);
});

test("workspace ignores legacy smoke state instead of treating it as source", async () => {
  const ignore = await readFile(path.resolve(import.meta.dirname, "..", ".gitignore"), "utf8");
  assert.match(ignore, /(?:^|\n)\.smoke\/(?:\n|$)/u);
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for smoke probe evidence.");
    await delay(5);
  }
}

function deliverEnvelope(host, envelope) {
  host.observeEnvelope(envelope);
  host.inbox.push(envelope);
  host.flushWaiters();
}
