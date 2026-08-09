import {
  copyFile,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import {
  isGenericConversationTitle,
  MAX_RELAY_FRAME_BYTES,
  RELAY_PORTS,
  relayErrorPayloadSchema,
  type ContextSnapshot,
  type Conversation,
  type ConversationMessage,
  type QueuedFollowUp,
  type RelayErrorPayload,
  type RunState,
  type SourceAnchorV1,
} from "@ask2gpt/protocol";

import { normalizeSourceAnchorContent, sourceAnchorSha256 } from "../source-anchor";

const KEY_NAME = "ask2gpt.conversationEncryptionKey.v1";
const KEY_INITIALIZATION_LOCK = ".conversation-key-initialization.lock";
const KEY_INITIALIZATION_TIMEOUT_MS = 15_000;
const KEY_INITIALIZATION_POLL_MS = 25;
const CURRENT_RECORD_VERSION = 2;
const SAFE_ID = /^[a-zA-Z0-9-]{1,128}$/;
const SAFE_RELAY_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_MODEL_SELECTION_ID = /^[A-Za-z0-9._-]{1,64}$/;
const MESSAGE_ROLES = new Set(["user", "assistant", "local-notice"]);
const MESSAGE_STATUSES = new Set(["complete", "streaming", "stopped", "error"]);
const RUN_STATUSES = new Set(["starting", "streaming", "stopping", "error"]);
const SYNC_STATUSES = new Set(["local", "syncing", "synced", "partial", "error"]);
const TITLE_SOURCES = new Set(["local", "chatgpt"]);
const EXPECTED_EMPTY_CONVERSATION_TITLES = new Set([
  "new chat",
  "new conversation",
  "\u65b0\u804a\u5929",
  "\u65b0\u5bf9\u8bdd",
]);
const MAX_STORED_CONTEXT_CHARS = 40_000;
const MAX_STORED_CONTEXTS = 8;
const MAX_STORED_CONTEXT_BUNDLE_CHARS = 60_000;
const MAX_QUEUED_FOLLOW_UPS = 20;
const MAX_QUEUED_FOLLOW_UP_CHARS = 20_000;
const MAX_WINDOW_NAMESPACE_SLOTS = RELAY_PORTS.length;
const INCOMPLETE_LEASE_GRACE_MS = 5_000;
const STALE_LEASE_REMOVE_RETRY_MS = [0, 4, 12, 30] as const;
const LEGACY_RUN_ERROR_NOTICE =
  /(?:^|\n\n---\n\n)> Ask2GPT：([^\n]+)\n>\n> ([^\n]+)\n>\n> 错误代码：`([A-Z][A-Z0-9_]+)`\s*$/u;
const LEGACY_RECOVERABLE_GUIDANCE = new Set([
  "请在 Chrome 中确认该 ChatGPT 会话可以正常打开；处理页面提示后，再重新发送问题。",
  "请在 Chrome 中完成 ChatGPT 登录，然后重新发送问题。",
  "请先在 Chrome 中完成人机验证，然后重新发送问题。",
  "请检查 Chrome 中的 ChatGPT 页面状态后重试。",
]);
const LEGACY_NON_RECOVERABLE_GUIDANCE =
  "请复制诊断信息，并确认 VS Code 插件与 Chrome 伴生扩展版本一致。";

interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
}

interface EncryptedRecord {
  version: 1 | 2;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface LoadedConversation {
  conversation: Conversation;
  recordVersion: 1 | 2;
  source: "primary" | "backup";
  needsSchemaMigration: boolean;
}

interface LeaseRecord {
  pid: number;
  token: string;
}

interface LeaseSnapshot {
  raw: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  size: number;
  record?: LeaseRecord;
}

export interface ConversationStoreLoadReport {
  records: number;
  recoveredFromBackup: number;
  unreadable: number;
  migrated: number;
  repairFailures: number;
  migrationFailures: number;
}

export interface ConversationNamespaceLease {
  storagePath: string;
  stateKeySuffix: string;
  slotIndex: number;
  release(): Promise<void>;
}

/**
 * Gives concurrent Extension Hosts for the same workspace distinct storage
 * roots. Slot zero is the legacy stable directory, preserving existing history
 * for the normal single-window case; additional windows use isolated subfolders.
 */
export async function acquireConversationNamespaceLease(
  stableStoragePath: string,
): Promise<ConversationNamespaceLease> {
  const resolvedRoot = path.resolve(stableStoragePath);
  const leaseDirectory = path.join(resolvedRoot, ".window-leases");
  await mkdir(leaseDirectory, { recursive: true, mode: 0o700 });

  for (let slot = 0; slot < MAX_WINDOW_NAMESPACE_SLOTS; slot += 1) {
    const lockPath = path.join(leaseDirectory, `${slot}.lock`);
    let reclaimed = false;
    while (true) {
      const token = randomBytes(16).toString("hex");
      try {
        await writeFile(
          lockPath,
          JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }),
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        // A concurrent stale-lock reclaimer may have observed the previous
        // owner immediately before this write. Yield once, then confirm that
        // the canonical path still contains our token before returning a
        // usable lease.
        if (reclaimed) await new Promise<void>((resolve) => setImmediate(resolve));
        if (!(await ownsLease(lockPath, token))) {
          await removeOwnedLease(lockPath, token);
          reclaimed = true;
          continue;
        }
        let released = false;
        return {
          storagePath:
            slot === 0 ? resolvedRoot : path.join(resolvedRoot, "window-instances", `slot-${slot}`),
          stateKeySuffix: slot === 0 ? "" : `.window-${slot}`,
          slotIndex: slot,
          release: async () => {
            if (released) return;
            released = true;
            await removeOwnedLease(lockPath, token);
          },
        };
      } catch (error) {
        if (!isFileExistsError(error)) throw error;
        if (await removeStaleLease(lockPath)) {
          reclaimed = true;
          continue;
        }
        break;
      }
    }
  }

  throw new Error("Too many Ask2GPT windows are using this workspace.");
}

export class ConversationStore {
  private readonly directory: string;
  private readonly keyCoordinationRoot: string;
  private key?: Buffer;
  private keyPromise?: Promise<Buffer>;
  private initialization?: Promise<void>;
  private readonly operations = new Map<string, Promise<void>>();
  private lastLoadReport: ConversationStoreLoadReport = emptyLoadReport();

  constructor(
    globalStoragePath: string,
    private readonly secrets: SecretStore,
    keyCoordinationPath = globalStoragePath,
  ) {
    this.directory = path.resolve(globalStoragePath, "conversations-v1");
    this.keyCoordinationRoot = path.resolve(keyCoordinationPath);
  }

  async initialize() {
    if (!this.initialization) {
      this.initialization = (async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await this.getKey();
      })().catch((error: unknown) => {
        this.initialization = undefined;
        throw error;
      });
    }
    await this.initialization;
  }

  getLoadReport(): ConversationStoreLoadReport {
    return { ...this.lastLoadReport };
  }

  async loadAll(): Promise<Conversation[]> {
    await this.initialize();
    const entries = await readdir(this.directory, { withFileTypes: true });
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = /^([a-zA-Z0-9-]{1,128})\.(?:qac|bak)$/.exec(entry.name);
      if (match?.[1]) ids.add(match[1]);
    }

    const report = emptyLoadReport();
    report.records = ids.size;
    const conversations: Conversation[] = [];

    for (const id of ids) {
      const loaded = await this.readConversation(id);
      if (!loaded) {
        report.unreadable += 1;
        continue;
      }

      conversations.push(loaded.conversation);
      if (loaded.source === "backup") {
        report.recoveredFromBackup += 1;
        try {
          await this.restorePrimaryFromBackup(id);
        } catch {
          report.repairFailures += 1;
        }
      }

      if (loaded.recordVersion < CURRENT_RECORD_VERSION || loaded.needsSchemaMigration) {
        try {
          await this.save(loaded.conversation);
          report.migrated += 1;
        } catch {
          report.migrationFailures += 1;
        }
      }
    }

    this.lastLoadReport = report;
    return conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async save(conversation: Conversation): Promise<void> {
    this.assertSafeId(conversation.id);
    const snapshot = normalizeConversation(structuredClone(conversation), conversation.id);
    return this.enqueue(conversation.id, async () => {
      await this.initialize();
      const target = this.recordPath(snapshot.id);
      const temporary = `${target}.${randomBytes(4).toString("hex")}.tmp`;
      const encrypted = await this.encrypt(snapshot);
      const serialized = `${JSON.stringify(encrypted)}\n`;

      await this.backUpValidPrimary(snapshot.id);
      try {
        await writeFile(temporary, serialized, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }

      if (hasTerminalDeliveryReceipt(snapshot)) {
        // Chrome removes a durable terminal event only after this exact
        // receipt-bearing snapshot is acknowledged. Keep the recovery copy at
        // the same checkpoint; otherwise a later primary-file corruption
        // could roll back to a streaming run whose terminal event no longer
        // exists in Chrome's outbox.
        const backup = this.backupPath(snapshot.id);
        const backupTemporary = `${backup}.${randomBytes(4).toString("hex")}.tmp`;
        try {
          await writeFile(backupTemporary, serialized, {
            encoding: "utf8",
            mode: 0o600,
          });
          await rename(backupTemporary, backup);
        } finally {
          await rm(backupTemporary, { force: true }).catch(() => undefined);
        }
      }
    });
  }

  async delete(id: string): Promise<void> {
    this.assertSafeId(id);
    return this.enqueue(id, async () => {
      await this.initialize();
      const entries = await readdir(this.directory);
      const temporaryPrefix = `${id}.`;
      await Promise.all([
        rm(this.recordPath(id), { force: true }),
        rm(this.backupPath(id), { force: true }),
        ...entries
          .filter(
            (entry) =>
              entry.startsWith(temporaryPrefix) &&
              (entry.endsWith(".tmp") || entry.endsWith(".restore")),
          )
          .map(async (entry) => rm(path.join(this.directory, entry), { force: true })),
      ]);
    });
  }

  private enqueue(id: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        if (this.operations.get(id) === next) {
          this.operations.delete(id);
        }
      });
    this.operations.set(id, next);
    return next;
  }

  private async readConversation(id: string): Promise<LoadedConversation | undefined> {
    try {
      const primary = await this.decryptFile(this.recordPath(id), id);
      return { ...primary, source: "primary" };
    } catch {
      try {
        const backup = await this.decryptFile(this.backupPath(id), id);
        return { ...backup, source: "backup" };
      } catch {
        return undefined;
      }
    }
  }

  private async decryptFile(
    filePath: string,
    expectedId: string,
  ): Promise<Omit<LoadedConversation, "source">> {
    const raw = await readFile(filePath, "utf8");
    const record = JSON.parse(raw) as Partial<EncryptedRecord>;
    if (
      (record.version !== 1 && record.version !== CURRENT_RECORD_VERSION) ||
      typeof record.iv !== "string" ||
      typeof record.tag !== "string" ||
      typeof record.ciphertext !== "string"
    ) {
      throw new Error("Invalid encrypted conversation record.");
    }

    const iv = Buffer.from(record.iv, "base64");
    const tag = Buffer.from(record.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) {
      throw new Error("Invalid encrypted conversation parameters.");
    }

    const key = await this.getKey();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    if (record.version === CURRENT_RECORD_VERSION) {
      decipher.setAAD(Buffer.from(recordAad(expectedId), "utf8"));
    }
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as unknown;
    const conversation = normalizeConversation(parsed, expectedId);
    return {
      conversation,
      recordVersion: record.version,
      needsSchemaMigration:
        hasLegacyContextShape(parsed) ||
        hasLegacyGenericRemoteTitle(parsed) ||
        hasMessageRunErrorSchemaMigration(parsed),
    };
  }

  private async encrypt(conversation: Conversation): Promise<EncryptedRecord> {
    const key = await this.getKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(recordAad(conversation.id), "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(conversation), "utf8"),
      cipher.final(),
    ]);

    return {
      version: CURRENT_RECORD_VERSION,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  }

  private async backUpValidPrimary(id: string) {
    const target = this.recordPath(id);
    try {
      await this.decryptFile(target, id);
    } catch (error) {
      if (isNotFound(error) || !hasFileSystemErrorCode(error)) return;
      throw error;
    }

    const backup = this.backupPath(id);
    const temporary = `${backup}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await copyFile(target, temporary);
      await rename(temporary, backup);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async restorePrimaryFromBackup(id: string) {
    const backup = this.backupPath(id);
    const target = this.recordPath(id);
    const temporary = `${target}.${randomBytes(4).toString("hex")}.restore`;
    try {
      await copyFile(backup, temporary);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async getKey() {
    if (this.key) return this.key;
    if (!this.keyPromise) {
      this.keyPromise = this.loadKey().catch((error: unknown) => {
        this.keyPromise = undefined;
        throw error;
      });
    }
    return this.keyPromise;
  }

  private async loadKey() {
    let encoded = await this.secrets.get(KEY_NAME);
    if (!encoded) {
      encoded = await this.initializeKeyAcrossHosts();
    }
    return this.acceptKey(encoded);
  }

  private async initializeKeyAcrossHosts() {
    await mkdir(this.keyCoordinationRoot, { recursive: true, mode: 0o700 });
    const lockPath = path.join(this.keyCoordinationRoot, KEY_INITIALIZATION_LOCK);
    const deadline = Date.now() + KEY_INITIALIZATION_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const existing = await this.secrets.get(KEY_NAME);
      if (existing) return existing;

      const token = randomBytes(16).toString("hex");
      try {
        await writeFile(
          lockPath,
          JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }),
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        if (!isFileExistsError(error)) throw error;
        if (await removeStaleLease(lockPath)) continue;
        await delay(KEY_INITIALIZATION_POLL_MS);
        continue;
      }

      try {
        // Another Host may have completed initialization between our first
        // SecretStorage read and the exclusive lock acquisition.
        const afterLock = await this.secrets.get(KEY_NAME);
        if (afterLock) return afterLock;

        const candidate = randomBytes(32).toString("base64");
        await this.secrets.store(KEY_NAME, candidate);

        // SecretStorage has no compare-and-swap API. Re-read the canonical
        // value after store and use only that value, never an unconfirmed
        // in-memory candidate.
        let confirmed = await this.secrets.get(KEY_NAME);
        while (!confirmed && Date.now() < deadline) {
          await delay(KEY_INITIALIZATION_POLL_MS);
          confirmed = await this.secrets.get(KEY_NAME);
        }
        if (confirmed) return confirmed;
        throw new Error("Conversation encryption key was not confirmed by SecretStorage.");
      } finally {
        await removeOwnedLease(lockPath, token);
      }
    }

    throw new Error("Timed out while initializing the conversation encryption key.");
  }

  private acceptKey(encoded: string) {
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) {
      throw new Error("Conversation encryption key has an invalid length.");
    }
    this.key = key;
    return key;
  }

  private recordPath(id: string) {
    return path.join(this.directory, `${id}.qac`);
  }

  private backupPath(id: string) {
    return path.join(this.directory, `${id}.bak`);
  }

  private assertSafeId(id: string) {
    if (!SAFE_ID.test(id)) throw new Error("Unsafe conversation id.");
  }
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function removeStaleLease(lockPath: string) {
  const observed = await readLeaseSnapshot(lockPath);
  if (!observed) return true;
  if (observed.record && isProcessAlive(observed.record.pid)) return false;
  if (!observed.record && Date.now() - observed.mtimeMs < INCOMPLETE_LEASE_GRACE_MS) return false;

  // Re-read immediately before deletion and compare the ownership token,
  // process and file metadata. Never delete a lock that changed while stale
  // ownership was being evaluated.
  const confirmed = await readLeaseSnapshot(lockPath);
  if (!confirmed) return true;
  if (!sameLeaseSnapshot(observed, confirmed)) return false;
  if (confirmed.record && isProcessAlive(confirmed.record.pid)) return false;
  if (!confirmed.record && Date.now() - confirmed.mtimeMs < INCOMPLETE_LEASE_GRACE_MS) return false;

  // Claim this exact stale file generation with a hard link before deleting
  // the canonical name. Link creation is atomic and never replaces an
  // existing claim, so only one concurrent reclaimer may remove this
  // generation. The fingerprint makes a delayed observer of the old file hit
  // the same claim instead of unlinking a newer lease created at lockPath.
  const reclaimPath = staleLeaseReclaimPath(lockPath, confirmed);
  try {
    await link(lockPath, reclaimPath);
  } catch (error) {
    if (isFileNotFoundError(error)) return true;
    if (isFileExistsError(error) || (await pathExists(reclaimPath))) return false;
    if (isRetryableLeaseFileError(error)) return false;
    throw error;
  }

  const claimed = await readLeaseSnapshot(reclaimPath);
  const current = await readLeaseSnapshot(lockPath);
  if (
    !claimed ||
    !current ||
    !sameLeaseGeneration(confirmed, claimed) ||
    !sameLeaseGeneration(claimed, current) ||
    !sameLeaseFile(claimed, current)
  ) {
    await rm(reclaimPath, { force: true }).catch(() => undefined);
    return !current;
  }

  for (const retryMs of STALE_LEASE_REMOVE_RETRY_MS) {
    if (retryMs > 0) await delay(retryMs);
    const beforeRemove = await readLeaseSnapshot(lockPath);
    if (!beforeRemove) {
      await removeLeaseReclaimMarker(reclaimPath);
      return true;
    }
    if (!sameLeaseGeneration(claimed, beforeRemove) || !sameLeaseFile(claimed, beforeRemove)) {
      await removeLeaseReclaimMarker(reclaimPath);
      return false;
    }
    try {
      await rm(lockPath);
      await removeLeaseReclaimMarker(reclaimPath);
      return true;
    } catch (error) {
      if (isFileNotFoundError(error)) {
        await removeLeaseReclaimMarker(reclaimPath);
        return true;
      }
      if (!isRetryableLeaseFileError(error)) throw error;
    }
  }

  // A sharing violation or scanner may temporarily prevent removal on
  // Windows. Leave exclusivity intact and let this acquisition try another
  // slot instead of surfacing a filesystem race as an activation failure.
  await removeLeaseReclaimMarker(reclaimPath);
  return false;
}

async function removeLeaseReclaimMarker(reclaimPath: string) {
  for (const retryMs of STALE_LEASE_REMOVE_RETRY_MS) {
    if (retryMs > 0) await delay(retryMs);
    try {
      await rm(reclaimPath, { force: true });
      return;
    } catch (error) {
      if (isFileNotFoundError(error)) return;
      if (!isRetryableLeaseFileError(error)) throw error;
    }
  }
}

async function readLeaseSnapshot(lockPath: string): Promise<LeaseSnapshot | undefined> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const metadata = await stat(lockPath);
    let record: LeaseRecord | undefined;
    try {
      const value: unknown = JSON.parse(raw);
      if (isLeaseRecord(value)) record = value;
    } catch {
      // A recent partial record is protected by the incomplete-file grace
      // period; an old malformed record is reclaimable.
    }
    return {
      raw,
      dev: metadata.dev,
      ino: metadata.ino,
      mtimeMs: metadata.mtimeMs,
      ctimeMs: metadata.ctimeMs,
      birthtimeMs: metadata.birthtimeMs,
      size: metadata.size,
      ...(record ? { record } : {}),
    };
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  }
}

function sameLeaseSnapshot(left: LeaseSnapshot, right: LeaseSnapshot) {
  return (
    left.raw === right.raw &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs &&
    left.size === right.size &&
    left.record?.pid === right.record?.pid &&
    left.record?.token === right.record?.token
  );
}

function sameLeaseFile(left: LeaseSnapshot, right: LeaseSnapshot) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameLeaseGeneration(left: LeaseSnapshot, right: LeaseSnapshot) {
  return (
    left.raw === right.raw &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.birthtimeMs === right.birthtimeMs &&
    left.size === right.size &&
    left.record?.pid === right.record?.pid &&
    left.record?.token === right.record?.token
  );
}

function staleLeaseReclaimPath(lockPath: string, snapshot: LeaseSnapshot) {
  const identity = JSON.stringify({
    raw: snapshot.raw,
    dev: snapshot.dev,
    ino: snapshot.ino,
    mtimeMs: snapshot.mtimeMs,
    birthtimeMs: snapshot.birthtimeMs,
    size: snapshot.size,
  });
  const fingerprint = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return `${lockPath}.reclaimed-${fingerprint}`;
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) return false;
    throw error;
  }
}

async function ownsLease(lockPath: string, token: string) {
  const snapshot = await readLeaseSnapshot(lockPath);
  return snapshot?.record?.token === token && snapshot.record.pid === process.pid;
}

async function removeOwnedLease(lockPath: string, token: string) {
  try {
    const value: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (isLeaseRecord(value) && value.token === token) {
      await rm(lockPath, { force: true });
    }
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
  }
}

function isLeaseRecord(value: unknown): value is { pid: number; token: string } {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) > 0 &&
    typeof value.token === "string" &&
    /^[a-f0-9]{32}$/.test(value.token)
  );
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ESRCH"
    );
  }
}

function isFileExistsError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function isFileNotFoundError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isRetryableLeaseFileError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["EACCES", "EBUSY", "EPERM"].includes(String((error as { code?: unknown }).code))
  );
}

function normalizeConversation(value: unknown, expectedId: string): Conversation {
  if (!isRecord(value) || value.id !== expectedId || !SAFE_ID.test(expectedId)) {
    throw new Error("Invalid conversation identity.");
  }
  if (
    typeof value.title !== "string" ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt) ||
    !Array.isArray(value.messages)
  ) {
    throw new Error("Invalid conversation.");
  }

  const messages = value.messages.map((message) =>
    normalizeMessage(message, value.createdAt as string),
  );
  const remoteUrl =
    typeof value.remoteUrl === "string" ? normalizeRemoteUrl(value.remoteUrl) : undefined;
  const selectedModelId =
    typeof value.selectedModelId === "string" && SAFE_MODEL_SELECTION_ID.test(value.selectedModelId)
      ? value.selectedModelId
      : undefined;
  const run = normalizeRun(value.run, messages, remoteUrl);
  const syncStatus = SYNC_STATUSES.has(String(value.syncStatus))
    ? (value.syncStatus as Conversation["syncStatus"])
    : undefined;
  const titleSource = TITLE_SOURCES.has(String(value.titleSource))
    ? (value.titleSource as Conversation["titleSource"])
    : undefined;
  const lastSyncedAt = isIsoDate(value.lastSyncedAt) ? value.lastSyncedAt : undefined;
  const archivedAt = isIsoDate(value.archivedAt) ? value.archivedAt : undefined;
  const queuedFollowUps = normalizeQueuedFollowUps(value.queuedFollowUps);
  const queuePaused = value.queuePaused === true && queuedFollowUps.length > 0;
  const storedTitle = normalizeStoredConversationTitle(value.title);
  const migrateGenericRemoteTitle =
    titleSource !== "local" &&
    isGenericConversationTitle(storedTitle) &&
    (titleSource === "chatgpt" || !isExpectedEmptyConversationTitle(storedTitle));
  const title = migrateGenericRemoteTitle ? fallbackConversationTitle(messages) : storedTitle;

  return {
    id: expectedId,
    title,
    ...(archivedAt ? { archivedAt } : {}),
    ...(remoteUrl ? { remoteUrl } : {}),
    ...(selectedModelId ? { selectedModelId } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    messages,
    ...(run ? { run } : {}),
    ...(syncStatus ? { syncStatus } : {}),
    ...(titleSource && !migrateGenericRemoteTitle ? { titleSource } : {}),
    ...(lastSyncedAt ? { lastSyncedAt } : {}),
    ...(queuedFollowUps.length > 0 ? { queuedFollowUps } : {}),
    ...(queuePaused ? { queuePaused: true } : {}),
  };
}

function normalizeQueuedFollowUps(value: unknown): QueuedFollowUp[] {
  if (!Array.isArray(value) || value.length > MAX_QUEUED_FOLLOW_UPS) return [];
  const queued: QueuedFollowUp[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !SAFE_RELAY_ID.test(item.id) ||
      seen.has(item.id) ||
      typeof item.text !== "string" ||
      item.text.trim().length === 0 ||
      item.text.length > MAX_QUEUED_FOLLOW_UP_CHARS ||
      !isIsoDate(item.createdAt)
    ) {
      continue;
    }
    const contexts = normalizeContexts(item.contexts, undefined);
    const contextIds = new Set(contexts.map((context) => context.id));
    const automaticContextIds = Array.isArray(item.automaticContextIds)
      ? item.automaticContextIds.filter(
          (id): id is string => typeof id === "string" && contextIds.has(id),
        )
      : [];
    const selectedModelId =
      typeof item.selectedModelId === "string" && SAFE_MODEL_SELECTION_ID.test(item.selectedModelId)
        ? item.selectedModelId
        : undefined;
    seen.add(item.id);
    queued.push({
      id: item.id,
      text: item.text.trim(),
      contexts,
      automaticContextIds: [...new Set(automaticContextIds)],
      ...(selectedModelId ? { selectedModelId } : {}),
      createdAt: item.createdAt,
    });
  }
  return queued;
}

function normalizeStoredConversationTitle(value: string) {
  return value.trim().slice(0, 80) || "New conversation";
}

function fallbackConversationTitle(messages: readonly ConversationMessage[]) {
  const firstUserMessage = messages.find((message) => message.role === "user");
  const firstLine = firstUserMessage?.markdown
    .trim()
    .split(/\r?\n/, 1)[0]
    ?.replace(/\s+/g, " ")
    .slice(0, 36);
  return firstLine && !isGenericConversationTitle(firstLine) ? firstLine : "New conversation";
}

function isExpectedEmptyConversationTitle(value: string) {
  return EXPECTED_EMPTY_CONVERSATION_TITLES.has(
    value.replace(/\s+/gu, " ").trim().toLocaleLowerCase(),
  );
}

function hasLegacyGenericRemoteTitle(value: unknown) {
  return (
    isRecord(value) &&
    value.titleSource !== "local" &&
    typeof value.title === "string" &&
    isGenericConversationTitle(normalizeStoredConversationTitle(value.title)) &&
    (value.titleSource === "chatgpt" ||
      !isExpectedEmptyConversationTitle(normalizeStoredConversationTitle(value.title)))
  );
}

function hasLegacyContextShape(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.messages)) return false;
  return value.messages.some(
    (message) =>
      isRecord(message) &&
      (message.context !== undefined ||
        (Array.isArray(message.contexts) &&
          message.contexts.some((context) => isRecord(context) && typeof context.id !== "string"))),
  );
}

function hasMessageRunErrorSchemaMigration(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.messages)) return false;
  return value.messages.some((message) => {
    if (!isRecord(message)) return false;
    if (legacyRunErrorFromStoredMessage(message)) return true;
    if (message.runError === undefined) return false;
    return (
      message.role !== "assistant" ||
      message.status !== "error" ||
      !relayErrorPayloadSchema.safeParse(message.runError).success
    );
  });
}

function hasTerminalDeliveryReceipt(conversation: Conversation) {
  return conversation.messages.some((message) => message.terminalReceipt !== undefined);
}

function normalizeMessage(value: unknown, fallbackCreatedAt: string): ConversationMessage {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !SAFE_RELAY_ID.test(value.id) ||
    !MESSAGE_ROLES.has(String(value.role)) ||
    typeof value.markdown !== "string" ||
    value.markdown.length > MAX_RELAY_FRAME_BYTES
  ) {
    throw new Error("Invalid conversation message.");
  }

  const role = value.role as ConversationMessage["role"];
  const status = MESSAGE_STATUSES.has(String(value.status))
    ? (value.status as ConversationMessage["status"])
    : role === "assistant"
      ? "complete"
      : "complete";
  const contexts = normalizeContexts(value.contexts, value.context);
  const terminalReceipt = normalizeTerminalReceipt(value.terminalReceipt);
  const storedRunError =
    role === "assistant" && status === "error" ? normalizeRunError(value.runError) : undefined;
  const legacyRunError =
    role === "assistant" && status === "error" && terminalReceipt?.terminalType === "error"
      ? extractLegacyRunErrorMarkdown(value.markdown)
      : undefined;
  const runError = storedRunError ?? legacyRunError?.runError;
  return {
    id: value.id,
    ...(typeof value.clientRequestId === "string" && SAFE_RELAY_ID.test(value.clientRequestId)
      ? { clientRequestId: value.clientRequestId }
      : {}),
    role,
    markdown: legacyRunError?.markdown ?? value.markdown,
    status,
    createdAt: isIsoDate(value.createdAt) ? value.createdAt : fallbackCreatedAt,
    ...(contexts.length > 0 ? { contexts } : {}),
    ...(role === "user" && contexts.length > 0 && value.contextTransportVersion === 2
      ? { contextTransportVersion: 2 as const }
      : {}),
    ...(runError ? { runError } : {}),
    ...(terminalReceipt ? { terminalReceipt } : {}),
  };
}

function normalizeRunError(value: unknown): RelayErrorPayload | undefined {
  const parsed = relayErrorPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function legacyRunErrorFromStoredMessage(value: Record<string, unknown>) {
  if (
    value.role !== "assistant" ||
    value.status !== "error" ||
    typeof value.markdown !== "string" ||
    !isRecord(value.terminalReceipt) ||
    value.terminalReceipt.terminalType !== "error"
  ) {
    return undefined;
  }
  return extractLegacyRunErrorMarkdown(value.markdown);
}

function extractLegacyRunErrorMarkdown(markdown: string) {
  const match = LEGACY_RUN_ERROR_NOTICE.exec(markdown);
  if (!match) return undefined;
  const [, escapedMessage, guidance, code] = match;
  const recoverable = LEGACY_RECOVERABLE_GUIDANCE.has(guidance!)
    ? true
    : guidance === LEGACY_NON_RECOVERABLE_GUIDANCE
      ? false
      : undefined;
  if (recoverable === undefined) return undefined;

  const parsed = relayErrorPayloadSchema.safeParse({
    code,
    message: unescapeLegacyMarkdownText(escapedMessage!),
    recoverable,
  });
  if (!parsed.success) return undefined;
  return {
    markdown: markdown.slice(0, match.index),
    runError: parsed.data,
  };
}

function unescapeLegacyMarkdownText(value: string) {
  return value.replace(/\\([\\`*_{}[\]<>])/gu, "$1");
}

function normalizeTerminalReceipt(
  value: unknown,
): NonNullable<ConversationMessage["terminalReceipt"]> | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.eventId !== "string" ||
    !SAFE_RELAY_ID.test(value.eventId) ||
    typeof value.runId !== "string" ||
    !SAFE_RELAY_ID.test(value.runId) ||
    !["complete", "stopped", "error"].includes(String(value.terminalType))
  ) {
    throw new Error("Invalid terminal delivery receipt.");
  }
  return {
    eventId: value.eventId,
    runId: value.runId,
    terminalType: value.terminalType as "complete" | "stopped" | "error",
  };
}

function normalizeContexts(value: unknown, legacyValue: unknown): ContextSnapshot[] {
  const source = value === undefined ? (legacyValue === undefined ? [] : [legacyValue]) : value;
  if (!Array.isArray(source) || source.length > MAX_STORED_CONTEXTS) {
    throw new Error("Invalid conversation context bundle.");
  }

  const contexts: ContextSnapshot[] = [];
  const identities = new Set<string>();
  let totalChars = 0;
  for (const item of source) {
    const context = normalizeContext(item);
    if (!context) throw new Error("Invalid conversation context snapshot.");
    const identity = [context.uri, context.startLine, context.endLine, context.content].join(
      "\u0000",
    );
    if (identities.has(identity)) continue;
    identities.add(identity);
    totalChars += context.content.length;
    if (totalChars > MAX_STORED_CONTEXT_BUNDLE_CHARS) {
      throw new Error("Conversation context bundle is too large.");
    }
    contexts.push(context);
  }
  return contexts;
}

function normalizeContext(value: unknown): ContextSnapshot | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    (value.kind !== "selection" && value.kind !== "current-file" && value.kind !== "file") ||
    typeof value.fileName !== "string" ||
    value.fileName.length < 1 ||
    value.fileName.length > 1_024 ||
    typeof value.uri !== "string" ||
    value.uri.length > 4_096 ||
    typeof value.language !== "string" ||
    value.language.length > 128 ||
    !Number.isInteger(value.startLine) ||
    !Number.isInteger(value.endLine) ||
    (value.startLine as number) < 1 ||
    (value.endLine as number) < (value.startLine as number) ||
    typeof value.content !== "string" ||
    value.content.length > MAX_STORED_CONTEXT_CHARS ||
    typeof value.unsaved !== "boolean" ||
    (value.id !== undefined && (typeof value.id !== "string" || !SAFE_RELAY_ID.test(value.id)))
  ) {
    return undefined;
  }

  const unsupportedSourceAnchor = isUnsupportedSourceAnchor(value.sourceAnchor);
  const sourceAnchor = unsupportedSourceAnchor
    ? undefined
    : normalizeSourceAnchor(value.sourceAnchor, value.content);
  if (value.sourceAnchor !== undefined && !unsupportedSourceAnchor && !sourceAnchor) {
    return undefined;
  }
  const id = typeof value.id === "string" ? value.id : legacyContextId(value);
  return {
    id,
    kind: value.kind,
    fileName: value.fileName,
    uri: value.uri,
    language: value.language,
    startLine: value.startLine as number,
    endLine: value.endLine as number,
    content: value.content,
    charCount: value.content.length,
    unsaved: value.unsaved,
    ...(sourceAnchor ? { sourceAnchor } : {}),
  };
}

function normalizeSourceAnchor(value: unknown, content: string): SourceAnchorV1 | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const allowedKeys = new Set([
    "formatVersion",
    "contentSha256",
    "normalizedContentSha256",
    "documentVersion",
    "beforeLineSha256",
    "afterLineSha256",
    "workspaceRelativePath",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return undefined;
  if (
    value.formatVersion !== 1 ||
    !isSha256(value.contentSha256) ||
    !isSha256(value.normalizedContentSha256) ||
    !Number.isSafeInteger(value.documentVersion) ||
    (value.documentVersion as number) < 0 ||
    (value.beforeLineSha256 !== undefined && !isSha256(value.beforeLineSha256)) ||
    (value.afterLineSha256 !== undefined && !isSha256(value.afterLineSha256)) ||
    (value.workspaceRelativePath !== undefined &&
      !isSafeWorkspaceRelativePath(value.workspaceRelativePath))
  ) {
    return undefined;
  }
  if (
    value.contentSha256 !== sourceAnchorSha256(content) ||
    value.normalizedContentSha256 !== sourceAnchorSha256(normalizeSourceAnchorContent(content))
  ) {
    return undefined;
  }
  return {
    formatVersion: 1,
    contentSha256: value.contentSha256,
    normalizedContentSha256: value.normalizedContentSha256,
    documentVersion: value.documentVersion as number,
    ...(value.beforeLineSha256 ? { beforeLineSha256: value.beforeLineSha256 } : {}),
    ...(value.afterLineSha256 ? { afterLineSha256: value.afterLineSha256 } : {}),
    ...(value.workspaceRelativePath ? { workspaceRelativePath: value.workspaceRelativePath } : {}),
  };
}

function isUnsupportedSourceAnchor(value: unknown) {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.formatVersion) &&
    (value.formatVersion as number) > 1
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isSafeWorkspaceRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.startsWith("/") ||
    /^[A-Za-z]:\//u.test(value) ||
    /[\\:\p{Cc}\p{Cf}]/u.test(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function legacyContextId(context: Record<string, unknown>) {
  const digest = createHash("sha256")
    .update(
      [
        String(context.kind),
        String(context.uri),
        String(context.startLine),
        String(context.endLine),
        String(context.content),
      ].join("\u0000"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
  return `legacy-${digest}`;
}

function normalizeRun(
  value: unknown,
  messages: ConversationMessage[],
  remoteUrl: string | undefined,
): RunState | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !SAFE_RELAY_ID.test(value.id) ||
    typeof value.messageId !== "string" ||
    !SAFE_RELAY_ID.test(value.messageId) ||
    !RUN_STATUSES.has(String(value.status)) ||
    !isIsoDate(value.startedAt)
  ) {
    return undefined;
  }
  const runMessage = messages.find(
    (message) => message.id === value.messageId && message.role === "assistant",
  );
  if (!runMessage) return undefined;
  const storedRemoteAdoptionStage = ["initial", "canonicalizing", "locked"].includes(
    String(value.remoteAdoptionStage),
  )
    ? (value.remoteAdoptionStage as RunState["remoteAdoptionStage"])
    : undefined;
  let remoteAdoptionStage = storedRemoteAdoptionStage;
  if (remoteAdoptionStage === "initial" && remoteUrl) {
    remoteAdoptionStage = "canonicalizing";
  } else if (remoteAdoptionStage === "canonicalizing" && !remoteUrl) {
    remoteAdoptionStage = "locked";
  }
  return {
    id: value.id,
    messageId: value.messageId,
    status: value.status as RunState["status"],
    startedAt: value.startedAt,
    ...(typeof value.softTimeoutNotified === "boolean"
      ? { softTimeoutNotified: value.softTimeoutNotified }
      : {}),
    ...(remoteAdoptionStage ? { remoteAdoptionStage } : {}),
    ...(value.resumeQueueAfterStop === true ? { resumeQueueAfterStop: true } : {}),
  };
}

function normalizeRemoteUrl(value: string) {
  try {
    if (!/^https:\/\/chatgpt\.com(?:\/|$)/.test(value)) return undefined;
    const url = new URL(value);
    if (
      url.origin !== "https://chatgpt.com" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      !isChatGptConversationPath(url.pathname)
    ) {
      return undefined;
    }
    return `https://chatgpt.com${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return undefined;
  }
}

function isChatGptConversationPath(pathname: string) {
  if (/^\/c\/[^/]+\/?$/.test(pathname)) return true;
  const segments = pathname.split("/").filter(Boolean);
  return (
    segments.length >= 4 &&
    segments.at(-2) === "c" &&
    segments.every((segment) => {
      if (segment.length < 1 || segment.length > 256 || segment.includes("\\")) return false;
      try {
        const decoded = decodeURIComponent(segment);
        return (
          decoded !== "." && decoded !== ".." && !decoded.includes("/") && !decoded.includes("\\")
        );
      } catch {
        return false;
      }
    })
  );
}

function recordAad(id: string) {
  return `ask2gpt:conversation:${id}:v${CURRENT_RECORD_VERSION}`;
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    value.length <= 32 &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyLoadReport(): ConversationStoreLoadReport {
  return {
    records: 0,
    recoveredFromBackup: 0,
    unreadable: 0,
    migrated: 0,
    repairFailures: 0,
    migrationFailures: 0,
  };
}

function hasFileSystemErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error;
}

function isNotFound(error: unknown) {
  return hasFileSystemErrorCode(error) && (error as { code?: string }).code === "ENOENT";
}
