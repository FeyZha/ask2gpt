import { describe, expect, it } from "vitest";

import { parseWebviewMessage } from "./webview-message-validation";

describe("parseWebviewMessage", () => {
  it("accepts supported bounded messages", () => {
    expect(parseWebviewMessage({ type: "ready" })).toEqual({ type: "ready" });
    expect(
      parseWebviewMessage({
        type: "newConversation",
        sourceConversationId: "conversation-1",
      }),
    ).toEqual({ type: "newConversation", sourceConversationId: "conversation-1" });
    expect(
      parseWebviewMessage({
        type: "send",
        conversationId: "conversation-1",
        requestId: "request-1",
        text: "解释这段代码",
      }),
    ).toEqual({
      type: "send",
      conversationId: "conversation-1",
      requestId: "request-1",
      text: "解释这段代码",
    });
    expect(
      parseWebviewMessage({
        type: "enqueueFollowUp",
        conversationId: "conversation-1",
        targetRunId: "run-1",
        requestId: "queue-1",
        text: "继续修复",
      }),
    ).toBeDefined();
    expect(
      parseWebviewMessage({
        type: "interruptWithFollowUp",
        conversationId: "conversation-1",
        targetRunId: "run-1",
        requestId: "interrupt-1",
        text: "Stop this answer and continue",
      }),
    ).toEqual({
      type: "interruptWithFollowUp",
      conversationId: "conversation-1",
      targetRunId: "run-1",
      requestId: "interrupt-1",
      text: "Stop this answer and continue",
    });
    expect(
      parseWebviewMessage({
        type: "stop",
        conversationId: "conversation-1",
        targetRunId: "run-1",
      }),
    ).toEqual({
      type: "stop",
      conversationId: "conversation-1",
      targetRunId: "run-1",
    });
    expect(
      parseWebviewMessage({
        type: "updateQueuedFollowUp",
        conversationId: "conversation-1",
        queueId: "queue-1",
        text: "改成运行完整测试",
      }),
    ).toBeDefined();
    expect(
      parseWebviewMessage({
        type: "removeQueuedFollowUp",
        conversationId: "conversation-1",
        queueId: "queue-1",
      }),
    ).toBeDefined();
    expect(
      parseWebviewMessage({ type: "resumeQueue", conversationId: "conversation-1" }),
    ).toBeDefined();
    expect(
      parseWebviewMessage({ type: "prepareConversation", conversationId: "conversation-1" }),
    ).toEqual({ type: "prepareConversation", conversationId: "conversation-1" });
    expect(
      parseWebviewMessage({
        type: "regenerate",
        conversationId: "conversation-1",
        messageId: "message_1",
      }),
    ).toBeDefined();
    expect(parseWebviewMessage({ type: "attachFiles", conversationId: "conversation-1" })).toEqual({
      type: "attachFiles",
      conversationId: "conversation-1",
    });
    expect(
      parseWebviewMessage({ type: "attachSelection", conversationId: "conversation-1" }),
    ).toEqual({ type: "attachSelection", conversationId: "conversation-1" });
    expect(
      parseWebviewMessage({ type: "attachNotebookCell", conversationId: "conversation-1" }),
    ).toEqual({ type: "attachNotebookCell", conversationId: "conversation-1" });
    expect(
      parseWebviewMessage({ type: "archiveConversation", conversationId: "conversation-1" }),
    ).toEqual({ type: "archiveConversation", conversationId: "conversation-1" });
    expect(
      parseWebviewMessage({
        type: "unarchiveConversation",
        activate: false,
        conversationId: "conversation-1",
      }),
    ).toEqual({
      type: "unarchiveConversation",
      activate: false,
      conversationId: "conversation-1",
    });
    expect(parseWebviewMessage({ type: "listModels", conversationId: "conversation-1" })).toEqual({
      type: "listModels",
      conversationId: "conversation-1",
    });
    expect(
      parseWebviewMessage({
        type: "selectModel",
        conversationId: "conversation-1",
        modelId: "mode-high",
      }),
    ).toEqual({
      type: "selectModel",
      conversationId: "conversation-1",
      modelId: "mode-high",
    });
    expect(
      parseWebviewMessage({
        type: "removeContext",
        conversationId: "conversation-1",
        contextId: "context-1",
      }),
    ).toEqual({
      type: "removeContext",
      conversationId: "conversation-1",
      contextId: "context-1",
    });
    expect(
      parseWebviewMessage({
        type: "openContext",
        conversationId: "conversation-1",
        contextId: "context-1",
      }),
    ).toEqual({
      type: "openContext",
      conversationId: "conversation-1",
      contextId: "context-1",
    });
    expect(
      parseWebviewMessage({
        type: "openSourceReference",
        conversationId: "conversation-1",
        messageId: "message-1",
        kind: "file-line",
        reference: "06_vector_store.py:34-39",
      }),
    ).toEqual({
      type: "openSourceReference",
      conversationId: "conversation-1",
      messageId: "message-1",
      kind: "file-line",
      reference: "06_vector_store.py:34-39",
    });
  });

  it("rejects unknown, malformed and oversized messages", () => {
    expect(parseWebviewMessage({ type: "unknown" })).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "openSourceReference",
        conversationId: "conversation-1",
        messageId: "message-1",
        kind: "file-line",
        reference: "06_vector_store.py:34",
        uri: "file:///outside.py",
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "openSourceReference",
        conversationId: "conversation-1",
        messageId: "../message",
        kind: "symbol",
        reference: "get_embeddings_endpoint",
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "openSourceReference",
        conversationId: "conversation-1",
        messageId: "message-1",
        kind: "other",
        reference: "get_embeddings_endpoint",
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "openSourceReference",
        conversationId: "conversation-1",
        messageId: "message-1",
        kind: "symbol",
        reference: "x".repeat(769),
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({ type: "deleteConversation", conversationId: "../x" }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "send",
        conversationId: "conversation-1",
        requestId: "request-1",
        text: "x".repeat(20_001),
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "send",
        conversationId: "conversation-1",
        text: "missing id",
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({ type: "send", requestId: "request-1", text: "missing conversation" }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "enqueueFollowUp",
        conversationId: "conversation-1",
        targetRunId: "run-1",
        text: "missing request id",
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "enqueueFollowUp",
        conversationId: "conversation-1",
        requestId: "queue-1",
        text: "missing target run",
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "enqueueFollowUp",
        conversationId: "conversation-1",
        targetRunId: "../run",
        requestId: "queue-1",
        text: "unsafe target run",
      }),
    ).toBeUndefined();
    expect(parseWebviewMessage({ type: "stop", conversationId: "conversation-1" })).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "stop",
        conversationId: "conversation-1",
        targetRunId: "../run",
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "interruptWithFollowUp",
        conversationId: "conversation-1",
        requestId: "interrupt-1",
        text: "missing target run",
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "interruptWithFollowUp",
        conversationId: "conversation-1",
        targetRunId: "run-1",
        requestId: "../interrupt",
        text: "unsafe request id",
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "interruptWithFollowUp",
        conversationId: "conversation-1",
        targetRunId: "run-1",
        requestId: "interrupt-1",
        text: "x".repeat(20_001),
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "updateQueuedFollowUp",
        conversationId: "conversation-1",
        queueId: "../queue",
        text: "unsafe id",
      }),
    ).toBeUndefined();
    expect(parseWebviewMessage({ type: "copy", text: 42 })).toBeUndefined();
    expect(parseWebviewMessage({ type: "attachFiles" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "attachSelection" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "attachNotebookCell" })).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "attachNotebookCell",
        conversationId: "conversation-1",
        notebookUri: "vscode-notebook-cell:/forged",
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({ type: "attachSelection", conversationId: "../conversation" }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "attachSelection",
        conversationId: "conversation-1",
        selection: "untrusted",
      }),
    ).toBeUndefined();
    expect(parseWebviewMessage({ type: "selectModel", modelId: "mode-high" })).toBeUndefined();
    expect(
      parseWebviewMessage({ type: "unarchiveConversation", conversationId: "conversation-1" }),
    ).toBeUndefined();
    expect(parseWebviewMessage({ type: "listModels" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "newConversation" })).toBeUndefined();
    expect(
      parseWebviewMessage({ type: "newConversation", sourceConversationId: "../conversation" }),
    ).toBeUndefined();
    expect(parseWebviewMessage({ type: "removeContext" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "removeContext", contextId: "../context" })).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "removeContext",
        conversationId: "conversation-1",
        contextId: "../context",
      }),
    ).toBeUndefined();
    expect(parseWebviewMessage({ type: "openContext", contextId: "context-1" })).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: "openContext",
        conversationId: "conversation-1",
        contextId: "context-1",
        uri: "file:///must-not-be-accepted.ts",
        startLine: 1,
        endLine: 2,
      }),
    ).toBeUndefined();
  });
});
