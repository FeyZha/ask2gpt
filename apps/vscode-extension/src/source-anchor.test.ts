import { describe, expect, it } from "vitest";

import {
  normalizeSourceAnchorContent,
  sourceAnchorMatchesContent,
  sourceAnchorSha256,
} from "./source-anchor";

describe("source anchors", () => {
  it("keeps the V1 normalization and lowercase SHA-256 deterministic", () => {
    expect(normalizeSourceAnchorContent("first  \r\nsecond\t \rthird ")).toBe(
      "first\nsecond\nthird",
    );
    expect(sourceAnchorSha256("same input")).toBe(
      "c2f991739d5824b4e1d8bafaffb735b9e4061f801d82c4aaf57aea02495f750c",
    );
  });

  it("accepts exact or normalized content and rejects real source drift", () => {
    const content = "first  \r\nsecond\t ";
    const anchor = {
      formatVersion: 1 as const,
      contentSha256: sourceAnchorSha256(content),
      normalizedContentSha256: sourceAnchorSha256(normalizeSourceAnchorContent(content)),
      documentVersion: 4,
    };

    expect(sourceAnchorMatchesContent(anchor, content)).toBe(true);
    expect(sourceAnchorMatchesContent(anchor, "first\nsecond")).toBe(true);
    expect(sourceAnchorMatchesContent(anchor, "first\nchanged")).toBe(false);
  });
});
