(() => {
  const initialStateElement = document.getElementById("ask2gpt-initial-state");
  if (!initialStateElement?.textContent) throw new Error("Preview initial state is missing.");

  let state = JSON.parse(initialStateElement.textContent);
  let streamTimer;
  let streamStep = 0;
  const parameters = new URLSearchParams(window.location.search);

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const now = () => new Date().toISOString();
  const activeConversation = () =>
    state.conversations.find((conversation) => conversation.id === state.activeConversationId);
  const dispatch = (message) =>
    window.dispatchEvent(new MessageEvent("message", { data: clone(message) }));
  const emitState = () => dispatch({ type: "state", state });
  const emitNotice = (level, message) => dispatch({ type: "notice", level, message });

  function stopStreamTimer() {
    if (streamTimer === undefined) return;
    window.clearInterval(streamTimer);
    streamTimer = undefined;
  }

  function generationUpdate(markdown) {
    const conversation = activeConversation();
    if (!conversation?.run) return;
    const message = conversation.messages.find((item) => item.id === conversation.run.messageId);
    if (!message) return;
    message.markdown = markdown;
    message.status = "streaming";
    conversation.run.status = "streaming";
    conversation.updatedAt = now();
    dispatch({
      type: "generationUpdate",
      update: {
        conversationId: conversation.id,
        messageId: message.id,
        runId: conversation.run.id,
        markdown,
        updatedAt: conversation.updatedAt,
      },
    });
  }

  function startGeneration(question = "重复标签和 `replace()` 会怎样影响结果？请按优先级解释。") {
    stopStreamTimer();
    const conversation = activeConversation();
    if (!conversation) return;
    const startedAt = now();
    const runId = `preview-run-${Date.now()}`;
    const messageId = `preview-assistant-${Date.now()}`;
    conversation.messages.push(
      {
        id: `preview-user-${Date.now()}`,
        role: "user",
        markdown: question,
        status: "complete",
        createdAt: startedAt,
        ...(state.pendingContexts.length > 0 ? { contexts: clone(state.pendingContexts) } : {}),
      },
      {
        id: messageId,
        role: "assistant",
        markdown: "",
        status: "streaming",
        createdAt: startedAt,
      },
    );
    conversation.run = { id: runId, messageId, status: "starting", startedAt };
    conversation.updatedAt = startedAt;
    state.pendingContexts = [];
    state.automaticContextIds = [];
    state.backend.activeRuns = 1;
    emitState();
  }

  function streamLongMarkdown(question) {
    startGeneration(question);
    const chunks = [
      "## 建议先处理这两个问题\n\n",
      "1. **`replace()` 不会让缓存失效**：反馈数量没有变化，旧的 `insights` 会被直接返回。\n\n",
      "```ts\nreplace(item: Feedback): boolean {\n",
      "  // 替换成功后应清空缓存，或改用递增 revision。\n}\n```\n\n",
      "2. **重复标签会重复计数**：同一条反馈里的 `['体验', '体验']` 会贡献两次 mentions。\n",
      "\n优先修缓存一致性，因为它会让调用方在数据已经更新后仍看到旧结论；标签去重则取决于产品语义。",
    ];
    let markdown = "";
    streamStep = 0;
    streamTimer = window.setInterval(
      () => {
        markdown += chunks[streamStep] ?? "";
        generationUpdate(markdown);
        streamStep += 1;
        if (streamStep >= chunks.length) completeGeneration();
      },
      parameters.get("slow") === "1" ? 5_000 : parameters.get("demo") === "1" ? 650 : 220,
    );
  }

  function completeGeneration() {
    stopStreamTimer();
    const conversation = activeConversation();
    if (!conversation?.run) return;
    const run = conversation.run;
    const message = conversation.messages.find((item) => item.id === run.messageId);
    if (message) {
      if (!message.markdown) message.markdown = "预览回答已完成。";
      message.status = "complete";
      message.terminalReceipt = {
        eventId: `preview-complete-${Date.now()}`,
        runId: run.id,
        terminalType: "complete",
      };
    }
    delete conversation.run;
    conversation.updatedAt = now();
    state.backend.activeRuns = 0;
    emitState();
    window.setTimeout(dispatchNextQueued, 80);
  }

  function enqueueFollowUp(message) {
    const conversation = activeConversation();
    if (!conversation?.run || conversation.run.id !== message.targetRunId) {
      dispatch({
        type: "sendResult",
        accepted: false,
        conversationId: message.conversationId,
        requestId: message.requestId,
      });
      return false;
    }
    conversation.queuedFollowUps ??= [];
    if (!conversation.queuedFollowUps.some((item) => item.id === message.requestId)) {
      conversation.queuedFollowUps.push({
        id: message.requestId,
        text: message.text,
        contexts: clone(state.pendingContexts),
        automaticContextIds: clone(state.automaticContextIds),
        createdAt: now(),
      });
    }
    state.pendingContexts = [];
    state.automaticContextIds = [];
    dispatch({
      type: "sendResult",
      accepted: true,
      conversationId: message.conversationId,
      requestId: message.requestId,
    });
    emitState();
    return true;
  }

  function dispatchNextQueued() {
    const conversation = activeConversation();
    if (
      !conversation ||
      conversation.run ||
      conversation.queuePaused ||
      !conversation.queuedFollowUps?.length
    ) {
      return;
    }
    const queued = conversation.queuedFollowUps.shift();
    if (conversation.queuedFollowUps.length === 0) delete conversation.queuedFollowUps;
    startGeneration(queued.text);
    const userMessage = conversation.messages.at(-2);
    if (userMessage?.role === "user") userMessage.clientRequestId = queued.id;
  }

  function stopGeneration(targetRunId, resumeQueueAfterStop = false) {
    stopStreamTimer();
    const conversation = activeConversation();
    if (!conversation?.run || conversation.run.id !== targetRunId) return;
    const run = conversation.run;
    const message = conversation.messages.find((item) => item.id === run.messageId);
    if (message) {
      message.status = "stopped";
      message.terminalReceipt = {
        eventId: `preview-stopped-${Date.now()}`,
        runId: run.id,
        terminalType: "stopped",
      };
    }
    delete conversation.run;
    if (conversation.queuedFollowUps?.length && !resumeQueueAfterStop) {
      conversation.queuePaused = true;
    } else {
      delete conversation.queuePaused;
    }
    conversation.updatedAt = now();
    state.backend.activeRuns = 0;
    emitState();
    if (resumeQueueAfterStop) window.setTimeout(dispatchNextQueued, 80);
  }

  function showError() {
    if (!activeConversation()?.run) startGeneration("请演示错误终态。\n");
    stopStreamTimer();
    const conversation = activeConversation();
    if (!conversation?.run) return;
    const run = conversation.run;
    const message = conversation.messages.find((item) => item.id === run.messageId);
    if (message) {
      message.status = "error";
      message.markdown = "";
      message.runError = {
        code: "CHATGPT_REMOTE_UNAVAILABLE",
        message: "Preview: simulated remote interruption after submission.",
        recoverable: true,
      };
      message.terminalReceipt = {
        eventId: `preview-error-${Date.now()}`,
        runId: run.id,
        terminalType: "error",
      };
    }
    delete conversation.run;
    conversation.updatedAt = now();
    state.backend.activeRuns = 0;
    emitState();
  }

  function reconnect() {
    state.backend.connected = false;
    state.backend.connection.phase = "reconnecting";
    state.backend.connection.since = now();
    emitState();
    window.setTimeout(() => {
      state.backend.connected = true;
      state.backend.connection.phase = "ready";
      state.backend.connection.since = now();
      state.backend.connection.lastConnectedAt = now();
      emitState();
    }, 900);
  }

  function setActiveConversation(conversationId) {
    const conversation = state.conversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    stopStreamTimer();
    state.activeConversationId = conversation.id;
    state.pendingContexts = [];
    state.automaticContextIds = [];
    state.modelPicker = {
      ...state.modelPicker,
      conversationId: conversation.id,
      currentModelId: conversation.selectedModelId ?? "mode-smart",
    };
    if (conversationId === "preview-secondary") {
      emitNotice("info", "已切换到独立示例会话；上下文不会跨会话保留。");
    }
    emitState();
  }

  function handleWebviewMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "ready") return;
    if (message.type === "send") {
      dispatch({
        type: "sendResult",
        accepted: true,
        conversationId: message.conversationId,
        requestId: message.requestId,
      });
      streamLongMarkdown(message.text);
      return;
    }
    if (message.type === "enqueueFollowUp") {
      enqueueFollowUp(message);
      return;
    }
    if (message.type === "interruptWithFollowUp") {
      if (!enqueueFollowUp(message)) return;
      const conversation = activeConversation();
      if (!conversation?.run || conversation.run.id !== message.targetRunId) return;
      conversation.run.status = "stopping";
      conversation.run.resumeQueueAfterStop = true;
      emitState();
      window.setTimeout(() => stopGeneration(message.targetRunId, true), 180);
      return;
    }
    if (message.type === "selectConversation") {
      setActiveConversation(message.conversationId);
      return;
    }
    if (message.type === "stop") {
      stopGeneration(message.targetRunId, false);
      return;
    }
    if (message.type === "regenerate") {
      streamLongMarkdown("请重新生成上一条回答。");
      return;
    }
    if (message.type === "retryConnection") {
      reconnect();
      return;
    }
    if (message.type === "selectModel") {
      const conversation = activeConversation();
      if (conversation) conversation.selectedModelId = message.modelId;
      state.modelPicker.currentModelId = message.modelId;
      state.modelPicker.options = state.modelPicker.options.map((option) => ({
        ...option,
        selected: option.id === message.modelId,
      }));
      emitState();
      return;
    }
    if (message.type === "removeContext") {
      state.pendingContexts = state.pendingContexts.filter(
        (context) => context.id !== message.contextId,
      );
      state.automaticContextIds = state.automaticContextIds.filter(
        (contextId) => contextId !== message.contextId,
      );
      emitState();
      return;
    }
    if (message.type === "copy") {
      void navigator.clipboard?.writeText(message.text);
      return;
    }
    emitNotice("info", `Preview received: ${message.type}`);
  }

  window.acquireVsCodeApi = () => ({ postMessage: handleWebviewMessage });
  window.ask2gptPreview = {
    completeGeneration,
    generationUpdate,
    reconnect,
    setActiveConversation,
    showError,
    streamLongMarkdown,
  };

  if (parameters.get("followUp") === "interrupt") {
    state.composerPreferences.followUpQueueMode = "interrupt";
  }
  const controls = document.getElementById("preview-controls");
  if (controls && parameters.get("controls") === "1") controls.hidden = false;
  controls?.addEventListener("click", (event) => {
    const action = event.target.closest("[data-preview-action]")?.dataset.previewAction;
    if (action === "stream") streamLongMarkdown();
    if (action === "complete") completeGeneration();
    if (action === "error") showError();
    if (action === "reconnect") reconnect();
    if (action === "switch") {
      setActiveConversation(
        state.activeConversationId === "preview-main" ? "preview-secondary" : "preview-main",
      );
    }
  });

  if (parameters.get("scenario") === "sequence") {
    window.setTimeout(() => streamLongMarkdown(), parameters.get("demo") === "1" ? 850 : 350);
  }
})();
