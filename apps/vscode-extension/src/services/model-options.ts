import type { ChatModelMode, ChatModelOption } from "@ask2gpt/protocol";

// Fast is the product default because first-token latency is part of the core
// chat experience. Users can still opt into Smart or a reasoning tier for a
// turn that benefits from more deliberation.
export const DEFAULT_CHATGPT_MODE_ID = "mode-fast";

const modePresets: ReadonlyArray<{
  id: string;
  label: string;
  mode: ChatModelMode;
}> = [
  { id: "mode-smart", label: "Smart", mode: "smart" },
  { id: "mode-fast", label: "Fast", mode: "fast" },
  { id: "mode-medium", label: "Medium", mode: "medium" },
  { id: "mode-high", label: "High", mode: "high" },
  { id: "mode-very-high", label: "Extra High", mode: "very-high" },
  { id: "mode-pro", label: "Pro", mode: "pro" },
];

/**
 * Keeps the web tier menu immediately usable while enriching it with the
 * account-specific model IDs that Chrome discovers in the background.
 */
export function mergeChatGptModeOptions(catalog: readonly ChatModelOption[]): ChatModelOption[] {
  const byMode = new Map(
    catalog.flatMap((option) => (option.mode ? [[option.mode, option] as const] : [])),
  );
  const presetModes = new Set<ChatModelMode>([...modePresets.map((preset) => preset.mode), "low"]);
  const modes = modePresets.map((preset) => {
    const discovered = byMode.get(preset.mode);
    return discovered
      ? { ...discovered }
      : {
          ...preset,
          selected: preset.id === DEFAULT_CHATGPT_MODE_ID,
        };
  });
  const discoveredLightReasoning = byMode.get("low");
  const extras = catalog
    .filter((option) => !option.mode || !presetModes.has(option.mode))
    .map((option) => ({ ...option }));
  return [
    ...modes.slice(0, 2),
    ...(discoveredLightReasoning ? [{ ...discoveredLightReasoning }] : []),
    ...modes.slice(2),
    ...extras,
  ];
}
