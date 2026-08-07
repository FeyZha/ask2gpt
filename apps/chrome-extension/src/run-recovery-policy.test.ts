import { describe, expect, it } from "vitest";

import {
  canAttributeRecoveredRun,
  canAttestRecoveredRun,
  canContinueRecoveredRunCanonicalization,
  hasRecoveredRunResponseProgress,
  RECOVERED_RUN_RENDER_REFRESH_GRACE_MS,
  RECOVERED_RUN_START_GRACE_MS,
  shouldFailRecoveredRunForMissingAnswer,
  shouldRefreshRecoveredRunRender,
} from "./run-recovery-policy";

describe("recovered run attestation", () => {
  it("accepts only an explicit exact page-side run match", () => {
    expect(canAttestRecoveredRun({ matchedActiveRun: true, active: true })).toBe(true);
    expect(canAttestRecoveredRun({ matchedActiveRun: false, active: true })).toBe(false);
    expect(canAttestRecoveredRun({ matchedActiveRun: "true", active: true })).toBe(false);
    expect(canAttestRecoveredRun({ adopted: true, active: true })).toBe(false);
    expect(canAttestRecoveredRun({ active: true })).toBe(false);
    expect(canAttestRecoveredRun({ active: false, markdown: "another answer" })).toBe(false);
    expect(canAttestRecoveredRun(null)).toBe(false);
  });

  it("attributes a rebuilt content runtime only after the visible turn fingerprint matches", () => {
    expect(canAttributeRecoveredRun({ matchedActiveRun: true })).toBe(true);
    expect(canAttributeRecoveredRun({ recoveryTurnMatched: true })).toBe(true);
    expect(canAttributeRecoveredRun({ recoveryTurnMatched: false })).toBe(false);
    expect(canAttributeRecoveredRun({ markdown: "an unrelated old answer" })).toBe(false);
  });

  it("preserves redirect authority when a reload adopts the exact run from one stop control", () => {
    expect(
      canContinueRecoveredRunCanonicalization({
        active: true,
        adopted: true,
        matchedActiveRun: false,
        recoveryTurnMatched: true,
      }),
    ).toBe(true);
    expect(canContinueRecoveredRunCanonicalization({ matchedActiveRun: true, active: true })).toBe(
      true,
    );

    expect(
      canContinueRecoveredRunCanonicalization({
        active: false,
        adopted: true,
        matchedActiveRun: false,
      }),
    ).toBe(false);
    expect(canContinueRecoveredRunCanonicalization({ active: true })).toBe(false);
    expect(
      canContinueRecoveredRunCanonicalization({
        active: true,
        adopted: true,
        matchedActiveRun: false,
        recoveryTurnMatched: false,
      }),
    ).toBe(false);
    expect(canContinueRecoveredRunCanonicalization({ active: true, adopted: "true" })).toBe(false);
    expect(canContinueRecoveredRunCanonicalization(null)).toBe(false);
  });
});

describe("recovered run missing-answer cleanup", () => {
  const stalled = {
    assistantAfterUser: false,
    elapsedMs: RECOVERED_RUN_START_GRACE_MS,
    hasVisibleMarkdown: false,
    networkResponseComplete: false,
    networkResponseStarted: false,
    responseAttributed: false,
    responseObserved: false,
    sawStop: false,
    stopVisible: false,
    submissionConfirmed: true,
    userTurnObserved: false,
  };

  it("cleans only a submitted run with no response progress after the grace window", () => {
    expect(shouldFailRecoveredRunForMissingAnswer(stalled)).toBe(true);
    expect(
      shouldFailRecoveredRunForMissingAnswer({
        ...stalled,
        elapsedMs: RECOVERED_RUN_START_GRACE_MS - 1,
      }),
    ).toBe(false);
  });

  it("preserves only current in-flight transport and actual visible response evidence", () => {
    expect(
      shouldFailRecoveredRunForMissingAnswer({ ...stalled, networkResponseStarted: true }),
    ).toBe(false);
    expect(
      shouldFailRecoveredRunForMissingAnswer({
        ...stalled,
        networkResponseStarted: true,
        networkResponseComplete: true,
      }),
    ).toBe(true);
    expect(shouldFailRecoveredRunForMissingAnswer({ ...stalled, stopVisible: true })).toBe(false);
    expect(shouldFailRecoveredRunForMissingAnswer({ ...stalled, hasVisibleMarkdown: true })).toBe(
      false,
    );
    expect(shouldFailRecoveredRunForMissingAnswer({ ...stalled, responseObserved: true })).toBe(
      false,
    );
  });

  it("does not accept an empty attributed assistant after the current user", () => {
    expect(
      shouldFailRecoveredRunForMissingAnswer({
        ...stalled,
        assistantAfterUser: true,
      }),
    ).toBe(true);
    expect(
      shouldFailRecoveredRunForMissingAnswer({
        ...stalled,
        assistantAfterUser: true,
        userTurnObserved: true,
      }),
    ).toBe(true);
    expect(
      shouldFailRecoveredRunForMissingAnswer({
        ...stalled,
        assistantAfterUser: true,
        userTurnObserved: true,
        responseAttributed: true,
      }),
    ).toBe(true);
  });

  it("does not persist transport or busy signals as visible-answer evidence", () => {
    expect(hasRecoveredRunResponseProgress({ ...stalled, networkResponseStarted: true })).toBe(
      false,
    );
    expect(hasRecoveredRunResponseProgress({ ...stalled, networkResponseComplete: true })).toBe(
      false,
    );
    expect(hasRecoveredRunResponseProgress({ ...stalled, responseAttributed: true })).toBe(false);
    expect(hasRecoveredRunResponseProgress({ ...stalled, sawStop: true })).toBe(false);
    expect(hasRecoveredRunResponseProgress({ ...stalled, stopVisible: true })).toBe(false);

    expect(
      shouldFailRecoveredRunForMissingAnswer({
        ...stalled,
        networkResponseComplete: true,
        networkResponseStarted: true,
        responseAttributed: false,
        sawStop: true,
      }),
    ).toBe(true);
  });
});

describe("recovered run render refresh", () => {
  const refreshable = {
    assistantAfterUser: false,
    documentVisible: false,
    exactRunAttested: true,
    generationBusy: false,
    hasVisibleMarkdown: false,
    networkResponseComplete: true,
    networkResponseCompleteAgeMs: RECOVERED_RUN_RENDER_REFRESH_GRACE_MS,
    refreshAttempted: false,
    responseAttributed: false,
    responseObserved: false,
    stopVisible: false,
    submissionConfirmed: true,
    terminalDomEvidence: false,
    userTurnObserved: true,
  };

  it("refreshes once at the completion-age boundary for an exact submitted run", () => {
    expect(shouldRefreshRecoveredRunRender(refreshable)).toBe(true);
    expect(
      shouldRefreshRecoveredRunRender({
        ...refreshable,
        networkResponseCompleteAgeMs: RECOVERED_RUN_RENDER_REFRESH_GRACE_MS - 1,
      }),
    ).toBe(false);
    expect(
      shouldRefreshRecoveredRunRender({
        ...refreshable,
        networkResponseCompleteAgeMs: undefined,
      }),
    ).toBe(false);
    expect(
      shouldRefreshRecoveredRunRender({
        ...refreshable,
        networkResponseCompleteAgeMs: Number.NaN,
      }),
    ).toBe(false);
    expect(shouldRefreshRecoveredRunRender({ ...refreshable, refreshAttempted: true })).toBe(false);
  });

  it("requires exact attestation, confirmed submission, and completed transport", () => {
    expect(shouldRefreshRecoveredRunRender({ ...refreshable, exactRunAttested: false })).toBe(
      false,
    );
    expect(shouldRefreshRecoveredRunRender({ ...refreshable, submissionConfirmed: false })).toBe(
      false,
    );
    expect(
      shouldRefreshRecoveredRunRender({ ...refreshable, networkResponseComplete: false }),
    ).toBe(false);
  });

  it("ignores stale busy and partial text but preserves strong terminal or visible-page evidence", () => {
    expect(shouldRefreshRecoveredRunRender({ ...refreshable, generationBusy: true })).toBe(true);
    expect(shouldRefreshRecoveredRunRender({ ...refreshable, stopVisible: true })).toBe(true);
    expect(shouldRefreshRecoveredRunRender({ ...refreshable, hasVisibleMarkdown: true })).toBe(
      true,
    );
    expect(shouldRefreshRecoveredRunRender({ ...refreshable, responseObserved: true })).toBe(true);
    expect(shouldRefreshRecoveredRunRender({ ...refreshable, responseAttributed: true })).toBe(
      true,
    );
    expect(shouldRefreshRecoveredRunRender({ ...refreshable, assistantAfterUser: true })).toBe(
      true,
    );
    expect(
      shouldRefreshRecoveredRunRender({
        ...refreshable,
        assistantAfterUser: true,
        userTurnObserved: false,
      }),
    ).toBe(true);
    expect(shouldRefreshRecoveredRunRender({ ...refreshable, terminalDomEvidence: true })).toBe(
      false,
    );
    expect(shouldRefreshRecoveredRunRender({ ...refreshable, documentVisible: true })).toBe(false);
  });
});
