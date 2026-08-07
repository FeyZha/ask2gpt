import { describe, expect, it } from "vitest";

import { normalizeExternalHttpUrl } from "./external-url";

describe("normalizeExternalHttpUrl", () => {
  it("allows normal HTTP(S) links", () => {
    expect(normalizeExternalHttpUrl("https://example.com/docs?q=1#part")).toBe(
      "https://example.com/docs?q=1#part",
    );
    expect(normalizeExternalHttpUrl("http://example.com/")).toBe("http://example.com/");
  });

  it("rejects active, local-file and credential-bearing URLs", () => {
    expect(normalizeExternalHttpUrl("javascript:alert(1)")).toBeUndefined();
    expect(normalizeExternalHttpUrl("data:text/html,test")).toBeUndefined();
    expect(normalizeExternalHttpUrl("file:///C:/secret.txt")).toBeUndefined();
    expect(normalizeExternalHttpUrl("https://user:pass@example.com/")).toBeUndefined();
  });

  it("rejects malformed and oversized values", () => {
    expect(normalizeExternalHttpUrl("not a url")).toBeUndefined();
    expect(normalizeExternalHttpUrl(`https://example.com/${"x".repeat(4096)}`)).toBeUndefined();
  });
});
