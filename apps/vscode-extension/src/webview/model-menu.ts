import type { ChatModelMode, ChatModelOption } from "@ask2gpt/protocol";

export interface ChatGptModeChoice {
  key: ChatModelMode;
  option: ChatModelOption;
  secondaryLabel?: string;
}

export type ChatGptModeGroupKey = "smart" | "fast" | "reasoning" | "pro";

export interface ChatGptModeGroup {
  key: ChatGptModeGroupKey;
  choices: ChatGptModeChoice[];
}

export interface ChatGptFamilyChoice {
  label: string;
  option: ChatModelOption;
  selected: boolean;
}

export interface ChatGptModelMenu {
  modes: ChatGptModeChoice[];
  modeGroups: ChatGptModeGroup[];
  families: ChatGptFamilyChoice[];
  current?: ChatModelOption;
  currentMode?: ChatGptModeChoice;
  currentFamily?: string;
}

const modeOrder: ChatModelMode[] = ["smart", "fast", "low", "medium", "high", "very-high", "pro"];

export function buildChatGptModelMenu(
  options: readonly ChatModelOption[],
  currentModelId?: string,
): ChatGptModelMenu {
  const current =
    options.find((option) => option.id === currentModelId) ??
    options.find((option) => option.selected);
  const modes = modeOrder.flatMap((key) => {
    const option = options.find((candidate) => candidate.mode === key);
    return option
      ? [
          {
            key,
            option,
            ...(option.secondaryLabel ? { secondaryLabel: option.secondaryLabel } : {}),
          },
        ]
      : [];
  });
  const modeGroups = [
    createModeGroup("smart", modes, ["smart"]),
    createModeGroup("fast", modes, ["fast"]),
    createModeGroup("reasoning", modes, ["low", "medium", "high", "very-high"]),
    createModeGroup("pro", modes, ["pro"]),
  ].filter((group): group is ChatGptModeGroup => group.choices.length > 0);
  const families = uniqueFamilies(options).map(([label, familyOptions]) => {
    const currentInFamily = familyOptions.find((option) => option.id === current?.id);
    const option = currentInFamily ?? preferredFamilyDefault(familyOptions);
    return { label, option, selected: Boolean(currentInFamily) };
  });

  return {
    modes,
    modeGroups,
    families,
    ...(current ? { current } : {}),
    ...(current?.mode ? { currentMode: modes.find((choice) => choice.key === current.mode) } : {}),
    ...(current?.familyLabel ? { currentFamily: current.familyLabel } : {}),
  };
}

function createModeGroup(
  key: ChatGptModeGroupKey,
  modes: ChatGptModeChoice[],
  keys: ChatModelMode[],
): ChatGptModeGroup {
  return {
    key,
    choices: keys.flatMap((mode) => modes.filter((choice) => choice.key === mode)),
  };
}

function uniqueFamilies(options: readonly ChatModelOption[]) {
  const groups = new Map<string, ChatModelOption[]>();
  for (const option of options) {
    const label = option.familyLabel?.trim();
    if (!label) continue;
    const group = groups.get(label) ?? [];
    group.push(option);
    groups.set(label, group);
  }
  return [...groups.entries()];
}

function preferredFamilyDefault(options: readonly ChatModelOption[]) {
  const priorities: ChatModelMode[] = [
    "smart",
    "medium",
    "low",
    "pro",
    "fast",
    "high",
    "very-high",
  ];
  for (const mode of priorities) {
    const match = options.find((option) => option.mode === mode);
    if (match) return match;
  }
  return options[0]!;
}
