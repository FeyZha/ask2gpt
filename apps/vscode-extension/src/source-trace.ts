import type { ContextSnapshot, Conversation } from "@ask2gpt/protocol";
import * as vscode from "vscode";

import { parseAnswerSourceReferences } from "./answer-source-reference";
import {
  extractAnswerSourceDefinitions,
  normalizeAnswerSourceSymbol,
} from "./answer-source-symbol";
import {
  findUniqueContextSnapshotRange,
  resolveNonSelectionSnapshotRange,
} from "./context-navigation";
import {
  isNotebookContextSnapshot,
  notebookContextIdentity,
  resolveNotebookContextCell,
  showNotebookContextRange,
  type NotebookCellResolution,
} from "./notebook-source-navigation";
import { assertAllowedContextFile } from "./services/context-policy";
import { Ask2GPTError } from "./services/errors";
import { planContextDelivery } from "./services/prompt-builder";
import {
  trustedContextUri as resolveTrustedContextUri,
  TrustedContextUriError,
} from "./trusted-context-uri";
import type { AppState } from "./types";

interface TraceContext {
  attachmentFileName?: string;
  context: ContextSnapshot;
}

interface ResolvedSourceLocation {
  context: ContextSnapshot;
  endLine: number;
  startLine: number;
}

interface SymbolLocation {
  containerName?: string;
  context: ContextSnapshot;
  document: vscode.TextDocument;
  notebookResolution?: Extract<NotebookCellResolution, { status: "found" }>;
  range: vscode.Range;
}

export async function openAnswerSourceReferenceFromState(
  state: AppState,
  conversationId: string,
  messageId: string,
  reference: string,
) {
  const { conversation, message, messageIndex } = requireAssistantMessage(
    state,
    conversationId,
    messageId,
  );
  const requested = parseExactFileReference(reference);
  const authoritative = parseAnswerSourceReferences(message.markdown).some(
    (candidate) =>
      candidate.raw === requested.raw &&
      candidate.path === requested.path &&
      candidate.startLine === requested.startLine &&
      candidate.endLine === requested.endLine,
  );
  if (!authoritative) throw traceError(state.locale, "SOURCE_REFERENCE_STALE");

  const matches = resolveFileReferenceCandidates(conversation, messageIndex, requested);
  if (matches.length === 0) throw traceError(state.locale, "SOURCE_REFERENCE_NOT_FOUND");
  const selected = await chooseSourceLocation(matches, state.locale);
  if (!selected) return;
  await openLineLocation(selected, state.locale);
}

export async function openAnswerSymbolFromState(
  state: AppState,
  conversationId: string,
  messageId: string,
  reference: string,
) {
  const { conversation, message, messageIndex } = requireAssistantMessage(
    state,
    conversationId,
    messageId,
  );
  const requested = normalizeAnswerSourceSymbol(reference);
  if (!requested || !assistantHasInlineSymbol(message.markdown, requested)) {
    throw traceError(state.locale, "SOURCE_SYMBOL_STALE");
  }

  const contexts = traceContextsBefore(conversation, messageIndex);
  const leaf = requested.split(".").at(-1)!;
  const relevant = contexts.filter(({ context }) => containsSymbol(context.content, leaf));
  if (relevant.length > 0) {
    const locations = await resolveSymbolLocations(relevant, requested, state.locale);
    if (locations.length > 0) {
      const selected = await chooseSymbolLocation(locations, requested, state.locale);
      if (!selected) return;
      await showSymbolLocation(selected);
      return;
    }
  }

  throw traceError(state.locale, "SOURCE_SYMBOL_NOT_FOUND");
}

function requireAssistantMessage(state: AppState, conversationId: string, messageId: string) {
  const conversation = state.conversations.find((candidate) => candidate.id === conversationId);
  if (!conversation) {
    throw traceError(state.locale, "SOURCE_MESSAGE_NOT_FOUND");
  }
  const messageIndex = conversation.messages.findIndex((candidate) => candidate.id === messageId);
  const message = messageIndex < 0 ? undefined : conversation.messages[messageIndex];
  if (!message || message.role !== "assistant") {
    throw traceError(state.locale, "SOURCE_MESSAGE_NOT_FOUND");
  }
  return { conversation, message, messageIndex };
}

function parseExactFileReference(reference: string) {
  const parsed = parseAnswerSourceReferences(reference);
  const exact = parsed.find(
    (candidate) => candidate.textRange.start === 0 && candidate.textRange.end === reference.length,
  );
  if (!exact) throw new Ask2GPTError("SOURCE_REFERENCE_INVALID", "Invalid source reference.");
  assertAllowedContextFile(exact.path);
  return exact;
}

function traceContextsBefore(conversation: Conversation, beforeIndex: number) {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message?.role !== "user") continue;
    if (!message.contexts || message.contexts.length === 0) return [];
    let delivery: ReturnType<typeof planContextDelivery> = [];
    try {
      delivery = planContextDelivery(message.contexts);
    } catch {
      // Old encrypted records can outlive a tightened bundle policy. Original
      // host-owned filenames remain safe navigation evidence in that case.
    }
    return message.contexts.map((context) => ({
      context,
      attachmentFileName: delivery.find((item) => item.contextId === context.id)?.fileName,
    }));
  }
  return [];
}

function resolveFileReferenceCandidates(
  conversation: Conversation,
  beforeIndex: number,
  reference: ReturnType<typeof parseExactFileReference>,
) {
  const matches = traceContextsBefore(conversation, beforeIndex).flatMap((candidate) => {
    const match = fileNameMatch(reference.path, candidate);
    if (!match) return [];
    const location = sourceLinesForReference(candidate.context, reference, match.attachmentAlias);
    if (!location) return [];
    return [{ ...location, score: match.score }];
  });
  if (matches.length === 0) return [];
  const bestScore = Math.max(...matches.map((match) => match.score));
  return deduplicateSourceLocations(matches.filter((match) => match.score === bestScore));
}

function fileNameMatch(referencePath: string, candidate: TraceContext) {
  const reference = normalizePath(referencePath);
  const original = normalizePath(candidate.context.fileName);
  const attachment = candidate.attachmentFileName
    ? normalizePath(candidate.attachmentFileName)
    : undefined;
  const referenceBase = pathBaseName(reference);
  const originalBase = pathBaseName(original);

  if (attachment && (reference === attachment || reference.endsWith(`/${attachment}`))) {
    return { attachmentAlias: true, score: 500 };
  }
  if (reference === original) return { attachmentAlias: false, score: 450 };
  if (reference.endsWith(`/${original}`) || original.endsWith(`/${reference}`)) {
    return { attachmentAlias: false, score: 400 };
  }
  if (referenceBase === originalBase) return { attachmentAlias: false, score: 250 };
  return undefined;
}

function sourceLinesForReference(
  context: ContextSnapshot,
  reference: ReturnType<typeof parseExactFileReference>,
  attachmentAlias: boolean,
): ResolvedSourceLocation | undefined {
  if (attachmentAlias && context.kind === "selection") {
    const attachmentLineCount = context.content.split(/\r?\n/u).length;
    if (reference.startLine >= 1 && reference.endLine <= attachmentLineCount) {
      const translated = {
        context,
        startLine: context.startLine + reference.startLine - 1,
        endLine: context.startLine + reference.endLine - 1,
      };
      return isWithinContextLines(translated, context) ? translated : undefined;
    }
  }

  const original = { context, startLine: reference.startLine, endLine: reference.endLine };
  return isWithinContextLines(original, context) ? original : undefined;
}

function isWithinContextLines(location: ResolvedSourceLocation, context: ContextSnapshot) {
  return (
    Number.isInteger(context.startLine) &&
    Number.isInteger(context.endLine) &&
    context.startLine >= 1 &&
    context.endLine >= context.startLine &&
    location.startLine >= context.startLine &&
    location.endLine <= context.endLine
  );
}

function deduplicateSourceLocations<T extends ResolvedSourceLocation>(locations: T[]) {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${notebookContextIdentity(location.context)}:${location.startLine}:${location.endLine}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function chooseSourceLocation(
  locations: ResolvedSourceLocation[],
  locale: AppState["locale"],
) {
  if (locations.length === 1) return locations[0];
  const items = locations.map((location) => ({
    label: `$(file-code) ${location.context.fileName}:${location.startLine}`,
    description: `L${location.context.startLine}–${location.context.endLine}`,
    detail:
      locale === "en"
        ? "Attached source from this answer's conversation"
        : "此回答所在对话附加过的源码",
    location,
  }));
  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: locale === "en" ? "Choose the referenced source" : "选择回答引用的源码",
  });
  return selected?.location;
}

async function openLineLocation(location: ResolvedSourceLocation, locale: AppState["locale"]) {
  if (isNotebookContextSnapshot(location.context)) {
    const resolution = await trustedNotebookResolution(location.context, locale);
    const range = sourceLineRange(resolution.document, resolution.evidenceRange, location, locale);
    await showNotebookContextRange(resolution, range);
    return;
  }

  const uri = trustedContextUri(location.context, locale);
  const document = await vscode.workspace.openTextDocument(uri);
  let startIndex = location.startLine - 1;
  let endIndex = location.endLine - 1;
  if (location.context.kind === "selection") {
    const snapshot = findUniqueContextSnapshotRange(document, location.context.content);
    if (snapshot.status !== "found") {
      throw traceError(
        locale,
        snapshot.status === "ambiguous" ? "SOURCE_LINE_AMBIGUOUS" : "SOURCE_LINE_STALE",
      );
    }
    const snapshotLineCount = location.context.content.split(/\r?\n/u).length;
    const startOffset = location.startLine - location.context.startLine;
    const endOffset = location.endLine - location.context.startLine;
    if (startOffset < 0 || endOffset < startOffset || endOffset >= snapshotLineCount) {
      throw traceError(locale, "SOURCE_LINE_STALE");
    }
    startIndex = snapshot.range.start.line + startOffset;
    endIndex = snapshot.range.start.line + endOffset;
  } else {
    const snapshot = resolveNonSelectionSnapshotRange(document, location.context);
    if (snapshot.status !== "found") {
      throw traceError(
        locale,
        snapshot.status === "ambiguous" ? "SOURCE_LINE_AMBIGUOUS" : "SOURCE_LINE_STALE",
      );
    }
    const startOffset = location.startLine - location.context.startLine;
    const endOffset = location.endLine - location.context.startLine;
    const snapshotLineCount = location.context.endLine - location.context.startLine + 1;
    if (startOffset < 0 || endOffset < startOffset || endOffset >= snapshotLineCount) {
      throw traceError(locale, "SOURCE_LINE_STALE");
    }
    startIndex = snapshot.range.start.line + startOffset;
    endIndex = snapshot.range.start.line + endOffset;
  }
  if (
    !Number.isInteger(startIndex) ||
    !Number.isInteger(endIndex) ||
    startIndex < 0 ||
    endIndex < startIndex ||
    endIndex >= document.lineCount
  ) {
    throw traceError(locale, "SOURCE_LINE_STALE");
  }
  const range = new vscode.Range(
    new vscode.Position(startIndex, 0),
    document.lineAt(endIndex).range.end,
  );
  await showRange(document, range);
}

function assistantHasInlineSymbol(markdown: string, requested: string) {
  for (const match of markdown.matchAll(/(?<!`)`([^`\r\n]+)`(?!`)/gu)) {
    const normalized = normalizeAnswerSourceSymbol(match[1] ?? "");
    if (normalized === requested) return true;
  }
  return false;
}

function containsSymbol(content: string, symbol: string) {
  return new RegExp(`(^|[^\\p{L}\\p{N}_$])${escapeRegExp(symbol)}([^\\p{L}\\p{N}_$]|$)`, "u").test(
    content,
  );
}

async function resolveSymbolLocations(
  contexts: TraceContext[],
  requested: string,
  locale: AppState["locale"],
) {
  const leaf = requested.split(".").at(-1)!;
  const requestedContainer = requested.includes(".")
    ? requested.split(".").slice(0, -1).join(".")
    : undefined;
  const locations: Array<SymbolLocation & { score: number }> = [];

  for (const { context } of contexts) {
    let document: vscode.TextDocument;
    let evidenceRange: vscode.Range;
    let notebookResolution: Extract<NotebookCellResolution, { status: "found" }> | undefined;
    let uri: vscode.Uri;
    if (isNotebookContextSnapshot(context)) {
      notebookResolution = await trustedNotebookResolution(context, locale);
      document = notebookResolution.document;
      evidenceRange = notebookResolution.evidenceRange;
      uri = document.uri;
    } else {
      uri = trustedContextUri(context, locale);
      document = await vscode.workspace.openTextDocument(uri);
      evidenceRange = contextEvidenceRange(document, context, locale);
    }
    let symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation> = [];
    try {
      symbols =
        (await vscode.commands.executeCommand<
          Array<vscode.DocumentSymbol | vscode.SymbolInformation>
        >("vscode.executeDocumentSymbolProvider", uri)) ?? [];
    } catch {
      // A language extension may not be installed or ready. The bounded
      // attached snapshot below provides a deterministic fallback.
    }

    for (const symbol of flattenDocumentSymbols(symbols)) {
      if (symbol.name !== leaf) continue;
      if (symbol.uri && symbol.uri.toString(true) !== uri.toString(true)) continue;
      if (!isRangeInsideDocument(document, symbol.range)) continue;
      if (!rangeContainsRange(evidenceRange, symbol.range)) continue;
      const containerMatch =
        !requestedContainer ||
        symbol.containerName === requestedContainer ||
        symbol.containerName?.endsWith(`.${requestedContainer}`);
      if (!containerMatch) continue;
      locations.push({
        context,
        document,
        ...(notebookResolution ? { notebookResolution } : {}),
        range: symbol.range,
        containerName: symbol.containerName,
        score: 500,
      });
    }

    if (locations.some((location) => location.context.uri === context.uri)) continue;
    for (const definition of extractAnswerSourceDefinitions(context.content)) {
      if (definition.name !== leaf) continue;
      const lineIndex = evidenceRange.start.line + definition.lineOffset;
      if (lineIndex < 0 || lineIndex >= document.lineCount) continue;
      const line = document.lineAt(lineIndex);
      const liveDefinition = extractAnswerSourceDefinitions(line.text).find(
        (candidate) => candidate.name === definition.name && candidate.lineOffset === 0,
      );
      if (!liveDefinition) continue;
      const range = new vscode.Range(
        new vscode.Position(lineIndex, liveDefinition.startCharacter),
        new vscode.Position(lineIndex, liveDefinition.endCharacter),
      );
      if (!rangeContainsRange(evidenceRange, range)) continue;
      locations.push({
        context,
        document,
        ...(notebookResolution ? { notebookResolution } : {}),
        range,
        score: 250,
      });
    }
  }

  if (locations.length === 0) return [];
  const bestScore = Math.max(...locations.map((location) => location.score));
  const seen = new Set<string>();
  return locations.filter((location) => {
    if (location.score !== bestScore) return false;
    const key = `${notebookContextIdentity(location.context)}:${location.range.start.line}:${location.range.start.character}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function flattenDocumentSymbols(
  symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>,
  inheritedContainers: string[] = [],
): Array<{ containerName?: string; name: string; range: vscode.Range; uri?: vscode.Uri }> {
  return symbols.flatMap((symbol) => {
    if ("selectionRange" in symbol) {
      const containerName =
        inheritedContainers.length > 0 ? inheritedContainers.join(".") : undefined;
      return [
        { name: symbol.name, range: symbol.selectionRange, containerName },
        ...flattenDocumentSymbols(symbol.children, [...inheritedContainers, symbol.name]),
      ];
    }
    return [
      {
        name: symbol.name,
        range: symbol.location.range,
        uri: symbol.location.uri,
        containerName: symbol.containerName,
      },
    ];
  });
}

function contextEvidenceRange(
  document: vscode.TextDocument,
  context: ContextSnapshot,
  locale: AppState["locale"],
) {
  if (context.kind === "selection") {
    const snapshot = findUniqueContextSnapshotRange(document, context.content);
    if (snapshot.status === "found") return snapshot.range;
    throw traceError(
      locale,
      snapshot.status === "ambiguous" ? "SOURCE_LINE_AMBIGUOUS" : "SOURCE_LINE_STALE",
    );
  }

  const snapshot = resolveNonSelectionSnapshotRange(document, context);
  if (snapshot.status === "found") return snapshot.range;
  throw traceError(
    locale,
    snapshot.status === "ambiguous" ? "SOURCE_LINE_AMBIGUOUS" : "SOURCE_LINE_STALE",
  );
}

async function chooseSymbolLocation(
  locations: SymbolLocation[],
  symbol: string,
  locale: AppState["locale"],
) {
  if (locations.length === 1) return locations[0];
  const items = locations.map((location) => ({
    label: `$(symbol-function) ${symbol}`,
    description: `${location.context.fileName}:${location.range.start.line + 1}`,
    detail: location.containerName,
    location,
  }));
  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: locale === "en" ? `Choose the definition of ${symbol}` : `选择 ${symbol} 的定义`,
  });
  return selected?.location;
}

async function showRange(document: vscode.TextDocument, range: vscode.Range) {
  const editor = await vscode.window.showTextDocument(document, {
    preserveFocus: false,
    preview: true,
  });
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function showSymbolLocation(location: SymbolLocation) {
  if (location.notebookResolution) {
    await showNotebookContextRange(location.notebookResolution, location.range);
    return;
  }
  await showRange(location.document, location.range);
}

async function trustedNotebookResolution(
  context: ContextSnapshot & {
    sourceAnchor: Extract<ContextSnapshot["sourceAnchor"], { formatVersion: 2 }>;
  },
  locale: AppState["locale"],
) {
  try {
    const resolution = await resolveNotebookContextCell(context);
    if (resolution.status === "found") return resolution;
    throw traceError(
      locale,
      resolution.status === "ambiguous" ? "SOURCE_LINE_AMBIGUOUS" : "SOURCE_LINE_STALE",
    );
  } catch (error) {
    if (error instanceof TrustedContextUriError) {
      throw traceError(locale, "SOURCE_CONTEXT_UNTRUSTED");
    }
    throw error;
  }
}

function sourceLineRange(
  document: vscode.TextDocument,
  evidenceRange: vscode.Range,
  location: ResolvedSourceLocation,
  locale: AppState["locale"],
) {
  const startOffset = location.startLine - location.context.startLine;
  const endOffset = location.endLine - location.context.startLine;
  const evidenceLineCount = location.context.endLine - location.context.startLine + 1;
  const startIndex = evidenceRange.start.line + startOffset;
  const endIndex = evidenceRange.start.line + endOffset;
  if (
    startOffset < 0 ||
    endOffset < startOffset ||
    endOffset >= evidenceLineCount ||
    startIndex < 0 ||
    endIndex < startIndex ||
    endIndex >= document.lineCount
  ) {
    throw traceError(locale, "SOURCE_LINE_STALE");
  }
  return new vscode.Range(new vscode.Position(startIndex, 0), document.lineAt(endIndex).range.end);
}

function trustedContextUri(context: ContextSnapshot, locale: AppState["locale"]) {
  try {
    return resolveTrustedContextUri(context);
  } catch (error) {
    if (error instanceof TrustedContextUriError) {
      throw traceError(locale, "SOURCE_CONTEXT_UNTRUSTED");
    }
    throw error;
  }
}

function rangeContainsRange(outer: vscode.Range, inner: vscode.Range) {
  return (
    comparePositions(outer.start, inner.start) <= 0 && comparePositions(inner.end, outer.end) <= 0
  );
}

function comparePositions(left: vscode.Position, right: vscode.Position) {
  if (left.line !== right.line) return left.line - right.line;
  return left.character - right.character;
}

function isRangeInsideDocument(document: vscode.TextDocument, range: vscode.Range) {
  const { start, end } = range;
  if (
    !Number.isInteger(start.line) ||
    !Number.isInteger(start.character) ||
    !Number.isInteger(end.line) ||
    !Number.isInteger(end.character) ||
    start.line < 0 ||
    start.character < 0 ||
    end.line < start.line ||
    end.line >= document.lineCount ||
    end.character < 0
  ) {
    return false;
  }
  if (start.line >= document.lineCount) return false;
  if (start.character > document.lineAt(start.line).text.length) return false;
  if (end.character > document.lineAt(end.line).text.length) return false;
  return end.line !== start.line || end.character >= start.character;
}

function normalizePath(value: string) {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "").toLowerCase();
}

function pathBaseName(value: string) {
  return value.split("/").at(-1) ?? value;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function traceError(locale: AppState["locale"], code: string) {
  const messages: Record<string, { en: string; "zh-CN": string }> = {
    SOURCE_MESSAGE_NOT_FOUND: {
      en: "This answer is no longer available in the conversation.",
      "zh-CN": "对话中已找不到这条回答。",
    },
    SOURCE_REFERENCE_STALE: {
      en: "This source reference is no longer present in the answer.",
      "zh-CN": "回答中已找不到这条源码引用。",
    },
    SOURCE_REFERENCE_NOT_FOUND: {
      en: "This reference does not match code attached before the answer.",
      "zh-CN": "该引用与回答前附加的代码上下文不匹配。",
    },
    SOURCE_LINE_STALE: {
      en: "The referenced line range is no longer available in the file.",
      "zh-CN": "文件中已找不到回答引用的行范围。",
    },
    SOURCE_LINE_AMBIGUOUS: {
      en: "The attached code now appears more than once in the file.",
      "zh-CN": "附加的代码目前在文件中出现多次，无法唯一定位。",
    },
    SOURCE_CONTEXT_UNTRUSTED: {
      en: "The attached source target is not a trusted editor document.",
      "zh-CN": "附加源码的目标不是受信任的编辑器文档。",
    },
    SOURCE_SYMBOL_STALE: {
      en: "This symbol is no longer present as code in the answer.",
      "zh-CN": "回答中已找不到这个函数引用。",
    },
    SOURCE_SYMBOL_NOT_FOUND: {
      en: "No matching definition was found in the attached source.",
      "zh-CN": "在已附加源码中没有找到对应定义。",
    },
  };
  const message = messages[code]?.[locale] ?? code;
  return new Ask2GPTError(code, message);
}
