import { randomUUID } from "node:crypto";

import { isRelayIdentifier } from "@ask2gpt/protocol";

export const STORAGE_NAMESPACE_KEY = "ask2gpt.instanceId.v1";

interface WorkspaceState {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * Keeps the pre-0.1.4 workspace namespace stable for conversation history and
 * for the primary relay route.
 */
export async function resolveStorageNamespaceId(
  workspaceState: WorkspaceState,
  createIdentifier: () => string = randomUUID,
): Promise<string> {
  let storageNamespaceId = workspaceState.get<string>(STORAGE_NAMESPACE_KEY);
  if (!isRelayIdentifier(storageNamespaceId)) {
    storageNamespaceId = requireIdentifier(createIdentifier(), "storage namespace");
    await workspaceState.update(STORAGE_NAMESPACE_KEY, storageNamespaceId);
  }

  return storageNamespaceId;
}

/**
 * Relay state in Chrome is keyed by instanceId. Bind that identity to the
 * leased storage slot so a reloaded Extension Host adopts the same remote tab,
 * active run and pending events instead of orphaning them.
 */
export function relayInstanceIdForSlot(storageNamespaceId: string, slotIndex: number) {
  requireIdentifier(storageNamespaceId, "storage namespace");
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0) {
    throw new Error("Storage slot index was invalid.");
  }

  return requireIdentifier(
    slotIndex === 0 ? storageNamespaceId : `${storageNamespaceId}.slot${slotIndex}`,
    "relay route",
  );
}

function requireIdentifier(value: string, purpose: string) {
  if (!isRelayIdentifier(value)) {
    throw new Error(`Generated ${purpose} identity was invalid.`);
  }
  return value;
}
