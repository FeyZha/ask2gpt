import type { ContextKind, NotebookSourceAnchorV2 } from "@ask2gpt/protocol";

import type { NotebookCellReference, SelectionReference } from "./selection-reference";
import type { AppState } from "./types";

const URI_MATCH_SCORE = 1_000;
const EXACT_CONTENT_SCORE = 600;
const CONTEXT_CONTAINS_SELECTION_SCORE = 400;
const SELECTION_CONTAINS_CONTEXT_SCORE = 300;
const EXACT_RANGE_SCORE = 300;
const RANGE_OVERLAP_BASE_SCORE = 100;
const RANGE_OVERLAP_RATIO_SCORE = 100;
const EXPLICIT_SELECTION_SCORE = 20;

export type ConversationTraceContentMatch =
  "exact" | "context-contains-selection" | "selection-contains-context" | "none";

export type ConversationTraceMatchKind =
  "exact" | "content-and-range" | "content" | "range-overlap";

export type ConversationTraceConfidence = "exact" | "content-backed";

/** A sent user turn whose durable context snapshot relates to an editor selection. */
export interface ConversationTraceMatch {
  confidence: ConversationTraceConfidence;
  directNavigation: true;
  score: number;
  matchKind: ConversationTraceMatchKind;
  contentMatch: ConversationTraceContentMatch;
  exactRange: boolean;
  overlapStartLine?: number;
  overlapEndLine?: number;
  conversationId: string;
  conversationTitle: string;
  conversationUpdatedAt: string;
  conversationArchivedAt?: string;
  messageId: string;
  messageCreatedAt: string;
  messageMarkdown: string;
  contextId: string;
  contextKind: ContextKind;
  contextFileName: string;
  contextStartLine: number;
  contextEndLine: number;
  contextUnsaved: boolean;
}

/**
 * Finds sent user turns related to an exact click-time editor selection.
 *
 * The search deliberately sees only `conversation.messages`: pending composer
 * contexts and queued follow-ups are not durable sent turns. A URI match is
 * mandatory, then unique literal content and line overlap contribute to relevance.
 * Range-only candidates are deliberately excluded: the current command
 * navigates a sole result directly, so every result returned here must have
 * content evidence.
 * Results are relevance-first and newest-first within equal relevance, with
 * stable ID tie-breakers so AppState ordering cannot change the result.
 */
export function findConversationTraceMatches(
  state: Pick<AppState, "conversations">,
  reference: SelectionReference | NotebookCellReference,
  selectedContent: string,
): ConversationTraceMatch[] {
  if (!isValidSelection(reference) || selectedContent.length === 0) return [];

  const selectedRange = selectionLineRange(reference, selectedContent);
  const matches: ConversationTraceMatch[] = [];

  for (const conversation of state.conversations) {
    for (const message of conversation.messages) {
      if (message.role !== "user") continue;
      for (const context of message.contexts ?? []) {
        const notebookAnchor =
          context.sourceAnchor?.formatVersion === 2 ? context.sourceAnchor : undefined;
        if (isNotebookCellReference(reference)) {
          if (
            !notebookAnchor ||
            context.uri !== reference.notebookUri ||
            !notebookReferenceMatchesAnchor(reference, notebookAnchor)
          ) {
            continue;
          }
        } else if (notebookAnchor || context.uri !== reference.uri) {
          continue;
        }

        const overlap = lineRangeOverlap(selectedRange, context);
        const contentMatch = classifyContentMatch(context.content, selectedContent);
        if (contentMatch === "none") continue;

        const exactRange = isNotebookCellReference(reference)
          ? notebookRangeMatches(reference, notebookAnchor!)
          : context.startLine === selectedRange.startLine &&
            context.endLine === selectedRange.endLine;
        const score = traceScore(
          context.kind,
          contentMatch,
          exactRange,
          overlap?.lineCount ?? 0,
          selectedRange.endLine - selectedRange.startLine + 1,
        );

        matches.push({
          confidence: exactRange && contentMatch === "exact" ? "exact" : "content-backed",
          directNavigation: true,
          score,
          matchKind: classifyMatchKind(contentMatch, Boolean(overlap), exactRange),
          contentMatch,
          exactRange,
          ...(overlap
            ? { overlapStartLine: overlap.startLine, overlapEndLine: overlap.endLine }
            : {}),
          conversationId: conversation.id,
          conversationTitle: conversation.title,
          conversationUpdatedAt: conversation.updatedAt,
          ...(conversation.archivedAt ? { conversationArchivedAt: conversation.archivedAt } : {}),
          messageId: message.id,
          messageCreatedAt: message.createdAt,
          messageMarkdown: message.markdown,
          contextId: context.id,
          contextKind: context.kind,
          contextFileName: context.fileName,
          contextStartLine: context.startLine,
          contextEndLine: context.endLine,
          contextUnsaved: context.unsaved,
        });
      }
    }
  }

  return matches.sort(compareTraceMatches);
}

function isValidSelection(reference: SelectionReference | NotebookCellReference) {
  if (isNotebookCellReference(reference)) {
    if (
      reference.notebookUri.length === 0 ||
      reference.notebookType.length === 0 ||
      !Number.isInteger(reference.notebookVersion) ||
      reference.notebookVersion < 0 ||
      !Number.isInteger(reference.cellIndex) ||
      reference.cellIndex < 0 ||
      reference.cellContentSha256.length === 0 ||
      reference.normalizedCellContentSha256.length === 0
    ) {
      return false;
    }
    if (reference.scope === "cell") return true;
  }

  const coordinates = [
    reference.startLine,
    reference.startCharacter,
    reference.endLine,
    reference.endCharacter,
  ];
  if (
    (!isNotebookCellReference(reference) && reference.uri.length === 0) ||
    (!isNotebookCellReference(reference) &&
      (!Number.isInteger(reference.documentVersion) || reference.documentVersion < 0)) ||
    coordinates.some((coordinate) => !Number.isInteger(coordinate) || coordinate < 0)
  ) {
    return false;
  }
  return (
    reference.endLine > reference.startLine ||
    (reference.endLine === reference.startLine && reference.endCharacter > reference.startCharacter)
  );
}

function selectionLineRange(
  reference: SelectionReference | NotebookCellReference,
  selectedContent: string,
) {
  if (isNotebookCellReference(reference) && reference.scope === "cell") {
    return { startLine: 1, endLine: selectedContent.split(/\r\n?|\n/u).length };
  }
  return {
    startLine: reference.startLine + 1,
    // Match ContextService's inclusive, one-based snapshot range when a
    // selection ends at column zero of the following line.
    endLine:
      reference.endCharacter === 0 && reference.endLine > reference.startLine
        ? reference.endLine
        : reference.endLine + 1,
  };
}

function isNotebookCellReference(
  reference: SelectionReference | NotebookCellReference,
): reference is NotebookCellReference {
  return "type" in reference && reference.type === "notebook-cell";
}

function notebookReferenceMatchesAnchor(
  reference: NotebookCellReference,
  anchor: NotebookSourceAnchorV2,
) {
  if (
    anchor.notebookUri !== reference.notebookUri ||
    anchor.notebookType !== reference.notebookType ||
    anchor.cellKind !== reference.cellKind ||
    anchor.cellLanguage !== reference.cellLanguage ||
    (anchor.cellContentSha256 !== reference.cellContentSha256 &&
      anchor.normalizedCellContentSha256 !== reference.normalizedCellContentSha256)
  ) {
    return false;
  }

  if (
    anchor.notebookVersion === reference.notebookVersion &&
    anchor.cellIndex === reference.cellIndex
  ) {
    return true;
  }

  const capturedNeighbors = [
    [anchor.beforeCellSha256, reference.beforeCellSha256],
    [anchor.afterCellSha256, reference.afterCellSha256],
  ].filter(([captured]) => captured !== undefined);

  // Notebook versions also change for edits outside this cell (and for some
  // provider-managed state). Stable source at the stable index is sufficient
  // identity for a single-cell notebook. When capture-time neighbors exist,
  // require them to remain stable so an equal-source duplicate cannot silently
  // replace the original cell at that index.
  if (anchor.cellIndex === reference.cellIndex) {
    return capturedNeighbors.every(([captured, current]) => captured === current);
  }

  return (
    capturedNeighbors.length > 0 &&
    capturedNeighbors.every(([captured, current]) => captured === current)
  );
}

function notebookRangeMatches(reference: NotebookCellReference, anchor: NotebookSourceAnchorV2) {
  return (
    reference.scope === anchor.scope &&
    (reference.scope === "cell" ||
      (reference.startLine === anchor.range.startLine &&
        reference.startCharacter === anchor.range.startCharacter &&
        reference.endLine === anchor.range.endLine &&
        reference.endCharacter === anchor.range.endCharacter))
  );
}

function lineRangeOverlap(
  selected: { startLine: number; endLine: number },
  context: { startLine: number; endLine: number },
) {
  const startLine = Math.max(selected.startLine, context.startLine);
  const endLine = Math.min(selected.endLine, context.endLine);
  if (endLine < startLine) return undefined;
  return { startLine, endLine, lineCount: endLine - startLine + 1 };
}

function classifyContentMatch(
  contextContent: string,
  selectedContent: string,
): ConversationTraceContentMatch {
  if (contextContent === selectedContent) return "exact";
  if (occursExactlyOnce(contextContent, selectedContent)) return "context-contains-selection";
  if (occursExactlyOnce(selectedContent, contextContent)) {
    return "selection-contains-context";
  }
  return "none";
}

function occursExactlyOnce(container: string, candidate: string) {
  if (candidate.length === 0) return false;
  const first = container.indexOf(candidate);
  return first >= 0 && container.indexOf(candidate, first + 1) < 0;
}

function traceScore(
  contextKind: ContextKind,
  contentMatch: ConversationTraceContentMatch,
  exactRange: boolean,
  overlapLines: number,
  selectedLines: number,
) {
  let score = URI_MATCH_SCORE;
  if (contentMatch === "exact") score += EXACT_CONTENT_SCORE;
  else if (contentMatch === "context-contains-selection") {
    score += CONTEXT_CONTAINS_SELECTION_SCORE;
  } else if (contentMatch === "selection-contains-context") {
    score += SELECTION_CONTAINS_CONTEXT_SCORE;
  }

  if (exactRange) score += EXACT_RANGE_SCORE;
  else if (overlapLines > 0) {
    score +=
      RANGE_OVERLAP_BASE_SCORE +
      Math.round(
        (Math.min(overlapLines, selectedLines) / selectedLines) * RANGE_OVERLAP_RATIO_SCORE,
      );
  }
  if (contextKind === "selection") score += EXPLICIT_SELECTION_SCORE;
  return score;
}

function classifyMatchKind(
  contentMatch: ConversationTraceContentMatch,
  overlaps: boolean,
  exactRange: boolean,
): ConversationTraceMatchKind {
  if (contentMatch === "exact" && exactRange) return "exact";
  if (contentMatch !== "none" && overlaps) return "content-and-range";
  if (contentMatch !== "none") return "content";
  return "range-overlap";
}

function compareTraceMatches(left: ConversationTraceMatch, right: ConversationTraceMatch) {
  return (
    right.score - left.score ||
    compareNewestFirst(left.messageCreatedAt, right.messageCreatedAt) ||
    compareNewestFirst(left.conversationUpdatedAt, right.conversationUpdatedAt) ||
    left.conversationId.localeCompare(right.conversationId) ||
    left.messageId.localeCompare(right.messageId) ||
    left.contextId.localeCompare(right.contextId)
  );
}

function compareNewestFirst(left: string, right: string) {
  return right.localeCompare(left);
}
