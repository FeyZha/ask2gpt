import { createCipheriv, randomBytes } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Conversation } from "@ask2gpt/protocol";
import { describe, expect, it, onTestFinished } from "vitest";

import {
  acquireConversationNamespaceLease,
  ConversationStore,
  type ConversationNamespaceLease,
} from "./conversation-store";
import { relayInstanceIdForSlot } from "./runtime-identity";

const KEY_NAME = "ask2gpt.conversationEncryptionKey.v1";
const FIRST_ID = "a3b8ea8b-2b99-4ae3-acd1-5065324d4684";
const SECOND_ID = "90a66c98-2117-4815-a5c2-a3249e9fbf8d";

class MemorySecrets {
  private readonly values = new Map<string, string>();
  readonly storeCalls: string[] = [];

  constructor(
    initial?: Record<string, string>,
    private readonly delayMs = 0,
  ) {
    for (const [key, value] of Object.entries(initial ?? {})) {
      this.values.set(key, value);
    }
  }

  async get(key: string) {
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.values.get(key);
  }

  async store(key: string, value: string) {
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.storeCalls.push(key);
    this.values.set(key, value);
  }

  value(key: string) {
    return this.values.get(key);
  }
}

function conversation(title: string, id = FIRST_ID): Conversation {
  return {
    id,
    title,
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    messages: [
      {
        id: "message-1",
        role: "user",
        markdown: "private source text",
        status: "complete",
        createdAt: "2026-07-23T00:00:00.000Z",
      },
    ],
  };
}

describe("ConversationStore", () => {
  it("leases the legacy root to one window and isolates concurrent windows in stable slots", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "qa-store-lease-"));
    const stableRoot = path.join(temporaryRoot, "instances", "workspace-id");
    const leases: ConversationNamespaceLease[] = [];
    try {
      const primary = await acquireConversationNamespaceLease(stableRoot);
      const secondary = await acquireConversationNamespaceLease(stableRoot);
      leases.push(primary, secondary);

      expect(primary).toMatchObject({
        storagePath: path.resolve(stableRoot),
        stateKeySuffix: "",
        slotIndex: 0,
      });
      expect(secondary.storagePath).toBe(
        path.join(path.resolve(stableRoot), "window-instances", "slot-1"),
      );
      expect(secondary.stateKeySuffix).toBe(".window-1");
      expect(secondary.slotIndex).toBe(1);
      expect(secondary.storagePath).not.toBe(primary.storagePath);

      const secondaryRoute = relayInstanceIdForSlot("workspace-id", secondary.slotIndex);
      await secondary.release();
      const replacement = await acquireConversationNamespaceLease(stableRoot);
      leases.push(replacement);
      expect(replacement.storagePath).toBe(secondary.storagePath);
      expect(replacement.stateKeySuffix).toBe(secondary.stateKeySuffix);
      expect(relayInstanceIdForSlot("workspace-id", replacement.slotIndex)).toBe(secondaryRoute);
    } finally {
      await Promise.allSettled(leases.map(async (lease) => lease.release()));
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("never returns the same slot to concurrent stale-lock reclaimers", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "qa-store-stale-lease-"));
    try {
      for (let round = 0; round < 24; round += 1) {
        const stableRoot = path.join(temporaryRoot, `round-${round}`);
        const leaseDirectory = path.join(stableRoot, ".window-leases");
        const staleLock = path.join(leaseDirectory, "0.lock");
        await mkdir(leaseDirectory, { recursive: true });
        await writeFile(staleLock, "{incomplete", "utf8");
        await utimes(staleLock, new Date(0), new Date(0));

        const roundLeases = await Promise.all(
          Array.from({ length: 6 }, async () => acquireConversationNamespaceLease(stableRoot)),
        );
        try {
          expect(roundLeases.map((lease) => lease.slotIndex).sort((a, b) => a - b)).toEqual([
            0, 1, 2, 3, 4, 5,
          ]);
          expect(
            (await readdir(leaseDirectory)).filter((entry) =>
              entry.startsWith("0.lock.reclaimed-"),
            ),
          ).toHaveLength(0);
        } finally {
          await Promise.all(roundLeases.map(async (lease) => lease.release()));
        }

        const replacement = await acquireConversationNamespaceLease(stableRoot);
        expect(replacement.slotIndex).toBe(0);
        await replacement.release();
      }
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("encrypts v2 records, binds them to their id, and can read them back", async () => {
    const root = await temporaryRoot();
    const secrets = new MemorySecrets();
    const store = new ConversationStore(root, secrets);
    await store.save(conversation("Encrypted"));

    const recordPath = primaryPath(root, FIRST_ID);
    const raw = await readFile(recordPath, "utf8");
    expect(raw).not.toContain("private source text");
    expect(JSON.parse(raw)).toMatchObject({ version: 2 });
    expect((await store.loadAll())[0]?.title).toBe("Encrypted");

    await copyFile(recordPath, primaryPath(root, SECOND_ID));
    await rm(recordPath);
    expect(await store.loadAll()).toEqual([]);
    expect(store.getLoadReport().unreadable).toBe(1);
  });

  it("preserves visible conversation synchronization metadata", async () => {
    const root = await temporaryRoot();
    const secrets = new MemorySecrets();
    const store = new ConversationStore(root, secrets);
    const value = conversation("Synced title");
    value.syncStatus = "synced";
    value.titleSource = "chatgpt";
    value.lastSyncedAt = "2026-07-23T01:02:03.000Z";
    value.selectedModelId = "mode-very-high";
    value.archivedAt = "2026-07-23T02:03:04.000Z";

    await store.save(value);

    expect((await store.loadAll())[0]).toMatchObject({
      syncStatus: "synced",
      titleSource: "chatgpt",
      lastSyncedAt: "2026-07-23T01:02:03.000Z",
      selectedModelId: "mode-very-high",
      archivedAt: "2026-07-23T02:03:04.000Z",
    });
  });

  it("round-trips the packaged context transport receipt without exposing source text", async () => {
    const root = await temporaryRoot();
    const store = new ConversationStore(root, new MemorySecrets());
    const value = conversation("Packaged context");
    value.messages[0]!.contexts = [
      {
        id: "context-packaged",
        kind: "selection",
        fileName: "worker.ts",
        uri: "file:///workspace/worker.ts",
        language: "typescript",
        startLine: 3,
        endLine: 5,
        content: "export const packaged = true;",
        charCount: 29,
        unsaved: true,
      },
    ];
    value.messages[0]!.contextTransportVersion = 2;

    await store.save(value);

    expect(await readFile(primaryPath(root, FIRST_ID), "utf8")).not.toContain(
      "export const packaged",
    );
    expect((await store.loadAll())[0]?.messages[0]).toMatchObject({
      contextTransportVersion: 2,
      contexts: [expect.objectContaining({ id: "context-packaged" })],
    });
  });

  it("round-trips a paused follow-up queue inside the encrypted conversation record", async () => {
    const root = await temporaryRoot();
    const secrets = new MemorySecrets();
    const store = new ConversationStore(root, secrets);
    const value = conversation("Queued work");
    value.messages[0]!.clientRequestId = "request-queue-1";
    value.messages.push({
      id: "assistant-queue-1",
      role: "assistant",
      markdown: "partial answer",
      status: "streaming",
      createdAt: "2026-07-23T02:59:59.000Z",
    });
    value.run = {
      id: "run-queue-1",
      messageId: "assistant-queue-1",
      status: "stopping",
      startedAt: "2026-07-23T02:59:59.000Z",
      resumeQueueAfterStop: true,
    };
    value.queuePaused = true;
    value.queuedFollowUps = [
      {
        id: "queue-1",
        text: "Run the focused tests",
        contexts: [
          {
            id: "context-1",
            kind: "selection",
            fileName: "worker.ts",
            uri: "file:///workspace/worker.ts",
            language: "typescript",
            startLine: 3,
            endLine: 5,
            content: "export const queued = true;",
            charCount: 27,
            unsaved: true,
          },
        ],
        automaticContextIds: ["context-1"],
        selectedModelId: "mode-high",
        createdAt: "2026-07-23T03:00:00.000Z",
      },
    ];

    await store.save(value);

    const raw = await readFile(primaryPath(root, FIRST_ID), "utf8");
    expect(raw).not.toContain("Run the focused tests");
    expect(raw).not.toContain("export const queued");
    expect((await store.loadAll())[0]).toMatchObject({
      queuePaused: true,
      run: {
        id: "run-queue-1",
        messageId: "assistant-queue-1",
        status: "stopping",
        resumeQueueAfterStop: true,
      },
      messages: [
        { id: "message-1", clientRequestId: "request-queue-1" },
        { id: "assistant-queue-1" },
      ],
      queuedFollowUps: [
        {
          id: "queue-1",
          text: "Run the focused tests",
          automaticContextIds: ["context-1"],
          selectedModelId: "mode-high",
          contexts: [expect.objectContaining({ id: "context-1", unsaved: true })],
        },
      ],
    });
  });

  it("restores mapped active runs as canonicalizing and removes legacy timers", async () => {
    const root = await temporaryRoot();
    const store = new ConversationStore(root, new MemorySecrets());
    const cases = [
      {
        id: FIRST_ID,
        stage: "initial" as const,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        id: SECOND_ID,
        stage: "canonicalizing" as const,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
      {
        id: "09fc0b69-ac30-4677-8566-cdf8df9979d4",
        stage: "canonicalizing" as const,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
    ];

    for (const item of cases) {
      const value = conversation("Restored active run", item.id);
      value.remoteUrl = `https://chatgpt.com/c/${item.id}`;
      const messageId = `assistant-${item.id}`;
      value.messages.push({
        id: messageId,
        role: "assistant",
        markdown: "partial",
        status: "streaming",
        createdAt: value.createdAt,
      });
      value.run = {
        id: `run-${item.id}`,
        messageId,
        status: "streaming",
        startedAt: value.createdAt,
        remoteAdoptionStage: item.stage,
        ...(item.expiresAt ? { canonicalizationExpiresAt: item.expiresAt } : {}),
      };
      await store.save(value);
    }

    const loaded = await store.loadAll();
    for (const item of cases) {
      expect(loaded.find((value) => value.id === item.id)?.run?.remoteAdoptionStage).toBe(
        "canonicalizing",
      );
      expect(
        loaded.find((value) => value.id === item.id)?.run?.canonicalizationExpiresAt,
      ).toBeUndefined();
    }
  });

  it("locks a canonicalizing restored run that has no mapped remote URL", async () => {
    const root = await temporaryRoot();
    const store = new ConversationStore(root, new MemorySecrets());
    const value = conversation("Missing remote URL");
    value.messages.push({
      id: "assistant-missing-remote",
      role: "assistant",
      markdown: "partial",
      status: "streaming",
      createdAt: value.createdAt,
    });
    value.run = {
      id: "run-missing-remote",
      messageId: "assistant-missing-remote",
      status: "streaming",
      startedAt: value.createdAt,
      remoteAdoptionStage: "canonicalizing",
      canonicalizationExpiresAt: new Date(Date.now() + 20_000).toISOString(),
    };

    await store.save(value);

    expect((await store.loadAll())[0]?.run).toMatchObject({
      remoteAdoptionStage: "locked",
    });
    expect((await store.loadAll())[0]?.run?.canonicalizationExpiresAt).toBeUndefined();
  });

  it("drops legacy post-completion URL promotion grants on load", async () => {
    const root = await temporaryRoot();
    const store = new ConversationStore(root, new MemorySecrets());
    const value = conversation("Legacy pending promotion");
    value.remoteUrl = "https://chatgpt.com/c/provisional-a";
    value.messages.push({
      id: "completed-assistant",
      role: "assistant",
      markdown: "OK",
      status: "complete",
      createdAt: value.createdAt,
    });
    value.pendingRemotePromotion = {
      runId: "completed-run",
      messageId: "completed-assistant",
      fromRemoteUrl: "https://chatgpt.com/c/provisional-a",
      terminalMarkdownSha256: "a".repeat(64),
      terminalTranscriptSha256: "b".repeat(64),
      terminalStatus: "complete",
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
    };

    await store.save(value);

    const loaded = await store.loadAll();
    expect(loaded[0]?.remoteUrl).toBe("https://chatgpt.com/c/provisional-a");
    expect(loaded[0]?.pendingRemotePromotion).toBeUndefined();
  });

  it("persists a terminal delivery receipt with the completed answer", async () => {
    const root = await temporaryRoot();
    const store = new ConversationStore(root, new MemorySecrets());
    const value = conversation("Durable terminal receipt");
    value.messages.push({
      id: "completed-with-receipt",
      role: "assistant",
      markdown: "Done",
      status: "complete",
      createdAt: value.createdAt,
      terminalReceipt: {
        eventId: "terminal-event-a",
        runId: "run-a",
        terminalType: "complete",
      },
    });

    await store.save(value);

    expect((await store.loadAll())[0]?.messages.at(-1)?.terminalReceipt).toEqual({
      eventId: "terminal-event-a",
      runId: "run-a",
      terminalType: "complete",
    });
  });

  it("round-trips a structured run error without polluting the answer markdown", async () => {
    const root = await temporaryRoot();
    const store = new ConversationStore(root, new MemorySecrets());
    const value = conversation("Structured run error");
    value.messages.push({
      id: "assistant-structured-error",
      role: "assistant",
      markdown: "partial answer",
      status: "error",
      createdAt: value.createdAt,
      runError: {
        code: "CHATGPT_REMOTE_UNAVAILABLE",
        message: "ChatGPT conversation temporarily unavailable.",
        recoverable: true,
        focusTab: true,
      },
      terminalReceipt: {
        eventId: "terminal-structured-error",
        runId: "run-structured-error",
        terminalType: "error",
      },
    });

    await store.save(value);

    expect((await store.loadAll())[0]?.messages.at(-1)).toMatchObject({
      markdown: "partial answer",
      status: "error",
      runError: {
        code: "CHATGPT_REMOTE_UNAVAILABLE",
        message: "ChatGPT conversation temporarily unavailable.",
        recoverable: true,
        focusTab: true,
      },
    });
  });

  it("drops malformed or out-of-state structured run errors", async () => {
    const root = await temporaryRoot();
    const store = new ConversationStore(root, new MemorySecrets());
    const value = conversation("Invalid run errors");
    Object.assign(value.messages[0]!, {
      runError: {
        code: "SELECTOR_INCOMPATIBLE",
        message: "must not attach to a user message",
        recoverable: true,
      },
    });
    value.messages.push({
      id: "assistant-invalid-error",
      role: "assistant",
      markdown: "completed answer",
      status: "complete",
      createdAt: value.createdAt,
      runError: {
        code: "SELECTOR_INCOMPATIBLE",
        message: "must not attach to a complete message",
        recoverable: true,
      },
    });
    Object.assign(value.messages.at(-1)!, {
      status: "error",
      runError: {
        code: "NOT_A_RELAY_ERROR",
        message: "invalid code",
        recoverable: true,
      },
    });

    await store.save(value);

    const messages = (await store.loadAll())[0]!.messages;
    expect(messages[0]?.runError).toBeUndefined();
    expect(messages[1]).toMatchObject({ markdown: "completed answer", status: "error" });
    expect(messages[1]?.runError).toBeUndefined();
  });

  it("keeps the acknowledged terminal checkpoint in the recovery copy", async () => {
    const root = await temporaryRoot();
    const store = new ConversationStore(root, new MemorySecrets());
    const value = conversation("Terminal recovery checkpoint");
    value.messages.push({
      id: "assistant-terminal-recovery",
      role: "assistant",
      markdown: "partial",
      status: "streaming",
      createdAt: value.createdAt,
    });
    value.run = {
      id: "run-terminal-recovery",
      messageId: "assistant-terminal-recovery",
      status: "streaming",
      startedAt: value.createdAt,
      remoteAdoptionStage: "canonicalizing",
    };
    await store.save(value);

    value.messages.at(-1)!.markdown = "complete";
    value.messages.at(-1)!.status = "complete";
    value.messages.at(-1)!.terminalReceipt = {
      eventId: "terminal-event-recovery",
      runId: "run-terminal-recovery",
      terminalType: "complete",
    };
    value.run = undefined;
    await store.save(value);

    await writeFile(primaryPath(root, FIRST_ID), "corrupt", "utf8");
    const recovered = (await store.loadAll())[0];
    expect(recovered?.run).toBeUndefined();
    expect(recovered?.messages.at(-1)).toMatchObject({
      markdown: "complete",
      status: "complete",
      terminalReceipt: {
        eventId: "terminal-event-recovery",
        runId: "run-terminal-recovery",
        terminalType: "complete",
      },
    });
    expect(store.getLoadReport().recoveredFromBackup).toBe(1);
  });

  it("restores and repairs the latest valid backup when the primary is corrupted", async () => {
    const root = await temporaryRoot();
    const secrets = new MemorySecrets();
    const store = new ConversationStore(root, secrets);
    await store.save(conversation("First"));
    await store.save(conversation("Second"));

    const recordPath = primaryPath(root, FIRST_ID);
    await writeFile(recordPath, "corrupt", "utf8");
    expect((await store.loadAll())[0]?.title).toBe("First");
    expect(store.getLoadReport()).toMatchObject({
      recoveredFromBackup: 1,
      repairFailures: 0,
    });

    await rm(backupPath(root, FIRST_ID));
    const reopened = new ConversationStore(root, secrets);
    expect((await reopened.loadAll())[0]?.title).toBe("First");
  });

  it("recovers an orphan backup when the primary record is missing", async () => {
    const root = await temporaryRoot();
    const secrets = new MemorySecrets();
    const store = new ConversationStore(root, secrets);
    await store.save(conversation("Only backup"));
    await copyFile(primaryPath(root, FIRST_ID), backupPath(root, FIRST_ID));
    await rm(primaryPath(root, FIRST_ID));

    expect((await store.loadAll())[0]?.title).toBe("Only backup");
    expect(store.getLoadReport().recoveredFromBackup).toBe(1);
  });

  it("takes a deterministic snapshot for every queued save", async () => {
    const root = await temporaryRoot();
    const store = new ConversationStore(root, new MemorySecrets());
    const value = conversation("First");

    const firstSave = store.save(value);
    value.title = "Second";
    const secondSave = store.save(value);
    await Promise.all([firstSave, secondSave]);

    expect((await store.loadAll())[0]?.title).toBe("Second");
    await writeFile(primaryPath(root, FIRST_ID), "corrupt", "utf8");
    expect((await store.loadAll())[0]?.title).toBe("First");
  });

  it("serializes deletion behind pending writes", async () => {
    const root = await temporaryRoot();
    const store = new ConversationStore(root, new MemorySecrets(undefined, 5));
    const save = store.save(conversation("Pending"));
    const deletion = store.delete(FIRST_ID);
    await Promise.all([save, deletion]);

    expect(await store.loadAll()).toEqual([]);
  });

  it("fails closed instead of silently dropping an invalid attachment bundle", async () => {
    const root = await temporaryRoot();
    const store = new ConversationStore(root, new MemorySecrets());
    const value = conversation("Invalid context");
    Object.assign(value.messages[0]!, {
      contexts: [
        {
          id: "../unsafe",
          kind: "file",
          fileName: "source.ts",
          uri: "file:///source.ts",
          language: "typescript",
          startLine: 1,
          endLine: 1,
          content: "export {};",
          charCount: 10,
          unsaved: false,
        },
      ],
    });

    await expect(store.save(value)).rejects.toThrow("Invalid conversation context snapshot");
    expect(await store.loadAll()).toEqual([]);
  });

  it("uses a single generated encryption key across concurrent first writes", async () => {
    const root = await temporaryRoot();
    const secrets = new MemorySecrets(undefined, 5);
    const store = new ConversationStore(root, secrets);
    await Promise.all([
      store.save(conversation("One", FIRST_ID)),
      store.save(conversation("Two", SECOND_ID)),
    ]);

    expect(secrets.storeCalls.filter((key) => key === KEY_NAME)).toHaveLength(1);
    expect((await store.loadAll()).map((item) => item.title).sort()).toEqual(["One", "Two"]);
  });

  it("serializes first key generation across independent Extension Hosts", async () => {
    const root = await temporaryRoot();
    const coordinationRoot = path.join(root, "extension-global-storage");
    const firstStorage = path.join(root, "window-a");
    const secondStorage = path.join(root, "window-b");
    const secrets = new MemorySecrets(undefined, 10);
    const first = new ConversationStore(firstStorage, secrets, coordinationRoot);
    const second = new ConversationStore(secondStorage, secrets, coordinationRoot);

    await Promise.all([
      first.save(conversation("Window A", FIRST_ID)),
      second.save(conversation("Window B", SECOND_ID)),
    ]);

    expect(secrets.storeCalls.filter((key) => key === KEY_NAME)).toHaveLength(1);
    const reopenedFirst = new ConversationStore(firstStorage, secrets, coordinationRoot);
    const reopenedSecond = new ConversationStore(secondStorage, secrets, coordinationRoot);
    expect((await reopenedFirst.loadAll())[0]?.title).toBe("Window A");
    expect((await reopenedSecond.loadAll())[0]?.title).toBe("Window B");
    await expect(
      readFile(path.join(coordinationRoot, ".conversation-key-initialization.lock"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims an abandoned key-initialization lock without storing key material on disk", async () => {
    const root = await temporaryRoot();
    const coordinationRoot = path.join(root, "extension-global-storage");
    const lockPath = path.join(coordinationRoot, ".conversation-key-initialization.lock");
    await mkdir(coordinationRoot, { recursive: true });
    await writeFile(lockPath, "{incomplete", "utf8");
    await utimes(lockPath, new Date(0), new Date(0));

    const secrets = new MemorySecrets();
    const store = new ConversationStore(path.join(root, "window-a"), secrets, coordinationRoot);
    await store.save(conversation("Recovered initializer"));

    expect(secrets.storeCalls.filter((key) => key === KEY_NAME)).toHaveLength(1);
    expect((await store.loadAll())[0]?.title).toBe("Recovered initializer");
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates an authenticated v1 record to the id-bound v2 format", async () => {
    const root = await temporaryRoot();
    const encodedKey = randomBytes(32).toString("base64");
    const secrets = new MemorySecrets({ [KEY_NAME]: encodedKey });
    await mkdir(path.join(root, "conversations-v1"), { recursive: true });
    await writeLegacyRecord(primaryPath(root, FIRST_ID), conversation("Legacy"), encodedKey);

    const store = new ConversationStore(root, secrets);
    expect((await store.loadAll())[0]?.title).toBe("Legacy");
    expect(store.getLoadReport().migrated).toBe(1);
    expect(JSON.parse(await readFile(primaryPath(root, FIRST_ID), "utf8"))).toMatchObject({
      version: 2,
    });
  });

  it("migrates a legacy message.context snapshot to a stable singleton contexts bundle", async () => {
    const root = await temporaryRoot();
    const encodedKey = randomBytes(32).toString("base64");
    const secrets = new MemorySecrets({ [KEY_NAME]: encodedKey });
    await mkdir(path.join(root, "conversations-v1"), { recursive: true });
    const legacy = conversation("Legacy context");
    Object.assign(legacy.messages[0] as unknown as Record<string, unknown>, {
      context: {
        kind: "selection",
        fileName: "legacy.ts",
        uri: "file:///legacy.ts",
        language: "typescript",
        startLine: 2,
        endLine: 3,
        content: "const legacy = true;",
        charCount: 20,
        unsaved: false,
      },
    });
    await writeLegacyRecord(primaryPath(root, FIRST_ID), legacy, encodedKey);

    const store = new ConversationStore(root, secrets);
    const loaded = (await store.loadAll())[0]!;
    expect(loaded.messages[0]?.contexts).toHaveLength(1);
    expect(loaded.messages[0]?.contexts?.[0]).toMatchObject({
      kind: "selection",
      fileName: "legacy.ts",
    });
    expect(loaded.messages[0]?.contexts?.[0]?.id).toMatch(/^legacy-[a-f0-9]{32}$/);

    const reopened = new ConversationStore(root, secrets);
    expect((await reopened.loadAll())[0]?.messages[0]?.contexts?.[0]?.id).toBe(
      loaded.messages[0]?.contexts?.[0]?.id,
    );
  });

  it("rewrites the legacy context shape even when it is already in an encrypted v2 record", async () => {
    const root = await temporaryRoot();
    const encodedKey = randomBytes(32).toString("base64");
    const secrets = new MemorySecrets({ [KEY_NAME]: encodedKey });
    await mkdir(path.join(root, "conversations-v1"), { recursive: true });
    const legacy = conversation("Legacy v2 context");
    Object.assign(legacy.messages[0] as unknown as Record<string, unknown>, {
      context: {
        kind: "current-file",
        fileName: "legacy-v2.ts",
        uri: "file:///legacy-v2.ts",
        language: "typescript",
        startLine: 1,
        endLine: 1,
        content: "export {};",
        charCount: 10,
        unsaved: false,
      },
    });
    await writeV2Record(primaryPath(root, FIRST_ID), legacy, encodedKey);

    const store = new ConversationStore(root, secrets);
    expect((await store.loadAll())[0]?.messages[0]?.contexts?.[0]?.fileName).toBe("legacy-v2.ts");
    expect(store.getLoadReport().migrated).toBe(1);

    const reopened = new ConversationStore(root, secrets);
    await reopened.loadAll();
    expect(reopened.getLoadReport().migrated).toBe(0);
  });

  it("migrates only exact legacy run-error footers into structured metadata", async () => {
    const root = await temporaryRoot();
    const encodedKey = randomBytes(32).toString("base64");
    const secrets = new MemorySecrets({ [KEY_NAME]: encodedKey });
    await mkdir(path.join(root, "conversations-v1"), { recursive: true });
    const guidance =
      "请在 Chrome 中确认该 ChatGPT 会话可以正常打开；处理页面提示后，再重新发送问题。";
    const notice = [
      "> Ask2GPT：ChatGPT 页面\\*暂时\\*不可用。",
      ">",
      `> ${guidance}`,
      ">",
      "> 错误代码：`CHATGPT_REMOTE_UNAVAILABLE`",
    ].join("\n");

    const partial = conversation("Legacy partial error", FIRST_ID);
    partial.messages.push({
      id: "assistant-legacy-partial",
      role: "assistant",
      markdown: `trusted partial answer\n\n---\n\n${notice}`,
      status: "error",
      createdAt: partial.createdAt,
      terminalReceipt: {
        eventId: "terminal-legacy-partial",
        runId: "run-legacy-partial",
        terminalType: "error",
      },
    });

    const empty = conversation("Legacy empty error", SECOND_ID);
    empty.messages.push({
      id: "assistant-legacy-empty",
      role: "assistant",
      markdown: notice,
      status: "error",
      createdAt: empty.createdAt,
      terminalReceipt: {
        eventId: "terminal-legacy-empty",
        runId: "run-legacy-empty",
        terminalType: "error",
      },
    });

    const similarId = "legacy-similar-run-error";
    const similar = conversation("Similar user-authored footer", similarId);
    similar.messages.push({
      id: "assistant-similar-footer",
      role: "assistant",
      markdown: `keep this verbatim\n\n---\n\n${notice}`,
      status: "error",
      createdAt: similar.createdAt,
      // No error terminal receipt: this may be user-authored Markdown and must
      // never be destructively interpreted as a former controller footer.
    });

    await Promise.all([
      writeV2Record(primaryPath(root, partial.id), partial, encodedKey),
      writeV2Record(primaryPath(root, empty.id), empty, encodedKey),
      writeV2Record(primaryPath(root, similar.id), similar, encodedKey),
    ]);

    const store = new ConversationStore(root, secrets);
    const loaded = await store.loadAll();
    expect(loaded.find((item) => item.id === partial.id)?.messages.at(-1)).toMatchObject({
      markdown: "trusted partial answer",
      runError: {
        code: "CHATGPT_REMOTE_UNAVAILABLE",
        message: "ChatGPT 页面*暂时*不可用。",
        recoverable: true,
      },
    });
    expect(loaded.find((item) => item.id === empty.id)?.messages.at(-1)).toMatchObject({
      markdown: "",
      runError: {
        code: "CHATGPT_REMOTE_UNAVAILABLE",
        recoverable: true,
      },
    });
    expect(loaded.find((item) => item.id === similar.id)?.messages.at(-1)).toMatchObject({
      markdown: `keep this verbatim\n\n---\n\n${notice}`,
    });
    expect(
      loaded.find((item) => item.id === similar.id)?.messages.at(-1)?.runError,
    ).toBeUndefined();
    expect(store.getLoadReport().migrated).toBe(2);

    const reopened = new ConversationStore(root, secrets);
    await reopened.loadAll();
    expect(reopened.getLoadReport().migrated).toBe(0);
  });

  it("migrates generic ChatGPT titles without losing the conversation", async () => {
    const root = await temporaryRoot();
    const encodedKey = randomBytes(32).toString("base64");
    const secrets = new MemorySecrets({ [KEY_NAME]: encodedKey });
    await mkdir(path.join(root, "conversations-v1"), { recursive: true });

    const firstUserLine =
      "第一条用户问题应成为回退标题并且最多只保留三十六个字符，后面的内容不应出现";
    const polluted = conversation("跳至内容", FIRST_ID);
    polluted.titleSource = "chatgpt";
    polluted.remoteUrl = "https://chatgpt.com/c/polluted-title";
    polluted.messages[0]!.markdown = `  ${firstUserLine}\n第二行不能成为标题`;
    polluted.messages.push({
      id: "message-2",
      role: "assistant",
      markdown: "原有回答必须保留",
      status: "complete",
      createdAt: "2026-07-23T00:01:00.000Z",
    });

    const noUserMessage = conversation("Skip to content", SECOND_ID);
    noUserMessage.titleSource = "chatgpt";
    noUserMessage.messages = [
      {
        id: "assistant-only",
        role: "assistant",
        markdown: "Assistant-only legacy record",
        status: "complete",
        createdAt: "2026-07-23T00:00:00.000Z",
      },
    ];

    const untaggedNavigationTitle = conversation(
      "Jump to content",
      "legacy-untagged-navigation-title",
    );

    const localTitle = conversation("跳至内容", "local-generic-title");
    localTitle.titleSource = "local";

    await Promise.all([
      writeV2Record(primaryPath(root, polluted.id), polluted, encodedKey),
      writeV2Record(primaryPath(root, noUserMessage.id), noUserMessage, encodedKey),
      writeV2Record(
        primaryPath(root, untaggedNavigationTitle.id),
        untaggedNavigationTitle,
        encodedKey,
      ),
      writeV2Record(primaryPath(root, localTitle.id), localTitle, encodedKey),
    ]);

    const store = new ConversationStore(root, secrets);
    const loaded = await store.loadAll();
    expect(loaded.find((item) => item.id === polluted.id)).toMatchObject({
      title: firstUserLine.slice(0, 36),
      remoteUrl: polluted.remoteUrl,
      messages: [
        { role: "user", markdown: `  ${firstUserLine}\n第二行不能成为标题` },
        { role: "assistant", markdown: "原有回答必须保留" },
      ],
    });
    expect(loaded.find((item) => item.id === polluted.id)?.titleSource).toBeUndefined();
    expect(loaded.find((item) => item.id === noUserMessage.id)).toMatchObject({
      title: "New conversation",
      messages: [{ role: "assistant", markdown: "Assistant-only legacy record" }],
    });
    expect(loaded.find((item) => item.id === noUserMessage.id)?.titleSource).toBeUndefined();
    expect(loaded.find((item) => item.id === untaggedNavigationTitle.id)).toMatchObject({
      title: "private source text",
      messages: [{ role: "user", markdown: "private source text" }],
    });
    expect(
      loaded.find((item) => item.id === untaggedNavigationTitle.id)?.titleSource,
    ).toBeUndefined();
    expect(loaded.find((item) => item.id === localTitle.id)).toMatchObject({
      title: "跳至内容",
      titleSource: "local",
    });
    expect(store.getLoadReport().migrated).toBe(3);

    const reopened = new ConversationStore(root, secrets);
    const reloaded = await reopened.loadAll();
    expect(reloaded.find((item) => item.id === polluted.id)?.title).toBe(
      firstUserLine.slice(0, 36),
    );
    expect(reloaded.find((item) => item.id === polluted.id)?.titleSource).toBeUndefined();
    expect(reloaded.find((item) => item.id === untaggedNavigationTitle.id)?.title).toBe(
      "private source text",
    );
    expect(reopened.getLoadReport().migrated).toBe(0);
  });

  it("normalizes a ChatGPT conversation URL and rejects credentials or explicit ports", async () => {
    const root = await temporaryRoot();
    const store = new ConversationStore(root, new MemorySecrets());
    const safe = conversation("Safe URL", FIRST_ID);
    safe.remoteUrl = "https://chatgpt.com/c/conversation-id?token=private#message";
    const unsafe = conversation("Unsafe URL", SECOND_ID);
    unsafe.remoteUrl = "https://user:password@chatgpt.com/c/conversation-id";
    const port = conversation("Port URL", "d04d18bc-c474-4cf3-8329-b7c50664aa86");
    port.remoteUrl = "https://chatgpt.com:444/c/conversation-id";
    const project = conversation("Project URL", "5c2cbb3d-c779-46fd-a379-cfbb3d869c04");
    project.remoteUrl =
      "https://chatgpt.com/g/ask2gpt-project/c/conversation-id?private=value#message";

    await Promise.all([
      store.save(safe),
      store.save(unsafe),
      store.save(port),
      store.save(project),
    ]);
    const loaded = await store.loadAll();
    expect(loaded.find((item) => item.id === FIRST_ID)?.remoteUrl).toBe(
      "https://chatgpt.com/c/conversation-id",
    );
    expect(loaded.find((item) => item.id === SECOND_ID)?.remoteUrl).toBeUndefined();
    expect(loaded.find((item) => item.id === port.id)?.remoteUrl).toBeUndefined();
    expect(loaded.find((item) => item.id === project.id)?.remoteUrl).toBe(
      "https://chatgpt.com/g/ask2gpt-project/c/conversation-id",
    );
  });
});

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ask2gpt-store-"));
  onTestFinished(async () => {
    await rm(root, { force: true, recursive: true });
  });
  return root;
}

function primaryPath(root: string, id: string) {
  return path.join(root, "conversations-v1", `${id}.qac`);
}

function backupPath(root: string, id: string) {
  return path.join(root, "conversations-v1", `${id}.bak`);
}

async function writeLegacyRecord(filePath: string, value: Conversation, encodedKey: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(encodedKey, "base64"), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  await writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    }),
    "utf8",
  );
}

async function writeV2Record(filePath: string, value: Conversation, encodedKey: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(encodedKey, "base64"), iv);
  cipher.setAAD(Buffer.from(`ask2gpt:conversation:${value.id}:v2`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  await writeFile(
    filePath,
    JSON.stringify({
      version: 2,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    }),
    "utf8",
  );
}
