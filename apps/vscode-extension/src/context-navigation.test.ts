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
      parse: (value: string) => ({
        fsPath: value.replace(/^file:\/\//u, ""),
        path: value.replace(/^file:\/\//u, ""),
        toString: () => value,
      }),
    },
    window: { showTextDocument: vscodeMock.showTextDocument },
    workspace: { openTextDocument: vscodeMock.openTextDocument },
  };
});

import type { ContextSnapshot } from "@ask2gpt/protocol";

import { openContextFromState, resolveContextFromState } from "./context-navigation";
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
    ["missing", "not-present", "before\nafter"],
    ["repeated", "same", "same\nsame"],
  ])(
    "falls back to the original line range when selection content is %s",
    async (_case, content, source) => {
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

      await openContextFromState(appState(selected), "conversation-a", "fallback-context");

      expect(editor.selection).toMatchObject({
        start: { line: 1, character: 0 },
        end: { line: 1, character: source.split("\n")[1]!.length },
      });
      expect(editor.revealRange).toHaveBeenCalledWith(editor.selection, 2);
    },
  );

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
      message: "The file changed and the attached line range is no longer available.",
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
      code: "CONTEXT_RANGE_STALE",
      message: "The file changed and the attached line range is no longer available.",
    });
    expect(vscodeMock.showTextDocument).not.toHaveBeenCalled();
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
