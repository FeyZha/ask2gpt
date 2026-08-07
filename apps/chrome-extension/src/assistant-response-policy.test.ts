import { describe, expect, it } from "vitest";

import { isTransientAssistantStatus, usableAssistantMarkdown } from "./assistant-response-policy";

describe("assistant response policy", () => {
  it("rejects localized ChatGPT progress labels as answer content", () => {
    expect(isTransientAssistantStatus("正在思考")).toBe(true);
    expect(isTransientAssistantStatus(" **正在思考……** ")).toBe(true);
    expect(isTransientAssistantStatus("Thinking...")).toBe(true);
    expect(usableAssistantMarkdown("正在处理…")).toBe("");
  });

  it("keeps real short and partial answers", () => {
    expect(isTransientAssistantStatus("正在思考这个问题的答案")).toBe(false);
    expect(isTransientAssistantStatus("TEST_OK")).toBe(false);
    expect(usableAssistantMarkdown("  TEST_OK  ")).toBe("TEST_OK");
  });
});
