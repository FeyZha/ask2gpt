import {
  MAX_INLINE_CONTEXT_BUNDLE_CHARS,
  MAX_INLINE_CONTEXT_CHARS,
  type ChatFileAttachment,
  type ContextSnapshot,
} from "@ask2gpt/protocol";

import { assertAllowedContextBundle } from "./context-policy";
import { Ask2GPTError } from "./errors";

export const MAX_QUESTION_CHARS = 20_000;

export type ContextDeliveryMode = "file";

export interface ContextDeliveryItem {
  contextId: string;
  mode: ContextDeliveryMode;
  fileName?: string;
}

export interface VisiblePromptPlan {
  prompt: string;
  attachments: ChatFileAttachment[];
  delivery: ContextDeliveryItem[];
}

export function buildVisiblePrompt(question: string, contexts: readonly ContextSnapshot[] = []) {
  return buildVisiblePromptPlan(question, contexts).prompt;
}

export function buildVisiblePromptPlan(
  question: string,
  contexts: readonly ContextSnapshot[] = [],
): VisiblePromptPlan {
  const trimmed = question.trim();
  if (!trimmed) {
    throw new Ask2GPTError("QUESTION_EMPTY", "问题不能为空。");
  }
  if (trimmed.length > MAX_QUESTION_CHARS) {
    throw new Ask2GPTError(
      "QUESTION_TOO_LARGE",
      `问题超过 ${MAX_QUESTION_CHARS.toLocaleString()} 字符。`,
    );
  }
  if (contexts.length === 0) return { prompt: trimmed, attachments: [], delivery: [] };
  assertAllowedContextBundle(contexts);

  const usedFileNames = new Set<string>();
  const attachments: ChatFileAttachment[] = [];
  const delivery: ContextDeliveryItem[] = [];

  contexts.forEach((context, index) => {
    const fileName = uniqueAttachmentFileName(context, index, usedFileNames);
    attachments.push({
      id: context.id,
      fileName,
      mimeType: mimeTypeForContext(context),
      content: context.content,
    });
    delivery.push({ contextId: context.id, mode: "file", fileName });
  });

  // Keep the human-visible question untouched. Code snapshots travel as
  // bounded file attachments, so ChatGPT receives the same context without
  // expanding transport metadata and source text into the conversation UI.
  return { prompt: trimmed, attachments, delivery };
}

export function planContextDelivery(contexts: readonly ContextSnapshot[]) {
  if (contexts.length === 0) return [];
  return buildVisiblePromptPlan("preview", contexts).delivery;
}

/**
 * Reconstructs the transport text used before 0.1.0 so a restored ChatGPT
 * snapshot cannot replace a compact local context card with the old expanded
 * prompt. New sends must only use buildVisiblePromptPlan.
 */
export function buildLegacyVisiblePrompt(
  question: string,
  contexts: readonly ContextSnapshot[] = [],
) {
  return buildLegacyVisiblePromptPlan(question, contexts).prompt;
}

export function buildLegacyVisiblePromptPlan(
  question: string,
  contexts: readonly ContextSnapshot[] = [],
) {
  const trimmed = question.trim();
  if (contexts.length === 0) return { prompt: trimmed, attachmentFileNames: [] as string[] };
  assertAllowedContextBundle(contexts);

  let inlineChars = 0;
  const usedFileNames = new Set<string>();
  const inlineSections: string[] = [];
  const attachmentLines: string[] = [];
  const attachmentFileNames: string[] = [];

  contexts.forEach((context, index) => {
    const canInline =
      context.content.length <= MAX_INLINE_CONTEXT_CHARS &&
      inlineChars + context.content.length <= MAX_INLINE_CONTEXT_BUNDLE_CHARS;
    const label = `${index + 1}/${contexts.length}`;
    if (canInline) {
      inlineChars += context.content.length;
      inlineSections.push(
        `${legacyContextHeader(context, `Context ${label}:`)}\n\n${context.content}\n\n--- End Context ${label} ---`,
      );
      return;
    }

    const fileName = uniqueAttachmentFileName(context, index, usedFileNames);
    attachmentFileNames.push(fileName);
    attachmentLines.push(
      `- ${fileName} — ${singleLine(context.language)}, lines ${context.startLine}-${context.endLine}, ${context.charCount.toLocaleString()} chars${context.unsaved ? ", unsaved snapshot" : ""}`,
    );
  });

  const sections = [...inlineSections];
  if (attachmentLines.length > 0) {
    sections.push(`Attached code files:\n${attachmentLines.join("\n")}`);
  }
  return {
    prompt: `${sections.join("\n\n")}\n\nQuestion:\n${trimmed}`,
    attachmentFileNames,
  };
}

function legacyContextHeader(context: ContextSnapshot, heading: string) {
  return [
    heading,
    `File: ${singleLine(context.fileName)}`,
    `Language: ${singleLine(context.language)}`,
    `Lines: ${context.startLine}-${context.endLine}`,
    context.unsaved ? "State: Unsaved" : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function uniqueAttachmentFileName(context: ContextSnapshot, index: number, used: Set<string>) {
  const rawBase = context.fileName.split(/[\\/]/u).at(-1) ?? "";
  const safeBase = rawBase
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/[<>:"|?*]/gu, "-")
    .replace(/[\\/]/gu, "-")
    .trim()
    .slice(0, 180);
  let candidate = safeBase || `context-${index + 1}.txt`;
  if (context.kind === "selection") candidate = withRange(candidate, context);
  const original = candidate;
  let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase())) {
    candidate = withNumericSuffix(original, suffix);
    suffix += 1;
  }
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

function withRange(fileName: string, context: ContextSnapshot) {
  const marker = `.L${context.startLine}-L${context.endLine}`;
  const dot = fileName.lastIndexOf(".");
  return dot > 0
    ? `${fileName.slice(0, dot)}${marker}${fileName.slice(dot)}`
    : `${fileName}${marker}.txt`;
}

function withNumericSuffix(fileName: string, suffix: number) {
  const dot = fileName.lastIndexOf(".");
  return dot > 0
    ? `${fileName.slice(0, dot)}-${suffix}${fileName.slice(dot)}`
    : `${fileName}-${suffix}`;
}

function mimeTypeForContext(context: ContextSnapshot) {
  const language = context.language.toLocaleLowerCase();
  if (["javascript", "javascriptreact"].includes(language)) return "text/javascript";
  if (["typescript", "typescriptreact"].includes(language)) return "text/typescript";
  if (language === "json" || language === "jsonc") return "application/json";
  if (language === "html") return "text/html";
  if (language === "css") return "text/css";
  if (language === "markdown") return "text/markdown";
  if (language === "xml") return "application/xml";
  return "text/plain";
}

function singleLine(value: string) {
  return value.replace(/[\r\n\u2028\u2029]+/gu, " ").trim();
}
