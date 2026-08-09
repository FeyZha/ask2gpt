const PREVIEW_TIME = "2026-07-31T00:00:00.000Z";

function selectionContext() {
  return {
    id: "preview-selection",
    kind: "selection",
    fileName: "insight-board.ts",
    uri: "file:///synthetic/ask2gpt-tour/insight-board.ts",
    language: "typescript",
    startLine: 68,
    endLine: 101,
    content:
      "summarize(limit = 3): Insight[] {\n  if (this.cache?.itemCount === this.feedback.length) {\n    return this.cache.insights;\n  }\n\n  const buckets = new Map<string, Bucket>();\n  // ...\n}",
    charCount: 181,
    unsaved: false,
  };
}

function fileContext() {
  return {
    id: "preview-file",
    kind: "current-file",
    fileName: "insight-board.ts",
    uri: "file:///synthetic/ask2gpt-tour/insight-board.ts",
    language: "typescript",
    startLine: 1,
    endLine: 119,
    content:
      "export class InsightBoard {\n  private readonly feedback: Feedback[] = [];\n  private cache: SummaryCache | undefined;\n  // ...\n}",
    charCount: 132,
    unsaved: false,
  };
}

export function createPreviewState() {
  const context = selectionContext();
  const file = fileContext();
  return {
    activeConversationId: "preview-main",
    backend: {
      activeRuns: 0,
      authenticated: true,
      connected: true,
      connection: {
        phase: "ready",
        since: PREVIEW_TIME,
        browserDetected: true,
        hasStoredTrust: true,
        hostVersion: "0.1.1",
        relayVersion: "0.1.1",
        protocolVersion: 15,
        lastConnectedAt: PREVIEW_TIME,
      },
      port: 32_171,
      project: { bound: true, name: "ask2gpt-tour" },
      selectorVersion: 50,
    },
    conversations: [
      {
        id: "preview-main",
        title: "分析 InsightBoard 缓存",
        remoteUrl: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111",
        selectedModelId: "mode-smart",
        syncStatus: "synced",
        titleSource: "chatgpt",
        lastSyncedAt: PREVIEW_TIME,
        createdAt: PREVIEW_TIME,
        updatedAt: "2026-07-31T00:02:00.000Z",
        messages: [
          {
            id: "preview-user-existing",
            role: "user",
            markdown: "这段 `summarize` 为什么可能返回过期结果？请只分析，不修改代码。",
            status: "complete",
            createdAt: PREVIEW_TIME,
            contexts: [context],
          },
          {
            id: "preview-assistant-existing",
            role: "assistant",
            markdown:
              "问题位于 insight-board.ts:68。缓存只比较 `feedback.length`；`replace()` 改变内容但不改变数量，所以后续 `summarize()` 可能直接返回旧结果。",
            status: "complete",
            createdAt: "2026-07-31T00:02:00.000Z",
          },
        ],
      },
      {
        id: "preview-secondary",
        title: "比较集合设计",
        remoteUrl: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222",
        selectedModelId: "mode-smart",
        syncStatus: "synced",
        titleSource: "chatgpt",
        lastSyncedAt: PREVIEW_TIME,
        createdAt: "2026-07-30T23:00:00.000Z",
        updatedAt: "2026-07-30T23:04:00.000Z",
        messages: [
          {
            id: "preview-secondary-user",
            role: "user",
            markdown: "这里使用 `Map<string, Bucket>` 有什么好处？",
            status: "complete",
            createdAt: "2026-07-30T23:00:00.000Z",
          },
          {
            id: "preview-secondary-assistant",
            role: "assistant",
            markdown:
              "`Map` 直接表达动态键集合，也避免对象原型键冲突；若主要目标是 JSON 序列化，普通对象会更方便。",
            status: "complete",
            createdAt: "2026-07-30T23:04:00.000Z",
          },
        ],
      },
    ],
    modelPicker: {
      conversationId: "preview-main",
      status: "ready",
      currentModelId: "mode-smart",
      options: [
        {
          id: "mode-smart",
          label: "Smart",
          mode: "smart",
          modelId: "gpt-5.5",
          familyLabel: "GPT-5.5",
          selected: true,
        },
        {
          id: "mode-fast",
          label: "Fast",
          mode: "fast",
          modelId: "gpt-5.5-instant",
          familyLabel: "GPT-5.5",
          secondaryLabel: "5.5",
          selected: false,
        },
        {
          id: "mode-low",
          label: "Light",
          mode: "low",
          modelId: "gpt-5.5-thinking",
          familyLabel: "GPT-5.6 Sol",
          reasoningEffort: "min",
          selected: false,
        },
        {
          id: "mode-medium",
          label: "Medium",
          mode: "medium",
          modelId: "gpt-5.5-thinking",
          familyLabel: "GPT-5.6 Sol",
          reasoningEffort: "standard",
          selected: false,
        },
        {
          id: "mode-high",
          label: "High",
          mode: "high",
          modelId: "gpt-5.5-thinking",
          familyLabel: "GPT-5.6 Sol",
          reasoningEffort: "extended",
          selected: false,
        },
        {
          id: "mode-very-high",
          label: "Extra High",
          mode: "very-high",
          modelId: "gpt-5.5-thinking",
          familyLabel: "GPT-5.6 Sol",
          reasoningEffort: "max",
          selected: false,
        },
        {
          id: "mode-pro",
          label: "Pro",
          mode: "pro",
          modelId: "gpt-5.6-pro",
          familyLabel: "GPT-5.6 Sol Pro",
          reasoningEffort: "standard",
          selected: false,
        },
      ],
    },
    composerPreferences: {
      followUpQueueMode: "queue",
      composerEnterBehavior: "enter",
    },
    sourceTraceHints: {
      "preview-main": {
        "preview-assistant-existing": {
          fileReferences: ["insight-board.ts:68"],
          sourceSymbols: ["summarize"],
        },
      },
    },
    locale: "zh-CN",
    pendingContexts: [context, file],
    automaticContextIds: [],
    contextLocked: false,
    dispatchingConversationIds: [],
  };
}

export function validatePreviewState(state) {
  const failures = [];
  const activeConversation = state.conversations?.find(
    (conversation) => conversation.id === state.activeConversationId,
  );
  if (!activeConversation) failures.push("activeConversationId must resolve to a conversation");
  if (!Array.isArray(state.pendingContexts)) failures.push("pendingContexts must be an array");
  if (!Array.isArray(state.automaticContextIds)) {
    failures.push("automaticContextIds must be an array");
  }
  if (typeof state.contextLocked !== "boolean") failures.push("contextLocked must be boolean");
  if (!state.backend?.connection?.phase) failures.push("backend.connection.phase is required");
  if (!state.sourceTraceHints || typeof state.sourceTraceHints !== "object") {
    failures.push("sourceTraceHints are required for the linked-source preview");
  }
  if (typeof state.backend?.connection?.browserDetected !== "boolean") {
    failures.push("backend.connection.browserDetected is required");
  }
  if (typeof state.backend?.connection?.hasStoredTrust !== "boolean") {
    failures.push("backend.connection.hasStoredTrust is required");
  }
  if (state.modelPicker?.conversationId !== state.activeConversationId) {
    failures.push("modelPicker must be scoped to the active conversation");
  }
  if (!["queue", "interrupt"].includes(state.composerPreferences?.followUpQueueMode)) {
    failures.push("composerPreferences.followUpQueueMode is invalid");
  }
  if (
    !["enter", "cmdIfMultiline", "cmdAlways"].includes(
      state.composerPreferences?.composerEnterBehavior,
    )
  ) {
    failures.push("composerPreferences.composerEnterBehavior is invalid");
  }
  for (const conversation of state.conversations ?? []) {
    if (!Array.isArray(conversation.messages)) {
      failures.push(`conversation ${conversation.id} is missing messages`);
    }
  }
  if (failures.length > 0) throw new Error(`Invalid preview AppState:\n- ${failures.join("\n- ")}`);
  return state;
}
