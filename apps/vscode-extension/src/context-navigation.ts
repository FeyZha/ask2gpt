import type { ContextSnapshot } from "@ask2gpt/protocol";
import * as vscode from "vscode";

import {
  isNotebookContextSnapshot,
  resolveNotebookContextCell,
  showNotebookContextRange,
} from "./notebook-source-navigation";
import { Ask2GPTError } from "./services/errors";
import { sourceAnchorMatchesContent, sourceAnchorSha256 } from "./source-anchor";
import { trustedContextUri, TrustedContextUriError } from "./trusted-context-uri";
import type { AppState } from "./types";

export type SnapshotRangeResolution =
  { range: vscode.Range; status: "found" } | { status: "ambiguous" | "missing" };

export function resolveContextFromState(
  state: AppState,
  conversationId: string,
  contextId: string,
): ContextSnapshot | undefined {
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (!conversation) return undefined;

  if (state.activeConversationId === conversationId) {
    const pending = state.pendingContexts.find((context) => context.id === contextId);
    if (pending) return pending;
  }

  for (const message of conversation.messages) {
    const sent = message.contexts?.find((context) => context.id === contextId);
    if (sent) return sent;
  }
  return undefined;
}

export async function openContextFromState(
  state: AppState,
  conversationId: string,
  contextId: string,
) {
  const context = resolveContextFromState(state, conversationId, contextId);
  if (!context) {
    throw new Ask2GPTError(
      "CONTEXT_NOT_FOUND",
      state.locale === "en"
        ? "This code context is no longer available in this chat."
        : "当前聊天中已找不到这段代码上下文。",
    );
  }

  if (isNotebookContextSnapshot(context)) {
    let resolution;
    try {
      resolution = await resolveNotebookContextCell(context);
    } catch (error) {
      if (error instanceof TrustedContextUriError) {
        throw contextNavigationError(state.locale, "CONTEXT_TARGET_UNTRUSTED");
      }
      throw error;
    }
    if (resolution.status !== "found") {
      throw contextNavigationError(
        state.locale,
        resolution.status === "ambiguous" ? "CONTEXT_RANGE_AMBIGUOUS" : "CONTEXT_RANGE_STALE",
      );
    }
    await showNotebookContextRange(resolution);
    return;
  }

  let uri: vscode.Uri;
  try {
    uri = trustedContextUri(context);
  } catch (error) {
    if (error instanceof TrustedContextUriError) {
      throw contextNavigationError(state.locale, "CONTEXT_TARGET_UNTRUSTED");
    }
    throw error;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  const range = contextEditorRange(document, context, state.locale);
  const editor = await vscode.window.showTextDocument(document, {
    preserveFocus: false,
    preview: true,
  });
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function contextEditorRange(
  document: vscode.TextDocument,
  context: ContextSnapshot,
  locale: AppState["locale"],
) {
  if (context.kind === "selection") {
    const snapshot = findUniqueContextSnapshotRange(document, context.content);
    if (snapshot.status === "found") return snapshot.range;
    throw contextNavigationError(
      locale,
      snapshot.status === "ambiguous" ? "CONTEXT_RANGE_AMBIGUOUS" : "CONTEXT_RANGE_STALE",
    );
  }

  const snapshot = resolveNonSelectionSnapshotRange(document, context);
  if (snapshot.status === "found") return snapshot.range;
  throw contextNavigationError(
    locale,
    snapshot.status === "ambiguous" ? "CONTEXT_RANGE_AMBIGUOUS" : "CONTEXT_RANGE_STALE",
  );
}

/** Resolves file snapshots only from immutable content or bounded V1 neighbors. */
export function resolveNonSelectionSnapshotRange(
  document: vscode.TextDocument,
  context: ContextSnapshot,
): SnapshotRangeResolution {
  const anchor = context.sourceAnchor?.formatVersion === 1 ? context.sourceAnchor : undefined;
  if (anchor && !sourceAnchorMatchesContent(anchor, context.content)) {
    return { status: "missing" };
  }

  const currentText = document.getText();
  if (
    anchor &&
    isFullDocumentSnapshot(context) &&
    sourceAnchorMatchesContent(anchor, currentText)
  ) {
    return { status: "found", range: fullDocumentRange(document, currentText) };
  }

  const literal = findUniqueContextSnapshotRange(document, context.content);
  if (literal.status === "found") return literal;

  const neighbors = findUniqueNeighborAnchoredRange(document, context);
  if (neighbors.status === "found") return neighbors;
  if (literal.status === "ambiguous" || neighbors.status === "ambiguous") {
    return { status: "ambiguous" };
  }
  return { status: "missing" };
}

export function findUniqueContextSnapshotRange(
  document: vscode.TextDocument,
  content: string,
): SnapshotRangeResolution {
  if (content.length === 0) return { status: "missing" };
  const currentText = document.getText();
  const contentOffset = currentText.indexOf(content);
  if (contentOffset < 0) return { status: "missing" };
  if (currentText.lastIndexOf(content) !== contentOffset) return { status: "ambiguous" };
  return {
    status: "found",
    range: new vscode.Range(
      document.positionAt(contentOffset),
      document.positionAt(contentOffset + content.length),
    ),
  };
}

function findUniqueNeighborAnchoredRange(
  document: vscode.TextDocument,
  context: ContextSnapshot,
): SnapshotRangeResolution {
  const anchor = context.sourceAnchor?.formatVersion === 1 ? context.sourceAnchor : undefined;
  const { beforeLineSha256, afterLineSha256 } = anchor ?? {};
  if (!beforeLineSha256 && !afterLineSha256) return { status: "missing" };

  const expectedLineCount = context.endLine - context.startLine + 1;
  if (!Number.isInteger(expectedLineCount) || expectedLineCount < 1) return { status: "missing" };
  const beforeLines = beforeLineSha256
    ? matchingLineIndexes(document, beforeLineSha256)
    : [undefined];
  const afterLines = afterLineSha256 ? matchingLineIndexes(document, afterLineSha256) : [undefined];
  const candidates = new Map<string, vscode.Range>();

  for (const beforeLine of beforeLines) {
    for (const afterLine of afterLines) {
      const startLine = beforeLine === undefined ? afterLine! - expectedLineCount : beforeLine + 1;
      const endLine = afterLine === undefined ? startLine + expectedLineCount - 1 : afterLine - 1;
      if (
        startLine < 0 ||
        endLine < startLine ||
        endLine >= document.lineCount ||
        endLine - startLine + 1 !== expectedLineCount
      ) {
        continue;
      }
      const range = new vscode.Range(
        new vscode.Position(startLine, 0),
        document.lineAt(endLine).range.end,
      );
      candidates.set(`${startLine}:${endLine}`, range);
    }
  }

  if (candidates.size === 1) return { status: "found", range: [...candidates.values()][0]! };
  return { status: candidates.size > 1 ? "ambiguous" : "missing" };
}

function matchingLineIndexes(document: vscode.TextDocument, expectedSha256: string) {
  const matches: number[] = [];
  for (let line = 0; line < document.lineCount; line += 1) {
    if (sourceAnchorSha256(document.lineAt(line).text) === expectedSha256) matches.push(line);
  }
  return matches;
}

function isFullDocumentSnapshot(context: ContextSnapshot) {
  return context.startLine === 1 && context.endLine === context.content.split(/\r\n?|\n/u).length;
}

function fullDocumentRange(document: vscode.TextDocument, content: string) {
  return new vscode.Range(new vscode.Position(0, 0), document.positionAt(content.length));
}

function contextNavigationError(locale: AppState["locale"], code: string) {
  const messages: Record<string, { en: string; "zh-CN": string }> = {
    CONTEXT_TARGET_UNTRUSTED: {
      en: "The attached source target is not a trusted editor document.",
      "zh-CN": "附加源码的目标不是受信任的编辑器文档。",
    },
    CONTEXT_RANGE_STALE: {
      en: "The file changed and the attached code is no longer available.",
      "zh-CN": "文件已发生变化，附加的代码已无法定位。",
    },
    CONTEXT_RANGE_AMBIGUOUS: {
      en: "The attached code now appears more than once in the file.",
      "zh-CN": "附加的代码目前在文件中出现多次，无法唯一定位。",
    },
  };
  return new Ask2GPTError(code, messages[code]?.[locale] ?? code);
}
