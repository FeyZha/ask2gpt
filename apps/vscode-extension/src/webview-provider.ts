import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

import type {
  AppState,
  GenerationViewUpdate,
  HostToWebviewMessage,
  WebviewToHostMessage,
} from "./types";
import type { Ask2GPTController } from "./controller";
import { openContextFromState } from "./context-navigation";
import { openAnswerSourceReferenceFromState, openAnswerSymbolFromState } from "./source-trace";
import { selectionReferenceFromEditor } from "./selection-reference";
import { Ask2GPTError } from "./services/errors";
import type { SafeLogger } from "./services/logger";
import { withSourceTraceHints } from "./source-trace-index";
import { normalizeExternalHttpUrl } from "./webview/external-url";
import { parseWebviewMessage } from "./webview-message-validation";

const VISIBLE_COALESCE_MS = 40;
const MEDIUM_GENERATION_COALESCE_MS = 50;
const MAX_GENERATION_COALESCE_MS = 60;
const MEDIUM_GENERATION_CHARS = 4_000;
const LONG_GENERATION_CHARS = 16_000;
const INITIAL_STATE_RETRY_MS = 100;
const MAX_STATE_RETRY_MS = 1_000;
const WEBVIEW_DELIVERY_TIMEOUT_MS = 2_000;

interface QueuedWebviewDelivery {
  message: HostToWebviewMessage;
  resolve(delivered: boolean): void;
}

interface ActiveWebviewDelivery {
  delivery: QueuedWebviewDelivery;
  id: number;
  timeout?: ReturnType<typeof setTimeout>;
}

interface WebviewDeliveryLane {
  active?: ActiveWebviewDelivery;
  generation: number;
  nextDeliveryId: number;
  queue: QueuedWebviewDelivery[];
  view: vscode.WebviewView;
}

interface StateDelivery {
  generation: number;
  id: number;
  state: AppState;
}

export class Ask2GPTViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "ask2gpt.sidebar";

  private view?: vscode.WebviewView;
  private viewDisposables: Array<{ dispose(): void }> = [];
  private viewGeneration = 0;
  private readonly stateSubscription: { dispose(): void };
  private readonly generationSubscription?: { dispose(): void };
  private pendingState?: AppState;
  private pendingStateUrgent = false;
  private stateFlushTimer?: ReturnType<typeof setTimeout>;
  private stateRetryTimer?: ReturnType<typeof setTimeout>;
  private stateDelivery?: StateDelivery;
  private stateDeliveryId = 0;
  private stateDeliveryFailures = 0;
  private readonly pendingGenerations = new Map<string, GenerationViewUpdate>();
  private readonly activeGenerations = new Map<string, GenerationViewUpdate>();
  private generationFlushTimer?: ReturnType<typeof setTimeout>;
  private generationFlushStartedAt?: number;
  private generationFlushDueAt?: number;
  private webviewReady = false;
  private pendingComposerFocus = false;
  private pendingTurnReveal?: Extract<HostToWebviewMessage, { type: "revealTurn" }>;
  private initialStateJson?: string;
  private lastDeliveredRuns = new Map<string, string>();
  private pendingStateRuns = new Map<string, string>();
  private deliveryLane?: WebviewDeliveryLane;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: Ask2GPTController,
    private readonly logger: SafeLogger,
    private readonly copyDiagnostics: () => Promise<void>,
    private readonly retryConnection: () => Promise<void> = async () => undefined,
    private readonly deliveryTimeoutMs: number = WEBVIEW_DELIVERY_TIMEOUT_MS,
  ) {
    this.stateSubscription = controller.onState((state) => {
      this.queueState(state);
    });
    this.generationSubscription = controller.onGeneration?.((update) => {
      this.queueGeneration(update);
    });
  }

  resolveWebviewView(view: vscode.WebviewView) {
    // Assigning `webview.html` destroys the renderer. Do not reset a retained
    // instance if VS Code asks the provider to resolve the same view again.
    if (this.view === view) {
      if (view.visible !== false && this.webviewReady) {
        this.postStateNow(this.controller.getState());
      }
      return;
    }

    this.disposeViewSubscriptions();
    this.cancelStateFlush();
    this.cancelStateRetry();
    this.cancelGenerationFlush();
    this.abortDeliveryLane();
    this.stateDelivery = undefined;
    this.activeGenerations.clear();
    const generation = ++this.viewGeneration;
    this.view = view;
    this.webviewReady = false;
    this.deliveryLane = { generation, nextDeliveryId: 0, queue: [], view };
    const initialState = this.controller.getState();
    this.pendingState = initialState;
    this.pendingStateUrgent = false;
    this.pendingStateRuns = this.runIds(initialState);
    this.lastDeliveredRuns = this.runIds(initialState);
    this.stateDeliveryFailures = 0;
    this.initialStateJson = JSON.stringify(withSourceTraceHints(initialState));
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
    };
    view.webview.html = this.html(view.webview, this.initialStateJson);
    this.viewDisposables = [
      view.webview.onDidReceiveMessage((value: unknown) => {
        // Ignore delayed messages from a renderer VS Code already replaced.
        if (!this.isCurrentView(view, generation)) return;
        const message = parseWebviewMessage(value);
        if (!message) {
          this.logger.error("webview.invalid-message", "WEBVIEW_INVALID_MESSAGE");
          this.notice("error", "收到无效的界面消息。");
          return;
        }
        void this.handleMessage(message);
      }),
      view.onDidChangeVisibility(() => {
        if (!this.isCurrentView(view, generation)) return;
        if (view.visible) {
          this.logger.info("webview.visible");
          if (this.webviewReady) this.postStateNow(this.controller.getState());
        } else {
          // Do not use WebviewView.visible as a transport gate. VS Code can
          // briefly report the view as hidden while entering full screen or
          // moving sidebars even though the retained renderer is still alive.
          // The renderer buffers state while its document is actually hidden.
          this.logger.info("webview.hidden");
        }
      }),
      view.onDidDispose(() => {
        if (!this.isCurrentView(view, generation)) return;
        this.logger.info("webview.disposed");
        this.viewGeneration += 1;
        this.view = undefined;
        this.webviewReady = false;
        this.initialStateJson = undefined;
        this.lastDeliveredRuns.clear();
        this.pendingStateRuns.clear();
        this.cancelStateFlush();
        this.cancelStateRetry();
        this.cancelGenerationFlush();
        this.abortDeliveryLane();
        this.stateDelivery = undefined;
        this.activeGenerations.clear();
        this.disposeViewSubscriptions();
      }),
    ];
    this.logger.info("webview.resolved", { generation });
  }

  async show(focusComposer = false) {
    this.pendingComposerFocus ||= focusComposer;
    if (this.view) {
      // WebviewView.show already reveals the owning container. Avoid combining
      // it with workbench commands, which creates consecutive layout switches.
      this.view.show?.(!focusComposer);
    } else {
      // The generated focus command reveals the view in whichever location the
      // user moved it to, including the Secondary Sidebar.
      await vscode.commands.executeCommand("ask2gpt.sidebar.focus");
    }
    this.flushComposerFocus();
  }

  async revealTurn(conversationId: string, messageId: string, contextId?: string) {
    this.pendingTurnReveal = {
      type: "revealTurn",
      conversationId,
      messageId,
      ...(contextId ? { contextId } : {}),
    };
    await this.show(false);
    // The renderer must see the selected conversation before it receives the
    // scroll request. The delivery lane preserves that order, and a retained
    // request survives a renderer that has not announced readiness yet.
    this.postStateNow(this.controller.getState());
    this.flushTurnReveal();
  }

  dispose() {
    // Invalidate every in-flight post before clearing its lane. A compact
    // delivery can settle after the extension itself is disposed; without
    // this generation boundary its failure callback could revive the retry
    // timer against a renderer that no longer exists.
    this.viewGeneration += 1;
    this.view = undefined;
    this.webviewReady = false;
    this.pendingComposerFocus = false;
    this.pendingTurnReveal = undefined;
    this.cancelStateFlush();
    this.cancelStateRetry();
    this.cancelGenerationFlush();
    this.abortDeliveryLane();
    this.stateDelivery = undefined;
    this.activeGenerations.clear();
    this.lastDeliveredRuns.clear();
    this.pendingStateRuns.clear();
    this.pendingState = undefined;
    this.pendingStateUrgent = false;
    this.initialStateJson = undefined;
    this.disposeViewSubscriptions();
    this.stateSubscription.dispose();
    this.generationSubscription?.dispose();
  }

  private async handleMessage(message: WebviewToHostMessage) {
    try {
      switch (message.type) {
        case "ready":
          this.webviewReady = true;
          {
            const currentState = this.controller.getState();
            const initialStateStillCurrent =
              this.initialStateJson !== undefined &&
              this.initialStateJson === JSON.stringify(withSourceTraceHints(currentState));
            this.initialStateJson = undefined;
            if (initialStateStillCurrent) {
              // React hydrated the host-provided snapshot on its first render;
              // avoid immediately replacing it with an identical full state.
              this.cancelStateFlush();
              this.cancelStateRetry();
              this.pendingState = undefined;
              this.pendingStateUrgent = false;
              this.pendingStateRuns.clear();
              this.stateDeliveryFailures = 0;
            } else {
              this.postStateNow(currentState);
            }
          }
          this.flushComposerFocus();
          this.flushTurnReveal();
          return;
        case "newConversation":
          await this.controller.newConversation(message.sourceConversationId);
          // New chat is a navigation boundary. Publish the authoritative blank
          // conversation immediately so the source composer (including any
          // rejected-send rollback cache) cannot remain visible until the
          // regular coalesced state timer fires.
          this.postStateNow(this.controller.getState());
          void this.post({ type: "focusComposer" });
          return;
        case "selectConversation":
          await this.controller.selectConversation(message.conversationId);
          return;
        case "renameConversation":
          await this.controller.renameConversation(message.conversationId, message.title);
          return;
        case "archiveConversation":
          await this.controller.archiveConversation(message.conversationId);
          return;
        case "unarchiveConversation":
          await this.controller.unarchiveConversation(message.conversationId, message.activate);
          return;
        case "deleteConversation":
          await this.controller.deleteConversation(message.conversationId);
          return;
        case "prepareConversation":
          this.controller.prepareConversationForDispatch(message.conversationId);
          return;
        case "send":
          await this.controller.send(message.text, message.conversationId, message.requestId);
          void this.post({
            type: "sendResult",
            accepted: true,
            conversationId: message.conversationId,
            requestId: message.requestId,
          });
          // The receipt and its authoritative state travel as one ordered
          // hand-off. This prevents a delayed/coalesced state frame from
          // leaving the composer in a pending state after the host accepted
          // the request.
          this.postStateNow(this.controller.getState());
          return;
        case "enqueueFollowUp":
          await this.controller.enqueueFollowUp(
            message.text,
            message.conversationId,
            message.requestId,
            message.targetRunId,
          );
          void this.post({
            type: "sendResult",
            accepted: true,
            conversationId: message.conversationId,
            requestId: message.requestId,
          });
          this.postStateNow(this.controller.getState());
          return;
        case "interruptWithFollowUp":
          {
            const outcome = await this.controller.interruptWithFollowUp(
              message.text,
              message.conversationId,
              message.requestId,
              message.targetRunId,
            );
            void this.post({
              type: "sendResult",
              accepted: true,
              conversationId: message.conversationId,
              requestId: message.requestId,
            });
            this.postStateNow(this.controller.getState());
            if (outcome === "queued") {
              this.notice("warning", "未能停止当前回答；消息已保留，将在当前回答完成后发送。");
            }
          }
          return;
        case "updateQueuedFollowUp":
          await this.controller.updateQueuedFollowUp(
            message.conversationId,
            message.queueId,
            message.text,
          );
          this.postStateNow(this.controller.getState());
          return;
        case "removeQueuedFollowUp":
          await this.controller.removeQueuedFollowUp(message.conversationId, message.queueId);
          this.postStateNow(this.controller.getState());
          return;
        case "resumeQueue":
          await this.controller.resumeQueue(message.conversationId);
          this.postStateNow(this.controller.getState());
          return;
        case "stop":
          await this.controller.stop(message.conversationId, message.targetRunId);
          return;
        case "regenerate":
          await this.controller.regenerate(message.conversationId, message.messageId);
          return;
        case "attachSelection":
          {
            const reference = selectionReferenceFromEditor(vscode.window.activeTextEditor);
            if (!reference) {
              throw new Ask2GPTError(
                "EMPTY_SELECTION",
                vscode.env.language.toLowerCase().startsWith("zh")
                  ? "请先在编辑器中选择代码。"
                  : "Select code in the editor first.",
              );
            }
            this.controller.attachSelection(message.conversationId, reference);
          }
          return;
        case "attachCurrentFile":
          this.controller.attachCurrentFile(message.conversationId);
          return;
        case "attachFiles":
          await this.controller.attachFiles(message.conversationId);
          return;
        case "removeContext":
          this.controller.removeContext(message.contextId, message.conversationId);
          return;
        case "openContext":
          await openContextFromState(
            this.controller.getState(),
            message.conversationId,
            message.contextId,
          );
          return;
        case "openSourceReference":
          if (message.kind === "file-line") {
            await openAnswerSourceReferenceFromState(
              this.controller.getState(),
              message.conversationId,
              message.messageId,
              message.reference,
            );
          } else {
            await openAnswerSymbolFromState(
              this.controller.getState(),
              message.conversationId,
              message.messageId,
              message.reference,
            );
          }
          return;
        case "copy":
          await vscode.env.clipboard.writeText(message.text);
          this.notice("info", "已复制到剪贴板。");
          return;
        case "retryConnection":
          await this.retryConnection();
          await this.controller.refreshBackendStatus();
          return;
        case "openChatGpt":
          await vscode.env.openExternal(vscode.Uri.parse("https://chatgpt.com/"));
          return;
        case "openExternal": {
          const url = normalizeExternalHttpUrl(message.url);
          if (!url) {
            throw new Ask2GPTError("UNSAFE_EXTERNAL_URL", "该链接不是安全的 HTTP(S) 地址。");
          }
          await vscode.env.openExternal(vscode.Uri.parse(url, true));
          return;
        }
        case "listModels":
          await this.controller.listModels(message.conversationId);
          return;
        case "selectModel":
          await this.controller.selectModel(message.modelId, message.conversationId);
          this.postStateNow(this.controller.getState());
          return;
        case "copyDiagnostics":
          await this.copyDiagnostics();
          this.notice("info", "已复制脱敏诊断信息。");
          return;
      }
    } catch (error) {
      if (
        message.type === "send" ||
        message.type === "enqueueFollowUp" ||
        message.type === "interruptWithFollowUp"
      ) {
        void this.post({
          type: "sendResult",
          accepted: false,
          conversationId: message.conversationId,
          requestId: message.requestId,
        });
      }
      const messageText = error instanceof Error ? error.message : "操作失败。";
      this.logger.error(
        "webview.action-failed",
        error instanceof Ask2GPTError ? error.code : "WEBVIEW_ACTION_FAILED",
        { action: message.type },
      );
      this.notice("error", messageText);
    }
  }

  private post(message: HostToWebviewMessage): Promise<boolean> {
    const lane = this.deliveryLane;
    if (!lane || !this.webviewReady || !this.isCurrentView(lane.view, lane.generation)) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      this.enqueueDelivery(lane, { message, resolve });
      this.pumpDeliveryLane(lane);
    });
  }

  private enqueueDelivery(lane: WebviewDeliveryLane, delivery: QueuedWebviewDelivery) {
    if (delivery.message.type === "state") {
      // A full state is authoritative for every active generation it carries.
      // Drop compact frames that have not entered postMessage yet so terminal
      // state and other urgent snapshots cannot sit behind stale Markdown.
      // Non-generation messages stay in place, preserving receipts and other
      // control-message ordering.
      this.removeQueuedGenerations(lane);
    } else if (delivery.message.type === "generationUpdate") {
      const key = this.deliveryGenerationKey(delivery.message.update);
      // Keep the in-flight frame plus only the newest queued frame for a run.
      // Remove then append instead of mutating in place: a control message that
      // arrived between two compact frames must remain ahead of the newer one.
      for (let index = lane.queue.length - 1; index >= 0; index -= 1) {
        const queued = lane.queue[index]!;
        if (
          queued.message.type !== "generationUpdate" ||
          this.deliveryGenerationKey(queued.message.update) !== key
        ) {
          continue;
        }
        lane.queue.splice(index, 1);
        // The newer compact frame supersedes this delivery. Resolve it as
        // covered so its dropped-frame recovery does not enqueue a full state;
        // failure of the retained latest frame still triggers that recovery.
        queued.resolve(true);
      }
    }
    lane.queue.push(delivery);
  }

  private removeQueuedGenerations(lane: WebviewDeliveryLane) {
    for (let index = lane.queue.length - 1; index >= 0; index -= 1) {
      const queued = lane.queue[index]!;
      if (queued.message.type !== "generationUpdate") continue;
      lane.queue.splice(index, 1);
      // The authoritative state covers the compact frame, so this is not a
      // delivery failure and must not schedule a redundant recovery snapshot.
      queued.resolve(true);
    }
  }

  private pumpDeliveryLane(lane: WebviewDeliveryLane) {
    if (lane.active) return;
    const delivery = lane.queue.shift();
    if (!delivery) return;
    if (
      this.deliveryLane !== lane ||
      !this.webviewReady ||
      !this.isCurrentView(lane.view, lane.generation)
    ) {
      delivery.resolve(false);
      this.pumpDeliveryLane(lane);
      return;
    }

    const active: ActiveWebviewDelivery = {
      delivery,
      id: ++lane.nextDeliveryId,
    };
    lane.active = active;
    let posted: Thenable<boolean>;
    try {
      posted = lane.view.webview.postMessage(delivery.message);
    } catch (error) {
      this.logger.error("webview.post-failed", "WEBVIEW_POST_FAILED", {
        generation: lane.generation,
        messageType: delivery.message.type,
        name: error instanceof Error ? error.name : "Unknown",
      });
      this.finishDelivery(lane, active, false);
      return;
    }
    active.timeout = setTimeout(() => {
      if (lane.active !== active) return;
      this.logger.error("webview.post-timeout", "WEBVIEW_POST_TIMEOUT", {
        generation: lane.generation,
        messageType: delivery.message.type,
        timeoutMs: this.deliveryTimeoutMs,
      });
      this.finishDelivery(lane, active, false);
    }, this.deliveryTimeoutMs);
    void Promise.resolve(posted).then(
      (delivered) => {
        this.finishDelivery(lane, active, delivered);
      },
      (error: unknown) => {
        if (lane.active !== active) return;
        this.logger.error("webview.post-failed", "WEBVIEW_POST_FAILED", {
          generation: lane.generation,
          messageType: delivery.message.type,
          name: error instanceof Error ? error.name : "Unknown",
        });
        this.finishDelivery(lane, active, false);
      },
    );
  }

  private finishDelivery(
    lane: WebviewDeliveryLane,
    active: ActiveWebviewDelivery,
    delivered: boolean,
  ) {
    // Timeout, view replacement, or a newer attempt can invalidate this
    // callback. A late promise settlement must never unlock the new attempt.
    if (lane.active !== active) return;
    if (active.timeout !== undefined) clearTimeout(active.timeout);
    lane.active = undefined;
    active.delivery.resolve(delivered);
    this.pumpDeliveryLane(lane);
  }

  private abortDeliveryLane() {
    const lane = this.deliveryLane;
    this.deliveryLane = undefined;
    if (!lane) return;
    if (lane.active) {
      if (lane.active.timeout !== undefined) clearTimeout(lane.active.timeout);
      const active = lane.active;
      lane.active = undefined;
      active.delivery.resolve(false);
    }
    for (const delivery of lane.queue.splice(0)) delivery.resolve(false);
  }

  private queueState(state: AppState) {
    const urgent = this.stateEndsActiveGeneration(state);
    this.cancelGenerationFlush();
    this.pendingState = state;
    this.pendingStateUrgent ||= urgent;
    this.pendingStateRuns = this.runIds(state);
    if (this.stateDelivery || !this.canDeliverState()) return;
    if (this.stateDeliveryFailures > 0) {
      this.scheduleStateRetry();
      return;
    }
    if (this.pendingStateUrgent) {
      this.cancelStateFlush();
      this.flushPendingState();
      return;
    }
    this.scheduleStateFlush();
  }

  private scheduleStateFlush() {
    if (
      this.stateFlushTimer ||
      this.stateDelivery ||
      !this.pendingState ||
      !this.canDeliverState()
    ) {
      return;
    }
    // VS Code serializes the full state for every postMessage call. Coalesce
    // relay/status bursts across a few frames so Markdown rendering gets time
    // to commit, while terminal states bypass this timer in the branch above.
    this.stateFlushTimer = setTimeout(
      () => {
        this.stateFlushTimer = undefined;
        this.flushPendingState();
      },
      this.view?.visible === false ? MAX_GENERATION_COALESCE_MS : VISIBLE_COALESCE_MS,
    );
  }

  private queueGeneration(update: GenerationViewUpdate) {
    const currentState = this.controller.getState();
    const key = this.generationKey(update);
    if (!this.isCurrentGeneration(update, currentState)) {
      this.pendingGenerations.delete(key);
      this.activeGenerations.delete(key);
      return;
    }
    const previous = this.pendingGenerations.get(key) ?? this.activeGenerations.get(key);
    if (
      previous &&
      (previous.updatedAt > update.updatedAt ||
        (previous.updatedAt === update.updatedAt &&
          previous.markdown.length > update.markdown.length))
    ) {
      return;
    }
    this.activeGenerations.set(key, update);
    if (!this.canDeliverState()) {
      this.pendingState = currentState;
      this.pendingStateRuns = this.runIds(currentState);
      return;
    }
    if (this.pendingState || this.stateFlushTimer || this.stateDelivery) {
      // A queued full state already supersedes every compact update and also
      // establishes any newly created assistant message before streaming.
      this.pendingState = currentState;
      this.pendingStateRuns = this.runIds(currentState);
      return;
    }

    this.pendingGenerations.set(key, update);
    this.scheduleGenerationFlush(this.generationCoalesceMs(update));
  }

  private scheduleGenerationFlush(delayMs: number) {
    if (this.generationFlushTimer) {
      const startedAt = this.generationFlushStartedAt ?? Date.now();
      const desiredDueAt = startedAt + delayMs;
      if ((this.generationFlushDueAt ?? desiredDueAt) >= desiredDueAt) return;
      clearTimeout(this.generationFlushTimer);
      this.generationFlushTimer = undefined;
      this.generationFlushDueAt = desiredDueAt;
      this.generationFlushTimer = setTimeout(
        () => this.flushGenerations(),
        Math.max(0, desiredDueAt - Date.now()),
      );
      return;
    }
    this.generationFlushStartedAt = Date.now();
    this.generationFlushDueAt = this.generationFlushStartedAt + delayMs;
    this.generationFlushTimer = setTimeout(() => this.flushGenerations(), delayMs);
  }

  private flushGenerations() {
    this.generationFlushTimer = undefined;
    this.generationFlushStartedAt = undefined;
    this.generationFlushDueAt = undefined;
    const updates = [...this.pendingGenerations.values()];
    this.pendingGenerations.clear();
    if (!this.canDeliverState()) {
      const currentState = this.controller.getState();
      this.pendingState = currentState;
      this.pendingStateRuns = this.runIds(currentState);
      return;
    }
    const generation = this.viewGeneration;
    for (const pending of updates) {
      void this.post({ type: "generationUpdate", update: pending }).then((delivered) => {
        if (!delivered) this.recoverDroppedGeneration(generation);
      });
    }
  }

  private postStateNow(state: AppState) {
    this.cancelStateFlush();
    this.cancelStateRetry();
    this.cancelGenerationFlush();
    this.pendingState = state;
    this.pendingStateUrgent = true;
    this.pendingStateRuns = this.runIds(state);
    this.stateDeliveryFailures = 0;
    this.flushPendingState();
  }

  private flushPendingState() {
    if (this.stateDelivery || !this.pendingState || !this.canDeliverState()) return;
    const state = this.pendingState;
    this.pendingState = undefined;
    this.pendingStateUrgent = false;
    const delivery: StateDelivery = {
      generation: this.viewGeneration,
      id: ++this.stateDeliveryId,
      state,
    };
    this.stateDelivery = delivery;
    void this.post({ type: "state", state: withSourceTraceHints(state) }).then((delivered) => {
      if (this.stateDelivery?.id !== delivery.id) return;
      this.stateDelivery = undefined;
      if (delivery.generation !== this.viewGeneration) return;

      if (delivered) {
        this.stateDeliveryFailures = 0;
        this.cancelStateRetry();
        this.didDeliverState(state);
      } else {
        this.stateDeliveryFailures += 1;
        if (!this.pendingState) this.pendingState = this.controller.getState();
        this.pendingStateUrgent = true;
        this.pendingStateRuns = this.runIds(this.pendingState);
      }

      if (!this.pendingState) return;
      if (this.stateDeliveryFailures > 0) {
        this.scheduleStateRetry();
      } else if (this.pendingStateUrgent) {
        this.flushPendingState();
      } else {
        this.scheduleStateFlush();
      }
    });
  }

  private recoverDroppedGeneration(generation: number) {
    if (generation !== this.viewGeneration || this.stateDelivery || this.pendingState) {
      return;
    }
    const state = this.controller.getState();
    this.pendingState = state;
    this.pendingStateUrgent = true;
    this.pendingStateRuns = this.runIds(state);
    this.stateDeliveryFailures = Math.max(1, this.stateDeliveryFailures);
    this.scheduleStateRetry();
  }

  private scheduleStateRetry() {
    if (
      this.stateRetryTimer ||
      this.stateDelivery ||
      !this.pendingState ||
      !this.canDeliverState() ||
      this.view?.visible === false
    ) {
      return;
    }
    const exponent = Math.min(Math.max(this.stateDeliveryFailures - 1, 0), 4);
    const delay = Math.min(INITIAL_STATE_RETRY_MS * 2 ** exponent, MAX_STATE_RETRY_MS);
    this.stateRetryTimer = setTimeout(() => {
      this.stateRetryTimer = undefined;
      if (this.view?.visible === false) return;
      this.flushPendingState();
    }, delay);
  }

  private cancelStateFlush() {
    if (this.stateFlushTimer) clearTimeout(this.stateFlushTimer);
    this.stateFlushTimer = undefined;
  }

  private cancelStateRetry() {
    if (this.stateRetryTimer) clearTimeout(this.stateRetryTimer);
    this.stateRetryTimer = undefined;
  }

  private cancelGenerationFlush() {
    if (this.generationFlushTimer) clearTimeout(this.generationFlushTimer);
    this.generationFlushTimer = undefined;
    this.generationFlushStartedAt = undefined;
    this.generationFlushDueAt = undefined;
    this.pendingGenerations.clear();
  }

  private generationCoalesceMs(update: GenerationViewUpdate) {
    if (this.view?.visible === false || update.markdown.length >= LONG_GENERATION_CHARS) {
      return MAX_GENERATION_COALESCE_MS;
    }
    if (update.markdown.length >= MEDIUM_GENERATION_CHARS) {
      return MEDIUM_GENERATION_COALESCE_MS;
    }
    return VISIBLE_COALESCE_MS;
  }

  private generationKey(update: GenerationViewUpdate) {
    return `${update.conversationId}:${update.messageId}`;
  }

  private deliveryGenerationKey(update: GenerationViewUpdate) {
    return `${this.generationKey(update)}:${update.runId}`;
  }

  private isCurrentGeneration(update: GenerationViewUpdate, state: AppState) {
    const conversation = state.conversations.find((item) => item.id === update.conversationId);
    const message = conversation?.messages.find((item) => item.id === update.messageId);
    return (
      conversation?.run?.id === update.runId &&
      conversation.run.messageId === update.messageId &&
      message?.status === "streaming"
    );
  }

  private stateEndsActiveGeneration(state: AppState) {
    if (this.activeGenerations.size > 0) {
      for (const update of this.activeGenerations.values()) {
        if (!this.isCurrentGeneration(update, state)) return true;
      }
    }
    const nextRuns = this.runIds(state);
    return [this.pendingStateRuns, this.lastDeliveredRuns].some((previousRuns) =>
      [...previousRuns].some(([conversationId, runId]) => nextRuns.get(conversationId) !== runId),
    );
  }

  private didDeliverState(state: AppState) {
    this.lastDeliveredRuns = this.runIds(state);
    this.pendingStateRuns = this.pendingState
      ? this.runIds(this.pendingState)
      : new Map<string, string>();
    for (const [key, update] of this.activeGenerations) {
      if (!this.isCurrentGeneration(update, state)) this.activeGenerations.delete(key);
    }
    this.flushTurnReveal();
  }

  private runIds(state: AppState) {
    return new Map(
      state.conversations.flatMap((conversation) =>
        conversation.run ? [[conversation.id, conversation.run.id] as const] : [],
      ),
    );
  }

  private flushComposerFocus() {
    if (!this.pendingComposerFocus || !this.webviewReady) return;
    this.pendingComposerFocus = false;
    void this.post({ type: "focusComposer" });
  }

  private flushTurnReveal() {
    const reveal = this.pendingTurnReveal;
    if (!reveal || !this.webviewReady || this.stateDelivery || this.pendingState) return;
    const deliveryGeneration = this.viewGeneration;
    this.pendingTurnReveal = undefined;
    void this.post(reveal).then((delivered) => {
      if (delivered || this.pendingTurnReveal) return;
      this.pendingTurnReveal = reveal;
      // Replacing a Webview aborts the old delivery asynchronously. The new
      // renderer may complete its ready handshake before that failure restores
      // this request, so explicitly flush it into the new generation. Do not
      // retry against the same renderer here; a persistent post failure would
      // otherwise create a tight loop.
      if (deliveryGeneration !== this.viewGeneration) this.flushTurnReveal();
    });
  }

  private notice(level: "info" | "warning" | "error", message: string) {
    void this.post({ type: "notice", level, message });
  }

  private canDeliverState() {
    // Visibility is a presentation concern, not a delivery guarantee. A
    // retained WebviewView can continue receiving messages while VS Code is
    // rearranging or hiding its container.
    return Boolean(this.view && this.webviewReady);
  }

  private isCurrentView(view: vscode.WebviewView, generation: number) {
    return this.view === view && this.viewGeneration === generation;
  }

  private disposeViewSubscriptions() {
    const disposables = this.viewDisposables;
    this.viewDisposables = [];
    for (const disposable of disposables) disposable.dispose();
  }

  private html(webview: vscode.Webview, initialStateJson: string) {
    const nonce = randomBytes(16).toString("base64");
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "webview.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "webview.css"),
    );

    return `<!doctype html>
<html lang="${vscode.env.language.toLowerCase().startsWith("en") ? "en" : "zh-CN"}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'nonce-${nonce}'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
    <style nonce="${nonce}">
      /*
       * Match the VS Code canvas before the external stylesheet is available.
       * Without this critical layer Chromium paints its default white canvas,
       * which is the visible flash on dark themes.
       */
      :root {
        color-scheme: light dark;
        background: var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e));
      }
      html, body, #root {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e));
        color: var(--vscode-foreground, #cccccc);
      }
      body {
        font-family: var(--vscode-font-family, system-ui, sans-serif);
      }
    </style>
    <link rel="stylesheet" href="${styleUri}" />
    <title>Ask2GPT</title>
  </head>
  <body>
    <div id="root"></div>
    <script id="ask2gpt-initial-state" nonce="${nonce}" type="application/json">${escapeJsonForHtml(initialStateJson)}</script>
    <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

export function escapeJsonForHtml(value: string) {
  return value.replace(/[<>&\u2028\u2029]/g, (character) => {
    switch (character) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return character;
    }
  });
}
