import type * as vscode from "vscode";

/**
 * A serializable pointer to the exact editor selection represented by the
 * editor attach action. Capturing the range before revealing the sidebar
 * matters because the focus change may collapse the visible selection.
 */
export interface SelectionReference {
  uri: string;
  documentVersion: number;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export function createSelectionReference(
  document: vscode.TextDocument,
  selection: vscode.Range,
): SelectionReference {
  return {
    uri: document.uri.toString(true),
    documentVersion: document.version,
    startLine: selection.start.line,
    startCharacter: selection.start.character,
    endLine: selection.end.line,
    endCharacter: selection.end.character,
  };
}

export function selectionReferenceFromEditor(
  editor: Pick<vscode.TextEditor, "document" | "selection"> | undefined,
): SelectionReference | undefined {
  if (
    !editor ||
    editor.selection.isEmpty ||
    !["file", "untitled", "vscode-remote"].includes(editor.document.uri.scheme)
  ) {
    return undefined;
  }
  return createSelectionReference(editor.document, editor.selection);
}
