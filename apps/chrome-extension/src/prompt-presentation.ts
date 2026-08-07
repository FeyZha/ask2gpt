export function normalizePromptLineEndings(value: string) {
  return value.replace(/\r\n?/gu, "\n");
}

/**
 * ChatGPT's current ProseMirror build can render a multiline native
 * `insertText` as one paragraph. The editor keeps every character, but each
 * line feed is exposed through the DOM as one ordinary space.
 *
 * Keep this transformation deliberately narrow. It is not general whitespace
 * normalization: tabs, repeated spaces, leading/trailing spaces, and NBSPs
 * remain meaningful so a truncated or otherwise changed prompt cannot pass a
 * pre-dispatch ownership check.
 */
export function singleBlockPromptPresentation(value: string) {
  return normalizePromptLineEndings(value).replace(/\n/gu, " ");
}

/**
 * Version 1 of the deterministic representation produced when ChatGPT renders
 * an Ask2GPT prompt as one inline user-message text node and the relay
 * serializes that node through `serializeAssistant`.
 *
 * Keep this byte-for-byte aligned with markdown.ts `escapeInline(value).trim()`.
 * This intentionally is not a fuzzy comparison: every source whitespace run
 * has one exact presentation, and every Markdown-significant character is
 * escaped exactly once.
 */
export const PROMPT_INLINE_PRESENTATION_VERSION = 1 as const;

export function promptInlinePresentationV1(value: string) {
  return value
    .replace(/\s+/gu, " ")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/([\\`[\]*_])/gu, "\\$1")
    .trim();
}

export function renderedTextMatchesPrompt(
  renderedText: string,
  prompt: string,
  { allowSingleBlockLineFolding = false }: { allowSingleBlockLineFolding?: boolean } = {},
) {
  const actual = normalizePromptLineEndings(renderedText);
  const expected = normalizePromptLineEndings(prompt);
  if (actual === expected) return true;

  // ChatGPT can render an ordinary space as a non-breaking space. Accept that
  // one-way presentation change only. A NBSP supplied by the Host is source
  // text and must remain byte-for-byte identical.
  if (expected.includes("\u00a0")) return false;
  const ordinaryActual = actual.replace(/\u00a0/gu, " ");
  if (ordinaryActual === expected) return true;

  return (
    allowSingleBlockLineFolding &&
    expected.includes("\n") &&
    !ordinaryActual.includes("\n") &&
    ordinaryActual === singleBlockPromptPresentation(expected)
  );
}
