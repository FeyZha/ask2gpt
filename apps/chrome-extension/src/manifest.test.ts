import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Chrome manifest permissions", () => {
  it("declares debugger as required because Chrome forbids it as an optional permission", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../public/manifest.json", import.meta.url), "utf8"),
    ) as {
      name: string;
      key: string;
      action: { default_title: string };
      permissions: string[];
      optional_permissions?: string[];
      host_permissions: string[];
      content_scripts: Array<{
        matches: string[];
        js: string[];
        run_at: string;
        world: string;
      }>;
      content_security_policy: { extension_pages: string };
    };

    expect(manifest.name).toBe("Ask2GPT Relay");
    expect(manifest.action.default_title).toBe("Ask2GPT Relay");
    expect(manifest.permissions.sort()).toEqual([
      "alarms",
      "debugger",
      "scripting",
      "storage",
      "tabs",
    ]);
    expect(manifest.optional_permissions).toBeUndefined();
    expect(manifest.host_permissions).toEqual(["https://chatgpt.com/*", "http://127.0.0.1/*"]);
    expect(manifest.content_scripts).toEqual([
      {
        matches: ["https://chatgpt.com/*"],
        js: ["page-model-bridge.js"],
        run_at: "document_start",
        world: "MAIN",
      },
      {
        matches: ["https://chatgpt.com/*"],
        js: ["content-script.js"],
        run_at: "document_idle",
        world: "ISOLATED",
      },
    ]);
    expect(manifest.permissions).not.toContain("nativeMessaging");
    expect(manifest.permissions).not.toContain("history");
    expect(manifest.permissions).not.toContain("downloads");

    const relayPorts = Array.from({ length: 10 }, (_, index) => 32_171 + index);
    const csp = manifest.content_security_policy.extension_pages;
    for (const port of relayPorts) {
      expect(csp).toContain(`ws://127.0.0.1:${port}`);
    }
    expect(csp).not.toContain("ws://127.0.0.1:*");
    expect(csp).not.toContain("ws://localhost");

    const alphabet = "abcdefghijklmnop";
    const digest = createHash("sha256")
      .update(Buffer.from(manifest.key, "base64"))
      .digest()
      .subarray(0, 16);
    const extensionId = [...digest]
      .map((byte) => `${alphabet[byte >> 4]}${alphabet[byte & 15]}`)
      .join("");
    expect(extensionId).toBe("jieljndeocnmdlfbmfknfgglfaoneceb");
  });
});
