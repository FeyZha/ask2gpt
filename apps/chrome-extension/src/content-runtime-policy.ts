export const CONTENT_RUNTIME_REVISION = 50;

/** Recovery diagnostics are revisioned with their selector implementation. */
export function isCompatibleContentRuntime(selectorVersion: unknown): selectorVersion is number {
  return selectorVersion === CONTENT_RUNTIME_REVISION;
}
