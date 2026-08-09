import type { ContextSnapshot, Conversation } from "@ask2gpt/protocol";

import { parseAnswerSourceReferences } from "./answer-source-reference";
import { extractAnswerSourceDefinitions } from "./answer-source-symbol";
import { planContextDelivery } from "./services/prompt-builder";
import type { AppState, SourceTraceHint } from "./types";

const MAX_HINTED_ASSISTANT_MESSAGES = 200;
const MAX_SOURCE_FILE_REFERENCES = 1_000;
const MAX_SOURCE_SYMBOLS = 4_096;
const SOURCE_TRACE_HINT_POLICY =
  "source-trace-policy:active-only;assistant=200;file-references=1000;symbols=4096";

interface ConversationHintCacheEntry {
  hints: Record<string, SourceTraceHint>;
  lastMessage: Conversation["messages"][number] | undefined;
  messageCount: number;
  messages: Conversation["messages"];
  policy: typeof SOURCE_TRACE_HINT_POLICY;
  updatedAt: string;
}

const conversationHintCache = new WeakMap<Conversation, ConversationHintCacheEntry>();

interface TraceContextHint {
  attachmentFileName?: string;
  context: ContextSnapshot;
}

/**
 * Adds bounded, host-authoritative link affordances without mutating or
 * persisting the controller's state. Streaming answers remain undecorated;
 * their terminal full state receives one stable index.
 */
export function withSourceTraceHints(state: AppState): AppState {
  const sourceTraceHints: Record<string, Record<string, SourceTraceHint>> = {};

  // The transcript renderer only consumes hints for the active conversation.
  // Keeping archived and inactive histories out of this derived payload bounds
  // both Extension Host work and the state JSON sent across the Webview bridge.
  const conversation = state.conversations.find(
    (candidate) => candidate.id === state.activeConversationId,
  );
  if (conversation) {
    const conversationHints = cachedConversationHints(conversation);
    if (Object.keys(conversationHints).length > 0) {
      sourceTraceHints[conversation.id] = conversationHints;
    }
  }

  const decorated = { ...state };
  delete decorated.sourceTraceHints;
  if (Object.keys(sourceTraceHints).length > 0) decorated.sourceTraceHints = sourceTraceHints;
  return decorated;
}

function cachedConversationHints(conversation: Conversation) {
  const messages = conversation.messages;
  const cached = conversationHintCache.get(conversation);
  const lastMessage = messages.at(-1);
  if (
    cached?.updatedAt === conversation.updatedAt &&
    cached.messages === messages &&
    cached.messageCount === messages.length &&
    cached.lastMessage === lastMessage &&
    cached.policy === SOURCE_TRACE_HINT_POLICY
  ) {
    return cached.hints;
  }

  const hints = buildConversationHints(conversation);
  conversationHintCache.set(conversation, {
    hints,
    lastMessage,
    messageCount: messages.length,
    messages,
    policy: SOURCE_TRACE_HINT_POLICY,
    updatedAt: conversation.updatedAt,
  });
  return hints;
}

function buildConversationHints(conversation: Conversation) {
  const hints: Record<string, SourceTraceHint> = {};
  let processedAssistantMessages = 0;
  let remainingFileReferences = MAX_SOURCE_FILE_REFERENCES;
  let remainingSourceSymbols = MAX_SOURCE_SYMBOLS;

  for (let messageIndex = conversation.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = conversation.messages[messageIndex]!;
    if (message.role !== "assistant" || message.status === "streaming") continue;
    if (
      processedAssistantMessages >= MAX_HINTED_ASSISTANT_MESSAGES ||
      (remainingFileReferences === 0 && remainingSourceSymbols === 0)
    ) {
      break;
    }
    processedAssistantMessages += 1;
    const traceContexts = nearestTraceContexts(conversation, messageIndex);
    if (traceContexts.length === 0) continue;

    const fileReferences = traceableFileReferences(
      message.markdown,
      traceContexts,
      remainingFileReferences,
    );
    const sourceSymbols = uniqueSourceDefinitions(
      traceContexts.map(({ context }) => context.content),
      remainingSourceSymbols,
    );
    if (fileReferences.length === 0 && sourceSymbols.length === 0) continue;
    hints[message.id] = { fileReferences, sourceSymbols };
    remainingFileReferences -= fileReferences.length;
    remainingSourceSymbols -= sourceSymbols.length;
  }

  return hints;
}

function nearestTraceContexts(conversation: Conversation, beforeIndex: number) {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message?.role !== "user") continue;
    if (!message.contexts || message.contexts.length === 0) return [];
    let delivery: ReturnType<typeof planContextDelivery> = [];
    try {
      delivery = planContextDelivery(message.contexts);
    } catch {
      // Persisted legacy snapshots can outlive a tighter current bundle cap.
    }
    return message.contexts.map((context) => ({
      context,
      attachmentFileName: delivery.find((item) => item.contextId === context.id)?.fileName,
    }));
  }
  return [];
}

function traceableFileReferences(markdown: string, contexts: TraceContextHint[], limit: number) {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const reference of parseAnswerSourceReferences(markdown)) {
    if (result.length >= limit) break;
    if (seen.has(reference.raw) || !referenceMatchesContext(reference, contexts)) continue;
    seen.add(reference.raw);
    result.push(reference.raw);
  }
  return result;
}

function referenceMatchesContext(
  reference: ReturnType<typeof parseAnswerSourceReferences>[number],
  contexts: TraceContextHint[],
) {
  return contexts.some((candidate) => {
    const match = fileNameMatch(reference.path, candidate);
    if (!match) return false;
    const context = candidate.context;
    if (match.attachmentAlias && context.kind === "selection") {
      const lineCount = context.content.split(/\r?\n/u).length;
      if (reference.startLine >= 1 && reference.endLine <= lineCount) {
        const translatedStart = context.startLine + reference.startLine - 1;
        const translatedEnd = context.startLine + reference.endLine - 1;
        if (translatedStart >= context.startLine && translatedEnd <= context.endLine) return true;
      }
    }
    return reference.startLine >= context.startLine && reference.endLine <= context.endLine;
  });
}

function fileNameMatch(referencePath: string, candidate: TraceContextHint) {
  const reference = normalizePath(referencePath);
  const original = normalizePath(candidate.context.fileName);
  const attachment = candidate.attachmentFileName
    ? normalizePath(candidate.attachmentFileName)
    : undefined;
  const referenceBase = pathBaseName(reference);
  const originalBase = pathBaseName(original);

  if (attachment && (reference === attachment || reference.endsWith(`/${attachment}`))) {
    return { attachmentAlias: true };
  }
  if (
    reference === original ||
    reference.endsWith(`/${original}`) ||
    original.endsWith(`/${reference}`) ||
    referenceBase === originalBase
  ) {
    return { attachmentAlias: false };
  }
  return undefined;
}

function normalizePath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase();
}

function pathBaseName(value: string) {
  return value.split("/").at(-1) ?? value;
}

function uniqueSourceDefinitions(contents: string[], limit: number) {
  if (limit <= 0) return [];
  const symbols = new Set<string>();
  for (const content of contents) {
    for (const definition of extractAnswerSourceDefinitions(content)) {
      symbols.add(definition.name);
      if (symbols.size >= limit) return [...symbols];
    }
  }
  return [...symbols].sort();
}
