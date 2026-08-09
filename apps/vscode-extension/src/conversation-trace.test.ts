import type { ContextSnapshot, Conversation, ConversationMessage } from "@ask2gpt/protocol";
import { describe, expect, it } from "vitest";

import { findConversationTraceMatches, type ConversationTraceMatch } from "./conversation-trace";
import type { NotebookCellReference, SelectionReference } from "./selection-reference";
import { normalizeSourceAnchorContent, sourceAnchorSha256 } from "./source-anchor";
import type { AppState } from "./types";

describe("findConversationTraceMatches", () => {
  it("searches only sent user-message contexts", () => {
    const sent = context("sent", { content: "selected()", startLine: 3, endLine: 3 });
    const ignored = context("ignored", { content: "selected()", startLine: 3, endLine: 3 });
    const conversation = makeConversation("conversation", [
      message("user-message", "user", [sent]),
      message("assistant-message", "assistant", [ignored]),
      message("local-notice", "local-notice", [ignored]),
    ]);
    conversation.queuedFollowUps = [
      {
        id: "queued",
        text: "queued question",
        contexts: [ignored],
        automaticContextIds: [],
        createdAt: "2026-08-09T04:00:00.000Z",
      },
    ];
    const state = makeState([conversation]);
    state.pendingContexts = [ignored];

    const matches = findConversationTraceMatches(
      state,
      selection({ startLine: 2, startCharacter: 0, endLine: 2, endCharacter: 10 }),
      "selected()",
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      matchKind: "exact",
      conversationId: "conversation",
      messageId: "user-message",
      contextId: "sent",
    });
  });

  it("requires the same URI and excludes range-only evidence from direct matches", () => {
    const exact = makeConversation(
      "exact-conversation",
      [message("exact-message", "user", [context("exact")])],
      "2026-08-01T00:00:00.000Z",
    );
    const shiftedContent = makeConversation(
      "shifted-conversation",
      [message("shifted-message", "user", [context("shifted", { startLine: 30, endLine: 30 })])],
      "2026-08-09T00:00:00.000Z",
    );
    const containingFile = makeConversation(
      "file-conversation",
      [
        message("file-message", "user", [
          context("file", {
            kind: "current-file",
            content: "before\nselected()\nafter",
            startLine: 1,
            endLine: 20,
          }),
        ]),
      ],
      "2026-08-09T01:00:00.000Z",
    );
    const rangeOnly = makeConversation(
      "range-conversation",
      [
        message("range-message", "user", [
          context("range", { content: "changed()", startLine: 3, endLine: 3 }),
        ]),
      ],
      "2026-08-09T02:00:00.000Z",
    );
    const wrongUri = makeConversation("wrong-uri-conversation", [
      message("wrong-uri-message", "user", [
        context("wrong-uri", { uri: "file:///repo/copied.ts" }),
      ]),
    ]);

    const matches = findConversationTraceMatches(
      makeState([rangeOnly, wrongUri, containingFile, shiftedContent, exact]),
      selection({ startLine: 2, startCharacter: 0, endLine: 2, endCharacter: 10 }),
      "selected()",
    );

    expect(matches.map(summary)).toEqual([
      ["exact", "exact", "exact"],
      ["shifted", "content", "exact"],
      ["file", "content-and-range", "context-contains-selection"],
    ]);
    expect(matches.every((match) => match.contextId !== "wrong-uri")).toBe(true);
    expect(matches.every((match) => match.contextId !== "range")).toBe(true);
    expect(matches.every((match) => match.directNavigation)).toBe(true);
    expect(matches.map((match) => match.confidence)).toEqual([
      "exact",
      "content-backed",
      "content-backed",
    ]);
  });

  it("does not match a replaced selection from URI and line overlap alone", () => {
    const state = makeState([
      makeConversation("replaced", [
        message("replaced-message", "user", [
          context("replaced-context", {
            content: "oldImplementation()",
            startLine: 3,
            endLine: 3,
          }),
        ]),
      ]),
    ]);

    expect(
      findConversationTraceMatches(
        state,
        selection({ startLine: 2, startCharacter: 0, endLine: 2, endCharacter: 19 }),
        "newImplementation()",
      ),
    ).toEqual([]);
  });

  it("does not treat repeated containment as unique content evidence", () => {
    const state = makeState([
      makeConversation("repeated", [
        message("repeated-message", "user", [
          context("repeated-context", {
            kind: "current-file",
            content: "selected()\nbetween\nselected()",
            startLine: 1,
            endLine: 5,
          }),
        ]),
      ]),
    ]);

    expect(
      findConversationTraceMatches(
        state,
        selection({ startLine: 2, startCharacter: 0, endLine: 2, endCharacter: 10 }),
        "selected()",
      ),
    ).toEqual([]);
  });

  it("keeps uniquely moved exact content as a content-backed direct match", () => {
    const state = makeState([
      makeConversation("moved", [
        message("moved-message", "user", [
          context("moved-context", {
            content: "selected()",
            startLine: 30,
            endLine: 30,
          }),
        ]),
      ]),
    ]);

    expect(
      findConversationTraceMatches(
        state,
        selection({ startLine: 2, startCharacter: 0, endLine: 2, endCharacter: 10 }),
        "selected()",
      ),
    ).toEqual([
      expect.objectContaining({
        confidence: "content-backed",
        directNavigation: true,
        contextId: "moved-context",
        matchKind: "content",
      }),
    ]);
  });

  it("uses ContextService's inclusive line convention for selections ending at column zero", () => {
    const state = makeState([
      makeConversation("conversation", [
        message("message", "user", [
          context("two-lines", {
            content: "first line\nsecond line\n",
            startLine: 1,
            endLine: 2,
          }),
        ]),
      ]),
    ]);

    const matches = findConversationTraceMatches(
      state,
      selection({ startLine: 0, startCharacter: 0, endLine: 2, endCharacter: 0 }),
      "first line\nsecond line\n",
    );

    expect(matches[0]).toMatchObject({
      matchKind: "exact",
      exactRange: true,
      contextStartLine: 1,
      contextEndLine: 2,
      overlapStartLine: 1,
      overlapEndLine: 2,
    });
  });

  it("orders equal-quality matches newest-first with deterministic ID tie-breakers", () => {
    const conversations = [
      makeConversation("z-conversation", [
        message("z-message", "user", [context("z-context")], "2026-08-08T12:00:00.000Z"),
      ]),
      makeConversation("newest-conversation", [
        message("newest-message", "user", [context("newest-context")], "2026-08-09T12:00:00.000Z"),
      ]),
      makeConversation("a-conversation", [
        message("a-message", "user", [context("a-context")], "2026-08-08T12:00:00.000Z"),
      ]),
    ];

    const find = (items: Conversation[]) =>
      findConversationTraceMatches(
        makeState(items),
        selection({ startLine: 2, startCharacter: 0, endLine: 2, endCharacter: 10 }),
        "selected()",
      ).map((match) => match.conversationId);

    expect(find(conversations)).toEqual([
      "newest-conversation",
      "a-conversation",
      "z-conversation",
    ]);
    expect(find([...conversations].reverse())).toEqual(find(conversations));
  });

  it("keeps archived matches as metadata", () => {
    const archived = makeConversation("archived", [
      message("message", "user", [context("context")]),
    ]);
    archived.archivedAt = "2026-08-09T15:00:00.000Z";
    const state = makeState([archived]);
    const reference = selection({
      startLine: 2,
      startCharacter: 0,
      endLine: 2,
      endCharacter: 10,
    });

    expect(findConversationTraceMatches(state, reference, "selected()")[0]).toMatchObject({
      conversationArchivedAt: "2026-08-09T15:00:00.000Z",
      contextUnsaved: false,
      messageMarkdown: "Question from message",
    });
  });

  it("returns no matches for empty content or a collapsed editor selection", () => {
    const state = makeState([
      makeConversation("conversation", [message("message", "user", [context("context")])]),
    ]);
    const reference = selection({
      startLine: 2,
      startCharacter: 0,
      endLine: 2,
      endCharacter: 10,
    });

    expect(findConversationTraceMatches(state, reference, "")).toEqual([]);
    expect(
      findConversationTraceMatches(
        state,
        { ...reference, endLine: reference.startLine, endCharacter: reference.startCharacter },
        "selected()",
      ),
    ).toEqual([]);
  });

  it("matches a notebook turn from container, cell fingerprint, range, and content evidence", () => {
    const notebook = notebookContext("notebook-context", "selected()", {
      cellIndex: 4,
      notebookVersion: 7,
    });
    const state = makeState([
      makeConversation("notebook", [message("notebook-message", "user", [notebook])]),
    ]);

    const matches = findConversationTraceMatches(
      state,
      notebookReference("selected()", { cellIndex: 4, notebookVersion: 7 }),
      "selected()",
    );

    expect(matches).toEqual([
      expect.objectContaining({
        confidence: "exact",
        contextId: "notebook-context",
        matchKind: "exact",
      }),
    ]);
  });

  it("matches an unchanged single cell at the same index after the notebook version changes", () => {
    const notebook = notebookContext("captured", "selected()", {
      cellIndex: 0,
      notebookVersion: 3,
    });
    const state = makeState([
      makeConversation("notebook", [message("notebook-message", "user", [notebook])]),
    ]);

    expect(
      findConversationTraceMatches(
        state,
        notebookReference("selected()", { cellIndex: 0, notebookVersion: 8 }),
        "selected()",
      ),
    ).toEqual([expect.objectContaining({ contextId: "captured", matchKind: "exact" })]);
  });

  it("fails closed at a stable index when capture-time neighbor evidence changed", () => {
    const notebook = notebookContext("captured", "selected()", {
      beforeCellSha256: sourceAnchorSha256("captured-before"),
      cellIndex: 2,
      notebookVersion: 3,
    });
    const state = makeState([
      makeConversation("notebook", [message("notebook-message", "user", [notebook])]),
    ]);

    expect(
      findConversationTraceMatches(
        state,
        notebookReference("selected()", {
          beforeCellSha256: sourceAnchorSha256("replacement-before"),
          cellIndex: 2,
          notebookVersion: 8,
        }),
        "selected()",
      ),
    ).toEqual([]);
  });

  it("fails closed when equal source moved without capture-time neighbor evidence", () => {
    const notebook = notebookContext("captured", "selected()", {
      cellIndex: 1,
      notebookVersion: 3,
    });
    const state = makeState([
      makeConversation("notebook", [message("notebook-message", "user", [notebook])]),
    ]);

    expect(
      findConversationTraceMatches(
        state,
        notebookReference("selected()", { cellIndex: 4, notebookVersion: 8 }),
        "selected()",
      ),
    ).toEqual([]);
  });

  it("does not confuse another same-source cell after notebook structure changes", () => {
    const notebook = notebookContext("captured", "selected()", {
      beforeCellSha256: sourceAnchorSha256("captured-before"),
      afterCellSha256: sourceAnchorSha256("captured-after"),
      cellIndex: 2,
      notebookVersion: 3,
    });
    const state = makeState([
      makeConversation("notebook", [message("notebook-message", "user", [notebook])]),
    ]);

    expect(
      findConversationTraceMatches(
        state,
        notebookReference("selected()", {
          beforeCellSha256: sourceAnchorSha256("different-before"),
          afterCellSha256: sourceAnchorSha256("captured-after"),
          cellIndex: 5,
          notebookVersion: 8,
        }),
        "selected()",
      ),
    ).toEqual([]);

    expect(
      findConversationTraceMatches(
        state,
        notebookReference("selected()", {
          beforeCellSha256: sourceAnchorSha256("captured-before"),
          afterCellSha256: sourceAnchorSha256("captured-after"),
          cellIndex: 5,
          notebookVersion: 8,
        }),
        "selected()",
      ),
    ).toEqual([expect.objectContaining({ contextId: "captured" })]);
  });

  it("does not let a plain text-document reference address notebook context", () => {
    const notebook = notebookContext("captured", "selected()");
    const state = makeState([
      makeConversation("notebook", [message("notebook-message", "user", [notebook])]),
    ]);

    expect(
      findConversationTraceMatches(
        state,
        selection({ uri: "file:///repo/analysis.ipynb" }),
        "selected()",
      ),
    ).toEqual([]);
  });
});

function summary(match: ConversationTraceMatch) {
  return [match.contextId, match.matchKind, match.contentMatch];
}

function selection(overrides: Partial<SelectionReference> = {}): SelectionReference {
  return {
    uri: "file:///repo/source.ts",
    documentVersion: 1,
    startLine: 2,
    startCharacter: 0,
    endLine: 2,
    endCharacter: 10,
    ...overrides,
  };
}

function notebookReference(
  cellContent: string,
  overrides: Partial<NotebookCellReference> = {},
): NotebookCellReference {
  return {
    type: "notebook-cell",
    notebookUri: "file:///repo/analysis.ipynb",
    notebookType: "jupyter-notebook",
    notebookVersion: 1,
    cellUri: "vscode-notebook-cell:///repo/analysis.ipynb#cell-1",
    cellIndex: 1,
    cellKind: "code",
    cellLanguage: "python",
    cellDocumentVersion: 1,
    cellContentSha256: sourceAnchorSha256(cellContent),
    normalizedCellContentSha256: sourceAnchorSha256(normalizeSourceAnchorContent(cellContent)),
    scope: "range",
    startLine: 2,
    startCharacter: 0,
    endLine: 2,
    endCharacter: 10,
    ...overrides,
  };
}

function context(id: string, overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    id,
    kind: "selection",
    fileName: "source.ts",
    uri: "file:///repo/source.ts",
    language: "typescript",
    startLine: 3,
    endLine: 3,
    content: "selected()",
    charCount: 10,
    unsaved: false,
    ...overrides,
  };
}

function notebookContext(
  id: string,
  content: string,
  anchorOverrides: Partial<Extract<ContextSnapshot["sourceAnchor"], { formatVersion: 2 }>> = {},
): ContextSnapshot {
  const cellContent = content;
  return {
    id,
    kind: "selection",
    fileName: "analysis.ipynb",
    uri: "file:///repo/analysis.ipynb",
    language: "python",
    startLine: 3,
    endLine: 3,
    content,
    charCount: content.length,
    unsaved: false,
    sourceAnchor: {
      formatVersion: 2,
      notebookUri: "file:///repo/analysis.ipynb",
      notebookType: "jupyter-notebook",
      notebookVersion: 1,
      cellIndex: 1,
      cellKind: "code",
      cellLanguage: "python",
      scope: "range",
      documentVersion: 1,
      range: { startLine: 2, startCharacter: 0, endLine: 2, endCharacter: 10 },
      contentSha256: sourceAnchorSha256(content),
      normalizedContentSha256: sourceAnchorSha256(normalizeSourceAnchorContent(content)),
      cellContentSha256: sourceAnchorSha256(cellContent),
      normalizedCellContentSha256: sourceAnchorSha256(normalizeSourceAnchorContent(cellContent)),
      ...anchorOverrides,
    },
  };
}

function message(
  id: string,
  role: ConversationMessage["role"],
  contexts: ContextSnapshot[],
  createdAt = "2026-08-08T12:00:00.000Z",
): ConversationMessage {
  return {
    id,
    role,
    markdown: `Question from ${id}`,
    status: "complete",
    createdAt,
    contexts,
  };
}

function makeConversation(
  id: string,
  messages: ConversationMessage[],
  updatedAt = "2026-08-08T12:00:00.000Z",
): Conversation {
  return {
    id,
    title: `Conversation ${id}`,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt,
    messages,
  };
}

function makeState(conversations: Conversation[]): AppState {
  return {
    activeConversationId: conversations[0]?.id ?? "empty",
    conversations,
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
    modelPicker: {
      conversationId: conversations[0]?.id ?? "empty",
      status: "idle",
      options: [],
    },
    locale: "en",
  };
}
