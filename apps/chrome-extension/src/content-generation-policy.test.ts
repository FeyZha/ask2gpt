import { describe, expect, it } from "vitest";

import {
  contentPreDispatchPageMatches,
  isContentConversationRemoteUrl,
  waitForContentConversationUrl,
} from "./content-generation-policy";

describe("content generation URL promotion", () => {
  it("guards dispatch without importing the service-worker navigation policy", () => {
    expect(
      contentPreDispatchPageMatches({
        currentPageUrl: "https://chatgpt.com/",
        allowFirstConversation: true,
      }),
    ).toBe(true);
    expect(
      contentPreDispatchPageMatches({
        expectedRemoteUrl: "https://chatgpt.com/c/conversation-a",
        currentPageUrl: "https://chatgpt.com/g/project/c/conversation-a",
        allowFirstConversation: false,
      }),
    ).toBe(true);
    expect(
      contentPreDispatchPageMatches({
        expectedRemoteUrl: "https://chatgpt.com/c/conversation-a",
        currentPageUrl: "https://chatgpt.com/c/conversation-b",
        allowFirstConversation: false,
      }),
    ).toBe(false);
  });

  it("waits through a complete-before-/c race and returns the promoted conversation", async () => {
    let now = 0;
    const sleep = async (milliseconds: number) => {
      now += milliseconds;
    };
    const readUrl = () =>
      now < 100 ? "https://chatgpt.com/" : "https://chatgpt.com/c/new-conversation";

    await expect(
      waitForContentConversationUrl(readUrl, 500, {
        now: () => now,
        sleep,
        pollMs: 50,
      }),
    ).resolves.toBe("https://chatgpt.com/c/new-conversation");
  });

  it("does not treat a home or Project root as a conversation", async () => {
    expect(isContentConversationRemoteUrl("https://chatgpt.com/")).toBe(false);
    expect(isContentConversationRemoteUrl("https://chatgpt.com/g/project/project")).toBe(false);
    expect(isContentConversationRemoteUrl("https://chatgpt.com/g/project/c/conversation")).toBe(
      true,
    );

    let now = 0;
    await expect(
      waitForContentConversationUrl(() => "https://chatgpt.com/", 100, {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        pollMs: 50,
      }),
    ).resolves.toBeUndefined();
  });
});
