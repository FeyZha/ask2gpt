import { describe, expect, it } from "vitest";

import { buildChatGptModelMenu } from "./model-menu";

describe("ChatGPT-style model menu", () => {
  it("keeps reasoning modes in the primary menu and model families in a submenu", () => {
    const menu = buildChatGptModelMenu(
      [
        option("smart", "mode-smart", "GPT-5.5"),
        option("fast", "mode-fast", "GPT-5.5", "5.5"),
        option("low", "mode-low", "GPT-5.6 Sol"),
        option("medium", "mode-medium", "GPT-5.6 Sol"),
        option("high", "mode-high", "GPT-5.6 Sol"),
        option("very-high", "mode-very-high", "GPT-5.6 Sol", undefined, true),
        option("pro", "mode-pro", "GPT-5.6 Sol Pro"),
      ],
      "mode-very-high",
    );

    expect(menu.modes.map(({ key }) => key)).toEqual([
      "smart",
      "fast",
      "low",
      "medium",
      "high",
      "very-high",
      "pro",
    ]);
    expect(menu.currentMode?.key).toBe("very-high");
    expect(menu.currentFamily).toBe("GPT-5.6 Sol");
    expect(menu.modeGroups.map(({ key }) => key)).toEqual(["smart", "fast", "reasoning", "pro"]);
    expect(
      menu.modeGroups.find(({ key }) => key === "reasoning")?.choices.map(({ key }) => key),
    ).toEqual(["low", "medium", "high", "very-high"]);
    expect(menu.families.map(({ label }) => label)).toEqual([
      "GPT-5.5",
      "GPT-5.6 Sol",
      "GPT-5.6 Sol Pro",
    ]);
    expect(menu.families.find(({ selected }) => selected)?.option.id).toBe("mode-very-high");
  });
});

function option(
  mode: "smart" | "fast" | "low" | "medium" | "high" | "very-high" | "pro",
  id: string,
  familyLabel: string,
  secondaryLabel?: string,
  selected = false,
) {
  return {
    id,
    label: mode,
    mode,
    modelId: `model-${mode}`,
    familyLabel,
    ...(secondaryLabel ? { secondaryLabel } : {}),
    selected,
  };
}
