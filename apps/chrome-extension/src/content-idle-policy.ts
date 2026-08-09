export type ContentIdleBlocker =
  | "active-run"
  | "ambiguous-composer"
  | "composer-not-ready"
  | "composer-not-empty"
  | "attachments-present"
  | "response-control-present"
  | "modal-present";

export interface ContentIdleEvidence {
  activeRun: boolean;
  attachmentPresent: boolean;
  composerCount: number;
  composerReady: boolean;
  composerText: string;
  modalPresent: boolean;
  responseControlPresent: boolean;
}

export type ContentIdleDecision = { idle: true } | { idle: false; blocker: ContentIdleBlocker };

/**
 * A deliberately conservative page-side proof used before a Relay-created tab
 * is reassigned or closed. Unknown/ambiguous UI always blocks lifecycle work.
 */
export function decideContentIdle(evidence: ContentIdleEvidence): ContentIdleDecision {
  if (evidence.activeRun) return { idle: false, blocker: "active-run" };
  if (evidence.composerCount !== 1) return { idle: false, blocker: "ambiguous-composer" };
  if (!evidence.composerReady) return { idle: false, blocker: "composer-not-ready" };
  if (evidence.composerText.trim().length > 0) {
    return { idle: false, blocker: "composer-not-empty" };
  }
  if (evidence.attachmentPresent) return { idle: false, blocker: "attachments-present" };
  if (evidence.responseControlPresent) {
    return { idle: false, blocker: "response-control-present" };
  }
  if (evidence.modalPresent) return { idle: false, blocker: "modal-present" };
  return { idle: true };
}
