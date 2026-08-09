import { describe, expect, it } from "vitest";

import { decideContentIdle, type ContentIdleEvidence } from "./content-idle-policy";

const idleEvidence = (): ContentIdleEvidence => ({
  activeRun: false,
  attachmentPresent: false,
  composerCount: 1,
  composerReady: true,
  composerText: "",
  modalPresent: false,
  responseControlPresent: false,
});

describe("content idle policy", () => {
  it("accepts one empty, ready composer with no active page work", () => {
    expect(decideContentIdle(idleEvidence())).toEqual({ idle: true });
  });

  it.each([
    ["active-run", { activeRun: true }],
    ["ambiguous-composer", { composerCount: 0 }],
    ["ambiguous-composer", { composerCount: 2 }],
    ["composer-not-ready", { composerReady: false }],
    ["composer-not-empty", { composerText: "unsent draft" }],
    ["attachments-present", { attachmentPresent: true }],
    ["response-control-present", { responseControlPresent: true }],
    ["modal-present", { modalPresent: true }],
  ] as const)("fails closed for %s", (blocker, update) => {
    expect(decideContentIdle({ ...idleEvidence(), ...update })).toEqual({
      idle: false,
      blocker,
    });
  });
});
