import { describe, expect, it } from "vitest";

import {
  buildSafeDiagnostics,
  sanitizeLogCode,
  sanitizeLogEvent,
  sanitizeLogFields,
} from "./logger-diagnostics";

describe("safe diagnostics", () => {
  it("contains only the documented connection fields and latest error metadata", () => {
    const result = JSON.parse(
      buildSafeDiagnostics(
        {
          hostVersion: "0.0.0",
          relayVersion: "0.0.0",
          port: 32_171,
          connected: true,
          authenticated: true,
          connectionPhase: "ready",
          protocolVersion: 8,
          detectedProtocol: "ask2gpt.v9",
          connectedAt: "2026-07-24T00:00:30.000Z",
          projectBound: true,
          selectorVersion: 1,
        },
        { code: "SELECTOR_INCOMPATIBLE", at: "2026-07-24T00:00:00.000Z" },
        "2026-07-24T00:01:00.000Z",
      ),
    ) as Record<string, unknown>;

    expect(result).toEqual({
      hostVersion: "0.0.0",
      relayVersion: "0.0.0",
      port: 32_171,
      connected: true,
      authenticated: true,
      connectionPhase: "ready",
      protocolVersion: 8,
      detectedProtocol: "ask2gpt.v9",
      connectedAt: "2026-07-24T00:00:30.000Z",
      projectBound: true,
      selectorVersion: 1,
      lastError: {
        code: "SELECTOR_INCOMPATIBLE",
        at: "2026-07-24T00:00:00.000Z",
      },
      generatedAt: "2026-07-24T00:01:00.000Z",
    });
    expect(result).not.toHaveProperty("instanceId");
    expect(JSON.stringify(result)).not.toContain("conversation");
  });

  it("drops unapproved fields and normalizes fixed diagnostic metadata", () => {
    expect(
      sanitizeLogFields({
        action: "send\nrequest",
        hostVersion: "0.0.0",
        relayVersion: "0.1.7",
        connectedAt: "2026-07-24T00:00:30.000Z",
        durationMs: 25,
        snapshots: 42,
        streamDurationMs: 1_800,
        averageGapMs: 44,
        maxGapMs: 130,
        maxChunkChars: 96,
        prompt: "private question",
        url: "https://chatgpt.com/c/private",
        instanceId: "private-instance",
      }),
    ).toEqual({
      action: "send request",
      hostVersion: "0.0.0",
      relayVersion: "0.1.7",
      connectedAt: "2026-07-24T00:00:30.000Z",
      durationMs: 25,
      snapshots: 42,
      streamDurationMs: 1_800,
      averageGapMs: 44,
      maxGapMs: 130,
      maxChunkChars: 96,
    });
    expect(sanitizeLogEvent("question\nprivate")).toBe("invalid-event");
    expect(sanitizeLogCode("private error message")).toBe("INVALID_ERROR_CODE");
  });
});
