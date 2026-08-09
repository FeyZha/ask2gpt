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

interface NotebookAttachmentAnchor {
  cellIndex: number;
  cellKind: "code" | "markup";
  cellLanguage: string;
  scope: "cell" | "range";
}

interface NotebookAttachmentFormat {
  extension: string;
  mimeType: string;
}

const NOTEBOOK_ATTACHMENT_FORMATS: Readonly<Record<string, NotebookAttachmentFormat>> = {
  bash: { extension: "sh", mimeType: "text/x-shellscript" },
  c: { extension: "c", mimeType: "text/x-c" },
  cpp: { extension: "cpp", mimeType: "text/x-c++src" },
  csharp: { extension: "cs", mimeType: "text/plain" },
  css: { extension: "css", mimeType: "text/css" },
  dart: { extension: "dart", mimeType: "text/plain" },
  go: { extension: "go", mimeType: "text/plain" },
  html: { extension: "html", mimeType: "text/html" },
  java: { extension: "java", mimeType: "text/x-java-source" },
  javascript: { extension: "js", mimeType: "text/javascript" },
  javascriptreact: { extension: "jsx", mimeType: "text/javascript" },
  json: { extension: "json", mimeType: "application/json" },
  jsonc: { extension: "json", mimeType: "application/json" },
  julia: { extension: "jl", mimeType: "text/plain" },
  kotlin: { extension: "kt", mimeType: "text/plain" },
  lua: { extension: "lua", mimeType: "text/plain" },
  markdown: { extension: "md", mimeType: "text/markdown" },
  perl: { extension: "pl", mimeType: "text/plain" },
  php: { extension: "php", mimeType: "text/plain" },
  plaintext: { extension: "txt", mimeType: "text/plain" },
  powershell: { extension: "ps1", mimeType: "text/plain" },
  python: { extension: "py", mimeType: "text/x-python" },
  r: { extension: "r", mimeType: "text/plain" },
  ruby: { extension: "rb", mimeType: "text/plain" },
  rust: { extension: "rs", mimeType: "text/plain" },
  scala: { extension: "scala", mimeType: "text/plain" },
  shellscript: { extension: "sh", mimeType: "text/x-shellscript" },
  sql: { extension: "sql", mimeType: "application/sql" },
  swift: { extension: "swift", mimeType: "text/plain" },
  typescript: { extension: "ts", mimeType: "text/typescript" },
  typescriptreact: { extension: "tsx", mimeType: "text/typescript" },
  xml: { extension: "xml", mimeType: "application/xml" },
  yaml: { extension: "yaml", mimeType: "application/yaml" },
};

const NOTEBOOK_FALLBACK_FORMAT = { extension: "txt", mimeType: "text/plain" } as const;

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
  const notebookAnchor = notebookAttachmentAnchor(context);
  if (notebookAnchor) {
    return uniqueNotebookAttachmentFileName(context, index, notebookAnchor, used);
  }
  const rawBase = context.fileName.split(/[\\/]/u).at(-1) ?? "";
  if (/\.ipynb(?:$|[\p{Cc}\p{Cf}])/iu.test(rawBase.trim())) {
    throw new Ask2GPTError(
      "NOTEBOOK_RAW_CONTEXT_UNSUPPORTED",
      "Notebook 必须按单元格附加，不能发送原始 .ipynb 文件。",
    );
  }
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

function uniqueNotebookAttachmentFileName(
  context: ContextSnapshot,
  index: number,
  anchor: NotebookAttachmentAnchor,
  used: Set<string>,
) {
  const rawBase = context.fileName.split(/[\\/]/u).at(-1) ?? "";
  const withoutNotebookExtension = rawBase.replace(/\.ipynb$/iu, "");
  const safeBase = withoutNotebookExtension
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/[<>:"|?*]/gu, "-")
    .replace(/[\\/]/gu, "-")
    .trim()
    .slice(0, 140);
  const base = safeBase || `notebook-${index + 1}`;
  const cellNumber = String(anchor.cellIndex + 1).padStart(3, "0");
  const range = anchor.scope === "range" ? `.L${context.startLine}-L${context.endLine}` : "";
  const format = notebookAttachmentFormat(anchor.cellLanguage);
  const original = `${base}.cell-${cellNumber}${range}.${format.extension}`;
  let candidate = original;
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
  const notebookAnchor = notebookAttachmentAnchor(context);
  if (notebookAnchor) return notebookAttachmentFormat(notebookAnchor.cellLanguage).mimeType;
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

function notebookAttachmentFormat(language: string) {
  return (
    NOTEBOOK_ATTACHMENT_FORMATS[language.trim().toLocaleLowerCase()] ?? NOTEBOOK_FALLBACK_FORMAT
  );
}

function notebookAttachmentAnchor(context: ContextSnapshot): NotebookAttachmentAnchor | undefined {
  const value = context.sourceAnchor as unknown;
  if (!value || typeof value !== "object") return undefined;
  const anchor = value as Record<string, unknown>;
  if (anchor.formatVersion !== 2) return undefined;
  if (
    !Number.isInteger(anchor.cellIndex) ||
    (anchor.cellIndex as number) < 0 ||
    (anchor.cellKind !== "code" && anchor.cellKind !== "markup") ||
    typeof anchor.cellLanguage !== "string" ||
    (anchor.scope !== "cell" && anchor.scope !== "range")
  ) {
    throw new Ask2GPTError("NOTEBOOK_CONTEXT_INVALID", "Notebook 单元格上下文无效，请重新附加。");
  }
  return {
    cellIndex: anchor.cellIndex as number,
    cellKind: anchor.cellKind,
    cellLanguage: anchor.cellLanguage,
    scope: anchor.scope,
  };
}

function singleLine(value: string) {
  return value.replace(/[\r\n\u2028\u2029]+/gu, " ").trim();
}
