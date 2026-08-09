import type * as vscode from "vscode";

import { normalizeSourceAnchorContent, sourceAnchorSha256 } from "./source-anchor";

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

export type NotebookCellKindReference = "code" | "markup";

/**
 * A click-time pointer to a notebook cell or an exact range inside it.
 *
 * `cellUri` is useful for validating the currently open cell, but it is never
 * promoted to durable context identity. Persisted contexts use `notebookUri`.
 */
export interface NotebookCellReference {
  type: "notebook-cell";
  notebookUri: string;
  notebookType: string;
  notebookVersion: number;
  cellUri: string;
  cellIndex: number;
  cellKind: NotebookCellKindReference;
  cellLanguage: string;
  cellDocumentVersion: number;
  cellContentSha256: string;
  normalizedCellContentSha256: string;
  beforeCellSha256?: string;
  afterCellSha256?: string;
  scope: "range" | "cell";
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface ResolvedNotebookCellCommandTarget {
  /** Canonical cell object owned by the VS Code extension host. */
  cell: vscode.NotebookCell;
  reference: NotebookCellReference;
}

const allowedNotebookSchemes = new Set(["file", "untitled", "vscode-remote"]);
const NOTEBOOK_MARKUP_KIND = 1 as vscode.NotebookCellKind;

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

export function createNotebookCellReference(
  cell: vscode.NotebookCell,
  scope: "range" | "cell",
  range?: vscode.Range,
): NotebookCellReference {
  const exactRange = scope === "range" && range ? range : undefined;
  const cellContent = cell.document.getText();
  const beforeCell = cell.index > 0 ? cell.notebook.cellAt(cell.index - 1) : undefined;
  const afterCell =
    cell.index + 1 < cell.notebook.cellCount ? cell.notebook.cellAt(cell.index + 1) : undefined;
  return {
    type: "notebook-cell",
    notebookUri: cell.notebook.uri.toString(true),
    notebookType: cell.notebook.notebookType,
    notebookVersion: cell.notebook.version,
    cellUri: cell.document.uri.toString(true),
    cellIndex: cell.index,
    // NotebookCellKind.Markup is the stable API value 1. Keeping this module's
    // vscode import type-only also makes the serializable helpers easy to test.
    cellKind: cell.kind === NOTEBOOK_MARKUP_KIND ? "markup" : "code",
    cellLanguage: cell.document.languageId,
    cellDocumentVersion: cell.document.version,
    cellContentSha256: sourceAnchorSha256(cellContent),
    normalizedCellContentSha256: sourceAnchorSha256(normalizeSourceAnchorContent(cellContent)),
    ...(beforeCell ? { beforeCellSha256: sourceAnchorSha256(beforeCell.document.getText()) } : {}),
    ...(afterCell ? { afterCellSha256: sourceAnchorSha256(afterCell.document.getText()) } : {}),
    scope,
    startLine: exactRange?.start.line ?? 0,
    startCharacter: exactRange?.start.character ?? 0,
    endLine: exactRange?.end.line ?? 0,
    endCharacter: exactRange?.end.character ?? 0,
  };
}

/**
 * Captures notebook intent before opening/focusing the Ask2GPT sidebar.
 * A non-empty text selection wins; otherwise every selected cell is captured
 * once, in notebook order, as a complete-cell reference.
 */
export function notebookCellReferencesFromEditor(
  notebookEditor: Pick<vscode.NotebookEditor, "notebook" | "selection" | "selections"> | undefined,
  textEditor?: Pick<vscode.TextEditor, "document" | "selection">,
): NotebookCellReference[] | undefined {
  if (!notebookEditor || !allowedNotebookSchemes.has(notebookEditor.notebook.uri.scheme)) {
    return undefined;
  }

  if (textEditor && !textEditor.selection.isEmpty) {
    const selectedCell = notebookEditor.notebook
      .getCells()
      .find(
        (cell) =>
          cell.document === textEditor.document ||
          cell.document.uri.toString(true) === textEditor.document.uri.toString(true),
      );
    if (selectedCell) {
      return [createNotebookCellReference(selectedCell, "range", textEditor.selection)];
    }
  }

  const indices = new Set<number>();
  const selections =
    notebookEditor.selections.length > 0 ? notebookEditor.selections : [notebookEditor.selection];
  for (const selection of selections) {
    const start = Math.max(0, selection.start);
    const end = Math.min(notebookEditor.notebook.cellCount, selection.end);
    for (let index = start; index < end; index += 1) indices.add(index);
  }

  const references = [...indices]
    .sort((left, right) => left - right)
    .map((index) => createNotebookCellReference(notebookEditor.notebook.cellAt(index), "cell"));
  return references.length > 0 ? references : undefined;
}

/**
 * Resolves a `notebook/cell/title` argument without trusting caller-provided
 * URIs or indices. VS Code 1.96 turns its internal cell-toolbar context into
 * the canonical `NotebookCell` API object before invoking an extension
 * command. Requiring object identity with an open host document means a
 * lookalike object from another extension cannot redirect capture.
 */
export function resolveNotebookCellCommandTarget(
  value: unknown,
  notebookDocuments: readonly vscode.NotebookDocument[],
  textEditor?: Pick<vscode.TextEditor, "document" | "selection">,
): ResolvedNotebookCellCommandTarget | undefined {
  for (const notebook of notebookDocuments) {
    if (!allowedNotebookSchemes.has(notebook.uri.scheme)) continue;
    const cell = notebook.getCells().find((candidate) => candidate === value);
    if (!cell) continue;

    const exactRange =
      textEditor?.document === cell.document && !textEditor.selection.isEmpty
        ? textEditor.selection
        : undefined;
    return {
      cell,
      reference: createNotebookCellReference(cell, exactRange ? "range" : "cell", exactRange),
    };
  }
  return undefined;
}

/** Accepts notebook-toolbar context only when it is a host-owned document. */
export function isOpenNotebookDocumentCommandTarget(
  value: unknown,
  notebookDocuments: readonly vscode.NotebookDocument[],
): value is vscode.NotebookDocument {
  return notebookDocuments.some(
    (notebook) => allowedNotebookSchemes.has(notebook.uri.scheme) && notebook === value,
  );
}

/** Identifies an untrusted object that is attempting to look like a cell. */
export function isClaimedNotebookCellCommandTarget(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "notebook" in value &&
    "document" in value &&
    "index" in value
  );
}

/** Strictly validates the only structured argument accepted from our CodeAction. */
export function isNotebookCellReference(value: unknown): value is NotebookCellReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<NotebookCellReference>;
  const allowedKeys = new Set([
    "type",
    "notebookUri",
    "notebookType",
    "notebookVersion",
    "cellUri",
    "cellIndex",
    "cellKind",
    "cellLanguage",
    "cellDocumentVersion",
    "cellContentSha256",
    "normalizedCellContentSha256",
    "beforeCellSha256",
    "afterCellSha256",
    "scope",
    "startLine",
    "startCharacter",
    "endLine",
    "endCharacter",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  const coordinates = [
    candidate.startLine,
    candidate.startCharacter,
    candidate.endLine,
    candidate.endCharacter,
  ];
  if (
    candidate.type !== "notebook-cell" ||
    !isBoundedString(candidate.notebookUri, 4_096) ||
    !/^(?:file|untitled|vscode-remote):/u.test(candidate.notebookUri) ||
    !isBoundedString(candidate.notebookType, 128) ||
    !isNonNegativeInteger(candidate.notebookVersion) ||
    !isBoundedString(candidate.cellUri, 4_096) ||
    !candidate.cellUri.startsWith("vscode-notebook-cell:") ||
    !isNonNegativeInteger(candidate.cellIndex) ||
    (candidate.cellKind !== "code" && candidate.cellKind !== "markup") ||
    !isBoundedString(candidate.cellLanguage, 128) ||
    !isNonNegativeInteger(candidate.cellDocumentVersion) ||
    !isSha256(candidate.cellContentSha256) ||
    !isSha256(candidate.normalizedCellContentSha256) ||
    (candidate.beforeCellSha256 !== undefined && !isSha256(candidate.beforeCellSha256)) ||
    (candidate.afterCellSha256 !== undefined && !isSha256(candidate.afterCellSha256)) ||
    (candidate.scope !== "range" && candidate.scope !== "cell") ||
    coordinates.some((coordinate) => !isNonNegativeInteger(coordinate))
  ) {
    return false;
  }
  return (
    candidate.scope === "cell" ||
    Number(candidate.endLine) > Number(candidate.startLine) ||
    (candidate.endLine === candidate.startLine &&
      Number(candidate.endCharacter) > Number(candidate.startCharacter))
  );
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
