import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
  openTextDocument: vi.fn(),
  showTextDocument: vi.fn(),
}));

vi.mock("vscode", () => {
  class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  }

  class Range {
    readonly start: Position;
    readonly end: Position;

    constructor(start: Position, end: Position) {
      this.start = start;
      this.end = end;
    }
  }

  class Selection extends Range {}

  return {
    Position,
    Range,
    Selection,
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    Uri: {
      parse: (value: string) => {
        const scheme = /^([A-Za-z][A-Za-z\d+.-]*):/u.exec(value)?.[1]?.toLowerCase();
        if (!scheme) throw new Error("Invalid URI");
        const path =
          scheme === "file"
            ? value.replace(/^file:\/\//u, "")
            : (/^[A-Za-z][A-Za-z\d+.-]*:\/\/[^/]+(\/.*)$/u.exec(value)?.[1] ??
              value.slice(scheme.length + 1));
        return { scheme, fsPath: path, path, toString: () => value };
      },
    },
    window: { showTextDocument: vscodeMock.showTextDocument },
    workspace: { openTextDocument: vscodeMock.openTextDocument },
  };
});

import type { ContextSnapshot } from "@ask2gpt/protocol";

import { openContextFromState, resolveContextFromState } from "./context-navigation";
import { normalizeSourceAnchorContent, sourceAnchorSha256 } from "./source-anchor";
import type { AppState } from "./types";

describe("context navigation", () => {
  beforeEach(() => {
    vscodeMock.openTextDocument.mockReset();
    vscodeMock.showTextDocument.mockReset();
  });

  it("resolves only the requested conversation's host-owned pending or sent context", () => {
    const pending = context("shared-context", "file:///workspace/pending.ts");
    const sentA = context("sent-a", "file:///workspace/a.ts");
    const sentB = context("shared-context", "file:///workspace/b.ts");
    const state = appState(pending, sentA, sentB);

    expect(resolveContextFromState(state, "conversation-a", "shared-context")).toBe(pending);
    expect(resolveContextFromState(state, "conversation-a", "sent-a")).toBe(sentA);
    expect(resolveContextFromState(state, "conversation-b", "shared-context")).toBe(sentB);
    expect(resolveContextFromState(state, "conversation-b", "sent-a")).toBeUndefined();
    expect(
      resolveContextFromState(state, "missing-conversation", "shared-context"),
    ).toBeUndefined();
  });

  it("opens the URI from host state and selects the exact unique selection inside its line range", async () => {
    const source = "before\n  selected();\nafter";
    const document = textDocument(source);
    const editor = {
      selection: undefined as unknown,
      revealRange: vi.fn(),
    };
    vscodeMock.openTextDocument.mockResolvedValue(document);
    vscodeMock.showTextDocument.mockResolvedValue(editor);
    const selected = context("selection-context", "file:///workspace/source.ts", {
      content: "selected()",
      endLine: 2,
      kind: "selection",
      startLine: 2,
    });
    const state = appState(selected);

    await openContextFromState(state, "conversation-a", "selection-context");

    expect(vscodeMock.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/workspace/source.ts" }),
    );
    expect(vscodeMock.showTextDocument).toHaveBeenCalledWith(document, {
      preserveFocus: false,
      preview: true,
    });
    expect(editor.selection).toMatchObject({
      start: { line: 1, character: 2 },
      end: { line: 1, character: 12 },
    });
    expect(editor.revealRange).toHaveBeenCalledWith(editor.selection, 2);
  });

  it("relocates a unique selection across the whole document before validating stale line metadata", async () => {
    const document = textDocument("moved();\nother();\n");
    const editor = {
      selection: undefined as unknown,
      revealRange: vi.fn(),
    };
    vscodeMock.openTextDocument.mockResolvedValue(document);
    vscodeMock.showTextDocument.mockResolvedValue(editor);
    const selected = context("moved-context", "file:///workspace/source.ts", {
      content: "moved()",
      endLine: 40,
      startLine: 40,
    });

    await openContextFromState(appState(selected), "conversation-a", "moved-context");

    expect(editor.selection).toMatchObject({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 7 },
    });
    expect(editor.revealRange).toHaveBeenCalledWith(editor.selection, 2);
  });

  it.each([
    ["missing", "not-present", "before\nafter", "CONTEXT_RANGE_STALE"],
    ["repeated", "same", "same\nsame", "CONTEXT_RANGE_AMBIGUOUS"],
  ])(
    "rejects a %s selection snapshot instead of trusting its old line number",
    async (_case, content, source, code) => {
      const document = textDocument(source);
      const editor = {
        selection: undefined as unknown,
        revealRange: vi.fn(),
      };
      vscodeMock.openTextDocument.mockResolvedValue(document);
      vscodeMock.showTextDocument.mockResolvedValue(editor);
      const selected = context("fallback-context", "file:///workspace/source.ts", {
        content,
        endLine: 2,
        startLine: 2,
      });

      await expect(
        openContextFromState(appState(selected), "conversation-a", "fallback-context"),
      ).rejects.toMatchObject({ code });
      expect(vscodeMock.showTextDocument).not.toHaveBeenCalled();
    },
  );

  it("accepts a normalized full-file anchor without trusting stale line metadata", async () => {
    const captured = "alpha  \r\nbeta\t ";
    const document = textDocument("alpha\nbeta");
    const editor = { selection: undefined as unknown, revealRange: vi.fn() };
    vscodeMock.openTextDocument.mockResolvedValue(document);
    vscodeMock.showTextDocument.mockResolvedValue(editor);
    const file = anchoredContext("normalized-file", captured, {
      endLine: 2,
      kind: "current-file",
    });

    await openContextFromState(appState(file), "conversation-a", file.id);

    expect(editor.selection).toMatchObject({
      start: { line: 0, character: 0 },
      end: { line: 1, character: 4 },
    });
  });

  it("relocates a full-file snapshot after lines are inserted outside the snapshot", async () => {
    const captured = "alpha\nbeta";
    const document = textDocument("inserted\nalpha\nbeta");
    const editor = { selection: undefined as unknown, revealRange: vi.fn() };
    vscodeMock.openTextDocument.mockResolvedValue(document);
    vscodeMock.showTextDocument.mockResolvedValue(editor);
    const file = anchoredContext("inserted-file", captured, {
      endLine: 2,
      kind: "file",
    });

    await openContextFromState(appState(file), "conversation-a", file.id);

    expect(editor.selection).toMatchObject({
      start: { line: 1, character: 0 },
      end: { line: 2, character: 4 },
    });
  });

  it.each([
    ["inserted inside", "alpha\ninserted\nbeta", "CONTEXT_RANGE_STALE"],
    ["deleted", "alpha", "CONTEXT_RANGE_STALE"],
    ["replaced in place", "gamma\ndelta", "CONTEXT_RANGE_STALE"],
    ["repeated", "alpha\nbeta\nseparator\nalpha\nbeta", "CONTEXT_RANGE_AMBIGUOUS"],
  ])("rejects a full-file snapshot that is %s", async (_case, source, code) => {
    const file = anchoredContext("drifted-file", "alpha\nbeta", {
      endLine: 2,
      kind: "file",
    });
    vscodeMock.openTextDocument.mockResolvedValue(textDocument(source));

    await expect(
      openContextFromState(appState(file), "conversation-a", file.id),
    ).rejects.toMatchObject({ code });
    expect(vscodeMock.showTextDocument).not.toHaveBeenCalled();
  });

  it("uses a unique pair of adjacent-line hashes to relocate a bounded file snapshot", async () => {
    const document = textDocument("header\nBEGIN\nnew one\nnew two\nEND\nfooter");
    const editor = { selection: undefined as unknown, revealRange: vi.fn() };
    vscodeMock.openTextDocument.mockResolvedValue(document);
    vscodeMock.showTextDocument.mockResolvedValue(editor);
    const file = anchoredContext("neighbor-file", "old one\nold two", {
      endLine: 11,
      kind: "file",
      startLine: 10,
      sourceAnchor: sourceAnchor("old one\nold two", {
        beforeLineSha256: sourceAnchorSha256("BEGIN"),
        afterLineSha256: sourceAnchorSha256("END"),
      }),
    });

    await openContextFromState(appState(file), "conversation-a", file.id);

    expect(editor.selection).toMatchObject({
      start: { line: 2, character: 0 },
      end: { line: 3, character: 7 },
    });
  });

  it("rejects missing or stale host context instead of opening a webview-supplied target", async () => {
    const state = appState(context("pending-context", "file:///workspace/pending.ts"));

    await expect(
      openContextFromState(state, "conversation-b", "pending-context"),
    ).rejects.toMatchObject({ code: "CONTEXT_NOT_FOUND" });
    expect(vscodeMock.openTextDocument).not.toHaveBeenCalled();

    vscodeMock.openTextDocument.mockResolvedValue(textDocument("one line"));
    await expect(
      openContextFromState(
        appState(
          context("stale-context", "file:///workspace/stale.ts", {
            endLine: 8,
            startLine: 7,
          }),
        ),
        "conversation-a",
        "stale-context",
      ),
    ).rejects.toMatchObject({
      code: "CONTEXT_RANGE_STALE",
      message: "The file changed and the attached code is no longer available.",
    });
    expect(vscodeMock.showTextDocument).not.toHaveBeenCalled();

    vscodeMock.openTextDocument.mockResolvedValue(textDocument("same\nsame"));
    await expect(
      openContextFromState(
        appState(
          context("repeated-stale-context", "file:///workspace/stale.ts", {
            content: "same",
            endLine: 8,
            startLine: 7,
          }),
        ),
        "conversation-a",
        "repeated-stale-context",
      ),
    ).rejects.toMatchObject({
      code: "CONTEXT_RANGE_AMBIGUOUS",
      message: "The attached code now appears more than once in the file.",
    });
    expect(vscodeMock.showTextDocument).not.toHaveBeenCalled();
  });

  it.each([
    ["unsupported scheme", "https://evil.example/source.ts", "source.ts"],
    ["mismatched basename", "file:///workspace/other.ts", "source.ts"],
  ])("rejects an untrusted context URI with an %s", async (_case, uri, fileName) => {
    const selected = context("untrusted-context", uri, { fileName });

    await expect(
      openContextFromState(appState(selected), "conversation-a", "untrusted-context"),
    ).rejects.toMatchObject({ code: "CONTEXT_TARGET_UNTRUSTED" });
    expect(vscodeMock.openTextDocument).not.toHaveBeenCalled();
  });

  it.each([
    ["untitled", "untitled:source.ts"],
    ["remote", "vscode-remote://ssh-remote+host/workspace/source.ts"],
  ])("opens a trusted %s editor context", async (_case, uri) => {
    vscodeMock.openTextDocument.mockResolvedValue(textDocument("value"));
    vscodeMock.showTextDocument.mockResolvedValue({
      selection: undefined,
      revealRange: vi.fn(),
    });
    const selected = context("trusted-context", uri, { fileName: "source.ts" });

    await openContextFromState(appState(selected), "conversation-a", "trusted-context");

    expect(vscodeMock.openTextDocument).toHaveBeenCalledOnce();
  });

  it("applies sensitive-file policy to both captured filenames and URI targets", async () => {
    const selected = context("sensitive-context", "file:///workspace/.env", {
      fileName: ".env",
    });

    await expect(
      openContextFromState(appState(selected), "conversation-a", "sensitive-context"),
    ).rejects.toMatchObject({ code: "SENSITIVE_CONTEXT" });
    expect(vscodeMock.openTextDocument).not.toHaveBeenCalled();
  });
});

function context(
  id: string,
  uri: string,
  overrides: Partial<ContextSnapshot> = {},
): ContextSnapshot {
  return {
    id,
    kind: "selection",
    fileName: uri.split("/").at(-1) ?? "source.ts",
    uri,
    language: "typescript",
    startLine: 1,
    endLine: 1,
    content: "value",
    charCount: 5,
    unsaved: false,
    ...overrides,
  };
}

function anchoredContext(id: string, content: string, overrides: Partial<ContextSnapshot> = {}) {
  return context(id, `file:///workspace/${id}.ts`, {
    content,
    charCount: content.length,
    sourceAnchor: sourceAnchor(content),
    ...overrides,
  });
}

function sourceAnchor(
  content: string,
  overrides: Partial<NonNullable<ContextSnapshot["sourceAnchor"]>> = {},
) {
  return {
    formatVersion: 1 as const,
    contentSha256: sourceAnchorSha256(content),
    normalizedContentSha256: sourceAnchorSha256(normalizeSourceAnchorContent(content)),
    documentVersion: 3,
    ...overrides,
  };
}

function appState(
  pending?: ContextSnapshot,
  sentA?: ContextSnapshot,
  sentB?: ContextSnapshot,
): AppState {
  const now = "2026-07-31T00:00:00.000Z";
  return {
    activeConversationId: "conversation-a",
    conversations: [
      {
        id: "conversation-a",
        title: "A",
        createdAt: now,
        updatedAt: now,
        messages: sentA
          ? [
              {
                id: "message-a",
                role: "user",
                markdown: "A",
                status: "complete",
                createdAt: now,
                contexts: [sentA],
              },
            ]
          : [],
      },
      {
        id: "conversation-b",
        title: "B",
        createdAt: now,
        updatedAt: now,
        messages: sentB
          ? [
              {
                id: "message-b",
                role: "user",
                markdown: "B",
                status: "complete",
                createdAt: now,
                contexts: [sentB],
              },
            ]
          : [],
      },
    ],
    pendingContexts: pending ? [pending] : [],
    automaticContextIds: [],
    contextLocked: false,
    backend: {
      connected: true,
      authenticated: true,
      activeRuns: 0,
      selectorVersion: 1,
      connection: {
        phase: "ready",
        since: now,
        browserDetected: true,
        hasStoredTrust: true,
      },
    },
    modelPicker: { conversationId: "conversation-a", status: "idle", options: [] },
    locale: "en",
  };
}

function textDocument(content: string) {
  const lines = content.split("\n");
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }
  const positionAt = (target: number) => {
    const bounded = Math.max(0, Math.min(target, content.length));
    let line = 0;
    while (line + 1 < lineOffsets.length && lineOffsets[line + 1]! <= bounded) line += 1;
    return {
      line,
      character: bounded - lineOffsets[line]!,
    };
  };
  return {
    lineCount: lines.length,
    lineAt: (line: number) => ({
      text: lines[line]!,
      range: {
        start: { line, character: 0 },
        end: { line, character: lines[line]!.length },
      },
    }),
    getText: (range?: { start: { line: number; character: number }; end: unknown }) => {
      if (!range) return content;
      const start = lineOffsets[range.start.line]! + range.start.character;
      const end = offsetAt(range.end as { line: number; character: number });
      return content.slice(start, end);
    },
    offsetAt,
    positionAt,
  };

  function offsetAt(position: { line: number; character: number }) {
    return Math.min(
      content.length,
      lineOffsets[position.line]! + Math.min(position.character, lines[position.line]!.length),
    );
  }
}
