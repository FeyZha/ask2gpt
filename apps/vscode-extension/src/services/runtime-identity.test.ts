import { describe, expect, it, vi } from "vitest";

import {
  relayInstanceIdForSlot,
  resolveStorageNamespaceId,
  STORAGE_NAMESPACE_KEY,
} from "./runtime-identity";

class MemoryWorkspaceState {
  readonly values = new Map<string, unknown>();

  get<T>(key: string) {
    return this.values.get(key) as T | undefined;
  }

  update(key: string, value: unknown) {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

describe("runtime relay identity", () => {
  it("preserves the legacy namespace as the primary window route", async () => {
    const state = new MemoryWorkspaceState();
    state.values.set(STORAGE_NAMESPACE_KEY, "existing-workspace");

    const namespace = await resolveStorageNamespaceId(state);

    expect(namespace).toBe("existing-workspace");
    expect(relayInstanceIdForSlot(namespace, 0)).toBe("existing-workspace");
  });

  it("creates the persistent namespace once", async () => {
    const state = new MemoryWorkspaceState();
    const createIdentifier = vi.fn(() => "new-workspace");

    await expect(resolveStorageNamespaceId(state, createIdentifier)).resolves.toBe("new-workspace");
    await expect(resolveStorageNamespaceId(state, createIdentifier)).resolves.toBe("new-workspace");
    expect(state.values.get(STORAGE_NAMESPACE_KEY)).toBe("new-workspace");
    expect(createIdentifier).toHaveBeenCalledOnce();
  });

  it("derives a stable, distinct relay route for every concurrent storage slot", () => {
    expect(relayInstanceIdForSlot("workspace-id", 1)).toBe("workspace-id.slot1");
    expect(relayInstanceIdForSlot("workspace-id", 2)).toBe("workspace-id.slot2");
    expect(relayInstanceIdForSlot("workspace-id", 1)).toBe("workspace-id.slot1");
  });
});
