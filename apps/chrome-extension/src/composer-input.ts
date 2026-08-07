import { normalizePromptLineEndings, renderedTextMatchesPrompt } from "./prompt-presentation";

export function setComposerText(element: HTMLElement, text: string) {
  element.focus();
  if (element instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) throw new Error("无法写入 ChatGPT 输入框。");
    setter.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection?.removeAllRanges();
  selection?.addRange(range);

  // Native insertion updates ChatGPT's editor state and emits its own input
  // event. A second synthetic input event makes newer controlled-editor builds
  // restore their previous (often empty) state.
  insertNativeContentEditableText(text);
  if (composerTextMatchesPrompt(element, text)) return;

  // Conservative fallback for editor variants where native insertion makes no
  // observable DOM change. This path owns the single input notification.
  element.replaceChildren(document.createTextNode(text));
  element.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text,
    }),
  );
}

export function readComposerText(element: HTMLElement) {
  const text =
    element instanceof HTMLTextAreaElement ? element.value : readContentEditablePlainText(element);
  return normalizePromptLineEndings(text);
}

export function composerTextMatchesPrompt(element: HTMLElement, prompt: string) {
  const actual = readComposerText(element);
  return renderedTextMatchesPrompt(actual, prompt);
}

function insertNativeContentEditableText(text: string) {
  const normalized = normalizePromptLineEndings(text);
  const lines = normalized.split("\n");
  document.execCommand("insertText", false, lines[0] ?? "");
  for (const line of lines.slice(1)) {
    // ProseMirror's insertText transaction normalizes embedded line feeds to
    // spaces. Issue native editing boundaries instead so both its editor state
    // and the DOM retain the exact multiline prompt. A paragraph is the
    // broadly-supported fallback when the soft line-break command is absent.
    if (!document.execCommand("insertLineBreak", false)) {
      document.execCommand("insertParagraph", false);
    }
    if (line) document.execCommand("insertText", false, line);
  }
}

const EDITOR_BLOCK_TAGS = new Set([
  "ADDRESS",
  "BLOCKQUOTE",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "P",
  "PRE",
]);

function readContentEditablePlainText(root: HTMLElement) {
  return serializeEditableChildren(root);
}

function serializeEditableChildren(parent: Node): string {
  const children = [...parent.childNodes];
  const hasDirectBlocks = children.some(isEditorBlock);
  if (!hasDirectBlocks) return children.map(serializeEditableNode).join("");

  let lastMeaningfulChild: ChildNode | undefined;
  for (const child of children) {
    if (child.nodeType !== Node.TEXT_NODE || child.textContent?.trim()) {
      lastMeaningfulChild = child;
    }
  }

  const parts: string[] = [];
  let inline = "";
  const flushInline = () => {
    if (!inline) return;
    parts.push(inline);
    inline = "";
  };

  for (const child of children) {
    if (isEditorBlock(child)) {
      flushInline();
      if (child === lastMeaningfulChild && isEmptyTrailingDecorationBlock(child)) continue;
      parts.push(serializeEditableChildren(child));
      continue;
    }
    if (child.nodeType === Node.TEXT_NODE && !(child.textContent ?? "").trim()) continue;
    inline += serializeEditableNode(child);
  }
  flushInline();
  return parts.join("\n");
}

function serializeEditableNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof HTMLElement)) return "";
  if (node.tagName === "BR") {
    return isTerminalProseMirrorBreak(node) ? "" : "\n";
  }
  return serializeEditableChildren(node);
}

function isTerminalProseMirrorBreak(element: HTMLElement) {
  if (!element.classList.contains("ProseMirror-trailingBreak")) return false;
  for (let sibling = element.nextSibling; sibling; sibling = sibling.nextSibling) {
    if (sibling.nodeType !== Node.TEXT_NODE || sibling.textContent?.trim()) return false;
  }
  return true;
}

function isEmptyTrailingDecorationBlock(element: HTMLElement) {
  let sawTrailingBreak = false;
  const visit = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) return !node.textContent?.trim();
    if (!(node instanceof HTMLElement)) return false;
    if (node.tagName === "BR") {
      if (!isTerminalProseMirrorBreak(node)) return false;
      sawTrailingBreak = true;
      return true;
    }
    return [...node.childNodes].every(visit);
  };
  return visit(element) && sawTrailingBreak;
}

function isEditorBlock(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && EDITOR_BLOCK_TAGS.has(node.tagName);
}
