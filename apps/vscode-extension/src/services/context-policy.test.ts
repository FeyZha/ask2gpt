import { describe, expect, it } from "vitest";

import {
  MAX_CONTEXT_ATTACHMENTS,
  MAX_CONTEXT_BUNDLE_CHARS,
  MAX_CONTEXT_CHARS,
  assertAllowedContext,
  assertAllowedContextBundle,
  isSensitiveContextFile,
} from "./context-policy";

describe("context policy", () => {
  it.each([
    ".env",
    ".env.local",
    ".envrc",
    ".environment",
    "server.pem",
    "private.key",
    "id_rsa",
    "id_ecdsa",
    ".npmrc",
    "credentials.json",
    "credentials-production.json",
    "service-account-prod.json",
    "release.keystore",
    String.raw`C:\project\.env.production`,
    "/home/user/.ssh/private.ppk",
  ])("blocks sensitive files: %s", (fileName) => {
    expect(isSensitiveContextFile(fileName)).toBe(true);
    expect(() => assertAllowedContext(fileName, "secret")).toThrow();
  });

  it("blocks binary and oversized content", () => {
    expect(() => assertAllowedContext("image.txt", "abc\u0000def")).toThrow("二进制");
    expect(() => assertAllowedContext("image.txt", "\u0001\u0002\u0003\u0004")).toThrow("二进制");
    expect(() => assertAllowedContext("large.ts", "x".repeat(MAX_CONTEXT_CHARS + 1))).toThrow(
      "上下文超过",
    );
  });

  it("enforces attachment count and aggregate content limits", () => {
    const context = { fileName: "service.ts", content: "x" };
    expect(() =>
      assertAllowedContextBundle(
        Array.from({ length: MAX_CONTEXT_ATTACHMENTS + 1 }, () => context),
      ),
    ).toThrow("最多只能附加");
    expect(() =>
      assertAllowedContextBundle([
        { fileName: "first.ts", content: "x".repeat(MAX_CONTEXT_CHARS) },
        {
          fileName: "second.ts",
          content: "x".repeat(MAX_CONTEXT_BUNDLE_CHARS - MAX_CONTEXT_CHARS + 1),
        },
      ]),
    ).toThrow("附件内容合计");
  });

  it("allows an ordinary explicit code selection", () => {
    expect(() => assertAllowedContext("service.ts", "export const ok = true;")).not.toThrow();
  });

  it.each(["environment.ts", "credential-store.ts", "public-key.ts"])(
    "does not block ordinary source files: %s",
    (fileName) => {
      expect(isSensitiveContextFile(fileName)).toBe(false);
    },
  );
});
