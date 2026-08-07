import { describe, expect, it } from "vitest";

import { buildChatGptComposerOptions, normalizeVisibleModelText } from "./model-picker";

describe("ChatGPT composer model options", () => {
  it("maps account metadata to the same user-level modes as the ChatGPT composer", () => {
    const options = buildChatGptComposerOptions(
      [
        accountModel("gpt-5-5", "GPT-5.5", "auto"),
        accountModel("gpt-5-5-instant", "GPT-5.5 Instant", "none"),
        accountModel("gpt-5-6-thinking", "GPT-5.6 Thinking", "reasoning", [
          "min",
          "standard",
          "extended",
          "max",
        ]),
        { ...accountModel("gpt-5.6-sol-wm", "GPT-5.6 Sol", "reasoning"), isWorkModeModel: true },
        accountModel("gpt-5-6-pro", "GPT-5.6 Pro", "pro", ["standard"]),
        {
          ...accountModel("gpt-5.6-terra-wm", "GPT-5.6 Terra", "reasoning"),
          isWorkModeModel: true,
        },
      ],
      "gpt-5-5",
    );

    expect(options.map(({ mode }) => mode)).toEqual([
      "smart",
      "fast",
      "low",
      "medium",
      "high",
      "very-high",
      "pro",
    ]);
    expect(options.find(({ mode }) => mode === "low")).toMatchObject({
      reasoningEffort: "min",
      familyLabel: "GPT-5.6 Sol",
    });
    expect(options.find(({ mode }) => mode === "very-high")).toMatchObject({
      modelId: "gpt-5-6-thinking",
      reasoningEffort: "max",
      familyLabel: "GPT-5.6 Sol",
    });
    expect(options.find(({ mode }) => mode === "smart")?.selected).toBe(true);
    expect(options.some(({ familyLabel }) => familyLabel?.includes("Terra"))).toBe(false);
  });

  it("removes control characters from visible text", () => {
    expect(normalizeVisibleModelText("A\u0000\u200b B", 80)).toBe("A B");
  });
});

function accountModel(id: string, label: string, reasoningType: string, efforts: string[] = []) {
  return {
    id,
    label,
    reasoningType,
    configurableThinkingEffort: efforts.length > 0,
    thinkingEfforts: efforts.map((effort) => ({ id: effort })),
    isWorkModeModel: false,
  };
}
