const transientAssistantStatuses = new Set([
  "正在思考",
  "思考中",
  "正在生成",
  "生成中",
  "正在回答",
  "正在处理",
  "thinking",
  "working",
  "generating",
  "responding",
  "processing",
]);

/**
 * ChatGPT can briefly mount a localized progress label inside the current
 * assistant turn. It is page chrome, not answer content, and must never be
 * used as a snapshot or as terminal evidence for a relay run.
 */
export function isTransientAssistantStatus(markdown: string) {
  const normalized = markdown
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .trim()
    .replace(/^[*_~`#>\s]+|[*_~`\s]+$/gu, "")
    .replace(/[.。!！…]+$/gu, "")
    .trim()
    .toLocaleLowerCase("en-US");
  return transientAssistantStatuses.has(normalized);
}

export function usableAssistantMarkdown(markdown: string) {
  const trimmed = markdown.trim();
  return trimmed && !isTransientAssistantStatus(trimmed) ? trimmed : "";
}
