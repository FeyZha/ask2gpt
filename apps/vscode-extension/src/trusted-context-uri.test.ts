import type { ContextSnapshot } from "@ask2gpt/protocol";
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  Uri: {
    parse(value: string) {
      const scheme = /^([A-Za-z][A-Za-z\d+.-]*):/u.exec(value)?.[1]?.toLowerCase();
      if (!scheme) throw new Error("Invalid URI");
      const path =
        scheme === "file"
          ? value.replace(/^file:\/\//u, "")
          : (/^[A-Za-z][A-Za-z\d+.-]*:\/\/[^/]+(\/.*)$/u.exec(value)?.[1] ??
            value.slice(scheme.length + 1));
      return { scheme, path, fsPath: path, toString: () => value };
    },
  },
}));

import { normalizeSourceAnchorContent, sourceAnchorSha256 } from "./source-anchor";
import { trustedContextUri, TrustedContextUriError } from "./trusted-context-uri";

describe("trustedContextUri", () => {
  it.each([
    "file:///workspace/analysis.ipynb",
    "untitled:analysis.ipynb",
    "vscode-remote://ssh-remote+host/workspace/analysis.ipynb",
  ])("accepts a trusted notebook container URI: %s", (uri) => {
    expect(trustedContextUri(notebookContext(uri)).toString()).toBe(uri);
  });

  it("rejects a durable notebook anchor that disagrees with its context URI", () => {
    const context = notebookContext("file:///workspace/analysis.ipynb");
    context.sourceAnchor.notebookUri = "file:///workspace/other.ipynb";

    expect(() => trustedContextUri(context)).toThrowError(
      expect.objectContaining<Partial<TrustedContextUriError>>({
        reason: "anchor-uri-mismatch",
      }),
    );
  });

  it("rejects virtual cell URIs even when the filename looks like a notebook", () => {
    const uri = "vscode-notebook-cell:///workspace/analysis.ipynb#cell-3";
    const context = notebookContext(uri);

    expect(() => trustedContextUri(context)).toThrowError(
      expect.objectContaining<Partial<TrustedContextUriError>>({
        reason: "unsupported-scheme",
      }),
    );
  });

  it("still rejects a container whose basename differs from captured host state", () => {
    const context = notebookContext("file:///workspace/other.ipynb");

    expect(() => trustedContextUri(context)).toThrowError(
      expect.objectContaining<Partial<TrustedContextUriError>>({ reason: "basename-mismatch" }),
    );
  });
});

function notebookContext(uri: string): ContextSnapshot & {
  sourceAnchor: Extract<ContextSnapshot["sourceAnchor"], { formatVersion: 2 }>;
} {
  const content = "print(value)";
  const hash = sourceAnchorSha256(content);
  return {
    id: "notebook-context",
    kind: "selection",
    fileName: "analysis.ipynb",
    uri,
    language: "python",
    startLine: 1,
    endLine: 1,
    content,
    charCount: content.length,
    unsaved: false,
    sourceAnchor: {
      formatVersion: 2,
      notebookUri: uri,
      notebookType: "jupyter-notebook",
      notebookVersion: 1,
      cellIndex: 0,
      cellKind: "code",
      cellLanguage: "python",
      scope: "cell",
      documentVersion: 1,
      range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: content.length },
      contentSha256: hash,
      normalizedContentSha256: sourceAnchorSha256(normalizeSourceAnchorContent(content)),
      cellContentSha256: hash,
      normalizedCellContentSha256: sourceAnchorSha256(normalizeSourceAnchorContent(content)),
    },
  };
}
