const PREVIEW_TIME = "2026-07-31T00:00:00.000Z";

function selectionContext() {
  return {
    id: "preview-selection",
    kind: "selection",
    fileName: "relay-client.ts",
    uri: "file:///preview/relay-client.ts",
    language: "typescript",
    startLine: 42,
    endLine: 58,
    content:
      "export function routeFrame(frame: RelayFrame) {\n  return sessions.get(frame.conversationId);\n}",
    charCount: 98,
    unsaved: false,
  };
}

function fileContext() {
  return {
    id: "preview-file",
    kind: "current-file",
    fileName: "relay-session.ts",
    uri: "file:///preview/relay-session.ts",
    language: "typescript",
    startLine: 1,
    endLine: 84,
    content: "export class RelaySession {\n  constructor(readonly conversationId: string) {}\n}",
    charCount: 82,
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
        hostVersion: "0.0.1",
        relayVersion: "0.0.1",
        protocolVersion: 13,
        lastConnectedAt: PREVIEW_TIME,
      },
      port: 32_171,
      project: { bound: true, name: "gpt_plugin" },
      selectorVersion: 1,
    },
    conversations: [
      {
        id: "preview-main",
        title: "验证 Relay 流式体验",
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
            markdown: "说明 Chrome Relay 如何避免把回复写进错误的会话。",
            status: "complete",
            createdAt: PREVIEW_TIME,
            contexts: [context],
          },
          {
            id: "preview-assistant-existing",
            role: "assistant",
            markdown:
              "Relay 以 `conversationId + runId` 绑定每一轮，并在收到终态后确认同一条远端会话。",
            status: "complete",
            createdAt: "2026-07-31T00:02:00.000Z",
          },
        ],
      },
      {
        id: "preview-secondary",
        title: "上下文隔离检查",
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
            markdown: "这个会话只应显示 relay-session.ts 的上下文。",
            status: "complete",
            createdAt: "2026-07-30T23:00:00.000Z",
          },
          {
            id: "preview-secondary-assistant",
            role: "assistant",
            markdown: "已隔离：切换回来时，草稿和附件仍按会话分别保存。",
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
