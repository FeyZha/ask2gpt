import type { ContextSnapshot, NotebookSourceAnchorV2 } from "@ask2gpt/protocol";
import * as vscode from "vscode";

import {
  normalizeSourceAnchorContent,
  sourceAnchorMatchesContent,
  sourceAnchorSha256,
} from "./source-anchor";
import { trustedContextUri } from "./trusted-context-uri";

export type NotebookCellResolution =
  | { status: "ambiguous" | "missing" }
  | {
      status: "found";
      anchor: NotebookSourceAnchorV2;
      cell: vscode.NotebookCell;
      cellIndex: number;
      document: vscode.TextDocument;
      evidenceRange: vscode.Range;
      notebook: vscode.NotebookDocument;
    };

export function isNotebookContextSnapshot(
  context: ContextSnapshot,
): context is ContextSnapshot & { sourceAnchor: NotebookSourceAnchorV2 } {
  return context.sourceAnchor?.formatVersion === 2;
}

/**
 * Opens only the host-captured notebook container and resolves a cell from its
 * durable content evidence. The virtual vscode-notebook-cell URI is never used
 * as authority and the workspace is never scanned.
 */
export async function resolveNotebookContextCell(
  context: ContextSnapshot & { sourceAnchor: NotebookSourceAnchorV2 },
): Promise<NotebookCellResolution> {
  const anchor = context.sourceAnchor;
  const containerUri = trustedContextUri(context);
  if (anchor.notebookUri !== context.uri || !sourceAnchorMatchesContent(anchor, context.content)) {
    return { status: "missing" };
  }

  const notebook = await vscode.workspace.openNotebookDocument(containerUri);
  if (
    notebook.uri.toString(true) !== containerUri.toString(true) ||
    notebook.notebookType !== anchor.notebookType
  ) {
    return { status: "missing" };
  }

  const cellResolution = resolveNotebookCell(notebook, anchor);
  if (cellResolution.status !== "found") return cellResolution;
  const evidenceRange = resolveNotebookEvidenceRange(cellResolution.cell.document, context, anchor);
  if (evidenceRange.status !== "found") return evidenceRange;

  return {
    status: "found",
    anchor,
    notebook,
    cell: cellResolution.cell,
    cellIndex: cellResolution.cell.index,
    document: cellResolution.cell.document,
    evidenceRange: evidenceRange.range,
  };
}

export function resolveNotebookCell(
  notebook: vscode.NotebookDocument,
  anchor: NotebookSourceAnchorV2,
): { status: "ambiguous" | "missing" } | { status: "found"; cell: vscode.NotebookCell } {
  if (!Number.isInteger(anchor.cellIndex) || anchor.cellIndex < 0) {
    return { status: "missing" };
  }

  // The capture-time index is the cheapest strong check and is authoritative
  // while the same complete cell source still occupies it.
  if (notebook.version === anchor.notebookVersion && anchor.cellIndex < notebook.cellCount) {
    const indexed = notebook.cellAt(anchor.cellIndex);
    if (cellMatchesAnchor(indexed, anchor)) return { status: "found", cell: indexed };
  }

  const sourceMatches = notebook.getCells().filter((cell) => cellMatchesAnchor(cell, anchor));
  if (sourceMatches.length === 0) return { status: "missing" };
  if (sourceMatches.length === 1) return { status: "found", cell: sourceMatches[0]! };

  const neighborMatches = sourceMatches.filter((cell) => neighborsMatchAnchor(cell, anchor));
  if (neighborMatches.length === 1) return { status: "found", cell: neighborMatches[0]! };
  return { status: "ambiguous" };
}

export function resolveNotebookEvidenceRange(
  document: vscode.TextDocument,
  context: ContextSnapshot,
  anchor: NotebookSourceAnchorV2,
): { status: "ambiguous" | "missing" } | { status: "found"; range: vscode.Range } {
  if (!sourceAnchorMatchesContent(anchor, context.content)) return { status: "missing" };

  if (anchor.scope === "cell") {
    const live = document.getText();
    if (!cellSourceMatches(live, anchor)) return { status: "missing" };
    return {
      status: "found",
      range: new vscode.Range(new vscode.Position(0, 0), document.positionAt(live.length)),
    };
  }

  const exactRange = notebookAnchorRange(document, anchor);
  if (exactRange && sourceAnchorMatchesContent(anchor, document.getText(exactRange))) {
    return { status: "found", range: exactRange };
  }

  const live = document.getText();
  const offset = live.indexOf(context.content);
  if (offset < 0) return { status: "missing" };
  if (live.indexOf(context.content, offset + 1) >= 0) return { status: "ambiguous" };
  return {
    status: "found",
    range: new vscode.Range(
      document.positionAt(offset),
      document.positionAt(offset + context.content.length),
    ),
  };
}

export async function showNotebookContextRange(
  resolution: Extract<NotebookCellResolution, { status: "found" }>,
  range: vscode.Range = resolution.evidenceRange,
) {
  const cellRange = new vscode.NotebookRange(resolution.cellIndex, resolution.cellIndex + 1);
  const editor = await vscode.window.showNotebookDocument(resolution.notebook, {
    preserveFocus: false,
    preview: true,
    selections: [cellRange],
  });
  editor.selection = cellRange;
  editor.selections = [cellRange];
  editor.revealRange(cellRange, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);

  // The notebook API can select and reveal a cell, but it cannot express a
  // character range inside that cell. Ask the public text-editor API to focus
  // the cell document after revealing it. Some notebook providers do not
  // expose their cell documents this way, so failure remains a safe cell-level
  // fallback instead of making navigation fail.
  let cellEditor: vscode.TextEditor | undefined;
  try {
    const candidate = await vscode.window.showTextDocument(resolution.document, {
      preserveFocus: false,
      preview: true,
      selection: range,
      ...(editor.viewColumn === undefined ? {} : { viewColumn: editor.viewColumn }),
    });
    if (candidate.document.uri.toString(true) === resolution.document.uri.toString(true)) {
      cellEditor = candidate;
    }
  } catch {
    // Fall through to an editor that the provider may already have exposed.
  }

  cellEditor ??= vscode.window.visibleTextEditors.find(
    (candidate) => candidate.document.uri.toString(true) === resolution.document.uri.toString(true),
  );
  if (cellEditor) {
    cellEditor.selection = new vscode.Selection(range.start, range.end);
    cellEditor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

export function notebookContextIdentity(context: ContextSnapshot) {
  if (!isNotebookContextSnapshot(context)) return context.uri;
  return [
    context.sourceAnchor.notebookUri,
    context.sourceAnchor.cellIndex,
    context.sourceAnchor.cellContentSha256,
  ].join(":");
}

function cellMatchesAnchor(cell: vscode.NotebookCell, anchor: NotebookSourceAnchorV2) {
  const expectedKind = cell.kind === vscode.NotebookCellKind.Markup ? "markup" : "code";
  return (
    expectedKind === anchor.cellKind &&
    cell.document.languageId === anchor.cellLanguage &&
    cellSourceMatches(cell.document.getText(), anchor)
  );
}

function cellSourceMatches(source: string, anchor: NotebookSourceAnchorV2) {
  return (
    anchor.cellContentSha256 === sourceAnchorSha256(source) ||
    anchor.normalizedCellContentSha256 === sourceAnchorSha256(normalizeSourceAnchorContent(source))
  );
}

function neighborsMatchAnchor(cell: vscode.NotebookCell, anchor: NotebookSourceAnchorV2) {
  if (!anchor.beforeCellSha256 && !anchor.afterCellSha256) return false;
  if (anchor.beforeCellSha256) {
    if (cell.index <= 0) return false;
    const before = cell.notebook.cellAt(cell.index - 1).document.getText();
    if (sourceAnchorSha256(before) !== anchor.beforeCellSha256) return false;
  }
  if (anchor.afterCellSha256) {
    if (cell.index + 1 >= cell.notebook.cellCount) return false;
    const after = cell.notebook.cellAt(cell.index + 1).document.getText();
    if (sourceAnchorSha256(after) !== anchor.afterCellSha256) return false;
  }
  return true;
}

function notebookAnchorRange(document: vscode.TextDocument, anchor: NotebookSourceAnchorV2) {
  const { startLine, startCharacter, endLine, endCharacter } = anchor.range;
  if (
    ![startLine, startCharacter, endLine, endCharacter].every(
      (value) => Number.isInteger(value) && value >= 0,
    ) ||
    startLine >= document.lineCount ||
    endLine >= document.lineCount ||
    endLine < startLine ||
    (endLine === startLine && endCharacter < startCharacter) ||
    startCharacter > document.lineAt(startLine).text.length ||
    endCharacter > document.lineAt(endLine).text.length
  ) {
    return undefined;
  }
  return new vscode.Range(
    new vscode.Position(startLine, startCharacter),
    new vscode.Position(endLine, endCharacter),
  );
}
