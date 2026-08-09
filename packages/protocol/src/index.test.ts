import { describe, expect, it } from "vitest";

import {
  MAX_CONCURRENT_RUNS,
  PROTOCOL_VERSION,
  RELAY_WEBSOCKET_PROTOCOL,
  isChromeToHostMessageType,
  isGenericConversationTitle,
  isHostToChromeMessageType,
  isRelayIdentifier,
  isRelayProductVersionCompatible,
  makeEnvelope,
  makeRelayStatusRequestPayload,
  safeParseRelayEnvelope,
} from "./index";
import type { ContextSnapshot, NotebookSourceAnchorV2, SourceAnchorV1 } from "./index";

describe("relay protocol", () => {
  it("keeps source anchors versioned while legacy context snapshots remain valid", () => {
    const sourceAnchor: SourceAnchorV1 = {
      formatVersion: 1,
      contentSha256: "a".repeat(64),
      normalizedContentSha256: "b".repeat(64),
      documentVersion: 7,
      beforeLineSha256: "c".repeat(64),
      afterLineSha256: "d".repeat(64),
      workspaceRelativePath: "src/index.ts",
    };
    const current: ContextSnapshot = {
      id: "context-current",
      kind: "selection",
      fileName: "src/index.ts",
      uri: "file:///workspace/src/index.ts",
      language: "typescript",
      startLine: 2,
      endLine: 2,
      content: "const answer = 42;",
      charCount: 18,
      unsaved: false,
      sourceAnchor,
    };
    const legacy: ContextSnapshot = {
      id: "context-legacy",
      kind: "file",
      fileName: "legacy.ts",
      uri: "file:///workspace/legacy.ts",
      language: "typescript",
      startLine: 1,
      endLine: 1,
      content: "export {};",
      charCount: 10,
      unsaved: false,
    };

    expect(current.sourceAnchor).toEqual(sourceAnchor);
    expect(legacy.sourceAnchor).toBeUndefined();
  });

  it("models notebook cell provenance without making a virtual cell URI authoritative", () => {
    const sourceAnchor: NotebookSourceAnchorV2 = {
      formatVersion: 2,
      notebookUri: "file:///workspace/analysis.ipynb",
      notebookType: "jupyter-notebook",
      notebookVersion: 8,
      cellIndex: 3,
      cellKind: "code",
      cellLanguage: "python",
      scope: "range",
      documentVersion: 5,
      range: { startLine: 1, startCharacter: 0, endLine: 2, endCharacter: 4 },
      contentSha256: "a".repeat(64),
      normalizedContentSha256: "b".repeat(64),
      cellContentSha256: "c".repeat(64),
      normalizedCellContentSha256: "d".repeat(64),
      beforeCellSha256: "e".repeat(64),
      afterCellSha256: "f".repeat(64),
      workspaceRelativePath: "analysis.ipynb",
    };
    const context: ContextSnapshot = {
      id: "context-notebook",
      kind: "selection",
      fileName: "analysis.ipynb",
      uri: sourceAnchor.notebookUri,
      language: sourceAnchor.cellLanguage,
      startLine: 2,
      endLine: 3,
      content: "x = 1\nprint(x)",
      charCount: 14,
      unsaved: true,
      sourceAnchor,
    };

    expect(context.uri).toBe("file:///workspace/analysis.ipynb");
    expect(JSON.stringify(context)).not.toContain("vscode-notebook-cell:");
  });

  it("classifies conversation placeholders and accessibility navigation as generic titles", () => {
    for (const title of [
      "New chat",
      " SKIP   TO CONTENT ",
      "Skip to main content",
      "Jump to content",
      "Main content",
      "跳至内容",
      "跳到主要内容",
      "主要内容",
      "跳至主要內容",
    ]) {
      expect(isGenericConversationTitle(title)).toBe(true);
    }
    expect(isGenericConversationTitle("Understanding event loops")).toBe(false);
  });

  it("uses protocol v15 for prewarmed transcript proofs", () => {
    expect(PROTOCOL_VERSION).toBe(15);
    expect(RELAY_WEBSOCKET_PROTOCOL).toBe("ask2gpt.v15");
  });

  it("allows either update order within the reviewed v15 product release line", () => {
    expect(isRelayProductVersionCompatible("0.1.0", "0.1.0")).toBe(true);
    expect(isRelayProductVersionCompatible("0.1.0", "0.1.1")).toBe(true);
    expect(isRelayProductVersionCompatible("0.1.1", "0.1.0")).toBe(true);
    expect(isRelayProductVersionCompatible("0.1.0", "0.0.1")).toBe(false);
    expect(isRelayProductVersionCompatible("0.1.1", "0.1.2")).toBe(true);
    expect(isRelayProductVersionCompatible("0.1.2", "0.1.3")).toBe(true);
    expect(isRelayProductVersionCompatible("0.1.3", "0.1.2")).toBe(true);
    expect(isRelayProductVersionCompatible("0.1.1", "0.1.3")).toBe(false);
    expect(isRelayProductVersionCompatible("0.1.0", "0.2.0")).toBe(false);
  });

  it("accepts a dedicated Host-to-Chrome status request and rejects a forged status event", () => {
    const payload = makeRelayStatusRequestPayload();
    expect(
      safeParseRelayEnvelope({
        version: PROTOCOL_VERSION,
        id: "status-request-a",
        type: "relay.status.request",
        instanceId: "window-a",
        payload,
      }).success,
    ).toBe(true);
    expect(isHostToChromeMessageType("relay.status.request")).toBe(true);
    expect(isHostToChromeMessageType("relay.status")).toBe(false);
    expect(
      safeParseRelayEnvelope({
        version: PROTOCOL_VERSION,
        id: "illegal-status-a",
        type: "relay.status",
        instanceId: "window-a",
        payload: {},
      }).success,
    ).toBe(false);
  });

  it("validates a Host acknowledgement for a durably applied terminal event", () => {
    expect(
      safeParseRelayEnvelope({
        version: PROTOCOL_VERSION,
        id: "terminal-ack-a",
        type: "generation.ack",
        instanceId: "window-a",
        conversationId: "conversation-a",
        runId: "run-a",
        payload: {
          eventId: "terminal-event-a",
          acknowledgedAt: new Date().toISOString(),
        },
      }).success,
    ).toBe(true);
  });

  it("validates request-correlated conversation cleanup acknowledgements", () => {
    const acknowledgement = makeEnvelope({
      type: "conversation.closed",
      instanceId: "window-a",
      conversationId: "conversation-a",
      payload: {
        requestId: "close-request-a",
        closeTab: true,
        tabDisposition: "closed",
      },
    });

    expect(safeParseRelayEnvelope(acknowledgement).success).toBe(true);
    expect(isChromeToHostMessageType("conversation.closed")).toBe(true);
    expect(
      safeParseRelayEnvelope({
        ...acknowledgement,
        payload: { ...acknowledgement.payload, tabDisposition: "assumed" },
      }).success,
    ).toBe(false);
  });

  it("validates explicit lease purposes while preserving legacy conversation.open payloads", () => {
    const base = {
      version: PROTOCOL_VERSION,
      id: "open-request-a",
      type: "conversation.open",
      instanceId: "window-a",
      conversationId: "conversation-a",
    } as const;

    expect(safeParseRelayEnvelope({ ...base, payload: { active: true } }).success).toBe(true);
    expect(safeParseRelayEnvelope({ ...base, payload: { dispatchIntent: true } }).success).toBe(
      true,
    );
    expect(
      safeParseRelayEnvelope({
        ...base,
        payload: { active: false, dispatchIntent: true, purpose: "dispatch" },
      }).success,
    ).toBe(true);
    expect(
      safeParseRelayEnvelope({
        ...base,
        payload: { active: true, dispatchIntent: true, purpose: "view" },
      }).success,
    ).toBe(false);
    expect(
      safeParseRelayEnvelope({
        ...base,
        payload: { dispatchIntent: false, purpose: "dispatch" },
      }).success,
    ).toBe(false);
    expect(safeParseRelayEnvelope({ ...base, payload: { purpose: "background" } }).success).toBe(
      false,
    );
  });

  it("validates non-destructive lease release requests and correlated acknowledgements", () => {
    const release = makeEnvelope({
      type: "conversation.release",
      instanceId: "window-a",
      conversationId: "conversation-a",
      payload: { purpose: "view", reason: "inactive" },
    });
    const acknowledgement = makeEnvelope({
      type: "conversation.released",
      instanceId: "window-a",
      conversationId: "conversation-a",
      payload: {
        requestId: release.id,
        purpose: "view",
        reason: "inactive",
      },
    });

    expect(safeParseRelayEnvelope(release).success).toBe(true);
    expect(safeParseRelayEnvelope(acknowledgement).success).toBe(true);
    expect(isHostToChromeMessageType("conversation.release")).toBe(true);
    expect(isChromeToHostMessageType("conversation.release")).toBe(false);
    expect(isChromeToHostMessageType("conversation.released")).toBe(true);
    expect(isHostToChromeMessageType("conversation.released")).toBe(false);
    expect(
      safeParseRelayEnvelope({
        ...release,
        payload: { purpose: "view", reason: "deleted" },
      }).success,
    ).toBe(false);
    expect(
      safeParseRelayEnvelope({
        ...acknowledgement,
        payload: { purpose: "view", reason: "inactive" },
      }).success,
    ).toBe(false);
  });

  it("validates ChatGPT model families and reasoning modes", () => {
    const catalog = makeEnvelope({
      type: "model.catalog",
      instanceId: "window-a",
      conversationId: "conversation-a",
      payload: {
        requestId: "request-a",
        currentModelId: "visible-a1b2c3d4",
        options: [
          {
            id: "visible-a1b2c3d4",
            label: "Extra High",
            mode: "very-high",
            modelId: "gpt-5-6-thinking",
            familyLabel: "GPT-5.6 Sol",
            reasoningEffort: "max",
            selected: true,
          },
        ],
      },
    });
    expect(safeParseRelayEnvelope(catalog).success).toBe(true);
    expect(isChromeToHostMessageType("model.catalog")).toBe(true);
    expect(
      safeParseRelayEnvelope({
        ...catalog,
        payload: {
          ...catalog.payload,
          options: [{ ...catalog.payload.options[0], reasoningEffort: "unbounded" }],
        },
      }).success,
    ).toBe(false);
  });

  it("normalizes Windows prompt line endings before validating the visible prompt budget", () => {
    const prompt = "x\r\n".repeat(50_000);
    const parsed = safeParseRelayEnvelope(
      makeEnvelope({
        type: "conversation.send",
        instanceId: "test",
        conversationId: "conversation",
        runId: "run",
        payload: { prompt, messageId: "message" },
      }),
    );

    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.type !== "conversation.send") return;
    expect(parsed.data.payload.prompt).toBe("x\n".repeat(50_000));
    expect(parsed.data.payload.prompt).toHaveLength(100_000);
  });

  it("carries an optional model intent with the exact send request", () => {
    const parsed = safeParseRelayEnvelope(
      makeEnvelope({
        type: "conversation.send",
        instanceId: "test",
        conversationId: "conversation",
        runId: "run",
        payload: {
          prompt: "hello",
          messageId: "message",
          modelId: "visible-1234abcd",
        },
      }),
    );
    expect(parsed.success).toBe(true);
    expect(
      safeParseRelayEnvelope(
        makeEnvelope({
          type: "conversation.send",
          instanceId: "test",
          conversationId: "conversation",
          runId: "run",
          payload: { prompt: "hello", messageId: "message", modelId: "not allowed" },
        }),
      ).success,
    ).toBe(false);
  });

  it("carries a bounded content-free transcript proof for prewarmed dispatch", () => {
    const transcriptProof = {
      remoteUrl: "https://chatgpt.com/c/transcript-proof",
      messageCount: 2,
      messageHashes: [
        { role: "user" as const, sha256: "a".repeat(64) },
        { role: "assistant" as const, sha256: "b".repeat(64) },
      ],
      transcriptChainSha256: "c".repeat(64),
    };
    const send = makeEnvelope({
      type: "conversation.send",
      instanceId: "test",
      conversationId: "conversation",
      runId: "run",
      payload: {
        prompt: "hello",
        messageId: "message",
        remoteUrl: transcriptProof.remoteUrl,
        transcriptProof,
      },
    });

    expect(safeParseRelayEnvelope(send).success).toBe(true);
    expect(
      safeParseRelayEnvelope({
        ...send,
        payload: {
          ...send.payload,
          transcriptProof: { ...transcriptProof, messageCount: 3 },
        },
      }).success,
    ).toBe(false);
  });

  it("validates bounded text-file attachments on send requests", () => {
    const envelope = makeEnvelope({
      type: "conversation.send",
      instanceId: "test",
      conversationId: "conversation",
      runId: "run",
      payload: {
        prompt: "Review the attached file.",
        messageId: "message",
        attachments: [
          {
            id: "context-1",
            fileName: "large.ts",
            mimeType: "text/typescript",
            content: "export const answer = 42;",
          },
        ],
      },
    });
    expect(safeParseRelayEnvelope(envelope).success).toBe(true);
    expect(
      safeParseRelayEnvelope({
        ...envelope,
        payload: {
          ...envelope.payload,
          attachments: [{ ...envelope.payload.attachments[0], fileName: "../secret.ts" }],
        },
      }).success,
    ).toBe(false);
  });

  it("validates identifiers shared by persisted VS Code instances", () => {
    expect(isRelayIdentifier("window-1.a_b")).toBe(true);
    expect(isRelayIdentifier("window:1")).toBe(false);
    expect(isRelayIdentifier("")).toBe(false);
    expect(isRelayIdentifier(undefined)).toBe(false);
  });

  it("requires a versioned ready/hello handshake with the fixed companion ID", () => {
    const ready = makeEnvelope({
      type: "relay.ready",
      instanceId: "window-a",
      payload: { serverLabel: "VS Code", serverInstanceId: "window-a" },
    });
    const hello = makeEnvelope({
      type: "relay.hello",
      instanceId: "window-a",
      payload: {
        chromeExtensionId: "jieljndeocnmdlfbmfknfgglfaoneceb",
        chromeVersion: "0.0.1",
      },
    });

    expect(safeParseRelayEnvelope(ready).success).toBe(true);
    expect(safeParseRelayEnvelope(hello).success).toBe(true);
    expect(isChromeToHostMessageType("relay.hello")).toBe(true);
    expect(
      safeParseRelayEnvelope({
        ...hello,
        payload: { ...hello.payload, chromeExtensionId: "unexpected-extension" },
      }).success,
    ).toBe(false);
    expect(
      safeParseRelayEnvelope({
        ...hello,
        payload: { ...hello.payload, chromeVersion: "0.0.1\nprivate" },
      }).success,
    ).toBe(false);
  });

  it("creates and validates a versioned envelope", () => {
    const envelope = makeEnvelope({
      type: "relay.status",
      instanceId: "test-instance",
      payload: {
        connected: true,
        authenticated: true,
        activeRuns: 1,
        selectorVersion: 1,
        project: { bound: true, name: "Ask2GPT" },
      },
    });

    expect(envelope.version).toBe(PROTOCOL_VERSION);
    expect(safeParseRelayEnvelope(envelope).success).toBe(true);
  });

  it("rejects unknown messages, protocol versions, and unknown fields", () => {
    expect(
      safeParseRelayEnvelope({
        version: PROTOCOL_VERSION,
        id: "1",
        type: "unknown",
        instanceId: "test",
        payload: {},
      }).success,
    ).toBe(false);
    expect(
      safeParseRelayEnvelope({
        version: 999,
        id: "1",
        type: "heartbeat",
        instanceId: "test",
        payload: { at: new Date().toISOString() },
      }).success,
    ).toBe(false);
    expect(
      safeParseRelayEnvelope({
        version: PROTOCOL_VERSION,
        id: "1",
        type: "heartbeat",
        instanceId: "test",
        payload: { at: new Date().toISOString(), injected: true },
      }).success,
    ).toBe(false);
  });

  it("rejects the legacy protocol before feature-specific messages are exchanged", () => {
    for (const version of [1, 3, 4, 5, 6]) {
      expect(
        safeParseRelayEnvelope({
          version,
          id: `legacy-${version}`,
          type: "heartbeat",
          instanceId: "test",
          payload: { at: new Date().toISOString() },
        }).success,
      ).toBe(false);
    }
  });

  it("accepts canonical global or conservatively scoped Project URLs", () => {
    const valid = makeEnvelope({
      type: "conversation.open",
      instanceId: "test",
      conversationId: "conversation",
      payload: {
        dispatchIntent: true,
        remoteUrl: "https://chatgpt.com/c/abc?temporary=value",
      },
    });
    expect(safeParseRelayEnvelope(valid).success).toBe(true);
    expect(
      safeParseRelayEnvelope({
        ...valid,
        id: crypto.randomUUID(),
        payload: {
          remoteUrl: "https://chatgpt.com/g/runtime-project-slug/project?temporary=value",
        },
      }).success,
    ).toBe(true);
    expect(
      safeParseRelayEnvelope({
        ...valid,
        id: crypto.randomUUID(),
        payload: {
          remoteUrl: "https://chatgpt.com/g/runtime-project-slug/c/conversation-id#message",
        },
      }).success,
    ).toBe(true);

    for (const remoteUrl of [
      "https://chatgpt.com/c/abc/extra",
      "https://chatgpt.com/g/runtime-project-slug/settings",
      "https://chatgpt.com/g/runtime-project-slug/c/id/extra",
      "https://chatgpt.com/g/runtime-project%2Fescape/project",
      "https://chatgpt.com/backend-api/private",
      "https://example.com/c/abc",
    ]) {
      expect(
        safeParseRelayEnvelope({
          ...valid,
          id: crypto.randomUUID(),
          payload: { remoteUrl },
        }).success,
      ).toBe(false);
    }
  });

  it("validates payloads instead of accepting arbitrary unknown data", () => {
    const invalidSnapshot = makeEnvelope({
      type: "generation.snapshot",
      instanceId: "test",
      conversationId: "conversation",
      runId: "run",
      payload: {
        markdown: 42,
        remoteUrl: "https://chatgpt.com/c/valid",
        startedAt: new Date().toISOString(),
      },
    });
    const missingRun = makeEnvelope({
      type: "generation.snapshot",
      instanceId: "test",
      conversationId: "conversation",
      payload: {
        markdown: "answer",
        startedAt: new Date().toISOString(),
      },
    });

    expect(safeParseRelayEnvelope(invalidSnapshot).success).toBe(false);
    expect(safeParseRelayEnvelope(missingRun).success).toBe(false);
  });

  it("accepts only a canonical, bounded remote conversation title event", () => {
    const valid = makeEnvelope({
      type: "conversation.title",
      instanceId: "test",
      conversationId: "conversation",
      payload: {
        title: "Understanding event loops",
        remoteUrl: "https://chatgpt.com/g/project-scope/c/conversation",
        observedAt: new Date().toISOString(),
      },
    });

    expect(safeParseRelayEnvelope(valid).success).toBe(true);
    expect(isChromeToHostMessageType("conversation.title")).toBe(true);
    for (const payload of [
      { ...valid.payload, title: "" },
      { ...valid.payload, title: "New chat" },
      { ...valid.payload, title: "Skip to content" },
      { ...valid.payload, title: "主要内容" },
      { ...valid.payload, title: " padded " },
      { ...valid.payload, title: "unsafe\u0000title" },
      { ...valid.payload, title: "x".repeat(81) },
      { ...valid.payload, remoteUrl: "https://chatgpt.com/g/project-scope/project" },
      { ...valid.payload, remoteUrl: "https://chatgpt.com/other/project-scope/c/conversation" },
      { ...valid.payload, remoteUrl: `${valid.payload.remoteUrl}?private=value` },
      { ...valid.payload, remoteUrl: "https://example.com/c/conversation" },
      { ...valid.payload, observedAt: "not-a-date" },
      { ...valid.payload, injected: true },
    ]) {
      expect(
        safeParseRelayEnvelope({
          ...valid,
          id: crypto.randomUUID(),
          payload,
        }).success,
      ).toBe(false);
    }
  });

  it("requires a bounded run proof for post-completion URL promotion", () => {
    const valid = makeEnvelope({
      type: "conversation.snapshot",
      instanceId: "test",
      conversationId: "conversation",
      payload: {
        remoteUrl: "https://chatgpt.com/g/ask2gpt/c/canonical-b",
        messages: [{ role: "assistant" as const, markdown: "OK" }],
        observedAt: new Date().toISOString(),
        complete: true,
        urlPromotion: {
          runId: "completed-run",
          fromRemoteUrl: "https://chatgpt.com/c/provisional-a",
          terminalMarkdownSha256:
            "565339bc4d33d72817b58302411201f1d3dbb3d8fbe2b8774b48ea9d985a763f",
          terminalTranscriptSha256:
            "b3f05c068c6cd19746a273ae34e3a810328491d56b590b0ef61bc777b14a4f53",
        },
      },
    });

    expect(safeParseRelayEnvelope(valid).success).toBe(true);
    expect(
      safeParseRelayEnvelope({
        ...valid,
        payload: {
          ...valid.payload,
          urlPromotion: { ...valid.payload.urlPromotion, runId: "unsafe:run" },
        },
      }).success,
    ).toBe(false);
    expect(
      safeParseRelayEnvelope({
        ...valid,
        payload: {
          ...valid.payload,
          urlPromotion: {
            ...valid.payload.urlPromotion,
            terminalMarkdownSha256: "not-a-sha256",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("validates a transcript-bound canonicalization check and promoted result", () => {
    const binding = {
      requestId: "settle-request",
      runId: "completed-run",
      fromRemoteUrl: "https://chatgpt.com/c/provisional-a",
      terminalMarkdownSha256: "565339bc4d33d72817b58302411201f1d3dbb3d8fbe2b8774b48ea9d985a763f",
      terminalTranscriptSha256: "b3f05c068c6cd19746a273ae34e3a810328491d56b590b0ef61bc777b14a4f53",
    };
    const check = makeEnvelope({
      type: "conversation.canonicalization.check",
      instanceId: "window-a",
      conversationId: "conversation-a",
      payload: binding,
    });
    const result = makeEnvelope({
      type: "conversation.canonicalization.result",
      instanceId: "window-a",
      conversationId: "conversation-a",
      payload: {
        ...binding,
        status: "promoted" as const,
        snapshot: {
          remoteUrl: "https://chatgpt.com/g/ask2gpt/c/canonical-b",
          messages: [{ role: "assistant" as const, markdown: "OK" }],
          observedAt: new Date().toISOString(),
          complete: true,
          urlPromotion: {
            runId: binding.runId,
            fromRemoteUrl: binding.fromRemoteUrl,
            terminalMarkdownSha256: binding.terminalMarkdownSha256,
            terminalTranscriptSha256: binding.terminalTranscriptSha256,
          },
        },
      },
    });

    expect(safeParseRelayEnvelope(check).success).toBe(true);
    expect(safeParseRelayEnvelope(result).success).toBe(true);
    expect(isChromeToHostMessageType("conversation.canonicalization.result")).toBe(true);
    expect(
      safeParseRelayEnvelope({
        ...result,
        payload: {
          ...result.payload,
          snapshot: { ...result.payload.snapshot, complete: false },
        },
      }).success,
    ).toBe(false);
  });

  it("validates a bounded visible-conversation history snapshot", () => {
    const snapshot = makeEnvelope({
      type: "conversation.snapshot",
      instanceId: "window-a",
      conversationId: "conversation-a",
      payload: {
        remoteUrl: "https://chatgpt.com/c/remote-a",
        title: "Event loop explanation",
        messages: [
          { role: "user", markdown: "Explain the event loop." },
          { role: "assistant", markdown: "The event loop coordinates queued work." },
        ],
        observedAt: new Date().toISOString(),
        complete: true,
      },
    });

    expect(safeParseRelayEnvelope(snapshot).success).toBe(true);
    expect(isChromeToHostMessageType("conversation.snapshot")).toBe(true);
    expect(
      safeParseRelayEnvelope({
        ...snapshot,
        payload: { ...snapshot.payload, messages: [{ role: "system", markdown: "hidden" }] },
      }).success,
    ).toBe(false);
    expect(
      safeParseRelayEnvelope({
        ...snapshot,
        payload: { ...snapshot.payload, remoteUrl: "https://chatgpt.com/c/remote-a?private=1" },
      }).success,
    ).toBe(false);
  });

  it("only accepts ChatGPT HTTPS URLs without embedded credentials", () => {
    const createSend = (remoteUrl: string) =>
      makeEnvelope({
        type: "conversation.send",
        instanceId: "test",
        conversationId: "conversation",
        runId: "run",
        payload: { prompt: "hello", messageId: "message", remoteUrl },
      });

    expect(safeParseRelayEnvelope(createSend("https://chatgpt.com/c/abc")).success).toBe(true);
    expect(safeParseRelayEnvelope(createSend("https://evil.example/c/abc")).success).toBe(false);
    expect(safeParseRelayEnvelope(createSend("https://user@chatgpt.com/c/abc")).success).toBe(
      false,
    );
  });

  it("rejects delimiter-bearing IDs to keep compound Chrome keys collision-free", () => {
    const envelope = makeEnvelope({
      type: "generation.stop",
      instanceId: "window:conversation",
      conversationId: "run",
      runId: "1",
      payload: { requestedAt: new Date().toISOString() },
    });

    expect(safeParseRelayEnvelope(envelope).success).toBe(false);
  });

  it("requires relay error run IDs to have a conversation ID", () => {
    const envelope = makeEnvelope({
      type: "relay.error",
      instanceId: "test",
      runId: "run",
      payload: {
        code: "INTERNAL_ERROR",
        message: "failed",
        recoverable: true,
      },
    });

    expect(safeParseRelayEnvelope(envelope).success).toBe(false);
  });

  it("fixes the MVP concurrency limit", () => {
    expect(MAX_CONCURRENT_RUNS).toBe(3);
  });
});
