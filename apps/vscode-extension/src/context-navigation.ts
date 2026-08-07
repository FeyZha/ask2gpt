import type { ContextSnapshot } from "@ask2gpt/protocol";
import * as vscode from "vscode";

import { assertAllowedContextFile } from "./services/context-policy";
import { Ask2GPTError } from "./services/errors";
import type { AppState } from "./types";

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

  assertAllowedContextFile(context.fileName);
  const uri = vscode.Uri.parse(context.uri, true);
  assertAllowedContextFile(uri.fsPath || uri.path || context.fileName);
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
  const startLine = context.startLine - 1;
  const endLine = context.endLine - 1;
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 0 ||
    endLine < startLine ||
    endLine >= document.lineCount
  ) {
    throw new Ask2GPTError(
      "CONTEXT_RANGE_STALE",
      locale === "en"
        ? "The file changed and the attached line range is no longer available."
        : "文件已发生变化，附加的代码行范围已失效。",
    );
  }

  const start = new vscode.Position(startLine, 0);
  const endTextLine = document.lineAt(endLine);
  const lineRange = new vscode.Range(start, endTextLine.range.end);
  if (context.kind !== "selection" || context.content.length === 0) return lineRange;

  const searchEnd =
    endLine + 1 < document.lineCount ? new vscode.Position(endLine + 1, 0) : endTextLine.range.end;
  const searchRange = new vscode.Range(start, searchEnd);
  const currentText = document.getText(searchRange);
  const contentOffset = currentText.indexOf(context.content);
  if (contentOffset < 0 || currentText.lastIndexOf(context.content) !== contentOffset) {
    return lineRange;
  }

  const documentOffset = document.offsetAt(searchRange.start) + contentOffset;
  return new vscode.Range(
    document.positionAt(documentOffset),
    document.positionAt(documentOffset + context.content.length),
  );
}
