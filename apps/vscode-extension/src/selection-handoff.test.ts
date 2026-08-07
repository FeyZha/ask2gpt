import { describe, expect, it, vi } from "vitest";

import { createActiveSelectionCommand, createSelectionHandoff } from "./selection-handoff";
import type { SelectionReference } from "./selection-reference";

describe("createSelectionHandoff", () => {
  it("queues the captured range before focusing the composer", async () => {
    const order: string[] = [];
    const reference = selectionReference();
    const controller = {
      attachSelectionToActiveConversation: vi.fn(async (received: SelectionReference) => {
        order.push("attach");
        expect(received).toBe(reference);
        return true;
      }),
      send: vi.fn(),
    };
    const view = {
      show: vi.fn(async (focusComposer?: boolean) => {
        order.push(`show:${String(focusComposer)}`);
      }),
    };

    const command = createSelectionHandoff(controller, view);
    await command(reference);

    expect(order).toEqual(["attach", "show:true"]);
    expect(controller.attachSelectionToActiveConversation).toHaveBeenCalledOnce();
    expect(controller.attachSelectionToActiveConversation).toHaveBeenCalledWith(reference);
    expect(controller.send).not.toHaveBeenCalled();
  });

  it("does nothing when no conversation owns the composer", async () => {
    const controller = {
      attachSelectionToActiveConversation: vi.fn(async () => false),
    };
    const view = { show: vi.fn(async () => undefined) };

    await createSelectionHandoff(controller, view)(selectionReference());

    expect(controller.attachSelectionToActiveConversation).toHaveBeenCalledOnce();
    expect(view.show).not.toHaveBeenCalled();
  });

  it("does not reveal the composer when the tracked selection is rejected", async () => {
    const controller = {
      attachSelectionToActiveConversation: vi.fn(async () => {
        throw new Error("SELECTION_STALE");
      }),
      send: vi.fn(),
    };
    const view = { show: vi.fn(async () => undefined) };
    const command = createSelectionHandoff(controller, view);

    await expect(command(selectionReference())).rejects.toThrow("SELECTION_STALE");

    expect(view.show).not.toHaveBeenCalled();
    expect(controller.send).not.toHaveBeenCalled();
  });

  it("ignores handoffs without a captured editor selection", async () => {
    const controller = {
      attachSelectionToActiveConversation: vi.fn(async () => true),
    };
    const view = { show: vi.fn(async () => undefined) };

    await createSelectionHandoff(controller, view)();

    expect(controller.attachSelectionToActiveConversation).not.toHaveBeenCalled();
    expect(view.show).not.toHaveBeenCalled();
  });

  it("waits for the navigation fence before revealing the composer", async () => {
    let release!: (attached: boolean) => void;
    const controller = {
      attachSelectionToActiveConversation: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const view = { show: vi.fn(async () => undefined) };

    const handoff = createSelectionHandoff(controller, view)(selectionReference());
    await vi.waitFor(() =>
      expect(controller.attachSelectionToActiveConversation).toHaveBeenCalled(),
    );
    expect(view.show).not.toHaveBeenCalled();

    release(true);
    await handoff;

    expect(view.show).toHaveBeenCalledWith(true);
  });
});

describe("createActiveSelectionCommand", () => {
  it("captures the active editor selection and ignores implicit menu arguments", async () => {
    const reference = selectionReference();
    const captureSelection = vi.fn(() => reference);
    const handoff = vi.fn(async () => undefined);
    const command = createActiveSelectionCommand(captureSelection, handoff);

    await command({ scheme: "file", path: "/repo/src/index.ts" });

    expect(captureSelection).toHaveBeenCalledOnce();
    expect(handoff).toHaveBeenCalledWith(reference);
  });

  it("uses an exact pre-captured range instead of recapturing editor state", async () => {
    const reference = selectionReference();
    const captureSelection = vi.fn(() => ({ ...reference, startLine: 20 }));
    const handoff = vi.fn(async () => undefined);
    const command = createActiveSelectionCommand(captureSelection, handoff);

    await command(reference);

    expect(captureSelection).not.toHaveBeenCalled();
    expect(handoff).toHaveBeenCalledWith(reference);
  });

  it("rejects malformed internal arguments and safely recaptures the active selection", async () => {
    const reference = selectionReference();
    const captureSelection = vi.fn(() => reference);
    const handoff = vi.fn(async () => undefined);
    const command = createActiveSelectionCommand(captureSelection, handoff);

    await command({ ...reference, endLine: reference.startLine, endCharacter: 0 });

    expect(captureSelection).toHaveBeenCalledOnce();
    expect(handoff).toHaveBeenCalledWith(reference);
  });
});

function selectionReference(): SelectionReference {
  return {
    uri: "file:///repo/src/index.ts",
    documentVersion: 4,
    startLine: 3,
    startCharacter: 0,
    endLine: 5,
    endCharacter: 1,
  };
}
