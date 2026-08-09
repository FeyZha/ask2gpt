import { randomUUID } from "node:crypto";

import type { ContextSnapshot, NotebookSourceAnchorV2 } from "@ask2gpt/protocol";
import * as vscode from "vscode";

import {
  MAX_CONTEXT_ATTACHMENTS,
  assertAllowedContext,
  assertAllowedContextBundle,
  assertAllowedContextFile,
} from "./context-policy";
import { Ask2GPTError } from "./errors";
import {
  notebookCellReferencesFromEditor,
  type NotebookCellReference,
  type SelectionReference,
} from "../selection-reference";
import { normalizeSourceAnchorContent, sourceAnchorSha256 } from "../source-anchor";

function activeEditor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    throw new Ask2GPTError("NO_ACTIVE_EDITOR", "请先打开一个文本编辑器。");
  }
  if (editor.document.uri.scheme === "vscode-notebook-cell") {
    throw new Ask2GPTError(
      "NOTEBOOK_CELL_REQUIRES_NOTEBOOK_ACTION",
      vscode.env.language.toLowerCase().startsWith("zh")
        ? "当前编辑器是 Notebook 单元格，请使用“附加当前 Cell”。"
        : 'The active editor is a notebook cell. Use "Attach Current Cell" instead.',
    );
  }
  if (isRawNotebookTextDocument(editor.document)) {
    throw rawNotebookFileError();
  }
  assertAllowedContextFile(editor.document.fileName);
  return editor;
}

function baseSnapshot(
  document: vscode.TextDocument,
  content: string,
  startLine: number,
  endLine: number,
): Omit<ContextSnapshot, "kind"> {
  assertAllowedContext(document.fileName, content);
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  return {
    id: randomUUID(),
    fileName: displayFileName(document, workspaceFolder),
    uri: document.uri.toString(true),
    language: document.languageId,
    startLine,
    endLine,
    content,
    charCount: content.length,
    unsaved: document.isDirty,
    sourceAnchor: sourceAnchor(document, content, startLine, endLine, workspaceFolder),
  };
}

export class ContextService {
  captureSelection(reference?: SelectionReference): ContextSnapshot {
    const editor = activeEditor();
    const selection = reference
      ? selectionFromReference(editor.document, reference)
      : editor.selection;
    if (selection.isEmpty) {
      throw new Ask2GPTError("EMPTY_SELECTION", "请先在编辑器中选择代码。");
    }

    const content = editor.document.getText(selection);
    const endLine =
      selection.end.character === 0 && selection.end.line > selection.start.line
        ? selection.end.line
        : selection.end.line + 1;
    return {
      kind: "selection",
      ...baseSnapshot(editor.document, content, selection.start.line + 1, endLine),
    };
  }

  captureCurrentFile(): ContextSnapshot {
    const editor = activeEditor();
    const content = editor.document.getText();
    return {
      kind: "current-file",
      ...baseSnapshot(editor.document, content, 1, editor.document.lineCount),
    };
  }

  captureNotebookCells(references?: readonly NotebookCellReference[]): ContextSnapshot[] {
    const capturedReferences =
      references ??
      notebookCellReferencesFromEditor(
        vscode.window.activeNotebookEditor,
        vscode.window.activeTextEditor,
      );
    if (!capturedReferences?.length) {
      throw new Ask2GPTError(
        "NO_NOTEBOOK_CELL_SELECTION",
        vscode.env.language.toLowerCase().startsWith("zh")
          ? "请先在 Notebook 中选择一个或多个 Cell。"
          : "Select one or more notebook cells first.",
      );
    }
    if (capturedReferences.length > MAX_CONTEXT_ATTACHMENTS) {
      throw new Ask2GPTError(
        "TOO_MANY_CONTEXTS",
        vscode.env.language.toLowerCase().startsWith("zh")
          ? `一次最多附加 ${MAX_CONTEXT_ATTACHMENTS} 个 Notebook Cell。`
          : `Attach at most ${MAX_CONTEXT_ATTACHMENTS} notebook cells at once.`,
      );
    }

    const first = capturedReferences[0]!;
    const notebook = findOpenNotebook(first.notebookUri);
    if (!notebook || notebook.isClosed) throw staleNotebookCellError();
    assertAllowedNotebookUri(notebook.uri);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(notebook.uri);
    const fileName = displayResourceFileName(notebook.uri, workspaceFolder);
    assertAllowedContextFile(fileName);

    const seenCells = new Set<number>();
    const snapshots = capturedReferences.map((reference) => {
      if (seenCells.has(reference.cellIndex)) {
        throw new Ask2GPTError(
          "NOTEBOOK_CELL_DUPLICATE",
          vscode.env.language.toLowerCase().startsWith("zh")
            ? "同一个 Notebook Cell 不能重复附加。"
            : "The same notebook cell cannot be attached twice.",
        );
      }
      seenCells.add(reference.cellIndex);
      return notebookSnapshot(notebook, reference, fileName, workspaceFolder);
    });
    assertAllowedContextBundle(snapshots);
    return snapshots;
  }

  async captureFiles(): Promise<ContextSnapshot[]> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: "附加到 Ask2GPT",
      title: "选择要添加到对话的文本文件",
    });
    if (!uris?.length) return [];
    if (uris.length > MAX_CONTEXT_ATTACHMENTS) {
      throw new Ask2GPTError(
        "TOO_MANY_CONTEXTS",
        `一次最多选择 ${MAX_CONTEXT_ATTACHMENTS} 个文件。`,
      );
    }

    const snapshots: ContextSnapshot[] = [];
    for (const uri of uris) {
      if (
        portableBasename(uri.fsPath || uri.path)
          .toLowerCase()
          .endsWith(".ipynb")
      ) {
        throw new Ask2GPTError(
          "NOTEBOOK_FILE_REQUIRES_NOTEBOOK_API",
          vscode.env.language.toLowerCase().startsWith("zh")
            ? "不能把 .ipynb 作为普通文件附加；请打开 Notebook 并使用“附加当前 Cell”。"
            : 'A .ipynb file cannot be attached as raw JSON. Open it and use "Attach Current Cell".',
        );
      }
      assertAllowedContextFile(uri.fsPath || uri.path);
      const document = await vscode.workspace.openTextDocument(uri);
      const content = document.getText();
      snapshots.push({
        kind: "file",
        ...baseSnapshot(document, content, 1, document.lineCount),
      });
    }
    return snapshots;
  }
}

function notebookSnapshot(
  notebook: vscode.NotebookDocument,
  reference: NotebookCellReference,
  fileName: string,
  workspaceFolder: vscode.WorkspaceFolder | undefined,
): ContextSnapshot {
  if (
    reference.type !== "notebook-cell" ||
    reference.notebookUri !== notebook.uri.toString(true) ||
    reference.notebookType !== notebook.notebookType ||
    reference.notebookVersion !== notebook.version ||
    reference.cellIndex < 0 ||
    reference.cellIndex >= notebook.cellCount
  ) {
    throw staleNotebookCellError();
  }

  const cell = notebook.cellAt(reference.cellIndex);
  const cellKind = cell.kind === vscode.NotebookCellKind.Markup ? "markup" : "code";
  const cellContent = cell.document.getText();
  if (
    cell.index !== reference.cellIndex ||
    cell.document.uri.toString(true) !== reference.cellUri ||
    cell.document.version !== reference.cellDocumentVersion ||
    cell.document.languageId !== reference.cellLanguage ||
    cellKind !== reference.cellKind ||
    sourceAnchorSha256(cellContent) !== reference.cellContentSha256 ||
    sourceAnchorSha256(normalizeSourceAnchorContent(cellContent)) !==
      reference.normalizedCellContentSha256
  ) {
    throw staleNotebookCellError();
  }

  const range =
    reference.scope === "cell"
      ? fullDocumentRange(cell.document)
      : notebookRangeFromReference(cell.document, reference);
  if (reference.scope === "range" && range.isEmpty) {
    throw new Ask2GPTError(
      "EMPTY_SELECTION",
      vscode.env.language.toLowerCase().startsWith("zh")
        ? "请先在 Notebook Cell 中选择代码。"
        : "Select source in the notebook cell first.",
    );
  }

  const content = reference.scope === "cell" ? cellContent : cell.document.getText(range);
  assertAllowedContext(fileName, content);
  const endLine =
    range.end.character === 0 && range.end.line > range.start.line
      ? range.end.line
      : range.end.line + 1;
  return {
    id: randomUUID(),
    kind: "selection",
    fileName,
    uri: notebook.uri.toString(true),
    language: cell.document.languageId,
    startLine: range.start.line + 1,
    endLine: Math.max(range.start.line + 1, endLine),
    content,
    charCount: content.length,
    unsaved: notebook.isDirty || cell.document.isDirty,
    sourceAnchor: notebookSourceAnchor(
      notebook,
      cell,
      reference.scope,
      range,
      content,
      workspaceFolder,
    ),
  };
}

function notebookSourceAnchor(
  notebook: vscode.NotebookDocument,
  cell: vscode.NotebookCell,
  scope: "range" | "cell",
  range: vscode.Range,
  content: string,
  workspaceFolder: vscode.WorkspaceFolder | undefined,
): NotebookSourceAnchorV2 {
  const cellContent = cell.document.getText();
  const beforeCell = cell.index > 0 ? notebook.cellAt(cell.index - 1) : undefined;
  const afterCell =
    cell.index + 1 < notebook.cellCount ? notebook.cellAt(cell.index + 1) : undefined;
  const relativePath = workspaceRelativeUriPath(notebook.uri, workspaceFolder);
  return {
    formatVersion: 2,
    notebookUri: notebook.uri.toString(true),
    notebookType: notebook.notebookType,
    notebookVersion: notebook.version,
    cellIndex: cell.index,
    cellKind: cell.kind === vscode.NotebookCellKind.Markup ? "markup" : "code",
    cellLanguage: cell.document.languageId,
    scope,
    documentVersion: cell.document.version,
    range: {
      startLine: range.start.line,
      startCharacter: range.start.character,
      endLine: range.end.line,
      endCharacter: range.end.character,
    },
    contentSha256: sourceAnchorSha256(content),
    normalizedContentSha256: sourceAnchorSha256(normalizeSourceAnchorContent(content)),
    cellContentSha256: sourceAnchorSha256(cellContent),
    normalizedCellContentSha256: sourceAnchorSha256(normalizeSourceAnchorContent(cellContent)),
    ...(beforeCell ? { beforeCellSha256: sourceAnchorSha256(beforeCell.document.getText()) } : {}),
    ...(afterCell ? { afterCellSha256: sourceAnchorSha256(afterCell.document.getText()) } : {}),
    ...(relativePath ? { workspaceRelativePath: relativePath } : {}),
  };
}

function notebookRangeFromReference(
  document: vscode.TextDocument,
  reference: NotebookCellReference,
) {
  const range = new vscode.Range(
    reference.startLine,
    reference.startCharacter,
    reference.endLine,
    reference.endCharacter,
  );
  const validated = document.validateRange(range);
  if (!validated.isEqual(range)) throw staleNotebookCellError();
  return range;
}

function fullDocumentRange(document: vscode.TextDocument) {
  const lastLine = Math.max(0, document.lineCount - 1);
  return new vscode.Range(0, 0, lastLine, document.lineAt(lastLine).text.length);
}

function findOpenNotebook(notebookUri: string) {
  const active = vscode.window.activeNotebookEditor?.notebook;
  if (active?.uri.toString(true) === notebookUri) return active;
  return vscode.workspace.notebookDocuments.find(
    (candidate) => candidate.uri.toString(true) === notebookUri,
  );
}

function assertAllowedNotebookUri(uri: vscode.Uri) {
  if (!["file", "untitled", "vscode-remote"].includes(uri.scheme)) {
    throw new Ask2GPTError(
      "UNSUPPORTED_NOTEBOOK_URI",
      vscode.env.language.toLowerCase().startsWith("zh")
        ? "不支持附加该类型的 Notebook。"
        : "This notebook URI type cannot be attached.",
    );
  }
}

function staleNotebookCellError() {
  return new Ask2GPTError(
    "NOTEBOOK_CELL_STALE",
    vscode.env.language.toLowerCase().startsWith("zh")
      ? "Notebook 或 Cell 已发生变化，请重新选择后再试。"
      : "The notebook or cell changed. Select it again and retry.",
  );
}

function selectionFromReference(
  document: vscode.TextDocument,
  reference: SelectionReference,
): vscode.Range {
  if (
    document.uri.toString(true) !== reference.uri ||
    document.version !== reference.documentVersion
  ) {
    throw new Ask2GPTError(
      "SELECTION_STALE",
      vscode.env.language.toLowerCase().startsWith("zh")
        ? "选区已发生变化，请重新选择代码后再试。"
        : "The selection changed. Select the code again and retry.",
    );
  }

  const range = new vscode.Range(
    reference.startLine,
    reference.startCharacter,
    reference.endLine,
    reference.endCharacter,
  );
  const validated = document.validateRange(range);
  if (!validated.isEqual(range)) {
    throw new Ask2GPTError(
      "SELECTION_STALE",
      vscode.env.language.toLowerCase().startsWith("zh")
        ? "选区已失效，请重新选择代码后再试。"
        : "The selection is no longer valid. Select the code again and retry.",
    );
  }
  return range;
}

function portableBasename(fileName: string) {
  return fileName.split(/[\\/]/).at(-1) ?? fileName;
}

function isRawNotebookTextDocument(document: vscode.TextDocument) {
  if (document.uri.scheme === "vscode-notebook-cell") return false;
  return (
    isNotebookPath(document.fileName) ||
    isNotebookPath(document.uri.fsPath) ||
    isNotebookPath(document.uri.path)
  );
}

function isNotebookPath(value: string | undefined) {
  return Boolean(value && portableBasename(value).toLowerCase().endsWith(".ipynb"));
}

function rawNotebookFileError() {
  return new Ask2GPTError(
    "NOTEBOOK_FILE_REQUIRES_NOTEBOOK_API",
    vscode.env.language.toLowerCase().startsWith("zh")
      ? "不能把 .ipynb 作为普通文本附加；请打开 Notebook 并使用“附加当前 Cell”。"
      : 'A .ipynb file cannot be attached as raw JSON. Open it and use "Attach Current Cell".',
  );
}

function displayFileName(
  document: vscode.TextDocument,
  workspaceFolder: vscode.WorkspaceFolder | undefined,
) {
  const fallback = portableBasename(document.fileName || document.uri.path || "Untitled");
  if (!workspaceFolder) return fallback;

  const includeWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  const relative = vscode.workspace
    .asRelativePath(document.uri, includeWorkspaceFolder)
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .trim();
  return relative && !/^(?:[A-Za-z]:)?\//.test(relative) ? relative : fallback;
}

function displayResourceFileName(
  uri: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder | undefined,
) {
  const fallback = portableBasename(uri.fsPath || uri.path || "Untitled.ipynb");
  if (!workspaceFolder) return fallback;

  const includeWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  const relative = vscode.workspace
    .asRelativePath(uri, includeWorkspaceFolder)
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .trim();
  return relative && !/^(?:[A-Za-z]:)?\//.test(relative) ? relative : fallback;
}

function sourceAnchor(
  document: vscode.TextDocument,
  content: string,
  startLine: number,
  endLine: number,
  workspaceFolder: vscode.WorkspaceFolder | undefined,
): NonNullable<ContextSnapshot["sourceAnchor"]> {
  const beforeLineIndex = startLine - 2;
  const afterLineIndex = endLine;
  const beforeLine = lineText(document, beforeLineIndex);
  const afterLine = lineText(document, afterLineIndex);
  const relativePath = workspaceRelativePath(document, workspaceFolder);
  return {
    formatVersion: 1,
    contentSha256: sourceAnchorSha256(content),
    normalizedContentSha256: sourceAnchorSha256(normalizeSourceAnchorContent(content)),
    documentVersion: document.version,
    ...(beforeLine === undefined ? {} : { beforeLineSha256: sourceAnchorSha256(beforeLine) }),
    ...(afterLine === undefined ? {} : { afterLineSha256: sourceAnchorSha256(afterLine) }),
    ...(relativePath ? { workspaceRelativePath: relativePath } : {}),
  };
}

function lineText(document: vscode.TextDocument, lineIndex: number) {
  if (lineIndex < 0 || lineIndex >= document.lineCount) return undefined;
  return document.lineAt(lineIndex).text;
}

function workspaceRelativePath(
  document: vscode.TextDocument,
  workspaceFolder: vscode.WorkspaceFolder | undefined,
) {
  if (!workspaceFolder) return undefined;
  const includeWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  const relative = vscode.workspace
    .asRelativePath(document.uri, includeWorkspaceFolder)
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
  if (
    relative.length === 0 ||
    relative.length > 1_024 ||
    relative.startsWith("/") ||
    /^[A-Za-z]:\//u.test(relative) ||
    /[\\:\p{Cc}\p{Cf}]/u.test(relative)
  ) {
    return undefined;
  }
  const segments = relative.split("/");
  return segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ? undefined
    : relative;
}

function workspaceRelativeUriPath(
  uri: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder | undefined,
) {
  if (!workspaceFolder) return undefined;
  const includeWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  const relative = vscode.workspace
    .asRelativePath(uri, includeWorkspaceFolder)
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
  if (
    relative.length === 0 ||
    relative.length > 1_024 ||
    relative.startsWith("/") ||
    /^[A-Za-z]:\//u.test(relative) ||
    /[\\:\p{Cc}\p{Cf}]/u.test(relative)
  ) {
    return undefined;
  }
  const segments = relative.split("/");
  return segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ? undefined
    : relative;
}
