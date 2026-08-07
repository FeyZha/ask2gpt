import { describe, expect, it } from "vitest";

import { promptInlinePresentationV1 } from "./prompt-presentation";

describe("prompt inline presentation fingerprint", () => {
  it("matches the ChatGPT user-message serializer for rich multiline source", () => {
    const raw = [
      "Context:",
      "  [first_file.py] exposes foo_bar",
      "\t[second_file.py] calls another_value & checks <state>",
      "",
      "Question: only_reply_OK",
    ].join("\n");

    expect(promptInlinePresentationV1(raw)).toBe(
      "Context: \\[first\\_file.py\\] exposes foo\\_bar \\[second\\_file.py\\] calls another\\_value &amp; checks &lt;state&gt; Question: only\\_reply\\_OK",
    );
  });

  it("remains deterministic and does not collapse changed prompt content", () => {
    expect(promptInlinePresentationV1("a\n\t[b_c]")).toBe("a \\[b\\_c\\]");
    expect(promptInlinePresentationV1("a\n\t[b_d]")).not.toBe(
      promptInlinePresentationV1("a\n\t[b_c]"),
    );
  });
});
