import type { SelectionReference } from "./selection-reference";

export const ATTACH_SELECTION_COMMAND = "ask2gpt.attachSelection";

interface SelectionAttachController {
  attachSelectionToActiveConversation(reference: SelectionReference): Promise<boolean>;
}

interface ComposerView {
  show(focusComposer?: boolean): Promise<void>;
}

export function createActiveSelectionCommand(
  captureSelection: () => SelectionReference | undefined,
  handoff: (reference?: SelectionReference) => Promise<void>,
) {
  return (codeActionReference?: unknown, ..._implicitArguments: unknown[]) =>
    handoff(isSelectionReference(codeActionReference) ? codeActionReference : captureSelection());
}

/**
 * Queues the captured range on the controller's conversation-navigation
 * fence before revealing the sidebar. The controller resolves the active
 * destination when that queue position runs, so New and selection clicks
 * preserve their user-visible order without a focus/layout race.
 */
export function createSelectionHandoff(controller: SelectionAttachController, view: ComposerView) {
  return async (reference?: SelectionReference) => {
    if (!reference) return;
    if (!(await controller.attachSelectionToActiveConversation(reference))) return;
    await view.show(true);
  };
}

function isSelectionReference(value: unknown): value is SelectionReference {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SelectionReference>;
  const coordinates = [
    candidate.startLine,
    candidate.startCharacter,
    candidate.endLine,
    candidate.endCharacter,
  ];
  if (
    typeof candidate.uri !== "string" ||
    candidate.uri.length === 0 ||
    !Number.isInteger(candidate.documentVersion) ||
    Number(candidate.documentVersion) < 0 ||
    coordinates.some((coordinate) => !Number.isInteger(coordinate) || Number(coordinate) < 0)
  ) {
    return false;
  }
  return (
    Number(candidate.endLine) > Number(candidate.startLine) ||
    (candidate.endLine === candidate.startLine &&
      Number(candidate.endCharacter) > Number(candidate.startCharacter))
  );
}
