import { describe, expect, it } from "vitest";

import {
  MAX_CONTENT_PROMPT_CHARS,
  chooseContentConversationTitle,
  chooseContentProjectDisplayName,
  contentProjectScopesMatch,
  hasResponseStarted,
  lifecycleOwnsVisibleTurn,
  normalizeContentPromptText,
  normalizeContentProjectScopedUrl,
  parseContentProjectPageUrl,
  parseContentProjectRootUrl,
  stopControlDecision,
} from "./content-policy";

describe("content generation boundaries", () => {
  it("keeps the content-script prompt budget aligned with the relay", () => {
    expect(MAX_CONTENT_PROMPT_CHARS).toBe(100_000);
  });

  it("uses LF prompt text for ChatGPT composer writes and comparisons", () => {
    const crlfPrompt =
      "Context 1/1:\r\nFile: src/example.ts\r\n\r\nconst answer = 42;\r\n\r\nQuestion:\r\nExplain it.";

    expect(normalizeContentPromptText(crlfPrompt)).toBe(crlfPrompt.replace(/\r\n/g, "\n"));
    expect(normalizeContentPromptText("x\r\n".repeat(50_000))).toHaveLength(
      MAX_CONTENT_PROMPT_CHARS,
    );
    expect(normalizeContentPromptText("x\r\n".repeat(50_001))).toBeUndefined();
  });

  it("does not treat the previous assistant answer as a new turn", () => {
    expect(
      hasResponseStarted({
        assistantCount: 1,
        baselineAssistants: 1,
        sawStop: false,
        submissionConfirmed: false,
        assistantIdentityChanged: false,
        assistantDomChanged: false,
        userTurnObserved: false,
        regeneration: false,
        markdown: "previous answer",
        baselineMarkdown: "previous answer",
      }),
    ).toBe(false);
    expect(
      hasResponseStarted({
        assistantCount: 2,
        baselineAssistants: 1,
        sawStop: true,
        submissionConfirmed: true,
        assistantIdentityChanged: true,
        assistantDomChanged: true,
        userTurnObserved: true,
        regeneration: false,
        markdown: "new answer",
        baselineMarkdown: "previous answer",
      }),
    ).toBe(true);
  });

  it("detects a confirmed fast follow-up when transcript nodes are recycled", () => {
    expect(
      hasResponseStarted({
        assistantCount: 1,
        baselineAssistants: 1,
        sawStop: false,
        submissionConfirmed: true,
        assistantIdentityChanged: true,
        assistantDomChanged: false,
        userTurnObserved: true,
        regeneration: false,
        markdown: "follow-up answer",
        baselineMarkdown: "previous answer",
      }),
    ).toBe(true);
  });

  it("uses a new turn identity when consecutive answers have identical markdown", () => {
    const repeatedAnswer = {
      assistantCount: 1,
      baselineAssistants: 1,
      sawStop: false,
      submissionConfirmed: true,
      assistantIdentityChanged: true,
      assistantDomChanged: false,
      userTurnObserved: true,
      regeneration: false,
      markdown: "OK",
      baselineMarkdown: "OK",
    };

    expect(hasResponseStarted(repeatedAnswer)).toBe(true);
    expect(hasResponseStarted({ ...repeatedAnswer, userTurnObserved: false })).toBe(false);
  });

  it("attributes a reformatted rich prompt only with matching run lifecycle and new turn structure", () => {
    const evidence = {
      assistantFollowsCurrentUser: true,
      assistantTurnObserved: true,
      networkResponseComplete: true,
      networkResponseStarted: true,
      runIntentAccepted: true,
      submissionConfirmed: true,
      userTurnObserved: true,
    };
    expect(lifecycleOwnsVisibleTurn(evidence)).toBe(true);
    expect(lifecycleOwnsVisibleTurn({ ...evidence, runIntentAccepted: false })).toBe(false);
    expect(lifecycleOwnsVisibleTurn({ ...evidence, userTurnObserved: false })).toBe(false);
    expect(lifecycleOwnsVisibleTurn({ ...evidence, assistantTurnObserved: false })).toBe(false);
    expect(lifecycleOwnsVisibleTurn({ ...evidence, assistantFollowsCurrentUser: false })).toBe(
      false,
    );
  });

  it("fails closed when stop controls are missing or ambiguous", () => {
    expect(stopControlDecision(1, false, false)).toBe("click");
    expect(stopControlDecision(0, true, true)).toBe("already-complete");
    expect(stopControlDecision(0, true, false)).toBe("unsafe");
    expect(stopControlDecision(2, true, true)).toBe("unsafe");
  });

  it("mirrors the conservative Project route boundary inside the content script", () => {
    const binding = parseContentProjectRootUrl(
      "https://chatgpt.com/g/runtime-scope/project?temporary=value",
    );
    expect(binding).toEqual({
      projectUrl: "https://chatgpt.com/g/runtime-scope/project",
      scope: "https://chatgpt.com/g/runtime-scope/",
    });
    expect(
      normalizeContentProjectScopedUrl(
        "https://chatgpt.com/g/runtime-scope/c/conversation#message",
        binding!,
      ),
    ).toBe("https://chatgpt.com/g/runtime-scope/c/conversation");
    expect(
      normalizeContentProjectScopedUrl("https://chatgpt.com/c/conversation", binding!),
    ).toBeUndefined();
    expect(
      parseContentProjectPageUrl("https://chatgpt.com/g/runtime-scope/c/conversation"),
    ).toEqual(binding);
    expect(parseContentProjectPageUrl("https://chatgpt.com/c/conversation")).toBeUndefined();
    expect(
      parseContentProjectPageUrl("https://chatgpt.com/other/runtime-scope/c/conversation"),
    ).toBeUndefined();
  });

  it("accepts the stable Project ID when ChatGPT adds a conversation slug", () => {
    const stableScope = "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/";
    const conversationScope = "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-ask2gpt/";
    const binding = parseContentProjectRootUrl(`${stableScope}project`);

    expect(binding).toBeTruthy();
    expect(contentProjectScopesMatch(stableScope, conversationScope)).toBe(true);
    expect(
      normalizeContentProjectScopedUrl(`${conversationScope}c/conversation-id`, binding!),
    ).toBe(`${stableScope}c/conversation-id`);
    expect(contentProjectScopesMatch(stableScope, "https://chatgpt.com/g/g-p-other-project/")).toBe(
      false,
    );
  });

  it("uses Project names only as safe display labels", () => {
    expect(
      chooseContentProjectDisplayName(
        ["", "Ask2GPT", "A stale duplicate"],
        "Conversation title - ChatGPT",
      ),
    ).toBe("Ask2GPT");
    expect(chooseContentProjectDisplayName([], "Ask2GPT - ChatGPT")).toBe("Ask2GPT");
    expect(chooseContentProjectDisplayName([], "ChatGPT")).toBe("ChatGPT Project");
    expect(chooseContentProjectDisplayName(["\u0000unsafe"], "Project")).toBe("ChatGPT Project");
  });

  it("accepts only an unambiguous ChatGPT-rendered conversation title", () => {
    expect(
      chooseContentConversationTitle(
        ["Understanding event loops", " Understanding   event loops "],
        "Stale tab title - ChatGPT",
        "Ask2GPT",
      ),
    ).toBe("Understanding event loops");
    expect(chooseContentConversationTitle([], "Event loop guide | ChatGPT")).toBe(
      "Event loop guide",
    );
    expect(
      chooseContentConversationTitle(["跳至内容", "Skip to content"], "Ask2GPT - OK", "Ask2GPT"),
    ).toBe("OK");
    expect(chooseContentConversationTitle([], "Ask2GPT · Runtime recovery", "Ask2GPT")).toBe(
      "Runtime recovery",
    );
    expect(
      chooseContentConversationTitle(["First title", "Conflicting title"], "First title"),
    ).toBeUndefined();
    expect(chooseContentConversationTitle([], "New chat - ChatGPT")).toBeUndefined();
    expect(chooseContentConversationTitle([], "Ask2GPT - ChatGPT", "Ask2GPT")).toBeUndefined();
    expect(chooseContentConversationTitle([], "unsafe\u0000title")).toBeUndefined();
  });
});
