export type MappedTabNavigationDecision =
  | { action: "ignore-stale" }
  | { action: "keep" }
  | { action: "await-attestation" }
  | { action: "adopt"; remoteUrl: string }
  | { action: "detach" };

export function decideMappedTabNavigation(input: {
  eventIsCurrent: boolean;
  mappedRemoteUrl?: string;
  observedConversationUrl?: string;
  initialAdoptionAllowed: boolean;
  redirectAllowed: boolean;
  canonicalization?: "none" | "await-attestation" | "attested";
}): MappedTabNavigationDecision {
  if (!input.eventIsCurrent) return { action: "ignore-stale" };

  const mappedRemoteUrl = input.mappedRemoteUrl;
  const observedRemoteUrl = input.observedConversationUrl;
  if (!observedRemoteUrl) {
    // The ChatGPT home route is a legitimate transient while a new prompt is
    // being promoted to /c/... . Never erase a known URL during that window.
    if (
      (!mappedRemoteUrl && (input.initialAdoptionAllowed || input.redirectAllowed)) ||
      (mappedRemoteUrl && (input.redirectAllowed || input.canonicalization === "await-attestation"))
    ) {
      return { action: "keep" };
    }
    return { action: "detach" };
  }

  if (!mappedRemoteUrl) {
    return input.initialAdoptionAllowed || input.redirectAllowed
      ? { action: "adopt", remoteUrl: observedRemoteUrl }
      : { action: "detach" };
  }
  if (mappedRemoteUrl === observedRemoteUrl) return { action: "keep" };
  if (sameChatGptConversationIdentity(mappedRemoteUrl, observedRemoteUrl)) {
    return { action: "adopt", remoteUrl: observedRemoteUrl };
  }
  if (input.canonicalization === "attested") {
    return { action: "adopt", remoteUrl: observedRemoteUrl };
  }
  if (input.canonicalization === "await-attestation") {
    return { action: "await-attestation" };
  }
  return { action: "detach" };
}

export function sameChatGptConversationIdentity(left: string, right: string) {
  return conversationId(left) !== undefined && conversationId(left) === conversationId(right);
}

export function expectedConversationNavigationMatches(
  expectedUrl: string | undefined,
  currentUrl: string | undefined,
  allowCanonicalRedirect: boolean,
) {
  if (!expectedUrl) return true;
  if (currentUrl === expectedUrl) return true;
  return Boolean(
    allowCanonicalRedirect &&
    currentUrl &&
    sameChatGptConversationIdentity(expectedUrl, currentUrl),
  );
}

export function shouldWaitForFirstConversationPromotion(input: {
  allowRemoteAdoption: boolean;
  mappedTabId: number | undefined;
  senderTabId: number;
  senderPageUrl: string | undefined;
  eventRemoteUrl: string | undefined;
}) {
  return Boolean(
    input.allowRemoteAdoption &&
    input.mappedTabId === input.senderTabId &&
    input.senderPageUrl &&
    conversationId(input.senderPageUrl) === undefined &&
    (!input.eventRemoteUrl || input.eventRemoteUrl === input.senderPageUrl),
  );
}

export function preDispatchPageMatches(input: {
  mappedRemoteUrl?: string;
  currentPageUrl?: string;
  allowFirstConversation: boolean;
}) {
  if (!input.currentPageUrl) return false;
  if (input.allowFirstConversation) {
    return conversationId(input.currentPageUrl) === undefined;
  }
  return Boolean(
    input.mappedRemoteUrl &&
    sameChatGptConversationIdentity(input.mappedRemoteUrl, input.currentPageUrl),
  );
}

export function promotionTimeoutAction(eventType: "snapshot" | "slow" | "complete" | "stopped") {
  return eventType === "snapshot" || eventType === "slow" ? "retry" : "terminal-error";
}

function conversationId(value: string) {
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

export function entriesForMappedTab<T extends { tabId: number }>(
  entries: ReadonlyArray<readonly [string, T]>,
  tabId: number,
) {
  return entries.filter(([, record]) => record.tabId === tabId);
}

export function mappingStillOwnsTab<T extends { tabId: number }>(
  currentRecord: T | undefined,
  expectedRecord: T,
  tabId: number,
) {
  return currentRecord === expectedRecord && expectedRecord.tabId === tabId;
}
