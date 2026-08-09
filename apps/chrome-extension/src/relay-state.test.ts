import { describe, expect, it } from "vitest";

import {
  classifyActiveRunTab,
  classifyRecoveredRun,
  classifyRestoredRemoteAdoption,
  conversationKey,
  isCompletedCanonicalizationCurrent,
  isRunExpired,
  parseStoredCompletedCanonicalizations,
  parseStoredPendingEvents,
  parseStoredRuns,
  parseStoredTerminalHistoryBarriers,
  parseStoredTabs,
} from "./relay-state";

const now = "2026-07-24T00:00:00.000Z";

describe("service-worker session recovery records", () => {
  it("keeps identical conversation IDs isolated by VS Code instance", () => {
    expect(conversationKey("window-a", "same-conversation")).not.toBe(
      conversationKey("window-b", "same-conversation"),
    );
  });

  it("polls available run tabs, reloads discarded tabs, and unfreezes frozen tabs", () => {
    expect(classifyActiveRunTab({})).toBe("poll");
    expect(classifyActiveRunTab({ discarded: true })).toBe("reload");
    expect(classifyActiveRunTab({ frozen: true })).toBe("unfreeze");
    expect(classifyActiveRunTab({ discarded: true, frozen: true })).toBe("reload");
  });

  it("expires recovered runs against their original start time", () => {
    const run = {
      instanceId: "instance-1",
      conversationId: "conversation-1",
      runId: "run-1",
      phase: "active" as const,
      remoteAdoptionStage: "locked" as const,
      startedAt: now,
    };
    const startedAt = Date.parse(now);

    expect(isRunExpired(run, startedAt + 29 * 60 * 1000)).toBe(false);
    expect(isRunExpired(run, startedAt + 30 * 60 * 1000)).toBe(true);
    expect(isRunExpired({ ...run, startedAt: "invalid" }, startedAt)).toBe(true);
  });

  it("restores only extension-owned, safe ChatGPT tab records", () => {
    const tabs = parseStoredTabs([
      {
        owned: true,
        instanceId: "instance-1",
        conversationId: "conversation-1",
        tabId: 7,
        remoteUrl: "https://chatgpt.com/c/abc?model=hidden",
        remoteTitle: "Event loop guide",
        createdAt: now,
      },
      {
        owned: false,
        instanceId: "instance-2",
        conversationId: "conversation-2",
        tabId: 8,
        remoteUrl: "https://chatgpt.com/c/def",
        createdAt: now,
      },
      {
        owned: true,
        instanceId: "instance-4",
        conversationId: "conversation-4",
        tabId: 10,
        remoteUrl: "https://chatgpt.com/g/runtime-scope/c/project-conversation?temporary=value",
        projectScope: "https://chatgpt.com/g/runtime-scope/",
        createdAt: now,
      },
      {
        owned: true,
        instanceId: "instance-6",
        conversationId: "conversation-6",
        tabId: 12,
        remoteUrl: "https://chatgpt.com/g/runtime-scope/c/invalid-scope",
        projectScope: "https://chatgpt.com/g/other/",
        createdAt: now,
      },
      {
        owned: true,
        instanceId: "instance-3",
        conversationId: "conversation-3",
        tabId: 9,
        remoteUrl: "https://example.com/",
        createdAt: now,
      },
      {
        owned: true,
        instanceId: "instance-5",
        conversationId: "conversation-5",
        tabId: 11,
        remoteUrl: "https://chatgpt.com/g/runtime-scope/project",
        remoteTitle: "A title without a conversation",
        createdAt: now,
      },
    ]);

    expect([...tabs.values()]).toEqual([
      {
        owned: true,
        instanceId: "instance-1",
        conversationId: "conversation-1",
        tabId: 7,
        remoteUrl: "https://chatgpt.com/c/abc",
        remoteTitle: "Event loop guide",
        createdAt: now,
        provenance: "legacy-unknown",
        leaseEpoch: 0,
        lastUsedAt: now,
      },
      {
        owned: true,
        instanceId: "instance-4",
        conversationId: "conversation-4",
        tabId: 10,
        remoteUrl: "https://chatgpt.com/g/runtime-scope/c/project-conversation",
        projectScope: "https://chatgpt.com/g/runtime-scope/",
        createdAt: now,
        provenance: "legacy-unknown",
        leaseEpoch: 0,
        lastUsedAt: now,
      },
    ]);
  });

  it("restores explicit tab lease metadata while legacy records fail closed", () => {
    const lastUsedAt = "2026-07-24T00:01:00.000Z";
    const idleSince = "2026-07-24T00:02:00.000Z";
    const releaseRequestedAt = "2026-07-24T00:02:30.000Z";
    const userClaimedAt = "2026-07-24T00:03:00.000Z";
    const tabs = parseStoredTabs([
      {
        owned: true,
        instanceId: "instance-created",
        conversationId: "conversation-created",
        tabId: 17,
        createdAt: now,
        provenance: "created",
        leaseEpoch: 9,
        lastUsedAt,
        idleSince,
        releaseRequestedAt,
        userClaimedAt,
      },
      {
        owned: true,
        instanceId: "instance-legacy",
        conversationId: "conversation-legacy",
        tabId: 18,
        createdAt: now,
      },
      {
        owned: false,
        instanceId: "instance-borrowed",
        conversationId: "conversation-borrowed",
        tabId: 19,
        createdAt: now,
        provenance: "borrowed",
        leaseEpoch: 1,
        lastUsedAt,
      },
    ]);

    expect(tabs.get(conversationKey("instance-created", "conversation-created"))).toMatchObject({
      provenance: "created",
      leaseEpoch: 9,
      lastUsedAt,
      idleSince,
      releaseRequestedAt,
      userClaimedAt,
    });
    expect(tabs.get(conversationKey("instance-legacy", "conversation-legacy"))).toMatchObject({
      provenance: "legacy-unknown",
      leaseEpoch: 0,
      lastUsedAt: now,
    });
    expect(tabs.get(conversationKey("instance-borrowed", "conversation-borrowed"))).toMatchObject({
      owned: false,
      provenance: "borrowed",
      leaseEpoch: 1,
    });
  });

  it("rejects malformed tab lease authority instead of upgrading it", () => {
    const base = {
      owned: true,
      instanceId: "instance-1",
      conversationId: "conversation-1",
      tabId: 17,
      createdAt: now,
    };
    const tabs = parseStoredTabs([
      { ...base, provenance: "extension-created" },
      { ...base, conversationId: "conversation-2", tabId: 18, leaseEpoch: -1 },
      { ...base, conversationId: "conversation-3", tabId: 19, lastUsedAt: "not-a-date" },
      { ...base, conversationId: "conversation-4", tabId: 20, idleSince: "not-a-date" },
      {
        ...base,
        conversationId: "conversation-5",
        tabId: 21,
        releaseRequestedAt: "not-a-date",
      },
      { ...base, conversationId: "conversation-6", tabId: 22, userClaimedAt: "not-a-date" },
      {
        ...base,
        conversationId: "conversation-7",
        tabId: 23,
        provenance: "borrowed",
      },
      {
        ...base,
        owned: false,
        conversationId: "conversation-8",
        tabId: 24,
        provenance: "created",
      },
    ]);

    expect(tabs.size).toBe(0);
  });

  it("keeps valid mappings while dropping legacy generic or invalid remote titles", () => {
    const tabs = parseStoredTabs([
      {
        owned: true,
        instanceId: "instance-skip-link",
        conversationId: "conversation-skip-link",
        tabId: 20,
        remoteUrl: "https://chatgpt.com/c/skip-link-title",
        remoteTitle: "跳至内容",
        createdAt: now,
      },
      {
        owned: true,
        instanceId: "instance-generic-title",
        conversationId: "conversation-generic-title",
        tabId: 21,
        remoteUrl: "https://chatgpt.com/c/generic-title",
        remoteTitle: "New chat",
        createdAt: now,
      },
      {
        owned: true,
        instanceId: "instance-invalid-title",
        conversationId: "conversation-invalid-title",
        tabId: 22,
        remoteUrl: "https://chatgpt.com/c/invalid-title",
        remoteTitle: "unsafe\u0000title",
        createdAt: now,
      },
      {
        owned: true,
        instanceId: "instance-title-only",
        conversationId: "conversation-title-only",
        tabId: 23,
        remoteTitle: "跳至内容",
        createdAt: now,
      },
    ]);

    expect([...tabs.values()]).toEqual([
      {
        owned: true,
        instanceId: "instance-skip-link",
        conversationId: "conversation-skip-link",
        tabId: 20,
        remoteUrl: "https://chatgpt.com/c/skip-link-title",
        createdAt: now,
        provenance: "legacy-unknown",
        leaseEpoch: 0,
        lastUsedAt: now,
      },
      {
        owned: true,
        instanceId: "instance-generic-title",
        conversationId: "conversation-generic-title",
        tabId: 21,
        remoteUrl: "https://chatgpt.com/c/generic-title",
        createdAt: now,
        provenance: "legacy-unknown",
        leaseEpoch: 0,
        lastUsedAt: now,
      },
      {
        owned: true,
        instanceId: "instance-invalid-title",
        conversationId: "conversation-invalid-title",
        tabId: 22,
        remoteUrl: "https://chatgpt.com/c/invalid-title",
        createdAt: now,
        provenance: "legacy-unknown",
        leaseEpoch: 0,
        lastUsedAt: now,
      },
    ]);
    expect(tabs.has(conversationKey("instance-title-only", "conversation-title-only"))).toBe(false);
  });

  it("rejects legacy/unvalidated run records and keeps explicit recovery phase", () => {
    const runs = parseStoredRuns([
      {
        instanceId: "instance-1",
        conversationId: "conversation-1",
        runId: "run-1",
        tabId: 7,
        phase: "active",
        allowRemoteAdoption: true,
        startedAt: now,
      },
      ["legacy", "shape"],
      {
        instanceId: "instance-2",
        conversationId: "conversation-2",
        runId: "run-2",
        phase: "zombie",
        startedAt: now,
      },
    ]);

    expect(runs.get(conversationKey("instance-1", "conversation-1"))).toMatchObject({
      runId: "run-1",
      phase: "active",
      tabId: 7,
      remoteAdoptionStage: "initial",
    });
    expect(runs.size).toBe(1);
  });

  it("restores only a validated prompt fingerprint for reload recovery", () => {
    const validDigest = "a".repeat(64);
    const validInlinePresentationDigest = "b".repeat(64);
    const runs = parseStoredRuns([
      {
        instanceId: "instance-1",
        conversationId: "conversation-1",
        runId: "run-1",
        phase: "active",
        remoteAdoptionStage: "canonicalizing",
        promptSha256: validDigest,
        promptInlinePresentationVersion: 1,
        promptInlinePresentationSha256: validInlinePresentationDigest,
        startedAt: now,
      },
      {
        instanceId: "instance-2",
        conversationId: "conversation-2",
        runId: "run-2",
        phase: "active",
        remoteAdoptionStage: "canonicalizing",
        promptSha256: "not-a-digest",
        startedAt: now,
      },
      {
        instanceId: "instance-3",
        conversationId: "conversation-3",
        runId: "run-3",
        phase: "active",
        remoteAdoptionStage: "canonicalizing",
        promptInlinePresentationVersion: 1,
        promptInlinePresentationSha256: validInlinePresentationDigest,
        startedAt: now,
      },
    ]);

    expect(runs.get(conversationKey("instance-1", "conversation-1"))).toMatchObject({
      promptSha256: validDigest,
      promptInlinePresentationVersion: 1,
      promptInlinePresentationSha256: validInlinePresentationDigest,
    });
    expect(runs.has(conversationKey("instance-2", "conversation-2"))).toBe(false);
    expect(runs.has(conversationKey("instance-3", "conversation-3"))).toBe(false);
  });

  it("restores only a monotonic true response-observed marker", () => {
    const runs = parseStoredRuns([
      {
        instanceId: "instance-1",
        conversationId: "conversation-1",
        runId: "run-1",
        phase: "active",
        remoteAdoptionStage: "locked",
        responseObserved: true,
        startedAt: now,
      },
      {
        instanceId: "instance-2",
        conversationId: "conversation-2",
        runId: "run-2",
        phase: "active",
        remoteAdoptionStage: "locked",
        responseObserved: false,
        startedAt: now,
      },
    ]);

    expect(runs.get(conversationKey("instance-1", "conversation-1"))).toMatchObject({
      responseObserved: true,
    });
    expect(runs.has(conversationKey("instance-2", "conversation-2"))).toBe(false);
  });

  it("restores only a complete durable transcript baseline and reload claim", () => {
    const transcriptSha256 = "c".repeat(64);
    const claimedAt = "2026-07-24T00:00:05.000Z";
    const valid = {
      instanceId: "instance-1",
      conversationId: "conversation-1",
      runId: "run-1",
      tabId: 17,
      phase: "active",
      remoteAdoptionStage: "locked",
      dispatchTranscriptBaseline: {
        tabId: 17,
        remoteUrl: "https://chatgpt.com/c/abc?model=hidden",
        messageCount: 2,
        transcriptSha256,
      },
      historyReloadClaimedAt: claimedAt,
      startedAt: now,
    };
    const runs = parseStoredRuns([
      valid,
      {
        ...valid,
        instanceId: "instance-2",
        conversationId: "conversation-2",
        runId: "run-2",
        dispatchTranscriptBaseline: { ...valid.dispatchTranscriptBaseline, tabId: 18 },
      },
      {
        ...valid,
        instanceId: "instance-3",
        conversationId: "conversation-3",
        runId: "run-3",
        dispatchTranscriptBaseline: undefined,
      },
    ]);

    expect(runs.get(conversationKey("instance-1", "conversation-1"))).toMatchObject({
      dispatchTranscriptBaseline: {
        tabId: 17,
        remoteUrl: "https://chatgpt.com/c/abc",
        messageCount: 2,
        transcriptSha256,
      },
      historyReloadClaimedAt: claimedAt,
    });
    expect(runs.has(conversationKey("instance-2", "conversation-2"))).toBe(false);
    expect(runs.has(conversationKey("instance-3", "conversation-3"))).toBe(false);
  });

  it("restores an empty initial Project baseline only within the same Project scope", () => {
    const transcriptSha256 = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
    const initialProjectUrl = "https://chatgpt.com/g/ask2gpt/project";
    const base = {
      tabId: 17,
      phase: "active",
      remoteAdoptionStage: "canonicalizing",
      startedAt: now,
    } as const;
    const runs = parseStoredRuns([
      {
        ...base,
        instanceId: "instance-1",
        conversationId: "conversation-1",
        runId: "run-1",
        dispatchTranscriptBaseline: {
          tabId: 17,
          remoteUrl: initialProjectUrl,
          initialProjectUrl,
          messageCount: 0,
          transcriptSha256,
        },
      },
      {
        ...base,
        instanceId: "instance-2",
        conversationId: "conversation-2",
        runId: "run-2",
        dispatchTranscriptBaseline: {
          tabId: 17,
          remoteUrl: "https://chatgpt.com/g/ask2gpt/c/canonical",
          initialProjectUrl,
          messageCount: 0,
          transcriptSha256,
        },
      },
      {
        ...base,
        instanceId: "instance-3",
        conversationId: "conversation-3",
        runId: "run-3",
        dispatchTranscriptBaseline: {
          tabId: 17,
          remoteUrl: "https://chatgpt.com/g/other-project/c/wrong",
          initialProjectUrl,
          messageCount: 0,
          transcriptSha256,
        },
      },
      {
        ...base,
        instanceId: "instance-4",
        conversationId: "conversation-4",
        runId: "run-4",
        dispatchTranscriptBaseline: {
          tabId: 17,
          remoteUrl: "https://chatgpt.com/g/ask2gpt/c/non-empty",
          initialProjectUrl,
          messageCount: 2,
          transcriptSha256,
        },
      },
    ]);

    expect(runs.get(conversationKey("instance-1", "conversation-1"))).toMatchObject({
      dispatchTranscriptBaseline: { remoteUrl: initialProjectUrl, initialProjectUrl },
    });
    expect(runs.get(conversationKey("instance-2", "conversation-2"))).toMatchObject({
      dispatchTranscriptBaseline: {
        remoteUrl: "https://chatgpt.com/g/ask2gpt/c/canonical",
        initialProjectUrl,
      },
    });
    expect(runs.has(conversationKey("instance-3", "conversation-3"))).toBe(false);
    expect(runs.has(conversationKey("instance-4", "conversation-4"))).toBe(false);
  });

  it("restores active canonicalization with or without the legacy short timer", () => {
    const expiresAt = "2026-07-24T00:00:30.000Z";
    const runs = parseStoredRuns([
      {
        instanceId: "instance-1",
        conversationId: "conversation-1",
        runId: "run-1",
        phase: "active",
        remoteAdoptionStage: "canonicalizing",
        canonicalizationExpiresAt: expiresAt,
        startedAt: now,
      },
      {
        instanceId: "instance-2",
        conversationId: "conversation-2",
        runId: "run-2",
        phase: "active",
        remoteAdoptionStage: "canonicalizing",
        startedAt: now,
      },
    ]);

    expect(runs.get(conversationKey("instance-1", "conversation-1"))).toMatchObject({
      remoteAdoptionStage: "canonicalizing",
      canonicalizationExpiresAt: expiresAt,
    });
    expect(runs.get(conversationKey("instance-2", "conversation-2"))).toMatchObject({
      remoteAdoptionStage: "canonicalizing",
    });
  });

  it("restores only validated post-complete canonicalization grants", () => {
    const expiresAt = "2026-07-24T00:00:30.000Z";
    const grants = parseStoredCompletedCanonicalizations([
      {
        instanceId: "instance-1",
        conversationId: "conversation-1",
        runId: "run-1",
        tabId: 7,
        fromRemoteUrl: "https://chatgpt.com/c/provisional?hidden=value",
        toRemoteUrl: "https://chatgpt.com/g/project/c/canonical?hidden=value",
        terminalMarkdownSha256: "a".repeat(64),
        terminalTranscriptSha256: "c".repeat(64),
        terminalStatus: "complete",
        expiresAt,
      },
      {
        instanceId: "instance-2",
        conversationId: "conversation-2",
        runId: "run-2",
        tabId: 8,
        fromRemoteUrl: "https://evil.test/c/nope",
        terminalMarkdownSha256: "b".repeat(64),
        terminalTranscriptSha256: "d".repeat(64),
        terminalStatus: "complete",
        expiresAt,
      },
      {
        instanceId: "instance-3",
        conversationId: "conversation-3",
        runId: "run-3",
        tabId: 9,
        fromRemoteUrl: "https://chatgpt.com/c/other",
        terminalMarkdownSha256: "not-a-digest",
        terminalTranscriptSha256: "e".repeat(64),
        terminalStatus: "stopped",
        expiresAt,
      },
    ]);

    const grant = grants.get(conversationKey("instance-1", "conversation-1"));
    expect(grant).toMatchObject({
      fromRemoteUrl: "https://chatgpt.com/c/provisional",
      toRemoteUrl: "https://chatgpt.com/g/project/c/canonical",
      terminalMarkdownSha256: "a".repeat(64),
      terminalTranscriptSha256: "c".repeat(64),
      terminalStatus: "complete",
      expiresAt,
    });
    expect(grants.size).toBe(1);
    expect(isCompletedCanonicalizationCurrent(grant!, Date.parse(now))).toBe(true);
    expect(isCompletedCanonicalizationCurrent(grant!, Date.parse(expiresAt))).toBe(false);
    expect(
      isCompletedCanonicalizationCurrent(
        { ...grant!, expiresAt: "2099-01-01T00:00:00.000Z" },
        Date.parse(now),
      ),
    ).toBe(false);
  });

  it("restores only validated terminal history barriers", () => {
    const barriers = parseStoredTerminalHistoryBarriers([
      {
        instanceId: "instance-1",
        conversationId: "conversation-1",
        runId: "run-1",
        tabId: 7,
        terminalMarkdownSha256: "a".repeat(64),
        createdAt: now,
      },
      {
        instanceId: "instance-2",
        conversationId: "conversation-2",
        runId: "run-2",
        tabId: -1,
        terminalMarkdownSha256: "b".repeat(64),
        createdAt: now,
      },
      {
        instanceId: "instance-3",
        conversationId: "conversation-3",
        runId: "run-3",
        tabId: 9,
        terminalMarkdownSha256: "not-a-digest",
        createdAt: now,
      },
    ]);

    expect(barriers).toEqual(
      new Map([
        [
          conversationKey("instance-1", "conversation-1"),
          {
            instanceId: "instance-1",
            conversationId: "conversation-1",
            runId: "run-1",
            tabId: 7,
            terminalMarkdownSha256: "a".repeat(64),
            createdAt: now,
          },
        ],
      ]),
    );
  });

  it("keeps exact-run adoption authority until the hard run timeout", () => {
    const initial = {
      instanceId: "instance-1",
      conversationId: "conversation-1",
      runId: "run-1",
      phase: "active" as const,
      remoteAdoptionStage: "initial" as const,
      startedAt: now,
    };
    const canonicalizing = {
      ...initial,
      remoteAdoptionStage: "canonicalizing" as const,
      canonicalizationExpiresAt: "2026-07-24T00:00:30.000Z",
    };

    expect(classifyRestoredRemoteAdoption(initial, false, Date.parse(now))).toBe("keep");
    expect(classifyRestoredRemoteAdoption(initial, true, Date.parse(now))).toBe("keep");
    expect(classifyRestoredRemoteAdoption(canonicalizing, false, Date.parse(now))).toBe("fail");
    expect(classifyRestoredRemoteAdoption(canonicalizing, true, Date.parse(now))).toBe("keep");
    expect(
      classifyRestoredRemoteAdoption(canonicalizing, true, Date.parse("2026-07-24T00:00:31.000Z")),
    ).toBe("keep");
    expect(
      classifyRestoredRemoteAdoption(
        { ...canonicalizing, canonicalizationExpiresAt: "2099-01-01T00:00:00.000Z" },
        true,
        Date.parse(now),
      ),
    ).toBe("keep");
    expect(
      classifyRestoredRemoteAdoption(
        { ...initial, remoteAdoptionStage: "locked" as const },
        false,
        Date.parse(now),
      ),
    ).toBe("fail");
  });

  it("cleans uncertain dispatches instead of leaving zombie concurrency slots", () => {
    expect(classifyRecoveredRun("active", true, "partial")).toBe("active");
    expect(classifyRecoveredRun("active", false, "final answer")).toBe("complete");
    expect(classifyRecoveredRun("dispatching", false, "old answer")).toBe("fail");
    expect(classifyRecoveredRun("active", false, "")).toBe("fail");
  });

  it("restores only validated terminal events bound to an instance and tab", () => {
    const pending = parseStoredPendingEvents([
      {
        instanceId: "instance-1",
        tabId: 7,
        event: {
          type: "content.event",
          eventType: "complete",
          conversationId: "conversation-1",
          runId: "run-1",
          markdown: "done",
          remoteUrl: "https://chatgpt.com/c/abc",
          title: "Event loop guide",
        },
      },
      {
        instanceId: "instance-1",
        tabId: 8,
        event: {
          type: "content.event",
          eventType: "complete",
          conversationId: "conversation-2",
          runId: "run-2",
          markdown: "done",
          remoteUrl: "https://evil.test/",
        },
      },
    ]);

    expect(pending.size).toBe(1);
    expect([...pending.values()][0]?.event.title).toBe("Event loop guide");
  });

  it("compacts disconnected streaming snapshots to the latest event per run", () => {
    const snapshots = Array.from({ length: 128 }, (_, index) => ({
      eventId: `snapshot-${index}`,
      instanceId: "instance-1",
      tabId: 7,
      startedAt: now,
      event: {
        type: "content.event",
        eventType: "snapshot",
        conversationId: "conversation-1",
        runId: "run-1",
        markdown: `partial-${index}`,
        remoteUrl: "https://chatgpt.com/c/abc",
      },
    }));

    const pending = parseStoredPendingEvents(snapshots);

    expect(pending.size).toBe(1);
    expect([...pending.values()][0]?.event.markdown).toBe("partial-127");
  });
});
