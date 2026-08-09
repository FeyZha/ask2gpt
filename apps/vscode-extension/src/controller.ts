import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";

import {
  MAX_CONCURRENT_RUNS,
  isGenericConversationTitle,
  type ChatModelOption,
  type ContextSnapshot,
  type Conversation,
  type ConversationMessage,
  type ConversationTranscriptProof,
  type QueuedFollowUp,
  type RelayErrorPayload,
} from "@ask2gpt/protocol";
import * as vscode from "vscode";

import type {
  AppState,
  BackendEvent,
  BackendStatus,
  ChatBackend,
  GenerationViewUpdate,
  ModelPickerState,
} from "./types";
import { readComposerPreferences } from "./composer-preferences";
import { assertAllowedContextBundle } from "./services/context-policy";
import { ContextService } from "./services/context-service";
import { ConversationStore } from "./services/conversation-store";
import { Ask2GPTError } from "./services/errors";
import { SafeLogger } from "./services/logger";
import { DEFAULT_CHATGPT_MODE_ID, mergeChatGptModeOptions } from "./services/model-options";
import { buildLegacyVisiblePromptPlan, buildVisiblePromptPlan } from "./services/prompt-builder";
import type { SelectionReference } from "./selection-reference";

const ACTIVE_CONVERSATION_KEY = "ask2gpt.activeConversationId";
const PENDING_TAB_CLOSES_KEY = "ask2gpt.pendingTabCloses.v1";
const HARD_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const SAVE_TRAILING_DELAY_MS = 1_000;
const SAVE_MAX_WAIT_MS = 5_000;
const MAX_QUEUED_FOLLOW_UPS = 20;
const SAFE_QUEUE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const TRANSCRIPT_PREFLIGHT_NOT_SENT_MESSAGE =
  "Ask2GPT could not capture a complete, stable pre-send transcript; the question was not sent.";

interface DraftContextState {
  items: ContextSnapshot[];
  automaticContextIds: Set<string>;
  primaryContextId?: string;
}

interface RunStreamMetrics {
  snapshots: number;
  firstSnapshotAt: number;
  lastSnapshotAt: number;
  lastMarkdownLength: number;
  maxGapMs: number;
  maxChunkChars: number;
}

export class Ask2GPTController {
  private conversations: Conversation[] = [];
  private activeConversationId = "";
  private readonly draftContexts = new Map<string, DraftContextState>();
  private readonly modelPickers = new Map<string, ModelPickerState>();
  private backendStatus: BackendStatus = {
    connected: false,
    authenticated: false,
    activeRuns: 0,
    selectorVersion: 1,
    connection: {
      phase: "starting",
      since: new Date().toISOString(),
      browserDetected: false,
      hasStoredTrust: false,
    },
  };
  private readonly events = new EventEmitter();
  private readonly generationEvents = new EventEmitter();
  private readonly saveTimers = new Map<string, NodeJS.Timeout>();
  private readonly saveWindows = new Map<string, number>();
  private readonly runTimers = new Map<string, NodeJS.Timeout>();
  private readonly runStreamMetrics = new Map<string, RunStreamMetrics>();
  private readonly backendTasks = new Set<Promise<void>>();
  private readonly terminalRunTasks = new Set<string>();
  private readonly pendingInitializationEvents: BackendEvent[] = [];
  private backendEventsReady = false;
  private readonly deletingConversations = new Set<string>();
  private readonly archivingConversations = new Set<string>();
  private readonly dispatchingConversations = new Set<string>();
  private readonly modelPrefetches = new Map<string, Promise<ChatModelOption[]>>();
  private readonly conversationPreparations = new Map<string, Promise<void>>();
  private readonly dispatchIntentPreparations = new Map<string, Promise<void>>();
  private modelCatalog?: ChatModelOption[];
  private readonly backendSubscription: { dispose(): void };
  private conversationNavigationTail: Promise<void> = Promise.resolve();
  private readonly pendingNewConversations = new Map<string, Promise<Conversation>>();
  private activeStateWrite: Promise<void> = Promise.resolve();
  private pendingCloseWrite: Promise<void> = Promise.resolve();
  private pendingCloseFlush?: Promise<void>;
  private readonly pendingTabCloses = new Set<string>();
  private disposePromise?: Promise<void>;
  private disposed = false;

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly store: ConversationStore,
    private readonly contextService: ContextService,
    private readonly backend: ChatBackend,
    private readonly logger: SafeLogger,
    readonly instanceId: string,
    private readonly stateKeySuffix = "",
  ) {
    this.backendSubscription = backend.onEvent((event) => {
      const task = this.handleBackendEvent(event);
      this.backendTasks.add(task);
      void task
        .catch((error: unknown) => {
          this.logger.error("backend.event-failed", "BACKEND_EVENT_FAILED", {
            name: error instanceof Error ? error.name : "Unknown",
          });
        })
        .finally(() => this.backendTasks.delete(task));
    });
  }

  async initialize() {
    const storedPendingCloses = this.extensionContext.workspaceState.get<unknown>(
      this.pendingTabClosesKey,
    );
    if (Array.isArray(storedPendingCloses)) {
      for (const id of storedPendingCloses.slice(0, 1_000)) {
        if (typeof id === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(id)) {
          this.pendingTabCloses.add(id);
        }
      }
    }
    this.conversations = await this.store.loadAll();
    const loadReport = this.store.getLoadReport();
    if (
      loadReport.unreadable > 0 ||
      loadReport.repairFailures > 0 ||
      loadReport.migrationFailures > 0
    ) {
      this.logger.error("conversation.load-degraded", "STORE_RECOVERY_INCOMPLETE", {
        unreadable: loadReport.unreadable,
        repairFailures: loadReport.repairFailures,
        migrationFailures: loadReport.migrationFailures,
      });
    } else if (loadReport.recoveredFromBackup > 0 || loadReport.migrated > 0) {
      this.logger.info("conversation.load-recovered", {
        recovered: loadReport.recoveredFromBackup,
        migrated: loadReport.migrated,
      });
    }

    const recovered = this.conversations.filter((conversation) =>
      this.reconcileLoadedRun(conversation),
    );
    const recoverySaves = await Promise.allSettled(
      recovered.map(async (conversation) => this.store.save(conversation)),
    );
    if (recoverySaves.some((result) => result.status === "rejected")) {
      this.logger.error("conversation.recovery-save-failed", "STORE_WRITE_FAILED", {
        failures: recoverySaves.filter((result) => result.status === "rejected").length,
      });
    }

    const legacyEmptyConversations = this.conversations.filter(
      (conversation) =>
        conversation.messages.length > 0 &&
        !hasVisibleConversationMessages(conversation) &&
        !conversation.run &&
        !conversation.queuedFollowUps?.length,
    );
    if (legacyEmptyConversations.length > 0) {
      this.conversations = this.conversations.filter(
        (conversation) => !legacyEmptyConversations.includes(conversation),
      );
      const cleanup = await Promise.allSettled(
        legacyEmptyConversations.map(async (conversation) => this.store.delete(conversation.id)),
      );
      if (cleanup.some((result) => result.status === "rejected")) {
        this.logger.error("conversation.empty-cleanup-failed", "STORE_WRITE_FAILED", {
          failures: cleanup.filter((result) => result.status === "rejected").length,
        });
      }
    }

    if (!this.conversations.some((conversation) => !conversation.archivedAt)) {
      this.conversations.unshift(this.createConversation());
    }
    const storedActive = this.extensionContext.workspaceState.get<string>(
      this.activeConversationKey,
    );
    const storedConversation = this.conversations.find((item) => item.id === storedActive);
    const restoredActive = storedConversation?.archivedAt ? undefined : storedConversation;
    if (restoredActive) {
      this.activeConversationId = restoredActive.id;
    } else if (storedActive && !storedConversation) {
      // The active id can legitimately point at an ephemeral blank composer,
      // which has no encrypted history record. Preserve that navigation state
      // as a fresh blank draft instead of silently reopening another chat.
      const replacement = this.createConversation();
      this.conversations.unshift(replacement);
      this.activeConversationId = replacement.id;
    } else {
      this.activeConversationId = this.mostRecentUnarchivedConversation()!.id;
    }
    if (this.activeConversationId !== storedActive) {
      try {
        await this.persistActive();
      } catch (error) {
        this.logger.error("conversation.active-save-failed", "GLOBAL_STATE_WRITE_FAILED", {
          name: error instanceof Error ? error.name : "Unknown",
        });
      }
    }
    this.ensureDraft(this.activeConversation);
    this.seedModelPicker(this.activeConversationId);
    this.backendStatus = await this.backend.getStatus();
    if (this.backendStatus.authenticated) await this.flushPendingTabCloses();
    for (const conversation of this.conversations) {
      if (conversation.run) this.scheduleRunTimeout(conversation);
    }
    await this.releaseInitializationEvents();
    this.emitState();
    if (isBackendReady(this.backendStatus)) {
      this.scheduleEligibleQueuedDispatches();
      this.scheduleActiveConversationPreparation();
    }
  }

  onState(listener: (state: AppState) => void) {
    this.events.on("state", listener);
    return { dispose: () => this.events.off("state", listener) };
  }

  onGeneration(listener: (update: GenerationViewUpdate) => void) {
    this.generationEvents.on("update", listener);
    return { dispose: () => this.generationEvents.off("update", listener) };
  }

  getState(): AppState {
    const restoredActiveRuns = this.conversations.filter((conversation) => conversation.run).length;
    const draft = this.getOrCreateDraft(this.activeConversationId);
    return {
      activeConversationId: this.activeConversationId,
      conversations: [...this.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      pendingContexts: [...draft.items],
      automaticContextIds: [...draft.automaticContextIds],
      contextLocked: this.dispatchingConversations.has(this.activeConversationId),
      dispatchingConversationIds: [...this.dispatchingConversations],
      backend: {
        ...this.backendStatus,
        activeRuns: Math.max(this.backendStatus.activeRuns, restoredActiveRuns),
      },
      modelPicker: this.getModelPickerState(this.activeConversationId),
      composerPreferences: readComposerPreferences(),
      locale: vscode.env.language.toLowerCase().startsWith("en") ? "en" : "zh-CN",
    };
  }

  refreshComposerPreferences() {
    this.emitState();
  }

  get activeConversation() {
    return this.conversations.find((item) => item.id === this.activeConversationId);
  }

  prepareConversationForDispatch(conversationId: string) {
    const conversation = this.conversations.find((item) => item.id === conversationId);
    if (
      !conversation ||
      conversation.id !== this.activeConversationId ||
      this.disposed ||
      !isBackendReady(this.backendStatus) ||
      conversation.archivedAt ||
      conversation.run ||
      this.dispatchingConversations.has(conversation.id) ||
      this.deletingConversations.has(conversation.id) ||
      this.archivingConversations.has(conversation.id) ||
      this.dispatchIntentPreparations.has(conversation.id)
    ) {
      return;
    }

    const startedAt = Date.now();
    const task = this.backend
      .prepareConversation(
        conversation.id,
        conversation.remoteUrl,
        buildConversationTranscriptProof(conversation),
        true,
      )
      .then(() => {
        this.logger.info("conversation.dispatch-prewarm-dispatched", {
          durationMs: Math.max(0, Date.now() - startedAt),
        });
      })
      .catch((error: unknown) => {
        this.logger.error("conversation.dispatch-prewarm-failed", "CHATGPT_REMOTE_UNAVAILABLE", {
          name: error instanceof Error ? error.name : "Unknown",
        });
      })
      .finally(() => {
        this.dispatchIntentPreparations.delete(conversation.id);
      });
    this.dispatchIntentPreparations.set(conversation.id, task);
    this.backendTasks.add(task);
    void task.finally(() => this.backendTasks.delete(task));
  }

  newConversation(sourceConversationId = this.activeConversationId) {
    const pending = this.pendingNewConversations.get(sourceConversationId);
    if (pending) return pending;

    const task = this.enqueueConversationNavigation(async () => {
      // The webview identifies the conversation that owned the New button at
      // click time. A repeated message from that rendered frame must not
      // create another empty conversation after the first request has already
      // switched the active conversation.
      if (this.activeConversationId !== sourceConversationId) {
        const active = this.activeConversation;
        if (active) return active;
      }

      const conversation = this.createConversation();
      // A blank composer is an ephemeral draft, not conversation history.
      // Its first accepted message is the point where the encrypted record
      // becomes durable. Draft attachments remain isolated by conversation id
      // in the meantime and therefore cannot leak from the source composer.
      this.conversations.unshift(conversation);
      this.activeConversationId = conversation.id;
      this.clearDraftAfterSend(conversation);
      this.seedModelPicker(conversation.id);
      try {
        await this.persistActive();
      } catch (error) {
        this.logger.error("conversation.active-save-failed", "GLOBAL_STATE_WRITE_FAILED", {
          name: error instanceof Error ? error.name : "Unknown",
        });
      }
      this.emitState();
      this.scheduleActiveConversationPreparation();
      return conversation;
    });
    this.pendingNewConversations.set(sourceConversationId, task);
    void task.then(
      () => {
        if (this.pendingNewConversations.get(sourceConversationId) === task) {
          this.pendingNewConversations.delete(sourceConversationId);
        }
      },
      () => {
        if (this.pendingNewConversations.get(sourceConversationId) === task) {
          this.pendingNewConversations.delete(sourceConversationId);
        }
      },
    );
    return task;
  }

  selectConversation(id: string) {
    return this.enqueueConversationNavigation(async () => {
      if (
        !this.conversations.some((item) => item.id === id && !item.archivedAt) ||
        this.archivingConversations.has(id) ||
        this.deletingConversations.has(id)
      ) {
        return;
      }
      this.activeConversationId = id;
      this.ensureDraft(this.activeConversation);
      this.seedModelPicker(id);
      try {
        await this.persistActive();
      } catch (error) {
        this.logger.error("conversation.active-save-failed", "GLOBAL_STATE_WRITE_FAILED", {
          name: error instanceof Error ? error.name : "Unknown",
        });
      }
      this.emitState();
      this.scheduleActiveConversationPreparation();
    });
  }

  async renameConversation(id: string, title: string) {
    const conversation = this.requireConversation(id);
    const normalized = title.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!normalized) throw new Ask2GPTError("TITLE_EMPTY", "会话名称不能为空。");
    const previousTitle = conversation.title;
    const previousUpdatedAt = conversation.updatedAt;
    const previousTitleSource = conversation.titleSource;
    conversation.title = normalized;
    conversation.titleSource = "local";
    conversation.updatedAt = new Date().toISOString();
    try {
      await this.persistConversation(conversation);
    } catch (error) {
      if (conversation.title === normalized) {
        conversation.title = previousTitle;
        conversation.titleSource = previousTitleSource;
        conversation.updatedAt = previousUpdatedAt;
      }
      throw error;
    }
    this.emitState();
  }

  archiveConversation(id: string) {
    return this.enqueueConversationNavigation(async () => {
      const conversation = this.conversations.find((item) => item.id === id);
      if (
        !conversation ||
        conversation.archivedAt ||
        this.deletingConversations.has(id) ||
        this.archivingConversations.has(id)
      ) {
        return;
      }
      if (
        conversation.run ||
        conversation.queuedFollowUps?.length ||
        this.dispatchingConversations.has(id)
      ) {
        throw new Ask2GPTError(
          "CONVERSATION_BUSY",
          "Wait for the current response and queued follow-ups to finish before archiving this chat.",
        );
      }
      // Blank composers are ephemeral and never appear in history.
      if (!hasVisibleConversationMessages(conversation)) return;

      this.archivingConversations.add(id);
      this.clearSaveTimer(id);
      conversation.archivedAt = new Date().toISOString();
      try {
        await this.store.save(conversation);
      } catch (error) {
        delete conversation.archivedAt;
        this.scheduleSave(conversation);
        throw error;
      } finally {
        this.archivingConversations.delete(id);
      }

      this.draftContexts.delete(id);
      this.modelPickers.delete(id);
      let activeConversationChanged = false;
      if (this.activeConversationId === id) {
        const replacement = this.mostRecentUnarchivedConversation();
        if (replacement) {
          this.activeConversationId = replacement.id;
        } else {
          const blank = this.createConversation();
          this.conversations.unshift(blank);
          this.activeConversationId = blank.id;
        }
        activeConversationChanged = true;
        this.ensureDraft(this.activeConversation);
        this.seedModelPicker(this.activeConversationId);
        try {
          await this.persistActive();
        } catch (error) {
          this.logger.error("conversation.active-save-failed", "GLOBAL_STATE_WRITE_FAILED", {
            name: error instanceof Error ? error.name : "Unknown",
          });
        }
      }
      this.emitState();
      if (activeConversationChanged) this.scheduleActiveConversationPreparation();
    });
  }

  unarchiveConversation(id: string, activate = false) {
    return this.enqueueConversationNavigation(async () => {
      const conversation = this.conversations.find((item) => item.id === id);
      if (
        !conversation ||
        !conversation.archivedAt ||
        this.deletingConversations.has(id) ||
        this.archivingConversations.has(id)
      ) {
        return;
      }

      this.archivingConversations.add(id);
      const archivedAt = conversation.archivedAt;
      delete conversation.archivedAt;
      try {
        await this.store.save(conversation);
      } catch (error) {
        conversation.archivedAt = archivedAt;
        throw error;
      } finally {
        this.archivingConversations.delete(id);
      }

      if (activate) {
        this.activeConversationId = id;
        this.ensureDraft(conversation);
        this.seedModelPicker(id);
        try {
          await this.persistActive();
        } catch (error) {
          this.logger.error("conversation.active-save-failed", "GLOBAL_STATE_WRITE_FAILED", {
            name: error instanceof Error ? error.name : "Unknown",
          });
        }
      }
      this.emitState();
      if (activate) this.scheduleActiveConversationPreparation();
    });
  }

  async deleteConversation(id: string) {
    if (!this.conversations.some((item) => item.id === id) || this.deletingConversations.has(id)) {
      return;
    }

    this.deletingConversations.add(id);
    this.clearSaveTimer(id);
    this.clearRunTimer(id);
    try {
      await this.store.delete(id);
    } catch (error) {
      const conversation = this.conversations.find((item) => item.id === id);
      this.deletingConversations.delete(id);
      if (conversation?.run) this.scheduleRunTimeout(conversation);
      if (conversation) this.scheduleSave(conversation);
      throw error;
    }
    this.draftContexts.delete(id);
    await this.rememberPendingTabClose(id);

    try {
      const currentIndex = this.conversations.findIndex((item) => item.id === id);
      if (currentIndex >= 0) this.conversations.splice(currentIndex, 1);
      if (this.conversations.length === 0) {
        const replacement = this.createConversation();
        this.conversations.push(replacement);
      }
      let activeConversationChanged = false;
      if (this.activeConversationId === id) {
        const replacement = this.mostRecentUnarchivedConversation();
        if (replacement) {
          this.activeConversationId = replacement.id;
        } else {
          const blank = this.createConversation();
          this.conversations.unshift(blank);
          this.activeConversationId = blank.id;
        }
        activeConversationChanged = true;
        this.ensureDraft(this.activeConversation);
        try {
          await this.persistActive();
        } catch (error) {
          this.logger.error("conversation.active-save-failed", "GLOBAL_STATE_WRITE_FAILED", {
            name: error instanceof Error ? error.name : "Unknown",
          });
        }
      }
      this.emitState();
      if (activeConversationChanged) this.scheduleActiveConversationPreparation();

      try {
        const delivered = await this.backend.closeConversation(id);
        if (delivered) await this.forgetPendingTabClose(id);
      } catch (error) {
        this.logger.error("conversation.tab-close-failed", "TAB_CLOSE_FAILED", {
          name: error instanceof Error ? error.name : "Unknown",
        });
      }
    } finally {
      this.deletingConversations.delete(id);
    }
  }

  attachSelection(conversationId = this.activeConversationId, reference?: SelectionReference) {
    if (!this.hasDraftTarget(conversationId)) return;
    this.setPrimaryContext(this.contextService.captureSelection(reference), conversationId);
  }

  attachSelectionToActiveConversation(reference: SelectionReference) {
    const capturedReference = { ...reference };
    return this.enqueueConversationNavigation(async () => {
      const conversationId = this.activeConversationId;
      if (!this.hasDraftTarget(conversationId)) return false;
      this.attachSelection(conversationId, capturedReference);
      return true;
    });
  }

  attachCurrentFile(conversationId = this.activeConversationId) {
    if (!this.hasDraftTarget(conversationId)) return;
    this.setPrimaryContext(this.contextService.captureCurrentFile(), conversationId);
  }

  async attachFiles(conversationId = this.activeConversationId) {
    if (!this.hasDraftTarget(conversationId)) return;
    const contexts = await this.contextService.captureFiles();
    if (contexts.length > 0) this.addContexts(contexts, conversationId);
  }

  removeContext(contextId: string, conversationId = this.activeConversationId) {
    if (!this.hasDraftTarget(conversationId)) return;
    this.assertDraftMutable(conversationId);
    const draft = this.getOrCreateDraft(conversationId);
    const next = draft.items.filter((context) => context.id !== contextId);
    if (next.length === draft.items.length) return;
    draft.items = next;
    draft.automaticContextIds.delete(contextId);
    if (draft.primaryContextId === contextId) {
      draft.primaryContextId = undefined;
    }
    this.emitState();
  }

  private addContexts(contexts: readonly ContextSnapshot[], conversationId: string) {
    if (!this.hasDraftTarget(conversationId)) return;
    this.assertDraftMutable(conversationId);
    const draft = this.getOrCreateDraft(conversationId);
    const additions = contexts.filter(
      (candidate) =>
        !draft.items.some(
          (existing) =>
            existing.id === candidate.id || haveSameExplicitContext(existing, candidate),
        ),
    );
    if (additions.length === 0) return;
    const next = [...draft.items, ...additions];
    assertAllowedContextBundle(next);
    draft.items = next;
    this.emitState();
  }

  private setPrimaryContext(context: ContextSnapshot, conversationId: string) {
    if (!this.hasDraftTarget(conversationId)) return;
    this.assertDraftMutable(conversationId);
    const draft = this.getOrCreateDraft(conversationId);
    const remaining = draft.primaryContextId
      ? draft.items.filter((item) => item.id !== draft.primaryContextId)
      : draft.items;
    const next = [context, ...remaining.filter((item) => !haveSameExplicitContext(item, context))];
    assertAllowedContextBundle(next);
    draft.items = next;
    draft.automaticContextIds.clear();
    draft.primaryContextId = context.id;
    this.emitState();
  }

  private hasDraftTarget(conversationId: string) {
    return (
      !this.deletingConversations.has(conversationId) &&
      !this.archivingConversations.has(conversationId) &&
      this.conversations.some(
        (conversation) => conversation.id === conversationId && !conversation.archivedAt,
      )
    );
  }

  private assertDraftMutable(conversationId: string) {
    if (!this.dispatchingConversations.has(conversationId)) return;
    throw new Ask2GPTError("SEND_IN_PROGRESS", "当前问题正在提交，请等待发送完成后再调整上下文。");
  }

  private ensureDraft(conversation: Conversation | undefined) {
    if (!conversation || this.draftContexts.has(conversation.id)) return;
    // Draft attachments are conversation-scoped and opt-in. A new or restored
    // conversation must start clean until the user explicitly attaches code.
    this.clearDraftAfterSend(conversation);
  }

  private clearDraftAfterSend(conversation: Conversation) {
    this.draftContexts.set(conversation.id, {
      items: [],
      automaticContextIds: new Set<string>(),
    });
  }

  private getOrCreateDraft(conversationId: string) {
    const existing = this.draftContexts.get(conversationId);
    if (existing) return existing;
    const created: DraftContextState = {
      items: [],
      automaticContextIds: new Set<string>(),
    };
    this.draftContexts.set(conversationId, created);
    return created;
  }

  async send(
    question: string,
    conversationId = this.activeConversationId,
    clientRequestId?: string,
  ) {
    const sendStartedAt = Date.now();
    // The webview captures the destination at click time. Never infer it from
    // the currently selected conversation after an asynchronous UI switch.
    const conversation = this.requireConversation(conversationId);
    const draft = this.getOrCreateDraft(conversation.id);
    const attachedDraft = cloneDraftContextState(draft);
    const attachedContexts = [...attachedDraft.items];
    const sendPlan = buildVisiblePromptPlan(question, attachedContexts);
    const prompt = sendPlan.prompt;
    if (this.dispatchingConversations.has(conversation.id)) {
      throw new Ask2GPTError(
        "SEND_IN_PROGRESS",
        "The previous request is still being prepared. Please wait and try again.",
      );
    }
    if (conversation.run) {
      throw new Ask2GPTError("CONVERSATION_BUSY", "该会话已有回答正在生成。");
    }
    this.assertGlobalRunCapacity();
    this.dispatchingConversations.add(conversation.id);
    this.emitState();
    try {
      await this.settlePendingRemotePromotionBeforeRun(conversation);
      if (
        this.deletingConversations.has(conversation.id) ||
        !this.conversations.includes(conversation)
      ) {
        throw new Ask2GPTError(
          "CONVERSATION_DELETED",
          "The conversation was deleted while its ChatGPT address was being settled.",
        );
      }
      if (conversation.run) {
        throw new Ask2GPTError(
          "CONVERSATION_BUSY",
          "This conversation started another response while its address was being settled.",
        );
      }
      this.assertGlobalRunCapacity();
    } catch (error) {
      this.dispatchingConversations.delete(conversation.id);
      this.emitState();
      throw error;
    }
    const now = new Date().toISOString();
    const originalTitle = conversation.title;
    const originalTitleSource = conversation.titleSource;
    const originalSyncStatus = conversation.syncStatus;
    const originalUpdatedAt = conversation.updatedAt;
    const userMessage: ConversationMessage = {
      id: randomUUID(),
      ...(clientRequestId && SAFE_QUEUE_ID.test(clientRequestId) ? { clientRequestId } : {}),
      role: "user",
      markdown: question.trim(),
      status: "complete",
      createdAt: now,
      ...(attachedContexts.length > 0
        ? { contexts: attachedContexts, contextTransportVersion: 2 as const }
        : {}),
    };
    conversation.messages.push(userMessage);
    this.updateAutomaticTitle(conversation, question);
    const automaticTitle = conversation.title;

    const assistantMessage: ConversationMessage = {
      id: randomUUID(),
      role: "assistant",
      markdown: "",
      status: "streaming",
      createdAt: now,
    };
    const runId = randomUUID();
    conversation.messages.push(assistantMessage);
    conversation.run = {
      id: runId,
      messageId: assistantMessage.id,
      status: "starting",
      startedAt: now,
      remoteAdoptionStage: conversation.remoteUrl ? "canonicalizing" : "initial",
    };
    conversation.syncStatus = "syncing";
    conversation.updatedAt = now;
    // Reflect the accepted local send immediately. The durable write still
    // happens before the prompt leaves VS Code, and the existing rollback path
    // restores the previous state if either persistence or dispatch fails.
    this.emitState();

    try {
      const saveStartedAt = Date.now();
      await this.store.save(conversation);
      this.logger.info("run.local-state-persisted", {
        durationMs: Date.now() - saveStartedAt,
      });
      // The question and its immutable context snapshot now live on the user
      // message. Move that context out of the next-question composer before
      // waiting for Chrome. The rollback path below restores the exact draft
      // if Relay rejects the dispatch, and context mutation remains locked in
      // the meantime, so this hand-off cannot lose a user's attachment.
      this.clearDraftAfterSend(conversation);
      this.emitState();
      this.scheduleRunTimeout(conversation);
      await this.backend.send({
        conversationId: conversation.id,
        messageId: userMessage.id,
        runId,
        prompt,
        attachments: sendPlan.attachments,
        remoteUrl: conversation.remoteUrl,
        // Keep the low-latency default deterministic. Model discovery is
        // proactively warmed while the user is reading or typing, and Relay
        // still resolves a cold catalog safely if the first send wins the race.
        modelId: modelIdForDispatch(conversation),
        transcriptProof: buildConversationTranscriptProof(conversation),
      });
      this.logger.info("run.relay-dispatched", {
        durationMs: Date.now() - sendStartedAt,
      });
    } catch (error) {
      if (conversation.run?.id !== runId) {
        this.logger.info("backend.late-send-rejection");
        return;
      }
      this.clearRunTimer(conversation.id);
      this.rollbackSend(
        conversation,
        [userMessage.id, assistantMessage.id],
        originalTitle,
        originalTitleSource,
        originalSyncStatus,
        automaticTitle,
        originalUpdatedAt,
        now,
        attachedContexts,
        attachedDraft,
      );
      await this.persistConversation(conversation).catch((saveError: unknown) => {
        this.logger.error("conversation.rollback-save-failed", "STORE_WRITE_FAILED", {
          name: saveError instanceof Error ? saveError.name : "Unknown",
        });
      });
      this.emitState();
      throw error;
    } finally {
      this.dispatchingConversations.delete(conversation.id);
      this.emitState();
    }
  }

  async enqueueFollowUp(
    question: string,
    conversationId = this.activeConversationId,
    queueId: string = randomUUID(),
    targetRunId?: string,
  ) {
    const conversation = this.requireConversation(conversationId);
    if (!conversation.run) {
      throw new Ask2GPTError(
        "QUEUE_REQUIRES_ACTIVE_RUN",
        "The current answer has already finished. Send this message normally.",
      );
    }
    if (targetRunId && conversation.run.id !== targetRunId) {
      throw new Ask2GPTError(
        "STALE_RUN",
        "The answer changed before this follow-up arrived. It was not queued.",
      );
    }
    if (!SAFE_QUEUE_ID.test(queueId)) {
      throw new Ask2GPTError("QUEUE_ID_INVALID", "The queued message id is invalid.");
    }
    const text = question.trim();
    if (!text) throw new Ask2GPTError("QUESTION_EMPTY", "The message cannot be empty.");
    if (text.length > 20_000) {
      throw new Ask2GPTError("QUESTION_TOO_LONG", "The message is too long.");
    }
    const queue = conversation.queuedFollowUps ?? [];
    if (queue.some((item) => item.id === queueId)) return;
    if (queue.length >= MAX_QUEUED_FOLLOW_UPS) {
      throw new Ask2GPTError(
        "QUEUE_LIMIT_REACHED",
        `At most ${MAX_QUEUED_FOLLOW_UPS} follow-ups can wait in one chat.`,
      );
    }

    const draft = this.getOrCreateDraft(conversation.id);
    const capturedDraft = cloneDraftContextState(draft);
    const capturedContexts = capturedDraft.items.map((context) => ({ ...context }));
    assertAllowedContextBundle(capturedContexts);
    const previousUpdatedAt = conversation.updatedAt;
    const item: QueuedFollowUp = {
      id: queueId,
      text,
      contexts: capturedContexts,
      automaticContextIds: [...capturedDraft.automaticContextIds].filter((id) =>
        capturedContexts.some((context) => context.id === id),
      ),
      ...(this.getModelPickerState(conversation.id).currentModelId
        ? { selectedModelId: this.getModelPickerState(conversation.id).currentModelId }
        : {}),
      createdAt: new Date().toISOString(),
    };
    conversation.queuedFollowUps = [...queue, item];
    conversation.updatedAt = item.createdAt;
    try {
      await this.store.save(conversation);
      this.clearDraftAfterSend(conversation);
      this.emitState();
    } catch (error) {
      conversation.queuedFollowUps = queue.length > 0 ? queue : undefined;
      conversation.updatedAt = previousUpdatedAt;
      this.draftContexts.set(conversation.id, capturedDraft);
      throw error;
    }
  }

  async interruptWithFollowUp(
    question: string,
    conversationId = this.activeConversationId,
    queueId: string = randomUUID(),
    targetRunId?: string,
  ): Promise<"interrupted" | "queued"> {
    const conversation = this.requireConversation(conversationId);
    const runId = targetRunId ?? conversation.run?.id;
    if (!runId || conversation.run?.id !== runId) {
      throw new Ask2GPTError(
        "STALE_RUN",
        "The answer changed before this follow-up arrived. Nothing was interrupted.",
      );
    }

    // Persist the follow-up first. From this point onward every failure falls
    // back to an ordinary queued message, so a lost stop receipt can never
    // make the UI restore and resend the same request.
    await this.enqueueFollowUp(question, conversationId, queueId, runId);
    if (conversation.run?.id !== runId || conversation.run.status === "stopping") {
      return "interrupted";
    }

    const previousStatus = conversation.run.status;
    conversation.run.status = "stopping";
    conversation.run.resumeQueueAfterStop = true;
    try {
      await this.store.save(conversation);
    } catch (error) {
      if (conversation.run?.id === runId) {
        conversation.run.status = previousStatus;
        delete conversation.run.resumeQueueAfterStop;
        this.emitState();
      }
      this.logger.error("queue.interrupt-intent-save-failed", "STORE_WRITE_FAILED", {
        name: error instanceof Error ? error.name : "Unknown",
      });
      return "queued";
    }
    this.emitState();

    // A terminal event can win while the durable intent is being written.
    // Never let the delayed action stop the next run promoted from the queue.
    if (conversation.run?.id !== runId) return "interrupted";
    try {
      await this.backend.stop(conversation.id, runId);
      return "interrupted";
    } catch (error) {
      if (conversation.run?.id === runId) {
        conversation.run.status = previousStatus;
        delete conversation.run.resumeQueueAfterStop;
        await this.store.save(conversation).catch((saveError: unknown) => {
          this.logger.error("queue.interrupt-rollback-save-failed", "STORE_WRITE_FAILED", {
            name: saveError instanceof Error ? saveError.name : "Unknown",
          });
        });
        this.emitState();
      }
      this.logger.error("queue.interrupt-stop-failed", "INTERRUPT_STOP_FAILED", {
        name: error instanceof Error ? error.name : "Unknown",
      });
      return "queued";
    }
  }

  async updateQueuedFollowUp(conversationId: string, queueId: string, question: string) {
    const conversation = this.requireConversation(conversationId);
    if (this.dispatchingConversations.has(conversationId)) {
      throw new Ask2GPTError("QUEUE_DISPATCHING", "The next queued message is being sent.");
    }
    const queue = conversation.queuedFollowUps ?? [];
    const index = queue.findIndex((item) => item.id === queueId);
    if (index < 0) return;
    const text = question.trim();
    if (!text) throw new Ask2GPTError("QUESTION_EMPTY", "The message cannot be empty.");
    if (text.length > 20_000) {
      throw new Ask2GPTError("QUESTION_TOO_LONG", "The message is too long.");
    }
    const previous = queue[index]!;
    const previousUpdatedAt = conversation.updatedAt;
    queue[index] = { ...previous, text };
    conversation.updatedAt = new Date().toISOString();
    try {
      await this.store.save(conversation);
      this.emitState();
    } catch (error) {
      queue[index] = previous;
      conversation.updatedAt = previousUpdatedAt;
      throw error;
    }
  }

  async removeQueuedFollowUp(conversationId: string, queueId: string) {
    const conversation = this.requireConversation(conversationId);
    if (this.dispatchingConversations.has(conversationId)) {
      throw new Ask2GPTError("QUEUE_DISPATCHING", "The next queued message is being sent.");
    }
    const queue = conversation.queuedFollowUps ?? [];
    const index = queue.findIndex((item) => item.id === queueId);
    if (index < 0) return;
    const previousUpdatedAt = conversation.updatedAt;
    const previousQueuePaused = conversation.queuePaused;
    const next = queue.filter((item) => item.id !== queueId);
    conversation.queuedFollowUps = next.length > 0 ? next : undefined;
    if (next.length === 0) conversation.queuePaused = undefined;
    conversation.updatedAt = new Date().toISOString();
    try {
      await this.store.save(conversation);
      this.emitState();
    } catch (error) {
      conversation.queuedFollowUps = queue;
      conversation.queuePaused = previousQueuePaused;
      conversation.updatedAt = previousUpdatedAt;
      throw error;
    }
  }

  async resumeQueue(conversationId: string) {
    const conversation = this.requireConversation(conversationId);
    if (!conversation.queuePaused || !conversation.queuedFollowUps?.length) return;
    conversation.queuePaused = undefined;
    try {
      await this.store.save(conversation);
    } catch (error) {
      conversation.queuePaused = true;
      throw error;
    }
    this.emitState();
    await this.dispatchNextQueued(conversation);
  }

  async stop(conversationId: string, targetRunId?: string) {
    const conversation = this.requireConversation(conversationId);
    if (!conversation.run) return;
    if (targetRunId && conversation.run.id !== targetRunId) return;
    if (conversation.run.status === "stopping") return;
    const runId = conversation.run.id;
    const previousStatus = conversation.run.status;
    conversation.run.status = "stopping";
    this.scheduleSave(conversation);
    this.emitState();
    try {
      await this.backend.stop(conversation.id, runId);
    } catch (error) {
      if (conversation.run?.id === runId) {
        conversation.run.status = previousStatus;
        this.scheduleSave(conversation);
        this.emitState();
      }
      throw error;
    }
  }

  async regenerate(conversationId: string, messageId: string) {
    const conversation = this.requireConversation(conversationId);
    if (this.dispatchingConversations.has(conversation.id)) {
      throw new Ask2GPTError(
        "SEND_IN_PROGRESS",
        "The previous request is still being prepared. Please wait and try again.",
      );
    }
    if (conversation.run) {
      throw new Ask2GPTError("CONVERSATION_BUSY", "该会话已有回答正在生成。");
    }
    this.assertGlobalRunCapacity();
    const message = conversation.messages.find(
      (item) => item.id === messageId && item.role === "assistant",
    );
    if (!message) throw new Ask2GPTError("MESSAGE_NOT_FOUND", "找不到可重新生成的回答。");
    if (message.status === "streaming") {
      throw new Ask2GPTError("MESSAGE_BUSY", "该回答仍在生成中。");
    }
    const messageIndex = conversation.messages.indexOf(message);
    const retryUserMessage = isClearlyUnsentRunError(message.runError)
      ? [...conversation.messages.slice(0, messageIndex)]
          .reverse()
          .find((item) => item.role === "user")
      : undefined;
    const retryPlan = retryUserMessage
      ? buildVisiblePromptPlan(retryUserMessage.markdown, retryUserMessage.contexts)
      : undefined;
    this.dispatchingConversations.add(conversation.id);
    try {
      await this.settlePendingRemotePromotionBeforeRun(conversation);
      if (
        this.deletingConversations.has(conversation.id) ||
        !this.conversations.includes(conversation)
      ) {
        throw new Ask2GPTError(
          "CONVERSATION_DELETED",
          "The conversation was deleted while its ChatGPT address was being settled.",
        );
      }
      if (conversation.run) {
        throw new Ask2GPTError(
          "CONVERSATION_BUSY",
          "This conversation started another response while its address was being settled.",
        );
      }
      this.assertGlobalRunCapacity();
    } catch (error) {
      this.dispatchingConversations.delete(conversation.id);
      throw error;
    }
    if (retryUserMessage && retryPlan) {
      return this.retryLocallyRejectedSend(conversation, message, retryUserMessage, retryPlan);
    }
    const previousStatus = message.status;
    const previousRunError = message.runError;
    const previousSyncStatus = conversation.syncStatus;
    const previousUpdatedAt = conversation.updatedAt;
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    message.status = "streaming";
    delete message.runError;
    conversation.run = {
      id: runId,
      messageId: message.id,
      status: "starting",
      startedAt,
      remoteAdoptionStage: "canonicalizing",
    };
    conversation.syncStatus = "syncing";
    conversation.updatedAt = startedAt;

    try {
      await this.store.save(conversation);
      this.emitState();
      this.scheduleRunTimeout(conversation);
      await this.backend.regenerate(conversationId, messageId, runId, conversation.remoteUrl);
    } catch (error) {
      if (conversation.run?.id !== runId) {
        this.logger.info("backend.late-regenerate-rejection");
        return;
      }
      this.clearRunTimer(conversation.id);
      conversation.run = undefined;
      message.status = previousStatus;
      message.runError = previousRunError;
      conversation.syncStatus = previousSyncStatus;
      if (conversation.updatedAt === startedAt) conversation.updatedAt = previousUpdatedAt;
      await this.store.save(conversation).catch((saveError: unknown) => {
        this.logger.error("conversation.rollback-save-failed", "STORE_WRITE_FAILED", {
          name: saveError instanceof Error ? saveError.name : "Unknown",
        });
      });
      this.emitState();
      throw error;
    } finally {
      this.dispatchingConversations.delete(conversation.id);
    }
  }

  private async retryLocallyRejectedSend(
    conversation: Conversation,
    message: ConversationMessage,
    userMessage: ConversationMessage,
    plan: ReturnType<typeof buildVisiblePromptPlan>,
  ) {
    const previousMarkdown = message.markdown;
    const previousStatus = message.status;
    const previousRunError = message.runError;
    const previousContextTransportVersion = userMessage.contextTransportVersion;
    const previousSyncStatus = conversation.syncStatus;
    const previousUpdatedAt = conversation.updatedAt;
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    message.markdown = "";
    message.status = "streaming";
    delete message.runError;
    if (userMessage.contexts?.length) userMessage.contextTransportVersion = 2;
    conversation.run = {
      id: runId,
      messageId: message.id,
      status: "starting",
      startedAt,
      remoteAdoptionStage: conversation.remoteUrl ? "canonicalizing" : "initial",
    };
    conversation.syncStatus = "syncing";
    conversation.updatedAt = startedAt;

    try {
      await this.store.save(conversation);
      this.emitState();
      this.scheduleRunTimeout(conversation);
      await this.backend.send({
        conversationId: conversation.id,
        messageId: userMessage.id,
        runId,
        prompt: plan.prompt,
        attachments: plan.attachments,
        remoteUrl: conversation.remoteUrl,
        modelId: modelIdForDispatch(conversation),
        transcriptProof: buildConversationTranscriptProof(conversation),
      });
    } catch (error) {
      if (conversation.run?.id !== runId) {
        this.logger.info("backend.late-retry-rejection");
        return;
      }
      this.clearRunTimer(conversation.id);
      conversation.run = undefined;
      message.markdown = previousMarkdown;
      message.status = previousStatus;
      message.runError = previousRunError;
      userMessage.contextTransportVersion = previousContextTransportVersion;
      conversation.syncStatus = previousSyncStatus;
      if (conversation.updatedAt === startedAt) conversation.updatedAt = previousUpdatedAt;
      await this.store.save(conversation).catch((saveError: unknown) => {
        this.logger.error("conversation.rollback-save-failed", "STORE_WRITE_FAILED", {
          name: saveError instanceof Error ? saveError.name : "Unknown",
        });
      });
      this.emitState();
      throw error;
    } finally {
      this.dispatchingConversations.delete(conversation.id);
    }
  }

  async refreshBackendStatus() {
    const wasReady = isBackendReady(this.backendStatus);
    this.backendStatus = await this.backend.getStatus();
    this.emitState();
    if (!wasReady && isBackendReady(this.backendStatus)) {
      this.scheduleEligibleQueuedDispatches();
      this.scheduleActiveConversationPreparation();
    }
  }

  async listModels(conversationId = this.activeConversationId) {
    const conversation = this.requireConversation(conversationId);
    return this.refreshModels(conversation, true);
  }

  async selectModel(modelId: string, conversationId = this.activeConversationId) {
    const conversation = this.requireConversation(conversationId);
    const picker = this.getModelPickerState(conversation.id);
    if (!picker.options.some((option) => option.id === modelId)) {
      throw new Ask2GPTError("MODEL_NOT_LISTED", "该模型当前不可用。");
    }
    const targetOption = picker.options.find((option) => option.id === modelId)!;
    this.modelPickers.set(conversation.id, {
      ...picker,
      conversationId: conversation.id,
      status: "ready",
      options: picker.options.map((option) => ({
        ...option,
        selected: option.id === modelId,
      })),
      currentModelId: modelId,
      errorCode: undefined,
      // Catalog discovery can continue invisibly. The actual ChatGPT page
      // switch happens atomically with the next conversation.send command.
      syncing: picker.syncing,
    });
    conversation.selectedModelId = modelId;
    this.scheduleSave(conversation);
    this.emitState();
    return { ...targetOption, selected: true as const };
  }

  dispose() {
    this.disposePromise ??= this.disposeInternal();
    return this.disposePromise;
  }

  private async handleBackendEvent(event: BackendEvent) {
    if (!this.backendEventsReady) {
      this.pendingInitializationEvents.push(event);
      return;
    }
    await this.dispatchBackendEvent(event);
  }

  private async releaseInitializationEvents() {
    while (this.pendingInitializationEvents.length > 0) {
      const batch = this.pendingInitializationEvents.splice(0);
      for (const event of batch) await this.dispatchBackendEvent(event);
    }
    // No async boundary exists between observing an empty queue and enabling
    // direct dispatch, so an event cannot fall into a transition gap.
    this.backendEventsReady = true;
  }

  private async dispatchBackendEvent(event: BackendEvent) {
    const terminalDelivery = terminalDeliveryFromEvent(event);
    if (!terminalDelivery || !("conversationId" in event) || !event.conversationId) {
      await this.handleBackendEventCore(event);
      return;
    }
    const taskKey = `${event.conversationId}:${terminalDelivery.runId}`;
    if (this.terminalRunTasks.has(taskKey)) return;
    this.terminalRunTasks.add(taskKey);
    try {
      await this.handleBackendEventCore(event);
    } finally {
      this.terminalRunTasks.delete(taskKey);
    }
  }

  private async handleBackendEventCore(event: BackendEvent) {
    if (this.disposed) return;
    if (event.type === "status") {
      const wasReady = isBackendReady(this.backendStatus);
      const nextStatus: BackendStatus = {
        ...this.backendStatus,
        ...event.status,
        connection: event.status.connection ?? this.backendStatus.connection,
        error:
          event.status.authenticated ||
          event.status.connection?.phase === "pairing-required" ||
          event.status.connection?.phase === "authenticating" ||
          event.status.connection?.phase === "syncing"
            ? undefined
            : this.backendStatus.error,
      };
      if (event.status.authenticated) await this.flushPendingTabCloses();
      const statusChanged = !backendStatusesEqual(this.backendStatus, nextStatus);
      this.backendStatus = nextStatus;
      if (statusChanged) this.emitState();
      const isReady = isBackendReady(this.backendStatus);
      if (isReady && !wasReady) {
        this.scheduleEligibleQueuedDispatches();
        this.scheduleActiveConversationPreparation();
      }
      return;
    }

    if (event.type === "error" && !event.conversationId) {
      const reportedStatus = await this.backend.getStatus();
      this.backendStatus = {
        ...reportedStatus,
        error: event.error,
        connection: {
          ...reportedStatus.connection,
          phase:
            event.error.code === "PROTOCOL_MISMATCH"
              ? "version-mismatch"
              : event.error.code === "PAIRING_MISMATCH" || event.error.code === "AUTH_FAILED"
                ? "trust-mismatch"
                : "attention",
          errorCode: event.error.code,
        },
      };
      this.emitState();
      return;
    }
    if (!event.conversationId) return;
    const terminalDelivery = terminalDeliveryFromEvent(event);
    const conversation = this.conversations.find((item) => item.id === event.conversationId);
    if (!conversation || this.deletingConversations.has(event.conversationId)) {
      if (terminalDelivery) {
        await this.backend.acknowledgeTerminal(
          event.conversationId,
          terminalDelivery.runId,
          terminalDelivery.eventId,
        );
      }
      return;
    }
    if (
      terminalDelivery &&
      conversation.messages.some(
        (message) =>
          message.terminalReceipt?.eventId === terminalDelivery.eventId &&
          message.terminalReceipt.runId === terminalDelivery.runId &&
          message.terminalReceipt.terminalType === terminalDelivery.terminalType,
      )
    ) {
      // Re-saving makes an in-memory receipt durable if an earlier disk write
      // failed. After a Host restart this is idempotent and simply proves the
      // already-applied terminal state before acknowledging a replay.
      await this.store.save(conversation);
      await this.backend.acknowledgeTerminal(
        conversation.id,
        terminalDelivery.runId,
        terminalDelivery.eventId,
      );
      this.scheduleEligibleQueuedDispatches();
      return;
    }
    const conflictingReceipt = terminalDelivery
      ? conversation.messages.find(
          (message) =>
            message.terminalReceipt?.runId === terminalDelivery.runId &&
            message.terminalReceipt.eventId !== terminalDelivery.eventId,
        )?.terminalReceipt
      : undefined;
    if (terminalDelivery && conflictingReceipt) {
      this.logger.error("relay.conflicting-terminal-rejected", "TERMINAL_EVENT_CONFLICT", {
        previousType: conflictingReceipt.terminalType,
        incomingType: terminalDelivery.terminalType,
      });
      await this.backend.acknowledgeTerminal(
        conversation.id,
        terminalDelivery.runId,
        terminalDelivery.eventId,
      );
      this.scheduleEligibleQueuedDispatches();
      return;
    }
    if (terminalDelivery && conversation.run?.id !== terminalDelivery.runId) {
      this.logger.info("relay.stale-terminal-discarded", {
        terminalType: terminalDelivery.terminalType,
      });
      await this.backend.acknowledgeTerminal(
        conversation.id,
        terminalDelivery.runId,
        terminalDelivery.eventId,
      );
      return;
    }

    if (event.type === "title") {
      const remoteUrl = normalizeRemoteTitleUrl(event.remoteUrl);
      const title = normalizeRemoteTitle(event.title);
      const observedAt = normalizeObservedAt(event.observedAt);
      if (
        !remoteUrl ||
        !title ||
        (conversation.remoteUrl !== undefined &&
          !isSameRemoteConversation(conversation.remoteUrl, remoteUrl))
      ) {
        this.logger.error("relay.stale-title-rejected", "REMOTE_TITLE_REJECTED");
        return;
      }
      if (conversation.lastSyncedAt && isOlderTimestamp(observedAt, conversation.lastSyncedAt)) {
        this.logger.info("relay.stale-title-ignored");
        return;
      }
      const acceptRemoteTitle = conversation.titleSource !== "local";
      if (
        conversation.remoteUrl === remoteUrl &&
        (!acceptRemoteTitle ||
          (conversation.title === title && conversation.titleSource === "chatgpt"))
      ) {
        return;
      }

      const previousRemoteUrl = conversation.remoteUrl;
      const previousTitle = conversation.title;
      const previousTitleSource = conversation.titleSource;
      conversation.remoteUrl = remoteUrl;
      if (acceptRemoteTitle) {
        conversation.title = title;
        conversation.titleSource = "chatgpt";
      }
      try {
        await this.persistConversation(conversation);
      } catch (error) {
        if (conversation.remoteUrl === remoteUrl) conversation.remoteUrl = previousRemoteUrl;
        if (acceptRemoteTitle && conversation.title === title) {
          conversation.title = previousTitle;
          conversation.titleSource = previousTitleSource;
        }
        throw error;
      }
      this.emitState();
      return;
    }

    if (event.type === "history") {
      const remoteUrl = normalizeRemoteTitleUrl(event.remoteUrl);
      const remoteMismatch = Boolean(
        remoteUrl &&
        conversation.remoteUrl &&
        !isSameRemoteConversation(conversation.remoteUrl, remoteUrl),
      );
      if (!remoteUrl) {
        this.logger.error("relay.stale-history-rejected", "REMOTE_HISTORY_REJECTED");
        return;
      }

      const title = event.title === undefined ? undefined : normalizeRemoteTitle(event.title);
      const acceptRemoteTitle = title !== undefined && conversation.titleSource !== "local";
      const observedAt = normalizeObservedAt(event.observedAt);
      if (conversation.lastSyncedAt && isOlderTimestamp(observedAt, conversation.lastSyncedAt)) {
        this.logger.info("relay.stale-history-ignored");
        return;
      }
      // A correlated complete event is the authority for the answer the user
      // has just seen. The Relay can still finish an older, partial transcript
      // inspection after that terminal event; applying it here could truncate
      // the answer or rebind the local conversation to the stale tab. Wait for
      // a complete history snapshot before reconciling terminal-backed state.
      if (!event.complete && hasCompletedTerminalAnswer(conversation)) {
        this.logger.info("relay.post-terminal-partial-history-ignored");
        return;
      }
      const canRebuildAuthoritatively = event.complete && !conversation.run;
      // During an active run the page can expose only a virtualized suffix of
      // the transcript. Treating that suffix as a prefix can match repeated
      // prompts to an older turn and overwrite its assistant. The correlated
      // generation events are the sole authority for the in-flight user and
      // assistant pair; the terminal flow requests a fresh history snapshot
      // after the run has settled.
      const merged = conversation.run
        ? { messages: conversation.messages, changed: false }
        : canRebuildAuthoritatively
          ? rebuildCompleteRemoteHistory(conversation.messages, event.messages, observedAt)
          : mergeIncompleteRemoteHistory(conversation.messages, event.messages, observedAt);
      const remoteUrlChanged = conversation.remoteUrl !== remoteUrl;
      const titleChanged =
        acceptRemoteTitle &&
        (conversation.title !== title || conversation.titleSource !== "chatgpt");
      const syncStatus = canRebuildAuthoritatively ? "synced" : "partial";
      const syncChanged =
        conversation.syncStatus !== syncStatus || conversation.lastSyncedAt !== observedAt;
      if (!remoteUrlChanged && !titleChanged && !merged.changed && !syncChanged) return;

      const previous = {
        remoteUrl: conversation.remoteUrl,
        title: conversation.title,
        titleSource: conversation.titleSource,
        syncStatus: conversation.syncStatus,
        lastSyncedAt: conversation.lastSyncedAt,
        messages: conversation.messages,
        updatedAt: conversation.updatedAt,
        pendingRemotePromotion: conversation.pendingRemotePromotion,
      };
      conversation.remoteUrl = remoteUrl;
      if (acceptRemoteTitle) {
        conversation.title = title;
        conversation.titleSource = "chatgpt";
      }
      conversation.syncStatus = syncStatus;
      conversation.lastSyncedAt = observedAt;
      if (merged.changed) {
        conversation.messages = merged.messages;
        conversation.updatedAt = newestTimestamp(conversation.updatedAt, observedAt);
      }
      delete conversation.pendingRemotePromotion;
      if (canRebuildAuthoritatively) this.clearSaveTimer(conversation.id);
      try {
        await this.persistConversation(conversation);
      } catch (error) {
        conversation.remoteUrl = previous.remoteUrl;
        conversation.title = previous.title;
        conversation.titleSource = previous.titleSource;
        conversation.syncStatus = previous.syncStatus;
        conversation.lastSyncedAt = previous.lastSyncedAt;
        conversation.messages = previous.messages;
        conversation.updatedAt = previous.updatedAt;
        conversation.pendingRemotePromotion = previous.pendingRemotePromotion;
        throw error;
      }
      if (remoteMismatch) {
        this.logger.info("relay.remote-session-rebound");
      }
      this.emitState();
      return;
    }

    if (event.type === "error") {
      if (!event.runId) {
        if (conversation.run) {
          this.logger.info("relay.conversation-error-during-run", {
            code: event.error.code,
          });
          return;
        }
        if (conversation.syncStatus === "error") return;
        conversation.syncStatus = "error";
        await this.persistConversation(conversation);
        this.logger.error("relay.conversation-sync-error", event.error.code, {
          recoverable: event.error.recoverable,
        });
        this.emitState();
        return;
      }
      if (!conversation.run || !event.runId || conversation.run.id !== event.runId) {
        this.logger.info("relay.stale-run-error", {
          code: event.error.code,
        });
        return;
      }
      const failedMessage = conversation.messages.find(
        (message) => message.id === conversation.run?.messageId,
      );
      if (!failedMessage || !terminalDelivery) return;
      this.clearSaveTimer(conversation.id);
      this.clearRunTimer(conversation.id);
      failedMessage.terminalReceipt = terminalDelivery;
      this.finishWithError(conversation, event.error);
      // The terminal failure is already authoritative in memory. Publish it
      // immediately so a slow encrypted write cannot leave the webview showing
      // a run that has already ended. The Chrome ACK still waits for durable
      // persistence, preserving terminal replay safety.
      this.emitState();
      await this.store.save(conversation);
      await this.backend.acknowledgeTerminal(
        conversation.id,
        terminalDelivery.runId,
        terminalDelivery.eventId,
      );
      this.scheduleEligibleQueuedDispatches();
      return;
    }
    if (!conversation.run || conversation.run.id !== event.runId) return;
    const message = conversation.messages.find((item) => item.id === conversation.run?.messageId);
    if (!message) return;

    if (event.remoteUrl) {
      const remoteUrl = normalizeRemoteUrl(event.remoteUrl);
      if (!remoteUrl || !this.acceptRunRemoteUrl(conversation, remoteUrl)) {
        this.logger.error(
          remoteUrl ? "relay.stale-remote-url-rejected" : "relay.remote-url-rejected",
          "REMOTE_URL_REJECTED",
        );
        if (event.type === "complete" || event.type === "stopped") {
          this.clearSaveTimer(conversation.id);
          this.clearRunTimer(conversation.id);
          message.terminalReceipt = terminalDelivery!;
          this.finishWithError(conversation, {
            code: "CHATGPT_REMOTE_UNAVAILABLE",
            message: "关联会话已发生变化；未接受无法验证的回答。",
            recoverable: true,
            focusTab: true,
          });
          // The terminal state is already authoritative in memory. Do not
          // leave the webview spinning behind a slow encrypted write; the ACK
          // still waits for that write to finish successfully.
          this.emitState();
          await this.store.save(conversation);
          await this.backend.acknowledgeTerminal(
            conversation.id,
            terminalDelivery!.runId,
            terminalDelivery!.eventId,
          );
          this.scheduleEligibleQueuedDispatches();
        }
        return;
      }
    }
    if (event.type === "slow") {
      conversation.run.softTimeoutNotified = true;
      this.scheduleSave(conversation);
    } else if (event.type === "snapshot") {
      const isFirstSnapshot = message.markdown.length === 0;
      this.recordRunSnapshot(conversation.run.id, event.markdown);
      message.markdown = event.markdown;
      message.status = "streaming";
      delete message.runError;
      // A late snapshot may race with a user stop request. Keep the stop
      // latch authoritative so repeated UI messages cannot dispatch another
      // stop for the same run while content already in flight is rendered.
      if (conversation.run.status !== "stopping") {
        conversation.run.status = "streaming";
      }
      conversation.syncStatus = "syncing";
      conversation.updatedAt = new Date().toISOString();
      if (isFirstSnapshot) {
        this.logRunDuration("run.first-snapshot", conversation.run.startedAt);
      }
      this.scheduleSave(conversation);
      this.generationEvents.emit("update", {
        conversationId: conversation.id,
        messageId: message.id,
        runId: conversation.run.id,
        markdown: message.markdown,
        updatedAt: conversation.updatedAt,
      } satisfies GenerationViewUpdate);
    } else if (event.type === "complete") {
      if (!message.markdown) {
        this.logRunDuration("run.first-snapshot", conversation.run.startedAt);
      }
      this.logRunDuration("run.completed", conversation.run.startedAt);
      this.logRunStreamSummary(conversation.run.id, event.markdown);
      this.clearSaveTimer(conversation.id);
      this.clearRunTimer(conversation.id);
      message.markdown = event.markdown;
      message.status = "complete";
      delete message.runError;
      message.terminalReceipt = terminalDelivery!;
      delete conversation.pendingRemotePromotion;
      conversation.run = undefined;
      conversation.syncStatus = "partial";
      conversation.updatedAt = new Date().toISOString();
      // The answer is already present in memory. Do not keep the completed UI
      // behind an older checkpoint write; persistence still runs immediately
      // and remains serialized by ConversationStore.
      this.emitState();
      await this.store.save(conversation);
      await this.backend.acknowledgeTerminal(
        conversation.id,
        terminalDelivery!.runId,
        terminalDelivery!.eventId,
      );
      try {
        await this.dispatchNextQueued(conversation);
      } finally {
        this.scheduleEligibleQueuedDispatches();
      }
    } else if (event.type === "stopped") {
      this.logRunStreamSummary(conversation.run.id, event.markdown);
      this.clearSaveTimer(conversation.id);
      this.clearRunTimer(conversation.id);
      if (event.markdown) message.markdown = event.markdown;
      message.status = "stopped";
      delete message.runError;
      message.terminalReceipt = terminalDelivery!;
      delete conversation.pendingRemotePromotion;
      const resumeQueueAfterStop = conversation.run.resumeQueueAfterStop === true;
      conversation.run = undefined;
      if (conversation.queuedFollowUps?.length) {
        conversation.queuePaused = resumeQueueAfterStop ? undefined : true;
      }
      conversation.syncStatus = "partial";
      conversation.updatedAt = new Date().toISOString();
      this.emitState();
      await this.store.save(conversation);
      await this.backend.acknowledgeTerminal(
        conversation.id,
        terminalDelivery!.runId,
        terminalDelivery!.eventId,
      );
      if (resumeQueueAfterStop) {
        try {
          await this.dispatchNextQueued(conversation);
        } finally {
          this.scheduleEligibleQueuedDispatches();
        }
      } else {
        this.scheduleEligibleQueuedDispatches();
      }
    }

    // Streaming text uses a compact update so large historical context bundles
    // are not cloned across the Extension Host boundary every 120 ms.
    if (event.type === "slow") {
      this.emitState();
    }
  }

  private getModelPickerState(conversationId: string): ModelPickerState {
    const existing = this.modelPickers.get(conversationId);
    if (existing) return existing;
    const conversation = this.conversations.find((item) => item.id === conversationId);
    const options = mergeChatGptModeOptions(this.modelCatalog ?? []);
    const currentModelId = conversation
      ? (preferredModelSelection(conversation, options) ?? DEFAULT_CHATGPT_MODE_ID)
      : DEFAULT_CHATGPT_MODE_ID;
    return {
      conversationId,
      status: "ready",
      options: markSelectedModel(options, currentModelId),
      currentModelId,
      syncing: false,
      stale: !this.modelCatalog?.length,
    };
  }

  private seedModelPicker(conversationId: string) {
    if (this.modelPickers.has(conversationId)) return;
    const conversation = this.conversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    const catalog = mergeChatGptModeOptions(this.modelCatalog ?? []);
    const currentModelId =
      preferredModelSelection(conversation, catalog) ?? DEFAULT_CHATGPT_MODE_ID;
    const options = markSelectedModel(catalog, currentModelId);
    this.modelPickers.set(conversationId, {
      conversationId,
      status: "ready",
      options,
      currentModelId,
      syncing: false,
      stale: !this.modelCatalog?.length,
    });
  }

  private refreshModels(conversation: Conversation, userInitiated: boolean) {
    const existing = this.modelPrefetches.get(conversation.id);
    if (existing) return existing;
    this.setModelPicker(conversation.id, {
      status: "ready",
      syncing: true,
      stale: true,
      ...(userInitiated ? { errorCode: undefined } : {}),
    });
    this.emitState();
    const request = this.backend
      .listModels(conversation.id, conversation.remoteUrl)
      .then((options) => {
        this.modelCatalog = options.map((option) => ({ ...option }));
        const mergedOptions = mergeChatGptModeOptions(options);
        const currentModelId =
          preferredModelSelection(conversation, mergedOptions) ?? DEFAULT_CHATGPT_MODE_ID;
        const scopedOptions = markSelectedModel(mergedOptions, currentModelId);
        this.modelPickers.set(conversation.id, {
          conversationId: conversation.id,
          status: "ready",
          options: scopedOptions,
          currentModelId,
          syncing: false,
          stale: false,
        });
        this.emitState();
        return options;
      })
      .catch((error: unknown) => {
        const current = this.getModelPickerState(conversation.id);
        if (current.options.length > 0) {
          this.setModelPicker(conversation.id, {
            status: "ready",
            syncing: false,
            stale: true,
            errorCode: modelPickerErrorCode(error),
          });
          this.emitState();
          return current.options;
        }
        this.setModelPicker(conversation.id, {
          status:
            modelPickerErrorCode(error) === "CHATGPT_MODEL_UNAVAILABLE" ? "unavailable" : "error",
          errorCode: modelPickerErrorCode(error),
          syncing: false,
          stale: true,
        });
        this.emitState();
        throw error;
      })
      .finally(() => this.modelPrefetches.delete(conversation.id));
    this.modelPrefetches.set(conversation.id, request);
    return request;
  }

  private setModelPicker(
    conversationId: string,
    update: Partial<Omit<ModelPickerState, "conversationId">>,
  ) {
    const current = this.getModelPickerState(conversationId);
    this.modelPickers.set(conversationId, { ...current, ...update, conversationId });
  }

  private scheduleActiveConversationPreparation() {
    const conversation = this.activeConversation;
    if (
      !conversation ||
      this.disposed ||
      !isBackendReady(this.backendStatus) ||
      conversation.archivedAt ||
      conversation.run ||
      this.dispatchingConversations.has(conversation.id) ||
      this.deletingConversations.has(conversation.id) ||
      this.archivingConversations.has(conversation.id) ||
      this.conversationPreparations.has(conversation.id)
    ) {
      return;
    }

    const startedAt = Date.now();
    const task = this.backend
      .prepareConversation(
        conversation.id,
        conversation.remoteUrl,
        buildConversationTranscriptProof(conversation),
      )
      .then(async () => {
        this.logger.info("conversation.prewarm-dispatched", {
          durationMs: Math.max(0, Date.now() - startedAt),
        });
        // Resolve the default Fast mapping before the user presses Send. This
        // also covers a restored explicit tier, so catalog inspection stays
        // outside the latency-sensitive dispatch path whenever possible.
        if (
          !this.disposed &&
          !conversation.run &&
          !this.dispatchingConversations.has(conversation.id) &&
          !hasResolvedDispatchModel(this.modelCatalog, modelIdForDispatch(conversation))
        ) {
          await this.refreshModels(conversation, false);
        }
      })
      .catch((error: unknown) => {
        this.logger.error("conversation.prewarm-dispatch-failed", "CHATGPT_REMOTE_UNAVAILABLE", {
          name: error instanceof Error ? error.name : "Unknown",
        });
      })
      .finally(() => {
        this.conversationPreparations.delete(conversation.id);
      });
    this.conversationPreparations.set(conversation.id, task);
    this.backendTasks.add(task);
    void task.finally(() => this.backendTasks.delete(task));
  }

  private logRunDuration(event: string, startedAt: string) {
    const parsed = Date.parse(startedAt);
    if (!Number.isFinite(parsed)) return;
    this.logger.info(event, {
      durationMs: Math.max(0, Date.now() - parsed),
    });
  }

  private recordRunSnapshot(runId: string, markdown: string) {
    const now = Date.now();
    const current = this.runStreamMetrics.get(runId);
    if (!current) {
      this.runStreamMetrics.set(runId, {
        snapshots: 1,
        firstSnapshotAt: now,
        lastSnapshotAt: now,
        lastMarkdownLength: markdown.length,
        maxGapMs: 0,
        maxChunkChars: markdown.length,
      });
      return;
    }

    current.snapshots += 1;
    current.maxGapMs = Math.max(current.maxGapMs, Math.max(0, now - current.lastSnapshotAt));
    current.maxChunkChars = Math.max(
      current.maxChunkChars,
      Math.abs(markdown.length - current.lastMarkdownLength),
    );
    current.lastSnapshotAt = now;
    current.lastMarkdownLength = markdown.length;
  }

  private logRunStreamSummary(runId: string, terminalMarkdown = "") {
    const now = Date.now();
    const metrics = this.runStreamMetrics.get(runId);
    this.runStreamMetrics.delete(runId);
    if (!metrics) {
      this.logger.info("run.stream-summary", {
        snapshots: 0,
        streamDurationMs: 0,
        averageGapMs: 0,
        maxGapMs: 0,
        maxChunkChars: terminalMarkdown.length,
      });
      return;
    }

    const streamDurationMs = Math.max(0, now - metrics.firstSnapshotAt);
    const terminalGapMs = Math.max(0, now - metrics.lastSnapshotAt);
    this.logger.info("run.stream-summary", {
      snapshots: metrics.snapshots,
      streamDurationMs,
      averageGapMs: Math.round(streamDurationMs / Math.max(1, metrics.snapshots)),
      maxGapMs: Math.max(metrics.maxGapMs, terminalGapMs),
      maxChunkChars: Math.max(
        metrics.maxChunkChars,
        Math.abs(terminalMarkdown.length - metrics.lastMarkdownLength),
      ),
    });
  }

  private async settlePendingRemotePromotionBeforeRun(conversation: Conversation) {
    if (!conversation.pendingRemotePromotion) return;
    // v7 stored a timer-based URL settlement marker in the Host. The live
    // Chrome tab and its visible transcript are now authoritative, so this
    // legacy marker must not poison every future send after a valid redirect.
    delete conversation.pendingRemotePromotion;
    await this.store.save(conversation);
    this.emitState();
  }

  private scheduleQueuedDispatch(conversation: Conversation) {
    if (
      this.disposed ||
      conversation.run ||
      conversation.queuePaused ||
      !conversation.queuedFollowUps?.length ||
      this.dispatchingConversations.has(conversation.id)
    ) {
      return;
    }
    const task = this.dispatchNextQueued(conversation).catch((error: unknown) => {
      this.logger.error("queue.dispatch-failed", "QUEUED_FOLLOW_UP_FAILED", {
        name: error instanceof Error ? error.name : "Unknown",
      });
    });
    this.backendTasks.add(task);
    void task.finally(() => this.backendTasks.delete(task));
  }

  private scheduleEligibleQueuedDispatches() {
    for (const conversation of this.conversations) this.scheduleQueuedDispatch(conversation);
  }

  private async dispatchNextQueued(conversation: Conversation) {
    if (
      this.disposed ||
      !isBackendReady(this.backendStatus) ||
      conversation.run ||
      conversation.queuePaused ||
      !conversation.queuedFollowUps?.length ||
      this.dispatchingConversations.has(conversation.id) ||
      this.deletingConversations.has(conversation.id)
    ) {
      return;
    }
    if (this.conversations.filter((item) => item.run).length >= MAX_CONCURRENT_RUNS) return;

    const originalQueue = [...conversation.queuedFollowUps];
    const queued = originalQueue[0]!;
    const attachedContexts = queued.contexts.map((context) => ({ ...context }));
    const sendPlan = buildVisiblePromptPlan(queued.text, attachedContexts);
    const originalTitle = conversation.title;
    const originalTitleSource = conversation.titleSource;
    const originalSyncStatus = conversation.syncStatus;
    const originalUpdatedAt = conversation.updatedAt;
    let automaticTitle = conversation.title;
    let attemptedAt: string | undefined;
    let userMessage: ConversationMessage | undefined;
    let assistantMessage: ConversationMessage | undefined;
    let runId: string | undefined;

    this.dispatchingConversations.add(conversation.id);
    this.emitState();
    try {
      await this.settlePendingRemotePromotionBeforeRun(conversation);
      if (
        this.disposed ||
        this.deletingConversations.has(conversation.id) ||
        !this.conversations.includes(conversation) ||
        conversation.run
      ) {
        return;
      }
      if (this.conversations.filter((item) => item.run).length >= MAX_CONCURRENT_RUNS) return;

      attemptedAt = new Date().toISOString();
      userMessage = {
        id: randomUUID(),
        clientRequestId: queued.id,
        role: "user",
        markdown: queued.text,
        status: "complete",
        createdAt: attemptedAt,
        ...(attachedContexts.length > 0
          ? { contexts: attachedContexts, contextTransportVersion: 2 as const }
          : {}),
      };
      conversation.messages.push(userMessage);
      this.updateAutomaticTitle(conversation, queued.text);
      automaticTitle = conversation.title;
      assistantMessage = {
        id: randomUUID(),
        role: "assistant",
        markdown: "",
        status: "streaming",
        createdAt: attemptedAt,
      };
      runId = randomUUID();
      conversation.messages.push(assistantMessage);
      conversation.run = {
        id: runId,
        messageId: assistantMessage.id,
        status: "starting",
        startedAt: attemptedAt,
        remoteAdoptionStage: conversation.remoteUrl ? "canonicalizing" : "initial",
      };
      const remainingQueue = originalQueue.slice(1);
      conversation.queuedFollowUps = remainingQueue.length > 0 ? remainingQueue : undefined;
      conversation.queuePaused = undefined;
      conversation.syncStatus = "syncing";
      conversation.updatedAt = attemptedAt;
      this.emitState();

      await this.store.save(conversation);
      this.scheduleRunTimeout(conversation);
      await this.backend.send({
        conversationId: conversation.id,
        messageId: userMessage.id,
        runId,
        prompt: sendPlan.prompt,
        attachments: sendPlan.attachments,
        remoteUrl: conversation.remoteUrl,
        modelId: queued.selectedModelId ?? DEFAULT_CHATGPT_MODE_ID,
        transcriptProof: buildConversationTranscriptProof(conversation),
      });
      this.logger.info("queue.follow-up-dispatched");
    } catch (error) {
      if (runId && conversation.run?.id !== runId) {
        this.logger.info("queue.late-dispatch-rejection");
        return;
      }
      if (runId) this.clearRunTimer(conversation.id);
      if (userMessage && assistantMessage) {
        const ids = new Set([userMessage.id, assistantMessage.id]);
        conversation.messages = conversation.messages.filter((message) => !ids.has(message.id));
      }
      if (runId && conversation.run?.id === runId) conversation.run = undefined;
      if (conversation.title === automaticTitle) {
        conversation.title = originalTitle;
        conversation.titleSource = originalTitleSource;
      }
      if (conversation.syncStatus === "syncing") {
        conversation.syncStatus = originalSyncStatus;
      }
      if (attemptedAt && conversation.updatedAt === attemptedAt) {
        conversation.updatedAt = originalUpdatedAt;
      }
      conversation.queuedFollowUps = originalQueue;
      conversation.queuePaused = true;
      await this.store.save(conversation).catch((saveError: unknown) => {
        this.logger.error("queue.rollback-save-failed", "STORE_WRITE_FAILED", {
          name: saveError instanceof Error ? saveError.name : "Unknown",
        });
      });
      this.emitState();
      throw error;
    } finally {
      this.dispatchingConversations.delete(conversation.id);
      this.emitState();
      if (
        runId &&
        !conversation.run &&
        !conversation.queuePaused &&
        conversation.queuedFollowUps?.length
      ) {
        this.scheduleQueuedDispatch(conversation);
      }
    }
  }

  private finishWithError(conversation: Conversation, error: RelayErrorPayload) {
    if (conversation.run) {
      const message = conversation.messages.find((item) => item.id === conversation.run?.messageId);
      this.logRunStreamSummary(conversation.run.id, message?.markdown);
      if (message) {
        message.status = "error";
        message.runError = { ...error };
      }
    }
    delete conversation.pendingRemotePromotion;
    conversation.run = undefined;
    if (conversation.queuedFollowUps?.length) conversation.queuePaused = true;
    conversation.syncStatus = "error";
    conversation.updatedAt = new Date().toISOString();
    this.logger.error("relay.run-error", error.code, {
      recoverable: error.recoverable,
      message: error.message,
    });
  }

  private acceptRunRemoteUrl(conversation: Conversation, remoteUrl: string) {
    const run = conversation.run;
    if (!run) return false;

    run.remoteAdoptionStage ??= conversation.remoteUrl ? "locked" : "initial";
    // Chrome has already matched this event to the exact local conversation,
    // run id and owned tab. Treat its current visible ChatGPT route as live
    // session metadata; it may change more than once and after long answers.
    conversation.remoteUrl = remoteUrl;
    run.remoteAdoptionStage = "canonicalizing";
    delete run.canonicalizationExpiresAt;
    return true;
  }

  private scheduleSave(conversation: Conversation) {
    if (
      this.disposed ||
      this.deletingConversations.has(conversation.id) ||
      this.archivingConversations.has(conversation.id) ||
      Boolean(conversation.archivedAt) ||
      !hasVisibleConversationMessages(conversation)
    ) {
      return;
    }
    const now = Date.now();
    const windowStartedAt = this.saveWindows.get(conversation.id) ?? now;
    this.saveWindows.set(conversation.id, windowStartedAt);
    const existing = this.saveTimers.get(conversation.id);
    if (existing) clearTimeout(existing);
    const maxWaitRemaining = Math.max(0, SAVE_MAX_WAIT_MS - (now - windowStartedAt));
    const delay = Math.min(SAVE_TRAILING_DELAY_MS, maxWaitRemaining);
    this.saveTimers.set(
      conversation.id,
      setTimeout(() => {
        this.saveTimers.delete(conversation.id);
        this.saveWindows.delete(conversation.id);
        if (
          this.disposed ||
          this.deletingConversations.has(conversation.id) ||
          this.archivingConversations.has(conversation.id) ||
          conversation.archivedAt
        ) {
          return;
        }
        void this.store.save(conversation).catch((error: unknown) => {
          this.logger.error("conversation.save-failed", "STORE_WRITE_FAILED", {
            name: error instanceof Error ? error.name : "Unknown",
          });
        });
      }, delay),
    );
  }

  private persistConversation(conversation: Conversation) {
    // A conversation becomes history only when it contains a visible turn.
    // If a failed first dispatch rolled the turn back, remove the temporary
    // encrypted checkpoint instead of leaving an empty history record.
    return !hasVisibleConversationMessages(conversation)
      ? this.store.delete(conversation.id)
      : this.store.save(conversation);
  }

  private clearSaveTimer(conversationId: string) {
    const timer = this.saveTimers.get(conversationId);
    if (timer) clearTimeout(timer);
    this.saveTimers.delete(conversationId);
    this.saveWindows.delete(conversationId);
  }

  private scheduleRunTimeout(conversation: Conversation) {
    this.clearRunTimer(conversation.id);
    if (!conversation.run || this.disposed) return;
    const runId = conversation.run.id;
    const elapsed = Date.now() - Date.parse(conversation.run.startedAt);
    const remaining = Math.max(0, HARD_RUN_TIMEOUT_MS - elapsed);
    const timer = setTimeout(() => {
      this.runTimers.delete(conversation.id);
      void this.expireRun(conversation.id, runId);
    }, remaining);
    this.runTimers.set(conversation.id, timer);
  }

  private clearRunTimer(conversationId: string) {
    const timer = this.runTimers.get(conversationId);
    if (timer) clearTimeout(timer);
    this.runTimers.delete(conversationId);
  }

  private async expireRun(conversationId: string, runId: string) {
    if (this.disposed || this.deletingConversations.has(conversationId)) return;
    const conversation = this.conversations.find((item) => item.id === conversationId);
    if (!conversation?.run || conversation.run.id !== runId) return;
    const message = conversation.messages.find(
      (item) => item.id === conversation.run?.messageId && item.role === "assistant",
    );
    this.logRunStreamSummary(runId, message?.markdown);
    if (message) {
      message.status = "error";
      message.runError ??= {
        code: "RESPONSE_TIMEOUT",
        message: "等待回答超过 30 分钟；远端会话和标签页仍予以保留。",
        recoverable: true,
      };
    }
    delete conversation.pendingRemotePromotion;
    conversation.run = undefined;
    if (conversation.queuedFollowUps?.length) conversation.queuePaused = true;
    conversation.syncStatus = "error";
    conversation.updatedAt = new Date().toISOString();
    this.clearSaveTimer(conversation.id);
    try {
      await this.store.save(conversation);
    } catch (error) {
      this.logger.error("conversation.timeout-save-failed", "STORE_WRITE_FAILED", {
        name: error instanceof Error ? error.name : "Unknown",
      });
    }
    this.emitState();
    this.scheduleEligibleQueuedDispatches();
  }

  private reconcileLoadedRun(conversation: Conversation) {
    let changed = false;
    if (conversation.pendingRemotePromotion) {
      delete conversation.pendingRemotePromotion;
      changed = true;
    }
    const run = conversation.run;
    if (run) {
      const message = conversation.messages.find(
        (item) => item.id === run.messageId && item.role === "assistant",
      );
      const parsedStartedAt = Date.parse(run.startedAt);
      const elapsed = Date.now() - parsedStartedAt;
      const expired =
        !Number.isFinite(parsedStartedAt) || elapsed < -60_000 || elapsed >= HARD_RUN_TIMEOUT_MS;
      const hasRemoteUrl = Boolean(conversation.remoteUrl);
      if (!run.remoteAdoptionStage) {
        run.remoteAdoptionStage = hasRemoteUrl ? "canonicalizing" : "initial";
        changed = true;
      }
      if (run.remoteAdoptionStage === "initial" && hasRemoteUrl) {
        run.remoteAdoptionStage = "canonicalizing";
        changed = true;
      } else if (run.remoteAdoptionStage === "canonicalizing" && !hasRemoteUrl) {
        run.remoteAdoptionStage = "locked";
        delete run.canonicalizationExpiresAt;
        changed = true;
      }
      if (run.canonicalizationExpiresAt) {
        delete run.canonicalizationExpiresAt;
        changed = true;
      }
      const invalidRemoteAdoption = run.remoteAdoptionStage === "locked" && !hasRemoteUrl;
      if (
        !message ||
        run.status === "error" ||
        message.status === "complete" ||
        message.status === "stopped" ||
        message.status === "error" ||
        expired ||
        invalidRemoteAdoption
      ) {
        if (message && message.status === "streaming") {
          message.status = "error";
          message.runError ??= {
            code: expired ? "RESPONSE_TIMEOUT" : "CHATGPT_REMOTE_UNAVAILABLE",
            message: expired
              ? "上次回答已超过恢复时限；远端会话仍予以保留。"
              : "上次生成未能恢复；远端会话仍予以保留。",
            recoverable: true,
          };
        }
        conversation.run = undefined;
        if (conversation.queuedFollowUps?.length) conversation.queuePaused = true;
        conversation.syncStatus = "error";
        changed = true;
      }
    }

    if (!conversation.run) {
      for (const message of conversation.messages) {
        if (message.role === "assistant" && message.status === "streaming") {
          message.status = "error";
          message.runError ??= {
            code: "CHATGPT_REMOTE_UNAVAILABLE",
            message: "上次生成在状态恢复前中断。",
            recoverable: true,
          };
          if (conversation.queuedFollowUps?.length) conversation.queuePaused = true;
          conversation.syncStatus = "error";
          changed = true;
        }
      }
    }
    return changed;
  }

  private rollbackSend(
    conversation: Conversation,
    messageIds: string[],
    originalTitle: string,
    originalTitleSource: Conversation["titleSource"],
    originalSyncStatus: Conversation["syncStatus"],
    automaticTitle: string,
    originalUpdatedAt: string,
    attemptedAt: string,
    attachedContexts: readonly ContextSnapshot[],
    attachedDraft: DraftContextState,
  ) {
    const ids = new Set(messageIds);
    conversation.messages = conversation.messages.filter((message) => !ids.has(message.id));
    if (conversation.run && ids.has(conversation.run.messageId)) {
      conversation.run = undefined;
    }
    if (conversation.title === automaticTitle) {
      conversation.title = originalTitle;
      conversation.titleSource = originalTitleSource;
    }
    if (conversation.syncStatus === "syncing") {
      conversation.syncStatus = originalSyncStatus;
    }
    if (conversation.updatedAt === attemptedAt) conversation.updatedAt = originalUpdatedAt;
    if (this.getOrCreateDraft(conversation.id).items.length === 0) {
      this.draftContexts.set(conversation.id, cloneDraftContextState(attachedDraft));
    }
  }

  private async disposeInternal() {
    if (this.disposed) return;
    this.disposed = true;
    this.runStreamMetrics.clear();
    this.backendSubscription.dispose();
    await this.conversationNavigationTail;
    await Promise.allSettled([...this.backendTasks]);
    for (const conversationId of this.saveTimers.keys()) {
      this.clearSaveTimer(conversationId);
    }
    for (const conversationId of this.runTimers.keys()) {
      this.clearRunTimer(conversationId);
    }
    const saves = await Promise.allSettled(
      this.conversations
        .filter(
          (conversation) =>
            !this.deletingConversations.has(conversation.id) &&
            hasVisibleConversationMessages(conversation),
        )
        .map(async (conversation) => this.store.save(conversation)),
    );
    if (saves.some((result) => result.status === "rejected")) {
      this.logger.error("conversation.dispose-save-failed", "STORE_WRITE_FAILED", {
        failures: saves.filter((result) => result.status === "rejected").length,
      });
    }
    await this.activeStateWrite.catch((error: unknown) => {
      this.logger.error("conversation.active-save-failed", "GLOBAL_STATE_WRITE_FAILED", {
        name: error instanceof Error ? error.name : "Unknown",
      });
    });
    await this.pendingCloseWrite.catch((error: unknown) => {
      this.logger.error("conversation.close-state-save-failed", "GLOBAL_STATE_WRITE_FAILED", {
        name: error instanceof Error ? error.name : "Unknown",
      });
    });
    this.events.removeAllListeners();
    this.generationEvents.removeAllListeners();
  }

  private updateAutomaticTitle(conversation: Conversation, question: string) {
    if (conversation.messages.filter((item) => item.role === "user").length !== 1) return;
    if (conversation.titleSource || !isGenericConversationTitle(conversation.title)) return;
    const title = question.trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").slice(0, 36);
    conversation.title =
      title && !isGenericConversationTitle(title)
        ? title
        : vscode.env.language.toLowerCase().startsWith("en")
          ? "New conversation"
          : "新对话";
  }

  private assertGlobalRunCapacity() {
    const activeRuns = this.conversations.filter((conversation) => conversation.run).length;
    if (activeRuns >= MAX_CONCURRENT_RUNS) {
      throw new Ask2GPTError(
        "CONCURRENT_RUN_LIMIT",
        `最多允许 ${MAX_CONCURRENT_RUNS} 个会话同时生成回答。`,
      );
    }
  }

  private createConversation(): Conversation {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      title: vscode.env.language.toLowerCase().startsWith("en") ? "New conversation" : "新对话",
      createdAt: now,
      updatedAt: now,
      messages: [],
      syncStatus: "local",
    };
  }

  private requireConversation(id: string) {
    const conversation = this.conversations.find((item) => item.id === id);
    if (!conversation) throw new Ask2GPTError("CONVERSATION_NOT_FOUND", "找不到该会话。");
    if (this.deletingConversations.has(id)) {
      throw new Ask2GPTError("CONVERSATION_DELETING", "该会话正在删除。");
    }
    if (conversation.archivedAt || this.archivingConversations.has(id)) {
      throw new Ask2GPTError("CONVERSATION_ARCHIVED", "This conversation is archived.");
    }
    return conversation;
  }

  private mostRecentUnarchivedConversation() {
    return this.conversations
      .filter((conversation) => !conversation.archivedAt)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  private enqueueConversationNavigation<T>(operation: () => Promise<T>) {
    const task = this.conversationNavigationTail.catch(() => undefined).then(operation);
    // The tail is only a sequencing fence. Each caller still receives the
    // original task (and therefore its error), while a failed navigation can
    // never poison later selections or New requests.
    this.conversationNavigationTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async persistActive() {
    const activeConversationId = this.activeConversationId;
    const next = this.activeStateWrite
      .catch(() => undefined)
      .then(async () =>
        this.extensionContext.workspaceState.update(
          this.activeConversationKey,
          activeConversationId,
        ),
      );
    this.activeStateWrite = next;
    await next;
  }

  private async rememberPendingTabClose(conversationId: string) {
    this.pendingTabCloses.add(conversationId);
    try {
      await this.persistPendingTabCloses();
    } catch (error) {
      this.logger.error("conversation.close-state-save-failed", "GLOBAL_STATE_WRITE_FAILED", {
        name: error instanceof Error ? error.name : "Unknown",
      });
    }
  }

  private async forgetPendingTabClose(conversationId: string) {
    this.pendingTabCloses.delete(conversationId);
    try {
      await this.persistPendingTabCloses();
    } catch (error) {
      this.logger.error("conversation.close-state-save-failed", "GLOBAL_STATE_WRITE_FAILED", {
        name: error instanceof Error ? error.name : "Unknown",
      });
    }
  }

  private persistPendingTabCloses() {
    const next = this.pendingCloseWrite
      .catch(() => undefined)
      .then(async () =>
        this.extensionContext.workspaceState.update(this.pendingTabClosesKey, [
          ...this.pendingTabCloses,
        ]),
      );
    this.pendingCloseWrite = next;
    return next;
  }

  private get activeConversationKey() {
    return `${ACTIVE_CONVERSATION_KEY}${this.stateKeySuffix}`;
  }

  private get pendingTabClosesKey() {
    return `${PENDING_TAB_CLOSES_KEY}${this.stateKeySuffix}`;
  }

  private flushPendingTabCloses() {
    if (this.pendingCloseFlush) return this.pendingCloseFlush;
    this.pendingCloseFlush = (async () => {
      let changed = false;
      for (const conversationId of [...this.pendingTabCloses]) {
        try {
          if (await this.backend.closeConversation(conversationId)) {
            this.pendingTabCloses.delete(conversationId);
            changed = true;
          }
        } catch (error) {
          this.logger.error("conversation.tab-close-failed", "TAB_CLOSE_FAILED", {
            name: error instanceof Error ? error.name : "Unknown",
          });
          break;
        }
      }
      if (changed) {
        try {
          await this.persistPendingTabCloses();
        } catch (error) {
          this.logger.error("conversation.close-state-save-failed", "GLOBAL_STATE_WRITE_FAILED", {
            name: error instanceof Error ? error.name : "Unknown",
          });
        }
      }
    })().finally(() => {
      this.pendingCloseFlush = undefined;
    });
    return this.pendingCloseFlush;
  }

  private emitState() {
    this.events.emit("state", this.getState());
  }
}

function haveSameExplicitContext(left: ContextSnapshot, right: ContextSnapshot) {
  return (
    left.uri === right.uri &&
    left.startLine === right.startLine &&
    left.endLine === right.endLine &&
    left.content === right.content
  );
}

function modelPickerErrorCode(error: unknown, fallback = "CHATGPT_MODEL_UNAVAILABLE") {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : fallback;
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

function normalizeRemoteTitle(value: string) {
  const title = value.replace(/\s+/gu, " ").trim();
  if (/[\p{Cc}\p{Cf}]/u.test(title)) {
    return undefined;
  }
  if (title.length < 1 || title.length > 80 || isGenericConversationTitle(title)) {
    return undefined;
  }
  return title;
}

function normalizeRemoteTitleUrl(value: string) {
  const remoteUrl = normalizeRemoteUrl(value);
  if (!remoteUrl) return undefined;
  const segments = new URL(remoteUrl).pathname.split("/").filter(Boolean);
  if (
    (segments.length === 2 && segments[0] === "c") ||
    (segments.length === 4 && segments[0] === "g" && segments[2] === "c")
  ) {
    return remoteUrl;
  }
  return undefined;
}

function isSameRemoteConversation(left: string, right: string) {
  if (left === right) return true;
  const leftId = remoteConversationId(left);
  const rightId = remoteConversationId(right);
  return leftId !== undefined && rightId !== undefined && leftId === rightId;
}

function hasVisibleConversationMessages(conversation: Conversation) {
  return conversation.messages.some((message) => message.role !== "local-notice");
}

function hasCompletedTerminalAnswer(conversation: Conversation) {
  return conversation.messages.some(
    (message) =>
      message.role === "assistant" && message.terminalReceipt?.terminalType === "complete",
  );
}

function remoteConversationId(value: string) {
  try {
    const normalized = normalizeRemoteUrl(value);
    if (!normalized) return undefined;
    const segments = new URL(normalized).pathname.split("/").filter(Boolean);
    if (segments.length === 2 && segments[0] === "c") {
      return decodeURIComponent(segments[1]!);
    }
    if (segments.length >= 4 && segments.at(-2) === "c") {
      return decodeURIComponent(segments.at(-1)!);
    }
  } catch {
    return undefined;
  }
  return undefined;
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

type RemoteHistoryMessage = Extract<BackendEvent, { type: "history" }>["messages"][number];

function rebuildCompleteRemoteHistory(
  localMessages: readonly ConversationMessage[],
  remoteMessages: readonly RemoteHistoryMessage[],
  observedAt: string,
) {
  const localChatMessages = localMessages.filter((message) => message.role !== "local-notice");
  const usedLocalIndexes = new Set<number>();
  const rebuilt = remoteMessages.map((remoteMessage, remoteIndex) => {
    let localIndex = findMatchingLocalMessage(
      localChatMessages,
      remoteMessage,
      usedLocalIndexes,
      remoteIndex,
    );
    if (localIndex < 0) {
      const positional = localChatMessages[remoteIndex];
      if (
        positional &&
        !usedLocalIndexes.has(remoteIndex) &&
        canReuseByPosition(positional, remoteMessage)
      ) {
        localIndex = remoteIndex;
      }
    }
    if (localIndex < 0) return createRemoteMessage(remoteMessage, observedAt);

    usedLocalIndexes.add(localIndex);
    return synchronizeRemoteMessage(localChatMessages[localIndex]!, remoteMessage);
  });
  const messages = interleaveLocalNotices(localMessages, rebuilt);
  return { messages, changed: !sameMessageReferences(localMessages, messages) };
}

function mergeIncompleteRemoteHistory(
  localMessages: readonly ConversationMessage[],
  remoteMessages: readonly RemoteHistoryMessage[],
  observedAt: string,
  activeRunMessageId?: string,
) {
  const messages = [...localMessages];
  const chatIndexes = messages.flatMap((message, index) =>
    message.role === "local-notice" ? [] : [index],
  );
  const usedMessageIndexes = new Set<number>();
  let prefixAligned = true;
  let changed = false;

  for (let remoteIndex = 0; remoteIndex < remoteMessages.length; remoteIndex += 1) {
    const remoteMessage = remoteMessages[remoteIndex]!;
    const preferredMessageIndex = chatIndexes[remoteIndex];
    let messageIndex = findMatchingMessageIndex(
      messages,
      chatIndexes,
      remoteMessage,
      usedMessageIndexes,
      preferredMessageIndex,
    );
    if (messageIndex < 0 && prefixAligned && preferredMessageIndex !== undefined) {
      const positional = messages[preferredMessageIndex];
      if (
        positional &&
        !usedMessageIndexes.has(preferredMessageIndex) &&
        canReuseByPosition(positional, remoteMessage)
      ) {
        messageIndex = preferredMessageIndex;
      }
    }

    if (messageIndex >= 0) {
      if (messageIndex !== preferredMessageIndex) prefixAligned = false;
      usedMessageIndexes.add(messageIndex);
      const current = messages[messageIndex]!;
      const synchronized = synchronizeRemoteMessage(current, remoteMessage, activeRunMessageId);
      if (synchronized !== current) {
        messages[messageIndex] = synchronized;
        changed = true;
      }
      continue;
    }

    if (preferredMessageIndex !== undefined) prefixAligned = false;
    const appended = createRemoteMessage(remoteMessage, observedAt);
    messages.push(appended);
    const appendedIndex = messages.length - 1;
    chatIndexes.push(appendedIndex);
    usedMessageIndexes.add(appendedIndex);
    changed = true;
  }

  return { messages, changed };
}

function findMatchingLocalMessage(
  messages: readonly ConversationMessage[],
  remoteMessage: RemoteHistoryMessage,
  usedIndexes: ReadonlySet<number>,
  preferredIndex: number,
) {
  const preferred = messages[preferredIndex];
  if (
    preferred &&
    !usedIndexes.has(preferredIndex) &&
    isSameRemoteMessage(preferred, remoteMessage)
  ) {
    return preferredIndex;
  }
  return messages.findIndex(
    (message, index) => !usedIndexes.has(index) && isSameRemoteMessage(message, remoteMessage),
  );
}

function findMatchingMessageIndex(
  messages: readonly ConversationMessage[],
  chatIndexes: readonly number[],
  remoteMessage: RemoteHistoryMessage,
  usedIndexes: ReadonlySet<number>,
  preferredIndex?: number,
) {
  if (preferredIndex !== undefined) {
    const preferred = messages[preferredIndex];
    if (
      preferred &&
      !usedIndexes.has(preferredIndex) &&
      isSameRemoteMessage(preferred, remoteMessage)
    ) {
      return preferredIndex;
    }
  }
  for (const index of chatIndexes) {
    const candidate = messages[index];
    if (candidate && !usedIndexes.has(index) && isSameRemoteMessage(candidate, remoteMessage)) {
      return index;
    }
  }
  return -1;
}

function isSameRemoteMessage(local: ConversationMessage, remote: RemoteHistoryMessage) {
  if (local.role !== remote.role) return false;
  if (local.markdown === remote.markdown) return true;
  return packagedPromptPresentationMatches(remote.markdown, local);
}

function canReuseByPosition(local: ConversationMessage, remote: RemoteHistoryMessage) {
  return (
    local.role === remote.role &&
    (local.role === "assistant" || !local.contexts || local.contexts.length === 0)
  );
}

function synchronizeRemoteMessage(
  local: ConversationMessage,
  remote: RemoteHistoryMessage,
  activeRunMessageId?: string,
) {
  const preservePackagedQuestion = packagedPromptPresentationMatches(remote.markdown, local);
  const markdown = preservePackagedQuestion ? local.markdown : remote.markdown;
  const status = local.id === activeRunMessageId ? local.status : "complete";
  const runError = status === "error" ? local.runError : undefined;
  if (local.markdown === markdown && local.status === status && local.runError === runError) {
    return local;
  }
  return { ...local, markdown, status, runError };
}

function renderedPromptPresentationMatches(rendered: string, prompt: string) {
  const actual = rendered.replace(/\r\n?/gu, "\n");
  const expected = prompt.replace(/\r\n?/gu, "\n");
  if (actual === expected) return true;

  // ChatGPT may expose ordinary spaces as NBSPs, but a source NBSP remains
  // significant. Keep this deliberately one-way and avoid general whitespace
  // folding so unrelated remote messages cannot be merged by position.
  if (expected.includes("\u00a0")) return false;
  const ordinaryActual = actual.replace(/\u00a0/gu, " ");
  if (ordinaryActual === expected) return true;

  // Its ProseMirror presentation can also flatten a multiline inserted prompt
  // into one paragraph. This is the same narrow equivalence used by the Relay
  // before dispatch; tabs, repeated spaces and all other characters still
  // have to match exactly.
  return (
    expected.includes("\n") &&
    !ordinaryActual.includes("\n") &&
    ordinaryActual === expected.replace(/\n/gu, " ")
  );
}

function packagedPromptPresentationMatches(rendered: string, message: ConversationMessage) {
  const presentation = promptPresentationForStoredMessage(message);
  if (!presentation) return false;

  const candidates = [presentation.prompt];
  if (presentation.fileNames.length > 0) {
    for (const separator of ["\n\n", "\n", " "]) {
      const attachmentBlock = presentation.fileNames.join(separator);
      candidates.push(
        `${presentation.prompt}${separator}${attachmentBlock}`,
        `${attachmentBlock}${separator}${presentation.prompt}`,
      );
    }
  }

  return candidates.some(
    (candidate) =>
      renderedPromptPresentationMatches(rendered, candidate) ||
      rendered
        .replace(/\r\n?/gu, "\n")
        .replace(/\u00a0/gu, " ")
        .trim() === promptInlinePresentationForTranscriptProof(candidate),
  );
}

function promptPresentationForStoredMessage(message: ConversationMessage) {
  if (message.role !== "user" || !message.contexts || message.contexts.length === 0) {
    return undefined;
  }
  try {
    const plan = buildVisiblePromptPlan(message.markdown, message.contexts);
    const legacyPlan = buildLegacyVisiblePromptPlan(message.markdown, message.contexts);
    const packaged = message.contextTransportVersion === 2;
    return {
      prompt: packaged ? plan.prompt : legacyPlan.prompt,
      fileNames: packaged
        ? plan.attachments.map((attachment) => attachment.fileName)
        : legacyPlan.attachmentFileNames,
    };
  } catch {
    // Older encrypted records may contain context that a newer policy no
    // longer permits. A failed equivalence check must not abort history sync.
    return undefined;
  }
}

function visiblePromptForStoredMessage(message: ConversationMessage) {
  return promptPresentationForStoredMessage(message)?.prompt;
}

function createRemoteMessage(
  remote: RemoteHistoryMessage,
  observedAt: string,
): ConversationMessage {
  return {
    id: randomUUID(),
    role: remote.role,
    markdown: remote.markdown,
    status: "complete",
    createdAt: observedAt,
  };
}

function interleaveLocalNotices(
  original: readonly ConversationMessage[],
  remoteMessages: readonly ConversationMessage[],
) {
  const noticeBuckets = Array.from(
    { length: remoteMessages.length + 1 },
    () => [] as ConversationMessage[],
  );
  let chatMessagesBeforeNotice = 0;
  for (const message of original) {
    if (message.role === "local-notice") {
      noticeBuckets[Math.min(chatMessagesBeforeNotice, remoteMessages.length)]!.push(message);
    } else {
      chatMessagesBeforeNotice += 1;
    }
  }

  const merged: ConversationMessage[] = [...noticeBuckets[0]!];
  remoteMessages.forEach((message, index) => {
    merged.push(message, ...noticeBuckets[index + 1]!);
  });
  return merged;
}

function sameMessageReferences(
  left: readonly ConversationMessage[],
  right: readonly ConversationMessage[],
) {
  return left.length === right.length && left.every((message, index) => message === right[index]);
}

function normalizeObservedAt(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? value : new Date().toISOString();
}

function newestTimestamp(left: string, right: string) {
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function isOlderTimestamp(candidate: string, reference: string) {
  return Date.parse(candidate) < Date.parse(reference);
}

function buildConversationTranscriptProof(
  conversation: Conversation,
): ConversationTranscriptProof | undefined {
  if (!conversation.remoteUrl) return undefined;
  const chatMessages = conversation.messages.filter(
    (message): message is ConversationMessage & { role: "user" | "assistant" } =>
      message.role !== "local-notice",
  );
  const messageHashes: ConversationTranscriptProof["messageHashes"] = [];

  for (let index = 0; index < chatMessages.length; index += 1) {
    const message = chatMessages[index]!;
    if (message.role === "assistant") {
      if (
        (message.status === "complete" || message.status === "stopped") &&
        message.markdown.length > 0
      ) {
        messageHashes.push({
          role: "assistant",
          sha256: sha256Text(JSON.stringify(["assistant", message.markdown])),
        });
      }
      continue;
    }

    const next = chatMessages[index + 1];
    const assistant = next?.role === "assistant" ? next : undefined;
    if (
      assistant?.status === "streaming" ||
      (assistant?.status === "error" && isClearlyUnsentRunError(assistant.runError))
    ) {
      index += 1;
      continue;
    }

    const visiblePrompt = visiblePromptForStoredMessage(message) ?? message.markdown;
    const locallyAuthored = Boolean(
      message.clientRequestId || message.contexts?.length || assistant?.terminalReceipt,
    );
    const remoteMarkdown = locallyAuthored
      ? promptInlinePresentationForTranscriptProof(visiblePrompt)
      : message.markdown;
    messageHashes.push({
      role: "user",
      sha256: sha256Text(JSON.stringify(["user", remoteMarkdown])),
    });

    if (assistant) {
      if (
        (assistant.status === "complete" || assistant.status === "stopped") &&
        assistant.markdown.length > 0
      ) {
        messageHashes.push({
          role: "assistant",
          sha256: sha256Text(JSON.stringify(["assistant", assistant.markdown])),
        });
      }
      index += 1;
    }
  }

  if (messageHashes.length > 200) return undefined;
  return {
    remoteUrl: conversation.remoteUrl,
    messageCount: messageHashes.length,
    messageHashes,
    transcriptChainSha256: sha256Text(
      JSON.stringify(messageHashes.map((message) => [message.role, message.sha256])),
    ),
  };
}

// Keep this aligned with the Relay's prompt-presentation version 1. Locally
// authored user messages retain their source Markdown, while ChatGPT exposes
// the inserted text through this exact escaped, single-inline presentation.
function promptInlinePresentationForTranscriptProof(value: string) {
  return value
    .replace(/\s+/gu, " ")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/([\\`[\]*_])/gu, "\\$1")
    .trim();
}

function sha256Text(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isClearlyUnsentRunError(error?: RelayErrorPayload) {
  return Boolean(
    error &&
    ([
      "SELECTOR_INCOMPATIBLE",
      "CHATGPT_COMPOSER_MISSING",
      "CHATGPT_ATTACHMENT_FAILED",
      "CHATGPT_MODEL_UNAVAILABLE",
      "CHATGPT_MODEL_SELECTION_FAILED",
    ].includes(error.code) ||
      (error.code === "CHATGPT_REMOTE_UNAVAILABLE" &&
        error.message.startsWith(TRANSCRIPT_PREFLIGHT_NOT_SENT_MESSAGE))),
  );
}

function isBackendReady(status: BackendStatus) {
  return status.connected && status.authenticated && status.connection.phase === "ready";
}

function backendStatusesEqual(left: BackendStatus, right: BackendStatus) {
  return (
    left.connected === right.connected &&
    left.authenticated === right.authenticated &&
    left.activeRuns === right.activeRuns &&
    left.port === right.port &&
    left.selectorVersion === right.selectorVersion &&
    projectsEqual(left.project, right.project) &&
    relayErrorsEqual(left.error, right.error) &&
    connectionStatusesEqual(left.connection, right.connection)
  );
}

function connectionStatusesEqual(
  left: BackendStatus["connection"],
  right: BackendStatus["connection"],
) {
  return (
    left.phase === right.phase &&
    left.since === right.since &&
    left.browserDetected === right.browserDetected &&
    left.hasStoredTrust === right.hasStoredTrust &&
    left.hostVersion === right.hostVersion &&
    left.relayVersion === right.relayVersion &&
    left.protocolVersion === right.protocolVersion &&
    left.lastConnectedAt === right.lastConnectedAt &&
    left.detectedProtocol === right.detectedProtocol &&
    left.errorCode === right.errorCode
  );
}

function projectsEqual(left: BackendStatus["project"], right: BackendStatus["project"]) {
  if (left === right) return true;
  if (!left || !right || left.bound !== right.bound) return false;
  return left.bound === false || (right.bound === true && left.name === right.name);
}

function relayErrorsEqual(left: BackendStatus["error"], right: BackendStatus["error"]) {
  if (left === right) return true;
  return (
    left?.code === right?.code &&
    left?.message === right?.message &&
    left?.recoverable === right?.recoverable
  );
}

function terminalDeliveryFromEvent(
  event: BackendEvent,
): NonNullable<ConversationMessage["terminalReceipt"]> | undefined {
  if (event.type === "complete" || event.type === "stopped") {
    return {
      eventId: event.terminalEventId,
      runId: event.runId,
      terminalType: event.type,
    };
  }
  if (event.type === "error" && event.runId && event.terminalEventId) {
    return {
      eventId: event.terminalEventId,
      runId: event.runId,
      terminalType: "error",
    };
  }
  return undefined;
}

function preferredModelSelection(conversation: Conversation, options: readonly ChatModelOption[]) {
  if (
    conversation.selectedModelId &&
    options.some((option) => option.id === conversation.selectedModelId)
  ) {
    return conversation.selectedModelId;
  }
  return DEFAULT_CHATGPT_MODE_ID;
}

function modelIdForDispatch(conversation: Conversation) {
  return conversation.selectedModelId ?? DEFAULT_CHATGPT_MODE_ID;
}

function hasResolvedDispatchModel(
  catalog: readonly ChatModelOption[] | undefined,
  modelId: string,
) {
  return Boolean(catalog?.some((option) => option.id === modelId && option.modelId));
}

function markSelectedModel(
  options: readonly ChatModelOption[],
  currentModelId: string | undefined,
) {
  return options.map((option) => ({
    ...option,
    selected: option.id === currentModelId,
  }));
}

function cloneDraftContextState(state: DraftContextState): DraftContextState {
  return {
    items: [...state.items],
    automaticContextIds: new Set(state.automaticContextIds),
    ...(state.primaryContextId ? { primaryContextId: state.primaryContextId } : {}),
  };
}
