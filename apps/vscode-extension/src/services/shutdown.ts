interface AsyncDisposable {
  dispose(): void | Promise<void>;
}

interface LoggerDisposable {
  dispose(): void;
}

interface StorageLease {
  release(): void | Promise<void>;
}

export interface ExtensionResources {
  controller: AsyncDisposable;
  backend: AsyncDisposable;
  relay: AsyncDisposable;
  logger: LoggerDisposable;
  storageLease: StorageLease;
}

export function disposeExtensionResources(resources: ExtensionResources): Promise<void> {
  // This line intentionally runs before the async function is created. VS Code
  // treats ExtensionContext subscription disposal as synchronous and may close
  // OutputChannel IPC while the first awaited cleanup is still pending.
  resources.logger.dispose();

  return (async () => {
    try {
      await resources.controller.dispose();
    } finally {
      try {
        await resources.backend.dispose();
      } finally {
        try {
          await resources.relay.dispose();
        } finally {
          await resources.storageLease.release();
        }
      }
    }
  })();
}
