import { describe, expect, it } from "vitest";

import { DEFAULT_CHATGPT_MODE_ID, mergeChatGptModeOptions } from "./model-options";

describe("model mode presets", () => {
  it("makes every ChatGPT web tier available before the browser catalog arrives", () => {
    const options = mergeChatGptModeOptions([]);

    expect(DEFAULT_CHATGPT_MODE_ID).toBe("mode-fast");
    expect(options.map((option) => option.id)).toEqual([
      "mode-smart",
      "mode-fast",
      "mode-medium",
      "mode-high",
      "mode-very-high",
      "mode-pro",
    ]);
    expect(options.find((option) => option.id === DEFAULT_CHATGPT_MODE_ID)?.selected).toBe(true);
  });

  it("enriches presets from the browser without hiding a temporarily unavailable tier", () => {
    const options = mergeChatGptModeOptions([
      {
        id: "mode-high",
        label: "High",
        mode: "high",
        modelId: "gpt-thinking",
        familyLabel: "GPT Sol",
        reasoningEffort: "extended",
        selected: true,
      },
      {
        id: "mode-low",
        label: "Light",
        mode: "low",
        modelId: "gpt-thinking",
        familyLabel: "GPT Sol",
        reasoningEffort: "min",
        selected: false,
      },
    ]);

    expect(options).toHaveLength(7);
    expect(options.find((option) => option.id === "mode-high")).toMatchObject({
      modelId: "gpt-thinking",
      familyLabel: "GPT Sol",
      reasoningEffort: "extended",
      selected: true,
    });
    expect(options.find((option) => option.id === "mode-low")).toMatchObject({
      mode: "low",
      reasoningEffort: "min",
    });
    expect(options.find((option) => option.id === "mode-pro")).toMatchObject({ mode: "pro" });
    expect(options.find((option) => option.id === "mode-pro")?.modelId).toBeUndefined();
  });
});
