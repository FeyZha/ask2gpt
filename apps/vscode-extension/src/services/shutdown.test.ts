import { describe, expect, it, vi } from "vitest";

import { disposeExtensionResources, type ExtensionResources } from "./shutdown";

describe("extension resource shutdown", () => {
  it("closes logging synchronously before awaiting resource cleanup", async () => {
    const order: string[] = [];
    let finishController: (() => void) | undefined;
    const controllerPending = new Promise<void>((resolve) => {
      finishController = resolve;
    });
    const resources: ExtensionResources = {
      logger: {
        dispose: vi.fn(() => {
          order.push("logger");
        }),
      },
      controller: {
        dispose: vi.fn(() => {
          order.push("controller");
          return controllerPending;
        }),
      },
      backend: {
        dispose: vi.fn(() => {
          order.push("backend");
        }),
      },
      relay: {
        dispose: vi.fn(() => {
          order.push("relay");
        }),
      },
      storageLease: {
        release: vi.fn(() => {
          order.push("storage");
        }),
      },
    };

    const shutdown = disposeExtensionResources(resources);

    expect(order).toEqual(["logger", "controller"]);
    finishController?.();
    await shutdown;
    expect(order).toEqual(["logger", "controller", "backend", "relay", "storage"]);
  });

  it("continues releasing later resources when an earlier cleanup fails", async () => {
    const resources: ExtensionResources = {
      logger: { dispose: vi.fn() },
      controller: { dispose: vi.fn(() => Promise.reject(new Error("controller failed"))) },
      backend: { dispose: vi.fn() },
      relay: { dispose: vi.fn() },
      storageLease: { release: vi.fn() },
    };

    await expect(disposeExtensionResources(resources)).rejects.toThrow("controller failed");
    expect(resources.backend.dispose).toHaveBeenCalledOnce();
    expect(resources.relay.dispose).toHaveBeenCalledOnce();
    expect(resources.storageLease.release).toHaveBeenCalledOnce();
  });
});
