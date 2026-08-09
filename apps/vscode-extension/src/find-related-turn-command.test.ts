import type { ContextSnapshot, Conversation } from "@ask2gpt/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  createFindRelatedTurnCommand,
  type ActiveTraceSelection,
  type FindRelatedTurnCommandDependencies,
} from "./find-related-turn-command";
import type { NotebookCellReference, SelectionReference } from "./selection-reference";
import { normalizeSourceAnchorContent, sourceAnchorSha256 } from "./source-anchor";

const selectedContent = "const value = 1;";
const selection: SelectionReference = {
  uri: "file:///workspace/source.ts",
  documentVersion: 1,
  startLine: 0,
  startCharacter: 0,
  endLine: 0,
  endCharacter: selectedContent.length,
};

describe("createFindRelatedTurnCommand", () => {
  it("asks for an editor selection before searching history", async () => {
    const deps = dependencies([], null);

    await createFindRelatedTurnCommand(deps)();

    expect(deps.showWarningMessage).toHaveBeenCalledWith("Select code in the editor first.");
    expect(deps.showInformationMessage).not.toHaveBeenCalled();
    expect(deps.revealTurn).not.toHaveBeenCalled();
  });

  it("offers to attach an unmatched selection without inventing a trace", async () => {
    const deps = dependencies([]);
    deps.showInformationMessage.mockResolvedValue("Ask about this selection");

    await createFindRelatedTurnCommand(deps)();

    expect(deps.attachSelectionAndOpen).toHaveBeenCalledWith(selection);
    expect(deps.selectConversation).not.toHaveBeenCalled();
    expect(deps.revealTurn).not.toHaveBeenCalled();
  });

  it("opens the sole content-backed sent turn directly", async () => {
    const conversation = makeConversation("conversation-1");
    const restoreFocus = vi.fn(async () => undefined);
    const deps = dependencies([conversation], {
      reference: selection,
      selectedContent,
      restoreFocus,
    });

    await createFindRelatedTurnCommand(deps)();

    expect(deps.showQuickPick).not.toHaveBeenCalled();
    expect(deps.selectConversation).toHaveBeenCalledWith(conversation.id);
    expect(deps.revealTurn).toHaveBeenCalledWith(
      conversation.id,
      "question-conversation-1",
      "context-conversation-1",
    );
    expect(restoreFocus).toHaveBeenCalledOnce();
  });

  it("uses Quick Pick for multiple turns and respects cancellation", async () => {
    const deps = dependencies([
      makeConversation("conversation-1", "2026-08-09T00:00:00.000Z"),
      makeConversation("conversation-2", "2026-08-09T00:00:01.000Z"),
    ]);

    await createFindRelatedTurnCommand(deps)();

    expect(deps.showQuickPick).toHaveBeenCalledTimes(1);
    expect(deps.selectConversation).not.toHaveBeenCalled();
    expect(deps.revealTurn).not.toHaveBeenCalled();
  });

  it("opens the exact turn selected from a newest-first Quick Pick", async () => {
    const older = makeConversation("conversation-1", "2026-08-09T00:00:00.000Z");
    const newer = makeConversation("conversation-2", "2026-08-09T00:00:01.000Z");
    const deps = dependencies([older, newer]);
    deps.showQuickPick.mockImplementation(async (items) => items[1]);

    await createFindRelatedTurnCommand(deps)();

    expect(deps.selectConversation).toHaveBeenCalledWith(older.id);
    expect(deps.revealTurn).toHaveBeenCalledWith(
      older.id,
      "question-conversation-1",
      "context-conversation-1",
    );
  });

  it("requires confirmation before restoring an archived conversation", async () => {
    const archived = makeConversation(
      "conversation-archived",
      "2026-08-09T00:00:00.000Z",
      "2026-08-09T00:01:00.000Z",
    );
    const deps = dependencies([archived]);

    await createFindRelatedTurnCommand(deps)();
    expect(deps.unarchiveConversation).not.toHaveBeenCalled();
    expect(deps.revealTurn).not.toHaveBeenCalled();

    deps.showInformationMessage.mockResolvedValue("Restore and open");
    await createFindRelatedTurnCommand(deps)();

    expect(deps.unarchiveConversation).toHaveBeenCalledWith(archived.id, true);
    expect(deps.selectConversation).not.toHaveBeenCalled();
    expect(deps.revealTurn).toHaveBeenCalledWith(
      archived.id,
      "question-conversation-archived",
      "context-conversation-archived",
    );
  });

  it("keeps equally ranked contexts from the same sent turn distinguishable in Quick Pick", async () => {
    const conversation = makeConversation("conversation-1");
    const first = conversation.messages[0]?.contexts?.[0];
    expect(first).toBeDefined();
    conversation.messages[0]?.contexts?.push({
      ...(first as ContextSnapshot),
      id: "context-duplicate",
    });
    const deps = dependencies([conversation]);
    deps.showQuickPick.mockImplementation(async (items) => items[1]);

    await createFindRelatedTurnCommand(deps)();

    expect(deps.showQuickPick).toHaveBeenCalledTimes(1);
    const items = deps.showQuickPick.mock.calls[0]?.[0];
    expect(items).toHaveLength(2);
    expect(items?.map((item) => item.description)).toEqual([
      "source.ts:L1–1 · Selection · Context 1/2",
      "source.ts:L1–1 · Selection · Context 2/2",
    ]);
    expect(deps.revealTurn).toHaveBeenCalledWith(
      conversation.id,
      "question-conversation-1",
      "context-duplicate",
    );
  });

  it("opens a strictly higher-scoring context from the same sent turn directly", async () => {
    const conversation = makeConversation("conversation-1");
    conversation.messages[0]?.contexts?.push({
      id: "context-lower-confidence",
      kind: "current-file",
      fileName: "source.ts",
      uri: selection.uri,
      language: "typescript",
      startLine: 1,
      endLine: 3,
      content: `function wrapper() {\n  ${selectedContent}\n}`,
      charCount: `function wrapper() {\n  ${selectedContent}\n}`.length,
      unsaved: false,
    });
    const deps = dependencies([conversation]);

    await createFindRelatedTurnCommand(deps)();

    expect(deps.showQuickPick).not.toHaveBeenCalled();
    expect(deps.revealTurn).toHaveBeenCalledWith(
      conversation.id,
      "question-conversation-1",
      "context-conversation-1",
    );
  });

  it("opens the sent turn linked to an active notebook cell range", async () => {
    const reference = notebookReference();
    const conversation = makeNotebookConversation("notebook-conversation", reference);
    const deps = dependencies([conversation], {
      reference,
      selectedContent,
    });

    await createFindRelatedTurnCommand(deps)();

    expect(deps.showQuickPick).not.toHaveBeenCalled();
    expect(deps.revealTurn).toHaveBeenCalledWith(
      conversation.id,
      "question-notebook-conversation",
      "context-notebook-conversation",
    );
  });

  it("forwards the clicked cell-toolbar target to selection capture", async () => {
    const commandTarget = { notebookCell: "host-owned" };
    const deps = dependencies([], null);

    await createFindRelatedTurnCommand(deps)(commandTarget);

    expect(deps.getActiveSelection).toHaveBeenCalledWith(commandTarget);
  });
});

function dependencies(
  conversations: Conversation[],
  activeSelection: ActiveTraceSelection | null = {
    reference: selection,
    selectedContent,
  },
) {
  return {
    getActiveSelection: vi.fn((_commandTarget?: unknown) => activeSelection ?? undefined),
    getState: vi.fn(() => ({ conversations })),
    isZh: vi.fn(() => false),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn<FindRelatedTurnCommandDependencies["showInformationMessage"]>(
      async () => undefined,
    ),
    showQuickPick: vi.fn<FindRelatedTurnCommandDependencies["showQuickPick"]>(
      async () => undefined,
    ),
    attachSelectionAndOpen: vi.fn(async () => undefined),
    selectConversation: vi.fn(async () => undefined),
    unarchiveConversation: vi.fn(async () => undefined),
    revealTurn: vi.fn(async () => undefined),
  } satisfies FindRelatedTurnCommandDependencies;
}

function makeConversation(id: string, createdAt = "2026-08-09T00:00:00.000Z", archivedAt?: string) {
  const context: ContextSnapshot = {
    id: `context-${id}`,
    kind: "selection",
    fileName: "source.ts",
    uri: selection.uri,
    language: "typescript",
    startLine: 1,
    endLine: 1,
    content: selectedContent,
    charCount: selectedContent.length,
    unsaved: false,
  };
  return {
    id,
    title: `Conversation ${id}`,
    createdAt,
    updatedAt: createdAt,
    ...(archivedAt ? { archivedAt } : {}),
    messages: [
      {
        id: `question-${id}`,
        role: "user" as const,
        markdown: "Please review this code.",
        status: "complete" as const,
        createdAt,
        contexts: [context],
      },
    ],
  } satisfies Conversation;
}

function notebookReference(): NotebookCellReference {
  return {
    type: "notebook-cell",
    notebookUri: "file:///workspace/analysis.ipynb",
    notebookType: "jupyter-notebook",
    notebookVersion: 4,
    cellUri: "vscode-notebook-cell:///workspace/analysis.ipynb#cell-2",
    cellIndex: 2,
    cellKind: "code",
    cellLanguage: "typescript",
    cellDocumentVersion: 3,
    cellContentSha256: sourceAnchorSha256(selectedContent),
    normalizedCellContentSha256: sourceAnchorSha256(normalizeSourceAnchorContent(selectedContent)),
    scope: "range",
    startLine: 0,
    startCharacter: 0,
    endLine: 0,
    endCharacter: selectedContent.length,
  };
}

function makeNotebookConversation(id: string, reference: NotebookCellReference): Conversation {
  const createdAt = "2026-08-09T00:00:00.000Z";
  return {
    id,
    title: `Conversation ${id}`,
    createdAt,
    updatedAt: createdAt,
    messages: [
      {
        id: `question-${id}`,
        role: "user",
        markdown: "Please review this cell.",
        status: "complete",
        createdAt,
        contexts: [
          {
            id: `context-${id}`,
            kind: "selection",
            fileName: "analysis.ipynb",
            uri: reference.notebookUri,
            language: reference.cellLanguage,
            startLine: 1,
            endLine: 1,
            content: selectedContent,
            charCount: selectedContent.length,
            unsaved: false,
            sourceAnchor: {
              formatVersion: 2,
              notebookUri: reference.notebookUri,
              notebookType: reference.notebookType,
              notebookVersion: reference.notebookVersion,
              cellIndex: reference.cellIndex,
              cellKind: reference.cellKind,
              cellLanguage: reference.cellLanguage,
              scope: reference.scope,
              documentVersion: reference.cellDocumentVersion,
              range: {
                startLine: reference.startLine,
                startCharacter: reference.startCharacter,
                endLine: reference.endLine,
                endCharacter: reference.endCharacter,
              },
              contentSha256: sourceAnchorSha256(selectedContent),
              normalizedContentSha256: sourceAnchorSha256(
                normalizeSourceAnchorContent(selectedContent),
              ),
              cellContentSha256: reference.cellContentSha256,
              normalizedCellContentSha256: reference.normalizedCellContentSha256,
            },
          },
        ],
      },
    ],
  };
}
