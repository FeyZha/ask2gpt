import { describe, expect, it } from "vitest";

import { CONTENT_RUNTIME_REVISION, isCompatibleContentRuntime } from "./content-runtime-policy";
import {
  RESPONSE_COMPLETE_DOM_GRACE_MS,
  networkResponseFailureDecision,
  responseStartWatchdogDecision,
} from "./response-start-policy";

describe("content runtime hot-update policy", () => {
  it("accepts only the content runtime revision paired with this worker", () => {
    expect(isCompatibleContentRuntime(CONTENT_RUNTIME_REVISION)).toBe(true);
    expect(isCompatibleContentRuntime(CONTENT_RUNTIME_REVISION - 1)).toBe(false);
    expect(isCompatibleContentRuntime(CONTENT_RUNTIME_REVISION + 1)).toBe(false);
  });

  it("rejects missing, malformed, and non-positive runtime identities", () => {
    expect(isCompatibleContentRuntime(undefined)).toBe(false);
    expect(isCompatibleContentRuntime("10")).toBe(false);
    expect(isCompatibleContentRuntime(0)).toBe(false);
    expect(isCompatibleContentRuntime(-1)).toBe(false);
    expect(isCompatibleContentRuntime(1.5)).toBe(false);
  });
});

describe("response start watchdog policy", () => {
  const idle = {
    documentVisible: true,
    generationBusy: false,
    networkResponseComplete: false,
    networkResponseStarted: false,
    responseAttributed: false,
    responseObserved: false,
    terminalDomEvidence: false,
  };

  it("requires observed answer text instead of an empty attributed placeholder", () => {
    expect(responseStartWatchdogDecision({ ...idle, responseAttributed: true })).toBe("fail");
    expect(responseStartWatchdogDecision({ ...idle, responseObserved: true })).toBe("satisfied");
  });

  it("does not contradict a first snapshot after the network response completes", () => {
    expect(
      responseStartWatchdogDecision({
        ...idle,
        networkResponseStarted: true,
        networkResponseComplete: true,
        networkResponseCompleteAgeMs: RESPONSE_COMPLETE_DOM_GRACE_MS,
        responseObserved: true,
      }),
    ).toBe("satisfied");
  });

  it("defers while ChatGPT is busy or its response stream is still active", () => {
    expect(responseStartWatchdogDecision({ ...idle, generationBusy: true })).toBe("defer");
    expect(
      responseStartWatchdogDecision({
        ...idle,
        networkResponseStarted: true,
      }),
    ).toBe("defer");
  });

  it("allows the DOM to settle, then delegates completed-response recovery to the worker", () => {
    expect(
      responseStartWatchdogDecision({
        ...idle,
        networkResponseStarted: true,
        networkResponseComplete: true,
        networkResponseCompleteAgeMs: RESPONSE_COMPLETE_DOM_GRACE_MS - 1,
      }),
    ).toBe("defer");
    expect(
      responseStartWatchdogDecision({
        ...idle,
        generationBusy: true,
        networkResponseStarted: true,
        networkResponseComplete: true,
        networkResponseCompleteAgeMs: RESPONSE_COMPLETE_DOM_GRACE_MS,
      }),
    ).toBe("recover");
    expect(
      responseStartWatchdogDecision({
        ...idle,
        networkResponseStarted: true,
        networkResponseComplete: true,
        networkResponseCompleteAgeMs: RESPONSE_COMPLETE_DOM_GRACE_MS,
      }),
    ).toBe("recover");
  });

  it("fails an idle turn with no progress evidence even when the tab is hidden", () => {
    expect(responseStartWatchdogDecision(idle)).toBe("fail");
    expect(responseStartWatchdogDecision({ ...idle, documentVisible: false })).toBe("fail");
  });

  it("preserves a completed hidden run for exact transcript recovery", () => {
    expect(
      responseStartWatchdogDecision({
        ...idle,
        documentVisible: false,
        networkResponseStarted: true,
        networkResponseComplete: true,
        networkResponseCompleteAgeMs: RESPONSE_COMPLETE_DOM_GRACE_MS - 1,
      }),
    ).toBe("defer");
    expect(
      responseStartWatchdogDecision({
        ...idle,
        documentVisible: false,
        networkResponseStarted: true,
        networkResponseComplete: true,
        networkResponseCompleteAgeMs: RESPONSE_COMPLETE_DOM_GRACE_MS,
        responseObserved: true,
      }),
    ).toBe("recover");
  });

  it("keeps hidden partial text under observation until a terminal signal or exact recovery", () => {
    expect(
      responseStartWatchdogDecision({
        ...idle,
        documentVisible: false,
        networkResponseStarted: true,
        responseObserved: true,
      }),
    ).toBe("defer");
    expect(
      responseStartWatchdogDecision({
        ...idle,
        documentVisible: false,
        networkResponseStarted: true,
        responseObserved: true,
        terminalDomEvidence: true,
      }),
    ).toBe("satisfied");
  });
});

describe("network response observer failure policy", () => {
  it("keeps empty HTTP and network failures terminal", () => {
    expect(
      networkResponseFailureDecision({
        failureKind: "http",
        generationBusy: false,
        responseObserved: false,
        terminalEvidence: true,
      }),
    ).toBe("fail");
    expect(
      networkResponseFailureDecision({
        failureKind: "network",
        generationBusy: false,
        responseObserved: false,
        terminalEvidence: true,
      }),
    ).toBe("fail");
  });

  it("recovers an HTTP or network observer error after answer text was observed", () => {
    expect(
      networkResponseFailureDecision({
        failureKind: "http",
        generationBusy: false,
        responseObserved: true,
        terminalEvidence: false,
      }),
    ).toBe("recover");
    expect(
      networkResponseFailureDecision({
        failureKind: "network",
        generationBusy: false,
        responseObserved: true,
        terminalEvidence: true,
      }),
    ).toBe("ignore");
  });

  it("fails an empty stream error, recovers ambiguous text, and ignores terminal text", () => {
    expect(
      networkResponseFailureDecision({
        failureKind: "stream",
        generationBusy: false,
        responseObserved: false,
        terminalEvidence: true,
      }),
    ).toBe("fail");
    expect(
      networkResponseFailureDecision({
        failureKind: "stream",
        generationBusy: true,
        responseObserved: true,
        terminalEvidence: true,
      }),
    ).toBe("recover");
    expect(
      networkResponseFailureDecision({
        failureKind: "stream",
        generationBusy: false,
        responseObserved: true,
        terminalEvidence: false,
      }),
    ).toBe("recover");
    expect(
      networkResponseFailureDecision({
        failureKind: "stream",
        generationBusy: false,
        responseObserved: true,
        terminalEvidence: true,
      }),
    ).toBe("ignore");
  });
});
