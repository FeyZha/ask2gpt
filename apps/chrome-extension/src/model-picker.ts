import type { ChatModelMode, ChatModelOption, ChatReasoningEffort } from "@ask2gpt/protocol";

export interface AccountThinkingEffort {
  id: string;
  label?: string;
}

export interface AccountModelCandidate {
  id: string;
  label: string;
  description?: string;
  reasoningType?: string;
  configurableThinkingEffort: boolean;
  thinkingEfforts: AccountThinkingEffort[];
  isWorkModeModel: boolean;
}

export function buildChatGptComposerOptions(
  candidates: readonly AccountModelCandidate[],
  defaultModelId?: string,
) {
  const standardModels = candidates.filter((candidate) => !candidate.isWorkModeModel);
  const smart = newestModel(
    standardModels.filter((candidate) => candidate.reasoningType === "auto"),
  );
  const fast = newestModel(
    standardModels.filter(
      (candidate) => candidate.reasoningType === "none" && /\binstant\b/iu.test(candidate.label),
    ),
  );
  const reasoning = newestModel(
    standardModels.filter(
      (candidate) =>
        candidate.reasoningType === "reasoning" &&
        candidate.configurableThinkingEffort &&
        candidate.thinkingEfforts.length > 0,
    ),
  );
  const pro = newestModel(standardModels.filter((candidate) => candidate.reasoningType === "pro"));
  const solFamily =
    newestModel(
      candidates.filter(
        (candidate) => candidate.isWorkModeModel && /\bsol\b/iu.test(candidate.label),
      ),
    )?.label ?? reasoning?.label.replace(/\bThinking\b/iu, "Sol");

  const options: ChatModelOption[] = [];
  if (smart) {
    options.push(composerOption("smart", "Smart", smart, undefined, baseFamilyLabel(smart.label)));
  }
  if (fast) {
    options.push(
      composerOption(
        "fast",
        "Fast",
        fast,
        undefined,
        baseFamilyLabel(fast.label),
        shortModelVersion(fast.label),
      ),
    );
  }
  if (reasoning) {
    const availableEfforts = new Set(reasoning.thinkingEfforts.map((effort) => effort.id));
    if (availableEfforts.has("min")) {
      options.push(composerOption("low", "Light", reasoning, "min", solFamily));
    }
    if (availableEfforts.has("standard")) {
      options.push(composerOption("medium", "Medium", reasoning, "standard", solFamily));
    }
    if (availableEfforts.has("extended")) {
      options.push(composerOption("high", "High", reasoning, "extended", solFamily));
    }
    if (availableEfforts.has("max")) {
      options.push(composerOption("very-high", "Extra High", reasoning, "max", solFamily));
    }
  }
  if (pro) {
    const proEffort = pro.thinkingEfforts.some((effort) => effort.id === "standard")
      ? "standard"
      : undefined;
    options.push(
      composerOption("pro", "Pro", pro, proEffort, proFamilyLabel(pro.label, solFamily)),
    );
  }
  if (options.length === 0) return [];

  const selected =
    options.find(
      (option) =>
        option.modelId === defaultModelId &&
        (option.mode === "smart" || option.mode === "fast" || option.mode === "medium"),
    ) ?? options[0]!;
  return options.map((option) => ({ ...option, selected: option.id === selected.id }));
}

export function normalizeVisibleModelText(value: string, maxLength: number) {
  return value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function composerOption(
  mode: ChatModelMode,
  label: string,
  model: AccountModelCandidate,
  reasoningEffort?: ChatReasoningEffort,
  familyLabel = model.label,
  secondaryLabel?: string,
): ChatModelOption {
  return {
    id: `mode-${mode}`,
    label,
    mode,
    modelId: model.id,
    familyLabel,
    ...(secondaryLabel ? { secondaryLabel } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    selected: false,
  };
}

function newestModel(candidates: readonly AccountModelCandidate[]) {
  return [...candidates].sort((left, right) => {
    const leftVersion = modelVersion(left.label);
    const rightVersion = modelVersion(right.label);
    return (
      rightVersion[0] - leftVersion[0] ||
      rightVersion[1] - leftVersion[1] ||
      left.label.localeCompare(right.label)
    );
  })[0];
}

function modelVersion(label: string): [number, number] {
  const match = /GPT-(\d+)(?:\.(\d+))?/iu.exec(label);
  return [Number(match?.[1] ?? 0), Number(match?.[2] ?? 0)];
}

function shortModelVersion(label: string) {
  return /GPT-(\d+(?:\.\d+)?)/iu.exec(label)?.[1];
}

function baseFamilyLabel(label: string) {
  return label.replace(/\s+(?:Instant|Thinking|Pro)\b.*$/iu, "").trim();
}

function proFamilyLabel(label: string, solFamily?: string) {
  const version = shortModelVersion(label);
  if (version && solFamily?.includes(version)) return `${solFamily} Pro`;
  return label.replace(/\s+Pro$/iu, " Sol Pro");
}
