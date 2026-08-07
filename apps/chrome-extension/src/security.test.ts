import { describe, expect, it } from "vitest";

import {
  MAX_MARKDOWN_BYTES,
  MAX_PROMPT_CHARS,
  RELAY_CONNECT_TIMEOUT_MS,
  isChatGptPageUrl,
  isSafeId,
  normalizePromptText,
  normalizeProjectScopedUrl,
  normalizeRemoteConversationUrl,
  normalizeRemoteConversationTitle,
  parseContentEvent,
  parseProjectPageUrl,
  parseProjectRootUrl,
  parseStoredProjectBinding,
  parseStoredTrustedProjectBinding,
  projectScopesMatch,
  reconnectDelay,
} from "./security";

describe("Chrome relay input policy", () => {
  it("accepts the bounded multi-context prompt budget", () => {
    expect(MAX_PROMPT_CHARS).toBe(100_000);
  });

  it("normalizes Windows prompt line endings before enforcing the relay budget", () => {
    const crlfPrompt =
      "Context 1/1:\r\nFile: src/example.ts\r\n\r\nconst answer = 42;\r\n\r\nQuestion:\r\nExplain it.";

    expect(normalizePromptText(crlfPrompt)).toBe(crlfPrompt.replace(/\r\n/g, "\n"));
    expect(normalizePromptText("x\r\n".repeat(50_000))).toHaveLength(MAX_PROMPT_CHARS);
    expect(normalizePromptText("x\r\n".repeat(50_001))).toBeUndefined();
  });

  it("accepts only safe relay identifiers", () => {
    expect(isSafeId("93ab1e4d-887f-4e76-a57d-0c0b1c3c356e")).toBe(true);
    expect(isSafeId("__proto__")).toBe(false);
    expect(isSafeId("instance:conversation")).toBe(false);
  });

  it("uses the specified capped reconnect backoff", () => {
    expect([0, 1, 2, 3, 4, 5, 99].map(reconnectDelay)).toEqual([
      500, 1_000, 2_000, 5_000, 10_000, 10_000, 10_000,
    ]);
    expect(RELAY_CONNECT_TIMEOUT_MS).toBe(5_000);
  });

  it("allows only the exact ChatGPT HTTPS origin", () => {
    expect(isChatGptPageUrl("https://chatgpt.com/c/abc")).toBe(true);
    expect(isChatGptPageUrl("https://chatgpt.com.evil.test/c/abc")).toBe(false);
    expect(isChatGptPageUrl("http://chatgpt.com/c/abc")).toBe(false);
    expect(isChatGptPageUrl("https://user@chatgpt.com/c/abc")).toBe(false);
  });

  it("normalizes only root and conversation URLs without model/query state", () => {
    expect(normalizeRemoteConversationUrl("https://chatgpt.com/c/abc?model=hidden#fragment")).toBe(
      "https://chatgpt.com/c/abc",
    );
    expect(normalizeRemoteConversationUrl("https://chatgpt.com/g/gpt-id")).toBeUndefined();
    expect(
      normalizeRemoteConversationUrl(
        "https://chatgpt.com/g/runtime-project/c/conversation?model=hidden#fragment",
      ),
    ).toBe("https://chatgpt.com/g/runtime-project/c/conversation");
    expect(normalizeRemoteConversationUrl("javascript:alert(1)")).toBeUndefined();
  });

  it("normalizes only bounded, non-generic conversation titles", () => {
    expect(normalizeRemoteConversationTitle("  Event   loop guide  ")).toBe("Event loop guide");
    for (const title of [
      "New chat",
      "Skip to content",
      "Skip to main content",
      "跳至内容",
      "主要内容",
    ]) {
      expect(normalizeRemoteConversationTitle(title)).toBeUndefined();
    }
    expect(normalizeRemoteConversationTitle("unsafe\u0000title")).toBeUndefined();
    expect(normalizeRemoteConversationTitle("x".repeat(81))).toBeUndefined();
  });

  it("derives a Project scope from the visible root without assuming an ID format", () => {
    const route = parseProjectRootUrl(
      "https://chatgpt.com/g/runtime-defined-scope/project?temporary=value#fragment",
    );
    expect(route).toEqual({
      projectUrl: "https://chatgpt.com/g/runtime-defined-scope/project",
      scope: "https://chatgpt.com/g/runtime-defined-scope/",
    });
    expect(parseProjectRootUrl("https://chatgpt.com/project")).toBeUndefined();
    expect(parseProjectRootUrl("https://chatgpt.com/other/runtime/project")).toBeUndefined();
    expect(parseProjectRootUrl("https://chatgpt.com/g/nested/runtime/project")).toBeUndefined();
    expect(parseProjectRootUrl("https://chatgpt.com/g/runtime%2Fescape/project")).toBeUndefined();
  });

  it("derives the same Project identity from its home or an in-Project conversation", () => {
    const expected = {
      projectUrl: "https://chatgpt.com/g/runtime-defined-scope/project",
      scope: "https://chatgpt.com/g/runtime-defined-scope/",
    };
    expect(parseProjectPageUrl(expected.projectUrl)).toEqual(expected);
    expect(
      parseProjectPageUrl(
        "https://chatgpt.com/g/runtime-defined-scope/c/conversation-id?temporary=value",
      ),
    ).toEqual(expected);
    expect(parseProjectPageUrl("https://chatgpt.com/c/conversation-id")).toBeUndefined();
    expect(
      parseProjectPageUrl("https://chatgpt.com/other/runtime-defined-scope/c/conversation-id"),
    ).toBeUndefined();
    expect(
      parseProjectPageUrl("https://chatgpt.com/g/runtime-defined-scope/settings"),
    ).toBeUndefined();
  });

  it("accepts only the bound Project root and its direct conversation route", () => {
    const binding = {
      projectUrl: "https://chatgpt.com/g/runtime-defined-scope/project",
      scope: "https://chatgpt.com/g/runtime-defined-scope/",
    };
    expect(normalizeProjectScopedUrl(`${binding.projectUrl}?model=hidden`, binding)).toBe(
      binding.projectUrl,
    );
    expect(
      normalizeProjectScopedUrl(
        "https://chatgpt.com/g/runtime-defined-scope/c/conversation#message",
        binding,
      ),
    ).toBe("https://chatgpt.com/g/runtime-defined-scope/c/conversation");
    expect(
      normalizeProjectScopedUrl("https://chatgpt.com/c/conversation", binding),
    ).toBeUndefined();
    expect(
      normalizeProjectScopedUrl("https://chatgpt.com/g/other-scope/c/conversation", binding),
    ).toBeUndefined();
    expect(
      normalizeProjectScopedUrl("https://chatgpt.com/g/runtime-defined-scope/settings", binding),
    ).toBeUndefined();
  });

  it("accepts ChatGPT's stable Project ID with a conversation slug alias", () => {
    const stableScope = "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/";
    const conversationScope = "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-ask2gpt/";
    const binding = {
      projectUrl: `${stableScope}project`,
      scope: stableScope,
    };

    expect(projectScopesMatch(stableScope, conversationScope)).toBe(true);
    expect(normalizeProjectScopedUrl(`${conversationScope}c/conversation-id`, binding)).toBe(
      `${stableScope}c/conversation-id`,
    );
    expect(projectScopesMatch(stableScope, "https://chatgpt.com/g/g-p-abcdef-other/")).toBe(false);
  });

  it("restores only canonical, self-consistent Project bindings", () => {
    const binding = {
      version: 4,
      projectUrl: "https://chatgpt.com/g/runtime-defined-scope/project",
      scope: "https://chatgpt.com/g/runtime-defined-scope/",
      name: "Ask2GPT",
      boundAt: "2026-07-24T00:00:00.000Z",
    };
    expect(parseStoredProjectBinding(binding)).toEqual(binding);
    expect(parseStoredProjectBinding({ ...binding, scope: "https://chatgpt.com/g/other/" })).toBe(
      undefined,
    );
    expect(parseStoredProjectBinding({ ...binding, name: " Ask2GPT " })).toBeUndefined();
  });

  it("restores durable Project trust only with the strict provenance schema", () => {
    const trusted = {
      version: 5,
      provenance: "strict-visible-project-v1",
      projectUrl: "https://chatgpt.com/g/runtime-defined-scope/project",
      scope: "https://chatgpt.com/g/runtime-defined-scope/",
      name: "Ask2GPT",
      boundAt: "2026-07-24T00:00:00.000Z",
    };
    expect(parseStoredTrustedProjectBinding(trusted)).toEqual(trusted);
    expect(parseStoredTrustedProjectBinding({ ...trusted, version: 4 })).toBeUndefined();
    expect(parseStoredTrustedProjectBinding({ ...trusted, provenance: undefined })).toBeUndefined();
    expect(
      parseStoredTrustedProjectBinding({
        ...trusted,
        scope: "https://chatgpt.com/g/other/",
      }),
    ).toBeUndefined();
  });

  it("rejects malformed, oversized, and unsafe content events", () => {
    const base = {
      type: "content.event",
      eventType: "snapshot",
      conversationId: "conversation-1",
      runId: "run-1",
      markdown: "ok",
      remoteUrl: "https://chatgpt.com/c/abc",
    };
    expect(parseContentEvent(base)).toMatchObject({ markdown: "ok" });
    expect(
      parseContentEvent({
        ...base,
        remoteUrl: "https://chatgpt.com/g/runtime-scope/c/conversation",
        title: "Understanding event loops",
      }),
    ).toMatchObject({
      remoteUrl: "https://chatgpt.com/g/runtime-scope/c/conversation",
      title: "Understanding event loops",
    });
    expect(
      parseContentEvent({
        ...base,
        eventType: "error",
        markdown: undefined,
        remoteUrl: undefined,
        error: {
          code: "CHATGPT_PROJECT_MISMATCH",
          message: "wrong project",
          recoverable: true,
        },
      }),
    ).toMatchObject({ eventType: "error" });
    expect(parseContentEvent({ ...base, eventType: "surprise" })).toBeUndefined();
    expect(parseContentEvent({ ...base, title: "New chat" })).toBeUndefined();
    expect(parseContentEvent({ ...base, title: "Skip to content" })).toBeUndefined();
    expect(parseContentEvent({ ...base, title: "跳至主要内容" })).toBeUndefined();
    expect(
      parseContentEvent({
        ...base,
        remoteUrl: "https://chatgpt.com/g/runtime-scope/project",
        title: "A title",
      }),
    ).toBeUndefined();
    expect(
      parseContentEvent({
        ...base,
        eventType: "error",
        markdown: undefined,
        title: "A title",
        error: {
          code: "CHATGPT_PROJECT_MISMATCH",
          message: "wrong project",
          recoverable: true,
        },
      }),
    ).toBeUndefined();
    expect(parseContentEvent({ ...base, remoteUrl: "https://example.com/steal" })).toBeUndefined();
    expect(
      parseContentEvent({ ...base, markdown: "x".repeat(MAX_MARKDOWN_BYTES + 1) }),
    ).toBeUndefined();
    expect(
      parseContentEvent({
        ...base,
        eventType: "error",
        error: {
          code: "NOT_A_REAL_CODE",
          message: "bad",
          recoverable: true,
        },
      }),
    ).toBeUndefined();
  });
});
