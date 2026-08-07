export function isContentConversationRemoteUrl(value: string | undefined) {
  if (!value) return false;
  try {
    const segments = new URL(value).pathname.split("/").filter(Boolean);
    return (
      (segments.length === 2 && segments[0] === "c") ||
      (segments.length === 4 && segments[0] === "g" && segments[2] === "c")
    );
  } catch {
    return false;
  }
}

/**
 * Content-script-local equivalent of the relay navigation guard.
 *
 * Keep this helper in the content-script dependency graph instead of importing
 * the service-worker navigation policy. MV3 manifest content scripts are
 * classic scripts, so sharing a runtime module with the service worker can make
 * Rollup emit an ESM chunk that Chrome cannot load from a content script.
 */
export function contentPreDispatchPageMatches(input: {
  expectedRemoteUrl?: string;
  currentPageUrl?: string;
  allowFirstConversation: boolean;
}) {
  if (!input.currentPageUrl) return false;
  if (input.allowFirstConversation) {
    return contentConversationId(input.currentPageUrl) === undefined;
  }
  const expectedId = contentConversationId(input.expectedRemoteUrl);
  return Boolean(expectedId && expectedId === contentConversationId(input.currentPageUrl));
}

export async function waitForContentConversationUrl(
  readUrl: () => string | undefined,
  timeoutMs: number,
  options: {
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    pollMs?: number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const pollMs = Math.max(20, options.pollMs ?? 50);
  const deadline = now() + Math.max(0, timeoutMs);
  while (true) {
    const remoteUrl = readUrl();
    if (isContentConversationRemoteUrl(remoteUrl)) return remoteUrl;
    const remaining = deadline - now();
    if (remaining <= 0) return undefined;
    await sleep(Math.min(pollMs, remaining));
  }
}

function contentConversationId(value: string | undefined) {
  if (!value) return undefined;
  try {
    const segments = new URL(value).pathname.split("/").filter(Boolean);
    if (segments.length === 2 && segments[0] === "c") return segments[1];
    if (segments.length === 4 && segments[0] === "g" && segments[2] === "c") {
      return segments[3];
    }
    return undefined;
  } catch {
    return undefined;
  }
}
