import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
  window: {
    activeTextEditor: undefined as unknown,
    activeNotebookEditor: undefined as unknown,
    showOpenDialog: vi.fn(),
  },
  workspace: {
    openTextDocument: vi.fn(),
    notebookDocuments: [] as unknown[],
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

  return {
    ...vscodeMock,
    Range,
    NotebookCellKind: { Markup: 1, Code: 2 },
    env: { language: "zh-cn" },
  };
});

import { ContextService } from "./context-service";
import { MAX_CONTEXT_ATTACHMENTS } from "./context-policy";
import { notebookCellReferencesFromEditor } from "../selection-reference";

describe("ContextService", () => {
  beforeEach(() => {
    vscodeMock.window.activeTextEditor = undefined;
    vscodeMock.window.activeNotebookEditor = undefined;
    vscodeMock.window.showOpenDialog.mockReset();
    vscodeMock.workspace.openTextDocument.mockReset();
    vscodeMock.workspace.notebookDocuments = [];
    vscodeMock.workspace.getWorkspaceFolder.mockReset();
    vscodeMock.workspace.getWorkspaceFolder.mockReturnValue({ name: "repo" });
    vscodeMock.workspace.workspaceFolders = [{ name: "repo" }];
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

  it("captures deterministic content and adjacent-line hashes without storing adjacent source", () => {
    const content = "selected  \r\nnext\t ";
    const options = {
      getText: vi.fn((selection?: unknown) =>
        selection ? content : "private neighbor one\nselected\nnext\nprivate neighbor two",
      ),
      lines: ["private neighbor one", "selected  ", "next\t ", "private neighbor two"],
      selection: {
        isEmpty: false,
        start: { line: 1, character: 0 },
        end: { line: 2, character: 6 },
      },
      version: 19,
    };

    vscodeMock.window.activeTextEditor = editor(options);
    const snapshot = new ContextService().captureSelection();
    vscodeMock.window.activeTextEditor = editor(options);
    const repeated = new ContextService().captureSelection();

    expect(snapshot.sourceAnchor).toEqual({
      formatVersion: 1,
      contentSha256: digest(content),
      normalizedContentSha256: digest("selected\nnext"),
      documentVersion: 19,
      beforeLineSha256: digest("private neighbor one"),
      afterLineSha256: digest("private neighbor two"),
      workspaceRelativePath: "src/index.ts",
    });
    expect(repeated.sourceAnchor).toEqual(snapshot.sourceAnchor);
    expect(JSON.stringify(snapshot.sourceAnchor)).not.toContain("private neighbor");
    expect(snapshot.sourceAnchor?.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
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
      sourceAnchor: {
        formatVersion: 1,
        contentSha256: digest("unsaved editor buffer"),
        normalizedContentSha256: digest("unsaved editor buffer"),
        documentVersion: 1,
        workspaceRelativePath: "src/index.ts",
      },
    });
    expect(getText).toHaveBeenCalledWith();
  });

  it("captures only a notebook cell text range with durable container provenance", () => {
    const value = notebook(["private before", "print('first')\nprint('second')", "private after"]);
    const selected = value.cells[1]!;
    vscodeMock.window.activeNotebookEditor = {
      notebook: value,
      selection: { start: 1, end: 2 },
      selections: [{ start: 1, end: 2 }],
    };
    vscodeMock.window.activeTextEditor = {
      document: selected.document,
      selection: {
        isEmpty: false,
        start: { line: 0, character: 6 },
        end: { line: 1, character: 7 },
      },
    };
    vscodeMock.workspace.notebookDocuments = [value];

    const [snapshot] = new ContextService().captureNotebookCells();

    expect(snapshot).toMatchObject({
      kind: "selection",
      fileName: "analysis.ipynb",
      uri: "file:///repo/analysis.ipynb",
      language: "python",
      startLine: 1,
      endLine: 2,
      content: "'first')\nprint('",
      unsaved: true,
      sourceAnchor: {
        formatVersion: 2,
        notebookUri: "file:///repo/analysis.ipynb",
        notebookType: "jupyter-notebook",
        notebookVersion: 11,
        cellIndex: 1,
        cellKind: "code",
        cellLanguage: "python",
        scope: "range",
        documentVersion: 7,
        range: {
          startLine: 0,
          startCharacter: 6,
          endLine: 1,
          endCharacter: 7,
        },
        contentSha256: digest("'first')\nprint('"),
        cellContentSha256: digest("print('first')\nprint('second')"),
        beforeCellSha256: digest("private before"),
        afterCellSha256: digest("private after"),
        workspaceRelativePath: "analysis.ipynb",
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("private before");
    expect(JSON.stringify(snapshot)).not.toContain("private after");
    expect(value.outputsRead).toBe(0);
    expect(value.metadataRead).toBe(0);
  });

  it("captures selected code and markup cells as ordered source-only contexts", () => {
    const value = notebook(["# Heading", "answer = 42", "print(answer)"], undefined, [1, 2, 2]);
    vscodeMock.window.activeNotebookEditor = {
      notebook: value,
      selection: { start: 0, end: 1 },
      selections: [
        { start: 2, end: 3 },
        { start: 0, end: 2 },
      ],
    };
    vscodeMock.window.activeTextEditor = undefined;
    vscodeMock.workspace.notebookDocuments = [value];

    const snapshots = new ContextService().captureNotebookCells();

    expect(snapshots.map((item) => [item.content, item.language])).toEqual([
      ["# Heading", "markdown"],
      ["answer = 42", "python"],
      ["print(answer)", "python"],
    ]);
    expect(
      snapshots.map((item) =>
        item.sourceAnchor?.formatVersion === 2
          ? [item.sourceAnchor.cellIndex, item.sourceAnchor.scope, item.sourceAnchor.cellKind]
          : undefined,
      ),
    ).toEqual([
      [0, "cell", "markup"],
      [1, "cell", "code"],
      [2, "cell", "code"],
    ]);
    expect(value.outputsRead).toBe(0);
    expect(value.metadataRead).toBe(0);
  });

  it("rejects stale notebook references before attaching changed cell source", () => {
    const value = notebook(["answer = 42"]);
    const notebookEditor = {
      notebook: value,
      selection: { start: 0, end: 1 },
      selections: [{ start: 0, end: 1 }],
    };
    const references = notebookCellReferencesFromEditor(notebookEditor as never)!;
    value.version += 1;
    vscodeMock.workspace.notebookDocuments = [value];

    expect(() => new ContextService().captureNotebookCells(references)).toThrow(/Notebook.*Cell/u);
  });

  it("rejects more than eight notebook cells and raw .ipynb file attachment", async () => {
    const value = notebook(Array.from({ length: MAX_CONTEXT_ATTACHMENTS + 1 }, (_, i) => `${i}`));
    const notebookEditor = {
      notebook: value,
      selection: { start: 0, end: value.cellCount },
      selections: [{ start: 0, end: value.cellCount }],
    };
    const references = notebookCellReferencesFromEditor(notebookEditor as never)!;
    vscodeMock.workspace.notebookDocuments = [value];
    expect(() => new ContextService().captureNotebookCells(references)).toThrow(
      /8.*Notebook Cell/u,
    );

    vscodeMock.window.showOpenDialog.mockResolvedValueOnce([
      {
        fsPath: String.raw`C:\repo\analysis.ipynb`,
        path: "/repo/analysis.ipynb",
      },
    ]);
    await expect(new ContextService().captureFiles()).rejects.toThrow(/\.ipynb/u);
    expect(vscodeMock.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it("does not mislabel an active notebook cell as the current file", () => {
    const value = notebook(["answer = 42"]);
    vscodeMock.window.activeTextEditor = {
      document: value.cells[0]!.document,
      selection: { isEmpty: true },
    };
    expect(() => new ContextService().captureCurrentFile()).toThrow(/Cell/u);
  });

  it.each([
    {
      label: "local fileName",
      fileName: String.raw`C:\repo\analysis.IPYNB`,
      uri: {
        scheme: "file",
        path: "/repo/analysis",
        fsPath: String.raw`C:\repo\analysis`,
        toString: () => "file:///repo/analysis",
      },
    },
    {
      label: "remote URI path",
      fileName: "/home/dev/analysis",
      uri: {
        scheme: "vscode-remote",
        path: "/home/dev/analysis.ipynb",
        fsPath: "/home/dev/analysis",
        toString: () => "vscode-remote://ssh-remote+host/home/dev/analysis.ipynb",
      },
    },
    {
      label: "remote fsPath",
      fileName: "/home/dev/analysis",
      uri: {
        scheme: "vscode-remote",
        path: "/home/dev/analysis",
        fsPath: "/home/dev/analysis.ipynb",
        toString: () => "vscode-remote://ssh-remote+host/home/dev/analysis",
      },
    },
  ])(
    "rejects a raw .ipynb text document identified by $label without reading JSON",
    ({ fileName, uri }) => {
      const rawJson =
        '{"cells":[],"metadata":{"secret":"ASK2GPT_METADATA_MUST_NOT_LEAK"},"outputs":["ASK2GPT_OUTPUT_MUST_NOT_LEAK"]}';
      const getText = vi.fn(() => rawJson);
      let getTextPropertyReads = 0;
      const rawDocument = {
        fileName,
        uri,
        languageId: "json",
        isDirty: false,
        version: 1,
        lineCount: 1,
        get getText() {
          getTextPropertyReads += 1;
          return getText;
        },
        lineAt: () => ({ text: rawJson }),
        validateRange: (range: unknown) => range,
      };
      vscodeMock.window.activeTextEditor = {
        document: rawDocument,
        selection: {
          isEmpty: false,
          start: { line: 0, character: 0 },
          end: { line: 0, character: rawJson.length },
        },
      };

      for (const capture of [
        () => new ContextService().captureSelection(),
        () => new ContextService().captureCurrentFile(),
      ]) {
        let thrown: unknown;
        try {
          capture();
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ code: "NOTEBOOK_FILE_REQUIRES_NOTEBOOK_API" });
        expect(String(thrown)).not.toContain("ASK2GPT_METADATA_MUST_NOT_LEAK");
        expect(String(thrown)).not.toContain("ASK2GPT_OUTPUT_MUST_NOT_LEAK");
      }
      expect(getTextPropertyReads).toBe(0);
      expect(getText).not.toHaveBeenCalled();
    },
  );

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
    expect(
      snapshots.map((snapshot) => ({
        formatVersion: snapshot.sourceAnchor?.formatVersion,
        contentSha256: snapshot.sourceAnchor?.contentSha256,
        documentVersion: snapshot.sourceAnchor?.documentVersion,
      })),
    ).toEqual([
      { formatVersion: 1, contentSha256: digest("export const first = 1;"), documentVersion: 1 },
      { formatVersion: 1, contentSha256: digest("export const second = 2;"), documentVersion: 1 },
    ]);
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
    const outside = new ContextService().captureCurrentFile();
    expect(outside.fileName).toBe("index.ts");
    expect(outside.sourceAnchor?.workspaceRelativePath).toBeUndefined();
  });

  it("includes the workspace folder in a multi-root anchor and rejects escaping identities", () => {
    vscodeMock.workspace.workspaceFolders = [{ name: "repo" }, { name: "other" }];
    vscodeMock.window.activeTextEditor = editor();
    expect(new ContextService().captureCurrentFile().sourceAnchor?.workspaceRelativePath).toBe(
      "repo/src/index.ts",
    );

    vscodeMock.workspace.workspaceFolders = [{ name: "repo" }];
    vscodeMock.workspace.asRelativePath.mockReturnValue("../external/index.ts");
    expect(
      new ContextService().captureCurrentFile().sourceAnchor?.workspaceRelativePath,
    ).toBeUndefined();
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
  const lines = content.split("\n");
  return {
    fileName,
    uri: {
      path: fileName.replaceAll("\\", "/"),
      toString: () => `file:///${fileName.replaceAll("\\", "/")}`,
    },
    languageId: "typescript",
    isDirty: false,
    version: 1,
    lineCount: lines.length,
    getText: () => content,
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
  };
}

function editor(options?: {
  fileName?: string;
  getText?: (selection?: unknown) => string;
  lines?: string[];
  version?: number;
  validateRange?: (range: unknown) => unknown;
  selection?: {
    isEmpty: boolean;
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}) {
  const lines = options?.lines ?? ["x", ""];
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
      lineCount: lines.length,
      getText: options?.getText ?? (() => "x"),
      lineAt: (line: number) => ({ text: lines[line] ?? "" }),
      validateRange: options?.validateRange ?? ((range: unknown) => range),
    },
  };
}

interface TestNotebookCell {
  index: number;
  notebook: TestNotebook;
  kind: number;
  document: ReturnType<typeof notebookCellDocument>;
  readonly outputs: never[];
  readonly metadata: Record<string, never>;
}

interface TestNotebook {
  uri: {
    scheme: string;
    path: string;
    fsPath: string;
    toString(): string;
  };
  notebookType: string;
  version: number;
  isDirty: boolean;
  isClosed: boolean;
  cellCount: number;
  cells: TestNotebookCell[];
  outputsRead: number;
  metadataRead: number;
  cellAt(index: number): TestNotebookCell;
  getCells(): TestNotebookCell[];
}

function notebook(
  contents: string[],
  uri = "file:///repo/analysis.ipynb",
  kinds = contents.map(() => 2),
): TestNotebook {
  const value: TestNotebook = {
    uri: {
      scheme: uri.slice(0, uri.indexOf(":")),
      path: "/repo/analysis.ipynb",
      fsPath: String.raw`C:\repo\analysis.ipynb`,
      toString: () => uri,
    },
    notebookType: "jupyter-notebook",
    version: 11,
    isDirty: true,
    isClosed: false,
    cellCount: contents.length,
    cells: [],
    outputsRead: 0,
    metadataRead: 0,
    cellAt(index) {
      return this.cells[index]!;
    },
    getCells() {
      return this.cells;
    },
  };
  value.cells = contents.map((content, index) => {
    const kind = kinds[index] ?? 2;
    const cell = {
      index,
      notebook: value,
      kind,
      document: notebookCellDocument(content, index, kind === 1 ? "markdown" : "python"),
      get outputs() {
        value.outputsRead += 1;
        return [];
      },
      get metadata() {
        value.metadataRead += 1;
        return {};
      },
    };
    return cell;
  });
  return value;
}

function notebookCellDocument(content: string, index: number, languageId: string) {
  const lines = content.split(/\r\n|\r|\n/u);
  return {
    fileName: `analysis.ipynb#${index}`,
    uri: {
      scheme: "vscode-notebook-cell",
      path: `/repo/analysis.ipynb#${index}`,
      toString: () => `vscode-notebook-cell:/repo/analysis.ipynb#${index}`,
    },
    languageId,
    isDirty: true,
    version: 7,
    lineCount: lines.length,
    getText: (range?: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    }) => (range ? textInRange(lines, range) : content),
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
    validateRange: (range: unknown) => range,
  };
}

function textInRange(
  lines: string[],
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  },
) {
  if (range.start.line === range.end.line) {
    return (lines[range.start.line] ?? "").slice(range.start.character, range.end.character);
  }
  return [
    (lines[range.start.line] ?? "").slice(range.start.character),
    ...lines.slice(range.start.line + 1, range.end.line),
    (lines[range.end.line] ?? "").slice(0, range.end.character),
  ].join("\n");
}

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
