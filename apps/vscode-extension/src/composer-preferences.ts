import * as vscode from "vscode";

export const FOLLOW_UP_QUEUE_MODES = ["queue", "interrupt"] as const;
export const COMPOSER_ENTER_BEHAVIORS = ["enter", "cmdIfMultiline", "cmdAlways"] as const;

export type FollowUpQueueMode = (typeof FOLLOW_UP_QUEUE_MODES)[number];
export type ComposerEnterBehavior = (typeof COMPOSER_ENTER_BEHAVIORS)[number];

export interface ComposerPreferences {
  followUpQueueMode: FollowUpQueueMode;
  composerEnterBehavior: ComposerEnterBehavior;
}

export const DEFAULT_COMPOSER_PREFERENCES: Readonly<ComposerPreferences> = Object.freeze({
  followUpQueueMode: "queue",
  composerEnterBehavior: "enter",
});

interface ConfigurationReader {
  get(section: string): unknown;
}

export function readComposerPreferences(configuration?: ConfigurationReader): ComposerPreferences {
  const source = configuration ?? defaultConfiguration();
  return {
    followUpQueueMode: readAllowedValue(
      source.get("followUpQueueMode"),
      FOLLOW_UP_QUEUE_MODES,
      DEFAULT_COMPOSER_PREFERENCES.followUpQueueMode,
    ),
    composerEnterBehavior: readAllowedValue(
      source.get("composerEnterBehavior"),
      COMPOSER_ENTER_BEHAVIORS,
      DEFAULT_COMPOSER_PREFERENCES.composerEnterBehavior,
    ),
  };
}

function defaultConfiguration(): ConfigurationReader {
  try {
    return vscode.workspace.getConfiguration("ask2gpt");
  } catch {
    // Unit hosts and a retained renderer can briefly outlive the VS Code
    // configuration service. Defaults keep the composer usable in both cases.
    return { get: () => undefined };
  }
}

function readAllowedValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.some((candidate) => candidate === value)
    ? (value as T)
    : fallback;
}
