import type { ContextSnapshot, NotebookSourceAnchorV2 } from "@ask2gpt/protocol";
import type * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
  notebooks: new Map<string, unknown>(),
  openNotebookDocument: vi.fn(),
  showNotebookDocument: vi.fn(),
  showTextDocument: vi.fn(),
  visibleTextEditors: [] as Array<{
    document: { uri: { toString(exact?: boolean): string } };
    selection?: unknown;
    revealRange: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("vscode", () => {
  class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  }
  class Range {
    constructor(
      readonly start: Position,
      readonly end: Position,
    ) {}
  }
  class Selection extends Range {}
  class NotebookRange {
    constructor(
      readonly start: number,
      readonly end: number,
    ) {}
  }
  const parseUri = (value: string) => {
    const scheme = /^([A-Za-z][A-Za-z\d+.-]*):/u.exec(value)?.[1]?.toLowerCase();
    if (!scheme) throw new Error("Invalid URI");
    const path =
      scheme === "file"
        ? value.replace(/^file:\/\//u, "")
        : (/^[A-Za-z][A-Za-z\d+.-]*:\/\/[^/]+(\/.*)$/u.exec(value)?.[1] ??
          value.slice(scheme.length + 1));
    return { scheme, path, fsPath: path, toString: () => value };
  };
  return {
    Position,
    Range,
    Selection,
    NotebookRange,
    NotebookCellKind: { Markup: 1, Code: 2 },
    NotebookEditorRevealType: { InCenterIfOutsideViewport: 2 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    Uri: { parse: parseUri },
    window: {
      get visibleTextEditors() {
        return vscodeMock.visibleTextEditors;
      },
      showNotebookDocument: vscodeMock.showNotebookDocument,
      showTextDocument: vscodeMock.showTextDocument,
    },
    workspace: { openNotebookDocument: vscodeMock.openNotebookDocument },
  };
});

import {
  resolveNotebookCell,
  resolveNotebookContextCell,
  showNotebookContextRange,
} from "./notebook-source-navigation";
import { normalizeSourceAnchorContent, sourceAnchorSha256 } from "./source-anchor";

describe("notebook source navigation", () => {
  beforeEach(() => {
    vscodeMock.notebooks.clear();
    vscodeMock.visibleTextEditors.length = 0;
    vscodeMock.openNotebookDocument
      .mockReset()
      .mockImplementation(async (uri: { toString(exact?: boolean): string }) => {
        const found = vscodeMock.notebooks.get(uri.toString(true));
        if (!found) throw new Error(`Missing notebook: ${uri.toString(true)}`);
        return found;
      });
    vscodeMock.showNotebookDocument.mockReset().mockImplementation(async () => ({
      selection: undefined,
      selections: [],
      revealRange: vi.fn(),
    }));
    vscodeMock.showTextDocument
      .mockReset()
      .mockRejectedValue(new Error("Notebook provider did not expose a cell text editor"));
  });

  it("uses the captured index only while the notebook version is unchanged", () => {
    const live = makeNotebook(7, ["duplicate()", "target()", "duplicate()"]);
    const exact = anchor("duplicate()", { cellIndex: 0, notebookVersion: 7 });

    expect(resolveNotebookCell(live as unknown as vscode.NotebookDocument, exact)).toMatchObject({
      status: "found",
      cell: { index: 0 },
    });

    const changedVersion = anchor("duplicate()", { cellIndex: 0, notebookVersion: 6 });
    expect(resolveNotebookCell(live as unknown as vscode.NotebookDocument, changedVersion)).toEqual(
      { status: "ambiguous" },
    );
  });

  it("relocates a moved duplicate only when adjacent cell hashes uniquely disambiguate it", () => {
    const live = makeNotebook(9, ["before", "same()", "middle", "same()", "after"]);
    const moved = anchor("same()", {
      notebookVersion: 3,
      cellIndex: 1,
      beforeCellSha256: sourceAnchorSha256("middle"),
      afterCellSha256: sourceAnchorSha256("after"),
    });

    expect(resolveNotebookCell(live as unknown as vscode.NotebookDocument, moved)).toMatchObject({
      status: "found",
      cell: { index: 3 },
    });
  });

  it("fails closed when the captured cell was deleted", () => {
    const live = makeNotebook(9, ["before", "replacement()", "after"]);
    const deleted = anchor("removed()", { notebookVersion: 3, cellIndex: 1 });

    expect(resolveNotebookCell(live as unknown as vscode.NotebookDocument, deleted)).toEqual({
      status: "missing",
    });
  });

  it("opens the trusted container, resolves the cell, and never opens its virtual URI", async () => {
    const notebookUri = "file:///workspace/analysis.ipynb";
    const live = makeNotebook(10, ["before", "print(value)"], notebookUri);
    vscodeMock.notebooks.set(notebookUri, live);
    const context = notebookContext("print(value)", {
      notebookUri,
      notebookVersion: 10,
      cellIndex: 1,
    });

    const resolution = await resolveNotebookContextCell(context);

    expect(resolution).toMatchObject({ status: "found", cellIndex: 1 });
    expect(vscodeMock.openNotebookDocument).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/workspace/analysis.ipynb" }),
    );
  });

  it("focuses and highlights an exact range through the public cell text editor API", async () => {
    const notebookUri = "file:///workspace/analysis.ipynb";
    const live = makeNotebook(10, ["first\nsecond"], notebookUri);
    vscodeMock.notebooks.set(notebookUri, live);
    const context = notebookContext("second", {
      notebookUri,
      notebookVersion: 10,
      cellIndex: 0,
      scope: "range",
      range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 6 },
    });
    const resolution = await resolveNotebookContextCell(context);
    expect(resolution.status).toBe("found");
    if (resolution.status !== "found") return;
    const cellEditor = {
      document: resolution.document,
      selection: undefined,
      revealRange: vi.fn(),
    };
    const notebookEditor = {
      selection: undefined,
      selections: [] as unknown[],
      revealRange: vi.fn(),
      viewColumn: 2,
    };
    vscodeMock.showNotebookDocument.mockResolvedValue(notebookEditor);
    vscodeMock.showTextDocument.mockResolvedValue(cellEditor);

    await showNotebookContextRange(resolution);

    expect(vscodeMock.showTextDocument).toHaveBeenCalledWith(resolution.document, {
      preserveFocus: false,
      preview: true,
      selection: resolution.evidenceRange,
      viewColumn: 2,
    });
    expect(cellEditor.selection).toMatchObject({
      start: { line: 1, character: 0 },
      end: { line: 1, character: 6 },
    });
    expect(cellEditor.revealRange).toHaveBeenCalledWith(
      expect.objectContaining({
        start: { line: 1, character: 0 },
        end: { line: 1, character: 6 },
      }),
      2,
    );
  });

  it("falls back to an already-visible cell editor when public focusing is unavailable", async () => {
    const notebookUri = "file:///workspace/analysis.ipynb";
    const live = makeNotebook(10, ["first\nsecond"], notebookUri);
    vscodeMock.notebooks.set(notebookUri, live);
    const context = notebookContext("second", {
      notebookUri,
      notebookVersion: 10,
      cellIndex: 0,
      scope: "range",
      range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 6 },
    });
    const resolution = await resolveNotebookContextCell(context);
    expect(resolution.status).toBe("found");
    if (resolution.status !== "found") return;
    const cellEditor = {
      document: resolution.document,
      selection: undefined,
      revealRange: vi.fn(),
    };
    vscodeMock.visibleTextEditors.push(cellEditor);
    const notebookEditor = {
      selection: undefined,
      selections: [] as unknown[],
      revealRange: vi.fn(),
    };
    vscodeMock.showNotebookDocument.mockResolvedValue(notebookEditor);

    await showNotebookContextRange(resolution);

    expect(vscodeMock.showNotebookDocument).toHaveBeenCalledWith(live, {
      preserveFocus: false,
      preview: true,
      selections: [expect.objectContaining({ start: 0, end: 1 })],
    });
    expect(notebookEditor.revealRange).toHaveBeenCalledWith(
      expect.objectContaining({ start: 0, end: 1 }),
      2,
    );
    expect(vscodeMock.showTextDocument).toHaveBeenCalledWith(
      resolution.document,
      expect.objectContaining({ selection: resolution.evidenceRange }),
    );
    expect(cellEditor.selection).toMatchObject({
      start: { line: 1, character: 0 },
      end: { line: 1, character: 6 },
    });
  });

  it("keeps the accurate cell-level fallback when the provider exposes no matching text editor", async () => {
    const notebookUri = "file:///workspace/analysis.ipynb";
    const live = makeNotebook(10, ["first\nsecond"], notebookUri);
    vscodeMock.notebooks.set(notebookUri, live);
    const context = notebookContext("second", {
      notebookUri,
      notebookVersion: 10,
      cellIndex: 0,
      scope: "range",
      range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 6 },
    });
    const resolution = await resolveNotebookContextCell(context);
    expect(resolution.status).toBe("found");
    if (resolution.status !== "found") return;
    const unrelatedEditor = {
      document: textDocument("unrelated", "file:///workspace/unrelated.py"),
      selection: undefined,
      revealRange: vi.fn(),
    };
    const notebookEditor = {
      selection: undefined,
      selections: [] as unknown[],
      revealRange: vi.fn(),
    };
    vscodeMock.showNotebookDocument.mockResolvedValue(notebookEditor);
    vscodeMock.showTextDocument.mockResolvedValue(unrelatedEditor);

    await expect(showNotebookContextRange(resolution)).resolves.toBeUndefined();

    expect(notebookEditor.revealRange).toHaveBeenCalledWith(
      expect.objectContaining({ start: 0, end: 1 }),
      2,
    );
    expect(unrelatedEditor.selection).toBeUndefined();
    expect(unrelatedEditor.revealRange).not.toHaveBeenCalled();
  });

  it("fails closed before opening when the durable notebook URI disagrees with the context", async () => {
    const context = notebookContext("value", {
      notebookUri: "file:///workspace/other.ipynb",
    });

    await expect(resolveNotebookContextCell(context)).rejects.toMatchObject({
      reason: "anchor-uri-mismatch",
    });
    expect(vscodeMock.openNotebookDocument).not.toHaveBeenCalled();
  });
});

function notebookContext(
  content: string,
  overrides: Partial<NotebookSourceAnchorV2> = {},
): ContextSnapshot & { sourceAnchor: NotebookSourceAnchorV2 } {
  const notebookUri = overrides.notebookUri ?? "file:///workspace/analysis.ipynb";
  const sourceAnchor = anchor(content, { notebookUri, ...overrides });
  return {
    id: "notebook-context",
    kind: "selection",
    fileName: "analysis.ipynb",
    uri: "file:///workspace/analysis.ipynb",
    language: "python",
    startLine: sourceAnchor.range.startLine + 1,
    endLine: sourceAnchor.range.endLine + 1,
    content,
    charCount: content.length,
    unsaved: false,
    sourceAnchor,
  };
}

function anchor(
  content: string,
  overrides: Partial<NotebookSourceAnchorV2> = {},
): NotebookSourceAnchorV2 {
  const cellContent = overrides.scope === "range" ? `first\n${content}` : content;
  return {
    formatVersion: 2,
    notebookUri: "file:///workspace/analysis.ipynb",
    notebookType: "jupyter-notebook",
    notebookVersion: 1,
    cellIndex: 0,
    cellKind: "code",
    cellLanguage: "python",
    scope: "cell",
    documentVersion: 1,
    range: {
      startLine: 0,
      startCharacter: 0,
      endLine: 0,
      endCharacter: content.length,
    },
    contentSha256: sourceAnchorSha256(content),
    normalizedContentSha256: sourceAnchorSha256(normalizeSourceAnchorContent(content)),
    cellContentSha256: sourceAnchorSha256(cellContent),
    normalizedCellContentSha256: sourceAnchorSha256(normalizeSourceAnchorContent(cellContent)),
    ...overrides,
  };
}

interface TestNotebook {
  uri: ReturnType<typeof testUri>;
  notebookType: string;
  version: number;
  cellCount: number;
  cells: TestCell[];
  cellAt(index: number): TestCell;
  getCells(): TestCell[];
}

interface TestCell {
  index: number;
  notebook: TestNotebook;
  kind: number;
  document: ReturnType<typeof textDocument>;
}

function makeNotebook(
  version: number,
  sources: string[],
  uri = "file:///workspace/analysis.ipynb",
): TestNotebook {
  const notebook: TestNotebook = {
    uri: testUri(uri),
    notebookType: "jupyter-notebook",
    version,
    cellCount: sources.length,
    cells: [],
    cellAt(index: number) {
      return this.cells[index]!;
    },
    getCells() {
      return this.cells;
    },
  };
  notebook.cells = sources.map((source, index) => makeCell(notebook, index, source));
  return notebook;
}

function makeCell(notebook: TestNotebook, index: number, content: string): TestCell {
  return {
    index,
    notebook,
    kind: 2,
    document: textDocument(
      content,
      `vscode-notebook-cell:///workspace/analysis.ipynb#cell-${index}`,
    ),
  };
}

function textDocument(content: string, uri: string) {
  const lines = content.split("\n");
  const offsets: number[] = [];
  let next = 0;
  for (const line of lines) {
    offsets.push(next);
    next += line.length + 1;
  }
  const offsetAt = (position: { line: number; character: number }) =>
    Math.min(content.length, offsets[position.line]! + position.character);
  return {
    uri: testUri(uri),
    languageId: "python",
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line]! }),
    getText: (range?: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    }) => (range ? content.slice(offsetAt(range.start), offsetAt(range.end)) : content),
    positionAt: (offset: number) => {
      const bounded = Math.max(0, Math.min(offset, content.length));
      let line = 0;
      while (line + 1 < offsets.length && offsets[line + 1]! <= bounded) line += 1;
      return { line, character: bounded - offsets[line]! };
    },
  };
}

function testUri(value: string) {
  return { toString: () => value, scheme: value.split(":", 1)[0], path: value };
}
