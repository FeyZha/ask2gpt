import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
  documents: new Map<string, unknown>(),
  editors: [] as Array<{ selection?: unknown; revealRange: ReturnType<typeof vi.fn> }>,
  executeCommand: vi.fn(),
  openTextDocument: vi.fn(),
  showQuickPick: vi.fn(),
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

  const parseUri = (value: string) => {
    const scheme = /^([A-Za-z][A-Za-z\d+.-]*):/u.exec(value)?.[1]?.toLowerCase();
    if (!scheme) throw new Error("Invalid URI");
    const path =
      scheme === "file"
        ? value.replace(/^file:\/\//u, "")
        : (/^[A-Za-z][A-Za-z\d+.-]*:\/\/[^/]+(\/.*)$/u.exec(value)?.[1] ??
          value.slice(scheme.length + 1));
    return {
      scheme,
      path,
      fsPath: path,
      toString: () => value,
    };
  };

  return {
    Position,
    Range,
    Selection,
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    Uri: { parse: parseUri },
    commands: { executeCommand: vscodeMock.executeCommand },
    window: {
      showQuickPick: vscodeMock.showQuickPick,
      showTextDocument: vscodeMock.showTextDocument,
    },
    workspace: { openTextDocument: vscodeMock.openTextDocument },
  };
});

import type { ContextSnapshot, ConversationMessage } from "@ask2gpt/protocol";
import * as vscode from "vscode";

import { createFindRelatedTurnCommand } from "./find-related-turn-command";
import { openAnswerSourceReferenceFromState, openAnswerSymbolFromState } from "./source-trace";
import type { AppState } from "./types";

describe("answer source trace", () => {
  beforeEach(() => {
    vscodeMock.documents.clear();
    vscodeMock.editors.length = 0;
    vscodeMock.executeCommand.mockReset().mockResolvedValue([]);
    vscodeMock.openTextDocument
      .mockReset()
      .mockImplementation(async (uri: { toString(): string }) => {
        const document = vscodeMock.documents.get(uri.toString());
        if (!document) throw new Error(`Missing test document: ${uri.toString()}`);
        return document;
      });
    vscodeMock.showQuickPick.mockReset().mockImplementation(async (items: unknown[]) => items[0]);
    vscodeMock.showTextDocument.mockReset().mockImplementation(async () => {
      const editor = { selection: undefined, revealRange: vi.fn() };
      vscodeMock.editors.push(editor);
      return editor;
    });
  });

  it("opens only an exact reference present in the authoritative assistant message", async () => {
    const attached = sourceContext({
      fileName: "src/06_vector_store.py",
      uri: "file:///workspace/src/06_vector_store.py",
      startLine: 34,
      endLine: 39,
      content: sixLines(),
    });
    registerDocument(attached.uri, numberedDocumentWithSnapshot(50, 34, attached.content));
    const state = appState([
      userMessage("question", [attached]),
      assistantMessage("answer", "See 06_vector_store.py:34-35 for the setup."),
    ]);

    await openAnswerSourceReferenceFromState(
      state,
      "conversation-a",
      "answer",
      "06_vector_store.py:34-35",
    );

    expect(vscodeMock.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/workspace/src/06_vector_store.py" }),
    );
    expect(lastEditor().selection).toMatchObject({
      start: { line: 33, character: 0 },
      end: { line: 34, character: "selected 2".length },
    });
    expect(lastEditor().revealRange).toHaveBeenCalledWith(lastEditor().selection, 2);

    const openedRange = lastEditor().selection as vscode.Range;
    const revealTurn = vi.fn(async () => undefined);
    await createFindRelatedTurnCommand({
      getActiveSelection: () => ({
        reference: {
          uri: attached.uri,
          documentVersion: 1,
          startLine: openedRange.start.line,
          startCharacter: openedRange.start.character,
          endLine: openedRange.end.line,
          endCharacter: openedRange.end.character,
        },
        selectedContent: sixLines().split("\n").slice(0, 2).join("\n"),
      }),
      getState: () => state,
      isZh: () => false,
      showWarningMessage: vi.fn(),
      showInformationMessage: vi.fn(async () => undefined),
      showQuickPick: vi.fn(async () => undefined),
      attachSelectionAndOpen: vi.fn(async () => undefined),
      selectConversation: vi.fn(async () => undefined),
      unarchiveConversation: vi.fn(async () => undefined),
      revealTurn,
    })();
    expect(revealTurn).toHaveBeenCalledWith("conversation-a", "question", attached.id);

    await expect(
      openAnswerSourceReferenceFromState(
        state,
        "conversation-a",
        "answer",
        "06_vector_store.py:36",
      ),
    ).rejects.toMatchObject({ code: "SOURCE_REFERENCE_STALE" });
    expect(vscodeMock.openTextDocument).toHaveBeenCalledTimes(1);
  });

  it("translates attachment-relative lines and preserves original-context line numbers", async () => {
    const attached = sourceContext({
      fileName: "src/06_vector_store.py",
      uri: "file:///workspace/src/06_vector_store.py",
      startLine: 34,
      endLine: 39,
      content: sixLines(),
    });
    registerDocument(attached.uri, numberedDocumentWithSnapshot(50, 34, attached.content));
    const alias = "06_vector_store.L34-L39.py";
    const state = appState([
      userMessage("question", [attached]),
      assistantMessage(
        "answer",
        `Relative ${alias}:2-3; absolute ${alias}:35-36; original src/06_vector_store.py:34.`,
      ),
    ]);

    await openAnswerSourceReferenceFromState(state, "conversation-a", "answer", `${alias}:2-3`);
    expect(lastEditor().selection).toMatchObject({ start: { line: 34 }, end: { line: 35 } });

    await openAnswerSourceReferenceFromState(state, "conversation-a", "answer", `${alias}:35-36`);
    expect(lastEditor().selection).toMatchObject({ start: { line: 34 }, end: { line: 35 } });

    await openAnswerSourceReferenceFromState(
      state,
      "conversation-a",
      "answer",
      "src/06_vector_store.py:34",
    );
    expect(lastEditor().selection).toMatchObject({ start: { line: 33 }, end: { line: 33 } });
  });

  it("relocates file-line references only when the attached selection snapshot is unique", async () => {
    const attached = sourceContext({
      fileName: "move.ts",
      uri: "file:///workspace/move.ts",
      startLine: 10,
      endLine: 11,
      content: "alpha\nbeta",
    });
    registerDocument(attached.uri, "header\nother\nalpha\nbeta\ntail");
    const state = appState([
      userMessage("question", [attached]),
      assistantMessage("answer", "See move.ts:11."),
    ]);

    await openAnswerSourceReferenceFromState(state, "conversation-a", "answer", "move.ts:11");

    expect(lastEditor().selection).toMatchObject({
      start: { line: 3, character: 0 },
      end: { line: 3, character: 4 },
    });
  });

  it.each([
    ["missing", "header\ntail", "SOURCE_LINE_STALE"],
    ["ambiguous", "alpha\nbeta\nalpha\nbeta", "SOURCE_LINE_AMBIGUOUS"],
  ])(
    "rejects a %s selection snapshot instead of opening its old line",
    async (_case, live, code) => {
      const attached = sourceContext({
        fileName: "stale.ts",
        uri: "file:///workspace/stale.ts",
        startLine: 1,
        endLine: 2,
        content: "alpha\nbeta",
      });
      registerDocument(attached.uri, live);
      const state = appState([
        userMessage("question", [attached]),
        assistantMessage("answer", "See stale.ts:1."),
      ]);

      await expect(
        openAnswerSourceReferenceFromState(state, "conversation-a", "answer", "stale.ts:1"),
      ).rejects.toMatchObject({ code });
      expect(vscodeMock.showTextDocument).not.toHaveBeenCalled();
    },
  );

  it("rejects a stale whole-file line reference even when the old line number still exists", async () => {
    const attached = sourceContext({
      kind: "current-file",
      fileName: "changed.ts",
      uri: "file:///workspace/changed.ts",
      startLine: 1,
      endLine: 3,
      content: "one\ntwo\nthree",
    });
    registerDocument(attached.uri, "one\nreplaced\nthree");
    const state = appState([
      userMessage("question", [attached]),
      assistantMessage("answer", "See changed.ts:2."),
    ]);

    await expect(
      openAnswerSourceReferenceFromState(state, "conversation-a", "answer", "changed.ts:2"),
    ).rejects.toMatchObject({ code: "SOURCE_LINE_STALE" });
    expect(vscodeMock.showTextDocument).not.toHaveBeenCalled();
  });

  it("relocates a whole-file line reference after a unique external insertion", async () => {
    const attached = sourceContext({
      kind: "current-file",
      fileName: "moved.ts",
      uri: "file:///workspace/moved.ts",
      startLine: 1,
      endLine: 2,
      content: "one\ntwo",
    });
    registerDocument(attached.uri, "header\none\ntwo");
    const state = appState([
      userMessage("question", [attached]),
      assistantMessage("answer", "See moved.ts:2."),
    ]);

    await openAnswerSourceReferenceFromState(state, "conversation-a", "answer", "moved.ts:2");

    expect(lastEditor().selection).toMatchObject({
      start: { line: 2, character: 0 },
      end: { line: 2, character: 3 },
    });
  });

  it("uses QuickPick when old context evidence leaves a basename ambiguous", async () => {
    const first = sourceContext({
      id: "first",
      kind: "current-file",
      fileName: "src/a.ts",
      uri: "file:///workspace/src/a.ts",
      startLine: 1,
      endLine: 3,
      content: "one\ntwo\nthree",
    });
    const second = sourceContext({
      id: "second",
      kind: "current-file",
      fileName: "tests/a.ts",
      uri: "file:///workspace/tests/a.ts",
      startLine: 1,
      endLine: 3,
      content: "one\ntwo\nthree",
    });
    const padding = Array.from({ length: 7 }, (_, index) =>
      sourceContext({
        id: `padding-${index}`,
        kind: "current-file",
        fileName: `padding-${index}.ts`,
        uri: `file:///workspace/padding-${index}.ts`,
        startLine: 1,
        endLine: 1,
        content: "value",
      }),
    );
    registerDocument(first.uri, "one\ntwo\nthree");
    registerDocument(second.uri, "one\ntwo\nthree");
    vscodeMock.showQuickPick.mockImplementation(async (items: unknown[]) => items[1]);
    const state = appState([
      userMessage("question", [first, second, ...padding]),
      assistantMessage("answer", "Both snapshots contain a.ts:2."),
    ]);

    await openAnswerSourceReferenceFromState(state, "conversation-a", "answer", "a.ts:2");

    expect(vscodeMock.showQuickPick).toHaveBeenCalledOnce();
    expect(vscodeMock.showQuickPick.mock.calls[0]?.[0]).toHaveLength(2);
    expect(vscodeMock.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/workspace/tests/a.ts" }),
    );
  });

  it("uses a qualified document-symbol provider result and highlights its definition", async () => {
    const attached = sourceContext({
      fileName: "store.ts",
      uri: "file:///workspace/store.ts",
      startLine: 1,
      endLine: 4,
      content: "class Store {\n  value = 1;\n  search() {}\n}",
    });
    registerDocument(attached.uri, attached.content);
    vscodeMock.executeCommand.mockResolvedValue([
      {
        name: "search",
        containerName: "Store",
        location: {
          uri: { toString: () => "file:///workspace/evil.ts" },
          range: range(0, 0, 0, 5),
        },
      },
      {
        name: "Store",
        selectionRange: range(0, 6, 0, 11),
        children: [{ name: "search", selectionRange: range(2, 2, 2, 8), children: [] }],
      },
    ]);
    const state = appState([
      userMessage("question", [attached]),
      assistantMessage("answer", "Call `Store.search()` here."),
    ]);

    await openAnswerSymbolFromState(state, "conversation-a", "answer", "Store.search()");

    expect(vscodeMock.executeCommand).toHaveBeenCalledWith(
      "vscode.executeDocumentSymbolProvider",
      expect.objectContaining({ path: "/workspace/store.ts" }),
    );
    expect(lastEditor().selection).toMatchObject({
      start: { line: 2, character: 2 },
      end: { line: 2, character: 8 },
    });
  });

  it("rejects a symbol in a changed whole-file snapshot before consulting a provider", async () => {
    const attached = sourceContext({
      kind: "current-file",
      fileName: "changed.ts",
      uri: "file:///workspace/changed.ts",
      startLine: 1,
      endLine: 2,
      content: "function compute() { return 1; }\ncompute();",
    });
    registerDocument(attached.uri, "function compute() { return 2; }\ncompute();");
    vscodeMock.executeCommand.mockResolvedValue([
      { name: "compute", selectionRange: range(0, 9, 0, 16), children: [] },
    ]);
    const state = appState([
      userMessage("question", [attached]),
      assistantMessage("answer", "Call `compute()` here."),
    ]);

    await expect(
      openAnswerSymbolFromState(state, "conversation-a", "answer", "compute()"),
    ).rejects.toMatchObject({ code: "SOURCE_LINE_STALE" });
    expect(vscodeMock.executeCommand).not.toHaveBeenCalled();
    expect(vscodeMock.showTextDocument).not.toHaveBeenCalled();
  });

  it("relocates an attached definition snapshot when no symbol provider is available", async () => {
    const attached = sourceContext({
      fileName: "worker.py",
      uri: "file:///workspace/worker.py",
      startLine: 20,
      endLine: 21,
      content: "def compute(value):\n    return value",
    });
    registerDocument(attached.uri, "header\nother\ndef compute(value):\n    return value\ntail");
    vscodeMock.executeCommand.mockRejectedValue(new Error("No language provider"));
    const state = appState([
      userMessage("question", [attached]),
      assistantMessage("answer", "The work happens in `compute()`."),
    ]);

    await openAnswerSymbolFromState(state, "conversation-a", "answer", "compute()");

    expect(lastEditor().selection).toMatchObject({
      start: { line: 2, character: 4 },
      end: { line: 2, character: 11 },
    });
  });

  it("does not accept a symbol-provider definition outside the attached selection evidence", async () => {
    const attached = sourceContext({
      fileName: "worker.py",
      uri: "file:///workspace/worker.py",
      startLine: 20,
      endLine: 20,
      content: "result = compute(value)",
    });
    registerDocument(attached.uri, "def compute(value): pass\nother\nresult = compute(value)");
    vscodeMock.executeCommand.mockResolvedValue([
      {
        name: "compute",
        containerName: "",
        location: {
          uri: { toString: () => attached.uri },
          range: range(0, 4, 0, 11),
        },
      },
    ]);
    const state = appState([
      userMessage("question", [attached]),
      assistantMessage("answer", "The call is `compute()` here."),
    ]);

    await expect(
      openAnswerSymbolFromState(state, "conversation-a", "answer", "compute()"),
    ).rejects.toMatchObject({ code: "SOURCE_SYMBOL_NOT_FOUND" });
    expect(vscodeMock.showTextDocument).not.toHaveBeenCalled();
  });

  it("offers a QuickPick when the same symbol has multiple attached definitions", async () => {
    const first = sourceContext({
      id: "first-symbol",
      fileName: "first.py",
      uri: "file:///workspace/first.py",
      startLine: 1,
      endLine: 1,
      content: "def compute(): pass",
    });
    const second = sourceContext({
      id: "second-symbol",
      fileName: "second.py",
      uri: "file:///workspace/second.py",
      startLine: 1,
      endLine: 1,
      content: "def compute(): pass",
    });
    registerDocument(first.uri, first.content);
    registerDocument(second.uri, second.content);
    vscodeMock.showQuickPick.mockImplementation(async (items: unknown[]) => items[1]);
    const state = appState([
      userMessage("question", [first, second]),
      assistantMessage("answer", "Both paths expose `compute()`."),
    ]);

    await openAnswerSymbolFromState(state, "conversation-a", "answer", "compute()");

    expect(vscodeMock.showQuickPick).toHaveBeenCalledOnce();
    expect(vscodeMock.showQuickPick.mock.calls[0]?.[0]).toHaveLength(2);
    expect(vscodeMock.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/workspace/second.py" }),
    );
  });

  it("rejects references outside the exact attached line evidence", async () => {
    const attached = sourceContext({
      fileName: "a.ts",
      uri: "file:///workspace/a.ts",
      startLine: 10,
      endLine: 12,
      content: "one\ntwo\nthree",
    });
    const alias = "a.L10-L12.ts";
    const state = appState([
      userMessage("question", [attached]),
      assistantMessage("answer", `Invented ${alias}:9 and a.ts:1.`),
    ]);

    await expect(
      openAnswerSourceReferenceFromState(state, "conversation-a", "answer", `${alias}:9`),
    ).rejects.toMatchObject({ code: "SOURCE_REFERENCE_NOT_FOUND" });
    await expect(
      openAnswerSourceReferenceFromState(state, "conversation-a", "answer", "a.ts:1"),
    ).rejects.toMatchObject({ code: "SOURCE_REFERENCE_NOT_FOUND" });
    expect(vscodeMock.openTextDocument).not.toHaveBeenCalled();
  });

  it("rejects cross-message, cross-conversation, and post-answer context spoofing", async () => {
    const attached = sourceContext({ fileName: "safe.ts", startLine: 1, endLine: 3 });
    const state = appState([
      assistantMessage("answer", "See safe.ts:2 and `safeFn()`."),
      userMessage("later", [attached]),
      assistantMessage("other-answer", "See other.ts:2."),
    ]);

    await expect(
      openAnswerSourceReferenceFromState(state, "conversation-a", "answer", "other.ts:2"),
    ).rejects.toMatchObject({ code: "SOURCE_REFERENCE_STALE" });
    await expect(
      openAnswerSourceReferenceFromState(state, "conversation-a", "answer", "safe.ts:2"),
    ).rejects.toMatchObject({ code: "SOURCE_REFERENCE_NOT_FOUND" });
    await expect(
      openAnswerSourceReferenceFromState(state, "conversation-b", "answer", "safe.ts:2"),
    ).rejects.toMatchObject({ code: "SOURCE_MESSAGE_NOT_FOUND" });
    await expect(
      openAnswerSymbolFromState(state, "conversation-a", "answer", "forgedFn()"),
    ).rejects.toMatchObject({ code: "SOURCE_SYMBOL_STALE" });
    expect(vscodeMock.openTextDocument).not.toHaveBeenCalled();
  });

  it("binds an answer only to the nearest preceding user turn", async () => {
    const older = sourceContext({
      kind: "current-file",
      fileName: "older.ts",
      uri: "file:///workspace/older.ts",
      startLine: 1,
      endLine: 1,
      content: "function olderFn() {}",
    });
    const state = appState([
      userMessage("older-question", [older]),
      assistantMessage("older-answer", "Earlier reply."),
      userMessage("nearest-question", []),
      assistantMessage("answer", "See older.ts:1 and `olderFn()`."),
    ]);

    await expect(
      openAnswerSourceReferenceFromState(state, "conversation-a", "answer", "older.ts:1"),
    ).rejects.toMatchObject({ code: "SOURCE_REFERENCE_NOT_FOUND" });
    await expect(
      openAnswerSymbolFromState(state, "conversation-a", "answer", "olderFn()"),
    ).rejects.toMatchObject({ code: "SOURCE_SYMBOL_NOT_FOUND" });
    expect(vscodeMock.openTextDocument).not.toHaveBeenCalled();
  });

  it("refuses a forged non-editor URI even when the answer and filename match", async () => {
    const attached = sourceContext({
      kind: "current-file",
      fileName: "safe.ts",
      uri: "https://evil.example/safe.ts",
      startLine: 1,
      endLine: 2,
      content: "const safe = 1;\nsafe;",
    });
    const state = appState([
      userMessage("question", [attached]),
      assistantMessage("answer", "See safe.ts:2."),
    ]);

    await expect(
      openAnswerSourceReferenceFromState(state, "conversation-a", "answer", "safe.ts:2"),
    ).rejects.toMatchObject({ code: "SOURCE_CONTEXT_UNTRUSTED" });
    expect(vscodeMock.openTextDocument).not.toHaveBeenCalled();
  });

  it("refuses host evidence whose URI basename does not match its captured filename", async () => {
    const attached = sourceContext({
      kind: "current-file",
      fileName: "safe.ts",
      uri: "file:///workspace/different.ts",
      startLine: 1,
      endLine: 2,
      content: "const safe = 1;\nsafe;",
    });
    const state = appState([
      userMessage("question", [attached]),
      assistantMessage("answer", "See safe.ts:2."),
    ]);

    await expect(
      openAnswerSourceReferenceFromState(state, "conversation-a", "answer", "safe.ts:2"),
    ).rejects.toMatchObject({ code: "SOURCE_CONTEXT_UNTRUSTED" });
    expect(vscodeMock.openTextDocument).not.toHaveBeenCalled();
  });
});

function sourceContext(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  const content = overrides.content ?? "const safeFn = () => 1;\nsafeFn();\n";
  return {
    id: "context-a",
    kind: "selection",
    fileName: "safe.ts",
    uri: "file:///workspace/safe.ts",
    language: "typescript",
    startLine: 1,
    endLine: 3,
    content,
    charCount: content.length,
    unsaved: false,
    ...overrides,
  };
}

function userMessage(id: string, contexts: ContextSnapshot[]): ConversationMessage {
  return {
    id,
    role: "user",
    markdown: "Question",
    status: "complete",
    createdAt: "2026-08-09T00:00:00.000Z",
    contexts,
    contextTransportVersion: 2,
  };
}

function assistantMessage(id: string, markdown: string): ConversationMessage {
  return {
    id,
    role: "assistant",
    markdown,
    status: "complete",
    createdAt: "2026-08-09T00:00:01.000Z",
  };
}

function appState(messages: ConversationMessage[]): AppState {
  const now = "2026-08-09T00:00:00.000Z";
  return {
    activeConversationId: "conversation-a",
    conversations: [
      {
        id: "conversation-a",
        title: "A",
        createdAt: now,
        updatedAt: now,
        messages,
      },
      {
        id: "conversation-b",
        title: "B",
        createdAt: now,
        updatedAt: now,
        messages: [],
      },
    ],
    pendingContexts: [],
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

function registerDocument(uri: string, content: string) {
  vscodeMock.documents.set(uri, textDocument(content));
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
    return new vscode.Position(line, bounded - lineOffsets[line]!);
  };
  return {
    lineCount: lines.length,
    lineAt: (line: number) => ({
      text: lines[line]!,
      range: range(line, 0, line, lines[line]!.length),
    }),
    getText: () => content,
    positionAt,
  };
}

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return new vscode.Range(
    new vscode.Position(startLine, startCharacter),
    new vscode.Position(endLine, endCharacter),
  );
}

function numberedDocumentWithSnapshot(lineCount: number, startLine: number, snapshot: string) {
  const lines = Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`);
  for (const [index, line] of snapshot.split("\n").entries()) {
    lines[startLine - 1 + index] = line;
  }
  return lines.join("\n");
}

function sixLines() {
  return Array.from({ length: 6 }, (_, index) => `selected ${index + 1}`).join("\n");
}

function lastEditor() {
  return vscodeMock.editors.at(-1)!;
}
