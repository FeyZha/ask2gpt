import { createHash } from "node:crypto";

import type {
  ChatModelOption,
  ContextSnapshot,
  Conversation,
  ConversationCanonicalizationResultPayload,
  ConversationLeasePurpose,
  ConversationReleaseReason,
  ConversationTranscriptProof,
  PendingRemotePromotion,
  RelayErrorPayload,
} from "@ask2gpt/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  env: { language: "zh-cn" },
  window: { activeTextEditor: undefined },
}));

import { Ask2GPTController } from "./controller";
import type {
  AppState,
  BackendEvent,
  BackendStatus,
  ChatBackend,
  GenerationViewUpdate,
  SendRequest,
} from "./types";
import type { ContextService } from "./services/context-service";
import type { ConversationStore, ConversationStoreLoadReport } from "./services/conversation-store";
import type { SafeLogger } from "./services/logger";
import { buildLegacyVisiblePrompt } from "./services/prompt-builder";
import type { NotebookCellReference, SelectionReference } from "./selection-reference";

const controllers: Ask2GPTController[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(controllers.splice(0).map(async (controller) => controller.dispose()));
});

describe("Ask2GPTController", () => {
  it("creates an initial blank composer without writing a conversation record", async () => {
    const store = new FakeStore([]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);

    expect(controller.activeConversation).toMatchObject({ messages: [] });
    expect(controller.getState().conversations).toHaveLength(1);
    expect(store.saved).toHaveLength(0);
    expect(backend.prepared).toEqual([]);
    expect(backend.modelRequests).toEqual([]);

    controller.attachSelection();
    expect(controller.getState().pendingContexts).toEqual([explicitContext()]);
    await controller.dispose();
    expect(store.saved).toHaveLength(0);
  });

  it("archives locally without deleting or closing the owned Chrome conversation", async () => {
    const first = conversation("archive-first");
    first.messages.push({
      id: "archive-first-message",
      role: "user",
      markdown: "Keep this chat",
      status: "complete",
      createdAt: first.createdAt,
    });
    const second = conversation("archive-second");
    second.messages.push({
      id: "archive-second-message",
      role: "user",
      markdown: "Remain active",
      status: "complete",
      createdAt: second.createdAt,
    });
    const store = new FakeStore([first, second]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend, first.id);

    await controller.archiveConversation(first.id);

    expect(
      controller.getState().conversations.find((item) => item.id === first.id)?.archivedAt,
    ).toBeDefined();
    expect(controller.activeConversation?.id).toBe(second.id);
    expect(store.operations).toContain(`save:${first.id}`);
    expect(store.operations).not.toContain(`delete:${first.id}`);
    expect(backend.closed).toEqual([]);

    await controller.unarchiveConversation(first.id, true);

    expect(controller.activeConversation?.id).toBe(first.id);
    expect(controller.activeConversation?.archivedAt).toBeUndefined();
    expect(store.saved.at(-1)?.archivedAt).toBeUndefined();
    expect(backend.closed).toEqual([]);
  });

  it("restores an archived conversation without switching the active composer", async () => {
    const archived = conversation("restore-in-background");
    archived.archivedAt = "2026-07-31T00:00:00.000Z";
    archived.messages.push({
      id: "archived-turn",
      role: "user",
      markdown: "Restore me",
      status: "complete",
      createdAt: archived.createdAt,
    });
    const active = conversation("keep-active");
    active.messages.push({
      id: "active-turn",
      role: "user",
      markdown: "Keep me active",
      status: "complete",
      createdAt: active.createdAt,
    });
    const controller = await createController(
      new FakeStore([archived, active]),
      new FakeBackend(),
      active.id,
    );

    await controller.unarchiveConversation(archived.id, false);

    expect(controller.activeConversation?.id).toBe(active.id);
    expect(
      controller.getState().conversations.find((item) => item.id === archived.id)?.archivedAt,
    ).toBeUndefined();
  });

  it("removes legacy notice-only records during startup", async () => {
    const legacy = conversation("legacy-notice-only");
    legacy.messages.push({
      id: "legacy-notice",
      role: "local-notice",
      markdown: "Legacy local handoff notice",
      status: "complete",
      createdAt: legacy.createdAt,
    });
    const visible = conversation("visible-history");
    visible.messages.push({
      id: "visible-turn",
      role: "user",
      markdown: "Keep this conversation",
      status: "complete",
      createdAt: visible.createdAt,
    });
    const store = new FakeStore([legacy, visible]);

    const controller = await createController(store, new FakeBackend(), legacy.id);

    expect(controller.getState().conversations.some((item) => item.id === legacy.id)).toBe(false);
    expect(store.operations).toContain(`delete:${legacy.id}`);
    expect(controller.activeConversation?.id).not.toBe(legacy.id);
  });

  it("never restores an archived conversation as the active composer", async () => {
    const archived = conversation("archived-active");
    archived.archivedAt = "2026-07-31T00:00:00.000Z";
    archived.messages.push({
      id: "archived-message",
      role: "user",
      markdown: "Archived",
      status: "complete",
      createdAt: archived.createdAt,
    });
    const visible = conversation("visible-active");
    const controller = await createController(
      new FakeStore([archived, visible]),
      new FakeBackend(),
      archived.id,
    );

    expect(controller.activeConversation?.id).toBe(visible.id);
    await controller.selectConversation(archived.id);
    expect(controller.activeConversation?.id).toBe(visible.id);
  });

  it("restores a missing ephemeral active id as the same blank draft", async () => {
    const history = conversation("persisted-history");
    history.messages.push({
      id: "persisted-turn",
      role: "user",
      markdown: "Persisted question",
      status: "complete",
      createdAt: history.createdAt,
    });
    const store = new FakeStore([history]);
    const workspaceState = new Map<string, unknown>([
      ["ask2gpt.activeConversationId", "missing-ephemeral-id"],
    ]);
    const controller = await createController(store, new FakeBackend(), undefined, workspaceState);

    expect(controller.activeConversation).toMatchObject({ messages: [] });
    expect(controller.activeConversation?.id).toBe("missing-ephemeral-id");
    expect(controller.getState().conversations).toHaveLength(2);
    expect(workspaceState.get("ask2gpt.activeConversationId")).toBe("missing-ephemeral-id");
    expect(store.saved).toHaveLength(0);
  });

  it("keeps one ephemeral blank identity across a VS Code reload", async () => {
    const store = new FakeStore([]);
    const workspaceState = new Map<string, unknown>();
    const firstBackend = new FakeBackend();
    const first = await createController(store, firstBackend, undefined, workspaceState);
    const ephemeralId = first.activeConversation!.id;

    expect(workspaceState.get("ask2gpt.activeConversationId")).toBe(ephemeralId);
    expect(firstBackend.prepared).toEqual([]);
    await first.dispose();

    const reloadedBackend = new FakeBackend();
    const reloaded = await createController(store, reloadedBackend, undefined, workspaceState);

    expect(reloaded.activeConversation?.id).toBe(ephemeralId);
    expect(reloaded.getState().conversations).toHaveLength(1);
    expect(workspaceState.get("ask2gpt.activeConversationId")).toBe(ephemeralId);
    expect(reloadedBackend.prepared).toEqual([]);
    expect(reloadedBackend.modelRequests).toEqual([]);
    expect(store.saved).toHaveLength(0);
  });

  it("rejects an unsafe missing workspace active id instead of restoring it", async () => {
    const history = conversation("safe-history");
    history.messages.push({
      id: "safe-history-turn",
      role: "user",
      markdown: "Keep the safe persisted conversation active",
      status: "complete",
      createdAt: history.createdAt,
    });
    const workspaceState = new Map<string, unknown>([
      ["ask2gpt.activeConversationId", "../unsafe-ephemeral-id"],
    ]);

    const controller = await createController(
      new FakeStore([history]),
      new FakeBackend(),
      undefined,
      workspaceState,
    );

    expect(controller.activeConversation?.id).toBe(history.id);
    expect(workspaceState.get("ask2gpt.activeConversationId")).toBe(history.id);
    expect(controller.getState().conversations).toHaveLength(1);
  });

  it("promotes an ephemeral new conversation only when its first turn is accepted", async () => {
    const initial = conversation("ephemeral-promotion-source");
    initial.messages.push({
      id: "existing-turn",
      role: "user",
      markdown: "Existing question",
      status: "complete",
      createdAt: initial.createdAt,
    });
    const store = new FakeStore([initial]);
    const controller = await createController(store, new FakeBackend(), initial.id);
    const created = await controller.newConversation(initial.id);

    expect(store.saved.some((item) => item.id === created.id)).toBe(false);
    controller.attachSelection(created.id);
    await controller.send("Explain this selection", created.id);

    expect(store.saved.at(-1)).toMatchObject({
      id: created.id,
      messages: [
        expect.objectContaining({
          role: "user",
          markdown: "Explain this selection",
          contexts: [explicitContext()],
        }),
        expect.objectContaining({ role: "assistant", status: "streaming" }),
      ],
    });
    expect(controller.getState().pendingContexts).toEqual([]);
  });

  it("keeps explicit attachments scoped to their conversation across new and selected conversations", async () => {
    const initial = conversation("context-a");
    const controller = await createController(
      new FakeStore([initial]),
      new FakeBackend(),
      initial.id,
    );

    controller.attachSelection();
    expect(controller.getState().pendingContexts).toEqual([explicitContext()]);

    const next = await controller.newConversation();
    expect(controller.activeConversation?.id).toBe(next.id);
    expect(controller.getState().pendingContexts).toEqual([]);
    expect(controller.getState().automaticContextIds).toEqual([]);

    await controller.selectConversation(initial.id);
    expect(controller.getState().pendingContexts).toEqual([explicitContext()]);

    await controller.selectConversation(next.id);
    expect(controller.getState().pendingContexts).toEqual([]);
  });

  it("prewarms the exact remote conversation as soon as it is selected", async () => {
    const first = conversation("prewarm-selection-a");
    const second = conversation("prewarm-selection-b");
    second.remoteUrl = "https://chatgpt.com/g/ask2gpt/c/remote-b";
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([first, second]), backend, first.id);

    await controller.selectConversation(second.id);

    expect(backend.prepared.at(-1)).toEqual({
      conversationId: second.id,
      remoteUrl: second.remoteUrl,
      transcriptProof: {
        remoteUrl: second.remoteUrl,
        messageCount: 0,
        messageHashes: [],
        transcriptChainSha256: sha256("[]"),
      },
    });
    expect(backend.sent).toHaveLength(0);
  });

  it("upgrades blank composer activity into a dispatch-intent prewarm", async () => {
    const active = conversation("dispatch-intent-prewarm");
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([active]), backend, active.id);

    expect(backend.prepared).toEqual([]);

    controller.prepareConversationForDispatch(active.id);
    await vi.waitFor(() =>
      expect(backend.prepared.some((entry) => entry.dispatchIntent === true)).toBe(true),
    );

    expect(backend.prepared.at(-1)).toMatchObject({
      conversationId: active.id,
      dispatchIntent: true,
      remoteUrl: undefined,
    });
    expect(backend.sent).toHaveLength(0);
  });

  it("releases the previous view lease once when switching conversations", async () => {
    const first = conversation("release-select-a");
    const second = conversation("release-select-b");
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([first, second]), backend, first.id);

    await controller.selectConversation(second.id);

    expect(backend.released).toEqual([
      { conversationId: first.id, purpose: "view", reason: "inactive" },
    ]);

    await controller.selectConversation(second.id);
    expect(backend.released).toHaveLength(1);
  });

  it("renews A when switching A to B to A even while A's first prewarm is pending", async () => {
    const first = conversation("release-renew-a");
    first.remoteUrl = "https://chatgpt.com/g/ask2gpt/c/release-renew-a";
    const second = conversation("release-renew-b");
    second.remoteUrl = "https://chatgpt.com/g/ask2gpt/c/release-renew-b";
    const backend = new FakeBackend();
    let finishFirstPrewarm!: () => void;
    let holdFirstPrewarm = true;
    backend.prepareHandler = (conversationId) => {
      if (conversationId !== first.id || !holdFirstPrewarm) return Promise.resolve();
      holdFirstPrewarm = false;
      return new Promise<void>((resolve) => {
        finishFirstPrewarm = resolve;
      });
    };
    const controller = await createController(new FakeStore([first, second]), backend, first.id);

    await controller.selectConversation(second.id);
    await controller.selectConversation(first.id);

    expect(backend.prepared.filter((entry) => entry.conversationId === first.id)).toHaveLength(2);
    expect(backend.released).toEqual([
      { conversationId: first.id, purpose: "view", reason: "inactive" },
      { conversationId: second.id, purpose: "view", reason: "inactive" },
    ]);

    finishFirstPrewarm();
    await Promise.resolve();
  });

  it("releases the previous view lease once when creating a conversation", async () => {
    const initial = conversation("release-new");
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([initial]), backend, initial.id);

    await controller.newConversation(initial.id);

    expect(backend.released).toEqual([
      { conversationId: initial.id, purpose: "view", reason: "inactive" },
    ]);
  });

  it("releases the archived active conversation view lease once", async () => {
    const archived = conversation("release-archive");
    archived.messages.push({
      id: "release-archive-message",
      role: "user",
      markdown: "Archive this conversation",
      status: "complete",
      createdAt: archived.createdAt,
    });
    const replacement = conversation("release-archive-replacement");
    const backend = new FakeBackend();
    const controller = await createController(
      new FakeStore([archived, replacement]),
      backend,
      archived.id,
    );

    await controller.archiveConversation(archived.id);

    expect(backend.released).toEqual([
      { conversationId: archived.id, purpose: "view", reason: "inactive" },
    ]);
  });

  it("releases the deleted active conversation view lease once", async () => {
    const deleted = conversation("release-delete");
    const replacement = conversation("release-delete-replacement");
    const backend = new FakeBackend();
    const controller = await createController(
      new FakeStore([deleted, replacement]),
      backend,
      deleted.id,
    );

    await controller.deleteConversation(deleted.id);

    expect(backend.released).toEqual([
      { conversationId: deleted.id, purpose: "view", reason: "inactive" },
    ]);
  });

  it("does not let a failed view release break conversation navigation", async () => {
    const first = conversation("release-failure-a");
    const second = conversation("release-failure-b");
    const backend = new FakeBackend();
    backend.releaseFailure = new Error("release unavailable");
    const controller = await createController(new FakeStore([first, second]), backend, first.id);

    await expect(controller.selectConversation(second.id)).resolves.toBeUndefined();
    await Promise.resolve();

    expect(controller.activeConversation?.id).toBe(second.id);
    expect(backend.released).toEqual([
      { conversationId: first.id, purpose: "view", reason: "inactive" },
    ]);
  });

  it("does not wait for a pending view release before completing navigation", async () => {
    const first = conversation("release-pending-a");
    const second = conversation("release-pending-b");
    const backend = new FakeBackend();
    let finishRelease!: (delivered: boolean) => void;
    backend.releaseHandler = () =>
      new Promise<boolean>((resolve) => {
        finishRelease = resolve;
      });
    const controller = await createController(new FakeStore([first, second]), backend, first.id);

    await expect(controller.selectConversation(second.id)).resolves.toBeUndefined();
    expect(controller.activeConversation?.id).toBe(second.id);

    finishRelease(true);
    await Promise.resolve();
  });

  it("does not release the active view lease during controller disposal", async () => {
    const active = conversation("release-dispose");
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([active]), backend, active.id);

    await controller.dispose();

    expect(backend.released).toEqual([]);
  });

  it("coalesces same-source New requests and keeps the source attachment isolated", async () => {
    const initial = conversation("new-single-flight-source");
    const store = new FakeStore([initial]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend, initial.id);
    controller.attachSelection(initial.id);
    const savesBefore = store.saved.length;
    const modelRequestsBefore = backend.modelRequests.length;

    const first = controller.newConversation(initial.id);
    const duplicate = controller.newConversation(initial.id);

    expect(duplicate).toBe(first);
    const [created, repeated] = await Promise.all([first, duplicate]);

    expect(repeated.id).toBe(created.id);
    expect(controller.getState().conversations).toHaveLength(2);
    expect(
      store.saved.slice(savesBefore).filter((conversation) => conversation.id === created.id),
    ).toHaveLength(0);
    expect(backend.modelRequests).toHaveLength(modelRequestsBefore);
    expect(controller.activeConversation?.id).toBe(created.id);
    expect(controller.getState().pendingContexts).toEqual([]);

    await controller.selectConversation(initial.id);
    expect(controller.getState().pendingContexts).toEqual([explicitContext()]);
  });

  it("treats a delayed New request from an old rendered conversation as idempotent", async () => {
    const initial = conversation("new-stale-source");
    const store = new FakeStore([initial]);
    const controller = await createController(store, new FakeBackend(), initial.id);

    const created = await controller.newConversation(initial.id);
    const duplicate = await controller.newConversation(initial.id);

    expect(duplicate.id).toBe(created.id);
    expect(controller.getState().conversations).toHaveLength(2);
    expect(store.saved.filter((conversation) => conversation.id === created.id)).toHaveLength(0);

    const intentionalNext = await controller.newConversation(created.id);
    expect(intentionalNext.id).not.toBe(created.id);
    expect(controller.getState().conversations).toHaveLength(3);
  });

  it("serializes New and selection so the later navigation intent wins", async () => {
    const first = conversation("new-navigation-a");
    const second = conversation("new-navigation-b");
    const store = new FakeStore([first, second]);
    const workspaceState = new Map<string, unknown>();
    const controller = await createController(store, new FakeBackend(), first.id, workspaceState);

    const creating = controller.newConversation(first.id);
    controller.attachSelection(first.id);
    const selecting = controller.selectConversation(second.id);
    const created = await creating;
    await selecting;

    expect(controller.activeConversation?.id).toBe(second.id);
    expect(workspaceState.get("ask2gpt.activeConversationId")).toBe(second.id);
    await controller.selectConversation(created.id);
    expect(controller.getState().pendingContexts).toEqual([]);
    await controller.selectConversation(first.id);
    expect(controller.getState().pendingContexts).toEqual([explicitContext()]);
  });

  it("attaches an editor-shortcut selection to a new conversation queued before it", async () => {
    const initial = conversation("selection-after-new");
    const workspaceState = new Map<string, unknown>();
    const reference = selectionReference();
    let pauseNextActiveWrite = false;
    let releaseActiveWrite: (() => void) | undefined;
    const captureSelection = vi.fn((received?: SelectionReference) => {
      expect(received).toEqual(reference);
      return { ...explicitContext(), id: "selection-after-new-context" };
    });
    const controller = await createController(
      new FakeStore([initial]),
      new FakeBackend(),
      initial.id,
      workspaceState,
      undefined,
      captureSelection,
      (key, value) => {
        workspaceState.set(key, value);
        if (!pauseNextActiveWrite) return Promise.resolve();
        pauseNextActiveWrite = false;
        return new Promise<void>((resolve) => {
          releaseActiveWrite = resolve;
        });
      },
    );
    pauseNextActiveWrite = true;

    const creating = controller.newConversation(initial.id);
    const attaching = controller.attachSelectionToActiveConversation(reference);
    await vi.waitFor(() => expect(releaseActiveWrite).toBeDefined());

    expect(captureSelection).not.toHaveBeenCalled();
    releaseActiveWrite!();
    const created = await creating;
    await expect(attaching).resolves.toBe(true);

    expect(controller.activeConversation?.id).toBe(created.id);
    expect(controller.getState().pendingContexts).toEqual([
      expect.objectContaining({ id: "selection-after-new-context" }),
    ]);
    await controller.selectConversation(initial.id);
    expect(controller.getState().pendingContexts).toEqual([]);
  });

  it("attaches an editor-shortcut selection before a later New conversation", async () => {
    const initial = conversation("selection-before-new");
    const reference = selectionReference();
    const captureSelection = vi.fn((received?: SelectionReference) => {
      expect(received).toEqual(reference);
      return { ...explicitContext(), id: "selection-before-new-context" };
    });
    const controller = await createController(
      new FakeStore([initial]),
      new FakeBackend(),
      initial.id,
      new Map(),
      undefined,
      captureSelection,
    );

    const attaching = controller.attachSelectionToActiveConversation(reference);
    const creating = controller.newConversation(initial.id);
    await expect(attaching).resolves.toBe(true);
    const created = await creating;

    expect(controller.activeConversation?.id).toBe(created.id);
    expect(controller.getState().pendingContexts).toEqual([]);
    await controller.selectConversation(initial.id);
    expect(controller.getState().pendingContexts).toEqual([
      expect.objectContaining({ id: "selection-before-new-context" }),
    ]);
    expect(captureSelection).toHaveBeenCalledOnce();
  });

  it("keeps consecutive blank new drafts lazy without losing source contexts", async () => {
    const initial = conversation("new-retry-source");
    const store = new FakeStore([initial]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend, initial.id);
    const savesBefore = store.saved.length;
    const modelRequestsBefore = backend.modelRequests.length;
    const created = await controller.newConversation(initial.id);

    controller.attachSelection(created.id);
    const next = await controller.newConversation(created.id);

    expect(controller.activeConversation?.id).toBe(next.id);
    expect(controller.getState().conversations).toHaveLength(3);
    expect(backend.prepared).toEqual([]);
    expect(backend.modelRequests).toHaveLength(modelRequestsBefore);
    expect(store.saved.slice(savesBefore).some((item) => item.id === created.id)).toBe(false);
    expect(store.saved.slice(savesBefore).some((item) => item.id === next.id)).toBe(false);

    await controller.selectConversation(created.id);
    expect(controller.getState().pendingContexts).toEqual([explicitContext()]);
    expect(backend.prepared).toEqual([]);

    await controller.selectConversation(next.id);
    expect(controller.getState().pendingContexts).toEqual([]);
    expect(backend.prepared).toEqual([]);

    await controller.dispose();
    expect(store.saved.slice(savesBefore).some((item) => item.id === created.id)).toBe(false);
    expect(store.saved.slice(savesBefore).some((item) => item.id === next.id)).toBe(false);
  });

  it("routes an editor-menu selection to its click-time conversation", async () => {
    const first = conversation("inline-target-a");
    const second = conversation("inline-target-b");
    const reference = selectionReference();
    const captureSelection = vi.fn((received?: SelectionReference) => {
      expect(received).toBe(reference);
      return explicitContext();
    });
    const controller = await createController(
      new FakeStore([first, second]),
      new FakeBackend(),
      second.id,
      new Map(),
      undefined,
      captureSelection,
    );

    controller.attachSelection(first.id, reference);

    expect(controller.activeConversation?.id).toBe(second.id);
    expect(controller.getState().pendingContexts).toEqual([]);
    await controller.selectConversation(first.id);
    expect(controller.getState().pendingContexts).toEqual([explicitContext()]);
    expect(captureSelection).toHaveBeenCalledOnce();
  });

  it("keeps identical ranges from two selected notebook cells distinct", async () => {
    const initial = conversation("notebook-cells");
    const references = [notebookReference(0), notebookReference(1)];
    const captureNotebookCells = vi.fn((received?: readonly NotebookCellReference[]) => {
      expect(received).toEqual(references);
      return [notebookContext(0), notebookContext(1)];
    });
    const controller = await createController(
      new FakeStore([initial]),
      new FakeBackend(),
      initial.id,
      new Map(),
      undefined,
      undefined,
      undefined,
      captureNotebookCells,
    );

    await expect(controller.attachNotebookCellsToActiveConversation(references)).resolves.toBe(
      true,
    );

    expect(controller.getState().pendingContexts).toHaveLength(2);
    expect(
      controller
        .getState()
        .pendingContexts.map((context) =>
          context.sourceAnchor?.formatVersion === 2 ? context.sourceAnchor.cellIndex : undefined,
        ),
    ).toEqual([0, 1]);
    expect(captureNotebookCells).toHaveBeenCalledOnce();
  });

  it("leaves the existing draft untouched when a tracked selection is stale", async () => {
    let captureCount = 0;
    const backend = new FakeBackend();
    const controller = await createController(
      new FakeStore([conversation("stale-selection")]),
      backend,
      undefined,
      new Map(),
      undefined,
      () => {
        captureCount += 1;
        if (captureCount === 1) return explicitContext();
        throw new Error("SELECTION_STALE");
      },
    );
    controller.attachSelection();
    const before = controller.getState().pendingContexts;

    expect(() => controller.attachSelection(undefined, selectionReference())).toThrow(
      "SELECTION_STALE",
    );

    expect(controller.getState().pendingContexts).toEqual(before);
    expect(backend.sent).toHaveLength(0);
    expect(controller.activeConversation?.messages).toEqual([]);
  });

  it("returns a delayed file-picker result to its originating conversation after selection changes", async () => {
    const first = conversation("delayed-files-a");
    const second = conversation("delayed-files-b");
    let finishPicker!: (contexts: ContextSnapshot[]) => void;
    const controller = await createController(
      new FakeStore([first, second]),
      new FakeBackend(),
      first.id,
      new Map(),
      () =>
        new Promise((resolve) => {
          finishPicker = resolve;
        }),
    );

    const attaching = controller.attachFiles(first.id);
    await controller.selectConversation(second.id);
    finishPicker([{ ...explicitContext(), id: "delayed-file", kind: "file" }]);
    await attaching;

    expect(controller.activeConversation?.id).toBe(second.id);
    expect(controller.getState().pendingContexts).toEqual([]);
    await controller.selectConversation(first.id);
    expect(controller.getState().pendingContexts.map((context) => context.id)).toEqual([
      "delayed-file",
    ]);
  });

  it("ignores a delayed file-picker result after its target conversation is deleted", async () => {
    const first = conversation("deleted-files-a");
    const second = conversation("deleted-files-b");
    let finishPicker!: (contexts: ContextSnapshot[]) => void;
    const controller = await createController(
      new FakeStore([first, second]),
      new FakeBackend(),
      first.id,
      new Map(),
      () =>
        new Promise((resolve) => {
          finishPicker = resolve;
        }),
    );

    const attaching = controller.attachFiles(first.id);
    await controller.deleteConversation(first.id);
    finishPicker([{ ...explicitContext(), id: "orphaned-file", kind: "file" }]);
    await attaching;

    expect(controller.activeConversation?.id).toBe(second.id);
    expect(controller.getState().pendingContexts).toEqual([]);
  });

  it("restores conversations with clean opt-in attachment drafts", async () => {
    const restored = conversation("restored-with-history");
    restored.messages.push({
      id: "restored-question",
      role: "user",
      markdown: "解释已有回答",
      status: "complete",
      createdAt: restored.createdAt,
      contexts: [explicitContext()],
    });
    const empty = conversation("empty-draft");
    const controller = await createController(
      new FakeStore([restored, empty]),
      new FakeBackend(),
      restored.id,
    );

    expect(controller.getState().pendingContexts).toEqual([]);
    await controller.selectConversation(empty.id);
    expect(controller.getState().pendingContexts).toEqual([]);
    await controller.selectConversation(restored.id);
    expect(controller.getState().pendingContexts).toEqual([]);
  });

  it("keeps explicit context when remote history establishes an initially empty conversation", async () => {
    const initial = conversation("remote-history-context-handoff");
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([initial]), backend, initial.id);

    await controller.attachFiles();
    expect(controller.getState().pendingContexts.map((context) => context.id)).toEqual([
      "context-2",
    ]);

    backend.emit({
      type: "history",
      conversationId: initial.id,
      remoteUrl: "https://chatgpt.com/c/remote-history-context-handoff",
      messages: [
        { role: "user", markdown: "Existing remote question" },
        { role: "assistant", markdown: "Existing remote answer" },
      ],
      observedAt: new Date().toISOString(),
      complete: true,
    });

    await vi.waitFor(() => expect(controller.activeConversation?.messages).toHaveLength(2));
    expect(controller.getState().pendingContexts.map((context) => context.id)).toEqual([
      "context-2",
    ]);
    expect(controller.getState().automaticContextIds).toEqual([]);
  });

  it("keeps explicit context stable while committing and clears it after dispatch", async () => {
    const initial = conversation("stable-context");
    const store = new FakeStore([initial]);
    const controller = await createController(store, new FakeBackend(), initial.id);
    const attached = explicitContext();
    controller.attachSelection();
    expect(controller.getState().pendingContexts).toEqual([attached]);

    const observed: AppState[] = [];
    const subscription = controller.onState((state) => observed.push(state));
    store.pauseNextSave = true;
    const sending = controller.send("解释这段代码", initial.id, "send-stable-context-request");
    await vi.waitFor(() => expect(store.pendingSave).toBeDefined());
    expect(controller.getState()).toMatchObject({
      contextLocked: true,
      pendingContexts: [attached],
    });
    expect(observed.every((state) => state.pendingContexts.length === 1)).toBe(true);

    store.finishSave();
    await sending;
    expect(controller.getState()).toMatchObject({
      contextLocked: false,
      pendingContexts: [],
      automaticContextIds: [],
    });
    expect(controller.activeConversation?.messages[0]).toMatchObject({
      role: "user",
      clientRequestId: "send-stable-context-request",
    });
    subscription.dispose();
  });

  it("rolls back an unaccepted send and restores its explicit context", async () => {
    const store = new FakeStore([conversation("idle")]);
    const backend = new FakeBackend();
    backend.sendFailure = new Error("not connected");
    const controller = await createController(store, backend);
    controller.attachSelection();

    await expect(controller.send("什么是事件循环？")).rejects.toThrow("not connected");
    expect(controller.activeConversation?.messages).toEqual([]);
    expect(controller.activeConversation?.run).toBeUndefined();
    expect(controller.getState().pendingContexts[0]?.fileName).toBe("index.ts");
    expect(store.operations.at(-1)).toBe(`delete:${controller.activeConversation?.id}`);
  });

  it.each([
    ["local", "Pinned local title"],
    ["chatgpt", "Existing ChatGPT title"],
  ] as const)("preserves an explicit %s title on the first send", async (titleSource, title) => {
    const initial = conversation(`first-send-${titleSource}-title`);
    initial.title = title;
    initial.titleSource = titleSource;
    if (titleSource === "chatgpt") {
      initial.remoteUrl = `https://chatgpt.com/c/first-send-${titleSource}-title`;
    }
    const controller = await createController(
      new FakeStore([initial]),
      new FakeBackend(),
      initial.id,
    );

    await controller.send("This first question must not replace the existing title.");

    expect(controller.activeConversation).toMatchObject({ title, titleSource });
  });

  it("never derives an accessibility navigation label as the first-message title", async () => {
    const initial = conversation("generic-first-message-title");
    const controller = await createController(
      new FakeStore([initial]),
      new FakeBackend(),
      initial.id,
    );

    await controller.send("Skip to content");

    expect(controller.activeConversation).toMatchObject({
      title: "新对话",
    });
    expect(controller.activeConversation?.titleSource).toBeUndefined();
  });

  it("moves context to the persisted message while Relay dispatch is pending and restores it on rejection", async () => {
    const backend = new FakeBackend();
    let rejectDispatch!: (error: Error) => void;
    backend.sendHandler = () =>
      new Promise((_, reject) => {
        rejectDispatch = reject;
      });
    const controller = await createController(
      new FakeStore([conversation("pending-dispatch")]),
      backend,
    );
    controller.attachSelection();

    const sending = controller.send("解释这段代码");
    await vi.waitFor(() => expect(backend.sent).toHaveLength(1));
    expect(controller.getState()).toMatchObject({
      contextLocked: true,
      dispatchingConversationIds: ["conversation-pending-dispatch"],
      pendingContexts: [],
    });
    expect(controller.activeConversation?.messages[0]?.contexts).toHaveLength(1);

    const originalConversationId = controller.activeConversation!.id;
    await controller.newConversation();
    rejectDispatch(new Error("relay rejected dispatch"));
    await expect(sending).rejects.toThrow("relay rejected dispatch");
    await controller.selectConversation(originalConversationId);
    expect(controller.activeConversation?.messages).toEqual([]);
    expect(controller.getState().pendingContexts).toEqual([explicitContext()]);
  });

  it("dispatches to the conversation captured by the composer even after selection changes", async () => {
    const first = conversation("captured-a");
    const second = conversation("captured-b");
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([first, second]), backend, first.id);
    controller.attachSelection();

    await controller.selectConversation(second.id);
    await controller.send("Question captured in A", first.id);

    expect(backend.sent).toHaveLength(1);
    expect(backend.sent[0]?.conversationId).toBe(first.id);
    expect(controller.activeConversation?.id).toBe(second.id);
    expect(controller.activeConversation?.messages).toEqual([]);

    await controller.selectConversation(first.id);
    expect(controller.activeConversation?.messages[0]).toMatchObject({
      role: "user",
      markdown: "Question captured in A",
      contexts: [explicitContext()],
    });
  });

  it("precomputes a content-free transcript proof and excludes known unsent failures", async () => {
    const initial = conversation("transcript-proof");
    initial.remoteUrl = "https://chatgpt.com/c/transcript-proof";
    initial.messages = [
      {
        id: "sent-user",
        clientRequestId: "sent-request",
        role: "user",
        markdown: "FIRST_TURN",
        status: "complete",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "sent-assistant",
        role: "assistant",
        markdown: "FIRST_ANSWER",
        status: "complete",
        createdAt: "2026-01-01T00:00:01.000Z",
        terminalReceipt: {
          eventId: "terminal-sent",
          runId: "run-sent",
          terminalType: "complete",
        },
      },
      {
        id: "unsent-user",
        clientRequestId: "unsent-request",
        role: "user",
        markdown: "UNSENT_TURN",
        status: "complete",
        createdAt: "2026-01-01T00:00:02.000Z",
      },
      {
        id: "unsent-assistant",
        role: "assistant",
        markdown: "",
        status: "error",
        createdAt: "2026-01-01T00:00:02.000Z",
        runError: {
          code: "CHATGPT_REMOTE_UNAVAILABLE",
          message:
            "Ask2GPT could not capture a complete, stable pre-send transcript; the question was not sent. Enhanced reception diagnostic: stage=candidate-post-seen.",
          recoverable: true,
        },
      },
    ];
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([initial]), backend, initial.id);

    await controller.send("NEXT_TURN");

    const firstUserHash = sha256(JSON.stringify(["user", "FIRST\\_TURN"]));
    const firstAssistantHash = sha256(JSON.stringify(["assistant", "FIRST_ANSWER"]));
    expect(backend.sent[0]?.transcriptProof).toEqual({
      remoteUrl: initial.remoteUrl,
      messageCount: 2,
      messageHashes: [
        { role: "user", sha256: firstUserHash },
        { role: "assistant", sha256: firstAssistantHash },
      ],
      transcriptChainSha256: sha256(
        JSON.stringify([
          ["user", firstUserHash],
          ["assistant", firstAssistantHash],
        ]),
      ),
    });
  });

  it("builds transcript proofs with each context transport version", async () => {
    const initial = conversation("versioned-context-proof");
    initial.remoteUrl = "https://chatgpt.com/c/versioned-context-proof";
    const context = explicitContext();
    const legacyQuestion = "LEGACY_[TURN] & <one>";
    const packagedQuestion = "PACKAGED_[TURN] & <two>";
    initial.messages = [
      {
        id: "legacy-user",
        role: "user",
        markdown: legacyQuestion,
        status: "complete",
        createdAt: "2026-01-01T00:00:00.000Z",
        contexts: [context],
      },
      {
        id: "legacy-answer",
        role: "assistant",
        markdown: "LEGACY_ANSWER",
        status: "complete",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "packaged-user",
        role: "user",
        markdown: packagedQuestion,
        status: "complete",
        createdAt: "2026-01-01T00:00:02.000Z",
        contexts: [context],
        contextTransportVersion: 2,
      },
      {
        id: "packaged-answer",
        role: "assistant",
        markdown: "PACKAGED_ANSWER",
        status: "complete",
        createdAt: "2026-01-01T00:00:03.000Z",
      },
    ];
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([initial]), backend, initial.id);

    await controller.send("NEXT_TURN");

    const expectedMessages = [
      ["user", promptInlinePresentationV1(buildLegacyVisiblePrompt(legacyQuestion, [context]))],
      ["assistant", "LEGACY_ANSWER"],
      ["user", promptInlinePresentationV1(packagedQuestion)],
      ["assistant", "PACKAGED_ANSWER"],
    ] as const;
    expect(backend.sent[0]?.transcriptProof?.messageHashes).toEqual(
      expectedMessages.map(([role, markdown]) => ({
        role,
        sha256: sha256(JSON.stringify([role, markdown])),
      })),
    );
  });

  it("deduplicates, removes, stores, and clears explicit attachment bundles", async () => {
    const store = new FakeStore([conversation("contexts")]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);

    controller.attachSelection();
    controller.attachSelection();
    await controller.attachFiles();
    expect(controller.getState().pendingContexts.map((context) => context.fileName)).toEqual([
      "index.ts",
      "other.ts",
    ]);

    controller.removeContext("context-1");
    expect(controller.getState().pendingContexts.map((context) => context.id)).toEqual([
      "context-2",
    ]);
    controller.attachSelection();
    await controller.send("解释这些代码");

    expect(controller.getState().pendingContexts).toEqual([]);
    expect(
      controller.activeConversation?.messages[0]?.contexts?.map((context) => context.id),
    ).toEqual(["context-1", "context-2"]);
    expect(backend.sent[0]?.prompt).toBe("解释这些代码");
    expect(backend.sent[0]?.attachments).toEqual([
      expect.objectContaining({ id: "context-1", fileName: "index.L1-L1.ts" }),
      expect.objectContaining({ id: "context-2", fileName: "other.ts" }),
    ]);
    expect(controller.activeConversation?.messages[0]).toMatchObject({
      contextTransportVersion: 2,
    });
  });

  it("deduplicates repeated snapshots by content identity instead of generated id", async () => {
    let captureCount = 0;
    const backend = new FakeBackend();
    const controller = await createController(
      new FakeStore([conversation("semantic-selection-dedupe")]),
      backend,
      undefined,
      new Map(),
      undefined,
      () => ({ ...explicitContext(), id: `selection-${++captureCount}` }),
    );

    controller.attachSelection();
    controller.attachSelection();

    expect(controller.getState().pendingContexts).toHaveLength(1);
    expect(controller.getState().pendingContexts[0]?.id).toBe("selection-2");
    expect(backend.sent).toHaveLength(0);
    expect(controller.activeConversation?.messages).toEqual([]);
  });

  it("replaces the primary selection across ranges and files while preserving file attachments", async () => {
    const selections: ContextSnapshot[] = [
      {
        ...explicitContext(),
        id: "range-a",
        startLine: 2,
        endLine: 3,
        content: "range a",
        charCount: 7,
      },
      {
        ...explicitContext(),
        id: "range-b",
        startLine: 8,
        endLine: 9,
        content: "range b",
        charCount: 7,
      },
      {
        ...explicitContext(),
        id: "file-b",
        fileName: "worker.py",
        uri: "file:///worker.py",
        language: "python",
        startLine: 4,
        endLine: 6,
        content: "range c",
        charCount: 7,
      },
    ];
    const controller = await createController(
      new FakeStore([conversation("replace-primary-selection")]),
      new FakeBackend(),
      undefined,
      new Map(),
      undefined,
      () => selections.shift()!,
    );
    await controller.attachFiles();

    controller.attachSelection();
    controller.attachSelection();
    expect(controller.getState().pendingContexts.map((context) => context.id)).toEqual([
      "range-b",
      "context-2",
    ]);
    expect(controller.getState().pendingContexts[0]).toMatchObject({
      uri: "file:///index.ts",
      startLine: 8,
      endLine: 9,
      content: "range b",
      charCount: 7,
    });

    controller.attachSelection();
    expect(controller.getState().pendingContexts.map((context) => context.id)).toEqual([
      "file-b",
      "context-2",
    ]);
    expect(controller.getState().pendingContexts[0]).toMatchObject({
      uri: "file:///worker.py",
      fileName: "worker.py",
      language: "python",
      startLine: 4,
      endLine: 6,
      content: "range c",
      charCount: 7,
    });
  });

  it.each([
    "帮我修改这个文件并运行测试",
    "解释这个错误，然后修复代码",
    "Please fix this component and run the tests",
    "Search the entire repository",
  ])("routes action-oriented prompts through the same Relay send path: %s", async (question) => {
    const backend = new FakeBackend();
    const controller = await createController(
      new FakeStore([conversation("action-prompt")]),
      backend,
    );
    controller.attachSelection();

    await controller.send(question);

    expect(backend.sent).toHaveLength(1);
    expect(backend.sent[0]?.prompt).toBe(question);
    expect(backend.sent[0]?.attachments).toEqual([
      expect.objectContaining({ id: "context-1", fileName: "index.L1-L1.ts" }),
    ]);
    expect(controller.activeConversation?.messages).toEqual([
      expect.objectContaining({
        role: "user",
        markdown: question,
        contexts: [explicitContext()],
        contextTransportVersion: 2,
      }),
      expect.objectContaining({ role: "assistant", status: "streaming" }),
    ]);
    expect(
      controller.activeConversation?.messages.some((message) => message.role === "local-notice"),
    ).toBe(false);
  });

  it("counts restored runs when enforcing the global concurrency limit for every prompt", async () => {
    const idle = conversation("idle");
    const store = new FakeStore([
      idle,
      runningConversation("run-1"),
      runningConversation("run-2"),
      runningConversation("run-3"),
    ]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend, idle.id);

    await expect(controller.send("解释事件循环")).rejects.toMatchObject({
      code: "CONCURRENT_RUN_LIMIT",
    });
    expect(controller.getState().backend.activeRuns).toBe(3);
    expect(backend.sent).toHaveLength(0);

    await expect(controller.send("帮我修改这个文件并运行测试")).rejects.toMatchObject({
      code: "CONCURRENT_RUN_LIMIT",
    });
    expect(backend.sent).toHaveLength(0);
    expect(controller.activeConversation?.messages).toEqual([]);
  });

  it("prewarms the Fast model mapping once and reuses it across conversations", async () => {
    const first = conversation("first");
    first.remoteUrl = "https://chatgpt.com/g/project/c/remote-first";
    const second = conversation("second");
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([first, second]), backend, first.id);

    await vi.waitFor(() => expect(backend.modelRequests).toHaveLength(1));

    await controller.newConversation();
    expect(backend.modelRequests).toHaveLength(1);

    await controller.selectConversation(second.id);
    expect(backend.modelRequests).toHaveLength(1);

    await controller.listModels(second.id);
    expect(backend.modelRequests.at(-1)).toEqual({
      conversationId: second.id,
      remoteUrl: undefined,
    });
    expect(backend.modelRequests).toHaveLength(2);
  });

  it("applies a model tier locally and defers the real page switch until send", async () => {
    const backend = new FakeBackend();
    backend.modelOptions = [
      { id: "visible-fast", label: "GPT Fast", selected: true },
      { id: "visible-thinking", label: "GPT Thinking", selected: false },
    ];
    backend.modelSelectionHandler = () =>
      Promise.reject(new Error("selectModel must not reach Chrome before send"));
    const controller = await createController(
      new FakeStore([conversation("optimistic-model")]),
      backend,
    );
    await controller.listModels();

    await controller.selectModel("visible-thinking");
    expect(controller.getState().modelPicker).toMatchObject({
      status: "ready",
      currentModelId: "visible-thinking",
    });
    await controller.send("解释事件循环");
    expect(backend.sent).toHaveLength(1);
    expect(backend.sent[0]?.modelId).toBe("visible-thinking");
    expect(controller.activeConversation?.selectedModelId).toBe("visible-thinking");
  });

  it("applies a delayed model choice only to the conversation captured by the webview", async () => {
    const first = conversation("model-first");
    const second = conversation("model-second");
    const backend = new FakeBackend();
    backend.modelOptions = [
      { id: "mode-smart", label: "Smart", mode: "smart", selected: true },
      { id: "mode-high", label: "High", mode: "high", selected: false },
    ];
    const controller = await createController(new FakeStore([first, second]), backend, first.id);
    await vi.waitFor(() => expect(controller.getState().modelPicker.status).toBe("ready"));
    await controller.selectConversation(second.id);
    await vi.waitFor(() => expect(controller.getState().modelPicker.status).toBe("ready"));

    await controller.selectModel("mode-high", first.id);

    const state = controller.getState();
    expect(state.activeConversationId).toBe(second.id);
    expect(state.conversations.find((item) => item.id === first.id)?.selectedModelId).toBe(
      "mode-high",
    );
    expect(
      state.conversations.find((item) => item.id === second.id)?.selectedModelId,
    ).toBeUndefined();
    expect(state.modelPicker.conversationId).toBe(second.id);
    expect(state.modelPicker.currentModelId).not.toBe("mode-high");
  });

  it("restores the selected ChatGPT mode for each local conversation", async () => {
    const local = conversation("stored-model");
    local.selectedModelId = "visible-thinking";
    local.messages.push({
      id: "stored-model-user-message",
      role: "user",
      markdown: "Keep this persisted model selection",
      status: "complete",
      createdAt: local.createdAt,
    });
    const backend = new FakeBackend();
    backend.modelOptions = [
      { id: "visible-fast", label: "GPT Fast", selected: true },
      { id: "visible-thinking", label: "GPT Thinking", selected: false },
    ];
    const controller = await createController(new FakeStore([local]), backend, local.id);

    await vi.waitFor(() =>
      expect(backend.modelRequests).toEqual([{ conversationId: local.id, remoteUrl: undefined }]),
    );
    const picker = controller.getState().modelPicker;
    expect(picker.currentModelId).toBe("visible-thinking");
    expect(picker.options.find((option) => option.id === "visible-fast")?.selected).toBe(false);
    expect(picker.options.find((option) => option.id === "visible-thinking")?.selected).toBe(true);
  });

  it("keeps all web tiers selectable while the account catalog refreshes in the background", async () => {
    const backend = new FakeBackend();
    backend.modelOptions = [
      { id: "mode-smart", label: "Smart", mode: "smart", selected: true },
      { id: "mode-high", label: "High", mode: "high", selected: false },
    ];
    const controller = await createController(
      new FakeStore([conversation("deferred-model")]),
      backend,
    );

    expect(controller.getState().modelPicker.options.map((option) => option.id)).toEqual([
      "mode-smart",
      "mode-fast",
      "mode-medium",
      "mode-high",
      "mode-very-high",
      "mode-pro",
    ]);
    await controller.selectModel("mode-pro");
    await vi.waitFor(() => expect(controller.getState().modelPicker.syncing).toBe(false));
    expect(controller.getState().modelPicker.currentModelId).toBe("mode-pro");
    await controller.send("比较模型挡位");
    expect(backend.sent[0]?.modelId).toBe("mode-pro");
  });

  it("uses Fast by default even before the browser catalog is available", async () => {
    const backend = new FakeBackend();
    backend.modelOptions = [];
    const controller = await createController(
      new FakeStore([conversation("implicit-web-model")]),
      backend,
    );

    expect(controller.getState().modelPicker.currentModelId).toBe("mode-fast");
    await controller.send("沿用网页当前模型回答");

    expect(backend.sent).toHaveLength(1);
    expect(backend.sent[0]?.modelId).toBe("mode-fast");
  });

  it("does not rebroadcast equivalent backend statuses", async () => {
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([conversation("status")]), backend);
    const states: BackendStatus[] = [];
    const subscription = controller.onState((state) => states.push(state.backend));

    backend.emit({ type: "status", status: { ...backend.status } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(states).toHaveLength(0);

    backend.emit({
      type: "status",
      status: {
        ...backend.status,
        project: { bound: true, name: "Ask2GPT" },
      },
    });
    await vi.waitFor(() => expect(states).toHaveLength(1));

    backend.emit({
      type: "status",
      status: {
        ...backend.status,
        project: { bound: true, name: "Ask2GPT" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(states).toHaveLength(1);
    subscription.dispose();
  });

  it("emits compact streaming updates and a full terminal state without polling status", async () => {
    const running = runningConversation("single-state");
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([running]), backend);
    const logger = (
      controller as unknown as {
        logger: {
          info: {
            mock: { calls: Array<[string, Record<string, unknown>]> };
          };
        };
      }
    ).logger;
    const states: AppState[] = [];
    const updates: GenerationViewUpdate[] = [];
    const subscription = controller.onState((state) => states.push(state));
    const generationSubscription = controller.onGeneration((update) => updates.push(update));
    expect(backend.getStatusCalls).toBe(1);

    backend.emit({
      type: "snapshot",
      conversationId: running.id,
      runId: "single-state",
      markdown: "partial",
    });
    expect(states).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      conversationId: running.id,
      markdown: "partial",
      runId: "single-state",
    });
    expect(backend.getStatusCalls).toBe(1);

    backend.emit({
      type: "complete",
      conversationId: running.id,
      runId: "single-state",
      terminalEventId: "terminal-single-state",
      markdown: "complete",
    });
    expect(states).toHaveLength(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(states).toHaveLength(1);
    expect(states[0]?.conversations[0]?.messages[0]?.markdown).toBe("complete");
    expect(backend.getStatusCalls).toBe(1);
    const streamSummaryCall = logger.info.mock.calls.find(
      ([event]) => event === "run.stream-summary",
    );
    expect(streamSummaryCall?.[1]).toMatchObject({
      snapshots: 1,
      maxChunkChars: 7,
    });
    const streamSummary = streamSummaryCall?.[1];
    expect(typeof streamSummary?.streamDurationMs).toBe("number");
    expect(typeof streamSummary?.averageGapMs).toBe("number");
    expect(typeof streamSummary?.maxGapMs).toBe("number");
    subscription.dispose();
    generationSubscription.dispose();
  });

  it("dispatches stop at most once for repeated requests on the same run", async () => {
    const running = runningConversation("stop-single-flight");
    running.run!.status = "starting";
    const backend = new FakeBackend();
    let releaseStop: (() => void) | undefined;
    backend.stopHandler = () =>
      new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
    const controller = await createController(new FakeStore([running]), backend, running.id);

    const firstStop = controller.stop(running.id, "stop-single-flight");
    await controller.stop(running.id, "stop-single-flight");
    expect(backend.stopped).toEqual([{ conversationId: running.id, runId: "stop-single-flight" }]);
    expect(controller.activeConversation?.run?.status).toBe("stopping");

    backend.emit({
      type: "snapshot",
      conversationId: running.id,
      runId: "stop-single-flight",
      markdown: "content already in flight",
    });
    await Promise.resolve();
    expect(controller.activeConversation?.run?.status).toBe("stopping");
    await controller.stop(running.id, "stop-single-flight");
    expect(backend.stopped).toHaveLength(1);

    releaseStop?.();
    await firstStop;
    await controller.stop(running.id, "stop-single-flight");
    expect(backend.stopped).toHaveLength(1);
  });

  it("restores the exact prior run status when stop is rejected", async () => {
    const running = runningConversation("stop-rejected");
    running.run!.status = "starting";
    const backend = new FakeBackend();
    backend.stopFailure = new Error("stop rejected");
    const controller = await createController(new FakeStore([running]), backend, running.id);

    await expect(controller.stop(running.id, "stop-rejected")).rejects.toThrow("stop rejected");

    expect(backend.stopped).toEqual([{ conversationId: running.id, runId: "stop-rejected" }]);
    expect(controller.activeConversation?.run?.status).toBe("starting");
  });

  it("does not let a delayed stop for an older run stop the current run", async () => {
    const running = runningConversation("stop-current-run");
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([running]), backend, running.id);

    await expect(controller.stop(running.id, "stop-older-run")).resolves.toBeUndefined();

    expect(backend.stopped).toEqual([]);
    expect(controller.activeConversation?.run).toMatchObject({
      id: "stop-current-run",
      status: "streaming",
    });
  });

  it("ignores a stale correlated error and only finishes the matching run", async () => {
    const running = runningConversation("run-current");
    const store = new FakeStore([running]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);
    const relayError: RelayErrorPayload = {
      code: "SELECTOR_INCOMPATIBLE",
      message: "selector changed",
      recoverable: true,
    };

    backend.emit({
      type: "error",
      conversationId: running.id,
      runId: "run-stale",
      terminalEventId: "terminal-run-stale",
      error: relayError,
    });
    await vi.waitFor(() => {
      expect(controller.activeConversation?.run?.id).toBe("run-current");
    });

    backend.emit({
      type: "error",
      conversationId: running.id,
      runId: "run-current",
      terminalEventId: "terminal-run-current",
      error: relayError,
    });
    await vi.waitFor(() => {
      expect(controller.activeConversation?.run).toBeUndefined();
    });
    expect(controller.activeConversation?.messages[0]).toMatchObject({
      markdown: "",
      status: "error",
      runError: relayError,
    });
  });

  it("records a conversation prewarm failure without adding a duplicate transcript error", async () => {
    const local = conversation("prewarm-error");
    local.syncStatus = "syncing";
    local.messages.push({
      id: "existing-user",
      role: "user",
      markdown: "保留当前问题",
      status: "complete",
      createdAt: local.createdAt,
    });
    const store = new FakeStore([local]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);

    backend.emit({
      type: "error",
      conversationId: local.id,
      error: {
        code: "CHATGPT_REMOTE_UNAVAILABLE",
        message: "ChatGPT 会话页面暂时不可用。",
        recoverable: true,
      },
    });

    await vi.waitFor(() => expect(controller.activeConversation?.syncStatus).toBe("error"));
    expect(controller.activeConversation?.messages).toHaveLength(1);
    expect(controller.activeConversation?.messages[0]?.markdown).toBe("保留当前问题");
    expect(store.saved.at(-1)?.syncStatus).toBe("error");
  });

  it("keeps a partial answer clean and stores its terminal error structurally", async () => {
    const running = runningConversation("remote-unavailable");
    running.messages[0]!.markdown = "已经收到的部分回答";
    const store = new FakeStore([running]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);
    const error: RelayErrorPayload = {
      code: "CHATGPT_REMOTE_UNAVAILABLE",
      message: "ChatGPT 会话页面暂时不可用。",
      recoverable: true,
    };

    backend.emit({
      type: "error",
      conversationId: running.id,
      runId: "remote-unavailable",
      terminalEventId: "terminal-remote-unavailable",
      error,
    });
    await vi.waitFor(() => expect(controller.activeConversation?.run).toBeUndefined());
    expect(controller.activeConversation?.messages).toHaveLength(1);
    expect(controller.activeConversation?.messages[0]).toMatchObject({
      role: "assistant",
      markdown: "已经收到的部分回答",
      status: "error",
      runError: error,
    });
    expect(controller.activeConversation?.messages[0]?.markdown).not.toMatch(
      /Ask2GPT|CHATGPT_REMOTE_UNAVAILABLE|ChatGPT 会话页面暂时不可用/u,
    );

    backend.emit({
      type: "error",
      conversationId: running.id,
      runId: "remote-unavailable",
      terminalEventId: "terminal-remote-unavailable",
      error,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.activeConversation?.messages[0]).toMatchObject({
      markdown: "已经收到的部分回答",
      runError: error,
    });
  });

  it("normalizes safe remote URLs and treats project aliases as the same mapping", async () => {
    const running = runningConversation("remote-url");
    const store = new FakeStore([running]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);

    for (const remoteUrl of [
      "https://user:password@chatgpt.com/c/id",
      "https://chatgpt.com:444/c/id",
      "https://chatgpt.com/",
      "https://chatgpt.com/c/id/extra",
    ]) {
      backend.emit({
        type: "snapshot",
        conversationId: running.id,
        runId: "remote-url",
        markdown: "partial",
        remoteUrl,
      });
      await Promise.resolve();
      expect(controller.activeConversation?.remoteUrl).toBeUndefined();
    }

    backend.emit({
      type: "snapshot",
      conversationId: running.id,
      runId: "remote-url",
      markdown: "partial",
      remoteUrl: "https://chatgpt.com/c/id?private=value#anchor",
    });
    await Promise.resolve();
    expect(controller.activeConversation?.remoteUrl).toBe("https://chatgpt.com/c/id");

    backend.emit({
      type: "snapshot",
      conversationId: running.id,
      runId: "remote-url",
      markdown: "partial",
      remoteUrl: "https://chatgpt.com/g/project-scope/c/id?private=value",
    });
    await Promise.resolve();
    expect(controller.activeConversation?.remoteUrl).toBe(
      "https://chatgpt.com/g/project-scope/c/id",
    );

    backend.emit({
      type: "complete",
      conversationId: running.id,
      runId: "remote-url",
      terminalEventId: "terminal-remote-url",
      markdown: "complete",
      remoteUrl: "https://chatgpt.com/c/id",
    });
    await vi.waitFor(() => expect(controller.activeConversation?.run).toBeUndefined());
    expect(controller.activeConversation?.remoteUrl).toBe("https://chatgpt.com/c/id");
  });

  it("keeps the exact run authoritative across repeated ChatGPT URL changes", async () => {
    const local = conversation("canonical-promotion");
    const store = new FakeStore([local]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);

    await controller.send("Explain the event loop.");
    const runId = backend.sent.at(-1)!.runId;
    expect(controller.activeConversation?.run?.remoteAdoptionStage).toBe("initial");

    backend.emit({
      type: "snapshot",
      conversationId: local.id,
      runId,
      markdown: "provisional answer",
      remoteUrl: "https://chatgpt.com/c/provisional-a",
    });
    await vi.waitFor(() => {
      expect(controller.activeConversation?.remoteUrl).toBe("https://chatgpt.com/c/provisional-a");
      expect(controller.activeConversation?.run?.remoteAdoptionStage).toBe("canonicalizing");
    });

    backend.emit({
      type: "snapshot",
      conversationId: local.id,
      runId,
      markdown: "canonical answer",
      remoteUrl: "https://chatgpt.com/g/ask2gpt/c/canonical-b",
    });
    await vi.waitFor(() => {
      expect(controller.activeConversation?.remoteUrl).toBe(
        "https://chatgpt.com/g/ask2gpt/c/canonical-b",
      );
      expect(controller.activeConversation?.run?.remoteAdoptionStage).toBe("canonicalizing");
      expect(controller.activeConversation?.messages.at(-1)?.markdown).toBe("canonical answer");
    });

    backend.emit({
      type: "snapshot",
      conversationId: local.id,
      runId,
      markdown: "answer after another visible redirect",
      remoteUrl: "https://chatgpt.com/c/unrelated-c",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.activeConversation?.remoteUrl).toBe("https://chatgpt.com/c/unrelated-c");
    expect(controller.activeConversation?.messages.at(-1)?.markdown).toBe(
      "answer after another visible redirect",
    );

    backend.emit({
      type: "complete",
      conversationId: local.id,
      runId,
      terminalEventId: "terminal-canonical-final",
      markdown: "canonical final answer",
      remoteUrl: "https://chatgpt.com/c/unrelated-c",
    });
    await vi.waitFor(() => expect(controller.activeConversation?.run).toBeUndefined());
    expect(store.saved.at(-1)).toMatchObject({
      id: local.id,
      remoteUrl: "https://chatgpt.com/c/unrelated-c",
      run: undefined,
    });

    backend.emit({
      type: "history",
      conversationId: local.id,
      remoteUrl: "https://chatgpt.com/g/ask2gpt/c/unrelated-c",
      title: "Understanding the event loop",
      messages: [
        { role: "user", markdown: "Explain the event loop." },
        { role: "assistant", markdown: "canonical final answer" },
      ],
      observedAt: new Date().toISOString(),
      complete: true,
    });
    await vi.waitFor(() => expect(controller.activeConversation?.syncStatus).toBe("synced"));
    expect(controller.activeConversation).toMatchObject({
      remoteUrl: "https://chatgpt.com/g/ask2gpt/c/unrelated-c",
      title: "Understanding the event loop",
      titleSource: "chatgpt",
    });
  });

  it("accepts a ChatGPT URL change after a long-running answer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T10:00:00.000Z"));
    const local = conversation("long-answer");
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([local]), backend);

    await controller.send("Explain this in depth.");
    const runId = backend.sent.at(-1)!.runId;
    backend.emit({
      type: "snapshot",
      conversationId: local.id,
      runId,
      markdown: "first part",
      remoteUrl: "https://chatgpt.com/c/provisional-a",
    });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(31_000);
    backend.emit({
      type: "snapshot",
      conversationId: local.id,
      runId,
      markdown: "still streaming after thirty seconds",
      remoteUrl: "https://chatgpt.com/g/ask2gpt/c/canonical-b",
    });
    await Promise.resolve();

    expect(controller.activeConversation?.remoteUrl).toBe(
      "https://chatgpt.com/g/ask2gpt/c/canonical-b",
    );
    expect(controller.activeConversation?.run?.remoteAdoptionStage).toBe("canonicalizing");
    expect(controller.activeConversation?.run?.canonicalizationExpiresAt).toBeUndefined();
    expect(controller.activeConversation?.messages.at(-1)?.markdown).toBe(
      "still streaming after thirty seconds",
    );
  });

  it.each(["complete", "stopped"] as const)(
    "finishes a %s run without leaving a pending URL grant",
    async (type) => {
      const local = conversation(`terminal-${type}`);
      const store = new FakeStore([local]);
      const backend = new FakeBackend();
      const controller = await createController(store, backend);

      await controller.send("Only reply OK.");
      const runId = backend.sent.at(-1)!.runId;
      backend.emit({
        type: "snapshot",
        conversationId: local.id,
        runId,
        markdown: type === "complete" ? "OK" : "",
        remoteUrl: "https://chatgpt.com/c/provisional-a",
      });
      await Promise.resolve();
      backend.emit({
        type,
        conversationId: local.id,
        runId,
        terminalEventId: `terminal-${type}`,
        markdown: type === "complete" ? "OK" : "",
        remoteUrl: "https://chatgpt.com/g/ask2gpt/c/canonical-b",
      });

      await vi.waitFor(() => expect(controller.activeConversation?.run).toBeUndefined());
      expect(controller.activeConversation?.remoteUrl).toBe(
        "https://chatgpt.com/g/ask2gpt/c/canonical-b",
      );
      expect(controller.activeConversation?.pendingRemotePromotion).toBeUndefined();
      expect(store.saved.at(-1)?.pendingRemotePromotion).toBeUndefined();
      expect(store.saved.at(-1)?.messages.at(-1)?.status).toBe(type);
    },
  );

  it("clears a legacy pending marker locally before an immediate follow-up", async () => {
    const local = completedPromotionConversation();
    const store = new FakeStore([local]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);

    await controller.send("Explain why.");

    expect(backend.canonicalizationChecks).toHaveLength(0);
    expect(backend.sent).toHaveLength(1);
    expect(backend.sent[0]?.remoteUrl).toBe("https://chatgpt.com/c/provisional-a");
    expect(controller.activeConversation?.pendingRemotePromotion).toBeUndefined();
    expect(controller.activeConversation?.run?.remoteAdoptionStage).toBe("canonicalizing");
    expect(store.saved.some((saved) => saved.pendingRemotePromotion === undefined)).toBe(true);
  });

  it("clears a legacy pending marker locally before regenerate", async () => {
    const local = completedPromotionConversation();
    const messageId = local.pendingRemotePromotion!.messageId;
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([local]), backend);

    await controller.regenerate(local.id, messageId);

    expect(backend.canonicalizationChecks).toHaveLength(0);
    expect(backend.regenerated).toHaveLength(1);
    expect(controller.activeConversation?.pendingRemotePromotion).toBeUndefined();
    expect(controller.activeConversation?.remoteUrl).toBe("https://chatgpt.com/c/provisional-a");
    expect(controller.activeConversation?.run?.remoteAdoptionStage).toBe("canonicalizing");
  });

  it("re-sends a locally rejected prompt instead of asking ChatGPT to regenerate", async () => {
    const local = conversation("pre-submit-retry");
    local.remoteUrl = "https://chatgpt.com/c/existing";
    local.messages.push(
      {
        id: "failed-user",
        role: "user",
        markdown: "解释这段代码",
        status: "complete",
        createdAt: "2026-01-01T00:00:00.000Z",
        contexts: [explicitContext()],
      },
      {
        id: "failed-assistant",
        role: "assistant",
        markdown: "",
        status: "error",
        createdAt: "2026-01-01T00:00:01.000Z",
        runError: {
          code: "SELECTOR_INCOMPATIBLE",
          message: "ChatGPT 输入框在发送前刷新。",
          recoverable: true,
        },
      },
    );
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([local]), backend, local.id);

    await controller.regenerate(local.id, "failed-assistant");

    expect(backend.regenerated).toHaveLength(0);
    expect(backend.sent).toHaveLength(1);
    expect(backend.sent[0]).toMatchObject({
      conversationId: local.id,
      messageId: "failed-user",
      remoteUrl: local.remoteUrl,
    });
    expect(backend.sent[0]?.prompt).toContain("解释这段代码");
    expect(controller.activeConversation?.messages.at(-1)).toMatchObject({
      id: "failed-assistant",
      markdown: "",
      status: "streaming",
    });
    expect(controller.activeConversation?.messages.at(-1)?.runError).toBeUndefined();
  });

  it("restores a structured run error when a retry dispatch is rejected", async () => {
    const local = conversation("pre-submit-retry-rollback");
    local.messages.push(
      {
        id: "rollback-user",
        role: "user",
        markdown: "解释这段代码",
        status: "complete",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "rollback-assistant",
        role: "assistant",
        markdown: "",
        status: "error",
        createdAt: "2026-01-01T00:00:01.000Z",
        runError: {
          code: "CHATGPT_COMPOSER_MISSING",
          message: "找不到 ChatGPT 输入框。",
          recoverable: true,
        },
      },
    );
    const backend = new FakeBackend();
    backend.sendFailure = new Error("retry dispatch rejected");
    const controller = await createController(new FakeStore([local]), backend, local.id);

    await expect(controller.regenerate(local.id, "rollback-assistant")).rejects.toThrow(
      "retry dispatch rejected",
    );

    expect(controller.activeConversation?.run).toBeUndefined();
    expect(controller.activeConversation?.messages.at(-1)).toMatchObject({
      markdown: "",
      status: "error",
      runError: {
        code: "CHATGPT_COMPOSER_MISSING",
        message: "找不到 ChatGPT 输入框。",
        recoverable: true,
      },
    });
  });

  it("restores a structured run error when regenerate dispatch is rejected", async () => {
    const local = conversation("regenerate-rollback");
    local.messages.push({
      id: "regenerate-assistant",
      role: "assistant",
      markdown: "trusted partial answer",
      status: "error",
      createdAt: "2026-01-01T00:00:01.000Z",
      runError: {
        code: "CHATGPT_REMOTE_UNAVAILABLE",
        message: "ChatGPT conversation temporarily unavailable.",
        recoverable: true,
      },
    });
    const backend = new FakeBackend();
    backend.regenerateFailure = new Error("regenerate rejected");
    const controller = await createController(new FakeStore([local]), backend, local.id);

    await expect(controller.regenerate(local.id, "regenerate-assistant")).rejects.toThrow(
      "regenerate rejected",
    );

    expect(controller.activeConversation?.run).toBeUndefined();
    expect(controller.activeConversation?.messages.at(-1)).toMatchObject({
      markdown: "trusted partial answer",
      status: "error",
      runError: {
        code: "CHATGPT_REMOTE_UNAVAILABLE",
        recoverable: true,
      },
    });
  });

  it("accepts an authenticated complete history snapshot as the owned tab authority", async () => {
    const local = completedPromotionConversation();
    const store = new FakeStore([local]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);
    const observedAt = new Date().toISOString();

    backend.emit({
      type: "history",
      conversationId: local.id,
      remoteUrl: "https://chatgpt.com/g/ask2gpt/c/canonical-b",
      title: "Short answer",
      messages: [
        { role: "user", markdown: "Only reply OK." },
        { role: "assistant", markdown: "OK" },
      ],
      observedAt,
      complete: true,
    });

    await vi.waitFor(() => expect(controller.activeConversation?.syncStatus).toBe("synced"));
    expect(controller.activeConversation).toMatchObject({
      remoteUrl: "https://chatgpt.com/g/ask2gpt/c/canonical-b",
      title: "Short answer",
      titleSource: "chatgpt",
      lastSyncedAt: observedAt,
    });
    expect(controller.activeConversation?.pendingRemotePromotion).toBeUndefined();
    expect(
      controller.activeConversation?.messages.map(({ role, markdown }) => ({
        role,
        markdown,
      })),
    ).toEqual([
      { role: "user", markdown: "Only reply OK." },
      { role: "assistant", markdown: "OK" },
    ]);
    expect(store.saved.at(-1)?.remoteUrl).toBe("https://chatgpt.com/g/ask2gpt/c/canonical-b");
  });

  it("clears a structured run error when complete remote history becomes authoritative", async () => {
    const local = conversation("history-recovers-error");
    local.remoteUrl = "https://chatgpt.com/c/history-recovers-error";
    local.messages.push(
      {
        id: "history-user",
        role: "user",
        markdown: "Explain this",
        status: "complete",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "history-assistant",
        role: "assistant",
        markdown: "Recovered answer",
        status: "error",
        createdAt: "2026-01-01T00:00:01.000Z",
        runError: {
          code: "CHATGPT_REMOTE_UNAVAILABLE",
          message: "The terminal snapshot was temporarily unavailable.",
          recoverable: true,
        },
      },
    );
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([local]), backend, local.id);

    backend.emit({
      type: "history",
      conversationId: local.id,
      remoteUrl: local.remoteUrl,
      messages: [
        { role: "user", markdown: "Explain this" },
        { role: "assistant", markdown: "Recovered answer" },
      ],
      observedAt: "2026-01-01T00:00:02.000Z",
      complete: true,
    });

    await vi.waitFor(() => expect(controller.activeConversation?.syncStatus).toBe("synced"));
    expect(controller.activeConversation?.messages.at(-1)).toMatchObject({
      markdown: "Recovered answer",
      status: "complete",
    });
    expect(controller.activeConversation?.messages.at(-1)?.runError).toBeUndefined();
  });

  it("ignores generation events whose runId does not match the local active run", async () => {
    const running = runningConversation("matching-run");
    running.remoteUrl = "https://chatgpt.com/c/mapped-a";
    running.run!.remoteAdoptionStage = "canonicalizing";
    running.messages.at(-1)!.markdown = "trusted partial answer";
    const store = new FakeStore([running]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);
    const savesBefore = store.saved.length;

    backend.emit({
      type: "complete",
      conversationId: running.id,
      runId: "different-run",
      terminalEventId: "terminal-different-run",
      markdown: "unrelated terminal answer",
      remoteUrl: "https://chatgpt.com/c/other-b",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.activeConversation?.run?.id).toBe("matching-run");
    expect(controller.activeConversation?.remoteUrl).toBe("https://chatgpt.com/c/mapped-a");
    expect(controller.activeConversation?.messages.at(-1)?.markdown).toBe("trusted partial answer");
    expect(store.saved).toHaveLength(savesBefore);
  });

  it("publishes a rejected terminal immediately while its durable receipt is saving", async () => {
    const running = runningConversation("invalid-terminal-url");
    running.remoteUrl = "https://chatgpt.com/c/mapped-a";
    const store = new FakeStore([running]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);
    await Promise.resolve();
    await Promise.resolve();
    const states: AppState[] = [];
    const subscription = controller.onState((state) => states.push(state));
    store.pauseNextSave = true;

    backend.emit({
      type: "complete",
      conversationId: running.id,
      runId: "invalid-terminal-url",
      terminalEventId: "terminal-invalid-url",
      markdown: "untrusted answer",
      remoteUrl: "https://example.com/c/not-chatgpt",
    });

    await vi.waitFor(() => expect(store.pendingSave).toBeDefined());
    expect(
      states.some((state) => {
        const conversation = state.conversations.find((item) => item.id === running.id);
        return conversation?.run === undefined && conversation?.messages.at(-1)?.status === "error";
      }),
    ).toBe(true);
    expect(backend.terminalAcknowledgements).toHaveLength(0);

    store.finishSave();
    await vi.waitFor(() => expect(backend.terminalAcknowledgements).toHaveLength(1));
    subscription.dispose();
  });

  it("persists a matching ChatGPT title but rejects a stale remote conversation", async () => {
    const local = conversation("local question");
    local.remoteUrl = "https://chatgpt.com/g/project-scope/c/current";
    local.messages.push({
      id: "existing-question",
      role: "user",
      markdown: "Existing question",
      status: "complete",
      createdAt: local.createdAt,
    });
    const store = new FakeStore([local]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);
    const originalUpdatedAt = controller.activeConversation?.updatedAt;

    backend.emit({
      type: "title",
      conversationId: local.id,
      title: "Understanding event loops",
      remoteUrl: "https://chatgpt.com/c/current",
      observedAt: new Date().toISOString(),
    });
    await vi.waitFor(() => {
      expect(controller.activeConversation?.title).toBe("Understanding event loops");
    });
    expect(controller.activeConversation?.updatedAt).toBe(originalUpdatedAt);
    expect(controller.activeConversation?.titleSource).toBe("chatgpt");
    expect(store.saved.at(-1)).toMatchObject({
      id: local.id,
      title: "Understanding event loops",
      remoteUrl: "https://chatgpt.com/c/current",
    });

    backend.emit({
      type: "title",
      conversationId: local.id,
      title: "Stale title",
      remoteUrl: "https://chatgpt.com/g/project-scope/c/old",
      observedAt: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.activeConversation?.title).toBe("Understanding event loops");
    expect(controller.activeConversation?.remoteUrl).toBe("https://chatgpt.com/c/current");
  });

  it("routes title updates by conversation id without changing the selected conversation", async () => {
    const selected = conversation("selected-title-route");
    selected.remoteUrl = "https://chatgpt.com/c/selected-title-route";
    const background = conversation("background-title-route");
    background.remoteUrl = "https://chatgpt.com/c/background-title-route";
    const backend = new FakeBackend();
    const controller = await createController(
      new FakeStore([selected, background]),
      backend,
      selected.id,
    );

    backend.emit({
      type: "title",
      conversationId: background.id,
      title: "Background conversation title",
      remoteUrl: background.remoteUrl,
      observedAt: new Date().toISOString(),
    });

    await vi.waitFor(() =>
      expect(
        controller.getState().conversations.find((item) => item.id === background.id)?.title,
      ).toBe("Background conversation title"),
    );
    expect(controller.activeConversation).toMatchObject({
      id: selected.id,
      title: "New conversation",
      remoteUrl: selected.remoteUrl,
    });
  });

  it("ignores a delayed title event older than the latest restored history", async () => {
    const local = conversation("stale-title-after-history");
    local.remoteUrl = "https://chatgpt.com/c/stale-title-after-history";
    local.title = "Current restored title";
    local.titleSource = "chatgpt";
    local.lastSyncedAt = "2026-07-26T10:00:00.000Z";
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([local]), backend, local.id);

    backend.emit({
      type: "title",
      conversationId: local.id,
      title: "Older delayed title",
      remoteUrl: local.remoteUrl,
      observedAt: "2026-07-26T09:59:59.000Z",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.activeConversation).toMatchObject({
      title: "Current restored title",
      titleSource: "chatgpt",
      lastSyncedAt: "2026-07-26T10:00:00.000Z",
    });
  });

  it("rejects accessibility navigation labels from title events and history snapshots", async () => {
    const local = conversation("generic-remote-title");
    local.remoteUrl = "https://chatgpt.com/c/generic-remote-title";
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([local]), backend);

    backend.emit({
      type: "title",
      conversationId: local.id,
      title: "Skip to content",
      remoteUrl: local.remoteUrl,
      observedAt: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.activeConversation).toMatchObject({
      title: "New conversation",
      remoteUrl: local.remoteUrl,
    });
    expect(controller.activeConversation?.titleSource).not.toBe("chatgpt");

    backend.emit({
      type: "history",
      conversationId: local.id,
      remoteUrl: local.remoteUrl,
      title: "主要内容",
      messages: [],
      observedAt: new Date().toISOString(),
      complete: true,
    });
    await vi.waitFor(() => expect(controller.activeConversation?.syncStatus).toBe("synced"));
    expect(controller.activeConversation?.title).toBe("New conversation");
    expect(controller.activeConversation?.titleSource).not.toBe("chatgpt");
  });

  it("rebuilds complete remote history while reusing local identities and contexts", async () => {
    const local = conversation("history-rebuild");
    local.remoteUrl = "https://chatgpt.com/c/remote-history";
    const context = explicitContext();
    const question = "解释 [user_name] *tag* `x` & <safe>";
    const createdAt = local.createdAt;
    local.messages = [
      {
        id: "local-user",
        role: "user",
        markdown: question,
        status: "complete",
        createdAt,
        contexts: [context],
      },
      {
        id: "local-assistant",
        role: "assistant",
        markdown: "旧回答",
        status: "stopped",
        createdAt,
      },
      {
        id: "stale-user",
        role: "user",
        markdown: "本地残留消息",
        status: "complete",
        createdAt,
      },
      {
        id: "local-notice",
        role: "local-notice",
        markdown: "这条提示只存在于本地。",
        status: "complete",
        createdAt,
      },
    ];
    const store = new FakeStore([local]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);
    const observedAt = new Date(Date.now() + 1_000).toISOString();

    backend.emit({
      type: "history",
      conversationId: local.id,
      remoteUrl: "https://chatgpt.com/g/project-scope/c/remote-history",
      title: "代码工作原理",
      messages: [
        {
          role: "user",
          markdown: promptInlinePresentationV1(buildLegacyVisiblePrompt(question, [context])),
        },
        { role: "assistant", markdown: "新回答" },
      ],
      observedAt,
      complete: true,
    });

    await vi.waitFor(() => expect(controller.activeConversation?.title).toBe("代码工作原理"));
    expect(controller.activeConversation?.titleSource).toBe("chatgpt");
    expect(controller.activeConversation?.syncStatus).toBe("synced");
    expect(controller.activeConversation?.lastSyncedAt).toBe(observedAt);
    expect(controller.activeConversation?.remoteUrl).toBe(
      "https://chatgpt.com/g/project-scope/c/remote-history",
    );
    expect(controller.activeConversation?.messages).toEqual([
      expect.objectContaining({
        id: "local-user",
        role: "user",
        markdown: question,
        contexts: [context],
      }),
      expect.objectContaining({
        id: "local-assistant",
        role: "assistant",
        markdown: "新回答",
        status: "complete",
      }),
      expect.objectContaining({ id: "local-notice", role: "local-notice" }),
    ]);
    expect(
      controller.activeConversation?.messages.some((message) => message.id === "stale-user"),
    ).toBe(false);
    expect(store.saved.at(-1)?.messages.map((message) => message.id)).toEqual([
      "local-user",
      "local-assistant",
      "local-notice",
    ]);
  });

  it("keeps version-2 attachment cards compact when ChatGPT decorates the user turn", async () => {
    const local = conversation("packaged-attachment-history");
    local.remoteUrl = "https://chatgpt.com/c/packaged-attachment-history";
    const context = explicitContext();
    const question = "Review [user_name] & <safe>";
    local.messages = [
      {
        id: "packaged-local-user",
        role: "user",
        markdown: question,
        status: "complete",
        createdAt: local.createdAt,
        contexts: [context],
        contextTransportVersion: 2,
      },
      {
        id: "packaged-local-assistant",
        role: "assistant",
        markdown: "Old answer",
        status: "complete",
        createdAt: local.createdAt,
      },
    ];
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([local]), backend, local.id);

    backend.emit({
      type: "history",
      conversationId: local.id,
      remoteUrl: local.remoteUrl,
      messages: [
        {
          role: "user",
          markdown: promptInlinePresentationV1(`${question}\n\nindex.L1-L1.ts`),
        },
        { role: "assistant", markdown: "New answer" },
      ],
      observedAt: new Date().toISOString(),
      complete: true,
    });

    await vi.waitFor(() => expect(controller.activeConversation?.syncStatus).toBe("synced"));
    expect(controller.activeConversation?.messages[0]).toMatchObject({
      id: "packaged-local-user",
      markdown: question,
      contexts: [context],
      contextTransportVersion: 2,
    });
  });

  it("does not fold a remote attachment decoration with a different filename", async () => {
    const local = conversation("mismatched-attachment-history");
    local.remoteUrl = "https://chatgpt.com/c/mismatched-attachment-history";
    const context = explicitContext();
    const question = "Review this selection";
    local.messages = [
      {
        id: "mismatched-local-user",
        role: "user",
        markdown: question,
        status: "complete",
        createdAt: local.createdAt,
        contexts: [context],
        contextTransportVersion: 2,
      },
      {
        id: "mismatched-local-assistant",
        role: "assistant",
        markdown: "Old answer",
        status: "complete",
        createdAt: local.createdAt,
      },
    ];
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([local]), backend, local.id);
    const mismatchedRemote = promptInlinePresentationV1(`${question}\n\nindex.L1-L2.ts`);

    backend.emit({
      type: "history",
      conversationId: local.id,
      remoteUrl: local.remoteUrl,
      messages: [
        { role: "user", markdown: mismatchedRemote },
        { role: "assistant", markdown: "New answer" },
      ],
      observedAt: new Date().toISOString(),
      complete: true,
    });

    await vi.waitFor(() => expect(controller.activeConversation?.syncStatus).toBe("synced"));
    expect(controller.activeConversation?.messages[0]).toMatchObject({
      role: "user",
      markdown: mismatchedRemote,
    });
    expect(controller.activeConversation?.messages[0]?.id).not.toBe("mismatched-local-user");
    expect(controller.activeConversation?.messages[0]?.contexts).toBeUndefined();
  });

  it("merges incomplete remote history without deleting local messages", async () => {
    const local = conversation("partial-history");
    const createdAt = local.createdAt;
    local.messages = [
      {
        id: "user-one",
        role: "user",
        markdown: "问题一",
        status: "complete",
        createdAt,
      },
      {
        id: "assistant-one",
        role: "assistant",
        markdown: "部分",
        status: "stopped",
        createdAt,
      },
      {
        id: "user-two",
        role: "user",
        markdown: "本地草稿",
        status: "complete",
        createdAt,
      },
      {
        id: "notice-one",
        role: "local-notice",
        markdown: "本地提示",
        status: "complete",
        createdAt,
      },
    ];
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([local]), backend);
    backend.emit({
      type: "history",
      conversationId: local.id,
      remoteUrl: "https://chatgpt.com/c/partial-history",
      messages: [
        { role: "user", markdown: "问题一" },
        { role: "assistant", markdown: "完整一些" },
        { role: "user", markdown: "远端问题二" },
        { role: "assistant", markdown: "远端回答二" },
      ],
      observedAt: new Date().toISOString(),
      complete: false,
    });

    await vi.waitFor(() => expect(controller.activeConversation?.messages).toHaveLength(5));
    const messages = controller.activeConversation!.messages;
    expect(messages.map((message) => message.id)).toEqual(
      expect.arrayContaining(["user-one", "assistant-one", "user-two", "notice-one"]),
    );
    expect(messages.find((message) => message.id === "assistant-one")?.markdown).toBe("完整一些");
    expect(messages.find((message) => message.id === "user-two")?.markdown).toBe("远端问题二");
    expect(messages.some((message) => message.markdown === "远端回答二")).toBe(true);
    expect(controller.activeConversation?.syncStatus).toBe("partial");
  });

  it("ignores incomplete history after a completed terminal without rebinding the session", async () => {
    const local = runningConversation("post-terminal-partial");
    local.remoteUrl = "https://chatgpt.com/c/post-terminal-partial";
    const store = new FakeStore([local]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend, local.id);

    backend.emit({
      type: "complete",
      conversationId: local.id,
      runId: "post-terminal-partial",
      terminalEventId: "post-terminal-partial-event",
      markdown: "The complete terminal answer.",
      remoteUrl: local.remoteUrl,
    });
    await vi.waitFor(() =>
      expect(backend.terminalAcknowledgements).toContainEqual({
        conversationId: local.id,
        runId: "post-terminal-partial",
        eventId: "post-terminal-partial-event",
      }),
    );
    const savesAfterTerminal = store.saved.length;

    backend.emit({
      type: "history",
      conversationId: local.id,
      remoteUrl: "https://chatgpt.com/c/unrelated-stale-tab",
      messages: [{ role: "assistant", markdown: "The incomplete terminal ans" }],
      observedAt: new Date(Date.now() + 1_000).toISOString(),
      complete: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.activeConversation).toMatchObject({
      remoteUrl: "https://chatgpt.com/c/post-terminal-partial",
      syncStatus: "partial",
    });
    expect(controller.activeConversation?.lastSyncedAt).toBeUndefined();
    expect(controller.activeConversation?.messages).toHaveLength(1);
    expect(controller.activeConversation?.messages[0]).toMatchObject({
      markdown: "The complete terminal answer.",
      status: "complete",
      terminalReceipt: {
        eventId: "post-terminal-partial-event",
        runId: "post-terminal-partial",
        terminalType: "complete",
      },
    });
    expect(store.saved).toHaveLength(savesAfterTerminal);
  });

  it("keeps the terminal barrier while a later follow-up is running", async () => {
    const local = runningConversation("terminal-before-follow-up");
    local.remoteUrl = "https://chatgpt.com/c/terminal-before-follow-up";
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([local]), backend, local.id);

    backend.emit({
      type: "complete",
      conversationId: local.id,
      runId: "terminal-before-follow-up",
      terminalEventId: "terminal-before-follow-up-event",
      markdown: "First final answer.",
      remoteUrl: local.remoteUrl,
    });
    await vi.waitFor(() =>
      expect(backend.terminalAcknowledgements).toContainEqual({
        conversationId: local.id,
        runId: "terminal-before-follow-up",
        eventId: "terminal-before-follow-up-event",
      }),
    );

    await controller.send("A later follow-up");
    const followUpRunId = controller.activeConversation?.run?.id;
    expect(followUpRunId).toBeDefined();
    expect(followUpRunId).not.toBe("terminal-before-follow-up");
    const messagesBeforeHistory = controller.activeConversation?.messages;

    backend.emit({
      type: "history",
      conversationId: local.id,
      remoteUrl: "https://chatgpt.com/c/unrelated-follow-up-tab",
      messages: [{ role: "assistant", markdown: "Old partial answer." }],
      observedAt: new Date(Date.now() + 1_000).toISOString(),
      complete: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.activeConversation).toMatchObject({
      remoteUrl: "https://chatgpt.com/c/terminal-before-follow-up",
      syncStatus: "syncing",
      run: { id: followUpRunId },
    });
    expect(controller.activeConversation?.messages).toBe(messagesBeforeHistory);
    expect(controller.activeConversation?.messages[0]).toMatchObject({
      markdown: "First final answer.",
      status: "complete",
      terminalReceipt: {
        eventId: "terminal-before-follow-up-event",
        runId: "terminal-before-follow-up",
        terminalType: "complete",
      },
    });
  });

  it("still accepts complete history after a completed terminal", async () => {
    const local = runningConversation("post-terminal-complete-history");
    local.remoteUrl = "https://chatgpt.com/c/provisional-terminal-history";
    const backend = new FakeBackend();
    const store = new FakeStore([local]);
    const controller = await createController(store, backend, local.id);

    backend.emit({
      type: "complete",
      conversationId: local.id,
      runId: "post-terminal-complete-history",
      terminalEventId: "post-terminal-complete-history-event",
      markdown: "The terminal answer.",
      remoteUrl: local.remoteUrl,
    });
    await vi.waitFor(() =>
      expect(backend.terminalAcknowledgements).toContainEqual({
        conversationId: local.id,
        runId: "post-terminal-complete-history",
        eventId: "post-terminal-complete-history-event",
      }),
    );

    const observedAt = new Date(Date.now() + 1_000).toISOString();
    backend.emit({
      type: "history",
      conversationId: local.id,
      remoteUrl: "https://chatgpt.com/c/canonical-terminal-history",
      messages: [{ role: "assistant", markdown: "The canonical answer." }],
      observedAt,
      complete: true,
    });

    await vi.waitFor(() => expect(controller.activeConversation?.syncStatus).toBe("synced"));
    expect(controller.activeConversation).toMatchObject({
      remoteUrl: "https://chatgpt.com/c/canonical-terminal-history",
      lastSyncedAt: observedAt,
    });
    expect(controller.activeConversation?.messages[0]).toMatchObject({
      markdown: "The canonical answer.",
      status: "complete",
      terminalReceipt: {
        eventId: "post-terminal-complete-history-event",
        runId: "post-terminal-complete-history",
        terminalType: "complete",
      },
    });

    const savesAfterCompleteHistory = store.saved.length;
    backend.emit({
      type: "history",
      conversationId: local.id,
      remoteUrl: "https://chatgpt.com/c/stale-after-canonical-history",
      messages: [{ role: "assistant", markdown: "The canonical ans" }],
      observedAt: new Date(Date.parse(observedAt) + 1_000).toISOString(),
      complete: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.activeConversation).toMatchObject({
      remoteUrl: "https://chatgpt.com/c/canonical-terminal-history",
      syncStatus: "synced",
      lastSyncedAt: observedAt,
    });
    expect(controller.activeConversation?.messages[0]).toMatchObject({
      markdown: "The canonical answer.",
      status: "complete",
    });
    expect(store.saved).toHaveLength(savesAfterCompleteHistory);
  });

  it("keeps a folded packaged history snapshot metadata-only during an active run", async () => {
    const local = conversation("folded-partial-history");
    local.remoteUrl = "https://chatgpt.com/c/folded-partial-history";
    const context = explicitContext();
    local.messages = [
      {
        id: "local-context-question",
        role: "user",
        markdown: "解释这段代码",
        status: "complete",
        createdAt: local.createdAt,
        contexts: [context],
      },
      {
        id: "local-streaming-answer",
        role: "assistant",
        markdown: "本地片段",
        status: "streaming",
        createdAt: local.createdAt,
      },
    ];
    local.run = {
      id: "folded-run",
      messageId: "local-streaming-answer",
      status: "streaming",
      startedAt: local.createdAt,
    };
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([local]), backend, local.id);
    const foldedPrompt = promptInlinePresentationV1(
      buildLegacyVisiblePrompt("解释这段代码", [context]),
    );

    backend.emit({
      type: "history",
      conversationId: local.id,
      remoteUrl: local.remoteUrl,
      messages: [
        { role: "user", markdown: foldedPrompt },
        { role: "assistant", markdown: "远端片段" },
      ],
      observedAt: new Date().toISOString(),
      complete: false,
    });

    await vi.waitFor(() => expect(controller.activeConversation?.syncStatus).toBe("partial"));
    expect(controller.activeConversation?.messages).toHaveLength(2);
    expect(controller.activeConversation?.messages[0]).toMatchObject({
      id: "local-context-question",
      markdown: "解释这段代码",
      contexts: [context],
    });
    expect(controller.activeConversation?.messages[1]).toMatchObject({
      id: "local-streaming-answer",
      markdown: "本地片段",
      status: "streaming",
    });
  });

  it("keeps an explicit local title when later ChatGPT snapshots report another title", async () => {
    const local = conversation("local-title");
    local.remoteUrl = "https://chatgpt.com/c/local-title";
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([local]), backend);

    await controller.renameConversation(local.id, "我的本地标题");
    expect(controller.activeConversation?.titleSource).toBe("local");

    backend.emit({
      type: "history",
      conversationId: local.id,
      remoteUrl: local.remoteUrl!,
      title: "ChatGPT 自动标题",
      messages: [],
      observedAt: new Date().toISOString(),
      complete: true,
    });

    await vi.waitFor(() => expect(controller.activeConversation?.syncStatus).toBe("synced"));
    expect(controller.activeConversation?.title).toBe("我的本地标题");
    expect(controller.activeConversation?.titleSource).toBe("local");
  });

  it("does not destructively rebuild a complete history snapshot during an active run", async () => {
    const running = runningConversation("history-active-run");
    const store = new FakeStore([running]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);

    backend.emit({
      type: "history",
      conversationId: running.id,
      remoteUrl: "https://chatgpt.com/c/active-run",
      messages: [],
      observedAt: new Date().toISOString(),
      complete: true,
    });

    await vi.waitFor(() =>
      expect(controller.activeConversation?.remoteUrl).toBe("https://chatgpt.com/c/active-run"),
    );
    expect(controller.activeConversation?.run?.id).toBe("history-active-run");
    expect(controller.activeConversation?.syncStatus).toBe("partial");
    expect(controller.activeConversation?.messages).toHaveLength(1);
    expect(controller.activeConversation?.messages[0]).toMatchObject({
      id: "message-history-active-run",
      status: "streaming",
    });
  });

  it("does not align a virtualized history suffix to older repeated turns during a run", async () => {
    const local = conversation("history-active-repeated-turn");
    const createdAt = local.createdAt;
    local.remoteUrl = "https://chatgpt.com/c/repeated-turn";
    local.messages = [
      {
        id: "user-one",
        role: "user",
        markdown: "只回复 OK",
        status: "complete",
        createdAt,
      },
      {
        id: "assistant-one",
        role: "assistant",
        markdown: "OK",
        status: "complete",
        createdAt,
      },
      {
        id: "user-two",
        role: "user",
        markdown: "只回复 OK",
        status: "complete",
        createdAt,
      },
      {
        id: "assistant-two",
        role: "assistant",
        markdown: "",
        status: "streaming",
        createdAt,
      },
    ];
    local.run = {
      id: "run-two",
      messageId: "assistant-two",
      status: "streaming",
      startedAt: createdAt,
    };
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([local]), backend, local.id);

    backend.emit({
      type: "history",
      conversationId: local.id,
      remoteUrl: local.remoteUrl,
      messages: [
        { role: "user", markdown: "只回复 OK" },
        { role: "assistant", markdown: "当前回答的远端片段" },
      ],
      observedAt: new Date(Date.now() + 1_000).toISOString(),
      complete: false,
    });

    await vi.waitFor(() => expect(controller.activeConversation?.syncStatus).toBe("partial"));
    expect(controller.activeConversation?.messages).toEqual(local.messages);
    expect(controller.activeConversation?.messages.map((message) => message.id)).toEqual([
      "user-one",
      "assistant-one",
      "user-two",
      "assistant-two",
    ]);
    expect(controller.activeConversation?.messages[1]?.markdown).toBe("OK");
    expect(controller.activeConversation?.messages[3]).toMatchObject({
      id: "assistant-two",
      markdown: "",
      status: "streaming",
    });
    expect(controller.activeConversation?.run).toMatchObject({
      id: "run-two",
      messageId: "assistant-two",
    });
  });

  it("does not let an assistant-only partial snapshot overwrite history during a run", async () => {
    const running = runningConversation("history-active-assistant-suffix");
    running.messages.unshift(
      {
        id: "older-user",
        role: "user",
        markdown: "older question",
        status: "complete",
        createdAt: running.createdAt,
      },
      {
        id: "older-assistant",
        role: "assistant",
        markdown: "older answer",
        status: "complete",
        createdAt: running.createdAt,
      },
    );
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([running]), backend, running.id);

    backend.emit({
      type: "history",
      conversationId: running.id,
      remoteUrl: "https://chatgpt.com/c/assistant-suffix",
      messages: [{ role: "assistant", markdown: "unattributed suffix" }],
      observedAt: new Date(Date.now() + 1_000).toISOString(),
      complete: false,
    });

    await vi.waitFor(() =>
      expect(controller.activeConversation?.remoteUrl).toBe(
        "https://chatgpt.com/c/assistant-suffix",
      ),
    );
    expect(controller.activeConversation?.messages[1]).toMatchObject({
      id: "older-assistant",
      markdown: "older answer",
    });
    expect(controller.activeConversation?.messages.at(-1)).toMatchObject({
      id: "message-history-active-assistant-suffix",
      status: "streaming",
    });
  });

  it("rebounds to a different conversation URL from an authenticated history snapshot", async () => {
    const local = conversation("history-url-rebound");
    local.remoteUrl = "https://chatgpt.com/c/current-history";
    local.messages.push({
      id: "existing-user",
      role: "user",
      markdown: "local stale message",
      status: "complete",
      createdAt: local.createdAt,
    });
    const store = new FakeStore([local]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);

    backend.emit({
      type: "history",
      conversationId: local.id,
      remoteUrl: "https://chatgpt.com/c/other-history",
      title: "Visible ChatGPT conversation",
      messages: [{ role: "assistant", markdown: "visible answer" }],
      observedAt: new Date().toISOString(),
      complete: true,
    });

    await vi.waitFor(() => expect(controller.activeConversation?.syncStatus).toBe("synced"));
    expect(controller.activeConversation).toMatchObject({
      remoteUrl: "https://chatgpt.com/c/other-history",
      title: "Visible ChatGPT conversation",
      titleSource: "chatgpt",
    });
    expect(controller.activeConversation?.messages.map((message) => message.markdown)).toEqual([
      "visible answer",
    ]);
    expect(store.saved.at(-1)?.remoteUrl).toBe("https://chatgpt.com/c/other-history");
  });
  it("ignores an out-of-order history snapshot older than the last successful sync", async () => {
    const local = conversation("stale-history");
    local.remoteUrl = "https://chatgpt.com/c/stale-history";
    local.syncStatus = "synced";
    local.lastSyncedAt = "2026-07-26T10:00:00.000Z";
    local.messages.push({
      id: "current-answer",
      role: "assistant",
      markdown: "较新的回答",
      status: "complete",
      createdAt: local.createdAt,
    });
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([local]), backend);

    backend.emit({
      type: "history",
      conversationId: local.id,
      remoteUrl: local.remoteUrl!,
      messages: [{ role: "assistant", markdown: "过期回答" }],
      observedAt: "2026-07-26T09:59:59.000Z",
      complete: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.activeConversation?.messages[0]?.markdown).toBe("较新的回答");
    expect(controller.activeConversation?.lastSyncedAt).toBe("2026-07-26T10:00:00.000Z");
  });

  it("keeps a blank conversation lazy after an idle connection is confirmed", async () => {
    const backend = new FakeBackend();
    backend.status = {
      connected: false,
      authenticated: false,
      activeRuns: 0,
      selectorVersion: 1,
      connection: {
        phase: "waiting-for-browser",
        since: "2026-01-01T00:00:00.000Z",
        browserDetected: false,
        hasStoredTrust: false,
      },
    };
    const ready = conversation("ready");
    const controller = await createController(new FakeStore([ready]), backend);
    const modelRequestsBefore = backend.modelRequests.length;

    backend.emit({
      type: "status",
      status: {
        connected: true,
        authenticated: true,
        activeRuns: 0,
        selectorVersion: 1,
        connection: {
          phase: "ready",
          since: new Date().toISOString(),
          browserDetected: true,
          hasStoredTrust: true,
        },
      },
    });

    await vi.waitFor(() => expect(controller.getState().backend.connection.phase).toBe("ready"));
    expect(controller.activeConversation?.id).toBe(ready.id);
    expect(backend.prepared).toEqual([]);
    expect(backend.modelRequests).toHaveLength(modelRequestsBefore);
  });

  it("clears an expired restored run instead of leaving the conversation permanently busy", async () => {
    const running = runningConversation("expired");
    running.run!.startedAt = "2026-01-01T00:00:00.000Z";
    const store = new FakeStore([running]);
    const controller = await createController(store, new FakeBackend());

    expect(controller.activeConversation?.run).toBeUndefined();
    expect(controller.activeConversation?.messages[0]?.status).toBe("error");
    expect(controller.activeConversation?.messages[0]?.markdown).toBe("");
    expect(controller.activeConversation?.messages[0]?.runError).toMatchObject({
      code: "RESPONSE_TIMEOUT",
      recoverable: true,
    });
    expect(store.saved.some((item) => item.id === running.id && !item.run)).toBe(true);
  });

  it("migrates restored runs away from legacy URL timers and pending grants", async () => {
    const restored = runningConversation("restored-legacy-state");
    restored.remoteUrl = "https://chatgpt.com/c/mapped-a";
    restored.run!.remoteAdoptionStage = "initial";
    restored.run!.canonicalizationExpiresAt = new Date(Date.now() - 60_000).toISOString();
    restored.pendingRemotePromotion = completedPromotionConversation().pendingRemotePromotion;
    const store = new FakeStore([restored]);
    const controller = await createController(store, new FakeBackend());

    expect(controller.activeConversation?.run).toMatchObject({
      id: "restored-legacy-state",
      remoteAdoptionStage: "canonicalizing",
    });
    expect(controller.activeConversation?.run?.canonicalizationExpiresAt).toBeUndefined();
    expect(controller.activeConversation?.pendingRemotePromotion).toBeUndefined();
    expect(store.saved.at(-1)?.run?.remoteAdoptionStage).toBe("canonicalizing");
    expect(store.saved.at(-1)?.pendingRemotePromotion).toBeUndefined();

    const noStoredStage = runningConversation("restored-without-stage");
    noStoredStage.remoteUrl = "https://chatgpt.com/c/mapped-b";
    const noStageController = await createController(
      new FakeStore([noStoredStage]),
      new FakeBackend(),
    );
    expect(noStageController.activeConversation?.run?.remoteAdoptionStage).toBe("canonicalizing");
  });

  it("keeps an active canonicalizing run regardless of a legacy timer value", async () => {
    for (const [suffix, expiresAt] of [
      ["expired-window", new Date(Date.now() - 1_000).toISOString()],
      ["far-future-window", new Date(Date.now() + 5 * 60_000).toISOString()],
    ] as const) {
      const canonicalizing = runningConversation(suffix);
      canonicalizing.remoteUrl = "https://chatgpt.com/c/provisional-a";
      canonicalizing.run!.remoteAdoptionStage = "canonicalizing";
      canonicalizing.run!.canonicalizationExpiresAt = expiresAt;
      const store = new FakeStore([canonicalizing]);
      const controller = await createController(store, new FakeBackend());

      expect(controller.activeConversation?.run?.remoteAdoptionStage).toBe("canonicalizing");
      expect(controller.activeConversation?.run?.canonicalizationExpiresAt).toBeUndefined();
    }
  });

  it("fails a restored locked run that has no remote conversation", async () => {
    const lockedWithoutRemote = runningConversation("locked-without-remote");
    lockedWithoutRemote.run!.remoteAdoptionStage = "locked";
    const store = new FakeStore([lockedWithoutRemote]);
    const controller = await createController(store, new FakeBackend());

    expect(controller.activeConversation?.run).toBeUndefined();
    expect(controller.activeConversation?.messages.at(-1)?.status).toBe("error");
    expect(store.saved.at(-1)?.run).toBeUndefined();
  });
  it("cancels a delayed snapshot save before deleting a conversation", async () => {
    vi.useFakeTimers();
    const initial = conversation("delete-me");
    const store = new FakeStore([initial]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);
    await controller.send("解释事件循环");
    const runId = controller.activeConversation?.run?.id;
    expect(runId).toBeDefined();

    backend.emit({
      type: "snapshot",
      conversationId: initial.id,
      runId: runId!,
      markdown: "partial",
    });
    await Promise.resolve();
    await controller.deleteConversation(initial.id);
    const deleteIndex = store.operations.indexOf(`delete:${initial.id}`);

    await vi.advanceTimersByTimeAsync(500);
    expect(
      store.operations
        .slice(deleteIndex + 1)
        .some((operation) => operation === `save:${initial.id}`),
    ).toBe(false);
  });

  it("persists snapshots with a one-second trailing delay and a five-second max wait", async () => {
    vi.useFakeTimers();
    const initial = conversation("throttled");
    const store = new FakeStore([initial]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);
    await controller.send("解释事件循环");
    const runId = controller.activeConversation?.run?.id;
    const savesAfterSend = store.saved.length;

    for (let index = 0; index < 5; index += 1) {
      backend.emit({
        type: "snapshot",
        conversationId: initial.id,
        runId: runId!,
        markdown: `partial-${index}`,
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(900);
    }
    expect(store.saved).toHaveLength(savesAfterSend);

    backend.emit({
      type: "snapshot",
      conversationId: initial.id,
      runId: runId!,
      markdown: "partial-5",
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(499);
    expect(store.saved).toHaveLength(savesAfterSend);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.saved).toHaveLength(savesAfterSend + 1);
    expect(store.saved.at(-1)?.messages.at(-1)?.markdown).toBe("partial-5");
  });

  it("flushes a terminal answer and prevents an older snapshot timer from overwriting it", async () => {
    vi.useFakeTimers();
    const initial = conversation("terminal");
    const store = new FakeStore([initial]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);
    await controller.send("解释事件循环");
    const runId = controller.activeConversation?.run?.id;

    backend.emit({
      type: "snapshot",
      conversationId: initial.id,
      runId: runId!,
      markdown: "partial",
    });
    await Promise.resolve();
    backend.emit({
      type: "complete",
      conversationId: initial.id,
      runId: runId!,
      terminalEventId: "terminal-flush",
      markdown: "complete",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.saved.at(-1)?.messages.at(-1)?.markdown).toBe("complete");
    const savesAfterComplete = store.saved.length;

    await vi.advanceTimersByTimeAsync(6_000);
    expect(store.saved).toHaveLength(savesAfterComplete);
    expect(controller.activeConversation?.messages.at(-1)?.status).toBe("complete");
  });

  it("shows a terminal answer before its durable write finishes", async () => {
    const initial = conversation("terminal-ui");
    const store = new FakeStore([initial]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);
    await controller.send("解释事件循环");
    const runId = controller.activeConversation?.run?.id;
    store.pauseNextSave = true;

    backend.emit({
      type: "complete",
      conversationId: initial.id,
      runId: runId!,
      terminalEventId: "terminal-ui",
      markdown: "complete",
    });

    await vi.waitFor(() => {
      expect(store.pendingSave).toBeDefined();
      expect(controller.activeConversation?.run).toBeUndefined();
      expect(controller.activeConversation?.messages.at(-1)?.status).toBe("complete");
    });
    expect(backend.terminalAcknowledgements).toHaveLength(0);

    store.finishSave();
    await vi.waitFor(() => expect(store.pendingSave).toBeUndefined());
    expect(store.saved.at(-1)?.messages.at(-1)?.markdown).toBe("complete");
    await vi.waitFor(() =>
      expect(backend.terminalAcknowledgements).toEqual([
        {
          conversationId: initial.id,
          runId,
          eventId: "terminal-ui",
        },
      ]),
    );
  });

  it("shows a terminal error before its durable write finishes", async () => {
    const initial = conversation("terminal-error-ui");
    const store = new FakeStore([initial]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);
    await controller.send("解释事件循环");
    const runId = controller.activeConversation?.run?.id;
    const states: AppState[] = [];
    const subscription = controller.onState((state) => states.push(state));
    store.pauseNextSave = true;

    backend.emit({
      type: "error",
      conversationId: initial.id,
      runId: runId!,
      terminalEventId: "terminal-error-ui",
      error: {
        code: "CHATGPT_COMPOSER_MISSING",
        message: "找不到 ChatGPT 输入框。",
        recoverable: true,
      },
    });

    await vi.waitFor(() => {
      expect(store.pendingSave).toBeDefined();
      expect(states.at(-1)?.conversations[0]?.run).toBeUndefined();
      expect(states.at(-1)?.conversations[0]?.messages.at(-1)?.status).toBe("error");
    });
    expect(backend.terminalAcknowledgements).toHaveLength(0);

    store.finishSave();
    await vi.waitFor(() => expect(store.pendingSave).toBeUndefined());
    await vi.waitFor(() =>
      expect(backend.terminalAcknowledgements).toEqual([
        {
          conversationId: initial.id,
          runId,
          eventId: "terminal-error-ui",
        },
      ]),
    );
    subscription.dispose();
  });

  it("buffers a replayed terminal until encrypted conversations finish loading", async () => {
    const initial = runningConversation("terminal-during-load");
    const store = new FakeStore([initial]);
    store.pauseLoad = true;
    const backend = new FakeBackend();
    const controllerPromise = createController(store, backend);
    await vi.waitFor(() => expect(store.pendingLoad).toBeDefined());

    backend.emit({
      type: "complete",
      conversationId: initial.id,
      runId: "terminal-during-load",
      terminalEventId: "terminal-during-load-event",
      markdown: "replayed while loading",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(backend.terminalAcknowledgements).toHaveLength(0);

    store.finishLoad();
    const controller = await controllerPromise;
    await vi.waitFor(() =>
      expect(backend.terminalAcknowledgements).toEqual([
        {
          conversationId: initial.id,
          runId: "terminal-during-load",
          eventId: "terminal-during-load-event",
        },
      ]),
    );
    expect(controller.activeConversation?.run).toBeUndefined();
    expect(store.saved.at(-1)?.messages[0]).toMatchObject({
      markdown: "replayed while loading",
      status: "complete",
      terminalReceipt: {
        eventId: "terminal-during-load-event",
        runId: "terminal-during-load",
        terminalType: "complete",
      },
    });
  });

  it("serializes duplicate terminal delivery while durable storage is pending", async () => {
    const initial = runningConversation("terminal-single-flight");
    const store = new FakeStore([initial]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);
    const savesBefore = store.saved.length;
    store.pauseNextSave = true;
    const terminal = {
      type: "complete" as const,
      conversationId: initial.id,
      runId: "terminal-single-flight",
      terminalEventId: "terminal-single-flight-event",
      markdown: "complete once",
    };

    backend.emit(terminal);
    await vi.waitFor(() => expect(store.pendingSave).toBeDefined());
    backend.emit(terminal);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.saved).toHaveLength(savesBefore + 1);
    expect(backend.terminalAcknowledgements).toHaveLength(0);
    store.finishSave();
    await vi.waitFor(() =>
      expect(backend.terminalAcknowledgements).toEqual([
        {
          conversationId: initial.id,
          runId: "terminal-single-flight",
          eventId: "terminal-single-flight-event",
        },
      ]),
    );
    expect(controller.activeConversation?.messages).toHaveLength(1);
    expect(controller.activeConversation?.messages[0]?.markdown).toBe("complete once");
  });

  it("re-acknowledges a persisted terminal receipt after Host restart without duplicating it", async () => {
    const initial = conversation("terminal-replay");
    initial.messages.push({
      id: "assistant-terminal-replay",
      role: "assistant",
      markdown: "already persisted",
      status: "complete",
      createdAt: initial.createdAt,
      terminalReceipt: {
        eventId: "terminal-replay-event",
        runId: "terminal-replay-run",
        terminalType: "complete",
      },
    });
    const store = new FakeStore([initial]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);

    backend.emit({
      type: "complete",
      conversationId: initial.id,
      runId: "terminal-replay-run",
      terminalEventId: "terminal-replay-event",
      markdown: "already persisted",
    });

    await vi.waitFor(() =>
      expect(backend.terminalAcknowledgements).toEqual([
        {
          conversationId: initial.id,
          runId: "terminal-replay-run",
          eventId: "terminal-replay-event",
        },
      ]),
    );
    expect(controller.activeConversation?.messages).toHaveLength(1);
    expect(store.saved.at(-1)?.messages).toHaveLength(1);
  });

  it("persists queued follow-ups with their context and model snapshot across reload", async () => {
    const initial = runningConversation("queue-reload-run");
    initial.selectedModelId = "mode-high";
    const store = new FakeStore([initial]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend, initial.id);
    controller.attachSelection(initial.id);

    await controller.enqueueFollowUp(
      "Run the focused tests",
      initial.id,
      "queue-reload-1",
      "queue-reload-run",
    );

    expect(controller.getState().pendingContexts).toEqual([]);
    expect(controller.activeConversation?.queuedFollowUps).toEqual([
      expect.objectContaining({
        id: "queue-reload-1",
        text: "Run the focused tests",
        selectedModelId: "mode-high",
        contexts: [explicitContext()],
        automaticContextIds: [],
      }),
    ]);
    const persisted = structuredClone(store.saved.at(-1)!);
    const reloaded = await createController(
      new FakeStore([persisted]),
      new FakeBackend(),
      initial.id,
    );
    expect(reloaded.activeConversation?.queuedFollowUps).toEqual(
      controller.activeConversation?.queuedFollowUps,
    );
    expect(reloaded.activeConversation?.run?.id).toBe("queue-reload-run");
  });

  it("rejects a delayed follow-up for an older run without attaching it to the current run", async () => {
    const initial = runningConversation("queue-current-run");
    const store = new FakeStore([initial]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend, initial.id);

    await expect(
      controller.enqueueFollowUp(
        "Must not move to the newer run",
        initial.id,
        "queue-stale-request",
        "queue-older-run",
      ),
    ).rejects.toThrow();

    expect(controller.activeConversation?.run?.id).toBe("queue-current-run");
    expect(controller.activeConversation?.queuedFollowUps).toBeUndefined();
    expect(backend.sent).toEqual([]);
  });

  it("deduplicates a queued follow-up by request id on the matching run", async () => {
    const initial = runningConversation("queue-deduplicated-run");
    const controller = await createController(
      new FakeStore([initial]),
      new FakeBackend(),
      initial.id,
    );

    await controller.enqueueFollowUp(
      "Only queue me once",
      initial.id,
      "queue-deduplicated-request",
      "queue-deduplicated-run",
    );
    await controller.enqueueFollowUp(
      "Only queue me once",
      initial.id,
      "queue-deduplicated-request",
      "queue-deduplicated-run",
    );

    expect(controller.activeConversation?.queuedFollowUps).toEqual([
      expect.objectContaining({
        id: "queue-deduplicated-request",
        text: "Only queue me once",
      }),
    ]);
  });

  it("interrupts the exact run and dispatches its follow-up exactly once after stopped settles", async () => {
    const initial = runningConversation("interrupt-target-run");
    const store = new FakeStore([initial]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend, initial.id);

    await controller.interruptWithFollowUp(
      "Only reply AFTER STOP",
      initial.id,
      "interrupt-request-1",
      "interrupt-target-run",
    );

    expect(backend.stopped).toEqual([
      { conversationId: initial.id, runId: "interrupt-target-run" },
    ]);
    expect(controller.activeConversation?.run).toMatchObject({
      id: "interrupt-target-run",
      status: "stopping",
      resumeQueueAfterStop: true,
    });
    expect(controller.activeConversation?.queuedFollowUps).toEqual([
      expect.objectContaining({
        id: "interrupt-request-1",
        text: "Only reply AFTER STOP",
      }),
    ]);

    backend.emit({
      type: "stopped",
      conversationId: initial.id,
      runId: "interrupt-older-run",
      terminalEventId: "interrupt-stale-terminal",
      markdown: "stale",
    });
    await vi.waitFor(() =>
      expect(backend.terminalAcknowledgements).toContainEqual({
        conversationId: initial.id,
        runId: "interrupt-older-run",
        eventId: "interrupt-stale-terminal",
      }),
    );
    expect(backend.sent).toEqual([]);

    const terminal = {
      type: "stopped" as const,
      conversationId: initial.id,
      runId: "interrupt-target-run",
      terminalEventId: "interrupt-target-terminal",
      markdown: "partial answer",
    };
    backend.emit(terminal);

    await vi.waitFor(() => expect(backend.sent).toHaveLength(1));
    expect(backend.sent[0]).toMatchObject({ conversationId: initial.id });
    expect(backend.sent[0]?.prompt).toContain("Only reply AFTER STOP");
    expect(controller.activeConversation?.queuePaused).toBeUndefined();
    expect(controller.activeConversation?.queuedFollowUps).toBeUndefined();
    expect(
      [...(controller.activeConversation?.messages ?? [])]
        .reverse()
        .find((message) => message.role === "user"),
    ).toMatchObject({
      markdown: "Only reply AFTER STOP",
      clientRequestId: "interrupt-request-1",
    });

    backend.emit(terminal);
    await vi.waitFor(() => expect(backend.terminalAcknowledgements).toHaveLength(3));
    expect(backend.sent).toHaveLength(1);
  });

  it("keeps an ordinary stopped run's queued follow-up paused", async () => {
    const initial = runningConversation("ordinary-stop-run");
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([initial]), backend, initial.id);
    await controller.enqueueFollowUp(
      "Wait for manual resume",
      initial.id,
      "ordinary-stop-queue",
      "ordinary-stop-run",
    );

    await controller.stop(initial.id, "ordinary-stop-run");
    expect(controller.activeConversation?.run?.resumeQueueAfterStop).not.toBe(true);
    backend.emit({
      type: "stopped",
      conversationId: initial.id,
      runId: "ordinary-stop-run",
      terminalEventId: "ordinary-stop-terminal",
      markdown: "partial",
    });

    await vi.waitFor(() => expect(controller.activeConversation?.run).toBeUndefined());
    expect(controller.activeConversation?.queuePaused).toBe(true);
    expect(controller.activeConversation?.queuedFollowUps).toHaveLength(1);
    expect(backend.sent).toEqual([]);
  });

  it("keeps one queued item and resolves acceptance when an interrupt stop request fails", async () => {
    const initial = runningConversation("interrupt-stop-failure-run");
    const backend = new FakeBackend();
    backend.stopFailure = new Error("stop transport rejected");
    const controller = await createController(new FakeStore([initial]), backend, initial.id);

    await expect(
      controller.interruptWithFollowUp(
        "Keep this accepted follow-up",
        initial.id,
        "interrupt-stop-failure-request",
        "interrupt-stop-failure-run",
      ),
    ).resolves.toBe("queued");

    expect(backend.stopped).toEqual([
      { conversationId: initial.id, runId: "interrupt-stop-failure-run" },
    ]);
    expect(controller.activeConversation?.queuedFollowUps).toEqual([
      expect.objectContaining({
        id: "interrupt-stop-failure-request",
        text: "Keep this accepted follow-up",
      }),
    ]);
    expect(backend.sent).toEqual([]);
  });

  it("dispatches exactly one queued turn only after durable complete settlement", async () => {
    const initial = runningConversation("queue-complete-run");
    const store = new FakeStore([initial]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend, initial.id);
    await controller.enqueueFollowUp(
      "Only reply NEXT",
      initial.id,
      "queue-next-1",
      "queue-complete-run",
    );
    store.pauseNextSave = true;
    const terminal = {
      type: "complete" as const,
      conversationId: initial.id,
      runId: "queue-complete-run",
      terminalEventId: "queue-complete-terminal",
      markdown: "DONE",
    };

    backend.emit(terminal);
    await vi.waitFor(() => expect(store.pendingSave).toBeDefined());
    backend.emit(terminal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(backend.sent).toHaveLength(0);
    expect(backend.terminalAcknowledgements).toHaveLength(0);

    store.finishSave();
    await vi.waitFor(() => expect(backend.sent).toHaveLength(1));
    expect(backend.terminalAcknowledgements).toEqual([
      {
        conversationId: initial.id,
        runId: "queue-complete-run",
        eventId: "queue-complete-terminal",
      },
    ]);
    expect(backend.sent[0]?.conversationId).toBe(initial.id);
    expect(backend.sent[0]?.prompt).toContain("Only reply NEXT");
    expect(controller.activeConversation?.queuedFollowUps).toBeUndefined();

    backend.emit(terminal);
    await vi.waitFor(() => expect(backend.terminalAcknowledgements).toHaveLength(2));
    expect(backend.sent).toHaveLength(1);
  });

  it.each(["stopped", "error"] as const)(
    "pauses queued work after a %s terminal and dispatches it only on resume",
    async (terminalType) => {
      const initial = runningConversation(`queue-${terminalType}-run`);
      const store = new FakeStore([initial]);
      const backend = new FakeBackend();
      const controller = await createController(store, backend, initial.id);
      await controller.enqueueFollowUp(
        "Resume me",
        initial.id,
        `queue-${terminalType}-1`,
        `queue-${terminalType}-run`,
      );

      if (terminalType === "stopped") {
        backend.emit({
          type: "stopped",
          conversationId: initial.id,
          runId: `queue-${terminalType}-run`,
          terminalEventId: `queue-${terminalType}-terminal`,
          markdown: "partial",
        });
      } else {
        backend.emit({
          type: "error",
          conversationId: initial.id,
          runId: `queue-${terminalType}-run`,
          terminalEventId: `queue-${terminalType}-terminal`,
          error: {
            code: "CHATGPT_REMOTE_UNAVAILABLE",
            message: "temporarily unavailable",
            recoverable: true,
          },
        });
      }

      await vi.waitFor(() => expect(controller.activeConversation?.run).toBeUndefined());
      expect(controller.activeConversation?.queuePaused).toBe(true);
      expect(controller.activeConversation?.queuedFollowUps).toHaveLength(1);
      expect(backend.sent).toHaveLength(0);

      await controller.resumeQueue(initial.id);
      expect(backend.sent).toHaveLength(1);
      expect(controller.activeConversation?.queuePaused).toBeUndefined();
      expect(controller.activeConversation?.queuedFollowUps).toBeUndefined();
    },
  );

  it("keeps queued follow-ups isolated while switching conversations", async () => {
    const first = runningConversation("queue-isolated-a");
    const second = runningConversation("queue-isolated-b");
    const backend = new FakeBackend();
    const controller = await createController(new FakeStore([first, second]), backend, first.id);
    await controller.enqueueFollowUp("Message A", first.id, "queue-a", "queue-isolated-a");
    await controller.selectConversation(second.id);
    await controller.enqueueFollowUp("Message B", second.id, "queue-b", "queue-isolated-b");

    const state = controller.getState();
    expect(
      state.conversations.find((item) => item.id === first.id)?.queuedFollowUps?.[0]?.text,
    ).toBe("Message A");
    expect(
      state.conversations.find((item) => item.id === second.id)?.queuedFollowUps?.[0]?.text,
    ).toBe("Message B");

    backend.emit({
      type: "complete",
      conversationId: first.id,
      runId: "queue-isolated-a",
      terminalEventId: "queue-isolated-a-terminal",
      markdown: "A done",
    });
    await vi.waitFor(() => expect(backend.sent).toHaveLength(1));
    expect(backend.sent[0]?.conversationId).toBe(first.id);
    expect(
      controller.getState().conversations.find((item) => item.id === second.id)
        ?.queuedFollowUps?.[0]?.text,
    ).toBe("Message B");
  });

  it("re-scans other conversations' queues whenever terminal settlement frees capacity", async () => {
    const waiting = conversation("queue-waiting-capacity");
    waiting.queuedFollowUps = [
      {
        id: "queue-after-capacity",
        text: "Dispatch when any slot is free",
        contexts: [],
        automaticContextIds: [],
        selectedModelId: "mode-smart",
        createdAt: new Date().toISOString(),
      },
    ];
    const runningA = runningConversation("capacity-a");
    const runningB = runningConversation("capacity-b");
    const runningC = runningConversation("capacity-c");
    const backend = new FakeBackend();
    const controller = await createController(
      new FakeStore([waiting, runningA, runningB, runningC]),
      backend,
      waiting.id,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(backend.sent).toHaveLength(0);

    backend.emit({
      type: "complete",
      conversationId: runningB.id,
      runId: "capacity-b",
      terminalEventId: "capacity-b-terminal",
      markdown: "slot released",
    });

    await vi.waitFor(() => expect(backend.sent).toHaveLength(1));
    expect(backend.sent[0]?.conversationId).toBe(waiting.id);
    expect(backend.sent[0]?.prompt).toContain("Dispatch when any slot is free");
    expect(
      controller.getState().conversations.find((conversation) => conversation.id === waiting.id)
        ?.queuedFollowUps,
    ).toBeUndefined();
  });

  it("keeps a completed answer when a correlated run error arrives late", async () => {
    const initial = runningConversation("terminal-late-error");
    const store = new FakeStore([initial]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);

    backend.emit({
      type: "snapshot",
      conversationId: initial.id,
      runId: "terminal-late-error",
      markdown: "OK",
    });
    backend.emit({
      type: "complete",
      conversationId: initial.id,
      runId: "terminal-late-error",
      terminalEventId: "terminal-complete-event",
      markdown: "OK",
    });
    await vi.waitFor(() =>
      expect(backend.terminalAcknowledgements).toContainEqual({
        conversationId: initial.id,
        runId: "terminal-late-error",
        eventId: "terminal-complete-event",
      }),
    );
    const savesAfterCompletion = store.saved.length;

    backend.emit({
      type: "error",
      conversationId: initial.id,
      runId: "terminal-late-error",
      terminalEventId: "terminal-late-error-event",
      error: {
        code: "CHATGPT_REMOTE_UNAVAILABLE",
        message: "ChatGPT conversation temporarily unavailable.",
        recoverable: true,
      },
    });

    await vi.waitFor(() =>
      expect(backend.terminalAcknowledgements).toContainEqual({
        conversationId: initial.id,
        runId: "terminal-late-error",
        eventId: "terminal-late-error-event",
      }),
    );
    expect(store.saved).toHaveLength(savesAfterCompletion);
    expect(controller.activeConversation?.run).toBeUndefined();
    expect(controller.activeConversation?.syncStatus).toBe("partial");
    expect(controller.activeConversation?.messages).toHaveLength(1);
    expect(controller.activeConversation?.messages[0]).toMatchObject({
      markdown: "OK",
      status: "complete",
      terminalReceipt: {
        eventId: "terminal-complete-event",
        runId: "terminal-late-error",
        terminalType: "complete",
      },
    });
    expect(controller.activeConversation?.messages[0]?.runError).toBeUndefined();
  });

  it("acknowledges but does not apply a conflicting terminal event for a persisted run", async () => {
    const initial = conversation("terminal-conflict");
    initial.messages.push({
      id: "assistant-terminal-conflict",
      role: "assistant",
      markdown: "durable answer",
      status: "complete",
      createdAt: initial.createdAt,
      terminalReceipt: {
        eventId: "terminal-original-event",
        runId: "terminal-conflict-run",
        terminalType: "complete",
      },
    });
    const store = new FakeStore([initial]);
    const backend = new FakeBackend();
    const controller = await createController(store, backend);
    const savesBefore = store.saved.length;

    backend.emit({
      type: "stopped",
      conversationId: initial.id,
      runId: "terminal-conflict-run",
      terminalEventId: "terminal-conflicting-event",
      markdown: "must not replace durable answer",
    });

    await vi.waitFor(() =>
      expect(backend.terminalAcknowledgements).toEqual([
        {
          conversationId: initial.id,
          runId: "terminal-conflict-run",
          eventId: "terminal-conflicting-event",
        },
      ]),
    );
    expect(store.saved).toHaveLength(savesBefore);
    expect(controller.activeConversation?.messages).toHaveLength(1);
    expect(controller.activeConversation?.messages[0]?.markdown).toBe("durable answer");
    expect(controller.activeConversation?.messages[0]?.status).toBe("complete");
  });

  it("re-resolves the deletion target after concurrent conversation insertion", async () => {
    const initial = conversation("delete-race");
    const store = new FakeStore([initial]);
    store.pauseDeletion = true;
    const controller = await createController(store, new FakeBackend());

    const deletion = controller.deleteConversation(initial.id);
    await vi.waitFor(() => expect(store.pendingDelete).toBeDefined());
    const replacement = await controller.newConversation();
    store.finishDeletion();
    await deletion;

    expect(controller.getState().conversations.map((item) => item.id)).toContain(replacement.id);
    expect(controller.getState().conversations.map((item) => item.id)).not.toContain(initial.id);
  });

  it("persists a disconnected tab close and flushes it after relay authentication", async () => {
    const initial = conversation("offline-delete");
    const backend = new FakeBackend();
    backend.status = {
      connected: false,
      authenticated: false,
      activeRuns: 0,
      selectorVersion: 1,
      connection: {
        phase: "waiting-for-browser",
        since: "2026-01-01T00:00:00.000Z",
        browserDetected: false,
        hasStoredTrust: true,
      },
    };
    backend.closeDelivered = false;
    const workspaceState = new Map<string, unknown>();
    const controller = await createController(
      new FakeStore([initial]),
      backend,
      initial.id,
      workspaceState,
    );

    await controller.deleteConversation(initial.id);
    expect(workspaceState.get("ask2gpt.pendingTabCloses.v1")).toEqual([initial.id]);

    backend.closeDelivered = true;
    backend.emit({
      type: "status",
      status: {
        connected: true,
        authenticated: true,
        activeRuns: 0,
        selectorVersion: 1,
      },
    });

    await vi.waitFor(() => {
      expect(workspaceState.get("ask2gpt.pendingTabCloses.v1")).toEqual([]);
    });
    expect(backend.closed.filter((id) => id === initial.id)).toHaveLength(2);
  });
});

class FakeStore {
  readonly saved: Conversation[] = [];
  readonly operations: string[] = [];
  pauseDeletion = false;
  pauseNextSave = false;
  failNextSave?: Error;
  pauseLoad = false;
  pendingLoad?: Promise<Conversation[]>;
  pendingSave?: Promise<void>;
  pendingDelete?: Promise<void>;
  private finishPendingSave?: () => void;
  private finishPendingDelete?: () => void;
  private finishPendingLoad?: () => void;

  constructor(private readonly initial: Conversation[]) {}

  loadAll() {
    if (!this.pauseLoad) return Promise.resolve(structuredClone(this.initial));
    this.pendingLoad = new Promise<Conversation[]>((resolve) => {
      this.finishPendingLoad = () => {
        this.pendingLoad = undefined;
        resolve(structuredClone(this.initial));
      };
    });
    return this.pendingLoad;
  }

  getLoadReport(): ConversationStoreLoadReport {
    return {
      records: this.initial.length,
      recoveredFromBackup: 0,
      unreadable: 0,
      migrated: 0,
      repairFailures: 0,
      migrationFailures: 0,
    };
  }

  save(value: Conversation) {
    this.saved.push(structuredClone(value));
    this.operations.push(`save:${value.id}`);
    if (this.failNextSave) {
      const error = this.failNextSave;
      this.failNextSave = undefined;
      return Promise.reject(error);
    }
    if (this.pauseNextSave) {
      this.pauseNextSave = false;
      this.pendingSave = new Promise<void>((resolve) => {
        this.finishPendingSave = () => {
          this.pendingSave = undefined;
          resolve();
        };
      });
      return this.pendingSave;
    }
    return Promise.resolve();
  }

  delete(id: string) {
    this.operations.push(`delete:${id}`);
    if (!this.pauseDeletion) return Promise.resolve();
    this.pendingDelete = new Promise<void>((resolve) => {
      this.finishPendingDelete = resolve;
    });
    return this.pendingDelete;
  }

  finishDeletion() {
    this.finishPendingDelete?.();
  }

  finishSave() {
    this.finishPendingSave?.();
  }

  finishLoad() {
    this.finishPendingLoad?.();
  }
}

class FakeBackend implements ChatBackend {
  sendFailure?: Error;
  regenerateFailure?: Error;
  stopFailure?: Error;
  stopHandler?: (conversationId: string, runId: string) => Promise<void>;
  sendHandler?: (request: SendRequest) => Promise<{
    conversationId: string;
    runId: string;
    startedAt: string;
  }>;
  canonicalizationResult?: ConversationCanonicalizationResultPayload;
  canonicalizationHandler?: (
    conversationId: string,
    promotion: PendingRemotePromotion,
  ) => Promise<ConversationCanonicalizationResultPayload>;
  closeDelivered = true;
  releaseDelivered = true;
  releaseFailure?: Error;
  releaseHandler?: (
    conversationId: string,
    purpose: ConversationLeasePurpose,
    reason: ConversationReleaseReason,
  ) => Promise<boolean>;
  prepareHandler?: (
    conversationId: string,
    remoteUrl?: string,
    transcriptProof?: ConversationTranscriptProof,
    dispatchIntent?: boolean,
  ) => Promise<void>;
  status: BackendStatus = {
    connected: true,
    authenticated: true,
    activeRuns: 0,
    selectorVersion: 1,
    connection: {
      phase: "ready",
      since: "2026-01-01T00:00:00.000Z",
      browserDetected: true,
      hasStoredTrust: true,
    },
  };
  readonly sent: SendRequest[] = [];
  readonly prepared: Array<{
    conversationId: string;
    dispatchIntent?: boolean;
    remoteUrl?: string;
    transcriptProof?: ConversationTranscriptProof;
  }> = [];
  readonly regenerated: Array<{ conversationId: string; messageId: string; runId: string }> = [];
  readonly stopped: Array<{ conversationId: string; runId: string }> = [];
  readonly closed: string[] = [];
  readonly released: Array<{
    conversationId: string;
    purpose: ConversationLeasePurpose;
    reason: ConversationReleaseReason;
  }> = [];
  readonly terminalAcknowledgements: Array<{
    conversationId: string;
    runId: string;
    eventId: string;
  }> = [];
  readonly modelRequests: Array<{ conversationId: string; remoteUrl?: string }> = [];
  readonly canonicalizationChecks: Array<{
    conversationId: string;
    promotion: PendingRemotePromotion;
  }> = [];
  modelOptions: ChatModelOption[] = [
    {
      id: "mode-smart",
      label: "Smart",
      mode: "smart",
      modelId: "gpt-5-5",
      selected: true,
    },
    {
      id: "mode-fast",
      label: "Fast",
      mode: "fast",
      modelId: "gpt-5-5-instant",
      selected: false,
    },
  ];
  modelSelectionHandler?: (
    modelId: string,
  ) => Promise<{ id: string; label: string; selected: true }>;
  getStatusCalls = 0;
  private listener?: (event: BackendEvent) => void;

  getStatus(): Promise<BackendStatus> {
    this.getStatusCalls += 1;
    return Promise.resolve({ ...this.status });
  }

  prepareConversation(
    conversationId: string,
    remoteUrl?: string,
    transcriptProof?: ConversationTranscriptProof,
    dispatchIntent = false,
  ) {
    this.prepared.push({
      conversationId,
      ...(dispatchIntent ? { dispatchIntent } : {}),
      remoteUrl,
      ...(transcriptProof ? { transcriptProof } : {}),
    });
    if (this.prepareHandler) {
      return this.prepareHandler(conversationId, remoteUrl, transcriptProof, dispatchIntent);
    }
    return Promise.resolve();
  }

  settlePendingRemotePromotion(
    conversationId: string,
    promotion: PendingRemotePromotion,
  ): Promise<ConversationCanonicalizationResultPayload> {
    this.canonicalizationChecks.push({
      conversationId,
      promotion: structuredClone(promotion),
    });
    if (this.canonicalizationHandler) {
      return this.canonicalizationHandler(conversationId, promotion);
    }
    return Promise.resolve(
      this.canonicalizationResult ?? {
        requestId: "canonicalization-check",
        runId: promotion.runId,
        fromRemoteUrl: promotion.fromRemoteUrl,
        terminalMarkdownSha256: promotion.terminalMarkdownSha256,
        terminalTranscriptSha256: promotion.terminalTranscriptSha256,
        status: "unchanged",
        remoteUrl: promotion.fromRemoteUrl,
      },
    );
  }

  send(request: SendRequest) {
    if (this.sendFailure) return Promise.reject(this.sendFailure);
    this.sent.push(request);
    if (this.sendHandler) return this.sendHandler(request);
    return Promise.resolve({
      conversationId: request.conversationId,
      runId: request.runId,
      startedAt: new Date().toISOString(),
    });
  }

  stop(conversationId: string, runId: string) {
    this.stopped.push({ conversationId, runId });
    if (this.stopFailure) return Promise.reject(this.stopFailure);
    if (this.stopHandler) return this.stopHandler(conversationId, runId);
    return Promise.resolve();
  }

  regenerate(conversationId: string, messageId: string, runId: string) {
    this.regenerated.push({ conversationId, messageId, runId });
    if (this.regenerateFailure) return Promise.reject(this.regenerateFailure);
    return Promise.resolve({
      conversationId,
      runId,
      startedAt: new Date().toISOString(),
    });
  }

  listModels(conversationId: string, remoteUrl?: string) {
    this.modelRequests.push({ conversationId, remoteUrl });
    return Promise.resolve(this.modelOptions.map((option) => ({ ...option })));
  }

  selectModel(_conversationId: string, modelId: string) {
    if (this.modelSelectionHandler) return this.modelSelectionHandler(modelId);
    return Promise.resolve({ id: modelId, label: "Selected model", selected: true });
  }

  closeConversation(conversationId: string) {
    this.closed.push(conversationId);
    return Promise.resolve(this.closeDelivered);
  }

  releaseConversation(
    conversationId: string,
    purpose: ConversationLeasePurpose = "view",
    reason: ConversationReleaseReason = "inactive",
  ) {
    this.released.push({ conversationId, purpose, reason });
    if (this.releaseHandler) return this.releaseHandler(conversationId, purpose, reason);
    if (this.releaseFailure) return Promise.reject(this.releaseFailure);
    return Promise.resolve(this.releaseDelivered);
  }

  acknowledgeTerminal(conversationId: string, runId: string, eventId: string) {
    this.terminalAcknowledgements.push({ conversationId, runId, eventId });
    return Promise.resolve();
  }

  onEvent(listener: (event: BackendEvent) => void) {
    this.listener = listener;
    return { dispose: () => (this.listener = undefined) };
  }

  dispose() {
    return Promise.resolve();
  }

  emit(event: BackendEvent) {
    if (event.type === "status") {
      this.status = {
        ...this.status,
        ...event.status,
        connection: event.status.connection ?? this.status.connection,
      };
    }
    this.listener?.(event);
  }
}

async function createController(
  store: FakeStore,
  backend: FakeBackend,
  activeConversationId?: string,
  workspaceState = new Map<string, unknown>(),
  captureFiles: () => Promise<ContextSnapshot[]> = async () => [
    {
      ...explicitContext(),
      id: "context-2",
      kind: "file" as const,
      fileName: "other.ts",
      uri: "file:///other.ts",
      content: "export const other = true;",
      charCount: 26,
    },
  ],
  captureSelection: (reference?: SelectionReference) => ContextSnapshot = () => explicitContext(),
  updateWorkspaceState: (key: string, value: unknown) => Promise<void> = (key, value) => {
    workspaceState.set(key, value);
    return Promise.resolve();
  },
  captureNotebookCells: (
    references?: readonly NotebookCellReference[],
  ) => ContextSnapshot[] = () => [],
) {
  if (activeConversationId) {
    workspaceState.set("ask2gpt.activeConversationId", activeConversationId);
  }
  const context = {
    workspaceState: {
      get: (key: string) => workspaceState.get(key),
      update: updateWorkspaceState,
    },
  };
  const contextService = {
    captureSelection,
    captureCurrentFile: () => explicitContext(),
    captureFiles,
    captureNotebookCells,
  };
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
  };
  const controller = new Ask2GPTController(
    context as never,
    store as unknown as ConversationStore,
    contextService as unknown as ContextService,
    backend,
    logger as unknown as SafeLogger,
    "instance-1",
  );
  controllers.push(controller);
  await controller.initialize();
  return controller;
}

function conversation(suffix: string): Conversation {
  return {
    id: `conversation-${suffix}`,
    title: "New conversation",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
  };
}

function runningConversation(runId: string): Conversation {
  const value = conversation(runId);
  value.messages.push({
    id: `message-${runId}`,
    role: "assistant",
    markdown: "",
    status: "streaming",
    createdAt: new Date().toISOString(),
  });
  value.run = {
    id: runId,
    messageId: `message-${runId}`,
    status: "streaming",
    startedAt: new Date().toISOString(),
  };
  return value;
}

function completedPromotionConversation(): Conversation {
  const value = conversation("completed-promotion");
  value.remoteUrl = "https://chatgpt.com/c/provisional-a";
  value.messages.push({
    id: "completed-assistant",
    role: "assistant",
    markdown: "OK",
    status: "complete",
    createdAt: new Date().toISOString(),
  });
  value.pendingRemotePromotion = {
    runId: "completed-run",
    messageId: "completed-assistant",
    fromRemoteUrl: "https://chatgpt.com/c/provisional-a",
    terminalMarkdownSha256: sha256("OK"),
    terminalTranscriptSha256: transcriptSha256([{ role: "assistant", markdown: "OK" }]),
    terminalStatus: "complete",
    expiresAt: new Date(Date.now() + 20_000).toISOString(),
  };
  return value;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function promptInlinePresentationV1(value: string) {
  return value
    .replace(/\s+/gu, " ")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/([\\`[\]*_])/gu, "\\$1")
    .trim();
}

function transcriptSha256(messages: readonly { role: "user" | "assistant"; markdown: string }[]) {
  return sha256(JSON.stringify(messages.map((message) => [message.role, message.markdown])));
}

function explicitContext(): ContextSnapshot {
  return {
    id: "context-1",
    kind: "selection",
    fileName: "index.ts",
    uri: "file:///index.ts",
    language: "typescript",
    startLine: 1,
    endLine: 1,
    content: "const answer = 42;",
    charCount: 18,
    unsaved: false,
  };
}

function selectionReference(): SelectionReference {
  return {
    uri: "file:///index.ts",
    documentVersion: 3,
    startLine: 0,
    startCharacter: 0,
    endLine: 0,
    endCharacter: 18,
  };
}

function notebookReference(cellIndex: number): NotebookCellReference {
  const contentHash = sha256("pass");
  return {
    type: "notebook-cell",
    notebookUri: "file:///analysis.ipynb",
    notebookType: "jupyter-notebook",
    notebookVersion: 4,
    cellUri: `vscode-notebook-cell:/analysis.ipynb#${cellIndex}`,
    cellIndex,
    cellKind: "code",
    cellLanguage: "python",
    cellDocumentVersion: 3,
    cellContentSha256: contentHash,
    normalizedCellContentSha256: contentHash,
    scope: "cell",
    startLine: 0,
    startCharacter: 0,
    endLine: 0,
    endCharacter: 0,
  };
}

function notebookContext(cellIndex: number): ContextSnapshot {
  const content = "pass";
  const contentHash = sha256(content);
  return {
    id: `notebook-context-${cellIndex}`,
    kind: "selection",
    fileName: "analysis.ipynb",
    uri: "file:///analysis.ipynb",
    language: "python",
    startLine: 1,
    endLine: 1,
    content,
    charCount: content.length,
    unsaved: false,
    sourceAnchor: {
      formatVersion: 2,
      notebookUri: "file:///analysis.ipynb",
      notebookType: "jupyter-notebook",
      notebookVersion: 4,
      cellIndex,
      cellKind: "code",
      cellLanguage: "python",
      scope: "cell",
      documentVersion: 3,
      range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 4 },
      contentSha256: contentHash,
      normalizedContentSha256: contentHash,
      cellContentSha256: contentHash,
      normalizedCellContentSha256: contentHash,
    },
  };
}
