import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
  get: vi.fn<(section: string) => unknown>(),
  getConfiguration: vi.fn(),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vscodeMock.getConfiguration,
  },
}));

import {
  COMPOSER_ENTER_BEHAVIORS,
  DEFAULT_COMPOSER_PREFERENCES,
  FOLLOW_UP_QUEUE_MODES,
  readComposerPreferences,
} from "./composer-preferences";

describe("readComposerPreferences", () => {
  beforeEach(() => {
    vscodeMock.get.mockReset();
    vscodeMock.getConfiguration.mockReset();
    vscodeMock.getConfiguration.mockReturnValue({ get: vscodeMock.get });
  });

  it("uses safe defaults when settings are absent", () => {
    expect(readComposerPreferences({ get: () => undefined })).toEqual({
      followUpQueueMode: "queue",
      composerEnterBehavior: "enter",
    });
    expect(DEFAULT_COMPOSER_PREFERENCES).toEqual({
      followUpQueueMode: "queue",
      composerEnterBehavior: "enter",
    });
  });

  it.each([
    ["queue", "enter"],
    ["interrupt", "cmdIfMultiline"],
    ["interrupt", "cmdAlways"],
  ] as const)("accepts supported values %s and %s", (followUpQueueMode, composerEnterBehavior) => {
    expect(
      readComposerPreferences({
        get: (section) =>
          section === "followUpQueueMode" ? followUpQueueMode : composerEnterBehavior,
      }),
    ).toEqual({ followUpQueueMode, composerEnterBehavior });
  });

  it("rejects unsupported and malformed values independently", () => {
    expect(
      readComposerPreferences({
        get: (section) => (section === "followUpQueueMode" ? "steer" : null),
      }),
    ).toEqual({
      followUpQueueMode: "queue",
      composerEnterBehavior: "enter",
    });
  });

  it("reads the expected keys from the ask2gpt configuration section", () => {
    vscodeMock.get.mockImplementation((section) =>
      section === "followUpQueueMode" ? "interrupt" : "cmdAlways",
    );

    expect(readComposerPreferences()).toEqual({
      followUpQueueMode: "interrupt",
      composerEnterBehavior: "cmdAlways",
    });
    expect(vscodeMock.getConfiguration).toHaveBeenCalledWith("ask2gpt");
    expect(vscodeMock.get.mock.calls.map(([section]) => section)).toEqual([
      "followUpQueueMode",
      "composerEnterBehavior",
    ]);
  });

  it("keeps defaults when the VS Code configuration service is unavailable", () => {
    vscodeMock.getConfiguration.mockImplementation(() => {
      throw new Error("configuration service unavailable");
    });

    expect(readComposerPreferences()).toEqual({
      followUpQueueMode: "queue",
      composerEnterBehavior: "enter",
    });
  });

  it("exports only implemented preference values", () => {
    expect(FOLLOW_UP_QUEUE_MODES).toEqual(["queue", "interrupt"]);
    expect(FOLLOW_UP_QUEUE_MODES).not.toContain("steer");
    expect(COMPOSER_ENTER_BEHAVIORS).toEqual(["enter", "cmdIfMultiline", "cmdAlways"]);
  });
});
