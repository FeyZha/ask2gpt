export const RESPONSE_COMPLETE_DOM_GRACE_MS = 5_000;

export type ResponseStartWatchdogDecision = "satisfied" | "defer" | "recover" | "fail";

export type NetworkResponseFailureDecision = "fail" | "recover" | "ignore";

export function networkResponseFailureDecision(input: {
  failureKind: "http" | "network" | "stream" | "unknown";
  generationBusy: boolean;
  responseObserved: boolean;
  terminalEvidence: boolean;
}) {
  // The bridge reads a clone of ChatGPT's response. A failure in that observer
  // is not authoritative once the exact page run has already exposed answer
  // text: the page-owned response and DOM may have completed successfully.
  // A response error is authoritative only while this run has exposed no
  // answer text. ChatGPT can report an HTTP/network failure after its page has
  // already rendered the answer, especially while the tab is hidden. Once
  // answer text was observed, preserve the run and recover it read-only.
  if (!input.responseObserved) return "fail";
  return input.generationBusy || !input.terminalEvidence ? "recover" : "ignore";
}

/**
 * Decides whether a submitted turn can be declared missing.
 *
 * ChatGPT can keep the network response active while temporarily hiding its
 * Stop control, and its React tree can settle after the response stream has
 * already closed. Neither state is a failure.
 */
export function responseStartWatchdogDecision(input: {
  documentVisible: boolean;
  generationBusy: boolean;
  networkResponseComplete: boolean;
  networkResponseCompleteAgeMs?: number;
  networkResponseStarted: boolean;
  responseAttributed: boolean;
  responseObserved: boolean;
  terminalDomEvidence: boolean;
}): ResponseStartWatchdogDecision {
  // Attribution identifies which assistant node belongs to this run, but an
  // empty React placeholder is not visible answer evidence. Only a serialized
  // snapshot already observed for this exact run is irreversible proof that
  // the response started. A later watchdog must never contradict it.
  // Visible text can continue to be observed normally. In a hidden document,
  // however, serialized text proves only that this exact response started: the
  // renderer can freeze midway through the answer. Require a strong terminal
  // DOM signal before stopping the watchdog for a hidden page.
  if (input.responseObserved && (input.documentVisible || input.terminalDomEvidence)) {
    return "satisfied";
  }
  // Visibility is not progress. Hidden ChatGPT tabs are exactly where React
  // can stop committing the submitted turn after the network stream has
  // already finished. Once the bounded DOM grace elapses, preserve the exact
  // page run and ask the worker to recover from the durable transcript instead
  // of emitting a contradictory terminal error from the stale renderer.
  if (input.networkResponseComplete) {
    const age = input.networkResponseCompleteAgeMs;
    if (!Number.isFinite(age) || Number(age) < RESPONSE_COMPLETE_DOM_GRACE_MS) return "defer";
    return "recover";
  }
  if (input.responseObserved) return "defer";
  if (input.generationBusy) return "defer";
  if (input.networkResponseStarted) return "defer";
  return "fail";
}
