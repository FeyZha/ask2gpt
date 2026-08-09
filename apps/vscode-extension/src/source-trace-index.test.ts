import type { ContextSnapshot, Conversation, ConversationMessage } from "@ask2gpt/protocol";
import { describe, expect, it } from "vitest";

import { withSourceTraceHints } from "./source-trace-index";
import { normalizeSourceAnchorContent, sourceAnchorSha256 } from "./source-anchor";
import type { AppState } from "./types";

describe("withSourceTraceHints", () => {
  it("publishes only file references and definitions backed by the nearest user turn", () => {
    const context = makeContext({
      content: "def compute_total():\n    return 42\n\ncompute_total()",
      endLine: 40,
      fileName: "src/total.py",
      startLine: 37,
    });
    const state = makeState([
      user("question", [context]),
      assistant(
        "answer",
        "Use src/total.py:37 and ignore missing.py:9. Then call `compute_total()`.",
      ),
    ]);

    const decorated = withSourceTraceHints(state);

    expect(decorated.sourceTraceHints?.["conversation-1"]?.answer).toEqual({
      fileReferences: ["src/total.py:37"],
      sourceSymbols: ["compute_total"],
    });
    expect(state.sourceTraceHints).toBeUndefined();
  });

  it("accepts the generated selection attachment alias and relative attachment lines", () => {
    const context = makeContext({
      content: "first()\nsecond()\nthird()",
      endLine: 36,
      fileName: "06_vector_store.py",
      startLine: 34,
    });
    const state = makeState([
      user("question", [context]),
      assistant("answer", "See 06_vector_store.L34-L36.py:2."),
    ]);

    expect(
      withSourceTraceHints(state).sourceTraceHints?.["conversation-1"]?.answer?.fileReferences,
    ).toEqual(["06_vector_store.L34-L36.py:2"]);
  });

  it("recognizes a notebook attachment alias as cell-local line evidence", () => {
    const context = makeNotebookContext("first()\nsecond()", {
      cellIndex: 3,
      range: { startLine: 4, startCharacter: 0, endLine: 5, endCharacter: 8 },
    });
    const state = makeState([
      user("question", [context]),
      assistant("answer", "See analysis.cell-004.L5-L6.py:2."),
    ]);

    expect(
      withSourceTraceHints(state).sourceTraceHints?.["conversation-1"]?.answer?.fileReferences,
    ).toEqual(["analysis.cell-004.L5-L6.py:2"]);
  });

  it("does not authorize a trailing attachment line outside the captured selection range", () => {
    const context = makeContext({
      content: "only_selected_line()\n",
      endLine: 34,
      fileName: "single.py",
      startLine: 34,
    });
    const state = makeState([
      user("question", [context]),
      assistant("answer", "See single.L34-L34.py:2."),
    ]);

    expect(
      withSourceTraceHints(state).sourceTraceHints?.["conversation-1"]?.answer,
    ).toBeUndefined();
  });

  it("does not borrow contexts across an intervening user turn", () => {
    const state = makeState([
      user("older", [makeContext()]),
      assistant("older-answer", "See source.ts:1."),
      user("nearest"),
      assistant("answer", "See source.ts:1 and call `known_source()`."),
    ]);

    expect(
      withSourceTraceHints(state).sourceTraceHints?.["conversation-1"]?.answer,
    ).toBeUndefined();
  });

  it("leaves streaming answers undecorated and excludes call-only symbol guesses", () => {
    const callOnly = makeContext({ content: "known_source()", endLine: 1, startLine: 1 });
    const state = makeState([
      user("question", [callOnly]),
      assistant("answer", "Call `known_source()`.", "complete"),
      assistant("streaming", "See source.ts:1", "streaming"),
    ]);

    const hints = withSourceTraceHints(state).sourceTraceHints?.["conversation-1"];
    expect(hints?.answer).toBeUndefined();
    expect(hints?.streaming).toBeUndefined();
  });

  it("replaces stale derived hints instead of carrying them into a newer state", () => {
    const state = makeState([user("question"), assistant("answer", "See source.ts:1.")]);
    state.sourceTraceHints = {
      "conversation-1": {
        answer: { fileReferences: ["stale.ts:99"], sourceSymbols: ["stale"] },
      },
    };

    const decorated = withSourceTraceHints(state);

    expect(decorated.sourceTraceHints).toBeUndefined();
    expect(state.sourceTraceHints?.["conversation-1"]?.answer?.fileReferences).toEqual([
      "stale.ts:99",
    ]);
  });

  it("derives and transports hints only for the active conversation", () => {
    const active = makeState([
      user("active-question", [makeContext()]),
      assistant("active-answer", "See source.ts:1."),
    ]);
    const inactive: Conversation = {
      ...active.conversations[0]!,
      id: "conversation-2",
      messages: [
        user("inactive-question", [makeContext({ id: "context-2" })]),
        assistant("inactive-answer", "See source.ts:1."),
      ],
    };
    active.conversations.push(inactive);

    expect(withSourceTraceHints(active).sourceTraceHints).toEqual({
      "conversation-1": {
        "active-answer": { fileReferences: ["source.ts:1"], sourceSymbols: ["known_source"] },
      },
    });
  });

  it("invalidates an in-place conversation cache entry when the conversation changes", () => {
    const state = makeState([
      user("question", [makeContext()]),
      assistant("answer", "See source.ts:1."),
    ]);
    expect(
      withSourceTraceHints(state).sourceTraceHints?.["conversation-1"]?.answer?.fileReferences,
    ).toEqual(["source.ts:1"]);

    const conversation = state.conversations[0]!;
    conversation.messages[1]!.markdown = "No source reference.";
    conversation.updatedAt = "2026-08-09T00:00:02.000Z";

    expect(withSourceTraceHints(state).sourceTraceHints?.["conversation-1"]?.answer).toEqual({
      fileReferences: [],
      sourceSymbols: ["known_source"],
    });
  });

  it("bounds derived history work to the newest terminal assistant turns", () => {
    const messages: ConversationMessage[] = [];
    for (let index = 0; index < 205; index += 1) {
      messages.push(
        user(`question-${index}`, [
          makeContext({ id: `context-${index}`, content: `function source_${index}() {}` }),
        ]),
        assistant(`answer-${index}`, "See source.ts:1."),
      );
    }

    const hints = withSourceTraceHints(makeState(messages)).sourceTraceHints?.["conversation-1"];
    expect(Object.keys(hints ?? {})).toHaveLength(200);
    expect(hints?.["answer-204"]).toBeDefined();
    expect(hints?.["answer-4"]).toBeUndefined();
  });
});

function makeState(messages: ConversationMessage[]): AppState {
  const conversation: Conversation = {
    id: "conversation-1",
    title: "Trace",
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    messages,
  };
  return {
    activeConversationId: conversation.id,
    conversations: [conversation],
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
        since: "2026-08-09T00:00:00.000Z",
        browserDetected: true,
        hasStoredTrust: true,
      },
    },
    modelPicker: { conversationId: conversation.id, status: "idle", options: [] },
    locale: "en",
  };
}

function makeContext(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    id: "context-1",
    kind: "selection",
    fileName: "source.ts",
    uri: "file:///workspace/source.ts",
    language: "typescript",
    startLine: 1,
    endLine: 2,
    content: "function known_source() {}",
    charCount: overrides.content?.length ?? 26,
    unsaved: false,
    ...overrides,
  };
}

function makeNotebookContext(
  content: string,
  anchorOverrides: Partial<Extract<ContextSnapshot["sourceAnchor"], { formatVersion: 2 }>>,
): ContextSnapshot {
  const range = anchorOverrides.range ?? {
    startLine: 0,
    startCharacter: 0,
    endLine: 0,
    endCharacter: content.length,
  };
  const normalizedHash = sourceAnchorSha256(normalizeSourceAnchorContent(content));
  return {
    id: "notebook-context",
    kind: "selection",
    fileName: "analysis.ipynb",
    uri: "file:///workspace/analysis.ipynb",
    language: "python",
    startLine: range.startLine + 1,
    endLine: range.endLine + 1,
    content,
    charCount: content.length,
    unsaved: false,
    sourceAnchor: {
      formatVersion: 2,
      notebookUri: "file:///workspace/analysis.ipynb",
      notebookType: "jupyter-notebook",
      notebookVersion: 1,
      cellIndex: 0,
      cellKind: "code",
      cellLanguage: "python",
      scope: "range",
      documentVersion: 1,
      range,
      contentSha256: sourceAnchorSha256(content),
      normalizedContentSha256: normalizedHash,
      cellContentSha256: sourceAnchorSha256(content),
      normalizedCellContentSha256: normalizedHash,
      ...anchorOverrides,
    },
  };
}

function user(id: string, contexts?: ContextSnapshot[]): ConversationMessage {
  return {
    id,
    role: "user",
    markdown: "Question",
    status: "complete",
    createdAt: "2026-08-09T00:00:00.000Z",
    ...(contexts ? { contexts } : {}),
  };
}

function assistant(
  id: string,
  markdown: string,
  status: ConversationMessage["status"] = "complete",
): ConversationMessage {
  return {
    id,
    role: "assistant",
    markdown,
    status,
    createdAt: "2026-08-09T00:00:01.000Z",
  };
}
