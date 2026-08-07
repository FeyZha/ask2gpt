import type { WebviewToHostMessage } from "./types";

const MAX_ID_LENGTH = 128;
const MAX_QUESTION_LENGTH = 20_000;
const MAX_COPY_LENGTH = 2 * 1024 * 1024;
const MAX_EXTERNAL_URL_LENGTH = 4096;
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function parseWebviewMessage(value: unknown): WebviewToHostMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;

  switch (value.type) {
    case "ready":
    case "retryConnection":
    case "openChatGpt":
    case "copyDiagnostics":
      return value as WebviewToHostMessage;
    case "newConversation":
      return isId(value.sourceConversationId) ? (value as WebviewToHostMessage) : undefined;
    case "attachCurrentFile":
    case "attachFiles":
      return isId(value.conversationId) ? (value as WebviewToHostMessage) : undefined;
    case "removeContext":
      return isId(value.conversationId) && isId(value.contextId)
        ? (value as WebviewToHostMessage)
        : undefined;
    case "openContext":
      return isId(value.conversationId) &&
        isId(value.contextId) &&
        hasOnlyKeys(value, ["type", "conversationId", "contextId"])
        ? {
            type: "openContext",
            conversationId: value.conversationId,
            contextId: value.contextId,
          }
        : undefined;
    case "selectConversation":
    case "archiveConversation":
    case "deleteConversation":
    case "prepareConversation":
    case "resumeQueue":
      return isId(value.conversationId) ? (value as WebviewToHostMessage) : undefined;
    case "stop":
      return isId(value.conversationId) &&
        isId(value.targetRunId) &&
        hasOnlyKeys(value, ["type", "conversationId", "targetRunId"])
        ? (value as WebviewToHostMessage)
        : undefined;
    case "unarchiveConversation":
      return isId(value.conversationId) && typeof value.activate === "boolean"
        ? (value as WebviewToHostMessage)
        : undefined;
    case "listModels":
      return isId(value.conversationId) ? (value as WebviewToHostMessage) : undefined;
    case "selectModel":
      return isId(value.conversationId) && isId(value.modelId)
        ? (value as WebviewToHostMessage)
        : undefined;
    case "renameConversation":
      return isId(value.conversationId) && isString(value.title, 1, 80)
        ? (value as WebviewToHostMessage)
        : undefined;
    case "send":
    case "enqueueFollowUp":
    case "interruptWithFollowUp":
      return isId(value.conversationId) &&
        isId(value.requestId) &&
        (value.type === "send" || isId(value.targetRunId)) &&
        isString(value.text, 1, MAX_QUESTION_LENGTH)
        ? (value as WebviewToHostMessage)
        : undefined;
    case "updateQueuedFollowUp":
      return isId(value.conversationId) &&
        isId(value.queueId) &&
        isString(value.text, 1, MAX_QUESTION_LENGTH)
        ? (value as WebviewToHostMessage)
        : undefined;
    case "removeQueuedFollowUp":
      return isId(value.conversationId) && isId(value.queueId)
        ? (value as WebviewToHostMessage)
        : undefined;
    case "regenerate":
      return isId(value.conversationId) && isId(value.messageId)
        ? (value as WebviewToHostMessage)
        : undefined;
    case "copy":
      return isString(value.text, 0, MAX_COPY_LENGTH) ? (value as WebviewToHostMessage) : undefined;
    case "openExternal":
      return isString(value.url, 1, MAX_EXTERNAL_URL_LENGTH)
        ? (value as WebviewToHostMessage)
        : undefined;
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function isId(value: unknown): value is string {
  return isString(value, 1, MAX_ID_LENGTH) && ID_PATTERN.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}
