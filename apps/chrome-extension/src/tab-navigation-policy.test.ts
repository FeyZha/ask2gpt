import { describe, expect, it } from "vitest";

import {
  decideMappedTabNavigation,
  entriesForMappedTab,
  expectedConversationNavigationMatches,
  mappingStillOwnsTab,
  preDispatchPageMatches,
  promotionTimeoutAction,
  sameChatGptConversationIdentity,
  shouldWaitForFirstConversationPromotion,
} from "./tab-navigation-policy";

describe("ChatGPT mapped-tab navigation policy", () => {
  it("keeps a first send mapped while the home page becomes a conversation", () => {
    expect(
      decideMappedTabNavigation({
        eventIsCurrent: true,
        initialAdoptionAllowed: true,
        redirectAllowed: false,
      }),
    ).toEqual({ action: "keep" });
    expect(
      decideMappedTabNavigation({
        eventIsCurrent: true,
        observedConversationUrl: "https://chatgpt.com/c/first",
        initialAdoptionAllowed: true,
        redirectAllowed: false,
      }),
    ).toEqual({ action: "adopt", remoteUrl: "https://chatgpt.com/c/first" });
  });

  it("does not accept a root-page event without an explicit first-adoption state", () => {
    expect(
      decideMappedTabNavigation({
        eventIsCurrent: true,
        initialAdoptionAllowed: false,
        redirectAllowed: false,
      }),
    ).toEqual({ action: "detach" });
  });

  it("waits for a root snapshot only on the owning first-send tab", () => {
    const input = {
      allowRemoteAdoption: true,
      mappedTabId: 41,
      senderPageUrl: "https://chatgpt.com/",
      eventRemoteUrl: "https://chatgpt.com/",
    };
    expect(shouldWaitForFirstConversationPromotion({ ...input, senderTabId: 41 })).toBe(true);
    expect(shouldWaitForFirstConversationPromotion({ ...input, senderTabId: 42 })).toBe(false);
    expect(
      shouldWaitForFirstConversationPromotion({
        ...input,
        senderTabId: 41,
        senderPageUrl: "https://chatgpt.com/c/already-promoted",
        eventRemoteUrl: "https://chatgpt.com/c/already-promoted",
      }),
    ).toBe(false);
  });

  it("ignores a stale home event that finishes after /c has already been observed", () => {
    expect(
      decideMappedTabNavigation({
        eventIsCurrent: false,
        mappedRemoteUrl: "https://chatgpt.com/c/first",
        initialAdoptionAllowed: false,
        redirectAllowed: false,
      }),
    ).toEqual({ action: "ignore-stale" });
  });

  it("adopts a same-id canonical redirect without allowing a different conversation", () => {
    const input = {
      eventIsCurrent: true,
      mappedRemoteUrl: "https://chatgpt.com/c/old",
      observedConversationUrl: "https://chatgpt.com/g/project-a/c/old",
      initialAdoptionAllowed: false,
    };
    expect(decideMappedTabNavigation({ ...input, redirectAllowed: true })).toEqual({
      action: "adopt",
      remoteUrl: "https://chatgpt.com/g/project-a/c/old",
    });
    expect(decideMappedTabNavigation({ ...input, redirectAllowed: false })).toEqual({
      action: "adopt",
      remoteUrl: "https://chatgpt.com/g/project-a/c/old",
    });
    expect(
      decideMappedTabNavigation({
        ...input,
        observedConversationUrl: "https://chatgpt.com/c/different",
        redirectAllowed: true,
      }),
    ).toEqual({
      action: "detach",
    });
  });

  it("allows only global/project canonical redirects with the same conversation id", () => {
    expect(
      sameChatGptConversationIdentity(
        "https://chatgpt.com/c/conversation-a",
        "https://chatgpt.com/g/project/c/conversation-a",
      ),
    ).toBe(true);
    expect(
      sameChatGptConversationIdentity(
        "https://chatgpt.com/c/conversation-a",
        "https://chatgpt.com/c/conversation-b",
      ),
    ).toBe(false);
  });

  it("rejects explicit restore A→B and accepts A→Project A", () => {
    expect(
      expectedConversationNavigationMatches(
        "https://chatgpt.com/c/conversation-a",
        "https://chatgpt.com/c/conversation-b",
        true,
      ),
    ).toBe(false);
    expect(
      expectedConversationNavigationMatches(
        "https://chatgpt.com/c/conversation-a",
        "https://chatgpt.com/g/project/c/conversation-a",
        true,
      ),
    ).toBe(true);
  });

  it("fails closed when a known conversation is changed manually during generation", () => {
    expect(
      decideMappedTabNavigation({
        eventIsCurrent: true,
        mappedRemoteUrl: "https://chatgpt.com/c/current",
        observedConversationUrl: "https://chatgpt.com/c/other",
        initialAdoptionAllowed: false,
        redirectAllowed: false,
      }),
    ).toEqual({ action: "detach" });
  });

  it("waits for run attestation before accepting one provisional-to-canonical id change", () => {
    const input = {
      eventIsCurrent: true,
      mappedRemoteUrl: "https://chatgpt.com/c/provisional",
      observedConversationUrl: "https://chatgpt.com/c/canonical",
      initialAdoptionAllowed: false,
      redirectAllowed: false,
    };

    expect(
      decideMappedTabNavigation({
        ...input,
        canonicalization: "await-attestation",
      }),
    ).toEqual({ action: "await-attestation" });
    expect(
      decideMappedTabNavigation({
        ...input,
        canonicalization: "attested",
      }),
    ).toEqual({ action: "adopt", remoteUrl: "https://chatgpt.com/c/canonical" });
    expect(decideMappedTabNavigation({ ...input, canonicalization: "none" })).toEqual({
      action: "detach",
    });
  });

  it("routes a tab update to only its owning VS Code window and conversation", () => {
    const records: ReadonlyArray<readonly [string, { tabId: number; instanceId: string }]> = [
      ["window-a/conversation", { tabId: 41, instanceId: "window-a" }],
      ["window-b/conversation", { tabId: 42, instanceId: "window-b" }],
      ["window-c/conversation", { tabId: 43, instanceId: "window-c" }],
    ];

    expect(entriesForMappedTab(records, 42)).toEqual([
      ["window-b/conversation", { tabId: 42, instanceId: "window-b" }],
    ]);
  });

  it("rejects an async result after its mapping record has been replaced", () => {
    const inspected = { tabId: 42, instanceId: "window-a" };
    const replacement = { tabId: 43, instanceId: "window-a" };
    expect(mappingStillOwnsTab(inspected, inspected, 42)).toBe(true);
    expect(mappingStillOwnsTab(replacement, inspected, 42)).toBe(false);
  });

  it("blocks content.send when an A tab is switched to B after readiness", () => {
    expect(
      preDispatchPageMatches({
        mappedRemoteUrl: "https://chatgpt.com/c/conversation-a",
        currentPageUrl: "https://chatgpt.com/c/conversation-b",
        allowFirstConversation: false,
      }),
    ).toBe(false);
    expect(
      preDispatchPageMatches({
        currentPageUrl: "https://chatgpt.com/",
        allowFirstConversation: true,
      }),
    ).toBe(true);
  });

  it("turns complete-before-/c timeout into one terminal error", () => {
    expect(promotionTimeoutAction("snapshot")).toBe("retry");
    expect(promotionTimeoutAction("complete")).toBe("terminal-error");
    expect(promotionTimeoutAction("stopped")).toBe("terminal-error");
  });
});
