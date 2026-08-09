import { randomUUID } from "node:crypto";

import type { ContextSnapshot } from "@ask2gpt/protocol";
import * as vscode from "vscode";

import {
  MAX_CONTEXT_ATTACHMENTS,
  assertAllowedContext,
  assertAllowedContextFile,
} from "./context-policy";
import { Ask2GPTError } from "./errors";
import type { SelectionReference } from "../selection-reference";
import { normalizeSourceAnchorContent, sourceAnchorSha256 } from "../source-anchor";

function activeEditor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    throw new Ask2GPTError("NO_ACTIVE_EDITOR", "请先打开一个文本编辑器。");
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
