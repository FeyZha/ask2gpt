import { describe, expect, it } from "vitest";

import { nextStreamingMarkdown, streamingMarkdownFrameStep } from "./stream-smoothing";

describe("streaming Markdown smoothing", () => {
  it("reveals a small received suffix one character at a time", () => {
    expect(nextStreamingMarkdown("Answer", "Answer now")).toBe("Answer ");
  });

  it("catches up with a large received backlog in a bounded number of frames", () => {
    const target = "x".repeat(24_000);
    let visible = "";
    const step = streamingMarkdownFrameStep(visible, target);

    for (let frame = 0; frame < 12; frame += 1) {
      const next = nextStreamingMarkdown(visible, target, step);
      expect(next.startsWith(visible)).toBe(true);
      visible = next;
    }

    expect(visible).toBe(target);
  });

  it("does not split a surrogate pair or CRLF boundary", () => {
    expect(nextStreamingMarkdown("", "😀 done")).toBe("😀");
    expect(nextStreamingMarkdown("line", "line\r\nnext")).toBe("line\r\n");
  });

  it("applies a non-prefix correction immediately", () => {
    expect(nextStreamingMarkdown("old answer", "corrected answer")).toBe("corrected answer");
  });
});
