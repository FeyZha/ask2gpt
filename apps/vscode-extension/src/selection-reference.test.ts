import { describe, expect, it } from "vitest";

import { selectionReferenceFromEditor } from "./selection-reference";

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
});
