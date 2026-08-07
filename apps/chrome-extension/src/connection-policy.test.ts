import { describe, expect, it } from "vitest";

import { parseRelayReadyIdentity, shouldSupersedeRelayConnection } from "./connection-policy";

describe("automatic relay connection policy", () => {
  it("pins only a self-consistent host identity from relay.ready", () => {
    expect(
      parseRelayReadyIdentity("window-a", {
        serverInstanceId: "window-a",
        serverLabel: "  Workspace   A  ",
      }),
    ).toEqual({ instanceId: "window-a", label: "Workspace A" });
    expect(
      parseRelayReadyIdentity("window-a", {
        serverInstanceId: "window-b",
        serverLabel: "Workspace B",
      }),
    ).toBeUndefined();
    expect(
      parseRelayReadyIdentity("unsafe:id", {
        serverInstanceId: "unsafe:id",
        serverLabel: "Workspace",
      }),
    ).toBeUndefined();
  });

  it("keeps different VS Code windows connected independently", () => {
    expect(shouldSupersedeRelayConnection("window-a", "window-b")).toBe(false);
    expect(shouldSupersedeRelayConnection("window-a", "window-a")).toBe(true);
  });
});
