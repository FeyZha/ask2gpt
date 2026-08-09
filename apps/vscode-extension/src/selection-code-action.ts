import * as vscode from "vscode";

import { ATTACH_SELECTION_COMMAND } from "./selection-handoff";
import { createNotebookCellReference, createSelectionReference } from "./selection-reference";

const SUPPORTED_SELECTION_SCHEMES = ["file", "untitled", "vscode-remote"] as const;
export const ATTACH_NOTEBOOK_CELL_COMMAND = "ask2gpt.attachNotebookCell";

export const ASK_SELECTION_ACTION_KIND = vscode.CodeActionKind.QuickFix.append("ask2gpt.selection");

export class SelectionCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken,
  ): vscode.CodeAction[] {
    const notebookCell = findOpenNotebookCell(document);
    const supportedTextDocument = SUPPORTED_SELECTION_SCHEMES.includes(
      document.uri.scheme as (typeof SUPPORTED_SELECTION_SCHEMES)[number],
    );
    if (
      token.isCancellationRequested ||
      range.isEmpty ||
      (!supportedTextDocument && !notebookCell) ||
      !isCurrentEditorSelection(document, range) ||
      (context.only !== undefined && !context.only.intersects(ASK_SELECTION_ACTION_KIND))
    ) {
      return [];
    }

    const title = selectionActionTitle();
    const action = new vscode.CodeAction(title, ASK_SELECTION_ACTION_KIND);
    action.command = {
      command: notebookCell ? ATTACH_NOTEBOOK_CELL_COMMAND : ATTACH_SELECTION_COMMAND,
      title,
      arguments: [
        notebookCell
          ? createNotebookCellReference(notebookCell, "range", range)
          : createSelectionReference(document, range),
      ],
    };
    return [action];
  }
}

export function registerSelectionCodeActionProvider(): vscode.Disposable {
  return vscode.languages.registerCodeActionsProvider(
    [...SUPPORTED_SELECTION_SCHEMES.map((scheme) => ({ scheme })), { notebookType: "*" }],
    new SelectionCodeActionProvider(),
    { providedCodeActionKinds: [ASK_SELECTION_ACTION_KIND] },
  );
}

function findOpenNotebookCell(document: vscode.TextDocument) {
  if (document.uri.scheme !== "vscode-notebook-cell") return undefined;
  for (const notebook of vscode.workspace.notebookDocuments) {
    if (!["file", "untitled", "vscode-remote"].includes(notebook.uri.scheme)) continue;
    const cell = notebook
      .getCells()
      .find(
        (candidate) =>
          candidate.document.version === document.version &&
          candidate.document.uri.toString(true) === document.uri.toString(true),
      );
    if (cell) return cell;
  }
  return undefined;
}

function selectionActionTitle(): string {
  return vscode.env.language.toLowerCase().startsWith("zh")
    ? "问 Ask2GPT（使用当前选区）"
    : "Ask Ask2GPT about this selection";
}

function isCurrentEditorSelection(
  document: vscode.TextDocument,
  range: vscode.Range | vscode.Selection,
): boolean {
  const editor = vscode.window.activeTextEditor;
  return Boolean(
    editor &&
    editor.document.version === document.version &&
    editor.document.uri.toString(true) === document.uri.toString(true) &&
    !editor.selection.isEmpty &&
    editor.selection.start.line === range.start.line &&
    editor.selection.start.character === range.start.character &&
    editor.selection.end.line === range.end.line &&
    editor.selection.end.character === range.end.character,
  );
}
