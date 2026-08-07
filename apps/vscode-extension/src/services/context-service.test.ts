import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
  window: {
    activeTextEditor: undefined as unknown,
    showOpenDialog: vi.fn(),
  },
  workspace: {
    openTextDocument: vi.fn(),
    getWorkspaceFolder: vi.fn(),
    asRelativePath: vi.fn(),
    workspaceFolders: [{ name: "repo" }],
  },
}));

vi.mock("vscode", () => {
  class Range {
    readonly isEmpty: boolean;

    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
      this.isEmpty = startLine === endLine && startCharacter === endCharacter;
    }

    readonly start: { line: number; character: number };
    readonly end: { line: number; character: number };

    isEqual(other: Range) {
      return (
        this.start.line === other.start.line &&
        this.start.character === other.start.character &&
        this.end.line === other.end.line &&
        this.end.character === other.end.character
      );
    }
  }

  return { ...vscodeMock, Range, env: { language: "zh-cn" } };
});

import { ContextService } from "./context-service";
import { MAX_CONTEXT_ATTACHMENTS } from "./context-policy";

describe("ContextService", () => {
  beforeEach(() => {
    vscodeMock.window.activeTextEditor = undefined;
    vscodeMock.window.showOpenDialog.mockReset();
    vscodeMock.workspace.openTextDocument.mockReset();
    vscodeMock.workspace.getWorkspaceFolder.mockReset();
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ name: "repo" });
    vscodeMock.workspace.asRelativePath.mockReset();
    vscodeMock.workspace.asRelativePath.mockImplementation(
      (uri: { path?: string }, includeWorkspaceFolder: boolean) => {
        const relative = (uri.path ?? "").replace(/^\/?(?:[A-Za-z]:\/)?repo\//, "");
        return includeWorkspaceFolder ? `repo/${relative}` : relative;
      },
    );
  });

  it("captures only the explicit selection and reports its exclusive end line correctly", () => {
    const getText = vi.fn((selection?: unknown) =>
      selection ? "const first = 1;\n" : "const first = 1;\nconst second = 2;",
    );
    vscodeMock.window.activeTextEditor = editor({
      getText,
      selection: {
        isEmpty: false,
        start: { line: 4, character: 0 },
        end: { line: 5, character: 0 },
      },
    });

    const snapshot = new ContextService().captureSelection();
    expect(snapshot).toMatchObject({
      kind: "selection",
      fileName: "src/index.ts",
      startLine: 5,
      endLine: 5,
      content: "const first = 1;\n",
      charCount: 17,
      unsaved: true,
    });
    expect(getText).toHaveBeenCalledTimes(1);
  });

  it("captures the exact button range even after the visible selection collapses", () => {
    const getText = vi.fn((value?: unknown) => {
      const range = value as { start: { line: number }; end: { line: number } } | undefined;
      return range?.start.line === 3 && range.end.line === 5 ? "captured button range\n" : "wrong";
    });
    vscodeMock.window.activeTextEditor = editor({
      getText,
      version: 11,
      selection: {
        isEmpty: true,
        start: { line: 5, character: 2 },
        end: { line: 5, character: 2 },
      },
    });

    const snapshot = new ContextService().captureSelection({
      uri: "file:///repo/src/index.ts",
      documentVersion: 11,
      startLine: 3,
      startCharacter: 0,
      endLine: 5,
      endCharacter: 0,
    });

    expect(snapshot).toMatchObject({
      kind: "selection",
      startLine: 4,
      endLine: 5,
      content: "captured button range\n",
    });
    expect(getText).toHaveBeenCalledWith(
      expect.objectContaining({
        start: { line: 3, character: 0 },
        end: { line: 5, character: 0 },
      }),
    );
  });

  it("rejects a stale editor-menu reference instead of attaching another editor", () => {
    const getText = vi.fn(() => "wrong editor content");
    vscodeMock.window.activeTextEditor = editor({ getText, version: 12 });
    const service = new ContextService();

    expect(() =>
      service.captureSelection({
        uri: "file:///repo/src/other.ts",
        documentVersion: 12,
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: 1,
      }),
    ).toThrow("选区已发生变化");
    expect(() =>
      service.captureSelection({
        uri: "file:///repo/src/index.ts",
        documentVersion: 11,
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: 1,
      }),
    ).toThrow("选区已发生变化");
    expect(getText).not.toHaveBeenCalled();
  });

  it("rejects a range that VS Code would clamp before reading editor content", () => {
    const getText = vi.fn(() => "clamped content");
    vscodeMock.window.activeTextEditor = editor({
      getText,
      version: 12,
      validateRange: () => ({ isEqual: () => false }),
    });

    expect(() =>
      new ContextService().captureSelection({
        uri: "file:///repo/src/index.ts",
        documentVersion: 12,
        startLine: 0,
        startCharacter: 0,
        endLine: 99,
        endCharacter: 1,
      }),
    ).toThrow("选区已失效");
    expect(getText).not.toHaveBeenCalled();
  });

  it("captures the current in-memory document without a filesystem read", () => {
    const getText = vi.fn(() => "unsaved editor buffer");
    vscodeMock.window.activeTextEditor = editor({ getText });

    const snapshot = new ContextService().captureCurrentFile();
    expect(snapshot).toMatchObject({
      kind: "current-file",
      startLine: 1,
      endLine: 2,
      content: "unsaved editor buffer",
      unsaved: true,
    });
    expect(getText).toHaveBeenCalledWith();
  });

  it("rejects an empty selection and sensitive active documents", () => {
    vscodeMock.window.activeTextEditor = editor({
      selection: {
        isEmpty: true,
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    });
    expect(() => new ContextService().captureSelection()).toThrow("选择代码");

    vscodeMock.window.activeTextEditor = editor({ fileName: String.raw`C:\repo\.envrc` });
    expect(() => new ContextService().captureCurrentFile()).toThrow("密钥或凭据");
  });

  it("captures only files explicitly returned by the VS Code picker", async () => {
    const firstUri = { fsPath: String.raw`C:\repo\src\first.ts`, path: "/repo/src/first.ts" };
    const secondUri = { fsPath: String.raw`C:\repo\src\second.ts`, path: "/repo/src/second.ts" };
    vscodeMock.window.showOpenDialog.mockResolvedValue([firstUri, secondUri]);
    vscodeMock.workspace.openTextDocument
      .mockResolvedValueOnce(document(firstUri.fsPath, "export const first = 1;"))
      .mockResolvedValueOnce(document(secondUri.fsPath, "export const second = 2;"));

    const snapshots = await new ContextService().captureFiles();

    expect(vscodeMock.window.showOpenDialog).toHaveBeenCalledWith({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: "附加到 Ask2GPT",
      title: "选择要添加到对话的文本文件",
    });
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map(({ kind, fileName }) => ({ kind, fileName }))).toEqual([
      { kind: "file", fileName: "src/first.ts" },
      { kind: "file", fileName: "src/second.ts" },
    ]);
    expect(snapshots.every((snapshot) => /^[a-f0-9-]{36}$/.test(snapshot.id))).toBe(true);
    expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledTimes(2);
  });

  it("does not read files when the picker is cancelled and rejects selected secrets", async () => {
    vscodeMock.window.showOpenDialog.mockResolvedValueOnce(undefined);
    await expect(new ContextService().captureFiles()).resolves.toEqual([]);
    expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();

    vscodeMock.window.showOpenDialog.mockResolvedValueOnce([
      { fsPath: String.raw`C:\repo\.env.local`, path: "/repo/.env.local" },
    ]);
    await expect(new ContextService().captureFiles()).rejects.toThrow("密钥或凭据");
    expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it("keeps workspace-relative paths distinct and falls back to a basename outside a workspace", () => {
    vscodeMock.workspace.asRelativePath.mockReturnValueOnce(String.raw`src\index.ts`);
    vscodeMock.window.activeTextEditor = editor();
    expect(new ContextService().captureCurrentFile().fileName).toBe("src/index.ts");

    vscodeMock.workspace.getWorkspaceFolder.mockReturnValueOnce(undefined);
    vscodeMock.window.activeTextEditor = editor({
      fileName: String.raw`D:\external\tests\index.ts`,
    });
    expect(new ContextService().captureCurrentFile().fileName).toBe("index.ts");
  });

  it("rejects too many picker results before reading any file", async () => {
    vscodeMock.window.showOpenDialog.mockResolvedValue(
      Array.from({ length: MAX_CONTEXT_ATTACHMENTS + 1 }, (_, index) => ({
        fsPath: `C:\\repo\\file-${index}.ts`,
        path: `/repo/file-${index}.ts`,
      })),
    );

    await expect(new ContextService().captureFiles()).rejects.toThrow("一次最多选择");
    expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
  });
});

function document(fileName: string, content: string) {
  return {
    fileName,
    uri: {
      path: fileName.replaceAll("\\", "/"),
      toString: () => `file:///${fileName.replaceAll("\\", "/")}`,
    },
    languageId: "typescript",
    isDirty: false,
    lineCount: content.split("\n").length,
    getText: () => content,
  };
}

function editor(options?: {
  fileName?: string;
  getText?: (selection?: unknown) => string;
  version?: number;
  validateRange?: (range: unknown) => unknown;
  selection?: {
    isEmpty: boolean;
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}) {
  return {
    selection:
      options?.selection ??
      ({
        isEmpty: false,
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      } as const),
    document: {
      fileName: options?.fileName ?? String.raw`C:\repo\src\index.ts`,
      uri: { path: "/repo/src/index.ts", toString: () => "file:///repo/src/index.ts" },
      languageId: "typescript",
      isDirty: true,
      version: options?.version ?? 1,
      lineCount: 2,
      getText: options?.getText ?? (() => "x"),
      validateRange: options?.validateRange ?? ((range: unknown) => range),
    },
  };
}
