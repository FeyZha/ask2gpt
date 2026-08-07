export function canAttestRecoveredRun(value: unknown) {
  return (
    typeof value === "object" &&
    value !== null &&
    "matchedActiveRun" in value &&
    value.matchedActiveRun === true
  );
}

export function canAttributeRecoveredRun(value: unknown) {
  return (
    canAttestRecoveredRun(value) ||
    (typeof value === "object" &&
      value !== null &&
      "recoveryTurnMatched" in value &&
      value.recoveryTurnMatched === true)
  );
}

/**
 * A content script restored from the page's single visible stop control has
 * just installed an observer for the exact recovery command's run id. It does
 * not prove that an older in-memory observer survived the reload, but it does
 * preserve this owned run's authority to follow ChatGPT's SPA redirects until
 * terminal state.
 */
export function canContinueRecoveredRunCanonicalization(value: unknown) {
  return (
    canAttestRecoveredRun(value) ||
    (typeof value === "object" &&
      value !== null &&
      "active" in value &&
      value.active === true &&
      "adopted" in value &&
      value.adopted === true &&
      "recoveryTurnMatched" in value &&
      value.recoveryTurnMatched === true &&
      (!("matchedActiveRun" in value) || value.matchedActiveRun === false))
  );
}

export const RECOVERED_RUN_START_GRACE_MS = 60_000;
export const RECOVERED_RUN_RENDER_REFRESH_GRACE_MS = 3_000;

export interface RecoveredRunMissingAnswerInput {
  assistantAfterUser: boolean;
  elapsedMs: number;
  hasVisibleMarkdown: boolean;
  networkResponseComplete: boolean;
  networkResponseStarted: boolean;
  responseAttributed: boolean;
  responseObserved: boolean;
  sawStop: boolean;
  stopVisible: boolean;
  submissionConfirmed: boolean;
  userTurnObserved: boolean;
}

/**
 * Visible response evidence is monotonic for one owned run. Transport
 * lifecycle flags and busy controls are intentionally excluded: they can
 * prove that a request ran, but not that ChatGPT rendered an answer. An
 * assistant node is evidence only when the current run's user turn was also
 * observed, so a pre-existing assistant cannot satisfy a follow-up run.
 */
export function hasRecoveredRunResponseProgress(input: RecoveredRunMissingAnswerInput) {
  // Attribution and DOM ordering prove ownership, not content. ChatGPT can
  // leave an empty assistant placeholder after the transport completes; only
  // serialized markdown is monotonic visible-answer evidence.
  return input.responseObserved || input.hasVisibleMarkdown;
}

/**
 * Worker recovery may clean up a submitted run that never produced a visible
 * answer. A currently visible stop control or a started-but-incomplete network
 * response is still in flight and is left alone. A completed transport without
 * visible answer evidence is allowed only until the normal start grace elapses.
 */
export function shouldFailRecoveredRunForMissingAnswer(input: RecoveredRunMissingAnswerInput) {
  if (
    input.elapsedMs < RECOVERED_RUN_START_GRACE_MS ||
    !input.submissionConfirmed ||
    hasRecoveredRunResponseProgress(input) ||
    input.stopVisible ||
    (input.networkResponseStarted && !input.networkResponseComplete)
  ) {
    return false;
  }
  return true;
}

export interface RecoveredRunRenderRefreshInput {
  assistantAfterUser: boolean;
  documentVisible: boolean;
  exactRunAttested: boolean;
  generationBusy: boolean;
  hasVisibleMarkdown: boolean;
  networkResponseComplete: boolean;
  networkResponseCompleteAgeMs?: number;
  refreshAttempted: boolean;
  responseAttributed: boolean;
  responseObserved: boolean;
  stopVisible: boolean;
  submissionConfirmed: boolean;
  terminalDomEvidence: boolean;
  userTurnObserved: boolean;
}

/**
 * A completed exact run can be reloaded once when ChatGPT saved the answer but
 * left the background tab's DOM stale or only partially rendered. This is a
 * render recovery only: stale busy UI and partial text do not block it, and it
 * never resubmits the prompt.
 */
export function shouldRefreshRecoveredRunRender(input: RecoveredRunRenderRefreshInput) {
  const completionAge = input.networkResponseCompleteAgeMs;
  return (
    !input.documentVisible &&
    input.exactRunAttested &&
    input.submissionConfirmed &&
    input.networkResponseComplete &&
    typeof completionAge === "number" &&
    Number.isFinite(completionAge) &&
    completionAge >= RECOVERED_RUN_RENDER_REFRESH_GRACE_MS &&
    !input.terminalDomEvidence &&
    !input.refreshAttempted
  );
}
