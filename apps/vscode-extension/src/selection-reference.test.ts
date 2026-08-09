import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  isClaimedNotebookCellCommandTarget,
  isOpenNotebookDocumentCommandTarget,
  notebookCellReferencesFromEditor,
  resolveNotebookCellCommandTarget,
  selectionReferenceFromEditor,
} from "./selection-reference";

describe("selectionReferenceFromEditor", () => {
  it("captures the exact document version and character range", () => {
    const reference = selectionReferenceFromEditor({
      document: {
        uri: { scheme: "file", toString: () => "file:///repo/src/index.ts" },
        version: 17,
      } as never,
      selection: {
        isEmpty: false,
        start: { line: 2, character: 4 },
        end: { line: 8, character: 11 },
      } as never,
    });

    expect(reference).toEqual({
      uri: "file:///repo/src/index.ts",
      documentVersion: 17,
      startLine: 2,
      startCharacter: 4,
      endLine: 8,
      endCharacter: 11,
    });
  });

  it("does not attach when there is no non-empty editor selection", () => {
    expect(selectionReferenceFromEditor(undefined)).toBeUndefined();
    expect(
      selectionReferenceFromEditor({
        document: {
          uri: { scheme: "file", toString: () => "file:///repo/src/index.ts" },
          version: 1,
        } as never,
        selection: { isEmpty: true } as never,
      }),
    ).toBeUndefined();
  });

  it.each(["untitled", "vscode-remote"])(
    "captures explicit selections from %s editors like VS Code chat",
    (scheme) => {
      expect(
        selectionReferenceFromEditor({
          document: {
            uri: { scheme, toString: () => `${scheme}:selection.ts` },
            version: 1,
          } as never,
          selection: {
            isEmpty: false,
            start: { line: 0, character: 0 },
            end: { line: 0, character: 4 },
          } as never,
        }),
      ).toMatchObject({ uri: `${scheme}:selection.ts`, endCharacter: 4 });
    },
  );

  it("rejects selections from unrelated virtual editors", () => {
    expect(
      selectionReferenceFromEditor({
        document: {
          uri: { scheme: "output", toString: () => "output:extension-log" },
          version: 1,
        } as never,
        selection: {
          isEmpty: false,
          start: { line: 0, character: 0 },
          end: { line: 0, character: 4 },
        } as never,
      }),
    ).toBeUndefined();
  });

  it("captures an exact notebook-cell text range before sidebar focus changes", () => {
    const notebook = testNotebook(["before", "first  \r\nsecond\t ", "after"]);
    const selectedCell = notebook.cells[1]!;

    const references = notebookCellReferencesFromEditor(
      {
        notebook,
        selection: { start: 1, end: 2 },
        selections: [{ start: 0, end: 3 }],
      } as never,
      {
        document: selectedCell.document,
        selection: {
          isEmpty: false,
          start: { line: 0, character: 2 },
          end: { line: 1, character: 4 },
        },
      } as never,
    );

    expect(references).toEqual([
      expect.objectContaining({
        type: "notebook-cell",
        notebookUri: "file:///repo/analysis.ipynb",
        notebookType: "jupyter-notebook",
        notebookVersion: 9,
        cellIndex: 1,
        cellKind: "code",
        cellLanguage: "python",
        cellDocumentVersion: 4,
        scope: "range",
        startLine: 0,
        startCharacter: 2,
        endLine: 1,
        endCharacter: 4,
        cellContentSha256: digest("first  \r\nsecond\t "),
        normalizedCellContentSha256: digest("first\nsecond"),
        beforeCellSha256: digest("before"),
        afterCellSha256: digest("after"),
      }),
    ]);
  });

  it("captures every selected cell once in notebook order when there is no text range", () => {
    const notebook = testNotebook(["one", "two", "three", "four"]);
    const references = notebookCellReferencesFromEditor(
      {
        notebook,
        selection: { start: 3, end: 4 },
        selections: [
          { start: 2, end: 4 },
          { start: 0, end: 2 },
          { start: 1, end: 3 },
        ],
      } as never,
      {
        document: notebook.cells[0]!.document,
        selection: { isEmpty: true },
      } as never,
    );

    expect(references?.map(({ cellIndex, scope }) => ({ cellIndex, scope }))).toEqual([
      { cellIndex: 0, scope: "cell" },
      { cellIndex: 1, scope: "cell" },
      { cellIndex: 2, scope: "cell" },
      { cellIndex: 3, scope: "cell" },
    ]);
  });

  it("fails closed for unsupported notebook containers and empty notebooks", () => {
    const unsupported = testNotebook(["one"], "vscode-notebook-cell:/virtual.ipynb");
    expect(
      notebookCellReferencesFromEditor({
        notebook: unsupported,
        selection: { start: 0, end: 1 },
        selections: [{ start: 0, end: 1 }],
      } as never),
    ).toBeUndefined();

    const empty = testNotebook([]);
    expect(
      notebookCellReferencesFromEditor({
        notebook: empty,
        selection: { start: 0, end: 0 },
        selections: [],
      } as never),
    ).toBeUndefined();
  });

  it("uses the cell-title command's clicked non-active cell instead of the active cell", () => {
    const notebook = testNotebook(["active cell", "middle cell", "clicked cell"]);
    const activeCell = notebook.cells[0]!;
    const clickedCell = notebook.cells[2]!;

    const resolved = resolveNotebookCellCommandTarget(
      clickedCell,
      [notebook] as never,
      {
        document: activeCell.document,
        selection: {
          isEmpty: false,
          start: { line: 0, character: 0 },
          end: { line: 0, character: 6 },
        },
      } as never,
    );

    expect(resolved?.cell).toBe(clickedCell);
    expect(resolved?.reference).toMatchObject({
      cellIndex: 2,
      scope: "cell",
      cellContentSha256: digest("clicked cell"),
    });
  });

  it("keeps an exact text range only when it belongs to the clicked cell", () => {
    const notebook = testNotebook(["first", "clicked cell"]);
    const clickedCell = notebook.cells[1]!;

    const resolved = resolveNotebookCellCommandTarget(
      clickedCell,
      [notebook] as never,
      {
        document: clickedCell.document,
        selection: {
          isEmpty: false,
          start: { line: 0, character: 2 },
          end: { line: 0, character: 7 },
        },
      } as never,
    );

    expect(resolved?.reference).toMatchObject({
      cellIndex: 1,
      scope: "range",
      startCharacter: 2,
      endCharacter: 7,
    });
  });

  it("rejects forged cell lookalikes and accepts only host-owned notebook documents", () => {
    const notebook = testNotebook(["trusted"]);
    const forgedCell = {
      ...notebook.cells[0],
      index: 0,
    };

    expect(isClaimedNotebookCellCommandTarget(forgedCell)).toBe(true);
    expect(resolveNotebookCellCommandTarget(forgedCell, [notebook] as never)).toBeUndefined();
    expect(isOpenNotebookDocumentCommandTarget(notebook, [notebook] as never)).toBe(true);
    expect(
      isOpenNotebookDocumentCommandTarget({ ...notebook, uri: notebook.uri }, [notebook] as never),
    ).toBe(false);
  });
});

function testNotebook(contents: string[], uri = "file:///repo/analysis.ipynb") {
  const scheme = uri.slice(0, uri.indexOf(":"));
  const notebook = {
    uri: { scheme, toString: () => uri },
    notebookType: "jupyter-notebook",
    version: 9,
    cellCount: contents.length,
    cells: [] as Array<{
      index: number;
      notebook: unknown;
      kind: number;
      document: {
        uri: { toString(): string };
        languageId: string;
        version: number;
        getText(): string;
      };
    }>,
    cellAt(index: number) {
      return this.cells[index]!;
    },
    getCells() {
      return this.cells;
    },
  };
  notebook.cells = contents.map((content, index) => ({
    index,
    notebook,
    kind: 2,
    document: {
      uri: { toString: () => `vscode-notebook-cell:/repo/analysis.ipynb#${index}` },
      languageId: "python",
      version: 4,
      getText: () => content,
    },
  }));
  return notebook;
}

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
