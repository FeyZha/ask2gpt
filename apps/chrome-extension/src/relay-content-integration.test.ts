// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://chatgpt.com/g/ask2gpt/project"}

import {
  CHROME_EXTENSION_ID,
  PROTOCOL_VERSION,
  makeEnvelope,
  makeRelayStatusRequestPayload,
  type RelayEnvelope,
} from "@ask2gpt/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FakeChromeRelayHarness,
  FakeRelayWebSocket,
  waitUntil,
} from "./test-support/fake-chrome-relay";
import { readComposerText } from "./composer-input";
import { CONTENT_RUNTIME_REVISION } from "./content-runtime-policy";
import { promptInlinePresentationV1, singleBlockPromptPresentation } from "./prompt-presentation";

const INSTANCE_ID = "window-a";
const CONVERSATION_ID = "conversation-a";
const FIRST_RUN_ID = "run-first";
const SECOND_RUN_ID = "run-follow-up";
const PROJECT_ROOT = "https://chatgpt.com/g/ask2gpt/project";
const PROJECT_SCOPE = "https://chatgpt.com/g/ask2gpt/";
const OTHER_PROJECT_ROOT = "https://chatgpt.com/g/other-project/project";
const OTHER_PROJECT_SCOPE = "https://chatgpt.com/g/other-project/";
const REMOTE_A = `${PROJECT_SCOPE}c/remote-a`;
const OTHER_REMOTE = `${OTHER_PROJECT_SCOPE}c/remote-other`;
const REMOTE_B = `${PROJECT_SCOPE}c/remote-b`;
const REMOTE_C = `${PROJECT_SCOPE}c/remote-c`;
const FIRST_PROMPT_SHA256 = "1b17517f73f0c23efbbc1d55fa47512ecd01df0f41920ed33e9dde2159babcac";
const PROJECT_DIRECTORY_REFRESH_REQUEST_ATTRIBUTE =
  "data-ask2gpt-project-directory-refresh-request";
const PROJECT_DIRECTORY_REFRESH_RESULT_ATTRIBUTE = "data-ask2gpt-project-directory-refresh-result";
const PROJECT_DIRECTORY_REFRESH_REQUEST_EVENT = "ask2gpt:project-directory-refresh-request";
const PROJECT_DIRECTORY_REFRESH_RESULT_EVENT = "ask2gpt:project-directory-refresh-result";
const fixtureTimeouts = new Set<number>();

describe("MV3 relay and ChatGPT content-script integration", () => {
  afterEach(async () => {
    clearFixtureTimeouts();
    window.dispatchEvent(new Event("pagehide"));
    FakeChromeRelayHarness.suspendActive();
    // Let callbacks released by pagehide/onSuspend observe the old, suspended
    // harness before the next test installs a new global Chrome API. Without
    // this turn, a slow CI worker can deliver an old run event into the next
    // test because the integration fixture intentionally reuses one document.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, "execCommand");
    Reflect.deleteProperty(document, "elementFromPoint");
    document.body.replaceChildren();
    document.head.querySelectorAll("style").forEach((style) => style.remove());
    document.documentElement.removeAttribute("data-ask2gpt-project-binding");
    window.history.replaceState({}, "", PROJECT_ROOT);
  });

  it("reuses a prewarmed tab and refreshes one bounded idle transcript proof", async () => {
    const { harness, socket, tab } = await startHarness();
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: harness.tabsById.get(tab.id)?.url,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: PROJECT_ROOT,
          complete: true,
          historyComplete: true,
          messages: [],
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });

    await waitUntil(
      () =>
        harness.timeline.filter(
          (entry) => entry === `tabs.sendMessage:response:${tab.id}:content.inspectConversation`,
        ).length >= 3,
      5_000,
    ).catch(() => {
      throw new Error(
        `Initial prewarm did not finish. Timeline: ${JSON.stringify(harness.timeline)} Outbound: ${JSON.stringify(
          harness.outboundEnvelopes(socket).map((envelope) => envelope.type),
        )}`,
      );
    });
    const inspectionsBefore = harness.timeline.filter(
      (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.inspectConversation`,
    ).length;

    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        payload: { active: false },
      }),
    );
    await waitUntil(
      () =>
        harness.timeline.filter(
          (entry) => entry === `tabs.sendMessage:response:${tab.id}:content.inspectConversation`,
        ).length >=
        inspectionsBefore + 4,
      5_000,
    ).catch(() => {
      throw new Error(
        `Repeated prewarm did not finish. Timeline: ${JSON.stringify(harness.timeline)} Outbound: ${JSON.stringify(
          harness.outboundEnvelopes(socket).map((envelope) => envelope.type),
        )}`,
      );
    });
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.inspectConversation`,
      ).length - inspectionsBefore,
    ).toBe(4);
  }, 12_000);

  it("streams a minimized-window run through the default debugger capture", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    harness.setDebuggerPermission(true);
    seedProjectBinding(harness);
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);
    await expect(harness.sendPopupMessage({ type: "popup.status" })).resolves.toMatchObject({
      backgroundReception: { enhancedEnabled: true, permissionGranted: true },
    });

    const tabPromise = harness.waitForCreatedTab();
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        payload: { active: false },
      }),
    );
    const tab = await tabPromise;
    harness.installTabMessageResponder(tab.id!, async (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: PROJECT_ROOT,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.composerStatus")) {
        const debuggerPageAwake = harness.timeline.includes(
          `debugger.command-target:${tab.id}:root:Page.setWebLifecycleState`,
        );
        const chromeWindow = await chrome.windows.get(tab.windowId!);
        const visible = chromeWindow.state !== "minimized";
        return {
          ok: true,
          ready: debuggerPageAwake,
          rawCandidateCount: 1,
          readyCandidateCount: debuggerPageAwake ? 1 : 0,
          visibilityState: visible ? "visible" : "hidden",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: PROJECT_ROOT,
          complete: true,
          historyComplete: true,
          messages: [],
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.terminalAck")) return { ok: true };
      return { ok: false };
    });

    const homeWindowId = tab.windowId!;
    harness.setWindowState(homeWindowId, "minimized");
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await waitUntil(() => harness.timeline.includes(`debugger.attach:${tab.id}`)).catch(() => {
      throw new Error(`Debugger was not attached. Timeline: ${JSON.stringify(harness.timeline)}`);
    });
    await waitUntil(() =>
      harness.timeline.includes(`debugger.command-target:${tab.id}:root:Target.setAutoAttach`),
    );
    const debuggerAttachIndex = harness.timeline.indexOf(`debugger.attach:${tab.id}`);
    const offscreenRestoreIndex = harness.timeline.indexOf(
      `window-updated:${homeWindowId}:state:normal`,
    );
    expect(debuggerAttachIndex).toBeGreaterThanOrEqual(0);
    expect(offscreenRestoreIndex).toBeGreaterThanOrEqual(0);
    // The home window must reach its validated off-screen normal state before
    // the debugger prepares the exact renderer; no capture may wake a still
    // visibly positioned minimized window.
    expect(offscreenRestoreIndex).toBeLessThan(debuggerAttachIndex);
    expect(
      harness.timeline.includes(
        `debugger.command-target:${tab.id}:root:Emulation.setFocusEmulationEnabled`,
      ),
    ).toBe(true);
    const jsonRequestId = "conversation-json-bookkeeping";
    const jsonResponseUrl = "https://chatgpt.com/backend-api/f/conversation";
    harness.emitDebuggerEvent(tab.id!, "Network.requestWillBeSent", {
      requestId: jsonRequestId,
      request: { method: "POST", url: jsonResponseUrl },
    });
    harness.emitDebuggerEvent(tab.id!, "Network.responseReceived", {
      requestId: jsonRequestId,
      response: { mimeType: "application/json", url: jsonResponseUrl },
    });
    harness.emitDebuggerEvent(tab.id!, "Network.loadingFinished", { requestId: jsonRequestId });
    const workerSessionId = "chatgpt-worker-session";
    harness.emitDebuggerEvent(tab.id!, "Target.attachedToTarget", {
      sessionId: workerSessionId,
      targetInfo: {
        targetId: "chatgpt-worker",
        type: "worker",
        url: "https://chatgpt.com/assets/chat-worker.js",
      },
    });
    await waitUntil(() =>
      harness.timeline.includes(
        `debugger.command-target:${tab.id}:${workerSessionId}:Network.enable`,
      ),
    );
    const requestId = "enhanced-request-1";
    const responseUrl = "https://chatgpt.com/backend-api/f/conversation/resume";
    harness.emitDebuggerEvent(
      tab.id!,
      "Network.requestWillBeSent",
      {
        requestId,
        request: { method: "POST", url: responseUrl },
      },
      workerSessionId,
    );
    harness.emitDebuggerEvent(
      tab.id!,
      "Network.responseReceived",
      {
        requestId,
        response: { mimeType: "text/event-stream", url: responseUrl },
      },
      workerSessionId,
    );
    const firstSnapshotWriteBarrier = harness.pauseNextSessionWrite(
      (values) =>
        (
          values.activeRunsV2 as Array<{ runId?: string; responseObserved?: boolean }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.responseObserved === true) === true,
    );
    // The shared socket can deliver the first assistant delta before Chrome
    // exposes the HTTP stream_handoff topic. Keep it bounded until the exact
    // topic arrives instead of silently losing the first useful text.
    harness.emitDebuggerEvent(
      tab.id!,
      "Network.webSocketFrameReceived",
      {
        requestId: "shared-chat-websocket",
        response: {
          opcode: 1,
          payloadData: JSON.stringify({
            type: "message",
            topic_id: "conversation-turn-a",
            payload: {
              payload: {
                encoded_item:
                  'event: delta\ndata: {"o":"add","p":"","v":{"message":{"author":{"role":"assistant"},"content":{"parts":[""]}}}}\n\n' +
                  'event: delta\ndata: {"o":"append","p":"/message/content/parts/0","v":"Answer captured"}\n\n',
              },
            },
          }),
        },
      },
      workerSessionId,
    );
    harness.emitDebuggerEvent(
      tab.id!,
      "Network.dataReceived",
      {
        requestId,
        data: utf8Base64(
          'event: delta_encoding\ndata: "v1"\n\n' +
            'data: {"type":"stream_handoff","conversation_id":"remote-a","turn_exchange_id":"turn-a","options":[' +
            '{"type":"resume_sse_endpoint","topic_id":"conversation-turn-a"},' +
            '{"type":"subscribe_ws_topic","topic_id":"conversation-turn-a"}' +
            "]}\n\n" +
            "data: [DONE]\n\n",
        ),
      },
      workerSessionId,
    );
    harness.emitDebuggerEvent(tab.id!, "Network.loadingFinished", { requestId }, workerSessionId);
    const firstSnapshot = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "generation.snapshot" &&
        envelope.runId === FIRST_RUN_ID &&
        (envelope.payload as { markdown?: string }).markdown === "Answer captured",
    );
    expect((firstSnapshot.payload as { markdown?: string }).markdown).toBe("Answer captured");
    // The first useful text must not wait for the recovery-hint checkpoint.
    // The deferred write begins afterwards and can be released independently.
    await firstSnapshotWriteBarrier.entered;
    firstSnapshotWriteBarrier.release();
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
        ),
    ).toBe(false);

    harness.emitDebuggerEvent(
      tab.id!,
      "Network.webSocketFrameReceived",
      {
        requestId: "shared-chat-websocket",
        response: {
          opcode: 1,
          payloadData: JSON.stringify({
            type: "message",
            topic_id: "conversation-turn-a",
            payload: {
              payload: {
                encoded_item:
                  'event: delta\ndata: {"o":"append","p":"/message/content/parts/0","v":" while minimized"}\n\n',
              },
            },
          }),
        },
      },
      workerSessionId,
    );
    const secondSnapshot = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "generation.snapshot" &&
        envelope.runId === FIRST_RUN_ID &&
        (envelope.payload as { markdown?: string }).markdown === "Answer captured while minimized",
    );
    expect((secondSnapshot.payload as { markdown?: string }).markdown).toBe(
      "Answer captured while minimized",
    );
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
        ),
    ).toBe(false);

    harness.emitDebuggerEvent(
      tab.id!,
      "Network.webSocketFrameReceived",
      {
        requestId: "shared-chat-websocket",
        response: {
          opcode: 1,
          payloadData: JSON.stringify({
            type: "message",
            topic_id: "conversation-turn-a",
            payload: { payload: { encoded_item: "data: [DONE]\n\n" } },
          }),
        },
      },
      workerSessionId,
    );

    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
    );
    expect((complete.payload as { markdown?: string }).markdown).toBe(
      "Answer captured while minimized",
    );
    await waitUntil(() => harness.timeline.includes(`debugger.detach:${tab.id}`));
    expect(
      harness.timeline.includes(
        `debugger.command-target:${tab.id}:${workerSessionId}:Network.streamResourceContent`,
      ),
    ).toBe(true);
    expect(harness.timeline.some((entry) => entry.includes("focused:true"))).toBe(false);
    expect(harness.timeline.some((entry) => entry.startsWith("window-created:"))).toBe(false);
    expect(harness.timeline).toContain(
      `window-updated:${homeWindowId}:bounds:-16000,-16000,100,100`,
    );
    await waitUntil(() =>
      harness.timeline.includes(`window-updated:${homeWindowId}:state:minimized`),
    );
    expect((await chrome.windows.get(homeWindowId)).state).toBe("minimized");
    expect(harness.windowBounds(homeWindowId)).toEqual({
      height: 900,
      left: 100,
      top: 100,
      width: 1_200,
    });
  }, 15_000);

  it("prepares the owned renderer before one guarded composer activation while visible and minimized", async () => {
    const { harness, socket, tab } = await startHarness({ debuggerPermission: true });
    const homeWindowId = tab.windowId;
    const page = installChatGptComposerFixture(harness, tab.id, {
      autoCanonicalize: false,
      submissionMode: "form",
    });
    requireElement<HTMLButtonElement>('[data-testid="send-button"]').type = "submit";
    const contentSendMessages: Array<Record<string, unknown>> = [];
    let offscreenComposerStatusMessages = 0;
    harness.beforeTabMessage = (_tabId, message) => {
      if (isMessageType(message, "content.send")) {
        contentSendMessages.push(structuredClone(message as Record<string, unknown>));
      }
      if (
        isMessageType(message, "content.composerStatus") &&
        harness.tabsById.get(tab.id)?.windowId === homeWindowId &&
        harness.tabsById.get(tab.id)?.active === true &&
        harness.windowBounds(homeWindowId).left <= -8_000
      ) {
        offscreenComposerStatusMessages += 1;
      }
    };
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      8_000,
    );
    expect(page.sendClicks()).toBe(1);

    // Chrome keeps MessageSender.url at the document's original project URL
    // across ChatGPT's History API navigation to the canonical conversation.
    harness.setRuntimeSenderUrlOverride(PROJECT_ROOT);
    harness.setWindowFocused(homeWindowId, false);
    harness.setWindowState(homeWindowId, "minimized");
    const minimizedTimelineStart = harness.timeline.length;
    socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_A));
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
      10_000,
    );

    expect(complete.payload).toMatchObject({ markdown: "Follow-up answer on canonical B" });
    expect(page.sendClicks()).toBe(2);
    expect(page.formSubmits()).toBe(2);
    expect(page.submittedPrompts()).toEqual(["Explain the relay race.", "Explain the relay race."]);
    expect(contentSendMessages).toHaveLength(2);
    expect(offscreenComposerStatusMessages).toBeGreaterThanOrEqual(2);
    expect(contentSendMessages[0]).not.toHaveProperty("debuggerDispatch");
    expect(contentSendMessages[1]).not.toHaveProperty("debuggerDispatch");
    expect(
      harness.timeline.filter(
        (entry) =>
          entry === `scripting.executeScript:${tab.id}:MAIN:activateMarkedComposerSendInMainWorld`,
      ),
    ).toHaveLength(2);
    expect(
      harness.timeline.filter((entry) => entry.includes("Input.dispatchKeyEvent")),
    ).toHaveLength(0);
    expect(
      harness.timeline.filter((entry) => entry.includes("Input.dispatchMouseEvent")),
    ).toHaveLength(12);
    const atomicActivationEntries = harness.timeline
      .map((entry, index) => ({ entry, index }))
      .filter(
        ({ entry }) =>
          entry === `scripting.executeScript:${tab.id}:MAIN:activateMarkedComposerSendInMainWorld`,
      );
    const focusPreparationEntries = harness.timeline
      .map((entry, index) => ({ entry, index }))
      .filter(
        ({ entry }) =>
          entry === `debugger.command-target:${tab.id}:root:Emulation.setFocusEmulationEnabled`,
      );
    expect(focusPreparationEntries).toHaveLength(2);
    expect(
      harness.timeline.filter(
        (entry) => entry === `debugger.command-target:${tab.id}:root:Page.setWebLifecycleState`,
      ),
    ).toHaveLength(2);
    expect(focusPreparationEntries[0]!.index).toBeLessThan(atomicActivationEntries[0]!.index);
    expect(focusPreparationEntries[1]!.index).toBeLessThan(atomicActivationEntries[1]!.index);
    const minimizedTimeline = harness.timeline.slice(minimizedTimelineStart);
    expect(
      minimizedTimeline.filter(
        (entry) => entry === `debugger.command-target:${tab.id}:root:Runtime.evaluate`,
      ),
    ).toHaveLength(0);
    expect(
      minimizedTimeline.filter(
        (entry) => entry === `debugger.command-target:${tab.id}:root:Page.setWebLifecycleState`,
      ),
    ).toHaveLength(1);
    expect(
      minimizedTimeline.filter(
        (entry) =>
          entry === `debugger.command-target:${tab.id}:root:Emulation.setFocusEmulationEnabled`,
      ),
    ).toHaveLength(1);
    expect(
      minimizedTimeline.filter(
        (entry) => entry === `debugger.command-target:${tab.id}:root:Input.dispatchKeyEvent`,
      ),
    ).toHaveLength(0);
    expect(
      minimizedTimeline.filter(
        (entry) => entry === `debugger.command-target:${tab.id}:root:Input.dispatchMouseEvent`,
      ),
    ).toHaveLength(3);
    expect(minimizedTimeline.some((entry) => entry.includes("focused:true"))).toBe(false);
    expect(minimizedTimeline.some((entry) => entry.startsWith("window-created:"))).toBe(false);
    expect(minimizedTimeline).toContain(
      `window-updated:${homeWindowId}:bounds:-16000,-16000,100,100`,
    );
    expect(minimizedTimeline).toContain(`window-updated:${homeWindowId}:state:normal`);
    expect(
      minimizedTimeline.filter(
        (entry) =>
          entry === `scripting.executeScript:${tab.id}:MAIN:activateMarkedComposerSendInMainWorld`,
      ),
    ).toHaveLength(1);
    await waitUntil(() =>
      harness.timeline.includes(`window-updated:${homeWindowId}:state:minimized`),
    );
    expect((await chrome.windows.get(homeWindowId)).state).toBe("minimized");
    expect(harness.windowBounds(homeWindowId)).toEqual({
      height: 900,
      left: 100,
      top: 100,
      width: 1_200,
    });
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
  }, 20_000);

  it("recovers a fast handoff from the completed HTTP body before queued WebSocket frames", async () => {
    const { harness, socket, tab } = await startHarness({ debuggerPermission: true });
    harness.installTabMessageResponder(tab.id, async (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        const chromeWindow = await chrome.windows.get(tab.windowId);
        return {
          ok: true,
          ready: true,
          rawCandidateCount: 1,
          readyCandidateCount: 1,
          visibilityState: chromeWindow.state === "minimized" ? "hidden" : "visible",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: PROJECT_ROOT,
          complete: true,
          historyComplete: true,
          messages: [],
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.terminalAck")) return { ok: true };
      return { ok: false };
    });
    harness.setWindowFocused(tab.windowId, false);
    harness.setWindowState(tab.windowId, "minimized");
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await waitUntil(() =>
      harness.timeline.includes(`tabs.sendMessage:request:${tab.id}:content.send`),
    );

    const requestId = "fast-body-handoff";
    const responseUrl = "https://chatgpt.com/backend-api/f/conversation/resume";
    const topicId = "conversation-turn-fast-body";
    harness.setDebuggerResponseBody(
      requestId,
      'event: delta_encoding\ndata: "v1"\n\n' +
        `data: {"type":"stream_handoff","options":[{"type":"subscribe_ws_topic","topic_id":"${topicId}"}]}\n\n` +
        "data: [DONE]\n\n",
    );
    harness.emitDebuggerEvent(tab.id, "Network.requestWillBeSent", {
      requestId,
      request: { method: "POST", url: responseUrl },
    });
    harness.emitDebuggerEvent(tab.id, "Network.responseReceived", {
      requestId,
      response: { mimeType: "text/event-stream", url: responseUrl },
    });
    harness.emitDebuggerEvent(tab.id, "Network.loadingFinished", { requestId });
    harness.emitDebuggerEvent(tab.id, "Network.webSocketFrameReceived", {
      requestId: "shared-fast-websocket",
      response: {
        opcode: 1,
        payloadData: JSON.stringify({
          type: "message",
          topic_id: topicId,
          payload: {
            payload: {
              encoded_item:
                'event: delta\ndata: {"o":"add","p":"","v":{"message":{"author":{"role":"assistant"},"content":{"parts":["Fast"]}}}}\n\n' +
                'event: delta\ndata: {"o":"append","p":"/message/content/parts/0","v":" answer"}\n\n',
            },
          },
        }),
      },
    });
    harness.emitDebuggerEvent(tab.id, "Network.webSocketFrameReceived", {
      requestId: "shared-fast-websocket",
      response: {
        opcode: 1,
        payloadData: JSON.stringify({
          type: "message",
          topic_id: topicId,
          payload: { payload: { encoded_item: "data: [DONE]\n\n" } },
        }),
      },
    });

    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      10_000,
    );
    expect(complete.payload).toMatchObject({ markdown: "Fast answer" });
    expect(
      harness.timeline.filter(
        (entry) => entry === `debugger.command:${tab.id}:Network.getResponseBody`,
      ),
    ).toHaveLength(1);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 15_000);

  it("preserves an explicit opt-out from enhanced background reception", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    harness.setDebuggerPermission(true);
    harness.seedLocalValue("enhancedBackgroundReceptionV1", false);
    seedProjectBinding(harness);

    await harness.importServiceWorker(async () => await import("./service-worker"));

    await expect(harness.sendPopupMessage({ type: "popup.status" })).resolves.toMatchObject({
      backgroundReception: { enhancedEnabled: false, permissionGranted: true },
    });
    expect(harness.timeline.some((entry) => entry.startsWith("debugger.attach:"))).toBe(false);
  });

  it("uses one trusted pointer after atomic MAIN-world validation when enhanced reception is disabled", async () => {
    const { harness, socket, tab } = await startHarness({
      debuggerPermission: true,
      enhancedBackgroundReception: false,
    });
    const homeWindowId = tab.windowId;
    const page = installChatGptComposerFixture(harness, tab.id, { autoCanonicalize: false });
    const composerForm = requireElement<HTMLFormElement>("form");
    composerForm.setAttribute("aria-hidden", "true");
    const fallbackTextarea = document.createElement("textarea");
    fallbackTextarea.style.display = "none";
    composerForm.append(fallbackTextarea);
    await chrome.tabs.create({
      active: true,
      url: "https://example.com/user-work",
      windowId: homeWindowId,
    });
    harness.setWindowFocused(homeWindowId, true);
    let targetActiveDuringMainWorldValidation = false;
    harness.scriptInjectionHandler = async (tabId, _files, world) => {
      if (tabId === tab.id && world === "MAIN") {
        targetActiveDuringMainWorldValidation = harness.tabsById.get(tab.id)?.active === true;
      }
    };
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      8_000,
    );

    expect(page.sendClicks()).toBe(1);
    expect(targetActiveDuringMainWorldValidation).toBe(true);
    expect(
      harness.timeline.filter(
        (entry) =>
          entry === `scripting.executeScript:${tab.id}:MAIN:activateMarkedComposerSendInMainWorld`,
      ),
    ).toHaveLength(1);
    expect(
      harness.timeline.filter(
        (entry) => entry === `debugger.command-target:${tab.id}:root:Page.setWebLifecycleState`,
      ),
    ).toHaveLength(0);
    expect(
      harness.timeline.filter(
        (entry) =>
          entry === `debugger.command-target:${tab.id}:root:Emulation.setFocusEmulationEnabled`,
      ),
    ).toHaveLength(0);
    expect(
      harness.timeline.filter(
        (entry) => entry === `debugger.command-target:${tab.id}:root:Runtime.evaluate`,
      ),
    ).toHaveLength(0);
    expect(
      harness.timeline.filter(
        (entry) => entry === `debugger.command-target:${tab.id}:root:Input.dispatchKeyEvent`,
      ),
    ).toHaveLength(0);
    expect(
      harness.timeline.filter(
        (entry) => entry === `debugger.command-target:${tab.id}:root:Input.dispatchMouseEvent`,
      ),
    ).toHaveLength(3);
    expect(
      harness.timeline.filter(
        (entry) => entry === `debugger.command-target:${tab.id}:root:Network.enable`,
      ),
    ).toHaveLength(0);
    expect(harness.timeline.filter((entry) => entry === `debugger.attach:${tab.id}`)).toHaveLength(
      1,
    );
    expect(harness.timeline.filter((entry) => entry === `debugger.detach:${tab.id}`)).toHaveLength(
      1,
    );
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 12_000);

  it("dismisses the exact ChatGPT conversation-history notice before one guarded send", async () => {
    const { harness, socket, tab } = await startHarness({ debuggerPermission: true });
    const page = installChatGptComposerFixture(harness, tab.id, { autoCanonicalize: false });
    const modal = document.createElement("div");
    modal.dataset.testid = "modal-conversation-history-rate-limit";
    modal.style.display = "none";
    const confirmation = document.createElement("button");
    confirmation.type = "button";
    confirmation.textContent = "Confirm";
    let confirmationClicks = 0;
    confirmation.addEventListener("click", () => {
      confirmationClicks += 1;
      modal.remove();
    });
    modal.append(confirmation);
    document.body.append(modal);
    requireElement<HTMLElement>("#prompt-textarea").addEventListener("input", () => {
      modal.style.display = "block";
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      8_000,
    );

    expect(confirmationClicks).toBe(1);
    expect(modal.isConnected).toBe(false);
    expect(page.sendClicks()).toBe(1);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 12_000);

  it("fails closed when the ChatGPT conversation-history notice has ambiguous controls", async () => {
    const { harness, socket, tab } = await startHarness({ debuggerPermission: true });
    const page = installChatGptComposerFixture(harness, tab.id, { autoCanonicalize: false });
    const modal = document.createElement("div");
    modal.dataset.testid = "modal-conversation-history-rate-limit";
    let modalClicks = 0;
    for (let index = 0; index < 2; index += 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `Choice ${index + 1}`;
      button.addEventListener("click", () => {
        modalClicks += 1;
      });
      modal.append(button);
    }
    document.body.append(modal);
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    const error = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "relay.error" && envelope.runId === FIRST_RUN_ID,
      8_000,
    );

    expect(error.payload).toMatchObject({ code: "CHATGPT_REMOTE_UNAVAILABLE" });
    expect(modalClicks).toBe(0);
    expect(page.sendClicks()).toBe(0);
  }, 12_000);

  it("dismisses a conversation-history notice mounted at the final MAIN-world boundary", async () => {
    const { harness, socket, tab } = await startHarness({ debuggerPermission: true });
    const page = installChatGptComposerFixture(harness, tab.id, { autoCanonicalize: false });
    let confirmationClicks = 0;
    harness.scriptInjectionHandler = async (_tabId, _files, world) => {
      if (
        world !== "MAIN" ||
        !document.querySelector("[data-ask2gpt-main-world-send]") ||
        document.querySelector('[data-testid="modal-conversation-history-rate-limit"]')
      ) {
        return;
      }
      const modal = document.createElement("div");
      modal.dataset.testid = "modal-conversation-history-rate-limit";
      const confirmation = document.createElement("button");
      confirmation.type = "button";
      confirmation.textContent = "Confirm";
      confirmation.addEventListener("click", () => {
        confirmationClicks += 1;
        modal.remove();
      });
      modal.append(confirmation);
      document.body.append(modal);
    };
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      8_000,
    );

    expect(confirmationClicks).toBe(1);
    expect(page.sendClicks()).toBe(1);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 12_000);

  it("uses one trusted pointer in the off-screen home window when enhanced reception is disabled", async () => {
    const { harness, socket, tab } = await startHarness({
      debuggerPermission: true,
      enhancedBackgroundReception: false,
    });
    const homeWindowId = tab.windowId;
    const page = installChatGptComposerFixture(harness, tab.id, { autoCanonicalize: false });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    harness.setWindowFocused(homeWindowId, false);
    harness.setWindowState(homeWindowId, "minimized");

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      10_000,
    );

    expect(page.sendClicks()).toBe(1);
    expect(
      harness.timeline.filter(
        (entry) => entry === `debugger.command-target:${tab.id}:root:Input.dispatchKeyEvent`,
      ),
    ).toHaveLength(0);
    expect(
      harness.timeline.filter(
        (entry) => entry === `debugger.command-target:${tab.id}:root:Input.dispatchMouseEvent`,
      ),
    ).toHaveLength(3);
    expect(
      harness.timeline.filter(
        (entry) => entry === `debugger.command-target:${tab.id}:root:Network.enable`,
      ),
    ).toHaveLength(0);
    expect(
      harness.timeline.filter(
        (entry) => entry === `debugger.command-target:${tab.id}:root:Page.setWebLifecycleState`,
      ),
    ).toHaveLength(0);
    expect(
      harness.timeline.filter(
        (entry) =>
          entry === `debugger.command-target:${tab.id}:root:Emulation.setFocusEmulationEnabled`,
      ),
    ).toHaveLength(0);
    expect(harness.timeline.filter((entry) => entry === `debugger.attach:${tab.id}`)).toHaveLength(
      1,
    );
    expect(harness.timeline.filter((entry) => entry === `debugger.detach:${tab.id}`)).toHaveLength(
      1,
    );
    expect(harness.timeline.some((entry) => entry.startsWith("window-created:"))).toBe(false);
    expect(harness.timeline).toContain(
      `window-updated:${homeWindowId}:bounds:-16000,-16000,100,100`,
    );
    expect(harness.timeline).toContain(`window-updated:${homeWindowId}:state:normal`);
    await waitUntil(() =>
      harness.timeline.includes(`window-updated:${homeWindowId}:state:minimized`),
    );
    expect(harness.timeline).toContain(`window-updated:${homeWindowId}:state:minimized`);
    expect((await chrome.windows.get(homeWindowId)).state).toBe("minimized");
    expect(harness.windowBounds(homeWindowId)).toEqual({
      height: 900,
      left: 100,
      top: 100,
      width: 1_200,
    });
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 15_000);

  it("fails before atomic activation when the marked button has invalid geometry", async () => {
    const { harness, socket, tab } = await startHarness({
      debuggerPermission: true,
      enhancedBackgroundReception: false,
    });
    const page = installChatGptComposerFixture(harness, tab.id, { autoCanonicalize: false });
    const send = requireElement<HTMLButtonElement>('[data-testid="send-button"]');
    harness.scriptInjectionHandler = async (_tabId, _files, world) => {
      if (world !== "MAIN" || !send.hasAttribute("data-ask2gpt-main-world-send")) return;
      vi.spyOn(send, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        toJSON: () => ({}),
      });
    };
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    const error = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "relay.error" && envelope.runId === FIRST_RUN_ID,
      8_000,
    );

    expect(error.payload).toMatchObject({ code: "CHATGPT_SEND_FAILED" });
    expect((error.payload as { message?: string }).message).toContain("页面发送激活");
    expect(page.sendClicks()).toBe(0);
    expect(
      harness.timeline.filter((entry) => entry.includes("Input.dispatchKeyEvent")),
    ).toHaveLength(0);
    expect(harness.timeline.filter((entry) => entry === `debugger.attach:${tab.id}`)).toHaveLength(
      1,
    );
    expect(harness.timeline.filter((entry) => entry === `debugger.detach:${tab.id}`)).toHaveLength(
      1,
    );
  });

  it("fails before atomic activation when the marked button is occluded", async () => {
    const { harness, socket, tab } = await startHarness({
      debuggerPermission: true,
      enhancedBackgroundReception: false,
    });
    const page = installChatGptComposerFixture(harness, tab.id, { autoCanonicalize: false });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => document.body,
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    const error = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "relay.error" && envelope.runId === FIRST_RUN_ID,
      8_000,
    );

    expect(error.payload).toMatchObject({ code: "CHATGPT_SEND_FAILED" });
    expect((error.payload as { message?: string }).message).toContain("页面发送激活");
    expect(page.sendClicks()).toBe(0);
    expect(
      harness.timeline.filter((entry) => entry.includes("Input.dispatchKeyEvent")),
    ).toHaveLength(0);
    expect(harness.timeline.filter((entry) => entry === `debugger.attach:${tab.id}`)).toHaveLength(
      1,
    );
    expect(harness.timeline.filter((entry) => entry === `debugger.detach:${tab.id}`)).toHaveLength(
      1,
    );
  });

  it("keeps a run alive when ChatGPT exposes a progress label before the real answer", async () => {
    const { harness, socket, tab } = await startHarness();
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: harness.tabsById.get(tab.id)?.url,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.composerStatus")) {
        return {
          ok: true,
          ready: true,
          rawCandidateCount: 1,
          readyCandidateCount: 1,
          visibilityState: "visible",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          complete: true,
          historyComplete: true,
          messages: [],
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.terminalAck")) return { ok: true };
      return { ok: false };
    });
    await harness.importContentScript(tab.id, async () => undefined);

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID, REMOTE_A));
    await waitUntil(
      () =>
        (harness.sessionValue("activeRunsV2") as Array<{ runId?: string }> | undefined)?.some(
          (run) => run.runId === FIRST_RUN_ID,
        ) === true,
    );
    harness.setPrimaryDocumentUrl(REMOTE_A);
    harness.setTabUrl(tab.id, REMOTE_A);

    await expect(
      chrome.runtime.sendMessage({
        type: "content.event",
        eventType: "snapshot",
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        markdown: "正在思考",
        remoteUrl: REMOTE_A,
      }),
    ).resolves.toEqual({ ok: false });
    await expect(
      chrome.runtime.sendMessage({
        type: "content.event",
        eventType: "complete",
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        markdown: "正在思考……",
        remoteUrl: REMOTE_A,
      }),
    ).resolves.toEqual({ ok: false });

    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) =>
            (envelope.type === "generation.snapshot" || envelope.type === "generation.complete") &&
            envelope.runId === FIRST_RUN_ID,
        ),
    ).toBe(false);
    expect(
      (harness.sessionValue("activeRunsV2") as Array<{ runId?: string }> | undefined)?.some(
        (run) => run.runId === FIRST_RUN_ID,
      ),
    ).toBe(true);

    await expect(
      chrome.runtime.sendMessage({
        type: "content.event",
        eventType: "snapshot",
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        markdown: "TEST_OK",
        remoteUrl: REMOTE_A,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      chrome.runtime.sendMessage({
        type: "content.event",
        eventType: "complete",
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        markdown: "TEST_OK",
        remoteUrl: REMOTE_A,
      }),
    ).resolves.toEqual({ ok: true });

    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
    );
    expect(complete.payload).toMatchObject({ markdown: "TEST_OK", remoteUrl: REMOTE_A });
  }, 15_000);

  it("does not complete a DOM-observed turn from ChatGPT's localized progress label", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, {
      terminalMode: "progress",
      autoCanonicalize: false,
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await waitUntil(() => page.submittedPrompts().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) =>
            (envelope.type === "generation.snapshot" || envelope.type === "generation.complete") &&
            envelope.runId === FIRST_RUN_ID,
        ),
    ).toBe(false);
    expect(
      (harness.sessionValue("activeRunsV2") as Array<{ runId?: string }> | undefined)?.some(
        (run) => run.runId === FIRST_RUN_ID,
      ),
    ).toBe(true);

    page.updatePrimaryAssistant("TEST_OK");
    const snapshot = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "generation.snapshot" &&
        envelope.runId === FIRST_RUN_ID &&
        (envelope.payload as { markdown?: string }).markdown === "TEST\\_OK",
    );
    expect(snapshot.payload).toMatchObject({ markdown: "TEST\\_OK", remoteUrl: REMOTE_A });
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
    );
    expect(complete.payload).toMatchObject({ markdown: "TEST\\_OK", remoteUrl: REMOTE_A });
  }, 15_000);

  it("settles an exact minimized transcript after the network finishes before terminal controls render", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    harness.setDebuggerPermission(true);
    harness.seedLocalValue("enhancedBackgroundReceptionV1", true);
    seedProjectBinding(harness);
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);

    const tabPromise = harness.waitForCreatedTab();
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        payload: { active: false, remoteUrl: REMOTE_A },
      }),
    );
    const tab = await tabPromise;
    const baselineMessages = [
      { role: "user" as const, markdown: "Earlier question" },
      { role: "assistant" as const, markdown: "Earlier answer" },
    ];
    const terminalMarkdown = "Exact answer recovered after the network completed";
    let sent = false;
    harness.installTabMessageResponder(tab.id!, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        return {
          ok: true,
          ready: true,
          rawCandidateCount: 1,
          readyCandidateCount: 1,
          visibilityState: "visible",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          // A minimized React tree can expose the exact transcript before its
          // Copy/Retry actions render. Network.loadingFinished is the terminal
          // authority for this narrowly attested recovery path.
          complete: !sent,
          historyComplete: true,
          messages: sent
            ? [
                ...baselineMessages,
                { role: "user" as const, markdown: "Explain the relay race." },
                { role: "assistant" as const, markdown: terminalMarkdown },
              ]
            : baselineMessages,
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sent = true;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.terminalAck")) return { ok: true };
      return { ok: false };
    });

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID, REMOTE_A));
    await waitUntil(() => harness.timeline.includes(`debugger.attach:${tab.id}`));
    // Debugger attachment now runs in parallel with the durable transcript
    // preflight. The real network request cannot exist until content.send has
    // actuated the page, so inject its lifecycle only after that boundary.
    await waitUntil(() => sent);
    harness.setWindowState(tab.windowId!, "minimized");
    const requestId = "network-terminal-exact-transcript";
    const responseUrl = "https://chatgpt.com/backend-api/f/conversation/resume";
    harness.setDebuggerResponseBody(requestId, "not a decodable conversation stream");
    harness.emitDebuggerEvent(tab.id!, "Network.requestWillBeSent", {
      requestId,
      request: { method: "POST", url: responseUrl },
    });
    harness.emitDebuggerEvent(tab.id!, "Network.responseReceived", {
      requestId,
      response: { mimeType: "text/event-stream", url: responseUrl },
    });
    harness.emitDebuggerEvent(tab.id!, "Network.loadingFinished", { requestId });

    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
    );
    expect(complete.payload).toMatchObject({ markdown: terminalMarkdown, remoteUrl: REMOTE_A });
    expect(harness.timeline.some((entry) => entry.includes("focused:true"))).toBe(false);
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
      ),
    ).toHaveLength(1);
  }, 15_000);

  it("keeps extension reload and idle Host synchronization off ChatGPT", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const existingTab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    if (existingTab.id === undefined) throw new Error("Fake Chrome did not create a mapped tab.");
    harness.seedSessionValue("conversationTabsV2", [
      {
        owned: true,
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        tabId: existingTab.id,
        remoteUrl: REMOTE_A,
        projectScope: PROJECT_SCOPE,
        createdAt: "2026-08-04T00:00:00.000Z",
      },
    ]);

    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    harness.timeline.length = 0;
    await connectFakeVsCodeHost(harness, socket);

    const statusesBefore = harness
      .outboundEnvelopes(socket)
      .filter((envelope) => envelope.type === "relay.status").length;
    socket.deliverFromHost(
      makeEnvelope({
        type: "relay.status.request",
        instanceId: INSTANCE_ID,
        payload: makeRelayStatusRequestPayload(),
      }),
    );
    await waitUntil(
      () =>
        harness.outboundEnvelopes(socket).filter((envelope) => envelope.type === "relay.status")
          .length > statusesBefore,
    );

    expect(harness.timeline.some((entry) => entry.startsWith("tab-created:"))).toBe(false);
    expect(harness.timeline.some((entry) => entry.includes(":content.inspectConversation"))).toBe(
      false,
    );
  });

  it("reuses an untracked exact conversation tab after a manual extension reload", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const existingTab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    if (existingTab.id === undefined) throw new Error("Fake Chrome did not create a reusable tab.");
    harness.installTabMessageResponder(existingTab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          title: "Reloaded conversation",
          complete: true,
          historyComplete: true,
          messages: [
            { role: "user" as const, markdown: "Earlier question" },
            { role: "assistant" as const, markdown: "Earlier answer" },
          ],
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);
    harness.timeline.length = 0;

    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        payload: { remoteUrl: REMOTE_A, active: false },
      }),
    );
    await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.snapshot" &&
        envelope.conversationId === CONVERSATION_ID &&
        (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_A,
    );

    expect([...harness.tabsById.values()]).toHaveLength(1);
    expect(harness.timeline.some((entry) => entry.startsWith("tab-created:"))).toBe(false);
    expect(
      (
        harness.sessionValue("conversationTabsV2") as
          Array<{ conversationId?: string; tabId?: number; remoteUrl?: string }> | undefined
      )?.find((record) => record.conversationId === CONVERSATION_ID),
    ).toMatchObject({ tabId: existingTab.id, remoteUrl: REMOTE_A });
  });

  it("retains a terminal event until the Host explicitly acknowledges it", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    harness.seedSessionValue("pendingEventsV2", [
      {
        instanceId: INSTANCE_ID,
        tabId: 41,
        event: {
          type: "content.event",
          eventType: "complete",
          conversationId: CONVERSATION_ID,
          runId: FIRST_RUN_ID,
          markdown: "Durable answer",
          remoteUrl: REMOTE_A,
        },
      },
    ]);
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket, { acknowledgeTerminals: false });

    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
    );
    await waitUntil(
      () => (harness.sessionValue("pendingEventsV2") as Array<unknown> | undefined)?.length === 1,
    );
    socket.deliverFromHost(
      makeEnvelope({
        type: "generation.ack",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        payload: { eventId: complete.id, acknowledgedAt: new Date().toISOString() },
      }),
    );
    await waitUntil(
      () => (harness.sessionValue("pendingEventsV2") as Array<unknown> | undefined)?.length === 0,
    );
  });

  it("delivers a restored terminal before reporting an idle authenticated status", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    harness.seedSessionValue("pendingEventsV2", [
      {
        eventId: "terminal-before-ready-status",
        instanceId: INSTANCE_ID,
        tabId: 41,
        startedAt: new Date().toISOString(),
        event: {
          type: "content.event",
          eventType: "complete",
          conversationId: CONVERSATION_ID,
          runId: FIRST_RUN_ID,
          markdown: "Restored answer",
          remoteUrl: REMOTE_A,
        },
      },
    ]);
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket, { acknowledgeTerminals: false });

    const outbound = harness.outboundEnvelopes(socket);
    const terminalIndex = outbound.findIndex(
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
    );
    const idleStatusIndex = outbound.findIndex(
      (envelope) =>
        envelope.type === "relay.status" &&
        (envelope.payload as { activeRuns?: number }).activeRuns === 0,
    );
    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    expect(idleStatusIndex).toBeGreaterThan(terminalIndex);
  });

  it("replays a failed terminal before a requested status reports the run idle", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    harness.seedSessionValue("pendingEventsV2", [
      {
        eventId: "terminal-before-requested-status",
        instanceId: INSTANCE_ID,
        tabId: 41,
        startedAt: new Date().toISOString(),
        event: {
          type: "content.event",
          eventType: "complete",
          conversationId: CONVERSATION_ID,
          runId: FIRST_RUN_ID,
          markdown: "Answer awaiting replay",
          remoteUrl: REMOTE_A,
        },
      },
    ]);
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    socket.failNextSendOfType("generation.complete");
    await connectFakeVsCodeHost(harness, socket, { acknowledgeTerminals: false });
    await waitUntil(
      () =>
        harness.outboundEnvelopes(socket).filter((envelope) => envelope.type === "relay.status")
          .length >= 2,
    );
    expect(
      harness.outboundEnvelopes(socket).some((envelope) => envelope.type === "generation.complete"),
    ).toBe(false);

    const beforeRequest = harness.outboundEnvelopes(socket).length;
    socket.deliverFromHost(
      makeEnvelope({
        type: "relay.status.request",
        instanceId: INSTANCE_ID,
        payload: makeRelayStatusRequestPayload(),
      }),
    );
    await waitUntil(() => harness.outboundEnvelopes(socket).length >= beforeRequest + 2);

    const responseTypes = harness
      .outboundEnvelopes(socket)
      .slice(beforeRequest)
      .filter(
        (envelope) => envelope.type === "generation.complete" || envelope.type === "relay.status",
      )
      .map((envelope) => envelope.type);
    expect(responseTypes.slice(0, 2)).toEqual(["generation.complete", "relay.status"]);
    const requestedStatus = harness
      .outboundEnvelopes(socket)
      .slice(beforeRequest)
      .find((envelope) => envelope.type === "relay.status");
    expect(requestedStatus?.payload).toMatchObject({ activeRuns: 0 });
  });

  it("still reports status after transient outbox persistence fails", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    harness.seedSessionValue("pendingEventsV2", [
      {
        eventId: "transient-before-status",
        instanceId: INSTANCE_ID,
        startedAt: new Date().toISOString(),
        event: {
          type: "content.event",
          eventType: "snapshot",
          conversationId: CONVERSATION_ID,
          runId: FIRST_RUN_ID,
          markdown: "Transient answer",
        },
      },
      {
        eventId: "terminal-before-failed-persist",
        instanceId: INSTANCE_ID,
        startedAt: new Date().toISOString(),
        event: {
          type: "content.event",
          eventType: "complete",
          conversationId: CONVERSATION_ID,
          runId: FIRST_RUN_ID,
          markdown: "Durable answer",
          remoteUrl: REMOTE_A,
        },
      },
    ]);
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    socket.failNextSendOfType("generation.snapshot");
    await connectFakeVsCodeHost(harness, socket, { acknowledgeTerminals: false });
    await waitUntil(
      () =>
        harness.outboundEnvelopes(socket).filter((envelope) => envelope.type === "relay.status")
          .length >= 2,
    );

    const sessionSet = vi
      .spyOn(chrome.storage.session, "set")
      .mockRejectedValueOnce(new Error("transient session storage failure"));
    const beforeRequest = harness.outboundEnvelopes(socket).length;
    socket.deliverFromHost(
      makeEnvelope({
        type: "relay.status.request",
        instanceId: INSTANCE_ID,
        payload: makeRelayStatusRequestPayload(),
      }),
    );
    await waitUntil(() => harness.outboundEnvelopes(socket).length >= beforeRequest + 3);

    const response = harness.outboundEnvelopes(socket).slice(beforeRequest);
    expect(
      response
        .filter(
          (envelope) => envelope.type === "generation.complete" || envelope.type === "relay.status",
        )
        .map((envelope) => envelope.type)
        .slice(0, 2),
    ).toEqual(["generation.complete", "relay.status"]);
    expect(response.find((envelope) => envelope.type === "relay.status")?.payload).toMatchObject({
      activeRuns: 0,
    });
    expect(response.some((envelope) => envelope.type === "relay.error")).toBe(false);
    expect(sessionSet).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(FakeRelayWebSocket.OPEN);
  });

  it("replays a terminal event after the first WebSocket send fails", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    harness.seedSessionValue("pendingEventsV2", [
      {
        eventId: "terminal-replay-a",
        instanceId: INSTANCE_ID,
        tabId: 41,
        startedAt: new Date().toISOString(),
        event: {
          type: "content.event",
          eventType: "complete",
          conversationId: CONVERSATION_ID,
          runId: FIRST_RUN_ID,
          markdown: "Durable replay answer",
          remoteUrl: REMOTE_A,
        },
      },
    ]);
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const firstSocket = await harness.waitForSocket();
    firstSocket.failNextSendOfType("generation.complete");
    await connectFakeVsCodeHost(harness, firstSocket, { acknowledgeTerminals: false });
    await waitUntil(
      () => (harness.sessionValue("pendingEventsV2") as Array<unknown> | undefined)?.length === 1,
    );
    expect(
      harness
        .outboundEnvelopes(firstSocket)
        .some((envelope) => envelope.type === "generation.complete"),
    ).toBe(false);

    firstSocket.close(1006, "simulated transport loss");
    await waitUntil(() => harness.socketsForPort().length >= 2);
    const secondSocket = harness.socketsForPort().at(-1)!;
    await connectFakeVsCodeHost(harness, secondSocket, { acknowledgeTerminals: false });
    const replayed = await harness.waitForEnvelope(
      secondSocket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
    );
    expect(replayed.id).toBe("terminal-replay-a");
    expect(
      harness
        .outboundEnvelopes(secondSocket)
        .filter((envelope) => envelope.type === "generation.complete"),
    ).toHaveLength(1);
    secondSocket.deliverFromHost(
      makeEnvelope({
        type: "generation.ack",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        payload: { eventId: replayed.id, acknowledgedAt: new Date().toISOString() },
      }),
    );
    await waitUntil(
      () => (harness.sessionValue("pendingEventsV2") as Array<unknown> | undefined)?.length === 0,
    );
  });

  it("does not send a terminal event before its session checkpoint commits", async () => {
    const { harness, socket, tab } = await startHarness({ acknowledgeTerminals: false });
    let writeBarrier: ReturnType<FakeChromeRelayHarness["pauseNextSessionWrite"]> | undefined;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.send")) {
        writeBarrier = harness.pauseNextSessionWrite();
        return { ok: false };
      }
      return { ok: false };
    });

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await waitUntil(() => writeBarrier !== undefined);
    await writeBarrier!.entered;

    socket.close(1006, "replace connection during terminal checkpoint");
    await waitUntil(() => harness.socketsForPort().length >= 2);
    const replacement = harness.socketsForPort().at(-1)!;
    await connectFakeVsCodeHost(harness, replacement, { acknowledgeTerminals: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      harness
        .outboundEnvelopes(replacement)
        .some((envelope) => envelope.type === "relay.error" && envelope.runId === FIRST_RUN_ID),
    ).toBe(false);

    writeBarrier!.release();
    const terminal = await harness.waitForEnvelope(
      replacement,
      (envelope) => envelope.type === "relay.error" && envelope.runId === FIRST_RUN_ID,
    );
    expect(terminal.payload).toMatchObject({ code: "SELECTOR_INCOMPATIBLE" });
  }, 10_000);

  it("does not resurrect a terminal event after its conversation is closed", async () => {
    const { harness, socket, tab } = await startHarness({ acknowledgeTerminals: false });
    const terminalMarkdown = "Answer that must not be resurrected";
    let releaseInspection!: () => void;
    let inspectionEntered = false;
    const inspectionGate = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    harness.installTabMessageResponder(tab.id, async (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: harness.tabsById.get(tab.id)?.url,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.composerStatus")) {
        const visible = harness.tabsById.get(tab.id)?.active === true;
        return {
          ok: true,
          ready: visible,
          rawCandidateCount: visible ? 1 : 0,
          readyCandidateCount: visible ? 1 : 0,
          visibilityState: visible ? "visible" : "hidden",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        const remoteUrl = harness.tabsById.get(tab.id)?.url ?? PROJECT_ROOT;
        if (remoteUrl === REMOTE_A) {
          inspectionEntered = true;
          await inspectionGate;
        }
        return {
          ok: true,
          remoteUrl,
          title: "Race test",
          complete: true,
          messages:
            remoteUrl === REMOTE_A
              ? [
                  { role: "user", markdown: "Explain the relay race." },
                  { role: "assistant", markdown: terminalMarkdown },
                ]
              : [],
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.recover")) {
        return {
          ok: true,
          active: true,
          matchedActiveRun: true,
          markdown: "",
          remoteUrl: PROJECT_ROOT,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });
    await harness.importContentScript(tab.id, async () => undefined);
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
    );
    harness.setTabUrl(tab.id, REMOTE_A);

    const staleTerminal = chrome.runtime.sendMessage({
      type: "content.event",
      eventType: "complete",
      conversationId: CONVERSATION_ID,
      runId: FIRST_RUN_ID,
      markdown: terminalMarkdown,
      remoteUrl: REMOTE_A,
    });
    await waitUntil(() => inspectionEntered);
    const closeRequest = makeEnvelope({
      type: "conversation.close",
      instanceId: INSTANCE_ID,
      conversationId: CONVERSATION_ID,
      payload: { closeTab: false },
    });
    socket.deliverFromHost(closeRequest);
    await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.closed" &&
        (envelope.payload as { requestId?: string }).requestId === closeRequest.id,
    );
    releaseInspection();

    await expect(staleTerminal).resolves.toEqual({ ok: false });
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
        ),
    ).toBe(false);
    expect(harness.sessionValue("pendingEventsV2")).toEqual([]);
    expect(harness.sessionValue("activeRunsV2")).toEqual([]);
    expect(harness.sessionValue("conversationTabsV2")).toEqual([]);
  }, 12_000);

  it("fails closed and cleans its owned discovery tab when no Project is bound", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);

    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        payload: { active: false },
      }),
    );
    const homeTab = await harness.waitForCreatedTab(0);
    window.history.replaceState({}, "", "https://chatgpt.com/");
    document.title = "ChatGPT";
    document.body.replaceChildren();
    await harness.importContentScript(homeTab.id, async () => await import("./content-script"));
    const error = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "relay.error" && envelope.conversationId === CONVERSATION_ID,
      15_000,
    );

    expect(error.payload).toMatchObject({ code: "CHATGPT_PROJECT_REQUIRED" });
    expect((error.payload as { message?: string }).message).toContain("visibleRows=0");
    expect(harness.tabsById.has(homeTab.id)).toBe(false);
    expect(harness.sessionValue("projectDiscoveryTabV1")).toBeNull();
    expect([...harness.tabsById.values()]).toHaveLength(0);
    expect(harness.timeline).toContain(
      `tabs.sendMessage:response:${homeTab.id}:content.openProjectHome`,
    );
  }, 25_000);

  it("discovers a hidden Project through the fixed page bridge refresh", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const homeTab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
    if (homeTab.id === undefined) throw new Error("Fake Chrome did not create a home tab.");
    window.history.replaceState({}, "", "https://chatgpt.com/");
    document.title = "ChatGPT";
    document.body.replaceChildren();
    const bridgeListener = () => {
      const requestId = document.documentElement.getAttribute(
        PROJECT_DIRECTORY_REFRESH_REQUEST_ATTRIBUTE,
      );
      if (!requestId) return;
      document.documentElement.removeAttribute(PROJECT_DIRECTORY_REFRESH_REQUEST_ATTRIBUTE);
      document.documentElement.setAttribute(
        "data-ask2gpt-project-binding",
        JSON.stringify({
          name: "Ask2GPT",
          projectUrl: PROJECT_ROOT,
          evidenceVersion: 2,
          observedAt: Date.now(),
        }),
      );
      document.documentElement.setAttribute(
        PROJECT_DIRECTORY_REFRESH_RESULT_ATTRIBUTE,
        JSON.stringify({
          requestId,
          outcome: "matched",
          projectUrl: PROJECT_ROOT,
          evidenceVersion: 2,
        }),
      );
      document.dispatchEvent(new Event(PROJECT_DIRECTORY_REFRESH_RESULT_EVENT));
    };
    document.addEventListener(PROJECT_DIRECTORY_REFRESH_REQUEST_EVENT, bridgeListener);
    try {
      await harness.importContentScript(homeTab.id, async () => await import("./content-script"));

      await expect(
        chrome.tabs.sendMessage(homeTab.id, { type: "content.discoverProject" }),
      ).resolves.toMatchObject({
        ok: true,
        name: "Ask2GPT",
        projectUrl: PROJECT_ROOT,
        scope: PROJECT_SCOPE,
      });
    } finally {
      document.removeEventListener(PROJECT_DIRECTORY_REFRESH_REQUEST_EVENT, bridgeListener);
    }
  });

  it("rejects stale Project bridge evidence from an older content runtime", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const homeTab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
    if (homeTab.id === undefined) throw new Error("Fake Chrome did not create a home tab.");
    window.history.replaceState({}, "", "https://chatgpt.com/");
    document.body.replaceChildren();
    document.documentElement.setAttribute(
      "data-ask2gpt-project-binding",
      JSON.stringify({
        name: "Ask2GPT",
        projectUrl: PROJECT_ROOT,
        evidenceVersion: 1,
        observedAt: Date.now(),
      }),
    );
    await harness.importContentScript(homeTab.id, async () => await import("./content-script"));

    await expect(
      chrome.tabs.sendMessage(homeTab.id, { type: "content.inspectProject" }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("persists a strict V6 binding after automatic hidden Project discovery", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);

    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: "automatic-hidden-project",
        payload: { active: false },
      }),
    );
    const homeTab = await harness.waitForCreatedTab(0);
    window.history.replaceState({}, "", "https://chatgpt.com/");
    document.title = "ChatGPT";
    document.body.replaceChildren();
    const bridgeListener = () => {
      const requestId = document.documentElement.getAttribute(
        PROJECT_DIRECTORY_REFRESH_REQUEST_ATTRIBUTE,
      );
      if (!requestId) return;
      document.documentElement.removeAttribute(PROJECT_DIRECTORY_REFRESH_REQUEST_ATTRIBUTE);
      document.documentElement.setAttribute(
        "data-ask2gpt-project-binding",
        JSON.stringify({
          name: "Ask2GPT",
          projectUrl: PROJECT_ROOT,
          evidenceVersion: 2,
          observedAt: Date.now(),
        }),
      );
      document.documentElement.setAttribute(
        PROJECT_DIRECTORY_REFRESH_RESULT_ATTRIBUTE,
        JSON.stringify({
          requestId,
          outcome: "matched",
          projectUrl: PROJECT_ROOT,
          evidenceVersion: 2,
        }),
      );
      document.dispatchEvent(new Event(PROJECT_DIRECTORY_REFRESH_RESULT_EVENT));
    };
    document.addEventListener(PROJECT_DIRECTORY_REFRESH_REQUEST_EVENT, bridgeListener);
    try {
      await harness.importContentScript(homeTab.id, async () => await import("./content-script"));
      await waitUntil(
        () =>
          (harness.localValue("projectBindingV6") as { projectUrl?: string } | undefined)
            ?.projectUrl === PROJECT_ROOT,
        8_000,
      );
      expect(harness.localValue("projectBindingV6")).toMatchObject({
        version: 5,
        provenance: "strict-visible-project-v1",
        name: "Ask2GPT",
        projectUrl: PROJECT_ROOT,
        scope: PROJECT_SCOPE,
      });
    } finally {
      document.removeEventListener(PROJECT_DIRECTORY_REFRESH_REQUEST_EVENT, bridgeListener);
    }
  }, 12_000);

  it("does not migrate a legacy URL-only Project binding", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    harness.seedLocalValue("projectBindingV3", {
      version: 2,
      projectUrl: "https://chatgpt.com/g/wrong-project/project",
      scope: "https://chatgpt.com/g/wrong-project/",
      name: "Ask2GPT",
      boundAt: "2026-07-26T00:00:00.000Z",
    });
    harness.seedLocalValue("projectBindingV4", {
      version: 3,
      projectUrl: "https://chatgpt.com/g/heuristic-project/project",
      scope: "https://chatgpt.com/g/heuristic-project/",
      name: "Ask2GPT",
      boundAt: "2026-07-26T00:00:00.000Z",
    });
    await harness.importServiceWorker(async () => await import("./service-worker"));
    await harness.waitForSocket();

    expect(harness.localValue("projectBindingV3")).toBeUndefined();
    expect(harness.localValue("projectBindingV4")).toBeUndefined();
    expect(harness.localValue("projectBindingV5")).toBeUndefined();
    expect(harness.localValue("projectBindingV6")).toBeUndefined();
  });

  it("restores mapped tabs and verified Project state from a reload checkpoint", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const tab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a mapped tab.");
    const boundAt = "2026-07-28T00:00:00.000Z";
    harness.seedLocalValue("projectBindingV6", {
      version: 5,
      provenance: "strict-visible-project-v1",
      projectUrl: PROJECT_ROOT,
      scope: PROJECT_SCOPE,
      name: "Ask2GPT",
      boundAt,
    });
    harness.seedLocalValue("relayReloadCheckpointV1", {
      version: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      conversationTabs: [
        {
          owned: true,
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          tabId: tab.id,
          remoteUrl: REMOTE_A,
          projectScope: PROJECT_SCOPE,
          createdAt: new Date().toISOString(),
        },
      ],
      activeRuns: [],
      completedCanonicalizations: [],
      projectBindingVerification: {
        version: 1,
        projectUrl: PROJECT_ROOT,
        boundAt,
      },
    });

    await harness.importServiceWorker(async () => await import("./service-worker"));
    await harness.waitForSocket();

    expect(harness.sessionValue("conversationTabsV2")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          tabId: tab.id,
          remoteUrl: REMOTE_A,
        }),
      ]),
    );
    expect(harness.sessionValue("projectBindingVerificationV1")).toMatchObject({
      projectUrl: PROJECT_ROOT,
      boundAt,
    });
    expect(harness.timeline).toContain(
      `scripting.executeScript:${tab.id}:MAIN:page-model-bridge.js`,
    );
    expect(harness.timeline).toContain(
      `scripting.executeScript:${tab.id}:ISOLATED:content-script.js`,
    );
    expect(harness.timeline.filter((entry) => entry === `tabs.reload:${tab.id}`)).toHaveLength(0);
    expect(harness.localValue("relayReloadCheckpointV1")).toBeUndefined();
  });

  it("restores a validated visibility lease across Relay reload without resending", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const baselineTab = await chrome.tabs.create({
      url: "https://example.test/restored-baseline",
      active: false,
    });
    const runTab = await chrome.tabs.create({ url: REMOTE_A, active: true });
    if (baselineTab.id === undefined || runTab.id === undefined) {
      throw new Error("Fake Chrome did not create the reload tabs.");
    }
    const baselineTabId = baselineTab.id;
    harness.setWindowFocused(runTab.windowId, false);
    let sendCalls = 0;
    harness.installTabMessageResponder(runTab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          complete: false,
          messages: [],
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.recover")) {
        return {
          ok: true,
          active: true,
          matchedActiveRun: true,
          markdown: "",
          remoteUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCalls += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });
    await harness.importContentScript(runTab.id, async () => undefined);
    const startedAt = new Date().toISOString();
    const key = JSON.stringify([INSTANCE_ID, CONVERSATION_ID]);
    harness.seedLocalValue("relayReloadCheckpointV1", {
      version: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      conversationTabs: [
        {
          owned: true,
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          tabId: runTab.id,
          remoteUrl: REMOTE_A,
          projectScope: PROJECT_SCOPE,
          createdAt: startedAt,
        },
      ],
      activeRuns: [
        {
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          runId: FIRST_RUN_ID,
          tabId: runTab.id,
          phase: "active",
          remoteAdoptionStage: "locked",
          startedAt,
        },
      ],
      completedCanonicalizations: [],
      runVisibilityLeases: {
        version: 1,
        windows: [
          {
            windowId: runTab.windowId,
            baselineTabId: baselineTab.id,
            userIntervened: false,
            stack: [
              {
                key,
                runId: FIRST_RUN_ID,
                tabId: runTab.id,
                windowId: runTab.windowId,
              },
            ],
          },
        ],
      },
    });

    await harness.importServiceWorker(async () => await import("./service-worker"));
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
      5_000,
    );
    await expect(
      chrome.runtime.sendMessage({
        type: "content.event",
        eventType: "stopped",
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        markdown: "Stopped after Relay reload",
        remoteUrl: REMOTE_A,
      }),
    ).resolves.toEqual({ ok: true });
    await waitUntil(() => harness.tabsById.get(baselineTabId)?.active === true);

    expect(sendCalls).toBe(0);
    expect(harness.tabsById.get(runTab.id)?.active).toBe(false);
  }, 10_000);

  it("drops an expired reload checkpoint without restoring its mappings", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    harness.seedLocalValue("relayReloadCheckpointV1", {
      version: 1,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      conversationTabs: [
        {
          owned: true,
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          tabId: 99,
          remoteUrl: REMOTE_A,
          projectScope: PROJECT_SCOPE,
          createdAt: new Date().toISOString(),
        },
      ],
      activeRuns: [],
      completedCanonicalizations: [],
    });

    await harness.importServiceWorker(async () => await import("./service-worker"));
    await harness.waitForSocket();

    expect(harness.sessionValue("conversationTabsV2")).toBeUndefined();
    expect(harness.localValue("relayReloadCheckpointV1")).toBeUndefined();
  });

  it("refuses an explicit Relay reload while a terminal event is still unacknowledged", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    harness.seedSessionValue("pendingEventsV2", [
      {
        eventId: "terminal-before-reload",
        instanceId: INSTANCE_ID,
        tabId: 41,
        startedAt: new Date().toISOString(),
        event: {
          type: "content.event",
          eventType: "complete",
          conversationId: CONVERSATION_ID,
          runId: FIRST_RUN_ID,
          markdown: "Answer still awaiting durable Host storage",
          remoteUrl: REMOTE_A,
        },
      },
    ]);
    await harness.importServiceWorker(async () => await import("./service-worker"));
    await harness.waitForSocket();

    await expect(harness.sendPopupMessage({ type: "popup.prepareReload" })).resolves.toMatchObject({
      ok: false,
    });
    expect(harness.localValue("relayReloadCheckpointV1")).toBeUndefined();
    expect(harness.runtimeReloadCalls).toBe(0);
    expect(
      (harness.sessionValue("pendingEventsV2") as Array<{ eventId?: string }>)[0]?.eventId,
    ).toBe("terminal-before-reload");
  }, 6_000);

  it("includes a terminal created while reload preparation is already waiting", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    harness.seedSessionValue("pendingEventsV2", [
      {
        eventId: "terminal-before-reload-a",
        instanceId: INSTANCE_ID,
        tabId: 41,
        startedAt: new Date().toISOString(),
        event: {
          type: "content.event",
          eventType: "complete",
          conversationId: CONVERSATION_ID,
          runId: FIRST_RUN_ID,
          markdown: "First answer awaiting Host storage",
          remoteUrl: REMOTE_A,
        },
      },
    ]);
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket, { acknowledgeTerminals: false });
    const firstTerminal = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
    );

    const preparation = harness.sendPopupMessage({ type: "popup.prepareReload" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID));
    const secondTerminal = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "relay.error" && envelope.runId === SECOND_RUN_ID,
    );
    socket.deliverFromHost(
      makeEnvelope({
        type: "generation.ack",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        payload: { eventId: firstTerminal.id, acknowledgedAt: new Date().toISOString() },
      }),
    );

    await expect(preparation).resolves.toMatchObject({ ok: false });
    expect(harness.localValue("relayReloadCheckpointV1")).toBeUndefined();
    expect(
      (harness.sessionValue("pendingEventsV2") as Array<{ eventId?: string }>).map(
        (pending) => pending.eventId,
      ),
    ).toContain(secondTerminal.id);

    socket.deliverFromHost(
      makeEnvelope({
        type: "generation.ack",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        runId: SECOND_RUN_ID,
        payload: { eventId: secondTerminal.id, acknowledgedAt: new Date().toISOString() },
      }),
    );
  }, 8_000);

  it("checkpoints an active generation and its exact mapped tab before reload", async () => {
    const { harness, socket, tab } = await startHarness();
    const baselineTab = await chrome.tabs.create({
      url: "https://example.test/reload-baseline",
      active: true,
    });
    if (baselineTab.id === undefined) throw new Error("Fake Chrome did not create a baseline tab.");
    harness.setWindowFocused(tab.windowId, false);
    installChatGptComposerFixture(harness, tab.id, {
      terminalMode: "streaming",
      autoCanonicalize: false,
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.snapshot" && envelope.runId === FIRST_RUN_ID,
    );

    await expect(harness.sendPopupMessage({ type: "popup.prepareReload" })).resolves.toEqual({
      ok: true,
      reloadScheduled: true,
    });
    expect(harness.localValue("relayReloadCheckpointV1")).toMatchObject({
      version: 1,
      conversationTabs: [
        expect.objectContaining({
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          tabId: tab.id,
        }),
      ],
      activeRuns: [
        expect.objectContaining({
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          runId: FIRST_RUN_ID,
          tabId: tab.id,
        }),
      ],
      runVisibilityLeases: {
        version: 4,
        windows: [
          expect.objectContaining({
            windowId: tab.windowId,
            baselineTabId: baselineTab.id,
            parked: false,
            restoreMinimized: false,
            userIntervened: false,
            stack: [
              expect.objectContaining({
                runId: FIRST_RUN_ID,
                tabId: tab.id,
                windowId: tab.windowId,
              }),
            ],
          }),
        ],
      },
    });
    expect(socket.readyState).toBe(FakeRelayWebSocket.CLOSED);
    expect(() => socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID))).toThrow(
      "Fake socket is not open",
    );
    await waitUntil(() => harness.runtimeReloadCalls === 1);
  }, 12_000);

  it("reconnects automatically when a Relay reload checkpoint write fails", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const firstSocket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, firstSocket);
    harness.failNextLocalWrite();

    await expect(harness.sendPopupMessage({ type: "popup.prepareReload" })).resolves.toMatchObject({
      ok: false,
    });
    await waitUntil(() => harness.socketsForPort().length >= 2);
    const replacement = harness.socketsForPort().at(-1)!;
    await connectFakeVsCodeHost(harness, replacement);

    expect(firstSocket.readyState).toBe(FakeRelayWebSocket.CLOSED);
    expect(harness.localValue("relayReloadCheckpointV1")).toBeUndefined();
    expect(harness.runtimeReloadCalls).toBe(0);
  });

  it("does not let a folded manual turn satisfy an exact multiline recovery fingerprint", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const tab = await chrome.tabs.create({ url: REMOTE_A, active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a recovery tab.");
    window.history.replaceState({}, "", REMOTE_A);
    document.body.innerHTML = `<main>${primaryConversationMarkup("streaming", true, "a b")}</main>`;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    const response: unknown = await chrome.tabs.sendMessage(tab.id, {
      type: "content.recover",
      conversationId: CONVERSATION_ID,
      runId: FIRST_RUN_ID,
      startedAt: new Date().toISOString(),
      expectedPromptSha256: "b5b65540b7c88230a6d62d928cd450d3be458c25e870d4750f754404324797b4",
    });

    expect(response).toMatchObject({
      ok: true,
      active: false,
      stopVisible: true,
      recoveryTurnMatched: false,
    });
  });

  it("recovers a reformatted rich prompt only through its versioned persisted run and mapped tab", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const tab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a mapped recovery tab.");
    const rawPrompt = [
      "Context:",
      "  [first_file.py] exposes foo_bar",
      "\t[second_file.py] calls another_value & checks <state>",
      "",
      "Question: only_reply_OK",
    ].join("\n");
    const normalizedPrompt = rawPrompt.trim();
    const renderedPrompt = normalizedPrompt.replace(/\s+/gu, " ");
    const promptSha256 = await sha256FixtureHex(normalizedPrompt);
    const promptInlinePresentationSha256 = await sha256FixtureHex(
      promptInlinePresentationV1(normalizedPrompt),
    );
    window.history.replaceState({}, "", REMOTE_A);
    document.body.innerHTML = `<main>${primaryConversationMarkup(
      "streaming",
      true,
      renderedPrompt,
    )}</main>`;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    const sendMessage = vi.spyOn(chrome.tabs, "sendMessage");
    const startedAt = new Date().toISOString();
    const emptyTranscriptSha256 = await sha256FixtureHex(JSON.stringify([]));
    harness.seedLocalValue("relayReloadCheckpointV1", {
      version: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      conversationTabs: [
        {
          owned: true,
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          tabId: tab.id,
          remoteUrl: REMOTE_A,
          projectScope: PROJECT_SCOPE,
          createdAt: startedAt,
        },
      ],
      activeRuns: [
        {
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          runId: FIRST_RUN_ID,
          tabId: tab.id,
          phase: "active",
          remoteAdoptionStage: "canonicalizing",
          promptSha256,
          promptInlinePresentationVersion: 1,
          promptInlinePresentationSha256,
          dispatchTranscriptBaseline: {
            tabId: tab.id,
            remoteUrl: REMOTE_A,
            initialProjectUrl: PROJECT_ROOT,
            messageCount: 0,
            transcriptSha256: emptyTranscriptSha256,
          },
          startedAt,
        },
      ],
      completedCanonicalizations: [],
    });

    await harness.importServiceWorker(async () => await import("./service-worker"));
    await waitUntil(() =>
      sendMessage.mock.calls.some(([, message]) => isMessageType(message, "content.recover")),
    );
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
    );
    const recoveryCall = sendMessage.mock.calls.find(([, message]) =>
      isMessageType(message, "content.recover"),
    );

    expect(recoveryCall?.[0]).toBe(tab.id);
    expect(recoveryCall?.[1]).toMatchObject({
      type: "content.recover",
      conversationId: CONVERSATION_ID,
      runId: FIRST_RUN_ID,
      expectedPromptSha256: promptSha256,
      expectedPromptInlinePresentationVersion: 1,
      expectedPromptInlinePresentationSha256: promptInlinePresentationSha256,
      allowPromptInlinePresentationMatch: true,
    });
    expect(harness.timeline.filter((entry) => entry.includes(":content.send"))).toHaveLength(0);
  });

  it("settles a reloaded checkpoint from its recovered snapshot without resending or accepting a late error", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const tab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a mapped tab.");
    const startedAt = new Date().toISOString();
    const emptyTranscriptSha256 = await sha256FixtureHex(JSON.stringify([]));
    let recoverCount = 0;
    let sendCount = 0;
    const installReloadedRuntime = (tabId: number) => {
      harness.installTabMessageResponder(tabId, (message) => {
        if (isMessageType(message, "content.ping")) {
          return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
        }
        if (isMessageType(message, "content.recover")) {
          recoverCount += 1;
          return {
            ok: true,
            active: true,
            adopted: true,
            matchedActiveRun: false,
            recoveryTurnMatched: true,
            markdown: "Recovered partial answer",
            remoteUrl: REMOTE_A,
            selectorVersion: CONTENT_RUNTIME_REVISION,
          };
        }
        if (isMessageType(message, "content.inspectConversation")) {
          return {
            ok: true,
            remoteUrl: REMOTE_A,
            complete: false,
            historyComplete: true,
            messages: [
              { role: "user", markdown: "Explain the relay race." },
              { role: "assistant", markdown: "Recovered partial answer" },
            ],
            observedAt: new Date().toISOString(),
            selectorVersion: CONTENT_RUNTIME_REVISION,
          };
        }
        if (isMessageType(message, "content.send")) sendCount += 1;
        return { ok: false };
      });
    };
    harness.beforeTabReload = (tabId) => {
      throw new Error(`Unexpected tab reload: ${tabId}`);
    };
    harness.scriptInjectionHandler = (tabId, files) => {
      if (files.includes("content-script.js")) installReloadedRuntime(tabId);
    };
    harness.seedLocalValue("relayReloadCheckpointV1", {
      version: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      conversationTabs: [
        {
          owned: true,
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          tabId: tab.id,
          remoteUrl: REMOTE_A,
          projectScope: PROJECT_SCOPE,
          createdAt: startedAt,
        },
      ],
      activeRuns: [
        {
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          runId: FIRST_RUN_ID,
          tabId: tab.id,
          phase: "active",
          remoteAdoptionStage: "canonicalizing",
          promptSha256: FIRST_PROMPT_SHA256,
          dispatchTranscriptBaseline: {
            tabId: tab.id,
            remoteUrl: REMOTE_A,
            initialProjectUrl: PROJECT_ROOT,
            messageCount: 0,
            transcriptSha256: emptyTranscriptSha256,
          },
          startedAt,
        },
      ],
      completedCanonicalizations: [],
    });

    await harness.importServiceWorker(async () => await import("./service-worker"));
    await waitUntil(() => recoverCount === 1);
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket, { acknowledgeTerminals: false });
    const recoveredSnapshot = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.snapshot" && envelope.runId === FIRST_RUN_ID,
    );
    expect(recoveredSnapshot.payload).toMatchObject({
      markdown: "Recovered partial answer",
      remoteUrl: REMOTE_A,
    });
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; promptSha256?: string; phase?: string }> | undefined
        )?.some(
          (run) =>
            run.runId === FIRST_RUN_ID &&
            run.promptSha256 === FIRST_PROMPT_SHA256 &&
            run.phase === "active",
        ) === true,
    );

    expect(harness.timeline).toContain(
      `scripting.executeScript:${tab.id}:MAIN:page-model-bridge.js`,
    );
    expect(harness.timeline).toContain(
      `scripting.executeScript:${tab.id}:ISOLATED:content-script.js`,
    );
    expect(harness.timeline.filter((entry) => entry === `tabs.reload:${tab.id}`)).toHaveLength(0);
    expect(sendCount).toBe(0);
    expect(harness.timeline.filter((entry) => entry.includes(":content.send"))).toHaveLength(0);

    // A different ChatGPT tab cannot claim the recovered run even when it
    // copies the same local conversation/run identifiers.
    const unrelatedTab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    if (unrelatedTab.id === undefined) throw new Error("Fake Chrome did not create a tab id.");
    await harness.importContentScript(unrelatedTab.id, async () => undefined);
    await expect(
      chrome.runtime.sendMessage({
        type: "content.event",
        eventType: "snapshot",
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        markdown: "Unrelated tab answer",
        remoteUrl: REMOTE_A,
      }),
    ).resolves.toEqual({ ok: false });
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) =>
            envelope.type === "generation.snapshot" &&
            (envelope.payload as { markdown?: string }).markdown === "Unrelated tab answer",
        ),
    ).toBe(false);

    // Keep subsequent runtime events bound to the exact mapped tab after the
    // simulated reload has installed its replacement content responder.
    await harness.importContentScript(tab.id, async () => undefined);

    await expect(
      chrome.runtime.sendMessage({
        type: "content.event",
        eventType: "complete",
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        markdown: "Recovered final answer",
        remoteUrl: REMOTE_A,
      }),
    ).resolves.toEqual({ ok: true });
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
    );
    expect(complete.payload).toMatchObject({ markdown: "Recovered final answer" });

    // A stale watchdog/content runtime can report an error after the durable
    // terminal has already won. It no longer owns an active run and must be
    // rejected instead of replacing the answer.
    await expect(
      chrome.runtime.sendMessage({
        type: "content.event",
        eventType: "error",
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        remoteUrl: REMOTE_A,
        error: {
          code: "CHATGPT_REMOTE_UNAVAILABLE",
          message: "Stale response-start watchdog",
          recoverable: true,
          focusTab: true,
        },
      }),
    ).resolves.toEqual({ ok: false });
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);

    // Replaying the original Host command while its terminal is awaiting ACK
    // replays that same terminal event id; it never clicks Send again.
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await waitUntil(
      () =>
        harness
          .outboundEnvelopes(socket)
          .filter(
            (envelope) =>
              envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
          ).length >= 2,
    );
    expect(
      new Set(
        harness
          .outboundEnvelopes(socket)
          .filter(
            (envelope) =>
              envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
          )
          .map((envelope) => envelope.id),
      ),
    ).toEqual(new Set([complete.id]));
    expect(sendCount).toBe(0);
    expect(harness.timeline.filter((entry) => entry.includes(":content.send"))).toHaveLength(0);
  }, 12_000);

  it("preserves a completed network lifecycle while recovered DOM attribution is temporarily absent", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const tab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a mapped tab.");
    const startedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    let recoverCount = 0;
    let sendCount = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.recover")) {
        recoverCount += 1;
        return {
          ok: true,
          active: true,
          matchedActiveRun: true,
          markdown: "",
          remoteUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
          runLifecycle: {
            documentVisible: false,
            intentAccepted: true,
            submissionConfirmed: true,
            networkSubmitted: true,
            networkResponseStarted: true,
            networkResponseComplete: true,
            networkResponseCompleteAgeMs: 120_000,
            userTurnObserved: false,
            responseAttributed: false,
            responseObserved: true,
            stopVisible: false,
            sawStop: true,
            assistantAfterUser: false,
          },
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          complete: false,
          messages: [],
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) sendCount += 1;
      return { ok: false };
    });
    await harness.importContentScript(tab.id, async () => undefined);
    harness.seedLocalValue("relayReloadCheckpointV1", {
      version: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      conversationTabs: [
        {
          owned: true,
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          tabId: tab.id,
          remoteUrl: REMOTE_A,
          projectScope: PROJECT_SCOPE,
          createdAt: startedAt,
        },
      ],
      activeRuns: [
        {
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          runId: FIRST_RUN_ID,
          tabId: tab.id,
          phase: "active",
          remoteAdoptionStage: "locked",
          startedAt,
        },
      ],
      completedCanonicalizations: [],
    });

    await harness.importServiceWorker(async () => await import("./service-worker"));
    await waitUntil(() => recoverCount === 1);
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket, { acknowledgeTerminals: false });
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
    );
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
    expect(sendCount).toBe(0);

    await expect(
      chrome.runtime.sendMessage({
        type: "content.event",
        eventType: "snapshot",
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        markdown: "Final answer restored after DOM churn",
        remoteUrl: REMOTE_A,
      }),
    ).resolves.toEqual({ ok: true });
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.snapshot" && envelope.runId === FIRST_RUN_ID,
    );
    await expect(
      chrome.runtime.sendMessage({
        type: "content.event",
        eventType: "complete",
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        markdown: "Final answer restored after DOM churn",
        remoteUrl: REMOTE_A,
      }),
    ).resolves.toEqual({ ok: true });
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
    );
    expect(complete.payload).toMatchObject({
      markdown: "Final answer restored after DOM churn",
    });
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
    expect(sendCount).toBe(0);
    expect(harness.timeline.filter((entry) => entry.includes(":content.send"))).toHaveLength(0);
  }, 12_000);

  it("fails closed when a rebuilt content runtime shows a different user turn", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const tab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a mapped tab.");
    window.history.replaceState({}, "", REMOTE_A);
    document.body.innerHTML = `<main>${primaryConversationMarkup(
      "complete",
      true,
      "A different manual question.",
    )}</main>`;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    const startedAt = new Date().toISOString();
    harness.seedLocalValue("relayReloadCheckpointV1", {
      version: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      conversationTabs: [
        {
          owned: true,
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          tabId: tab.id,
          remoteUrl: REMOTE_A,
          projectScope: PROJECT_SCOPE,
          createdAt: startedAt,
        },
      ],
      activeRuns: [
        {
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          runId: FIRST_RUN_ID,
          tabId: tab.id,
          phase: "active",
          remoteAdoptionStage: "canonicalizing",
          promptSha256: FIRST_PROMPT_SHA256,
          startedAt,
        },
      ],
      completedCanonicalizations: [],
    });

    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket, { acknowledgeTerminals: false });
    const failure = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "relay.error" && envelope.runId === FIRST_RUN_ID,
    );

    expect(failure.payload).toMatchObject({ code: "CHATGPT_REMOTE_UNAVAILABLE" });
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
        ),
    ).toBe(false);
    expect(harness.timeline.some((entry) => entry.includes(":content.send"))).toBe(false);
  });

  it("reports active runs only for the requesting VS Code instance", async () => {
    const { harness, socket, tab } = await startHarness({ acknowledgeTerminals: false });
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: PROJECT_ROOT,
          complete: true,
          messages: [],
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.recover")) {
        return {
          ok: true,
          active: true,
          matchedActiveRun: true,
          markdown: "",
          remoteUrl: PROJECT_ROOT,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });
    await waitUntil(() =>
      harness.timeline.includes(`tabs.sendMessage:response:${tab.id}:content.inspectConversation`),
    );

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ instanceId?: string; runId?: string; phase?: string }> | undefined
        )?.some(
          (run) =>
            run.instanceId === INSTANCE_ID && run.runId === FIRST_RUN_ID && run.phase === "active",
        ) === true,
    );

    const firstStatusCount = harness
      .outboundEnvelopes(socket)
      .filter((envelope) => envelope.type === "relay.status").length;
    socket.deliverFromHost(
      makeEnvelope({
        type: "relay.status.request",
        instanceId: INSTANCE_ID,
        payload: makeRelayStatusRequestPayload(),
      }),
    );
    await waitUntil(
      () =>
        harness.outboundEnvelopes(socket).filter((envelope) => envelope.type === "relay.status")
          .length > firstStatusCount,
    );
    expect(
      harness
        .outboundEnvelopes(socket)
        .filter((envelope) => envelope.type === "relay.status")
        .at(-1)?.payload,
    ).toMatchObject({ activeRuns: 1 });

    const otherInstanceId = "window-b";
    const otherSocket = await harness.waitForSocket(32_172);
    otherSocket.open();
    otherSocket.deliverFromHost(
      makeEnvelope({
        type: "relay.ready",
        instanceId: otherInstanceId,
        payload: { serverLabel: "Other Window", serverInstanceId: otherInstanceId },
      }),
    );
    const otherStatus = await harness.waitForEnvelope(
      otherSocket,
      (envelope) => envelope.type === "relay.status",
    );
    expect(otherStatus.payload).toMatchObject({ activeRuns: 0 });
  });

  it("keeps an authenticated relay alive beyond five seconds with legal status requests", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);

    await new Promise((resolve) => setTimeout(resolve, 5_100));
    const statusCount = harness
      .outboundEnvelopes(socket)
      .filter((envelope) => envelope.type === "relay.status").length;
    socket.deliverFromHost(
      makeEnvelope({
        type: "relay.status.request",
        instanceId: INSTANCE_ID,
        payload: makeRelayStatusRequestPayload(),
      }),
    );
    await waitUntil(
      () =>
        harness.outboundEnvelopes(socket).filter((envelope) => envelope.type === "relay.status")
          .length > statusCount,
    );

    expect(socket.readyState).toBe(FakeRelayWebSocket.OPEN);
    expect(socket.closeCode).toBeUndefined();
  }, 15_000);

  it("rejects a Chrome-to-Host status event forged by a Host", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);

    socket.deliverFromHost(
      makeEnvelope({
        type: "relay.status",
        instanceId: INSTANCE_ID,
        payload: {
          connected: true,
          authenticated: true,
          activeRuns: 0,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        },
      }),
    );
    await waitUntil(() => socket.readyState === FakeRelayWebSocket.CLOSED);
    expect(socket.closeCode).toBe(1008);
  });

  it("reports same-version schema failures without contradictory upgrade guidance", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);

    socket.deliverFromHost({
      version: PROTOCOL_VERSION,
      id: "malformed-status-request",
      type: "relay.status.request",
      instanceId: INSTANCE_ID,
      payload: {},
    } as unknown as RelayEnvelope);
    const error = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "relay.error",
    );

    expect((error.payload as { message?: string }).message).toContain("schema validation");
    expect((error.payload as { message?: string }).message).not.toMatch(/update|v15.*v15/iu);
    expect(socket.closeCode).toBe(1008);
  });

  it("rejects another Project and an unscoped legacy conversation before opening a tab", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);

    for (const [conversationId, remoteUrl] of [
      ["wrong-project", OTHER_REMOTE],
      ["legacy-global", "https://chatgpt.com/c/legacy-global"],
    ] as const) {
      socket.deliverFromHost(
        makeEnvelope({
          type: "conversation.open",
          instanceId: INSTANCE_ID,
          conversationId,
          payload: { remoteUrl, active: false },
        }),
      );
      const error = await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "relay.error" && envelope.conversationId === conversationId,
      );
      expect(error.payload).toMatchObject({ code: "CHATGPT_PROJECT_MISMATCH" });
    }

    expect([...harness.tabsById.values()]).toHaveLength(0);
  });

  it("keeps an old remote mapping unchanged when its Project scope is no longer bound", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const oldTab = await chrome.tabs.create({ url: OTHER_REMOTE, active: false });
    if (oldTab.id === undefined) throw new Error("Fake Chrome did not create an old Project tab.");
    harness.seedSessionValue("conversationTabsV2", [
      {
        owned: true,
        instanceId: INSTANCE_ID,
        conversationId: "old-remote-mapping",
        tabId: oldTab.id,
        remoteUrl: OTHER_REMOTE,
        projectScope: OTHER_PROJECT_SCOPE,
        createdAt: "2026-07-26T00:00:00.000Z",
      },
    ]);
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);

    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: "old-remote-mapping",
        payload: { remoteUrl: OTHER_REMOTE, active: false },
      }),
    );
    const error = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "relay.error" && envelope.conversationId === "old-remote-mapping",
    );
    expect(error.payload).toMatchObject({ code: "CHATGPT_PROJECT_MISMATCH" });
    expect(harness.tabsById.get(oldTab.id)?.url).toBe(OTHER_REMOTE);
    expect(harness.sessionValue("conversationTabsV2")).toEqual([
      expect.objectContaining({
        remoteUrl: OTHER_REMOTE,
        projectScope: OTHER_PROJECT_SCOPE,
      }),
    ]);
  });

  it("moves only an empty stale prewarm tab to the currently verified Project", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const oldTab = await chrome.tabs.create({ url: OTHER_PROJECT_ROOT, active: false });
    if (oldTab.id === undefined) throw new Error("Fake Chrome did not create an old prewarm tab.");
    harness.seedSessionValue("conversationTabsV2", [
      {
        owned: true,
        instanceId: INSTANCE_ID,
        conversationId: "stale-prewarm",
        tabId: oldTab.id,
        projectScope: OTHER_PROJECT_SCOPE,
        createdAt: "2026-07-26T00:00:00.000Z",
      },
    ]);
    harness.installTabMessageResponder(oldTab.id, (message) =>
      isMessageType(message, "content.ping")
        ? {
            ok: true,
            pageUrl: harness.tabsById.get(oldTab.id!)?.url,
            selectorVersion: CONTENT_RUNTIME_REVISION,
          }
        : { ok: false },
    );
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);

    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: "stale-prewarm",
        payload: { active: false },
      }),
    );
    await waitUntil(() => harness.tabsById.get(oldTab.id!)?.url === PROJECT_ROOT);
    await waitUntil(
      () =>
        (
          harness.sessionValue("conversationTabsV2") as
            | Array<{ conversationId?: string; projectScope?: string; remoteUrl?: string }>
            | undefined
        )?.some(
          (record) =>
            record.conversationId === "stale-prewarm" &&
            record.projectScope === PROJECT_SCOPE &&
            record.remoteUrl === undefined,
        ) === true,
    );
  });

  it("migrates a legacy V5 binding only after strict same-scope verification", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    harness.seedLocalValue("projectBindingV5", {
      version: 4,
      projectUrl: PROJECT_ROOT,
      scope: PROJECT_SCOPE,
      name: "Ask2GPT",
      boundAt: "2026-07-25T00:00:00.000Z",
    });
    const projectTab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (projectTab.id === undefined) throw new Error("Fake Chrome did not create a project tab.");
    window.history.replaceState({}, "", PROJECT_ROOT);
    document.body.innerHTML = projectSidebarLink(PROJECT_ROOT);
    await harness.importContentScript(projectTab.id, async () => await import("./content-script"));
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);

    const conversationTabPromise = harness.waitForCreatedTab(1);
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: "strict-migration",
        payload: { active: false },
      }),
    );
    const conversationTab = await conversationTabPromise;
    harness.installTabMessageResponder(conversationTab.id, (message) =>
      isMessageType(message, "content.ping")
        ? { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION }
        : { ok: false },
    );
    await waitUntil(
      () =>
        (harness.localValue("projectBindingV6") as { projectUrl?: string } | undefined)
          ?.projectUrl === PROJECT_ROOT,
    );
    expect(harness.localValue("projectBindingV5")).toBeUndefined();
    expect(harness.localValue("projectBindingV6")).toMatchObject({
      version: 5,
      provenance: "strict-visible-project-v1",
      projectUrl: PROJECT_ROOT,
      scope: PROJECT_SCOPE,
    });
    expect(harness.sessionValue("projectBindingVerificationV1")).toMatchObject({
      version: 1,
      projectUrl: PROJECT_ROOT,
    });
  });

  it("uses a trusted V6 binding after an ordinary worker restart without session proof or an open tab", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const trustedBinding = {
      version: 5,
      provenance: "strict-visible-project-v1",
      projectUrl: PROJECT_ROOT,
      scope: PROJECT_SCOPE,
      name: "Ask2GPT",
      boundAt: "2026-07-25T00:00:00.000Z",
    } as const;
    harness.seedLocalValue("projectBindingV6", trustedBinding);
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);

    const conversationTabPromise = harness.waitForCreatedTab(0);
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: "restart-without-session-proof",
        payload: { active: false },
      }),
    );
    const conversationTab = await conversationTabPromise;
    harness.installTabMessageResponder(conversationTab.id, (message) =>
      isMessageType(message, "content.ping")
        ? { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION }
        : { ok: false },
    );

    expect(conversationTab.url).toBe(PROJECT_ROOT);
    await waitUntil(
      () =>
        (
          harness.sessionValue("conversationTabsV2") as
            Array<{ conversationId?: string; tabId?: number; projectScope?: string }> | undefined
        )?.some(
          (record) =>
            record.conversationId === "restart-without-session-proof" &&
            record.tabId === conversationTab.id &&
            record.projectScope === PROJECT_SCOPE,
        ) === true,
    );
    expect(
      harness
        .outboundEnvelopes(socket)
        .filter(
          (envelope) =>
            envelope.type === "relay.error" &&
            envelope.conversationId === "restart-without-session-proof",
        ),
    ).toHaveLength(0);
    expect(harness.localValue("projectBindingV6")).toEqual(trustedBinding);
    expect(harness.sessionValue("projectBindingVerificationV1")).toBeUndefined();
  });

  it("keeps a bare legacy V5 binding pending when no strict same-scope proof is available", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const legacyBinding = {
      version: 4,
      projectUrl: PROJECT_ROOT,
      scope: PROJECT_SCOPE,
      name: "Ask2GPT",
      boundAt: "2026-07-25T00:00:00.000Z",
    } as const;
    harness.seedLocalValue("projectBindingV5", legacyBinding);
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);

    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: "legacy-without-proof",
        payload: { active: false },
      }),
    );
    const error = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "relay.error" && envelope.conversationId === "legacy-without-proof",
      10_000,
    );

    expect(error.payload).toMatchObject({ code: "CHATGPT_REMOTE_UNAVAILABLE" });
    expect(harness.localValue("projectBindingV5")).toEqual(legacyBinding);
    expect(harness.localValue("projectBindingV6")).toBeUndefined();
    expect(harness.sessionValue("conversationTabsV2")).toBeUndefined();
  }, 12_000);

  it("does not replace trusted scope A with a different visible exact-name scope B", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const trustedBinding = {
      version: 5,
      provenance: "strict-visible-project-v1",
      projectUrl: PROJECT_ROOT,
      scope: PROJECT_SCOPE,
      name: "Ask2GPT",
      boundAt: "2026-07-25T00:00:00.000Z",
    } as const;
    harness.seedLocalValue("projectBindingV6", trustedBinding);
    const otherProjectTab = await chrome.tabs.create({ url: OTHER_PROJECT_ROOT, active: true });
    if (otherProjectTab.id === undefined) {
      throw new Error("Fake Chrome did not create the other Project tab.");
    }
    window.history.replaceState({}, "", OTHER_PROJECT_ROOT);
    document.body.innerHTML = projectSidebarLink(OTHER_PROJECT_ROOT);
    await harness.importContentScript(
      otherProjectTab.id,
      async () => await import("./content-script"),
    );
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);

    const conversationTabPromise = harness.waitForCreatedTab(1);
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: "trusted-scope-wins",
        payload: { active: false },
      }),
    );
    const conversationTab = await conversationTabPromise;

    expect(conversationTab.url).toBe(PROJECT_ROOT);
    expect(harness.localValue("projectBindingV6")).toEqual(trustedBinding);
    expect(
      [...harness.tabsById.values()].filter(
        (tab) => tab.id !== otherProjectTab.id && tab.url === OTHER_PROJECT_ROOT,
      ),
    ).toHaveLength(0);
  });

  it("binds the active Project only after its visible Ask2GPT identity is verified", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const projectTab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (projectTab.id === undefined) throw new Error("Fake Chrome did not create a project tab.");
    window.history.replaceState({}, "", PROJECT_ROOT);
    document.title = "Ask2GPT - ChatGPT";
    document.body.innerHTML = projectSidebarLink(PROJECT_ROOT);
    await harness.importContentScript(projectTab.id, async () => await import("./content-script"));
    await harness.importServiceWorker(async () => await import("./service-worker"));

    await expect(
      harness.sendPopupMessage({ type: "popup.bindCurrentProject" }),
    ).resolves.toMatchObject({
      ok: true,
      project: { bound: true, name: "Ask2GPT", projectUrl: PROJECT_ROOT },
    });
    expect(harness.localValue("projectBindingV6")).toMatchObject({
      projectUrl: PROJECT_ROOT,
      scope: PROJECT_SCOPE,
      name: "Ask2GPT",
    });

    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);
    const tabPromise = harness.waitForCreatedTab(1);
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: "new-project-conversation",
        payload: { active: false },
      }),
    );
    const created = await tabPromise;
    expect(created.url).toBe(PROJECT_ROOT);
    harness.installTabMessageResponder(created.id, (message) =>
      isMessageType(message, "content.ping")
        ? { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION }
        : { ok: false },
    );
    await waitUntil(
      () =>
        (
          harness.sessionValue("conversationTabsV2") as
            Array<{ conversationId?: string; projectScope?: string }> | undefined
        )?.some(
          (record) =>
            record.conversationId === "new-project-conversation" &&
            record.projectScope === PROJECT_SCOPE,
        ) === true,
    );
  });

  it("creates the default Ask2GPT Project through the real page controls", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const homeTab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
    if (homeTab.id === undefined) throw new Error("Fake Chrome did not create the ChatGPT tab.");
    window.history.replaceState({}, "", "https://chatgpt.com/");
    document.title = "ChatGPT";
    document.body.innerHTML = `
      <nav aria-label="Chat history">
        <button type="button" aria-label="新项目" style="opacity: 0">新项目</button>
      </nav>
      <main></main>`;

    let submittedProjectName = "";
    const newProjectButton = requireElement<HTMLButtonElement>('button[aria-label="新项目"]');
    newProjectButton.addEventListener("click", () => {
      document.body.insertAdjacentHTML(
        "beforeend",
        `<dialog open aria-label="创建项目">
          <h2>创建项目</h2>
          <label for="project-name">项目名称</label>
          <input id="project-name" name="projectName" placeholder="哥本哈根之旅" />
          <button type="submit" disabled>创建项目</button>
        </dialog>`,
      );
      const dialog = requireElement<HTMLElement>("dialog");
      const input = requireElement<HTMLInputElement>("#project-name");
      const createButton = requireElement<HTMLButtonElement>('button[type="submit"]');
      input.addEventListener("input", () => {
        createButton.disabled = input.value.trim().length === 0;
      });
      createButton.addEventListener("click", () => {
        submittedProjectName = input.value;
        dialog.remove();
        document.body.innerHTML = `<nav aria-label="Chat history"><ul><li>
          <div role="button">Ask2GPT</div>
          <button type="button" aria-label="打开项目首页">打开项目首页</button>
        </li></ul></nav>`;
        requireElement<HTMLButtonElement>('button[aria-label="打开项目首页"]').addEventListener(
          "click",
          () => {
            window.history.replaceState({}, "", "https://chatgpt.com/g/g-created-ask2gpt/project");
            document.title = "Ask2GPT - ChatGPT";
          },
        );
      });
    });

    await harness.importContentScript(homeTab.id, async () => await import("./content-script"));

    await expect(
      chrome.tabs.sendMessage(homeTab.id, { type: "content.createProject" }),
    ).resolves.toMatchObject({
      ok: true,
      projectUrl: "https://chatgpt.com/g/g-created-ask2gpt/project",
      scope: "https://chatgpt.com/g/g-created-ask2gpt/",
      name: "Ask2GPT",
      created: true,
      selectorVersion: CONTENT_RUNTIME_REVISION,
      projectEvidenceVersion: 2,
    });
    expect(submittedProjectName).toBe("Ask2GPT");
  });

  it("accepts a button-based ChatGPT Project row during validity detection", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const projectTab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (projectTab.id === undefined) throw new Error("Fake Chrome did not create the Project tab.");
    window.history.replaceState({}, "", PROJECT_ROOT);
    document.title = "Ask2GPT - ChatGPT";
    document.body.innerHTML = `<nav aria-label="Chat history"><ul><li>
      <div role="button">Ask2GPT</div>
      <button type="button" aria-label="打开项目首页">打开项目首页</button>
      <button type="button" aria-label="打开 Ask2GPT 的项目选项">项目选项</button>
    </li></ul></nav>`;
    await harness.importContentScript(projectTab.id, async () => await import("./content-script"));

    await expect(
      chrome.tabs.sendMessage(projectTab.id, { type: "content.inspectProject" }),
    ).resolves.toMatchObject({
      ok: true,
      projectUrl: PROJECT_ROOT,
      scope: PROJECT_SCOPE,
      name: "Ask2GPT",
      selectorVersion: CONTENT_RUNTIME_REVISION,
      projectEvidenceVersion: 2,
    });
  });

  it("opens ChatGPT and saves the created Project binding from the popup flow", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const createdProjectUrl = "https://chatgpt.com/g/g-created-ask2gpt/project";
    const createdProjectScope = "https://chatgpt.com/g/g-created-ask2gpt/";
    let responderInstalled = false;
    harness.beforeTabMessage = (tabId, message) => {
      if (responderInstalled || !isMessageType(message, "content.createProject")) return;
      responderInstalled = true;
      harness.installTabMessageResponder(tabId, () => ({
        ok: true,
        projectUrl: createdProjectUrl,
        scope: createdProjectScope,
        name: "Ask2GPT",
        created: true,
        selectorVersion: CONTENT_RUNTIME_REVISION,
        projectEvidenceVersion: 2,
      }));
    };
    await harness.importServiceWorker(async () => await import("./service-worker"));

    await expect(
      harness.sendPopupMessage({ type: "popup.openChatGpt", mode: "create" }),
    ).resolves.toMatchObject({
      ok: true,
      created: true,
      project: { bound: true, name: "Ask2GPT", projectUrl: createdProjectUrl },
    });
    expect([...harness.tabsById.values()]).toHaveLength(1);
    expect([...harness.tabsById.values()][0]?.url).toBe("https://chatgpt.com/");
    expect(harness.localValue("projectBindingV6")).toMatchObject({
      version: 5,
      projectUrl: createdProjectUrl,
      scope: createdProjectScope,
      name: "Ask2GPT",
    });
    expect(responderInstalled).toBe(true);
  });

  it("reuses a ready ChatGPT tab for popup Project creation", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const existingTab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
    if (existingTab.id === undefined)
      throw new Error("Fake Chrome did not create the ChatGPT tab.");
    const createdProjectUrl = "https://chatgpt.com/g/g-reused-ask2gpt/project";
    const createdProjectScope = "https://chatgpt.com/g/g-reused-ask2gpt/";
    harness.beforeTabMessage = (tabId, message) => {
      if (tabId !== existingTab.id || !isMessageType(message, "content.ping")) return;
      harness.installTabMessageResponder(tabId, (request) => {
        if (isMessageType(request, "content.ping")) {
          return {
            ok: true,
            pageUrl: "https://chatgpt.com/",
            selectorVersion: CONTENT_RUNTIME_REVISION,
          };
        }
        if (isMessageType(request, "content.createProject")) {
          return {
            ok: true,
            projectUrl: createdProjectUrl,
            scope: createdProjectScope,
            name: "Ask2GPT",
            created: true,
            selectorVersion: CONTENT_RUNTIME_REVISION,
            projectEvidenceVersion: 2,
          };
        }
        return undefined;
      });
    };
    await harness.importServiceWorker(async () => await import("./service-worker"));

    await expect(
      harness.sendPopupMessage({ type: "popup.openChatGpt", mode: "create" }),
    ).resolves.toMatchObject({
      ok: true,
      created: true,
      project: { bound: true, name: "Ask2GPT", projectUrl: createdProjectUrl },
    });
    expect([...harness.tabsById.values()]).toHaveLength(1);
    expect([...harness.tabsById.values()][0]?.id).toBe(existingTab.id);
  });

  it("waits for a slow Project creation response without resending the command", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const createdProjectUrl = "https://chatgpt.com/g/g-slow-ask2gpt/project";
    const createdProjectScope = "https://chatgpt.com/g/g-slow-ask2gpt/";
    let createRequests = 0;
    harness.beforeTabMessage = (tabId, message) => {
      if (!isMessageType(message, "content.createProject")) return;
      harness.installTabMessageResponder(tabId, async (request) => {
        if (!isMessageType(request, "content.createProject")) return undefined;
        createRequests += 1;
        await new Promise((resolve) => setTimeout(resolve, 3_200));
        return {
          ok: true,
          projectUrl: createdProjectUrl,
          scope: createdProjectScope,
          name: "Ask2GPT",
          created: true,
          selectorVersion: CONTENT_RUNTIME_REVISION,
          projectEvidenceVersion: 2,
        };
      });
    };
    await harness.importServiceWorker(async () => await import("./service-worker"));

    await expect(
      harness.sendPopupMessage({ type: "popup.openChatGpt", mode: "create" }),
    ).resolves.toMatchObject({
      ok: true,
      created: true,
      project: { bound: true, name: "Ask2GPT", projectUrl: createdProjectUrl },
    });
    expect(createRequests).toBe(1);
  });

  it("lists and binds a user-selected Project with any visible name", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const selectedRoot = "https://chatgpt.com/g/g-team-project/project";
    const selectedScope = "https://chatgpt.com/g/g-team-project/";
    const otherRoot = "https://chatgpt.com/g/g-personal-project/project";
    const otherScope = "https://chatgpt.com/g/g-personal-project/";
    const projectTab = await chrome.tabs.create({ url: selectedRoot, active: true });
    if (projectTab.id === undefined) throw new Error("Fake Chrome did not create a project tab.");
    window.history.replaceState({}, "", selectedRoot);
    document.title = "团队研发 - ChatGPT";
    document.body.innerHTML = `
      <nav aria-label="Chat history"><ul>
        <li><a href="${selectedRoot}">团队研发</a></li>
        <li><a href="${otherRoot}">个人项目</a></li>
      </ul></nav>`;
    await harness.importContentScript(projectTab.id, async () => await import("./content-script"));
    await harness.importServiceWorker(async () => await import("./service-worker"));

    const listResponse = await harness.sendPopupMessage({ type: "popup.listProjects" });
    expect(listResponse).toMatchObject({ ok: true });
    expect((listResponse as { projects?: unknown }).projects).toEqual(
      expect.arrayContaining([
        { name: "团队研发", projectUrl: selectedRoot, scope: selectedScope },
        { name: "个人项目", projectUrl: otherRoot, scope: otherScope },
      ]),
    );
    await expect(
      harness.sendPopupMessage({ type: "popup.bindProject", projectUrl: selectedRoot }),
    ).resolves.toMatchObject({
      ok: true,
      project: { bound: true, name: "团队研发", projectUrl: selectedRoot },
    });
    expect(harness.localValue("projectBindingV6")).toMatchObject({
      projectUrl: selectedRoot,
      scope: selectedScope,
      name: "团队研发",
    });
  });

  it("waits for a visible active Project to hydrate before binding it", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const projectTab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (projectTab.id === undefined) throw new Error("Fake Chrome did not create a project tab.");
    window.history.replaceState({}, "", PROJECT_ROOT);
    document.title = "Ask2GPT - ChatGPT";
    document.body.replaceChildren();
    await harness.importContentScript(projectTab.id, async () => await import("./content-script"));
    await harness.importServiceWorker(async () => await import("./service-worker"));
    scheduleFixtureTimeout(() => {
      document.body.innerHTML = projectSidebarLink(PROJECT_ROOT);
    }, 350);

    await expect(
      harness.sendPopupMessage({ type: "popup.bindCurrentProject" }),
    ).resolves.toMatchObject({
      ok: true,
      project: { bound: true, name: "Ask2GPT", projectUrl: PROJECT_ROOT },
    });
    expect(harness.localValue("projectBindingV6")).toMatchObject({
      projectUrl: PROJECT_ROOT,
      scope: PROJECT_SCOPE,
    });
  });

  it("self-heals an active Project tab that still runs the previous content runtime", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const staleProjectTab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (staleProjectTab.id === undefined) {
      throw new Error("Fake Chrome did not create the stale Project tab.");
    }
    harness.installTabMessageResponder(staleProjectTab.id, (message) =>
      isMessageType(message, "content.inspectProject") ||
      isMessageType(message, "content.discoverProject")
        ? {
            ok: true,
            projectUrl: PROJECT_ROOT,
            scope: PROJECT_SCOPE,
            name: "Ask2GPT",
            projectEvidenceVersion: 1,
          }
        : { ok: false },
    );
    await harness.importServiceWorker(async () => await import("./service-worker"));

    const bindingPromise = harness.sendPopupMessage({ type: "popup.bindCurrentProject" });
    await waitUntil(() => harness.tabsById.size === 2);
    const verificationTab = [...harness.tabsById.values()].find(
      (candidate) => candidate.id !== staleProjectTab.id,
    )!;
    expect(verificationTab.url).toBe(PROJECT_ROOT);
    window.history.replaceState({}, "", PROJECT_ROOT);
    document.title = "Ask2GPT - ChatGPT";
    document.body.innerHTML = projectSidebarLink(PROJECT_ROOT);
    await harness.importContentScript(
      verificationTab.id,
      async () => await import("./content-script"),
    );

    await expect(bindingPromise).resolves.toMatchObject({
      ok: true,
      project: { bound: true, name: "Ask2GPT", projectUrl: PROJECT_ROOT },
    });
    await waitUntil(() => !harness.tabsById.has(verificationTab.id));
    expect(harness.tabsById.get(staleProjectTab.id)?.active).toBe(true);
    expect(harness.tabsById.get(staleProjectTab.id)?.url).toBe(PROJECT_ROOT);
  });

  it("relinquishes a verification tab that the user navigates to another Project", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const staleProjectTab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (staleProjectTab.id === undefined) {
      throw new Error("Fake Chrome did not create the stale Project tab.");
    }
    harness.installTabMessageResponder(staleProjectTab.id, (message) =>
      isMessageType(message, "content.inspectProject") ||
      isMessageType(message, "content.discoverProject")
        ? {
            ok: true,
            projectUrl: PROJECT_ROOT,
            scope: PROJECT_SCOPE,
            name: "Ask2GPT",
            projectEvidenceVersion: 1,
          }
        : { ok: false },
    );
    await harness.importServiceWorker(async () => await import("./service-worker"));

    const bindingPromise = harness.sendPopupMessage({ type: "popup.bindCurrentProject" });
    const verificationTab = await harness.waitForCreatedTab(1);
    harness.setTabUrl(verificationTab.id, OTHER_PROJECT_ROOT);
    harness.installTabMessageResponder(verificationTab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: OTHER_PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (
        isMessageType(message, "content.inspectProject") ||
        isMessageType(message, "content.discoverProject")
      ) {
        return {
          ok: false,
          error: {
            code: "CHATGPT_PROJECT_MISMATCH",
            message: "This tab now belongs to another Project.",
          },
        };
      }
      return { ok: false };
    });

    await expect(bindingPromise).resolves.toMatchObject({ ok: false });
    expect(harness.tabsById.has(verificationTab.id)).toBe(true);
    expect(harness.tabsById.get(verificationTab.id)?.url).toBe(OTHER_PROJECT_ROOT);
    expect(harness.tabsById.get(verificationTab.id)?.active).toBe(true);
    expect(harness.tabsById.get(staleProjectTab.id)?.active).toBe(false);
    expect(harness.sessionValue("projectDiscoveryTabV1")).toBeNull();
  });

  it("freshly verifies a stale active Ask2GPT Project before binding another window", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const otherWindowProject = await chrome.tabs.create({ url: PROJECT_ROOT, active: false });
    const activeProjectRoot = "https://chatgpt.com/g/g-p-second-ask2gpt/project";
    const activeProjectScope = "https://chatgpt.com/g/g-p-second-ask2gpt/";
    const staleActiveProject = await chrome.tabs.create({ url: activeProjectRoot, active: true });
    if (otherWindowProject.id === undefined || staleActiveProject.id === undefined) {
      throw new Error("Fake Chrome did not create both Project tabs.");
    }
    harness.installTabMessageResponder(otherWindowProject.id, (message) =>
      isMessageType(message, "content.inspectProject")
        ? {
            ok: true,
            projectUrl: PROJECT_ROOT,
            scope: PROJECT_SCOPE,
            name: "Ask2GPT",
            projectEvidenceVersion: 2,
          }
        : { ok: false },
    );
    harness.installTabMessageResponder(staleActiveProject.id, (message) =>
      isMessageType(message, "content.inspectProject") ||
      isMessageType(message, "content.discoverProject")
        ? {
            ok: true,
            projectUrl: activeProjectRoot,
            scope: activeProjectScope,
            name: "Ask2GPT",
            projectEvidenceVersion: 1,
          }
        : { ok: false },
    );
    await harness.importServiceWorker(async () => await import("./service-worker"));

    const bindingPromise = harness.sendPopupMessage({ type: "popup.bindCurrentProject" });
    const verificationTab = await harness.waitForCreatedTab(2);
    expect(verificationTab.url).toBe(activeProjectRoot);
    harness.installTabMessageResponder(verificationTab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: activeProjectRoot, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (
        isMessageType(message, "content.inspectProject") ||
        isMessageType(message, "content.discoverProject")
      ) {
        return {
          ok: true,
          projectUrl: activeProjectRoot,
          scope: activeProjectScope,
          name: "Ask2GPT",
          projectEvidenceVersion: 2,
        };
      }
      return { ok: false };
    });

    await expect(bindingPromise).resolves.toMatchObject({
      ok: true,
      project: { bound: true, name: "Ask2GPT", projectUrl: activeProjectRoot },
    });
    expect(harness.localValue("projectBindingV6")).toMatchObject({
      projectUrl: activeProjectRoot,
      scope: activeProjectScope,
    });
  });

  it("shares one Project binding attempt across popup reopen and exposes its progress", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const projectTab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (projectTab.id === undefined) throw new Error("Fake Chrome did not create a project tab.");
    let inspectionRequests = 0;
    let finishInspection:
      | ((value: {
          ok: true;
          projectUrl: string;
          scope: string;
          name: string;
          projectEvidenceVersion: number;
        }) => void)
      | undefined;
    const pendingInspection = new Promise<{
      ok: true;
      projectUrl: string;
      scope: string;
      name: string;
      projectEvidenceVersion: number;
    }>((resolve) => {
      finishInspection = resolve;
    });
    harness.installTabMessageResponder(projectTab.id, (message) => {
      if (
        isMessageType(message, "content.inspectProject") ||
        isMessageType(message, "content.discoverProject")
      ) {
        inspectionRequests += 1;
        return pendingInspection;
      }
      return { ok: false };
    });
    await harness.importServiceWorker(async () => await import("./service-worker"));

    const firstBinding = harness.sendPopupMessage({ type: "popup.bindCurrentProject" });
    await waitUntil(() => inspectionRequests === 1);
    await expect(harness.sendPopupMessage({ type: "popup.status" })).resolves.toMatchObject({
      projectSetup: { phase: "working" },
    });

    const secondBinding = harness.sendPopupMessage({ type: "popup.bindCurrentProject" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(inspectionRequests).toBe(1);

    finishInspection?.({
      ok: true,
      projectUrl: PROJECT_ROOT,
      scope: PROJECT_SCOPE,
      name: "Ask2GPT",
      projectEvidenceVersion: 2,
    });
    await expect(Promise.all([firstBinding, secondBinding])).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    await expect(harness.sendPopupMessage({ type: "popup.status" })).resolves.toMatchObject({
      project: { bound: true, projectUrl: PROJECT_ROOT },
      projectSetup: { phase: "idle" },
    });
  });

  it("binds from an active conversation inside the Project", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const projectTab = await chrome.tabs.create({ url: REMOTE_A, active: true });
    if (projectTab.id === undefined) throw new Error("Fake Chrome did not create a project tab.");
    window.history.replaceState({}, "", REMOTE_A);
    document.body.innerHTML = projectSidebarLink(PROJECT_ROOT);
    await harness.importContentScript(projectTab.id, async () => await import("./content-script"));
    await harness.importServiceWorker(async () => await import("./service-worker"));

    await expect(
      harness.sendPopupMessage({ type: "popup.bindCurrentProject" }),
    ).resolves.toMatchObject({
      ok: true,
      project: { bound: true, name: "Ask2GPT", projectUrl: PROJECT_ROOT },
    });
    expect(harness.localValue("projectBindingV6")).toMatchObject({
      projectUrl: PROJECT_ROOT,
      scope: PROJECT_SCOPE,
    });
  });

  it("refuses an active Project URL whose visible identity is not Ask2GPT", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const wrongRoot = "https://chatgpt.com/g/another-project/project";
    const projectTab = await chrome.tabs.create({ url: wrongRoot, active: true });
    if (projectTab.id === undefined) throw new Error("Fake Chrome did not create a project tab.");
    window.history.replaceState({}, "", wrongRoot);
    document.title = "Another Project - ChatGPT";
    document.body.innerHTML = projectSidebarLink(wrongRoot, "Another Project");
    await harness.importContentScript(projectTab.id, async () => await import("./content-script"));
    await harness.importServiceWorker(async () => await import("./service-worker"));

    await expect(
      harness.sendPopupMessage({ type: "popup.bindCurrentProject" }),
    ).resolves.toMatchObject({ ok: false });
    expect(harness.localValue("projectBindingV6")).toBeUndefined();
  });

  it("refuses a renamed Project even when its stale route slug contains Ask2GPT", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const staleSlugRoot = "https://chatgpt.com/g/g-p-renamed-ask2gpt/project";
    const projectTab = await chrome.tabs.create({ url: staleSlugRoot, active: true });
    if (projectTab.id === undefined) throw new Error("Fake Chrome did not create a project tab.");
    window.history.replaceState({}, "", staleSlugRoot);
    document.title = "Renamed Project - ChatGPT";
    document.body.innerHTML = projectSidebarLink(staleSlugRoot, "Renamed Project");
    await harness.importContentScript(projectTab.id, async () => await import("./content-script"));
    await expect(
      chrome.tabs.sendMessage(projectTab.id, { type: "content.discoverProject" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CHATGPT_PROJECT_MISMATCH" },
    });
    await harness.importServiceWorker(async () => await import("./service-worker"));

    await expect(
      harness.sendPopupMessage({ type: "popup.bindCurrentProject" }),
    ).resolves.toMatchObject({ ok: false });
    expect(harness.localValue("projectBindingV5")).toBeUndefined();
    expect(harness.localValue("projectBindingV6")).toBeUndefined();
  });

  it("rejects a Project-shaped link rendered only inside a conversation body", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const conversationUrl = "https://chatgpt.com/c/body-link-only";
    const tab = await chrome.tabs.create({ url: conversationUrl, active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a conversation tab.");
    window.history.replaceState({}, "", conversationUrl);
    document.title = "Conversation - ChatGPT";
    document.body.innerHTML = `<main><a href="${PROJECT_ROOT}">Ask2GPT</a></main>`;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    await expect(
      chrome.tabs.sendMessage(tab.id, { type: "content.inspectProject" }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("does not persist a wrong Project conversation with a forged Ask2GPT title", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const wrongConversation = `${OTHER_PROJECT_SCOPE}c/forged-title`;
    const tab = await chrome.tabs.create({ url: wrongConversation, active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a Project tab.");
    window.history.replaceState({}, "", wrongConversation);
    document.title = "ChatGPT - Ask2GPT";
    document.body.innerHTML = `<main data-message-author-role="assistant"><a href="${OTHER_PROJECT_ROOT}">Ask2GPT</a></main>`;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    await harness.importServiceWorker(async () => await import("./service-worker"));

    await expect(
      harness.sendPopupMessage({ type: "popup.bindCurrentProject" }),
    ).resolves.toMatchObject({ ok: false });
    expect(harness.localValue("projectBindingV5")).toBeUndefined();
    expect(harness.localValue("projectBindingV6")).toBeUndefined();
  });

  it("does not replace trusted scope A from a forged body/title candidate in scope B", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const trustedBinding = {
      version: 5,
      provenance: "strict-visible-project-v1",
      projectUrl: PROJECT_ROOT,
      scope: PROJECT_SCOPE,
      name: "Ask2GPT",
      boundAt: "2026-07-25T00:00:00.000Z",
    } as const;
    harness.seedLocalValue("projectBindingV6", trustedBinding);
    const wrongConversation = `${OTHER_PROJECT_SCOPE}c/forged-title`;
    const tab = await chrome.tabs.create({ url: wrongConversation, active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a Project tab.");
    window.history.replaceState({}, "", wrongConversation);
    document.title = "ChatGPT - Ask2GPT";
    document.body.innerHTML = `<main data-message-author-role="assistant"><a href="${OTHER_PROJECT_ROOT}">Ask2GPT</a></main>`;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    await harness.importServiceWorker(async () => await import("./service-worker"));

    await expect(
      harness.sendPopupMessage({ type: "popup.bindCurrentProject" }),
    ).resolves.toMatchObject({ ok: false });
    expect(harness.localValue("projectBindingV6")).toEqual(trustedBinding);
    expect(harness.localValue("projectBindingV5")).toBeUndefined();
  }, 8_000);

  it("binds the verified sidebar Project while ignoring a conflicting body link", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const tab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a home tab.");
    window.history.replaceState({}, "", "https://chatgpt.com/");
    document.title = "ChatGPT";
    document.body.innerHTML = `
      <nav aria-label="Chat history"><ul><li><a href="${PROJECT_ROOT}">Ask2GPT</a></li></ul></nav>
      <main><a href="${OTHER_PROJECT_ROOT}">Ask2GPT</a></main>`;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    await harness.importServiceWorker(async () => await import("./service-worker"));

    await expect(
      harness.sendPopupMessage({ type: "popup.bindCurrentProject" }),
    ).resolves.toMatchObject({ ok: true, project: { projectUrl: PROJECT_ROOT } });
    expect(harness.localValue("projectBindingV6")).toMatchObject({
      projectUrl: PROJECT_ROOT,
      scope: PROJECT_SCOPE,
    });
    expect(harness.localValue("projectBindingV6")).not.toMatchObject({
      projectUrl: OTHER_PROJECT_ROOT,
    });
  });

  it("opens Project home only from one visible row carrying both exact controls", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const homeTab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
    if (homeTab.id === undefined) throw new Error("Fake Chrome did not create a home tab.");
    window.history.replaceState({}, "", "https://chatgpt.com/");
    document.title = "ChatGPT";
    document.body.innerHTML = `
      <nav aria-label="Chat history"><ul><li>
          <button id="project-main" type="button"><span>Ask2GPT</span><span hidden> hidden metadata</span></button>
          <button id="project-home" type="button" aria-labelledby="project-home-label"></button>
          <span id="project-home-label" class="sr-only">Open project home</span>
          <button type="button" aria-label="打开 Ask2GPT 的项目选项"></button>
      </li></ul></nav>`;
    const projectMain = requireElement<HTMLButtonElement>("#project-main");
    Object.defineProperty(projectMain, "innerText", {
      configurable: true,
      value: "Ask2GPT",
    });
    expect(projectMain.textContent).not.toBe("Ask2GPT");
    const projectHome = requireElement<HTMLButtonElement>("#project-home");
    const click = vi.fn();
    projectHome.addEventListener("click", click);
    await harness.importContentScript(homeTab.id, async () => await import("./content-script"));

    await expect(
      chrome.tabs.sendMessage(homeTab.id, { type: "content.openProjectHome" }),
    ).resolves.toEqual({ ok: true });
    expect(click).toHaveBeenCalledTimes(1);
    await expect(
      chrome.tabs.sendMessage(homeTab.id, {
        type: "content.openProjectHome",
        name: "Ask2GPT",
      }),
    ).rejects.toThrow("No fake runtime listener accepted");
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("refuses to combine the Project name and home action across list items", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const homeTab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
    if (homeTab.id === undefined) throw new Error("Fake Chrome did not create a home tab.");
    window.history.replaceState({}, "", "https://chatgpt.com/");
    document.title = "ChatGPT";
    document.body.innerHTML = `
      <nav aria-label="Chat history"><ul>
        <li><button type="button">Ask2GPT</button></li>
        <li><button type="button" aria-label="Open project home"></button></li>
        <li><button type="button">Private Project Name</button></li>
      </ul></nav>`;
    const projectHome = requireElement<HTMLButtonElement>('button[aria-label="Open project home"]');
    const click = vi.fn();
    projectHome.addEventListener("click", click);
    await harness.importContentScript(homeTab.id, async () => await import("./content-script"));

    const rejected = (await chrome.tabs.sendMessage(homeTab.id, {
      type: "content.openProjectHome",
    })) as { ok?: unknown; error?: { message?: string } };
    expect(rejected).toMatchObject({ ok: false });
    expect(rejected.error?.message).toMatch(/visibleRows=\d+/u);
    expect(rejected.error?.message).toMatch(/exactNameRows=\d+/u);
    expect(rejected.error?.message).toMatch(/homeActionRows=\d+/u);
    expect(rejected.error?.message).toMatch(/combinedRows=\d+/u);
    expect(rejected.error?.message).toMatch(/targetButtons=\d+/u);
    expect(rejected.error?.message).toContain("ariaLabelledBy:");
    expect(rejected.error?.message).not.toContain("Private Project Name");
    expect(click).not.toHaveBeenCalled();

    document.body.innerHTML = `
      <nav aria-label="Chat history"><ul>
        <li><button type="button">Ask2GPT</button><button type="button" aria-label="Open project home"></button></li>
        <li><button type="button">Ask2GPT</button><button type="button" aria-label="打开项目首页"></button></li>
      </ul></nav>`;
    const ambiguousClicks = vi.fn();
    for (const action of document.querySelectorAll<HTMLButtonElement>("button[aria-label]")) {
      action.addEventListener("click", ambiguousClicks);
    }
    await expect(
      chrome.tabs.sendMessage(homeTab.id, { type: "content.openProjectHome" }),
    ).resolves.toMatchObject({ ok: false });
    expect(ambiguousClicks).not.toHaveBeenCalled();
  });

  it("uses an exact title only to corroborate sidebar controls on a strict Project root", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const projectRoot = "https://chatgpt.com/g/g-p-title-proof-ask2gpt/project";
    const projectScope = "https://chatgpt.com/g/g-p-title-proof-ask2gpt/";
    const projectTab = await chrome.tabs.create({ url: projectRoot, active: true });
    if (projectTab.id === undefined) throw new Error("Fake Chrome did not create a Project tab.");
    window.history.replaceState({}, "", projectRoot);
    document.title = "ChatGPT - Ask2GPT";
    document.body.replaceChildren();
    await harness.importContentScript(projectTab.id, async () => await import("./content-script"));

    await expect(
      chrome.tabs.sendMessage(projectTab.id, { type: "content.inspectProject" }),
    ).resolves.toMatchObject({ ok: false });

    document.body.innerHTML = `
      <div><ul><li>
        <div role="button" tabindex="0">Ask2GPT</div>
        <button type="button" aria-label="Open project home"></button>
      </li></ul></div>`;
    await expect(
      chrome.tabs.sendMessage(projectTab.id, { type: "content.inspectProject" }),
    ).resolves.toMatchObject({
      ok: true,
      projectUrl: projectRoot,
      scope: projectScope,
      name: "Ask2GPT",
    });

    document.title = "Ask2GPT - ChatGPT";
    await expect(
      chrome.tabs.sendMessage(projectTab.id, { type: "content.inspectProject" }),
    ).resolves.toMatchObject({ ok: true, projectUrl: projectRoot, scope: projectScope });

    window.history.replaceState({}, "", "https://chatgpt.com/");
    await expect(
      chrome.tabs.sendMessage(projectTab.id, { type: "content.inspectProject" }),
    ).resolves.toMatchObject({ ok: false });

    window.history.replaceState({}, "", projectRoot);
    document.title = "ChatGPT";
    await expect(
      chrome.tabs.sendMessage(projectTab.id, { type: "content.inspectProject" }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("binds from the visible Ask2GPT link on the ChatGPT home page", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const homeTab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
    if (homeTab.id === undefined) throw new Error("Fake Chrome did not create a home tab.");
    window.history.replaceState({}, "", "https://chatgpt.com/");
    document.title = "ChatGPT";
    document.body.innerHTML = projectSidebarLink(PROJECT_ROOT);
    await harness.importContentScript(homeTab.id, async () => await import("./content-script"));
    await harness.importServiceWorker(async () => await import("./service-worker"));

    await expect(
      harness.sendPopupMessage({ type: "popup.bindCurrentProject" }),
    ).resolves.toMatchObject({
      ok: true,
      project: { bound: true, projectUrl: PROJECT_ROOT },
    });
    expect(harness.localValue("projectBindingV6")).toMatchObject({
      projectUrl: PROJECT_ROOT,
      scope: PROJECT_SCOPE,
    });
  });

  it("consumes the exact Ask2GPT Project discovered from ChatGPT page runtime traffic", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const projectRoot = "https://chatgpt.com/g/g-p-api-project-123/project";
    const homeTab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
    if (homeTab.id === undefined) throw new Error("Fake Chrome did not create a home tab.");
    window.history.replaceState({}, "", "https://chatgpt.com/");
    document.title = "ChatGPT";
    document.body.replaceChildren();
    document.documentElement.setAttribute(
      "data-ask2gpt-project-binding",
      JSON.stringify({
        name: "Ask2GPT",
        projectUrl: projectRoot,
        evidenceVersion: 2,
        observedAt: Date.now(),
      }),
    );
    await harness.importContentScript(homeTab.id, async () => await import("./content-script"));
    await harness.importServiceWorker(async () => await import("./service-worker"));

    await expect(
      harness.sendPopupMessage({ type: "popup.bindCurrentProject" }),
    ).resolves.toMatchObject({
      ok: true,
      project: { bound: true, name: "Ask2GPT", projectUrl: projectRoot },
    });
    expect(harness.localValue("projectBindingV6")).toMatchObject({
      version: 5,
      provenance: "strict-visible-project-v1",
      projectUrl: projectRoot,
      name: "Ask2GPT",
    });
  });

  it("discovers Ask2GPT from the exact accessible name on a collapsed sidebar link", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const projectRoot = "https://chatgpt.com/g/g-p-runtime-id-ask2gpt/project";
    const projectScope = "https://chatgpt.com/g/g-p-runtime-id-ask2gpt/";
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const homeTab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
    if (homeTab.id === undefined) throw new Error("Fake Chrome did not create a home tab.");
    window.history.replaceState({}, "", "https://chatgpt.com/");
    document.title = "ChatGPT";
    document.body.innerHTML = `<nav aria-label="Chat history"><ul><li><a href="${projectRoot}" aria-label="Ask2GPT Project"><span>project icon</span>Open</a></li></ul></nav>`;
    await harness.importContentScript(homeTab.id, async () => await import("./content-script"));
    await harness.importServiceWorker(async () => await import("./service-worker"));

    await expect(
      harness.sendPopupMessage({ type: "popup.bindCurrentProject" }),
    ).resolves.toMatchObject({
      ok: true,
      project: { bound: true, projectUrl: projectRoot },
    });
    expect(harness.localValue("projectBindingV6")).toMatchObject({
      projectUrl: projectRoot,
      scope: projectScope,
    });
  });

  it("discovers Ask2GPT from a freshly created ChatGPT home before opening a new chat", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const originalTab = await chrome.tabs.create({
      url: "https://example.test/original",
      active: true,
    });
    if (originalTab.id === undefined)
      throw new Error("Fake Chrome did not create the original tab.");
    window.history.replaceState({}, "", "https://chatgpt.com/");
    document.title = "ChatGPT";
    document.body.replaceChildren();
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);

    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: "fresh-project-discovery",
        payload: { active: false },
      }),
    );
    await waitUntil(() =>
      [...harness.tabsById.values()].some((candidate) => candidate.url === "https://chatgpt.com/"),
    );
    const homeTab = [...harness.tabsById.values()].find(
      (candidate) => candidate.url === "https://chatgpt.com/",
    )!;
    await harness.importContentScript(homeTab.id, async () => await import("./content-script"));
    await waitUntil(() => harness.tabsById.get(homeTab.id)?.active === true);
    scheduleFixtureTimeout(() => {
      document.body.innerHTML = `
        <nav aria-label="Chat history"><ul><li>
            <button id="delayed-project-main" type="button"><span>Ask2GPT</span><span hidden> hidden metadata</span></button>
            <button id="delayed-project-home" type="button" aria-labelledby="delayed-project-home-label"></button>
            <span id="delayed-project-home-label" class="sr-only">Open project home</span>
        </li></ul></nav>`;
      Object.defineProperty(
        requireElement<HTMLButtonElement>("#delayed-project-main"),
        "innerText",
        {
          configurable: true,
          value: "Ask2GPT",
        },
      );
      requireElement<HTMLButtonElement>("#delayed-project-home").addEventListener("click", () => {
        window.history.replaceState({}, "", PROJECT_ROOT);
        document.title = "ChatGPT - Ask2GPT";
        harness.setTabUrl(homeTab.id, PROJECT_ROOT);
      });
    }, 350);
    await waitUntil(
      () =>
        (harness.localValue("projectBindingV6") as { projectUrl?: string } | undefined)
          ?.projectUrl === PROJECT_ROOT,
    );
    await waitUntil(() => harness.sessionValue("projectDiscoveryTabV1") === null);
    expect(harness.tabsById.has(homeTab.id)).toBe(false);
    expect(harness.tabsById.get(originalTab.id)?.active).toBe(true);
    await waitUntil(() =>
      [...harness.tabsById.values()].some((candidate) => candidate.url === PROJECT_ROOT),
    );
    const conversationTab = [...harness.tabsById.values()].find(
      (candidate) => candidate.url === PROJECT_ROOT,
    )!;
    expect(conversationTab.url).toBe(PROJECT_ROOT);
    harness.installTabMessageResponder(conversationTab.id, (message) =>
      isMessageType(message, "content.ping")
        ? { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION }
        : { ok: false },
    );
    expect(harness.timeline).toContain(
      `tabs.sendMessage:response:${homeTab.id}:content.openProjectHome`,
    );
    expect(harness.timeline).toContain(`tab-active:${homeTab.id}:true`);
    expect(harness.timeline).toContain(`tab-active:${originalTab.id}:true`);
    expect(harness.timeline.some((entry) => entry.startsWith("window-updated:"))).toBe(false);
    expect(new Set([...harness.tabsById.values()].map((candidate) => candidate.windowId))).toEqual(
      new Set([originalTab.windowId]),
    );
  }, 12_000);

  it("relinquishes a login probe so a later retry never closes the user's navigated tab", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);

    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: "login-probe-first",
        payload: { active: false },
      }),
    );
    const loginTab = await harness.waitForCreatedTab(0);
    harness.setTabUrl(loginTab.id, "https://auth.openai.com/login");
    const firstError = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "relay.error" && envelope.conversationId === "login-probe-first",
    );
    expect(firstError.payload).toMatchObject({ code: "CHATGPT_LOGIN_REQUIRED" });
    expect(harness.sessionValue("projectDiscoveryTabV1")).toBeNull();
    expect(harness.tabsById.has(loginTab.id)).toBe(true);

    const userConversation = "https://chatgpt.com/c/user-owned-after-login";
    harness.setTabUrl(loginTab.id, userConversation);
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: "login-probe-retry",
        payload: { active: false },
      }),
    );
    await waitUntil(() => harness.tabsById.size >= 2);
    const retryTab = [...harness.tabsById.values()].find(
      (candidate) => candidate.id !== loginTab.id,
    )!;
    expect(retryTab.url).toBe("https://chatgpt.com/");
    harness.setTabUrl(retryTab.id, "https://auth.openai.com/login");
    const retryError = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "relay.error" && envelope.conversationId === "login-probe-retry",
    );
    expect(retryError.payload).toMatchObject({ code: "CHATGPT_LOGIN_REQUIRED" });
    expect(harness.tabsById.get(loginTab.id)?.url).toBe(userConversation);
    expect(harness.tabsById.has(loginTab.id)).toBe(true);
    expect(harness.sessionValue("projectDiscoveryTabV1")).toBeNull();
  });

  it("finds one unambiguous Project across Chrome windows when the active tab is unrelated", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const projectTab = await chrome.tabs.create({ url: PROJECT_ROOT, active: false });
    await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
    if (projectTab.id === undefined) throw new Error("Fake Chrome did not create a project tab.");
    harness.tabsById.get(projectTab.id)!.windowId = 2;
    window.history.replaceState({}, "", PROJECT_ROOT);
    document.title = "Ask2GPT - ChatGPT";
    document.body.innerHTML = projectSidebarLink(PROJECT_ROOT);
    await harness.importContentScript(projectTab.id, async () => await import("./content-script"));
    await harness.importServiceWorker(async () => await import("./service-worker"));

    await expect(
      harness.sendPopupMessage({ type: "popup.bindCurrentProject" }),
    ).resolves.toMatchObject({
      ok: true,
      project: { bound: true, projectUrl: PROJECT_ROOT },
    });
  });

  it("binds the uniquely verified Ask2GPT Project when another Project is active", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const ask2gptTab = await chrome.tabs.create({ url: PROJECT_ROOT, active: false });
    const otherProjectTab = await chrome.tabs.create({ url: OTHER_PROJECT_ROOT, active: true });
    if (ask2gptTab.id === undefined || otherProjectTab.id === undefined) {
      throw new Error("Fake Chrome did not create both Project tabs.");
    }
    harness.tabsById.get(ask2gptTab.id)!.windowId = 2;
    harness.installTabMessageResponder(ask2gptTab.id, (message) =>
      isMessageType(message, "content.inspectProject")
        ? {
            ok: true,
            projectUrl: PROJECT_ROOT,
            scope: PROJECT_SCOPE,
            name: "Ask2GPT",
            projectEvidenceVersion: 2,
          }
        : { ok: false },
    );
    harness.installTabMessageResponder(otherProjectTab.id, (message) =>
      isMessageType(message, "content.discoverProject") ||
      isMessageType(message, "content.inspectProject")
        ? {
            ok: true,
            projectUrl: OTHER_PROJECT_ROOT,
            scope: OTHER_PROJECT_SCOPE,
            name: "Other Project",
            projectEvidenceVersion: 2,
          }
        : { ok: false },
    );
    await harness.importServiceWorker(async () => await import("./service-worker"));

    await expect(
      harness.sendPopupMessage({ type: "popup.bindCurrentProject" }),
    ).resolves.toMatchObject({
      ok: true,
      project: { bound: true, name: "Ask2GPT", projectUrl: PROJECT_ROOT },
    });
    expect(harness.localValue("projectBindingV6")).toMatchObject({
      projectUrl: PROJECT_ROOT,
      scope: PROJECT_SCOPE,
      name: "Ask2GPT",
    });
  });

  it("rejects an ambiguous fallback instead of binding the wrong Project", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    await chrome.tabs.create({ url: "https://chatgpt.com/g/project-one/project", active: false });
    await chrome.tabs.create({ url: "https://chatgpt.com/g/project-two/project", active: false });
    await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
    await harness.importServiceWorker(async () => await import("./service-worker"));

    const response = (await harness.sendPopupMessage({
      type: "popup.bindCurrentProject",
    })) as { ok?: unknown; error?: unknown };
    expect(response.ok).toBe(false);
    expect(response.error).toEqual(expect.stringContaining("多个 ChatGPT Project"));
    expect(harness.localValue("projectBindingV6")).toBeUndefined();
  });

  it("acknowledges tab cleanup only after close succeeds and safely retries failures", async () => {
    const { harness, socket, tab } = await startHarness();
    harness.installTabMessageResponder(tab.id, (message) =>
      isMessageType(message, "content.ping")
        ? { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION }
        : isMessageType(message, "content.inspectProject")
          ? {
              ok: true,
              projectUrl: PROJECT_ROOT,
              scope: PROJECT_SCOPE,
              name: "Ask2GPT",
              projectEvidenceVersion: 2,
            }
          : { ok: false },
    );
    await waitUntil(
      () =>
        (
          harness.sessionValue("conversationTabsV2") as
            Array<{ conversationId?: string; tabId?: number }> | undefined
        )?.some(
          (record) => record.conversationId === CONVERSATION_ID && record.tabId === tab.id,
        ) === true,
    );

    harness.failNextTabRemovals(tab.id);
    const failedClose = makeEnvelope({
      type: "conversation.close",
      instanceId: INSTANCE_ID,
      conversationId: CONVERSATION_ID,
      payload: { closeTab: true },
    });
    socket.deliverFromHost(failedClose);
    const error = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "relay.error" && envelope.conversationId === CONVERSATION_ID,
    );
    expect(error.payload).toMatchObject({ code: "CHATGPT_REMOTE_UNAVAILABLE" });
    expect(harness.tabsById.has(tab.id)).toBe(true);
    expect(
      (
        harness.sessionValue("conversationTabsV2") as
          Array<{ conversationId?: string; tabId?: number }> | undefined
      )?.some((record) => record.conversationId === CONVERSATION_ID && record.tabId === tab.id),
    ).toBe(true);
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) =>
            envelope.type === "conversation.closed" &&
            (envelope.payload as { requestId?: string }).requestId === failedClose.id,
        ),
    ).toBe(false);

    const retryClose = makeEnvelope({
      type: "conversation.close",
      instanceId: INSTANCE_ID,
      conversationId: CONVERSATION_ID,
      payload: { closeTab: true },
    });
    socket.deliverFromHost(retryClose);
    const closed = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.closed" &&
        (envelope.payload as { requestId?: string }).requestId === retryClose.id,
    );
    expect(closed.payload).toMatchObject({
      closeTab: true,
      tabDisposition: "closed",
    });
    expect(harness.tabsById.has(tab.id)).toBe(false);
    expect(harness.sessionValue("conversationTabsV2")).toEqual([]);

    const idempotentClose = makeEnvelope({
      type: "conversation.close",
      instanceId: INSTANCE_ID,
      conversationId: CONVERSATION_ID,
      payload: { closeTab: true },
    });
    socket.deliverFromHost(idempotentClose);
    const alreadyAbsent = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.closed" &&
        (envelope.payload as { requestId?: string }).requestId === idempotentClose.id,
    );
    expect(alreadyAbsent.payload).toMatchObject({
      closeTab: true,
      tabDisposition: "already-absent",
    });
  });

  it("keeps a selected Chrome tab attached through provisional and canonical URLs", async () => {
    const { harness, socket, tab } = await startHarness();
    const composer = installChatGptComposerFixture(harness, tab.id, {
      removeEmptyFollowUpSendControl: true,
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
    );
    expect(complete.payload).toMatchObject({
      markdown: "Short answer completed on provisional A",
      remoteUrl: REMOTE_A,
    });
    expect(harness.tabsById.get(tab.id)?.active).toBe(true);

    const canonicalHistory = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.snapshot" &&
        envelope.conversationId === CONVERSATION_ID &&
        (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_B,
    );
    expect(canonicalHistory.payload).toMatchObject({
      remoteUrl: REMOTE_B,
      complete: true,
      messages: [
        { role: "user", markdown: "Explain the relay race." },
        { role: "assistant", markdown: "Short answer completed on provisional A" },
      ],
    });
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);

    // Simulate a stale Host cache still sending A. The owned tab is already B
    // and must remain authoritative instead of being navigated backwards.
    socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_A));
    const followUp = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
    );
    expect(followUp.payload).toMatchObject({ markdown: "Follow-up answer on canonical B" });
    expect((followUp.payload as { remoteUrl?: string }).remoteUrl).toBe(REMOTE_B);
    expect(harness.tabsById.get(tab.id)?.url).toBe(REMOTE_B);
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
    expect(composer.sendClicks()).toBe(2);
    expect(composer.submittedPrompts()).toEqual([
      "Explain the relay race.",
      "Explain the relay race.",
    ]);
  }, 12_000);

  it("completes an immediate second turn when ChatGPT recycles transcript nodes", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, {
      virtualizeFollowUp: true,
      autoCanonicalize: false,
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    const firstComplete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );
    const firstRemoteUrl = (firstComplete.payload as { remoteUrl?: string }).remoteUrl;
    expect(firstRemoteUrl).toBe(REMOTE_A);

    // The host is allowed to send the next turn as soon as it receives the
    // terminal envelope. ChatGPT may recycle the old user/assistant nodes, so
    // response detection cannot rely on the visible message count increasing.
    // Keep the exact route stable here; cross-conversation navigation is a
    // separate fail-closed condition.
    socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, firstRemoteUrl));
    const secondComplete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
      5_000,
    );
    expect(secondComplete.payload).toMatchObject({
      markdown: "Short answer completed on provisional A",
      remoteUrl: REMOTE_A,
    });
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
    expect(page.sendClicks()).toBe(2);
    expect(page.formSubmits()).toBe(0);
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
      ),
    ).toHaveLength(2);
    await waitUntil(
      () =>
        !(harness.sessionValue("activeRunsV2") as Array<{ runId?: string }> | undefined)?.some(
          (run) => run.runId === SECOND_RUN_ID,
        ),
    );
    await waitUntil(() => harness.tabsById.get(tab.id)?.autoDiscardable === true);
    expect(
      (
        harness.sessionValue("conversationTabsV2") as
          Array<{ conversationId?: string; tabId?: number; remoteUrl?: string }> | undefined
      )?.find((record) => record.conversationId === CONVERSATION_ID),
    ).toMatchObject({ tabId: tab.id, remoteUrl: REMOTE_A });
  }, 10_000);

  it("reruns final history sync when a second terminal lands during an in-flight inspect", async () => {
    const { harness, socket, tab } = await startHarness();
    // Keep the owned tab active for the whole race. Otherwise the terminal's
    // transient activation emits an unrelated onActivated snapshot sync that
    // can mask whether the coalesced final sync itself requested a rerun.
    harness.emitTabActivated(tab.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.importContentScript(tab.id, async () => undefined);

    type VisibleMessage = { role: "user" | "assistant"; markdown: string };
    const firstAnswer = "First visible answer";
    const followUpPrompt = "Give me the follow-up.";
    const partialFollowUp = "Partial follow-up";
    const finalFollowUp = "Final follow-up answer";
    let visibleMessages: VisibleMessage[] = [];
    let visibleComplete = false;
    let inspectCount = 0;
    let inspectReleased = false;
    let heldInspectObservedAt: string | undefined;
    let coalescedRerunObservedAt: string | undefined;
    let holdNextInspect = false;
    let heldInspect = false;
    let markInspectEntered!: () => void;
    let markRerunInspectEntered!: () => void;
    let releaseInspect!: () => void;
    let releaseRerunInspect!: () => void;
    const inspectEntered = new Promise<void>((resolve) => {
      markInspectEntered = resolve;
    });
    const rerunInspectEntered = new Promise<void>((resolve) => {
      markRerunInspectEntered = resolve;
    });
    const inspectGate = new Promise<void>((resolve) => {
      releaseInspect = resolve;
    });
    const rerunInspectGate = new Promise<void>((resolve) => {
      releaseRerunInspect = resolve;
    });
    const submittedPrompts: string[] = [];

    harness.installTabMessageResponder(tab.id, async (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: harness.tabsById.get(tab.id)?.url,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.composerStatus")) {
        return {
          ok: true,
          ready: true,
          rawCandidateCount: 1,
          readyCandidateCount: 1,
          visibilityState: "visible",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        const prompt = (message as { prompt?: unknown }).prompt;
        if (typeof prompt === "string") submittedPrompts.push(prompt);
        return {
          ok: true,
          pageUrl: harness.tabsById.get(tab.id)?.url,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        inspectCount += 1;
        const observedAt = new Date(
          Date.parse("2026-07-31T00:00:00.000Z") + inspectCount,
        ).toISOString();
        const capturedMessages = visibleMessages.map((item) => ({ ...item }));
        const capturedComplete = visibleComplete;
        if (holdNextInspect && !heldInspect) {
          heldInspect = true;
          heldInspectObservedAt = observedAt;
          markInspectEntered();
          await inspectGate;
        } else if (inspectReleased && !coalescedRerunObservedAt) {
          // The dirty rerun starts before the shared pending sync resolves.
          // Later background syncs get their own marker and cannot satisfy the
          // exact final-history assertion below.
          coalescedRerunObservedAt = observedAt;
          markRerunInspectEntered();
          await rerunInspectGate;
        }
        return {
          ok: true,
          remoteUrl: harness.tabsById.get(tab.id)?.url ?? PROJECT_ROOT,
          title: "Snapshot rerun",
          complete: capturedComplete,
          historyComplete: true,
          messages: capturedMessages,
          observedAt,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
    );
    harness.setPrimaryDocumentUrl(REMOTE_A);
    harness.setTabUrl(tab.id, REMOTE_A);
    visibleMessages = [
      { role: "user", markdown: "Explain the relay race." },
      { role: "assistant", markdown: firstAnswer },
    ];
    visibleComplete = true;
    await expect(
      chrome.runtime.sendMessage({
        type: "content.event",
        eventType: "complete",
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        markdown: firstAnswer,
        remoteUrl: REMOTE_A,
      }),
    ).resolves.toEqual({ ok: true });
    await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.snapshot" &&
        envelope.conversationId === CONVERSATION_ID &&
        (envelope.payload as { messages?: VisibleMessage[] }).messages?.length === 2,
    );

    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.send",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        runId: SECOND_RUN_ID,
        payload: {
          prompt: followUpPrompt,
          messageId: `message-${SECOND_RUN_ID}`,
          remoteUrl: REMOTE_A,
        },
      }),
    );
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === SECOND_RUN_ID && run.phase === "active") === true,
    );

    visibleMessages = [
      { role: "user", markdown: "Explain the relay race." },
      { role: "assistant", markdown: firstAnswer },
      { role: "user", markdown: followUpPrompt },
      { role: "assistant", markdown: partialFollowUp },
    ];
    visibleComplete = false;
    const inspectCountBeforeRace = inspectCount;
    holdNextInspect = true;
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        payload: { remoteUrl: REMOTE_A, active: false },
      }),
    );
    await inspectEntered;
    expect(inspectCount).toBe(inspectCountBeforeRace + 1);

    visibleMessages = [
      { role: "user", markdown: "Explain the relay race." },
      { role: "assistant", markdown: firstAnswer },
      { role: "user", markdown: followUpPrompt },
      { role: "assistant", markdown: finalFollowUp },
    ];
    visibleComplete = true;
    let secondTerminalSettled = false;
    const secondTerminal = chrome.runtime.sendMessage({
      type: "content.event",
      eventType: "complete",
      conversationId: CONVERSATION_ID,
      runId: SECOND_RUN_ID,
      markdown: finalFollowUp,
      remoteUrl: REMOTE_A,
    });
    void secondTerminal.then(
      () => {
        secondTerminalSettled = true;
      },
      () => {
        secondTerminalSettled = true;
      },
    );
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
    );
    await waitUntil(
      () =>
        !(harness.sessionValue("activeRunsV2") as Array<{ runId?: string }> | undefined)?.some(
          (run) => run.runId === SECOND_RUN_ID,
        ),
    );
    // The durable terminal commit marks the blocked history sync dirty before
    // generation.complete is sent, so releasing it no longer depends on a
    // guessed wall-clock delay.
    inspectReleased = true;
    releaseInspect();
    await rerunInspectEntered;
    await Promise.resolve();
    await Promise.resolve();
    await expect(secondTerminal).resolves.toEqual({ ok: true });
    expect(secondTerminalSettled).toBe(true);
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) =>
            envelope.type === "conversation.snapshot" &&
            envelope.conversationId === CONVERSATION_ID &&
            (envelope.payload as { observedAt?: string }).observedAt === coalescedRerunObservedAt,
        ),
    ).toBe(false);
    releaseRerunInspect();
    expect(heldInspectObservedAt).toBeDefined();
    expect(coalescedRerunObservedAt).toBeDefined();

    const finalHistory = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.snapshot" &&
        envelope.conversationId === CONVERSATION_ID &&
        (envelope.payload as { observedAt?: string }).observedAt === coalescedRerunObservedAt &&
        (envelope.payload as { complete?: boolean }).complete === true &&
        (envelope.payload as { messages?: VisibleMessage[] }).messages?.at(-1)?.markdown ===
          finalFollowUp,
    );
    expect(finalHistory.payload).toMatchObject({
      remoteUrl: REMOTE_A,
      complete: true,
      messages: visibleMessages,
    });
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) =>
            envelope.type === "conversation.snapshot" &&
            envelope.conversationId === CONVERSATION_ID &&
            (envelope.payload as { observedAt?: string }).observedAt === heldInspectObservedAt,
        ),
    ).toBe(false);
    expect(submittedPrompts).toEqual(["Explain the relay race.", followUpPrompt]);
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
      ),
    ).toHaveLength(2);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
  }, 10_000);

  it("keeps a restored terminal history barrier across tab reload until exact final history arrives", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const tab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    const tabId = tab.id!;
    const finalAnswer = "Final answer after the restored tab settles";
    const terminalMarkdownSha256 = await sha256FixtureHex(finalAnswer);
    let visibleComplete = false;
    let visibleMessages = [
      { role: "user" as const, markdown: "Explain the relay race." },
      { role: "assistant" as const, markdown: "Final answer after the restored" },
    ];
    let inspectCount = 0;

    harness.installTabMessageResponder(tabId, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        inspectCount += 1;
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          title: visibleComplete ? "Settled final history" : "Stale partial title",
          complete: visibleComplete,
          historyComplete: visibleComplete,
          messages: visibleMessages,
          observedAt: new Date(Date.parse("2026-07-31T01:00:00.000Z") + inspectCount).toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });
    harness.seedSessionValue("conversationTabsV2", [
      {
        owned: true,
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        tabId,
        remoteUrl: REMOTE_A,
        projectScope: PROJECT_SCOPE,
        createdAt: "2026-07-31T00:59:00.000Z",
      },
    ]);
    harness.seedSessionValue("terminalHistoryBarriersV1", [
      {
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        tabId,
        terminalMarkdownSha256,
        createdAt: "2026-07-31T01:00:00.000Z",
      },
    ]);

    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);

    const inspectCountBeforePartialReload = inspectCount;
    await chrome.tabs.reload(tabId);
    await waitUntil(() => inspectCount > inspectCountBeforePartialReload);
    expect(
      harness
        .outboundEnvelopes(socket)
        .filter(
          (envelope) =>
            envelope.type === "conversation.snapshot" &&
            envelope.conversationId === CONVERSATION_ID,
        ),
    ).toHaveLength(0);
    expect(
      (
        harness.sessionValue("conversationTabsV2") as
          Array<{ conversationId?: string; remoteTitle?: string }> | undefined
      )?.find((record) => record.conversationId === CONVERSATION_ID)?.remoteTitle,
    ).toBeUndefined();
    expect(
      harness.sessionValue("terminalHistoryBarriersV1") as Array<{ runId?: string }> | undefined,
    ).toEqual([expect.objectContaining({ runId: FIRST_RUN_ID })]);

    visibleComplete = true;
    visibleMessages = [
      { role: "user", markdown: "Explain the relay race." },
      { role: "assistant", markdown: finalAnswer },
    ];
    const finalSnapshotPromise = harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.snapshot" &&
        envelope.conversationId === CONVERSATION_ID &&
        (envelope.payload as { complete?: boolean }).complete === true &&
        (
          envelope.payload as {
            messages?: Array<{ role?: string; markdown?: string }>;
          }
        ).messages?.at(-1)?.markdown === finalAnswer,
    );
    await chrome.tabs.reload(tabId);
    const finalSnapshot = await finalSnapshotPromise;

    expect(finalSnapshot.payload).toMatchObject({
      remoteUrl: REMOTE_A,
      title: "Settled final history",
      complete: true,
      messages: visibleMessages,
    });
    await waitUntil(
      () =>
        (harness.sessionValue("terminalHistoryBarriersV1") as Array<unknown> | undefined)
          ?.length === 0,
    );
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) =>
            envelope.type === "conversation.snapshot" &&
            envelope.conversationId === CONVERSATION_ID &&
            (envelope.payload as { complete?: boolean }).complete === false,
        ),
    ).toBe(false);
  }, 10_000);

  it("recovers a hidden restored terminal history without the user opening Chrome", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const tab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    const decoy = await chrome.tabs.create({ url: "https://example.test/user-tab", active: true });
    const tabId = tab.id!;
    const finalAnswer = "Final answer hydrated only while the Relay tab is active";
    const terminalMarkdownSha256 = await sha256FixtureHex(finalAnswer);
    let inspectCount = 0;

    harness.installTabMessageResponder(tabId, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        inspectCount += 1;
        const hydrated = harness.tabsById.get(tabId)?.active === true;
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          complete: hydrated,
          historyComplete: hydrated,
          messages: [
            { role: "user", markdown: "Explain the relay race." },
            {
              role: "assistant",
              markdown: hydrated ? finalAnswer : "Final answer hydrated only",
            },
          ],
          observedAt: new Date(Date.parse("2026-07-31T01:10:00.000Z") + inspectCount).toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });
    harness.seedSessionValue("conversationTabsV2", [
      {
        owned: true,
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        tabId,
        remoteUrl: REMOTE_A,
        projectScope: PROJECT_SCOPE,
        createdAt: "2026-07-31T01:09:00.000Z",
      },
    ]);
    harness.seedSessionValue("terminalHistoryBarriersV1", [
      {
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        tabId,
        terminalMarkdownSha256,
        createdAt: "2026-07-31T01:10:00.000Z",
      },
    ]);

    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);

    const finalSnapshot = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.snapshot" &&
        envelope.conversationId === CONVERSATION_ID &&
        (envelope.payload as { complete?: boolean }).complete === true &&
        (
          envelope.payload as {
            messages?: Array<{ role?: string; markdown?: string }>;
          }
        ).messages?.at(-1)?.markdown === finalAnswer,
      5_000,
    );

    expect(finalSnapshot.payload).toMatchObject({
      remoteUrl: REMOTE_A,
      complete: true,
      messages: [
        { role: "user", markdown: "Explain the relay race." },
        { role: "assistant", markdown: finalAnswer },
      ],
    });
    await waitUntil(
      () =>
        (harness.sessionValue("terminalHistoryBarriersV1") as Array<unknown> | undefined)
          ?.length === 0,
    );
    expect(inspectCount).toBeGreaterThan(0);
    expect(harness.timeline).toContain(`tab-active:${tabId}:true`);
    expect(harness.timeline).toContain(`tab-active:${decoy.id}:true`);
    expect(harness.tabsById.get(decoy.id!)?.active).toBe(true);
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tabId}:content.send`,
      ),
    ).toHaveLength(0);
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) =>
            envelope.type === "conversation.snapshot" &&
            envelope.conversationId === CONVERSATION_ID &&
            (envelope.payload as { complete?: boolean }).complete === false,
        ),
    ).toBe(false);
  }, 10_000);

  it("replays a duplicate terminal without resending and releases its barrier for the next run", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const tab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    const tabId = tab.id!;
    const finalAnswer = "Durable terminal awaiting acknowledgement";
    const terminalMarkdownSha256 = await sha256FixtureHex(finalAnswer);
    let contentSendCount = 0;
    let historyHydrated = false;

    harness.installTabMessageResponder(tabId, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          complete: historyHydrated,
          historyComplete: historyHydrated,
          messages: [
            { role: "user", markdown: "Explain the relay race." },
            {
              role: "assistant",
              markdown: historyHydrated ? finalAnswer : "Durable terminal awaiting",
            },
          ],
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.composerStatus")) {
        return {
          ok: true,
          ready: true,
          rawCandidateCount: 1,
          readyCandidateCount: 1,
          visibilityState: "visible",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        contentSendCount += 1;
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });
    harness.seedSessionValue("conversationTabsV2", [
      {
        owned: true,
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        tabId,
        remoteUrl: REMOTE_A,
        projectScope: PROJECT_SCOPE,
        createdAt: "2026-07-31T01:30:00.000Z",
      },
    ]);
    harness.seedSessionValue("terminalHistoryBarriersV1", [
      {
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        tabId,
        terminalMarkdownSha256,
        createdAt: "2026-07-31T01:31:00.000Z",
      },
    ]);
    harness.seedSessionValue("pendingEventsV2", [
      {
        eventId: "durable-terminal-first-run",
        instanceId: INSTANCE_ID,
        tabId,
        startedAt: "2026-07-31T01:30:00.000Z",
        event: {
          type: "content.event",
          eventType: "complete",
          conversationId: CONVERSATION_ID,
          runId: FIRST_RUN_ID,
          markdown: finalAnswer,
          remoteUrl: REMOTE_A,
        },
      },
    ]);

    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket, { acknowledgeTerminals: false });
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
    );

    const terminalDeliveriesBeforeReplay = harness
      .outboundEnvelopes(socket)
      .filter(
        (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      ).length;
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID, REMOTE_A));
    await waitUntil(
      () =>
        harness
          .outboundEnvelopes(socket)
          .filter(
            (envelope) =>
              envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
          ).length > terminalDeliveriesBeforeReplay,
    );
    expect(contentSendCount).toBe(0);
    expect(
      harness.sessionValue("terminalHistoryBarriersV1") as Array<{ runId?: string }> | undefined,
    ).toEqual([expect.objectContaining({ runId: FIRST_RUN_ID })]);

    historyHydrated = true;
    socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_A));
    await waitUntil(() => contentSendCount === 1);
    await waitUntil(
      () =>
        (harness.sessionValue("terminalHistoryBarriersV1") as Array<unknown> | undefined)
          ?.length === 0,
    );
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === SECOND_RUN_ID && run.phase === "active") === true,
    );

    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tabId}:content.send`,
      ),
    ).toHaveLength(1);
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
  }, 10_000);

  it("rejects a same-Project manual conversation switch during the final send check", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, { autoCanonicalize: false });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    const firstComplete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );
    expect((firstComplete.payload as { remoteUrl?: string }).remoteUrl).toBe(REMOTE_A);

    page.navigateOnNextComposerInput(REMOTE_C, { renderUnrelatedTranscript: true });
    socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_A));
    const error = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "relay.error" && envelope.runId === SECOND_RUN_ID,
      5_000,
    );

    expect(error.payload).toMatchObject({ code: "CHATGPT_REMOTE_UNAVAILABLE" });
    expect(page.sendClicks()).toBe(1);
    expect(page.formSubmits()).toBe(0);
    expect(page.submittedPrompts()).toEqual(["Explain the relay race."]);
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
      ),
    ).toHaveLength(2);
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
        ),
    ).toBe(false);
    expect(
      (
        harness.sessionValue("conversationTabsV2") as
          Array<{ conversationId?: string; remoteUrl?: string }> | undefined
      )?.find((record) => record.conversationId === CONVERSATION_ID),
    ).toBeUndefined();
  }, 10_000);

  it("attributes a reused assistant element from a changed ChatGPT turn identity", async () => {
    const { harness, socket, tab } = await startHarness();
    installChatGptComposerFixture(harness, tab.id, {
      reuseAssistantFollowUp: "identity-changed",
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );
    await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.snapshot" &&
        (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_B,
      5_000,
    );

    const assistantBefore = requireElement<HTMLElement>('[data-message-author-role="assistant"]');
    const sentAt = Date.now();
    socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_B));
    const snapshot = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.snapshot" && envelope.runId === SECOND_RUN_ID,
      2_000,
    );

    expect(Date.now() - sentAt).toBeLessThan(1_500);
    expect(requireElement('[data-message-author-role="assistant"]')).toBe(assistantBefore);
    expect(snapshot.payload).toMatchObject({
      markdown: "Short answer completed on provisional A",
      remoteUrl: REMOTE_B,
    });
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
      3_000,
    );
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
  }, 12_000);

  it("waits for quiet ownership before adopting a reused identity-less assistant", async () => {
    const { harness, socket, tab } = await startHarness();
    installChatGptComposerFixture(harness, tab.id, {
      reuseAssistantFollowUp: "identity-unavailable",
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );
    await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.snapshot" &&
        (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_B,
      5_000,
    );

    const assistantBefore = requireElement<HTMLElement>('[data-message-author-role="assistant"]');
    const assistantTurnBefore = assistantBefore.closest("article")?.outerHTML;
    socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_B));

    await new Promise((resolve) => setTimeout(resolve, 1_800));
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) =>
            envelope.runId === SECOND_RUN_ID &&
            ["generation.snapshot", "generation.complete", "relay.error"].includes(envelope.type),
        ),
    ).toBe(false);

    const snapshot = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.snapshot" && envelope.runId === SECOND_RUN_ID,
      3_000,
    );
    const assistantAfter = requireElement<HTMLElement>('[data-message-author-role="assistant"]');
    expect(assistantAfter).toBe(assistantBefore);
    expect(assistantAfter.closest("article")?.outerHTML).toBe(assistantTurnBefore);
    expect(snapshot.payload).toMatchObject({
      markdown: "Short answer completed on provisional A",
      remoteUrl: REMOTE_B,
    });
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
      3_000,
    );
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
  }, 14_000);

  it("polls a changed hidden in-place follow-up without adopting an unchanged transcript", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const contentEvents: Array<{
      type?: unknown;
      eventType?: unknown;
      runId?: unknown;
      markdown?: unknown;
      remoteUrl?: unknown;
    }> = [];
    await installDirectMainWorldSendWorker(harness, (message) => {
      if (typeof message === "object" && message !== null) {
        contentEvents.push(message as (typeof contentEvents)[number]);
      }
    });
    const createdTab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (createdTab.id === undefined) throw new Error("Fixture tab has no id.");
    const tabId = createdTab.id;
    const nativeObserve = MutationObserver.prototype.observe;
    let disconnectRunObservers = false;
    vi.spyOn(MutationObserver.prototype, "observe").mockImplementation(function (
      this: MutationObserver,
      target: Node,
      options?: MutationObserverInit,
    ) {
      nativeObserve.call(this, target, options);
      // The long-lived run observer watches document.body. Keep the
      // short-lived submission observer working so this fixture isolates the
      // polling fallback used after a background dispatch.
      if (disconnectRunObservers && target === document.body) this.disconnect();
    });
    const page = installChatGptComposerFixture(harness, tabId, {
      reuseAssistantFollowUp: "in-place-user-text",
    });
    const bridge = installRunLifecycleBridgeFixture();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await harness.importContentScript(tabId, async () => await import("./content-script"));
    requireElement<HTMLButtonElement>('[data-testid="send-button"]').addEventListener(
      "click",
      () => {
        const runId = bridge.pendingRunId();
        if (runId) bridge.emit(runId, "submitted");
      },
    );

    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "content.send",
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        prompt: "Explain the relay race.",
        expectedProjectScope: PROJECT_SCOPE,
        allowFirstConversation: true,
      });
      await waitUntil(
        () =>
          contentEvents.some(
            (event) => event.eventType === "complete" && event.runId === FIRST_RUN_ID,
          ),
        5_000,
      );
      await waitUntil(() => location.href === REMOTE_B, 5_000);

      visibility.mockReturnValue("hidden");
      disconnectRunObservers = true;
      const unchangedRunId = "run-unchanged-in-place-follow-up";
      await chrome.tabs.sendMessage(tabId, {
        type: "content.send",
        conversationId: CONVERSATION_ID,
        runId: unchangedRunId,
        prompt: "Explain the relay race.",
        expectedProjectScope: PROJECT_SCOPE,
        expectedRemoteUrl: REMOTE_B,
        allowFirstConversation: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 3_200));
      expect(
        contentEvents.filter(
          (event) =>
            event.runId === unchangedRunId &&
            ["snapshot", "complete", "error"].includes(String(event.eventType)),
        ),
      ).toHaveLength(0);

      // End only the synthetic unchanged run. A real page lifecycle event can
      // likewise destroy this observer before a later command reuses the same
      // virtualized turn nodes.
      window.dispatchEvent(new Event("pagehide"));
      const followUpPrompt = "Again reply with only OK.";
      await chrome.tabs.sendMessage(tabId, {
        type: "content.send",
        conversationId: CONVERSATION_ID,
        runId: SECOND_RUN_ID,
        prompt: followUpPrompt,
        expectedProjectScope: PROJECT_SCOPE,
        expectedRemoteUrl: REMOTE_B,
        allowFirstConversation: false,
      });
      await waitUntil(
        () =>
          contentEvents.some(
            (event) => event.eventType === "snapshot" && event.runId === SECOND_RUN_ID,
          ),
        6_000,
      );
      expect(
        contentEvents.find(
          (event) => event.eventType === "snapshot" && event.runId === SECOND_RUN_ID,
        ),
      ).toMatchObject({
        markdown: "Short answer completed on provisional A",
        remoteUrl: REMOTE_B,
      });
      await waitUntil(
        () =>
          contentEvents.some(
            (event) => event.eventType === "complete" && event.runId === SECOND_RUN_ID,
          ),
        5_000,
      );
      expect(page.submittedPrompts()).toEqual([
        "Explain the relay race.",
        "Explain the relay race.",
        followUpPrompt,
      ]);
      expect(
        contentEvents.filter(
          (event) => event.eventType === "error" && event.runId === SECOND_RUN_ID,
        ),
      ).toHaveLength(0);
    } finally {
      visibility.mockRestore();
      bridge.dispose();
    }
  }, 20_000);

  it("does not attribute an old assistant when lifecycle advances without a current user turn", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, {
      reuseAssistantFollowUp: "network-only",
    });
    const bridge = installRunLifecycleBridgeFixture();
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    let lifecycleDispatchCount = 0;
    requireElement<HTMLButtonElement>('[data-testid="send-button"]').addEventListener(
      "click",
      () => {
        lifecycleDispatchCount += 1;
        const runId = bridge.pendingRunId();
        if (!runId) return;
        bridge.emit(runId, "submitted");
        bridge.emit(runId, "response-started");
        scheduleFixtureTimeout(
          () => bridge.emit(runId, "response-complete"),
          lifecycleDispatchCount === 1 ? 50 : 650,
        );
      },
    );

    try {
      socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
      await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
        5_000,
      );
      await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "conversation.snapshot" &&
          (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_B,
        5_000,
      );

      const assistantBefore = requireElement<HTMLElement>('[data-message-author-role="assistant"]');
      socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_B));
      // A stale React subtree can still mutate (for example when old controls
      // settle) after the next request. Network lifecycle plus that mutation
      // must not make this pre-current-user assistant belong to the new run.
      assistantBefore.innerHTML = "<p>SENSITIVE_STALE_ASSISTANT_MUTATION</p>";
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(
        harness
          .outboundEnvelopes(socket)
          .some(
            (envelope) =>
              envelope.runId === SECOND_RUN_ID &&
              ["generation.snapshot", "generation.complete", "relay.error"].includes(envelope.type),
          ),
      ).toBe(false);
      expect(
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === SECOND_RUN_ID && run.phase === "active"),
      ).toBe(true);
      const assistantAfter = requireElement<HTMLElement>('[data-message-author-role="assistant"]');
      expect(assistantAfter).toBe(assistantBefore);
      expect(assistantAfter.textContent).toContain("SENSITIVE_STALE_ASSISTANT_MUTATION");
      expect(page.sendClicks()).toBe(2);
      expect(bridge.acceptedRunIds()).toEqual([FIRST_RUN_ID, SECOND_RUN_ID]);
    } finally {
      bridge.dispose();
    }
  }, 12_000);

  it("attributes the tagged new turn when ChatGPT reformats a rich user message", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, { autoCanonicalize: false });
    const bridge = installRunLifecycleBridgeFixture();
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    requireElement<HTMLButtonElement>('[data-testid="send-button"]').addEventListener(
      "click",
      () => {
        const runId = bridge.pendingRunId();
        if (!runId) return;
        bridge.emit(runId, "submitted");
        bridge.emit(runId, "response-started");
        // ChatGPT's rich-text renderer can remove code-context presentation
        // details after the composer has accepted the exact prompt. Structural
        // new-turn evidence plus this run's tagged network lifecycle must remain
        // sufficient; fuzzy text matching is deliberately not used.
        requireElement<HTMLElement>('[data-message-author-role="user"]').textContent =
          "Reformatted context presentation — Question: Explain the relay race.";
        scheduleFixtureTimeout(() => bridge.emit(runId, "response-complete"), 50);
      },
    );

    try {
      const runId = "run-reformatted-rich-prompt";
      socket.deliverFromHost(sendEnvelope(runId));
      const complete = await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "generation.complete" && envelope.runId === runId,
        5_000,
      );
      expect(complete.payload).toMatchObject({
        markdown: "Short answer completed on provisional A",
      });
      expect(runErrors(harness, socket, runId)).toHaveLength(0);
      expect(page.sendClicks()).toBe(1);
    } finally {
      bridge.dispose();
    }
  }, 10_000);

  it("uses the same run lifecycle for an identical regenerate response", async () => {
    const { harness, socket, tab } = await startHarness();
    installChatGptComposerFixture(harness, tab.id);
    const bridge = installRunLifecycleBridgeFixture();
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    requireElement<HTMLButtonElement>('[data-testid="send-button"]').addEventListener(
      "click",
      () => {
        const runId = bridge.pendingRunId();
        if (!runId) return;
        bridge.emit(runId, "submitted");
        bridge.emit(runId, "response-started");
        scheduleFixtureTimeout(() => bridge.emit(runId, "response-complete"), 50);
      },
    );

    try {
      socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
      await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
        5_000,
      );
      await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "conversation.snapshot" &&
          (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_B,
        5_000,
      );

      const assistant = requireElement<HTMLElement>('[data-message-author-role="assistant"]');
      const regenerate = document.createElement("button");
      regenerate.type = "button";
      regenerate.setAttribute("aria-label", "Regenerate response");
      assistant.parentElement?.append(regenerate);
      regenerate.addEventListener("click", () => {
        const runId = bridge.pendingRunId();
        if (!runId) return;
        bridge.emit(runId, "submitted");
        bridge.emit(runId, "response-started");
        scheduleFixtureTimeout(() => bridge.emit(runId, "response-complete"), 50);
      });

      const regenerateRunId = "run-regenerate-identical";
      const assistantBefore = assistant.outerHTML;
      socket.deliverFromHost(regenerateEnvelope(regenerateRunId, REMOTE_B));
      await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "generation.snapshot" && envelope.runId === regenerateRunId,
        2_000,
      );
      const terminalWaitStartedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(
        harness
          .outboundEnvelopes(socket)
          .some(
            (envelope) =>
              envelope.type === "generation.complete" && envelope.runId === regenerateRunId,
          ),
      ).toBe(false);
      const complete = await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "generation.complete" && envelope.runId === regenerateRunId,
        7_000,
      );

      expect(complete.payload).toMatchObject({
        markdown: "Short answer completed on provisional A",
        remoteUrl: REMOTE_B,
      });
      expect(assistant.outerHTML).toBe(assistantBefore);
      expect(Date.now() - terminalWaitStartedAt).toBeGreaterThanOrEqual(4_000);
      expect(bridge.acceptedRunIds()).toEqual([FIRST_RUN_ID, regenerateRunId]);
      expect(runErrors(harness, socket, regenerateRunId)).toHaveLength(0);
    } finally {
      bridge.dispose();
    }
  }, 16_000);

  it("completes from stable visible DOM when the cloned response stream stays open", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, { autoCanonicalize: false });
    const bridge = installRunLifecycleBridgeFixture();
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    requireElement<HTMLButtonElement>('[data-testid="send-button"]').addEventListener(
      "click",
      () => {
        const runId = bridge.pendingRunId();
        if (!runId) return;
        bridge.emit(runId, "submitted");
        bridge.emit(runId, "response-started");
        // ChatGPT can keep the cloned SSE response open after its visible DOM
        // has settled. DOM completion must not wait forever for this signal.
      },
    );

    try {
      socket.deliverFromHost(sendEnvelope("run-open-cloned-stream"));
      const complete = await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "generation.complete" && envelope.runId === "run-open-cloned-stream",
        4_000,
      );

      expect(complete.payload).toMatchObject({
        markdown: "Short answer completed on provisional A",
      });
      expect(runErrors(harness, socket, "run-open-cloned-stream")).toHaveLength(0);
      expect(page.sendClicks()).toBe(1);
    } finally {
      bridge.dispose();
    }
  }, 8_000);

  it("does not let a stale recovery checkpoint rewind a long streaming answer", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, {
      terminalMode: "streaming",
      autoCanonicalize: false,
    });
    let releaseRecovery!: () => void;
    let markRecoveryCaptured!: () => void;
    const recoveryCaptured = new Promise<void>((resolve) => {
      markRecoveryCaptured = resolve;
    });
    const recoveryRelease = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    let holdFirstRecovery = true;
    let capturedRecoveryMarkdown: string | undefined;
    harness.afterTabMessage = async (messageTabId, message, response) => {
      const recoveryMarkdown = (response as { markdown?: unknown } | undefined)?.markdown;
      if (
        !holdFirstRecovery ||
        messageTabId !== tab.id ||
        !isMessageType(message, "content.recover") ||
        typeof recoveryMarkdown !== "string" ||
        !recoveryMarkdown
      ) {
        return;
      }
      // The content observer has already returned its current markdown, but
      // the worker has not consumed that recovery response yet. Keep this old
      // checkpoint in flight while a newer DOM mutation is delivered through
      // the normal content.event path.
      holdFirstRecovery = false;
      capturedRecoveryMarkdown = recoveryMarkdown;
      markRecoveryCaptured();
      await recoveryRelease;
    };
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    const first = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.snapshot" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );
    const firstMarkdown = (first.payload as { markdown?: string }).markdown;
    expect(firstMarkdown).toBe("Partial answer on provisional A");
    await recoveryCaptured;
    expect(capturedRecoveryMarkdown).toBe(firstMarkdown);

    page.updatePrimaryAssistant("Long answer chunk two");
    await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "generation.snapshot" &&
        envelope.runId === FIRST_RUN_ID &&
        (envelope.payload as { markdown?: string }).markdown === "Long answer chunk two",
      5_000,
    );
    releaseRecovery();
    await waitUntil(() =>
      harness.timeline.includes(`tabs.sendMessage:response:${tab.id}:content.recover`),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));

    const snapshotsAfterRecovery = harness
      .outboundEnvelopes(socket)
      .filter(
        (envelope) => envelope.type === "generation.snapshot" && envelope.runId === FIRST_RUN_ID,
      )
      .map((envelope) => (envelope.payload as { markdown?: string }).markdown);
    const secondBeforeRecoveryIndex = snapshotsAfterRecovery.indexOf("Long answer chunk two");
    expect(secondBeforeRecoveryIndex).toBeGreaterThanOrEqual(0);
    expect(snapshotsAfterRecovery.slice(secondBeforeRecoveryIndex + 1)).not.toContain(
      firstMarkdown,
    );

    page.updatePrimaryAssistant("Long answer chunk three");
    await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "generation.snapshot" &&
        envelope.runId === FIRST_RUN_ID &&
        (envelope.payload as { markdown?: string }).markdown === "Long answer chunk three",
      5_000,
    );
    requireElement<HTMLButtonElement>('[data-testid="stop-button"]').outerHTML =
      '<button type="button" aria-label="Copy response">Copy</button>';
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );
    expect(complete.payload).toMatchObject({ markdown: "Long answer chunk three" });

    const snapshots = harness
      .outboundEnvelopes(socket)
      .filter(
        (envelope) => envelope.type === "generation.snapshot" && envelope.runId === FIRST_RUN_ID,
      )
      .map((envelope) => (envelope.payload as { markdown?: string }).markdown);
    const secondIndex = snapshots.indexOf("Long answer chunk two");
    const thirdIndex = snapshots.indexOf("Long answer chunk three");
    expect(secondIndex).toBeGreaterThanOrEqual(0);
    expect(thirdIndex).toBeGreaterThan(secondIndex);
    expect(snapshots.slice(secondIndex + 1)).not.toContain(firstMarkdown);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 15_000);

  it("completes a network-complete run while the ChatGPT document stays hidden", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, { autoCanonicalize: false });
    const bridge = installRunLifecycleBridgeFixture();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let terminalChurnTimer: number | undefined;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    requireElement<HTMLButtonElement>('[data-testid="send-button"]').addEventListener(
      "click",
      () => {
        const runId = bridge.pendingRunId();
        if (!runId) return;
        visibility.mockReturnValue("hidden");
        bridge.emit(runId, "submitted");
        bridge.emit(runId, "response-started");
        bridge.emit(runId, "response-complete");
      },
    );

    try {
      socket.deliverFromHost(sendEnvelope("run-hidden-network-complete"));
      await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "generation.snapshot" &&
          envelope.runId === "run-hidden-network-complete",
        3_000,
      );
      const assistantTurn = requireElement<HTMLElement>(
        '[data-testid="conversation-turn-primary-assistant"]',
      );
      terminalChurnTimer = window.setInterval(
        () => assistantTurn.classList.toggle("terminal-ui-churn"),
        75,
      );
      const complete = await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "generation.complete" &&
          envelope.runId === "run-hidden-network-complete",
        6_000,
      );
      expect(complete.payload).toMatchObject({
        markdown: "Short answer completed on provisional A",
      });
      expect(page.sendClicks()).toBe(1);

      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(
        harness
          .outboundEnvelopes(socket)
          .filter(
            (envelope) =>
              envelope.type === "generation.complete" &&
              envelope.runId === "run-hidden-network-complete",
          ),
      ).toHaveLength(1);
      expect(runErrors(harness, socket, "run-hidden-network-complete")).toHaveLength(0);
    } finally {
      if (terminalChurnTimer !== undefined) window.clearInterval(terminalChurnTimer);
      bridge.dispose();
    }
  }, 15_000);

  it("waits for a delayed visible DOM suffix after the exact response stream completes", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, { autoCanonicalize: false });
    const bridge = installRunLifecycleBridgeFixture();
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    requireElement<HTMLButtonElement>('[data-testid="send-button"]').addEventListener(
      "click",
      () => {
        const runId = bridge.pendingRunId();
        if (!runId) return;
        requireElement<HTMLButtonElement>('button[aria-label="Copy response"]').remove();
        bridge.emit(runId, "submitted");
        bridge.emit(runId, "response-started");
        bridge.emit(runId, "response-complete");
      },
    );

    try {
      const runId = "run-visible-delayed-suffix";
      socket.deliverFromHost(sendEnvelope(runId));
      await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "generation.snapshot" && envelope.runId === runId,
        3_000,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(
        harness
          .outboundEnvelopes(socket)
          .some((envelope) => envelope.type === "generation.complete" && envelope.runId === runId),
      ).toBe(false);

      const finalMarkdown = "Short answer completed on provisional A with a delayed DOM suffix";
      requireElement<HTMLElement>(
        '[data-testid="conversation-turn-primary-assistant"] [data-message-author-role="assistant"] p',
      ).textContent = finalMarkdown;
      await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "generation.snapshot" &&
          envelope.runId === runId &&
          (envelope.payload as { markdown?: string }).markdown === finalMarkdown,
        3_000,
      );
      const complete = await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "generation.complete" && envelope.runId === runId,
        7_000,
      );
      expect(complete.payload).toMatchObject({ markdown: finalMarkdown, remoteUrl: REMOTE_A });
      expect(page.sendClicks()).toBe(1);
      expect(runErrors(harness, socket, runId)).toHaveLength(0);
    } finally {
      bridge.dispose();
    }
  }, 14_000);

  it("keeps a hidden run active across exact status recoveries without terminal evidence", async () => {
    let frozenIntervals = 0;
    vi.spyOn(window, "setInterval").mockImplementation(
      () => (2_000_000_000 + frozenIntervals++) as unknown as ReturnType<typeof setInterval>,
    );
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, { autoCanonicalize: false });
    const bridge = installRunLifecycleBridgeFixture();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    requireElement<HTMLButtonElement>('[data-testid="send-button"]').addEventListener(
      "click",
      () => {
        const runId = bridge.pendingRunId();
        if (!runId) return;
        visibility.mockReturnValue("hidden");
        requireElement<HTMLButtonElement>('button[aria-label="Copy response"]').remove();
        bridge.emit(runId, "submitted");
        bridge.emit(runId, "response-started");
      },
    );

    try {
      const runId = "run-suspended-timer-recovery";
      socket.deliverFromHost(sendEnvelope(runId));
      await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "generation.snapshot" && envelope.runId === runId,
        3_000,
      );
      await waitUntil(() => location.href === REMOTE_A, 3_000);

      const frozenAt = Date.now();
      const now = vi.spyOn(Date, "now").mockReturnValue(frozenAt);
      let frozenInspectTimeouts = 0;
      const timeout = vi
        .spyOn(window, "setTimeout")
        .mockImplementation(
          () =>
            (2_100_000_000 + frozenInspectTimeouts++) as unknown as ReturnType<typeof setTimeout>,
        );
      requireElement<HTMLElement>(
        '[data-testid="conversation-turn-primary-assistant"]',
      ).classList.toggle("suspended-page-churn");
      await Promise.resolve();
      await Promise.resolve();
      expect(frozenInspectTimeouts).toBeGreaterThan(0);
      timeout.mockRestore();
      now.mockReturnValue(frozenAt + 31_000);

      await expect(
        chrome.tabs.sendMessage(tab.id, {
          type: "content.recover",
          conversationId: CONVERSATION_ID,
          runId: "stale-run-id",
          startedAt: new Date().toISOString(),
        }),
      ).resolves.toMatchObject({
        ok: true,
        active: false,
        recoveryTurnMatched: false,
        markdown: "",
      });
      const recoveriesBeforeStatus = harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.recover`,
      ).length;

      const firstStatusCount = harness
        .outboundEnvelopes(socket)
        .filter((envelope) => envelope.type === "relay.status").length;
      socket.deliverFromHost(
        makeEnvelope({
          type: "relay.status.request",
          instanceId: INSTANCE_ID,
          payload: makeRelayStatusRequestPayload(),
        }),
      );
      await waitUntil(
        () =>
          harness.outboundEnvelopes(socket).filter((envelope) => envelope.type === "relay.status")
            .length > firstStatusCount,
      );
      expect(
        harness
          .outboundEnvelopes(socket)
          .filter(
            (envelope) => envelope.type === "generation.complete" && envelope.runId === runId,
          ),
      ).toHaveLength(0);

      const beforeSecondStatus = harness.outboundEnvelopes(socket).length;
      socket.deliverFromHost(
        makeEnvelope({
          type: "relay.status.request",
          instanceId: INSTANCE_ID,
          payload: makeRelayStatusRequestPayload(),
        }),
      );
      await waitUntil(() =>
        harness
          .outboundEnvelopes(socket)
          .slice(beforeSecondStatus)
          .some((envelope) => envelope.type === "relay.status"),
      );

      const outbound = harness.outboundEnvelopes(socket);
      expect(
        outbound.some(
          (envelope) => envelope.type === "generation.complete" && envelope.runId === runId,
        ),
      ).toBe(false);
      expect(
        [...outbound].reverse().find((envelope) => envelope.type === "relay.status")?.payload,
      ).toMatchObject({ activeRuns: 1 });
      expect(
        harness.timeline.filter(
          (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.recover`,
        ),
      ).toHaveLength(recoveriesBeforeStatus + 2);
      expect(
        harness.timeline.filter(
          (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
        ),
      ).toHaveLength(1);
      expect(page.sendClicks()).toBe(1);
      expect(
        (harness.sessionValue("activeRunsV2") as Array<{ runId?: string }> | undefined)?.some(
          (run) => run.runId === runId,
        ),
      ).toBe(true);
      expect(runErrors(harness, socket, runId)).toHaveLength(0);
    } finally {
      bridge.dispose();
    }
  }, 10_000);

  it("attests complete history after a hidden terminal even when response actions stay deferred", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, { autoCanonicalize: false });
    const bridge = installRunLifecycleBridgeFixture();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let dispatchedRunId: string | undefined;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    requireElement<HTMLButtonElement>('[data-testid="send-button"]').addEventListener(
      "click",
      () => {
        dispatchedRunId = bridge.pendingRunId();
        if (!dispatchedRunId) return;
        visibility.mockReturnValue("hidden");
        requireElement<HTMLButtonElement>('button[aria-label="Copy response"]').remove();
        bridge.emit(dispatchedRunId, "submitted");
        bridge.emit(dispatchedRunId, "response-started");
      },
    );
    harness.beforeTabReload = (tabId) => {
      expect(tabId).toBe(tab.id);
      requireElement<HTMLElement>(
        '[data-testid="conversation-turn-primary-assistant"]',
      ).insertAdjacentHTML(
        "beforeend",
        '<button type="button" aria-label="Copy response">Copy</button>',
      );
    };

    try {
      socket.deliverFromHost(sendEnvelope("run-hidden-history-terminal"));
      await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "generation.snapshot" &&
          envelope.runId === "run-hidden-history-terminal",
        3_000,
      );

      await expect(
        chrome.tabs.sendMessage(tab.id, { type: "content.inspectConversation" }),
      ).resolves.toMatchObject({
        ok: true,
        complete: false,
        historyComplete: true,
        remoteUrl: REMOTE_A,
      });

      expect(dispatchedRunId).toBe("run-hidden-history-terminal");
      bridge.emit(dispatchedRunId!, "response-complete");
      const complete = await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "generation.complete" &&
          envelope.runId === "run-hidden-history-terminal",
        10_000,
      );
      expect(complete.payload).toMatchObject({
        markdown: "Short answer completed on provisional A",
        remoteUrl: REMOTE_A,
      });
      expect(complete.payload).toHaveProperty("terminalTranscriptSha256");

      const history = await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "conversation.snapshot" &&
          envelope.conversationId === CONVERSATION_ID &&
          (envelope.payload as { complete?: boolean }).complete === true,
        5_000,
      );
      expect(history.payload).toMatchObject({
        complete: true,
        remoteUrl: REMOTE_A,
        messages: [
          { role: "user", markdown: "Explain the relay race." },
          { role: "assistant", markdown: "Short answer completed on provisional A" },
        ],
      });
      expect(history.payload).not.toHaveProperty("historyComplete");
      expect(harness.timeline.filter((entry) => entry === `tabs.reload:${tab.id}`)).toHaveLength(1);
      expect(page.sendClicks()).toBe(1);

      socket.deliverFromHost(
        makeEnvelope({
          type: "conversation.open",
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          payload: { remoteUrl: REMOTE_A, active: false },
        }),
      );
      await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "conversation.snapshot" &&
          envelope.conversationId === CONVERSATION_ID &&
          (envelope.payload as { complete?: boolean }).complete === true,
        5_000,
      );

      requireElement<HTMLButtonElement>('button[aria-label="Copy response"]').remove();
      requireElement<HTMLElement>('[data-message-author-role="assistant"]').textContent =
        "A different answer";
      socket.deliverFromHost(
        makeEnvelope({
          type: "conversation.open",
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          payload: { remoteUrl: REMOTE_A, active: false },
        }),
      );
      const changedHistory = await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "conversation.snapshot" &&
          envelope.conversationId === CONVERSATION_ID &&
          (envelope.payload as { messages?: Array<{ markdown?: string }> }).messages?.at(-1)
            ?.markdown === "A different answer",
        5_000,
      );
      expect(changedHistory.payload).toMatchObject({ complete: false, remoteUrl: REMOTE_A });
      expect(page.sendClicks()).toBe(1);
      expect(
        harness.timeline.filter(
          (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
        ),
      ).toHaveLength(1);
      expect(runErrors(harness, socket, "run-hidden-history-terminal")).toHaveLength(0);
    } finally {
      bridge.dispose();
    }
  }, 20_000);

  it("publishes a fully hydrated hidden terminal after the initial grant inspection was partial", async () => {
    const { harness, socket, tab } = await startHarness();
    await harness.importContentScript(tab.id, async () => undefined);
    const terminalMarkdown = "Hydrated hidden terminal";
    const terminalMessages = [
      { role: "user" as const, markdown: "Explain the relay race." },
      { role: "assistant" as const, markdown: terminalMarkdown },
    ];
    let terminalInspectionStarted = false;
    let terminalInspectCount = 0;
    let documentHidden = false;

    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: harness.tabsById.get(tab.id)?.url,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.composerStatus")) {
        return {
          ok: true,
          ready: true,
          rawCandidateCount: 1,
          readyCandidateCount: 1,
          visibilityState: documentHidden ? "hidden" : "visible",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        if (!terminalInspectionStarted) {
          return {
            ok: true,
            remoteUrl: harness.tabsById.get(tab.id)?.url,
            complete: true,
            historyComplete: true,
            messages: [],
            observedAt: new Date().toISOString(),
            selectorVersion: CONTENT_RUNTIME_REVISION,
          };
        }
        terminalInspectCount += 1;
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          complete: false,
          historyComplete: terminalInspectCount > 1,
          messages: terminalMessages,
          observedAt: new Date(Date.now() + terminalInspectCount).toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        documentHidden = true;
        return {
          ok: true,
          pageUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });
    await waitUntil(() =>
      harness.timeline.includes(`tabs.sendMessage:response:${tab.id}:content.inspectConversation`),
    );
    harness.setPrimaryDocumentUrl(REMOTE_A);
    harness.setTabUrl(tab.id, REMOTE_A);

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID, REMOTE_A));
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
    );

    terminalInspectionStarted = true;
    const terminalResult = chrome.runtime.sendMessage({
      type: "content.event",
      eventType: "complete",
      conversationId: CONVERSATION_ID,
      runId: FIRST_RUN_ID,
      markdown: terminalMarkdown,
      remoteUrl: REMOTE_A,
    });
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
    );
    await expect(terminalResult).resolves.toEqual({ ok: true });

    await waitUntil(() => terminalInspectCount >= 2);
    await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.snapshot" &&
        envelope.conversationId === CONVERSATION_ID &&
        (envelope.payload as { complete?: boolean }).complete === true &&
        (envelope.payload as { messages?: typeof terminalMessages }).messages?.at(-1)?.markdown ===
          terminalMarkdown,
      5_000,
    );

    const terminalHistories = harness
      .outboundEnvelopes(socket)
      .filter(
        (envelope) =>
          envelope.type === "conversation.snapshot" &&
          envelope.conversationId === CONVERSATION_ID &&
          (envelope.payload as { messages?: typeof terminalMessages }).messages?.at(-1)
            ?.markdown === terminalMarkdown,
      );
    expect(terminalInspectCount).toBeGreaterThanOrEqual(2);
    expect(terminalHistories.length).toBeGreaterThan(0);
    expect(
      terminalHistories.every(
        (envelope) => (envelope.payload as { complete?: boolean }).complete === true,
      ),
    ).toBe(true);
    expect(terminalHistories.at(-1)?.payload).toMatchObject({
      complete: true,
      remoteUrl: REMOTE_A,
      messages: terminalMessages,
    });
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 15_000);

  it("completes from the owned cached snapshot when a hidden tab virtualizes the assistant", async () => {
    const { harness, socket, tab } = await startHarness();
    installChatGptComposerFixture(harness, tab.id, { autoCanonicalize: false });
    const bridge = installRunLifecycleBridgeFixture();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let dispatchedRunId: string | undefined;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    requireElement<HTMLButtonElement>('[data-testid="send-button"]').addEventListener(
      "click",
      () => {
        dispatchedRunId = bridge.pendingRunId();
        if (!dispatchedRunId) return;
        visibility.mockReturnValue("hidden");
        bridge.emit(dispatchedRunId, "submitted");
        bridge.emit(dispatchedRunId, "response-started");
      },
    );

    try {
      socket.deliverFromHost(sendEnvelope("run-hidden-virtualized-assistant"));
      const snapshot = await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "generation.snapshot" &&
          envelope.runId === "run-hidden-virtualized-assistant",
        3_000,
      );
      expect(snapshot.payload).toMatchObject({
        markdown: "Short answer completed on provisional A",
      });
      requireElement<HTMLElement>('[data-testid="conversation-turn-primary-assistant"]').remove();
      expect(dispatchedRunId).toBe("run-hidden-virtualized-assistant");
      bridge.emit(dispatchedRunId!, "response-complete");

      const complete = await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "generation.complete" &&
          envelope.runId === "run-hidden-virtualized-assistant",
        6_000,
      );
      expect(complete.payload).toMatchObject({
        markdown: "Short answer completed on provisional A",
      });
      expect(runErrors(harness, socket, "run-hidden-virtualized-assistant")).toHaveLength(0);
    } finally {
      bridge.dispose();
    }
  }, 12_000);

  it("accepts terminal response controls as complete history while the tab is hidden", async () => {
    const { harness, tab } = await startHarness();
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    harness.setTabUrl(tab.id, REMOTE_A);
    harness.setPrimaryDocumentUrl(REMOTE_A);
    document.body.innerHTML = primaryConversationMarkup(
      "complete",
      true,
      "Explain the relay race.",
    );
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const backgroundCopy = requireElement<HTMLButtonElement>('button[aria-label="Copy response"]');
    backgroundCopy.dataset.testid = "copy-turn-action-button";
    backgroundCopy.style.pointerEvents = "none";

    await expect(
      chrome.tabs.sendMessage(tab.id, { type: "content.inspectConversation" }),
    ).resolves.toMatchObject({
      ok: true,
      complete: true,
      historyComplete: true,
      remoteUrl: REMOTE_A,
    });

    visibility.mockReturnValue("visible");
    await expect(
      chrome.tabs.sendMessage(tab.id, { type: "content.inspectConversation" }),
    ).resolves.toMatchObject({ ok: true, complete: true, remoteUrl: REMOTE_A });

    document.body.innerHTML = primaryConversationMarkup(
      "streaming",
      true,
      "Explain the relay race.",
    );
    const streamingStop = requireElement<HTMLButtonElement>('[data-testid="stop-button"]');
    streamingStop.style.pointerEvents = "none";
    streamingStop.insertAdjacentHTML(
      "afterend",
      '<button type="button" data-testid="copy-turn-action-button" aria-label="Copy response" style="pointer-events: none">Copy</button>',
    );
    visibility.mockReturnValue("hidden");
    await expect(
      chrome.tabs.sendMessage(tab.id, { type: "content.inspectConversation" }),
    ).resolves.toMatchObject({ ok: true, complete: false, remoteUrl: REMOTE_A });

    document.body.innerHTML = primaryConversationMarkup(
      "complete",
      true,
      "Explain the relay race.",
    );
    requireElement<HTMLButtonElement>('button[aria-label="Copy response"]').outerHTML =
      '<div aria-hidden="true"><button type="button" data-testid="copy-turn-action-button" aria-label="Copy response" style="pointer-events: none">Copy</button></div>';
    await expect(
      chrome.tabs.sendMessage(tab.id, { type: "content.inspectConversation" }),
    ).resolves.toMatchObject({
      ok: true,
      complete: false,
      historyComplete: true,
      remoteUrl: REMOTE_A,
    });
  });

  it("completes one hidden owned run from a pointer-disabled terminal action", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, { autoCanonicalize: false });
    const bridge = installRunLifecycleBridgeFixture();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    requireElement<HTMLButtonElement>('[data-testid="send-button"]').addEventListener(
      "click",
      () => {
        const runId = bridge.pendingRunId();
        if (!runId) return;
        visibility.mockReturnValue("hidden");
        const copy = requireElement<HTMLButtonElement>('button[aria-label="Copy response"]');
        copy.dataset.testid = "copy-turn-action-button";
        copy.style.pointerEvents = "none";
        bridge.emit(runId, "submitted");
        bridge.emit(runId, "response-started");
      },
    );

    try {
      const runId = "run-hidden-pointer-disabled-terminal";
      socket.deliverFromHost(sendEnvelope(runId));
      await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "generation.snapshot" && envelope.runId === runId,
        3_000,
      );
      const complete = await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "generation.complete" && envelope.runId === runId,
        6_000,
      );

      expect(complete.payload).toMatchObject({
        markdown: "Short answer completed on provisional A",
        remoteUrl: REMOTE_A,
      });
      expect(
        harness
          .outboundEnvelopes(socket)
          .filter(
            (envelope) => envelope.type === "generation.complete" && envelope.runId === runId,
          ),
      ).toHaveLength(1);
      expect(page.sendClicks()).toBe(1);
      expect(runErrors(harness, socket, runId)).toHaveLength(0);
      await waitUntil(
        () =>
          !(harness.sessionValue("activeRunsV2") as Array<{ runId?: string }> | undefined)?.some(
            (run) => run.runId === runId,
          ),
      );
    } finally {
      bridge.dispose();
    }
  }, 10_000);

  it("terminates the owned run when the page bridge reports a response error", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, {
      autoCanonicalize: false,
      terminalMode: "streaming",
    });
    const bridge = installRunLifecycleBridgeFixture();
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    requireElement<HTMLButtonElement>('[data-testid="send-button"]').addEventListener(
      "click",
      () => {
        const runId = bridge.pendingRunId();
        if (!runId) return;
        // Keep this regression focused on an empty failed turn. A separate
        // test below covers the case where answer text was already observed.
        requireElement<HTMLElement>('[data-message-author-role="assistant"]').textContent = "";
        bridge.emit(runId, "submitted");
        bridge.emit(runId, "response-error");
      },
    );

    try {
      socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
      const error = await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "relay.error" &&
          envelope.runId === FIRST_RUN_ID &&
          (envelope.payload as { code?: string }).code === "CHATGPT_REMOTE_UNAVAILABLE",
        5_000,
      );
      expect(error.payload).toMatchObject({ code: "CHATGPT_REMOTE_UNAVAILABLE" });
      expect((error.payload as { message?: string }).message).toContain("未自动重试");
      expect(page.sendClicks()).toBe(1);
      expect(
        harness
          .outboundEnvelopes(socket)
          .some(
            (envelope) =>
              envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
          ),
      ).toBe(false);
    } finally {
      bridge.dispose();
    }
  }, 8_000);

  it("recovers a late cloned-stream error after hidden answer text without a tail failure", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, { autoCanonicalize: false });
    const bridge = installRunLifecycleBridgeFixture();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let dispatchedRunId: string | undefined;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    requireElement<HTMLButtonElement>('[data-testid="send-button"]').addEventListener(
      "click",
      () => {
        dispatchedRunId = bridge.pendingRunId();
        if (!dispatchedRunId) return;
        visibility.mockReturnValue("hidden");
        requireElement<HTMLButtonElement>('button[aria-label="Copy response"]').remove();
        bridge.emit(dispatchedRunId, "submitted");
        bridge.emit(dispatchedRunId, "response-started");
      },
    );

    try {
      const runId = "run-hidden-late-stream-error";
      socket.deliverFromHost(sendEnvelope(runId));
      const snapshot = await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "generation.snapshot" && envelope.runId === runId,
        4_000,
      );
      expect(snapshot.payload).toMatchObject({
        markdown: "Short answer completed on provisional A",
      });
      expect(dispatchedRunId).toBe(runId);

      bridge.emit(runId, "response-error", { failureKind: "stream" });
      await waitUntil(() =>
        harness.timeline.some((entry) =>
          entry.startsWith("runtime.message:content.recovery.request:"),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(runErrors(harness, socket, runId)).toHaveLength(0);
      expect(
        harness.timeline.filter(
          (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
        ),
      ).toHaveLength(1);

      visibility.mockReturnValue("visible");
      requireElement<HTMLElement>(
        '[data-testid="conversation-turn-primary-assistant"]',
      ).insertAdjacentHTML(
        "beforeend",
        '<button type="button" aria-label="Copy response">Copy</button>',
      );
      const complete = await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "generation.complete" && envelope.runId === runId,
        5_000,
      );
      expect(complete.payload).toMatchObject({
        markdown: "Short answer completed on provisional A",
      });
      expect(runErrors(harness, socket, runId)).toHaveLength(0);
      expect(page.sendClicks()).toBe(1);
    } finally {
      bridge.dispose();
      visibility.mockRestore();
    }
  }, 10_000);

  it("recovers a late network observer error after hidden answer text", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, { autoCanonicalize: false });
    const bridge = installRunLifecycleBridgeFixture();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let dispatchedRunId: string | undefined;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    requireElement<HTMLButtonElement>('[data-testid="send-button"]').addEventListener(
      "click",
      () => {
        dispatchedRunId = bridge.pendingRunId();
        if (!dispatchedRunId) return;
        visibility.mockReturnValue("hidden");
        requireElement<HTMLButtonElement>('button[aria-label="Copy response"]').remove();
        bridge.emit(dispatchedRunId, "submitted");
        bridge.emit(dispatchedRunId, "response-started");
      },
    );

    try {
      const runId = "run-hidden-late-network-error";
      socket.deliverFromHost(sendEnvelope(runId));
      const snapshot = await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "generation.snapshot" && envelope.runId === runId,
        4_000,
      );
      expect(snapshot.payload).toMatchObject({
        markdown: "Short answer completed on provisional A",
      });
      expect(dispatchedRunId).toBe(runId);

      bridge.emit(runId, "response-error", { failureKind: "network" });
      await waitUntil(() =>
        harness.timeline.some((entry) =>
          entry.startsWith("runtime.message:content.recovery.request:"),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(runErrors(harness, socket, runId)).toHaveLength(0);
      expect(
        harness.timeline.filter(
          (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
        ),
      ).toHaveLength(1);

      visibility.mockReturnValue("visible");
      requireElement<HTMLElement>(
        '[data-testid="conversation-turn-primary-assistant"]',
      ).insertAdjacentHTML(
        "beforeend",
        '<button type="button" aria-label="Copy response">Copy</button>',
      );
      const complete = await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "generation.complete" && envelope.runId === runId,
        5_000,
      );
      expect(complete.payload).toMatchObject({
        markdown: "Short answer completed on provisional A",
      });
      expect(runErrors(harness, socket, runId)).toHaveLength(0);
      expect(page.sendClicks()).toBe(1);
    } finally {
      bridge.dispose();
      visibility.mockRestore();
    }
  }, 10_000);

  it("surfaces a privacy-safe actionable error immediately for an HTTP 429 response", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, { autoCanonicalize: false });
    const bridge = installRunLifecycleBridgeFixture();
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    requireElement<HTMLButtonElement>('[data-testid="send-button"]').addEventListener(
      "click",
      () => {
        const runId = bridge.pendingRunId();
        if (!runId) return;
        bridge.emit(runId, "submitted");
        bridge.emit(runId, "response-error", { failureKind: "http", httpStatus: 429 });
      },
    );

    try {
      socket.deliverFromHost(sendEnvelope("run-http-429"));
      const error = await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "relay.error" &&
          envelope.runId === "run-http-429" &&
          (envelope.payload as { code?: string }).code === "CHATGPT_REMOTE_UNAVAILABLE",
        2_000,
      );
      expect(error.payload).toMatchObject({ code: "CHATGPT_REMOTE_UNAVAILABLE" });
      const message = (error.payload as { message?: string }).message ?? "";
      expect(message).toContain("HTTP 429");
      expect(message).toContain("稍后重试");
      expect(message).toContain("未自动重试");
      expect(message).not.toContain("private prompt");
      expect(page.sendClicks()).toBe(1);
    } finally {
      bridge.dispose();
    }
  }, 6_000);

  it("reports a visible current-turn ChatGPT generation error without copying page text", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, {
      autoCanonicalize: false,
      terminalMode: "visible-error",
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope("run-visible-error"));
    const error = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "relay.error" &&
        envelope.runId === "run-visible-error" &&
        (envelope.payload as { code?: string }).code === "CHATGPT_REMOTE_UNAVAILABLE",
      2_000,
    );

    const message = (error.payload as { message?: string }).message ?? "";
    expect(message).toContain("本轮回答生成失败");
    expect(message).toContain("未自动重试");
    expect(message).not.toContain("SENSITIVE_REMOTE_ERROR_TEXT");
    expect(message).not.toContain("Explain the relay race.");
    expect(page.sendClicks()).toBe(1);
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) =>
            envelope.type === "generation.complete" && envelope.runId === "run-visible-error",
        ),
    ).toBe(false);
  }, 6_000);

  it("ignores a benign current-turn live-region alert while the answer starts", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, {
      autoCanonicalize: false,
      submissionDelayMs: 150,
    });
    const send = requireElement<HTMLButtonElement>('[data-testid="send-button"]');
    send.addEventListener(
      "click",
      () => {
        scheduleFixtureTimeout(() => {
          const prompt = requireElement<HTMLTextAreaElement>("#prompt-textarea").value;
          requireElement<HTMLElement>("#thread").innerHTML = `
            <article data-testid="conversation-turn-pending-user">
              <div data-message-author-role="user">${escapeFixtureHtml(prompt)}</div>
            </article>
            <div role="alert">Generating response…</div>`;
        }, 20);
      },
      { capture: true },
    );
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope("run-benign-live-region"));
    await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "generation.complete" && envelope.runId === "run-benign-live-region",
      4_000,
    );

    expect(runErrors(harness, socket, "run-benign-live-region")).toHaveLength(0);
    expect(page.sendClicks()).toBe(1);
  }, 8_000);

  it("ignores an older assistant Retry control during the next completed turn", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, { autoCanonicalize: false });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      3_000,
    );
    const oldAssistant = requireElement<HTMLElement>(
      '[data-testid="conversation-turn-primary-assistant"]',
    );
    oldAssistant.insertAdjacentHTML(
      "beforeend",
      '<button type="button" data-testid="retry-button">Retry old answer</button>',
    );

    socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_A));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
      3_000,
    );
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
    expect(page.sendClicks()).toBe(2);
  }, 10_000);

  it("completes an attributed stable follow-up without Stop, Send, or response actions", async () => {
    const { harness, socket, tab } = await startHarness();
    installChatGptComposerFixture(harness, tab.id, {
      virtualizeFollowUp: true,
      noFollowUpActions: true,
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );
    await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.snapshot" &&
        (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_B,
      5_000,
    );

    socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_B));
    const snapshot = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.snapshot" && envelope.runId === SECOND_RUN_ID,
      5_000,
    );
    expect(snapshot.payload).toMatchObject({
      markdown: "Short answer completed on provisional A",
      remoteUrl: REMOTE_B,
    });
    expect(requireElement<HTMLButtonElement>('[data-testid="send-button"]').disabled).toBe(true);
    expect(document.querySelector('[data-testid="stop-button"]')).toBeNull();
    expect(document.querySelector('[data-testid="conversation-turn-follow-up"] button')).toBeNull();

    const completedAt = Date.now();
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
      6_000,
    );
    expect(Date.now() - completedAt).toBeGreaterThanOrEqual(2_000);
    expect(complete.payload).toMatchObject({
      markdown: "Short answer completed on provisional A",
      remoteUrl: REMOTE_B,
    });
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
  }, 12_000);

  it("restarts hidden completion stability when late answer text arrives after twelve seconds", async () => {
    const { harness, socket, tab } = await startHarness();
    installChatGptComposerFixture(harness, tab.id, {
      virtualizeFollowUp: true,
      noFollowUpActions: true,
    });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let dispatchCount = 0;
    let terminalChurnTimer: number | undefined;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    requireElement<HTMLButtonElement>('[data-testid="send-button"]').addEventListener(
      "click",
      () => {
        dispatchCount += 1;
        if (dispatchCount === 2) visibility.mockReturnValue("hidden");
      },
    );

    try {
      socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
      await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
        5_000,
      );
      await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "conversation.snapshot" &&
          (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_B,
        5_000,
      );

      socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_B));
      const snapshot = await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "generation.snapshot" && envelope.runId === SECOND_RUN_ID,
        5_000,
      );
      expect(snapshot.payload).toMatchObject({
        markdown: "Short answer completed on provisional A",
        remoteUrl: REMOTE_B,
      });
      expect(document.querySelector('[data-testid="stop-button"]')).toBeNull();
      expect(
        document.querySelector('[data-testid="conversation-turn-follow-up"] button'),
      ).toBeNull();

      const assistantTurn = requireElement<HTMLElement>(
        '[data-testid="conversation-turn-follow-up"]',
      );
      terminalChurnTimer = window.setInterval(
        () => assistantTurn.classList.toggle("terminal-ui-churn"),
        75,
      );

      await new Promise((resolve) => setTimeout(resolve, 12_000));
      expect(
        harness
          .outboundEnvelopes(socket)
          .some(
            (envelope) =>
              envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
          ),
      ).toBe(false);

      const lateMarkdown = "Short answer completed on provisional A with a late suffix";
      requireElement<HTMLElement>(
        '[data-testid="conversation-turn-follow-up"] [data-message-author-role="assistant"] p',
      ).textContent = lateMarkdown;
      const lateSnapshot = await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "generation.snapshot" &&
          envelope.runId === SECOND_RUN_ID &&
          (envelope.payload as { markdown?: string }).markdown === lateMarkdown,
        5_000,
      );
      expect(lateSnapshot.payload).toMatchObject({
        markdown: lateMarkdown,
        remoteUrl: REMOTE_B,
      });

      await new Promise((resolve) => setTimeout(resolve, 20_000));
      expect(
        harness
          .outboundEnvelopes(socket)
          .some(
            (envelope) =>
              envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
          ),
      ).toBe(false);

      visibility.mockReturnValue("visible");
      assistantTurn.insertAdjacentHTML(
        "beforeend",
        '<button type="button" aria-label="Copy response">Copy</button>',
      );
      const complete = await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
        15_000,
      );
      expect(complete.payload).toMatchObject({
        markdown: lateMarkdown,
        remoteUrl: REMOTE_B,
      });
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(
        harness
          .outboundEnvelopes(socket)
          .filter(
            (envelope) =>
              envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
          ),
      ).toHaveLength(1);
      expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
    } finally {
      if (terminalChurnTimer !== undefined) window.clearInterval(terminalChurnTimer);
      visibility.mockRestore();
    }
  }, 60_000);

  it("bounds hidden completion when the page bridge response stream never closes", async () => {
    const { harness, socket, tab } = await startHarness();
    installChatGptComposerFixture(harness, tab.id, {
      virtualizeFollowUp: true,
      noFollowUpActions: true,
    });
    const bridge = installRunLifecycleBridgeFixture();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let lifecycleDispatchCount = 0;
    let terminalChurnTimer: number | undefined;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    requireElement<HTMLButtonElement>('[data-testid="send-button"]').addEventListener(
      "click",
      () => {
        lifecycleDispatchCount += 1;
        const runId = bridge.pendingRunId();
        if (!runId) return;
        if (lifecycleDispatchCount === 2) visibility.mockReturnValue("hidden");
        bridge.emit(runId, "submitted");
        bridge.emit(runId, "response-started");
        if (lifecycleDispatchCount === 1) bridge.emit(runId, "response-complete");
      },
    );

    try {
      socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
      await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
        5_000,
      );
      await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "conversation.snapshot" &&
          (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_B,
        5_000,
      );

      socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_B));
      await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "generation.snapshot" && envelope.runId === SECOND_RUN_ID,
        5_000,
      );
      const assistantTurn = requireElement<HTMLElement>(
        '[data-testid="conversation-turn-follow-up"]',
      );
      terminalChurnTimer = window.setInterval(
        () => assistantTurn.classList.toggle("terminal-ui-churn"),
        75,
      );

      await new Promise((resolve) => setTimeout(resolve, 20_000));
      expect(
        harness
          .outboundEnvelopes(socket)
          .some(
            (envelope) =>
              envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
          ),
      ).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 12_000));
      expect(
        harness
          .outboundEnvelopes(socket)
          .some(
            (envelope) =>
              envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
          ),
      ).toBe(false);
      expect(
        harness.timeline.some((entry) =>
          entry.includes("runtime.message:content.recovery.request:"),
        ),
      ).toBe(true);

      const finalMarkdown = "Short answer completed on provisional A with a late suffix";
      requireElement<HTMLElement>(
        '[data-testid="conversation-turn-follow-up"] [data-message-author-role="assistant"] p',
      ).textContent = finalMarkdown;
      visibility.mockReturnValue("visible");
      bridge.emit(SECOND_RUN_ID, "response-complete");
      const complete = await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
        8_000,
      );
      expect(complete.payload).toMatchObject({
        markdown: finalMarkdown,
        remoteUrl: REMOTE_B,
      });
      expect(lifecycleDispatchCount).toBe(2);
      expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
    } finally {
      if (terminalChurnTimer !== undefined) window.clearInterval(terminalChurnTimer);
      visibility.mockRestore();
      bridge.dispose();
    }
  }, 65_000);

  it("ignores a hidden stale busy marker when finalizing an attributed answer", async () => {
    const { harness, socket, tab } = await startHarness();
    installChatGptComposerFixture(harness, tab.id, {
      virtualizeFollowUp: true,
      noFollowUpActions: true,
      followUpBusy: true,
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );
    await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.snapshot" &&
        (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_B,
      5_000,
    );

    socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_B));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.snapshot" && envelope.runId === SECOND_RUN_ID,
      5_000,
    );
    expect(getComputedStyle(requireElement<HTMLElement>('[data-streaming="true"]')).display).toBe(
      "none",
    );
    const completedAt = Date.now();
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
      6_000,
    );
    expect(Date.now() - completedAt).toBeGreaterThanOrEqual(2_000);
    expect(complete.payload).toMatchObject({
      markdown: "Short answer completed on provisional A",
      remoteUrl: REMOTE_B,
    });
  }, 15_000);

  it("does not complete when Stop disappears for one sample during a long pause", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, {
      virtualizeFollowUp: true,
      followUpStreaming: true,
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );
    await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.snapshot" &&
        (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_B,
      5_000,
    );

    socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_B));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.snapshot" && envelope.runId === SECOND_RUN_ID,
      5_000,
    );
    await page.flickerFollowUpStop();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
        ),
    ).toBe(false);

    page.finishFollowUpStreaming();
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
      5_000,
    );
    expect(complete.payload).toMatchObject({
      markdown: "Short answer completed on provisional A",
      remoteUrl: REMOTE_B,
    });
  }, 12_000);

  it("does not borrow an old turn's Copy action to complete the current answer", async () => {
    const { harness, socket, tab } = await startHarness();
    installChatGptComposerFixture(harness, tab.id, { noFollowUpActions: true });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );
    await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.snapshot" &&
        (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_B,
      5_000,
    );

    socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_B));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.snapshot" && envelope.runId === SECOND_RUN_ID,
      5_000,
    );
    expect(
      document.querySelector('[data-testid="conversation-turn-primary-assistant"] button'),
    ).not.toBeNull();
    expect(document.querySelector('[data-testid="conversation-turn-follow-up"] button')).toBeNull();
    expect(requireElement<HTMLButtonElement>('[data-testid="send-button"]').disabled).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
        ),
    ).toBe(false);

    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
      5_000,
    );
  }, 12_000);

  it("excludes hidden transcript clones from ownership, recovery, and history hashes", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, {
      terminalMode: "streaming",
      autoCanonicalize: false,
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.snapshot" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );
    requireElement<HTMLElement>("#thread").insertAdjacentHTML(
      "beforeend",
      `<section aria-hidden="true" style="display:none">
         <article data-message-author-role="user">Hidden duplicate prompt</article>
         <article data-message-author-role="assistant">
           <p>HIDDEN_DUPLICATE_ANSWER</p>
           <button type="button" aria-label="Copy response">Copy</button>
         </article>
       </section>`,
    );

    const recovered: unknown = await chrome.tabs.sendMessage(tab.id, {
      type: "content.recover",
      conversationId: CONVERSATION_ID,
      runId: FIRST_RUN_ID,
      startedAt: new Date().toISOString(),
      expectedPromptSha256: FIRST_PROMPT_SHA256,
    });
    expect(recovered).toMatchObject({
      ok: true,
      active: true,
      matchedActiveRun: true,
      markdown: "Partial answer on provisional A",
      runLifecycle: { assistantAfterUser: true, responseActionsPresent: false },
    });
    const inspected: unknown = await chrome.tabs.sendMessage(tab.id, {
      type: "content.inspectConversation",
    });
    expect(inspected).toMatchObject({
      ok: true,
      messages: [
        { role: "user", markdown: "Explain the relay race." },
        { role: "assistant", markdown: "Partial answer on provisional A" },
      ],
    });
    expect(JSON.stringify(inspected)).not.toContain("HIDDEN_DUPLICATE_ANSWER");

    page.updatePrimaryAssistant("Final live answer after hidden clone");
    requireElement<HTMLButtonElement>('[data-testid="stop-button"]').outerHTML =
      '<button type="button" aria-label="Copy response">Copy</button>';
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );
    expect(complete.payload).toMatchObject({ markdown: "Final live answer after hidden clone" });
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 12_000);

  it("keeps cached follow-up ownership when the whole current turn is virtualized", async () => {
    const { harness, socket, tab } = await startHarness();
    installChatGptComposerFixture(harness, tab.id, {
      followUpStreaming: true,
      autoCanonicalize: false,
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );

    socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_A));
    const snapshot = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.snapshot" && envelope.runId === SECOND_RUN_ID,
      5_000,
    );
    expect(snapshot.payload).toMatchObject({ markdown: "Follow-up answer on canonical B" });
    expect(document.querySelector('[data-testid="stop-button"]')).not.toBeNull();
    const beforeVirtualization: unknown = await chrome.tabs.sendMessage(tab.id, {
      type: "content.recover",
      conversationId: CONVERSATION_ID,
      runId: SECOND_RUN_ID,
      startedAt: new Date().toISOString(),
      expectedPromptSha256: FIRST_PROMPT_SHA256,
    });
    expect(beforeVirtualization).toMatchObject({
      runLifecycle: { responseActionsPresent: false },
    });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    requireElement<HTMLElement>('[data-testid="conversation-turn-follow-up-user"]').remove();
    requireElement<HTMLElement>('[data-testid="conversation-turn-follow-up"]').remove();
    expect(
      document.querySelector('[data-testid="conversation-turn-primary-assistant"] button'),
    ).not.toBeNull();

    const recovered: unknown = await chrome.tabs.sendMessage(tab.id, {
      type: "content.recover",
      conversationId: CONVERSATION_ID,
      runId: SECOND_RUN_ID,
      startedAt: new Date().toISOString(),
      expectedPromptSha256: FIRST_PROMPT_SHA256,
    });
    expect(recovered).toMatchObject({
      ok: true,
      active: true,
      matchedActiveRun: true,
      markdown: "Follow-up answer on canonical B",
      runLifecycle: {
        responseActionsPresent: false,
        assistantAfterUser: false,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
        ),
    ).toBe(false);
    expect(
      harness
        .outboundEnvelopes(socket)
        .filter(
          (envelope) =>
            envelope.runId === SECOND_RUN_ID &&
            (envelope.type === "generation.snapshot" || envelope.type === "generation.complete"),
        )
        .some(
          (envelope) =>
            (envelope.payload as { markdown?: string }).markdown ===
            "Short answer completed on provisional A",
        ),
    ).toBe(false);
    visibility.mockRestore();
  }, 12_000);

  it("dispatches the send button exactly once while awaiting delayed confirmation", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, { submissionDelayMs: 1_500 });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );
    expect(complete.payload).toMatchObject({
      markdown: "Short answer completed on provisional A",
    });
    expect(page.sendClicks()).toBe(1);
    expect(page.formSubmits()).toBe(0);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 10_000);

  it("fails an untouched draft quickly without submitting or retrying", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, { submissionMode: "form" });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    vi.useFakeTimers();
    try {
      socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
      await vi.waitFor(() =>
        expect(
          harness.timeline.filter(
            (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
          ),
        ).toHaveLength(1),
      );
      await vi.waitFor(() => expect(page.sendClicks()).toBe(1));
      await vi.advanceTimersByTimeAsync(1_750);
      await vi.waitFor(() =>
        expect(
          harness.timeline.filter(
            (entry) => entry === `tabs.sendMessage:response:${tab.id}:content.send`,
          ),
        ).toHaveLength(1),
      );
      await vi.waitFor(() => expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(1));
    } finally {
      vi.useRealTimers();
    }

    expect(page.sendClicks()).toBe(1);
    expect(page.formSubmits()).toBe(0);
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
      ),
    ).toHaveLength(1);
    const error = runErrors(harness, socket, FIRST_RUN_ID)[0]!;
    expect(error.payload).toMatchObject({ code: "CHATGPT_SEND_FAILED" });
    const message = (error.payload as { message?: string }).message ?? "";
    expect(message).toContain("问题仍保留在输入框中");
    expect(message).not.toContain("已显示本轮用户消息");
    expect(
      (harness.sessionValue("activeRunsV2") as Array<{ runId?: string }> | undefined)?.some(
        (run) => run.runId === FIRST_RUN_ID,
      ),
    ).toBe(false);
    expect(readComposerText(requireElement<HTMLElement>("#prompt-textarea"))).toBe(
      "Explain the relay race.",
    );
  }, 5_000);

  it("transiently selects an unhydrated owned tab and restores the focused user tab", async () => {
    const { harness, socket, tab } = await startHarness();
    const homeWindowId = tab.windowId;
    const previousTab = await chrome.tabs.create({
      url: "https://example.test/user-tab",
      active: true,
    });
    if (previousTab.id === undefined) throw new Error("Fake Chrome did not create a user tab.");

    let sendCalls = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        const visible = harness.tabsById.get(tab.id)?.active === true;
        return {
          ok: true,
          ready: visible,
          rawCandidateCount: visible ? 1 : 0,
          readyCandidateCount: visible ? 1 : 0,
          visibilityState: visible ? "visible" : "hidden",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCalls += 1;
        return harness.tabsById.get(tab.id)?.active === true
          ? { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION }
          : { ok: false };
      }
      return { ok: false };
    });

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
      5_000,
    );

    expect(sendCalls).toBe(1);
    expect(harness.tabsById.get(tab.id)?.windowId).toBe(homeWindowId);
    expect(harness.tabsById.get(tab.id)?.active).toBe(false);
    expect(harness.tabsById.get(previousTab.id)?.active).toBe(true);
    expect(harness.timeline.some((entry) => entry.startsWith("window-created:"))).toBe(false);
    expect(harness.timeline).not.toContain(`window-updated:${homeWindowId}:focused:true`);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 8_000);

  it("keeps an unfocused Chrome run visible through final history sync, then restores the user tab", async () => {
    const { harness, socket, tab } = await startHarness();
    const homeWindowId = tab.windowId;
    const previousTab = await chrome.tabs.create({
      url: "https://example.test/user-tab",
      active: true,
    });
    if (previousTab.id === undefined) throw new Error("Fake Chrome did not create a user tab.");
    const previousTabId = previousTab.id;
    harness.setWindowFocused(tab.windowId, false);
    let sendCalls = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: harness.tabsById.get(tab.id)?.url ?? PROJECT_ROOT,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.composerStatus")) {
        const ready = harness.tabsById.get(tab.id)?.active === true;
        return {
          ok: true,
          ready,
          rawCandidateCount: ready ? 1 : 0,
          readyCandidateCount: ready ? 1 : 0,
          visibilityState: ready ? "visible" : "hidden",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCalls += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: harness.tabsById.get(tab.id)?.url ?? PROJECT_ROOT,
          title: "Lease test",
          complete: sendCalls > 0,
          historyComplete: true,
          messages:
            sendCalls > 0
              ? [
                  { role: "user", markdown: "Explain the relay race." },
                  { role: "assistant", markdown: "Complete lease answer" },
                ]
              : [],
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });
    await harness.importContentScript(tab.id, async () => undefined);

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
      5_000,
    );
    expect(harness.tabsById.get(tab.id)?.windowId).toBe(homeWindowId);
    expect(harness.tabsById.get(tab.id)?.active).toBe(true);
    expect(harness.tabsById.get(previousTabId)?.active).toBe(false);

    harness.setPrimaryDocumentUrl(REMOTE_A);
    harness.setTabUrl(tab.id, REMOTE_A);
    const terminalStartIndex = harness.timeline.length;
    await expect(
      chrome.runtime.sendMessage({
        type: "content.event",
        eventType: "complete",
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        markdown: "Complete lease answer",
        remoteUrl: REMOTE_A,
      }),
    ).resolves.toEqual({ ok: true });
    await waitUntil(() => harness.tabsById.get(previousTabId)?.active === true);

    const terminalInspectIndex = harness.timeline.findIndex(
      (entry, index) =>
        index >= terminalStartIndex &&
        entry === `tabs.sendMessage:response:${tab.id}:content.inspectConversation`,
    );
    const restoredIndex = harness.timeline.lastIndexOf(`tab-active:${previousTabId}:true`);
    expect(terminalInspectIndex).toBeGreaterThanOrEqual(terminalStartIndex);
    expect(restoredIndex).toBeGreaterThan(terminalInspectIndex);
    expect(sendCalls).toBe(1);
    expect(harness.tabsById.get(tab.id)?.active).toBe(false);
    expect(harness.tabsById.get(previousTabId)?.active).toBe(true);
    expect(harness.timeline.some((entry) => entry.startsWith("window-updated:"))).toBe(false);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 10_000);

  it("keeps a minimized Relay window in the background during send and terminal sync", async () => {
    const { harness, socket, tab } = await startHarness();
    const homeWindowId = tab.windowId;
    const previousTab = await chrome.tabs.create({
      url: "https://example.test/user-tab",
      active: true,
    });
    if (previousTab.id === undefined) throw new Error("Fake Chrome did not create a user tab.");
    const previousTabId = previousTab.id;
    harness.setWindowFocused(homeWindowId, false);
    harness.setWindowState(homeWindowId, "minimized");
    let sendCalls = 0;
    let composerStatusChecks = 0;
    harness.installTabMessageResponder(tab.id, async (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: harness.tabsById.get(tab.id)?.url ?? PROJECT_ROOT,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.composerStatus")) {
        composerStatusChecks += 1;
        const chromeWindow = await chrome.windows.get(tab.windowId);
        const visible =
          harness.tabsById.get(tab.id)?.active === true && chromeWindow.state !== "minimized";
        return {
          ok: true,
          // A hidden document can still expose one exact, writable composer.
          // The worker must not unminimize Chrome just to obtain this probe.
          ready: true,
          rawCandidateCount: 1,
          readyCandidateCount: 1,
          visibilityState: visible ? "visible" : "hidden",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCalls += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: harness.tabsById.get(tab.id)?.url ?? PROJECT_ROOT,
          title: "Minimized lease test",
          complete: sendCalls > 0,
          historyComplete: true,
          messages:
            sendCalls > 0
              ? [
                  { role: "user", markdown: "Explain the relay race." },
                  { role: "assistant", markdown: "Complete minimized answer" },
                ]
              : [],
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });
    await harness.importContentScript(tab.id, async () => undefined);

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
      5_000,
    );

    expect(harness.tabsById.get(tab.id)?.windowId).toBe(homeWindowId);
    expect((await chrome.windows.get(homeWindowId)).state).toBe("normal");
    expect(harness.windowBounds(homeWindowId)).toEqual({
      height: 100,
      left: -16_000,
      top: -16_000,
      width: 100,
    });
    expect(harness.timeline).toContain(`window-updated:${homeWindowId}:state:normal`);
    expect(harness.timeline.some((entry) => entry.startsWith("window-created:"))).toBe(false);

    harness.setPrimaryDocumentUrl(REMOTE_A);
    harness.setTabUrl(tab.id, REMOTE_A);
    await expect(
      chrome.runtime.sendMessage({
        type: "content.event",
        eventType: "complete",
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        markdown: "Complete minimized answer",
        remoteUrl: REMOTE_A,
      }),
    ).resolves.toEqual({ ok: true });
    await waitUntil(() =>
      harness.timeline.includes(`window-updated:${homeWindowId}:state:minimized`),
    );
    expect((await chrome.windows.get(homeWindowId)).state).toBe("minimized");
    expect(harness.windowBounds(homeWindowId)).toEqual({
      height: 900,
      left: 100,
      top: 100,
      width: 1_200,
    });
    expect(harness.tabsById.get(previousTabId)?.active).toBe(true);
    expect(harness.tabsById.get(tab.id)?.active).toBe(false);
    expect(harness.timeline).toContain(`window-updated:${homeWindowId}:state:normal`);
    expect(sendCalls).toBe(1);
    // One hidden probe chooses the visibility path. A freshly restored renderer
    // then proves the exact ready composer twice across the bounded stability
    // window before dispatch.
    expect(composerStatusChecks).toBe(3);
    expect(harness.timeline).not.toContain(`window-updated:${homeWindowId}:focused:true`);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 10_000);

  it("finishes an active run after the user minimizes Chrome without bringing it forward", async () => {
    const { harness, socket, tab } = await startHarness();
    const homeWindowId = tab.windowId;
    const previousTab = await chrome.tabs.create({
      url: "https://example.test/user-minimized-during-run",
      active: true,
    });
    if (previousTab.id === undefined) throw new Error("Fake Chrome did not create a user tab.");
    const previousTabId = previousTab.id;
    let sendCalls = 0;
    let recoverCalls = 0;

    harness.setTabUrl(tab.id, REMOTE_A);
    harness.installTabMessageResponder(tab.id, async (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.composerStatus")) {
        const chromeWindow = await chrome.windows.get(tab.windowId);
        const visible =
          harness.tabsById.get(tab.id)?.active === true && chromeWindow.state !== "minimized";
        return {
          ok: true,
          ready: visible,
          rawCandidateCount: visible ? 1 : 0,
          readyCandidateCount: visible ? 1 : 0,
          visibilityState: visible ? "visible" : "hidden",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCalls += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.recover")) {
        recoverCalls += 1;
        return {
          ok: true,
          active: false,
          matchedActiveRun: true,
          markdown: "Answer recovered after Chrome was minimized",
          remoteUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        const complete = recoverCalls > 0;
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          title: "Minimized during run",
          complete,
          historyComplete: true,
          messages: complete
            ? [
                { role: "user", markdown: "Explain the relay race." },
                { role: "assistant", markdown: "Answer recovered after Chrome was minimized" },
              ]
            : [],
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID, REMOTE_A));
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
      5_000,
    );
    expect(sendCalls).toBe(1);
    expect(harness.tabsById.get(previousTabId)?.active).toBe(true);
    expect(harness.tabsById.get(tab.id)?.windowId).toBe(homeWindowId);
    expect(harness.tabsById.get(tab.id)?.active).toBe(false);

    harness.setWindowFocused(homeWindowId, false);
    harness.setWindowState(homeWindowId, "minimized");
    expect((await chrome.windows.get(homeWindowId)).state).toBe("minimized");

    socket.deliverFromHost(
      makeEnvelope({
        type: "heartbeat",
        instanceId: INSTANCE_ID,
        payload: { at: new Date().toISOString() },
      }),
    );
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );

    expect(complete.payload).toMatchObject({
      markdown: "Answer recovered after Chrome was minimized",
      remoteUrl: REMOTE_A,
    });
    expect(recoverCalls).toBeGreaterThanOrEqual(1);
    expect(sendCalls).toBe(1);
    await waitUntil(() => harness.tabsById.get(previousTabId)?.active === true);
    expect(harness.tabsById.get(tab.id)?.active).toBe(false);
    expect(harness.tabsById.get(previousTabId)?.active).toBe(true);
    expect((await chrome.windows.get(homeWindowId)).state).toBe("minimized");
    expect(harness.timeline).not.toContain(`window-updated:${homeWindowId}:focused:true`);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 10_000);

  it("does not take the Chrome tab back after the user changes tabs during a visibility lease", async () => {
    const { harness, socket, tab } = await startHarness();
    await chrome.tabs.create({ url: "https://example.test/baseline", active: true });
    const userChosenTab = await chrome.tabs.create({
      url: "https://example.test/user-choice",
      active: false,
    });
    if (userChosenTab.id === undefined) throw new Error("Fake Chrome did not create a user tab.");
    const userChosenTabId = userChosenTab.id;
    harness.setWindowFocused(tab.windowId, false);
    let sendCalls = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        const ready = harness.tabsById.get(tab.id)?.active === true;
        return {
          ok: true,
          ready,
          rawCandidateCount: ready ? 1 : 0,
          readyCandidateCount: ready ? 1 : 0,
          visibilityState: ready ? "visible" : "hidden",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCalls += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });
    await harness.importContentScript(tab.id, async () => undefined);

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
      5_000,
    );
    harness.emitTabActivated(userChosenTabId);
    await waitUntil(
      () =>
        harness.tabsById.get(userChosenTabId)?.active === true &&
        harness.tabsById.get(tab.id)?.active === false,
    );
    await expect(
      chrome.runtime.sendMessage({
        type: "content.event",
        eventType: "stopped",
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        markdown: "Stopped after user changed tabs",
      }),
    ).resolves.toEqual({ ok: true });

    expect(harness.tabsById.get(userChosenTabId)?.active).toBe(true);
    expect(harness.tabsById.get(tab.id)?.active).toBe(false);
    expect(sendCalls).toBe(1);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 10_000);

  it("restores parked bounds without restoring the baseline after the user opens Chrome", async () => {
    const { harness, socket, tab } = await startHarness({ debuggerPermission: true });
    const baselineTab = await chrome.tabs.create({
      url: "https://example.test/baseline-focus",
      active: true,
    });
    if (baselineTab.id === undefined) throw new Error("Fake Chrome did not create a baseline tab.");
    const baselineTabId = baselineTab.id;
    harness.setWindowFocused(tab.windowId, false);
    harness.setWindowState(tab.windowId, "minimized");
    let sendCalls = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        const ready = harness.tabsById.get(tab.id)?.active === true;
        return {
          ok: true,
          ready,
          rawCandidateCount: ready ? 1 : 0,
          readyCandidateCount: ready ? 1 : 0,
          visibilityState: ready ? "visible" : "hidden",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCalls += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });
    await harness.importContentScript(tab.id, async () => undefined);

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
      5_000,
    );
    expect(harness.tabsById.get(tab.id)?.active).toBe(true);
    expect((await chrome.windows.get(tab.windowId)).state).toBe("normal");
    expect(harness.windowBounds(tab.windowId)).toEqual({
      height: 100,
      left: -16_000,
      top: -16_000,
      width: 100,
    });

    harness.setWindowFocused(tab.windowId, true);
    await waitUntil(
      () =>
        JSON.stringify(harness.windowBounds(tab.windowId)) ===
        JSON.stringify({ height: 900, left: 100, top: 100, width: 1_200 }),
    );
    await expect(
      chrome.runtime.sendMessage({
        type: "content.event",
        eventType: "stopped",
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        markdown: "Stopped after the user focused Chrome",
      }),
    ).resolves.toEqual({ ok: true });

    expect(harness.tabsById.get(tab.id)?.active).toBe(true);
    expect(harness.tabsById.get(baselineTabId)?.active).toBe(false);
    expect((await chrome.windows.get(tab.windowId)).state).toBe("normal");
    expect(harness.windowBounds(tab.windowId)).toEqual({
      height: 900,
      left: 100,
      top: 100,
      width: 1_200,
    });
    expect(sendCalls).toBe(1);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 10_000);

  it("fails before sending when an older content script cannot answer the readiness probe", async () => {
    const { harness, socket, tab } = await startHarness();
    let sendCalls = 0;
    let statusChecks = 0;
    harness.disableImplicitComposerReadiness(tab.id);
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        statusChecks += 1;
        return { ok: false };
      }
      if (isMessageType(message, "content.send")) {
        sendCalls += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });

    vi.useFakeTimers();
    try {
      socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
      await vi.waitFor(() => expect(statusChecks).toBeGreaterThanOrEqual(2));
      await vi.advanceTimersByTimeAsync(15_500);
      await vi.waitFor(() => {
        const errors = runErrors(harness, socket, FIRST_RUN_ID);
        expect(errors).toHaveLength(1);
        expect((errors[0]!.payload as { code?: string }).code).toBe("CHATGPT_REMOTE_UNAVAILABLE");
      });
    } finally {
      vi.useRealTimers();
    }

    expect(sendCalls).toBe(0);
  }, 8_000);

  it("waits for a transient composer ownership gap before sending once", async () => {
    const { harness, socket, tab } = await startHarness();
    let statusChecks = 0;
    let sendCalls = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        statusChecks += 1;
        const ready = statusChecks >= 3;
        return {
          ok: true,
          ready,
          rawCandidateCount: 1,
          readyCandidateCount: ready ? 1 : 0,
          visibilityState: harness.tabsById.get(tab.id!)?.active ? "visible" : "hidden",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCalls += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
      5_000,
    );

    expect(statusChecks).toBeGreaterThanOrEqual(3);
    expect(sendCalls).toBe(1);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 8_000);

  it("waits for two transient ready composers to settle to one", async () => {
    const { harness, socket, tab } = await startHarness();
    let statusChecks = 0;
    let sendCalls = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        statusChecks += 1;
        const settled = statusChecks >= 3;
        return {
          ok: true,
          ready: settled,
          rawCandidateCount: settled ? 1 : 2,
          readyCandidateCount: settled ? 1 : 2,
          visibilityState: harness.tabsById.get(tab.id)?.active ? "visible" : "hidden",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCalls += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
      5_000,
    );

    expect(statusChecks).toBeGreaterThanOrEqual(3);
    expect(sendCalls).toBe(1);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 8_000);

  it("fails before sending when a persistent composer transition never settles", async () => {
    const { harness, socket, tab } = await startHarness();
    let statusChecks = 0;
    let sendCalls = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        statusChecks += 1;
        return {
          ok: true,
          ready: false,
          rawCandidateCount: 2,
          readyCandidateCount: 0,
          visibilityState: "visible",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCalls += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });

    vi.useFakeTimers();
    try {
      socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
      await vi.waitFor(() => expect(statusChecks).toBeGreaterThanOrEqual(2));
      await vi.advanceTimersByTimeAsync(15_500);
      await vi.waitFor(() =>
        expect(
          runErrors(harness, socket, FIRST_RUN_ID).some(
            (error) => (error.payload as { code?: string }).code === "SELECTOR_INCOMPATIBLE",
          ),
        ).toBe(true),
      );
    } finally {
      vi.useRealTimers();
    }

    expect(statusChecks).toBeGreaterThanOrEqual(2);
    expect(sendCalls).toBe(0);
  }, 8_000);

  it("rechecks Project ownership after composer wake-up and before dispatch", async () => {
    const { harness, socket, tab } = await startHarness();
    let statusChecks = 0;
    let sendCalls = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        statusChecks += 1;
        if (statusChecks === 2) harness.setTabUrl(tab.id, OTHER_PROJECT_ROOT);
        return {
          ok: true,
          ready: false,
          rawCandidateCount: 2,
          readyCandidateCount: 0,
          visibilityState: "visible",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCalls += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await waitUntil(
      () =>
        runErrors(harness, socket, FIRST_RUN_ID).some(
          (error) => (error.payload as { code?: string }).code === "CHATGPT_PROJECT_MISMATCH",
        ),
      5_000,
    );

    expect(statusChecks).toBeGreaterThanOrEqual(2);
    expect(sendCalls).toBe(0);
  }, 8_000);

  it("delegates an invalid composer candidate once and preserves a fail-closed response", async () => {
    const { harness, socket, tab } = await startHarness();
    let sendCalls = 0;
    let statusChecks = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        statusChecks += 1;
        return {
          ok: true,
          ready: false,
          rawCandidateCount: 1,
          readyCandidateCount: 0,
          visibilityState: "visible",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCalls += 1;
        return { ok: false };
      }
      return { ok: false };
    });

    vi.useFakeTimers();
    try {
      socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
      await vi.waitFor(() => expect(statusChecks).toBeGreaterThanOrEqual(2));
      await vi.advanceTimersByTimeAsync(15_500);
      await vi.waitFor(() => {
        const errors = runErrors(harness, socket, FIRST_RUN_ID);
        expect(errors).toHaveLength(1);
        expect((errors[0]!.payload as { code?: string }).code).toBe("SELECTOR_INCOMPATIBLE");
      });
    } finally {
      vi.useRealTimers();
    }

    expect(sendCalls).toBe(0);
  }, 8_000);

  it("selects a responsive background tab without activating the user's Chrome window", async () => {
    const { harness, socket, tab } = await startHarness();
    const homeWindowId = tab.windowId;
    const userTab = await chrome.tabs.create({
      url: "https://example.test/background-user-tab",
      active: true,
    });
    if (userTab.id === undefined) throw new Error("Fake Chrome did not create a user tab.");
    harness.setWindowFocused(tab.windowId, false);

    let sendCalls = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        const currentTab = harness.tabsById.get(tab.id);
        const visible = currentTab?.active === true && currentTab.windowId === homeWindowId;
        return {
          ok: true,
          ready: visible,
          rawCandidateCount: visible ? 1 : 0,
          readyCandidateCount: visible ? 1 : 0,
          visibilityState: visible ? "visible" : "hidden",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCalls += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });
    await harness.importContentScript(tab.id, async () => undefined);
    const sendTimelineStart = harness.timeline.length;

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
      5_000,
    );
    expect(harness.tabsById.get(tab.id)?.windowId).toBe(homeWindowId);
    expect(harness.tabsById.get(tab.id)?.active).toBe(true);

    await expect(
      chrome.runtime.sendMessage({
        type: "content.event",
        eventType: "stopped",
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        markdown: "Background response stopped",
      }),
    ).resolves.toEqual({ ok: true });
    await waitUntil(
      () =>
        !(harness.sessionValue("activeRunsV2") as Array<{ runId?: string }> | undefined)?.some(
          (run) => run.runId === FIRST_RUN_ID,
        ),
    );
    await waitUntil(() => harness.tabsById.get(userTab.id!)?.active === true);

    const sendTimeline = harness.timeline.slice(sendTimelineStart);
    expect(sendCalls).toBe(1);
    expect(harness.tabsById.get(tab.id)?.active).toBe(false);
    expect(harness.tabsById.get(userTab.id)?.active).toBe(true);
    expect(sendTimeline.some((entry) => entry.startsWith("window-created:"))).toBe(false);
    expect(sendTimeline).not.toContain(`window-updated:${homeWindowId}:focused:true`);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 8_000);

  it("restores an unresponsive minimized home window only at safe off-screen bounds", async () => {
    const { harness, socket, tab } = await startHarness();
    const homeWindowId = tab.windowId;
    const userTab = await chrome.tabs.create({
      url: "https://example.test/minimized-user-tab",
      active: true,
    });
    if (userTab.id === undefined) throw new Error("Fake Chrome did not create a user tab.");
    harness.setWindowFocused(homeWindowId, false);
    harness.setWindowState(homeWindowId, "minimized");

    let sendCalls = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        const ready = harness.tabsById.get(tab.id)?.active === true;
        const currentWindowId = harness.tabsById.get(tab.id)?.windowId;
        const currentWindowState = harness.timeline
          .filter((entry) => entry.startsWith(`window-updated:${currentWindowId}:state:`))
          .at(-1);
        const visible = currentWindowState?.endsWith(":normal") === true;
        return {
          ok: true,
          ready: ready && visible,
          rawCandidateCount: ready ? 1 : 0,
          readyCandidateCount: ready && visible ? 1 : 0,
          visibilityState: visible ? "visible" : "hidden",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCalls += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });
    await harness.importContentScript(tab.id, async () => undefined);
    const sendTimelineStart = harness.timeline.length;

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
      5_000,
    );
    expect(harness.tabsById.get(tab.id)?.windowId).toBe(homeWindowId);
    expect(harness.windowBounds(homeWindowId)).toEqual({
      height: 100,
      left: -16_000,
      top: -16_000,
      width: 100,
    });
    await expect(
      chrome.runtime.sendMessage({
        type: "content.event",
        eventType: "stopped",
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        markdown: "Fallback response stopped",
      }),
    ).resolves.toEqual({ ok: true });
    await waitUntil(
      () =>
        !(harness.sessionValue("activeRunsV2") as Array<{ runId?: string }> | undefined)?.some(
          (run) => run.runId === FIRST_RUN_ID,
        ),
    );
    await waitUntil(() =>
      harness.timeline.includes(`window-updated:${homeWindowId}:state:minimized`),
    );
    await waitUntil(() => harness.tabsById.get(userTab.id!)?.active === true);

    const sendTimeline = harness.timeline.slice(sendTimelineStart);
    expect(sendCalls).toBe(1);
    expect(sendTimeline.some((entry) => entry.startsWith("window-created:"))).toBe(false);
    expect(sendTimeline.filter((entry) => entry === `tab-active:${userTab.id}:true`)).toHaveLength(
      1,
    );
    expect(sendTimeline).toContain(`window-updated:${homeWindowId}:bounds:-16000,-16000,100,100`);
    expect(sendTimeline).toContain(`window-updated:${homeWindowId}:state:normal`);
    expect((await chrome.windows.get(homeWindowId)).state).toBe("minimized");
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 8_000);

  it("serializes transient activation for two conversations in the same Chrome window", async () => {
    const { harness, socket, tab: firstTab } = await startHarness();
    const previousTab = await chrome.tabs.create({
      url: "https://example.test/user-tab",
      active: true,
    });
    if (previousTab.id === undefined) throw new Error("Fake Chrome did not create a user tab.");

    const secondConversationId = "conversation-b";
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: secondConversationId,
        payload: { active: false },
      }),
    );
    const secondTab = await harness.waitForCreatedTab(2);
    const sendCounts = new Map<number, number>();
    const installResponder = (tabId: number) => {
      harness.installTabMessageResponder(tabId, async (message) => {
        if (isMessageType(message, "content.ping")) {
          return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
        }
        if (isMessageType(message, "content.composerStatus")) {
          const ready = harness.tabsById.get(tabId)?.active === true;
          return {
            ok: true,
            ready,
            rawCandidateCount: ready ? 1 : 0,
            readyCandidateCount: ready ? 1 : 0,
            visibilityState: ready ? "visible" : "hidden",
            selectorVersion: CONTENT_RUNTIME_REVISION,
          };
        }
        if (isMessageType(message, "content.send")) {
          sendCounts.set(tabId, (sendCounts.get(tabId) ?? 0) + 1);
          await new Promise((resolve) => setTimeout(resolve, 100));
          return harness.tabsById.get(tabId)?.active
            ? { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION }
            : { ok: false };
        }
        return { ok: false };
      });
    };
    installResponder(firstTab.id);
    installResponder(secondTab.id);
    await chrome.tabs.update(firstTab.id, { active: true });

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.send",
        instanceId: INSTANCE_ID,
        conversationId: secondConversationId,
        runId: SECOND_RUN_ID,
        payload: {
          prompt: "Explain the second relay race.",
          messageId: `message-${SECOND_RUN_ID}`,
        },
      }),
    );
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.filter((run) => run.phase === "active").length === 2,
      5_000,
    );

    expect(sendCounts.get(firstTab.id)).toBe(1);
    expect(sendCounts.get(secondTab.id)).toBe(1);
    expect(
      [firstTab.id, secondTab.id].filter((tabId) => harness.tabsById.get(tabId)?.active === true),
    ).toHaveLength(1);
    expect(harness.tabsById.get(previousTab.id)?.active).toBe(false);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
  }, 8_000);

  it("queues terminal restoration behind another conversation's in-flight send", async () => {
    const { harness, socket, tab: firstTab } = await startHarness();
    const baselineTab = await chrome.tabs.create({
      url: "https://example.test/queued-baseline",
      active: true,
    });
    if (baselineTab.id === undefined) throw new Error("Fake Chrome did not create a baseline tab.");
    const baselineTabId = baselineTab.id;
    harness.setWindowFocused(firstTab.windowId, false);

    const secondConversationId = "conversation-queued-b";
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: secondConversationId,
        payload: { active: false },
      }),
    );
    const secondTab = await harness.waitForCreatedTab(2);
    let firstSendCalls = 0;
    let secondSendCalls = 0;
    let markSecondSendStarted!: () => void;
    let releaseSecondSend!: () => void;
    const secondSendStarted = new Promise<void>((resolve) => {
      markSecondSendStarted = resolve;
    });
    const secondSendGate = new Promise<void>((resolve) => {
      releaseSecondSend = resolve;
    });
    const installResponder = (tabId: number, second = false) => {
      harness.installTabMessageResponder(tabId, async (message) => {
        if (isMessageType(message, "content.ping")) {
          return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
        }
        if (isMessageType(message, "content.composerStatus")) {
          const ready = harness.tabsById.get(tabId)?.active === true;
          return {
            ok: true,
            ready,
            rawCandidateCount: ready ? 1 : 0,
            readyCandidateCount: ready ? 1 : 0,
            visibilityState: ready ? "visible" : "hidden",
            selectorVersion: CONTENT_RUNTIME_REVISION,
          };
        }
        if (isMessageType(message, "content.send")) {
          if (second) {
            secondSendCalls += 1;
            markSecondSendStarted();
            await secondSendGate;
          } else {
            firstSendCalls += 1;
          }
          return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
        }
        return { ok: false };
      });
    };
    installResponder(firstTab.id);
    installResponder(secondTab.id, true);
    await harness.importContentScript(firstTab.id, async () => undefined);

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
      5_000,
    );
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.send",
        instanceId: INSTANCE_ID,
        conversationId: secondConversationId,
        runId: SECOND_RUN_ID,
        payload: {
          prompt: "Explain the queued relay race.",
          messageId: `message-${SECOND_RUN_ID}`,
        },
      }),
    );
    await secondSendStarted;

    const firstTerminal = chrome.runtime.sendMessage({
      type: "content.event",
      eventType: "stopped",
      conversationId: CONVERSATION_ID,
      runId: FIRST_RUN_ID,
      markdown: "First run stopped while B was sending",
    });
    releaseSecondSend();
    await firstTerminal;
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === SECOND_RUN_ID && run.phase === "active") === true,
      5_000,
    );
    expect(harness.tabsById.get(secondTab.id)?.active).toBe(true);

    await harness.importContentScript(secondTab.id, async () => undefined);
    await expect(
      chrome.runtime.sendMessage({
        type: "content.event",
        eventType: "stopped",
        conversationId: secondConversationId,
        runId: SECOND_RUN_ID,
        markdown: "Second run stopped",
      }),
    ).resolves.toEqual({ ok: true });
    await waitUntil(() => harness.tabsById.get(baselineTabId)?.active === true);

    expect(firstSendCalls).toBe(1);
    expect(secondSendCalls).toBe(1);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
  }, 12_000);

  it("does not restore the previous tab after the user changes the active tab", async () => {
    const { harness, socket, tab } = await startHarness();
    const homeWindowId = tab.windowId;
    const previousTab = await chrome.tabs.create({
      url: "https://example.test/user-tab",
      active: true,
    });
    if (previousTab.id === undefined) throw new Error("Fake Chrome did not create a user tab.");

    let markDispatchStarted!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      markDispatchStarted = resolve;
    });
    harness.installTabMessageResponder(tab.id, async (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        return {
          ok: true,
          ready: true,
          rawCandidateCount: 1,
          readyCandidateCount: 1,
          visibilityState: harness.tabsById.get(tab.id)?.active ? "visible" : "hidden",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        markDispatchStarted();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await dispatchStarted;
    harness.emitTabActivated(previousTab.id);
    harness.emitTabActivated(tab.id);
    await waitUntil(
      () =>
        harness.tabsById.get(tab.id)?.windowId === homeWindowId &&
        harness.tabsById.get(tab.id)?.active === true &&
        harness.tabsById.get(previousTab.id!)?.active === false,
    );
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
      5_000,
    );

    expect(harness.tabsById.get(tab.id)?.active).toBe(true);
    expect(harness.tabsById.get(previousTab.id)?.active).toBe(false);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 8_000);

  it("fails before the non-idempotent send when the composer never becomes ready", async () => {
    const { harness, socket, tab } = await startHarness();
    const homeWindowId = tab.windowId;
    const previousTab = await chrome.tabs.create({
      url: "https://example.test/user-tab",
      active: true,
    });
    if (previousTab.id === undefined) throw new Error("Fake Chrome did not create a user tab.");

    let sendCalls = 0;
    let statusChecks = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        statusChecks += 1;
        return {
          ok: true,
          ready: false,
          rawCandidateCount: 0,
          readyCandidateCount: 0,
          visibilityState: harness.tabsById.get(tab.id!)?.active ? "visible" : "hidden",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCalls += 1;
        return { ok: false };
      }
      return { ok: false };
    });

    vi.useFakeTimers();
    try {
      socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
      await vi.waitFor(() => expect(statusChecks).toBeGreaterThanOrEqual(2));
      await vi.advanceTimersByTimeAsync(15_500);
      await vi.waitFor(() => {
        const errors = runErrors(harness, socket, FIRST_RUN_ID);
        expect(errors).toHaveLength(1);
        expect((errors[0]!.payload as { code?: string }).code).toBe("CHATGPT_REMOTE_UNAVAILABLE");
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(harness.tabsById.get(previousTab.id!)?.active).toBe(true));
    } finally {
      vi.useRealTimers();
    }

    expect(sendCalls).toBe(0);
    expect(harness.tabsById.get(tab.id)?.windowId).toBe(homeWindowId);
    expect(harness.tabsById.get(tab.id)?.active).toBe(false);
    expect(harness.tabsById.get(previousTab.id)?.active).toBe(true);
    expect(harness.timeline.some((entry) => entry.startsWith("window-created:"))).toBe(false);
    expect(harness.timeline.some((entry) => entry.startsWith("window-removed:"))).toBe(false);
    expect(harness.timeline).not.toContain(`window-updated:${homeWindowId}:focused:true`);
  }, 8_000);

  it("recognizes the unique modern composer owned by the send form", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const tab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a Project tab.");
    document.body.innerHTML = `
      <main>
        <form>
          <div class="ProseMirror" contenteditable="true" aria-label="Message ChatGPT"></div>
          <button type="button" data-testid="send-button" aria-label="Send prompt">Send</button>
        </form>
      </main>`;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    await expect(
      chrome.tabs.sendMessage(tab.id, { type: "content.composerStatus" }),
    ).resolves.toMatchObject({ ok: true, ready: true, selectorVersion: CONTENT_RUNTIME_REVISION });
  });

  it("accepts only a high-confidence empty composer before its send control is rendered", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const tab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a Project tab.");
    document.body.innerHTML = `
      <main>
        <form data-testid="feedback-form">
          <textarea aria-label="Feedback"></textarea>
          <div contenteditable="true" role="textbox" aria-label="Feedback details"></div>
        </form>
        <form data-testid="composer-form">
          <div id="prompt-textarea" contenteditable role="textbox"></div>
          <button type="button" data-testid="send-button" hidden>Desktop send</button>
          <button type="button" data-testid="send-button" hidden>Compact send</button>
        </form>
      </main>`;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    await expect(
      chrome.tabs.sendMessage(tab.id, { type: "content.composerStatus" }),
    ).resolves.toMatchObject({
      ok: true,
      ready: true,
      rawCandidateCount: 3,
      readyCandidateCount: 1,
      selectorVersion: CONTENT_RUNTIME_REVISION,
    });
  });

  it("does not report a composer whose own pointer events remain disabled as ready", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const tab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a Project tab.");
    document.body.innerHTML = `
      <main>
        <div style="pointer-events: none">
          <form data-type="unified-composer">
            <div
              class="ProseMirror"
              id="prompt-textarea"
              contenteditable="true"
              role="textbox"
              aria-multiline="true"
              style="pointer-events: none"
            ></div>
            <textarea name="prompt-textarea" style="display: none"></textarea>
          </form>
        </div>
      </main>`;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    await expect(
      chrome.tabs.sendMessage(tab.id, { type: "content.composerStatus" }),
    ).resolves.toMatchObject({
      ok: true,
      ready: false,
      rawCandidateCount: 2,
      readyCandidateCount: 0,
      selectorVersion: CONTENT_RUNTIME_REVISION,
    });
  });

  it("does not click an owned send control whose own pointer events are disabled", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const tab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a Project tab.");
    document.body.innerHTML = `
      <main>
        <section id="thread"></section>
        <form data-type="unified-composer">
          <div
            class="ProseMirror"
            id="prompt-textarea"
            contenteditable="true"
            role="textbox"
            aria-multiline="true"
            style="pointer-events: auto"
          ></div>
          <textarea name="prompt-textarea" style="display: none"></textarea>
          <button
            type="button"
            data-testid="send-button"
            aria-label="Send prompt"
            style="pointer-events: none"
          >Send</button>
        </form>
      </main>`;
    const composer = requireElement<HTMLElement>("#prompt-textarea");
    const send = requireElement<HTMLButtonElement>('[data-testid="send-button"]');
    const click = vi.fn();
    send.addEventListener("click", click);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    vi.useFakeTimers();
    try {
      const responsePromise = chrome.tabs.sendMessage(tab.id, {
        type: "content.send",
        conversationId: CONVERSATION_ID,
        runId: "run-pointer-disabled-send",
        prompt: "Explain the relay race.",
        allowFirstConversation: true,
        expectedProjectScope: PROJECT_SCOPE,
      });
      await vi.advanceTimersByTimeAsync(11_000);
      await expect(responsePromise).resolves.toMatchObject({
        ok: false,
        definitiveFailure: true,
        error: { code: "CHATGPT_SEND_FAILED" },
        selectorVersion: CONTENT_RUNTIME_REVISION,
      });
    } finally {
      vi.useRealTimers();
    }

    expect(click).not.toHaveBeenCalled();
    expect(readComposerText(composer)).toBe("");
  });

  it("recognizes a unique composer and send control in a bounded non-form shell", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const tab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a Project tab.");
    document.body.innerHTML = `
      <main>
        <section data-testid="composer-shell">
          <div class="ProseMirror" contenteditable="true" aria-label="Message ChatGPT"></div>
          <div><button type="button" data-testid="send-button">Send</button></div>
        </section>
      </main>`;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    await expect(
      chrome.tabs.sendMessage(tab.id, { type: "content.composerStatus" }),
    ).resolves.toMatchObject({
      ok: true,
      ready: true,
      rawCandidateCount: 1,
      readyCandidateCount: 1,
      selectorVersion: CONTENT_RUNTIME_REVISION,
    });
  });

  it("sends once with the attachment controls owned by a bounded non-form shell", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const tab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a Project tab.");
    document.body.innerHTML = `
      <main>
        <section id="thread"></section>
        <section data-testid="composer-shell">
          <div class="ProseMirror" contenteditable="true" aria-label="Message ChatGPT"></div>
          <input type="file" multiple data-testid="shell-file-input" />
          <div><button type="button" data-testid="send-button">Send</button></div>
        </section>
        <input type="file" multiple data-testid="page-file-input" />
        <button type="button" data-testid="send-button" data-page-wide-send>Page send</button>
      </main>`;

    const prompt = "Explain the selected code without changing it.";
    const shell = requireElement<HTMLElement>('[data-testid="composer-shell"]');
    const composer = requireElement<HTMLElement>('[data-testid="composer-shell"] .ProseMirror');
    const shellFileInput = requireElement<HTMLInputElement>('[data-testid="shell-file-input"]');
    const pageFileInput = requireElement<HTMLInputElement>('[data-testid="page-file-input"]');
    const shellSend = requireElement<HTMLButtonElement>(
      '[data-testid="composer-shell"] [data-testid="send-button"]',
    );
    const pageSend = requireElement<HTMLButtonElement>("[data-page-wide-send]");
    let shellFiles: File[] = [];
    let pageFiles: File[] = [];
    let shellFileChanges = 0;
    let pageFileChanges = 0;
    let shellSendClicks = 0;
    let pageSendClicks = 0;
    Object.defineProperty(shellFileInput, "files", {
      configurable: true,
      get: () => shellFiles,
      set: (value: Iterable<File>) => {
        shellFiles = [...value];
      },
    });
    Object.defineProperty(pageFileInput, "files", {
      configurable: true,
      get: () => pageFiles,
      set: (value: Iterable<File>) => {
        pageFiles = [...value];
      },
    });
    shellFileInput.addEventListener("change", () => {
      shellFileChanges += 1;
      const attachment = document.createElement("span");
      attachment.textContent = shellFiles[0]?.name ?? "";
      shell.append(attachment);
    });
    pageFileInput.addEventListener("change", () => {
      pageFileChanges += 1;
    });
    shellSend.addEventListener("click", () => {
      shellSendClicks += 1;
      const userTurn = document.createElement("article");
      userTurn.dataset.testid = "conversation-turn-new-user";
      userTurn.innerHTML = `<div data-message-author-role="user"></div>`;
      requireElement<HTMLElement>("#thread").append(userTurn);
      const user = userTurn.querySelector<HTMLElement>('[data-message-author-role="user"]')!;
      user.textContent = `${composer.textContent ?? ""}\n${shellFiles[0]?.name ?? ""}`;
      composer.textContent = "";
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    });
    pageSend.addEventListener("click", () => {
      pageSendClicks += 1;
    });
    vi.stubGlobal(
      "DataTransfer",
      class {
        readonly files: File[] = [];
        readonly items = { add: (file: File) => this.files.push(file) };
      },
    );
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });
    await installDirectMainWorldSendWorker(harness);
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    const response: unknown = await chrome.tabs.sendMessage(tab.id, {
      type: "content.send",
      conversationId: CONVERSATION_ID,
      runId: FIRST_RUN_ID,
      prompt,
      allowFirstConversation: true,
      expectedProjectScope: PROJECT_SCOPE,
      attachments: [
        {
          id: "bounded-shell-attachment",
          fileName: "probe.ts",
          mimeType: "text/typescript",
          content: "export const probe = 42;\n",
        },
      ],
    });

    expect({
      response,
      shellSendClicks,
      pageSendClicks,
      shellFileChanges,
      pageFileChanges,
      shellFileCount: shellFiles.length,
      pageFileCount: pageFiles.length,
    }).toMatchObject({
      response: { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION },
      shellSendClicks: 1,
      pageSendClicks: 0,
      shellFileChanges: 1,
      pageFileChanges: 0,
      shellFileCount: 1,
      pageFileCount: 0,
    });
    expect(shellFiles).toHaveLength(1);
    expect(shellFiles[0]).toMatchObject({ name: "probe.ts", type: "text/typescript" });
    expect(pageFiles).toHaveLength(0);
    const users = [...document.querySelectorAll<HTMLElement>('[data-message-author-role="user"]')];
    expect(users).toHaveLength(1);
    expect(users[0]?.textContent).toBe(`${prompt}\nprobe.ts`);
  });

  it("does not bind a non-form composer to a send button owned by another form", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const tab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a Project tab.");
    document.body.innerHTML = `
      <main>
        <section data-testid="mixed-shell">
          <div class="ProseMirror" contenteditable="true" aria-label="Message ChatGPT"></div>
          <form><button type="button" data-testid="send-button">Unrelated send</button></form>
        </section>
      </main>`;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    await expect(
      chrome.tabs.sendMessage(tab.id, { type: "content.composerStatus" }),
    ).resolves.toMatchObject({
      ok: true,
      ready: false,
      rawCandidateCount: 1,
      readyCandidateCount: 0,
      selectorVersion: CONTENT_RUNTIME_REVISION,
    });
  });

  it("does not widen composer ownership across a transcript wrapper", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const tab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a Project tab.");
    document.body.innerHTML = `
      <main>
        <section data-testid="broad-page-shell">
          <div data-testid="conversation-turn-1">
            <div data-message-author-role="assistant">Existing answer</div>
          </div>
          <div><div class="ProseMirror" contenteditable="true" aria-label="Message ChatGPT"></div></div>
          <button type="button" data-testid="send-button">Page send</button>
        </section>
      </main>`;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    await expect(
      chrome.tabs.sendMessage(tab.id, { type: "content.composerStatus" }),
    ).resolves.toMatchObject({
      ok: true,
      ready: false,
      rawCandidateCount: 1,
      readyCandidateCount: 0,
      selectorVersion: CONTENT_RUNTIME_REVISION,
    });
  });

  it("ignores a contenteditable assistant turn beside the real composer", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const tab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a Project tab.");
    document.body.innerHTML = `
      <main>
        <article data-message-author-role="assistant">
          <div class="ProseMirror" contenteditable="true" aria-label="Editable answer"></div>
        </article>
        <form>
          <div class="ProseMirror" contenteditable="true" aria-label="Message ChatGPT"></div>
          <button type="button" data-testid="send-button" aria-label="Send prompt">Send</button>
        </form>
      </main>`;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    await expect(
      chrome.tabs.sendMessage(tab.id, { type: "content.composerStatus" }),
    ).resolves.toMatchObject({
      ok: true,
      ready: true,
      rawCandidateCount: 2,
      readyCandidateCount: 1,
      selectorVersion: CONTENT_RUNTIME_REVISION,
    });
  });

  it("rejects a composer mimic inside an assistant turn", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const tab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a Project tab.");
    document.body.innerHTML = `
      <main>
        <article data-message-author-role="assistant">
          <form>
            <div class="ProseMirror" contenteditable="true" aria-label="Message ChatGPT"></div>
            <button type="button" data-testid="send-button" aria-label="Send prompt">Send</button>
          </form>
        </article>
      </main>`;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    await expect(
      chrome.tabs.sendMessage(tab.id, { type: "content.composerStatus" }),
    ).resolves.toMatchObject({
      ok: true,
      ready: false,
      rawCandidateCount: 1,
      readyCandidateCount: 0,
      selectorVersion: CONTENT_RUNTIME_REVISION,
    });
  });

  it("rejects a turn composer even when an outer form owns a send button", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const tab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a Project tab.");
    document.body.innerHTML = `
      <main>
        <form>
          <article data-message-author-role="assistant">
            <div class="ProseMirror" contenteditable="true" aria-label="Message ChatGPT"></div>
          </article>
          <button type="button" data-testid="send-button" aria-label="Send prompt">Send</button>
        </form>
      </main>`;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    await expect(
      chrome.tabs.sendMessage(tab.id, { type: "content.composerStatus" }),
    ).resolves.toMatchObject({
      ok: true,
      ready: false,
      rawCandidateCount: 1,
      readyCandidateCount: 0,
      selectorVersion: CONTENT_RUNTIME_REVISION,
    });
  });

  it("rejects a composer mimic owned by a dialog", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const tab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a Project tab.");
    document.body.innerHTML = `
      <main>
        <form inert>
          <textarea aria-label="Message ChatGPT"></textarea>
          <button type="button" data-testid="send-button">Send</button>
        </form>
        <div role="dialog" aria-modal="true">
          <form>
            <div class="ProseMirror" contenteditable="true" aria-label="Message ChatGPT"></div>
            <button type="button" data-testid="send-button">Send</button>
          </form>
        </div>
      </main>`;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    await expect(
      chrome.tabs.sendMessage(tab.id, { type: "content.composerStatus" }),
    ).resolves.toMatchObject({
      ok: true,
      ready: false,
      rawCandidateCount: 2,
      readyCandidateCount: 0,
      selectorVersion: CONTENT_RUNTIME_REVISION,
    });
  });

  it("does not report a disabled or readonly composer as ready", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const tab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a Project tab.");
    document.body.innerHTML = `
      <main>
        <form>
          <textarea aria-label="Message ChatGPT" readonly></textarea>
          <button type="button" data-testid="send-button">Send</button>
        </form>
      </main>`;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    await expect(
      chrome.tabs.sendMessage(tab.id, { type: "content.composerStatus" }),
    ).resolves.toMatchObject({
      ok: true,
      ready: false,
      rawCandidateCount: 1,
      readyCandidateCount: 0,
      selectorVersion: CONTENT_RUNTIME_REVISION,
    });
  });

  it("fails the composer preflight closed when two send forms are visible", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const tab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a Project tab.");
    document.body.innerHTML = ["first", "second"]
      .map(
        (name) => `
          <form data-name="${name}">
            <div class="ProseMirror" contenteditable="true"></div>
            <button type="button" data-testid="send-button">Send</button>
          </form>`,
      )
      .join("");
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    await expect(
      chrome.tabs.sendMessage(tab.id, { type: "content.composerStatus" }),
    ).resolves.toMatchObject({
      ok: true,
      ready: false,
      rawCandidateCount: 2,
      readyCandidateCount: 2,
      selectorVersion: CONTENT_RUNTIME_REVISION,
    });
  });

  it("rejects content.send if the owned page moves to another Project before the click", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const tab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a Project tab.");
    const tabId = tab.id;
    document.body.innerHTML = `
      <main>
        <form>
          <textarea id="prompt-textarea" aria-label="Message ChatGPT"></textarea>
          <button type="button" data-testid="send-button">Send</button>
        </form>
      </main>`;
    let sendClicks = 0;
    requireElement<HTMLButtonElement>('[data-testid="send-button"]').addEventListener(
      "click",
      () => {
        sendClicks += 1;
      },
    );
    await harness.importContentScript(tabId, async () => await import("./content-script"));
    requireElement<HTMLTextAreaElement>("#prompt-textarea").addEventListener(
      "input",
      () => {
        harness.setPrimaryDocumentUrl(OTHER_PROJECT_ROOT);
        harness.setTabUrl(tabId, OTHER_PROJECT_ROOT);
      },
      { once: true },
    );

    await expect(
      chrome.tabs.sendMessage(tabId, {
        type: "content.send",
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        prompt: "Do not send this prompt.",
        allowFirstConversation: true,
        expectedProjectScope: PROJECT_SCOPE,
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(sendClicks).toBe(0);
  });

  it("ignores a hidden responsive duplicate of the owned send button", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const tab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a Project tab.");
    document.body.innerHTML = `
      <main>
        <form>
          <div class="ProseMirror" contenteditable="true"></div>
          <button type="button" data-testid="send-button">Send</button>
          <button type="button" data-testid="send-button" hidden>Responsive duplicate</button>
        </form>
      </main>`;
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    await expect(
      chrome.tabs.sendMessage(tab.id, { type: "content.composerStatus" }),
    ).resolves.toMatchObject({
      ok: true,
      ready: true,
      rawCandidateCount: 1,
      readyCandidateCount: 1,
      selectorVersion: CONTENT_RUNTIME_REVISION,
    });
  });

  it("sends once when the current ProseMirror creates its submit button after input", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const tab = await chrome.tabs.create({ url: PROJECT_ROOT, active: true });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a Project tab.");
    document.body.innerHTML = `
      <main>
        <section id="thread"></section>
        <form data-type="unified-composer">
          <textarea name="prompt-textarea" placeholder="Ask anything" hidden></textarea>
          <div class="ProseMirror" id="prompt-textarea" role="textbox" aria-multiline="true" aria-label="Chat with ChatGPT"></div>
        </form>
      </main>`;
    const thread = requireElement<HTMLElement>("#thread");
    const composer = requireElement<HTMLElement>("#prompt-textarea");
    const form = requireElement<HTMLFormElement>('form[data-type="unified-composer"]');
    let sendClicks = 0;
    const submittedPrompts: string[] = [];
    composer.addEventListener("input", () => {
      if (form.querySelector('[data-testid="send-button"]')) return;
      const send = document.createElement("button");
      send.type = "button";
      send.dataset.testid = "send-button";
      send.setAttribute("aria-label", "Send prompt");
      send.addEventListener("click", () => {
        sendClicks += 1;
        const prompt = composer.textContent ?? "";
        submittedPrompts.push(prompt);
        thread.innerHTML = `<article data-testid="conversation-turn-current-user"><div data-message-author-role="user">${escapeFixtureHtml(prompt)}</div></article>`;
      });
      form.append(send);
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });
    await installDirectMainWorldSendWorker(harness);
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    const response: unknown = await chrome.tabs.sendMessage(tab.id, {
      type: "content.send",
      conversationId: CONVERSATION_ID,
      runId: FIRST_RUN_ID,
      prompt: "Explain the relay race.",
      allowFirstConversation: true,
      expectedProjectScope: PROJECT_SCOPE,
    });

    expect({
      response,
      sendClicks,
      submittedPrompts,
      composerText: composer.textContent,
    }).toMatchObject({
      response: { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION },
      sendClicks: 1,
      submittedPrompts: ["Explain the relay race."],
    });
    expect(requireElement('[data-message-author-role="user"]').textContent).toBe(
      "Explain the relay race.",
    );
  });

  it("preserves a multiline Context and returns its answer after one ProseMirror send", async () => {
    const { harness, socket, tab } = await startHarness();
    const prompt = "Context:\nalpha = 1\nbeta = 2\n\nQuestion:\nExplain the values.";
    document.body.innerHTML = `
      <main>
        <section id="thread"></section>
        <form data-type="unified-composer">
          <div class="ProseMirror" id="prompt-textarea" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Chat with ChatGPT"></div>
          <button type="button" data-testid="send-button" aria-label="Send prompt">Send</button>
        </form>
      </main>`;
    const thread = requireElement<HTMLElement>("#thread");
    const composer = requireElement<HTMLElement>("#prompt-textarea");
    const send = requireElement<HTMLButtonElement>('[data-testid="send-button"]');
    const bridge = installRunLifecycleBridgeFixture();
    let sendClicks = 0;
    const submittedPrompts: string[] = [];
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn((command: string, _showUi: boolean, value?: string) => {
        let paragraph = composer.querySelector("p");
        if (!paragraph) {
          paragraph = document.createElement("p");
          composer.append(paragraph);
        }
        if (command === "insertText") {
          if (value?.includes("\n")) {
            // Model the production regression: a bulk ProseMirror insert
            // flattens embedded line feeds. The fixed writer must never use it.
            paragraph.append(document.createTextNode(value.replace(/\n/gu, " ")));
          } else {
            paragraph.append(document.createTextNode(value ?? ""));
          }
        } else if (command === "insertLineBreak") {
          paragraph.append(document.createElement("br"));
        } else {
          throw new Error(`Unexpected native edit command: ${command}`);
        }
        composer.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: command, data: value ?? null }),
        );
        return true;
      }),
    });
    send.addEventListener("click", () => {
      sendClicks += 1;
      const submittedPrompt = readComposerText(composer);
      submittedPrompts.push(submittedPrompt);
      const renderedPrompt = singleBlockPromptPresentation(submittedPrompt);
      thread.innerHTML = `
        <article data-testid="conversation-turn-current-user">
          <div data-message-author-role="user">${escapeFixtureHtml(renderedPrompt)}</div>
        </article>
        <article data-testid="conversation-turn-current-assistant">
          <div data-message-author-role="assistant"><p>Multiline answer received.</p></div>
          <button type="button" aria-label="Copy response">Copy</button>
        </article>`;
      composer.replaceChildren();
      harness.setPrimaryDocumentUrl(REMOTE_A);
      harness.setTabUrl(tab.id, REMOTE_A);
      harness.emitTabUrlUpdated(tab.id, REMOTE_A);
      const runId = bridge.pendingRunId();
      if (!runId) throw new Error("Run lifecycle intent was not accepted before the send click.");
      bridge.emit(runId, "submitted");
      bridge.emit(runId, "response-started");
      bridge.emit(runId, "response-complete");
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    try {
      socket.deliverFromHost(
        makeEnvelope({
          type: "conversation.send",
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          runId: "run-multiline-context",
          payload: { prompt, messageId: "message-multiline-context" },
        }),
      );
      const complete = await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "generation.complete" && envelope.runId === "run-multiline-context",
        5_000,
      );

      expect(complete.payload).toMatchObject({ markdown: "Multiline answer received." });
      expect(sendClicks).toBe(1);
      expect(submittedPrompts).toEqual([prompt]);
      expect(runErrors(harness, socket, "run-multiline-context")).toHaveLength(0);
    } finally {
      bridge.dispose();
    }
  }, 8_000);

  it("sends from the real follow-up ProseMirror inside ChatGPT's pointer-events shell", async () => {
    const { harness, socket, tab } = await startHarness();
    document.body.innerHTML = `
      <main>
        <section id="thread"></section>
        <div id="thread-bottom-container" style="pointer-events: none">
          <div class="pointer-events-auto" style="pointer-events: auto">
            <form data-type="unified-composer">
              <div
                class="ProseMirror"
                id="prompt-textarea"
                contenteditable="true"
                role="textbox"
                aria-multiline="true"
                aria-label="与 ChatGPT 聊天"
              ></div>
              <textarea
                class="wcDTda_fallbackTextarea"
                name="prompt-textarea"
                style="display: none"
              ></textarea>
            </form>
          </div>
        </div>
      </main>`;
    const thread = requireElement<HTMLElement>("#thread");
    const composer = requireElement<HTMLElement>("#prompt-textarea");
    const fallback = requireElement<HTMLTextAreaElement>('textarea[name="prompt-textarea"]');
    const form = requireElement<HTMLFormElement>('form[data-type="unified-composer"]');
    const bridge = installRunLifecycleBridgeFixture();
    let sendClicks = 0;
    const submittedPrompts: string[] = [];
    const submit = () => {
      sendClicks += 1;
      const submittedPrompt = readComposerText(composer);
      submittedPrompts.push(submittedPrompt);
      thread.innerHTML = `
        <article data-testid="conversation-turn-current-user">
          <div data-message-author-role="user">${escapeFixtureHtml(submittedPrompt)}</div>
        </article>
        <article data-testid="conversation-turn-current-assistant">
          <div data-message-author-role="assistant"><p>Follow-up answer received.</p></div>
          <button type="button" aria-label="Copy response">Copy</button>
        </article>`;
      composer.replaceChildren();
      harness.setPrimaryDocumentUrl(REMOTE_A);
      harness.setTabUrl(tab.id, REMOTE_A);
      harness.emitTabUrlUpdated(tab.id, REMOTE_A);
      const runId = bridge.pendingRunId();
      if (!runId) throw new Error("Run lifecycle intent was not accepted before the send click.");
      bridge.emit(runId, "submitted");
      bridge.emit(runId, "response-started");
      bridge.emit(runId, "response-complete");
    };
    composer.addEventListener("input", () => {
      if (form.querySelector('[data-testid="send-button"]')) return;
      const send = document.createElement("button");
      send.type = "button";
      send.dataset.testid = "send-button";
      send.setAttribute("aria-label", "Send prompt");
      send.addEventListener("click", submit);
      form.append(send);
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn((command: string, _showUi: boolean, value?: string) => {
        if (command !== "insertText") return false;
        let paragraph = composer.querySelector("p");
        if (!paragraph) {
          paragraph = document.createElement("p");
          composer.append(paragraph);
        }
        paragraph.append(document.createTextNode(value ?? ""));
        composer.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: command, data: value ?? null }),
        );
        return true;
      }),
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    await expect(
      chrome.tabs.sendMessage(tab.id, { type: "content.composerStatus" }),
    ).resolves.toMatchObject({
      ok: true,
      ready: true,
      rawCandidateCount: 2,
      readyCandidateCount: 1,
      selectorVersion: CONTENT_RUNTIME_REVISION,
    });

    // Match the observed post-turn DOM: an outer fixed shell disables pointer
    // events, the inner composer restores them, and a hidden writable fallback
    // textarea shares the form. Only the visible ProseMirror may be written.
    socket.deliverFromHost(sendEnvelope("run-real-follow-up-composer"));
    try {
      const complete = await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "generation.complete" &&
          envelope.runId === "run-real-follow-up-composer",
        5_000,
      );

      expect(complete.payload).toMatchObject({ markdown: "Follow-up answer received." });
      expect(sendClicks).toBe(1);
      expect(submittedPrompts).toEqual(["Explain the relay race."]);
      expect(fallback.value).toBe("");
      expect(runErrors(harness, socket, "run-real-follow-up-composer")).toHaveLength(0);
    } finally {
      bridge.dispose();
    }
  }, 8_000);

  it("confirms an asynchronously inserted user turn without timer polling", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, {
      autoCanonicalize: false,
      submissionMode: "form",
    });
    const composer = requireElement<HTMLTextAreaElement>("#prompt-textarea");
    const thread = requireElement<HTMLElement>("#thread");
    requireElement<HTMLButtonElement>('[data-testid="send-button"]').addEventListener(
      "click",
      () => {
        queueMicrotask(() => {
          thread.innerHTML = primaryConversationMarkup("complete", true, composer.value);
          harness.setPrimaryDocumentUrl(REMOTE_A);
          harness.setTabUrl(tab.id, REMOTE_A);
          harness.emitTabUrlUpdated(tab.id, REMOTE_A);
        });
      },
    );
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    const originalSetTimeout = window.setTimeout.bind(window);
    let hundredMillisecondPolls = 0;
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 100) hundredMillisecondPolls += 1;
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout;
    try {
      socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
      await harness.waitForEnvelope(
        socket,
        (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
        4_000,
      );
    } finally {
      window.setTimeout = originalSetTimeout as typeof window.setTimeout;
    }

    expect(hundredMillisecondPolls).toBe(0);
    expect(page.sendClicks()).toBe(1);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 8_000);

  it("waits for a follow-up controlled-editor commit and clicks only the replacement button", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id);
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );
    await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.snapshot" &&
        (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_B,
      5_000,
    );

    page.deferNextControlledCommit();
    socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_B));
    const followUp = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
      5_000,
    );

    expect(followUp.payload).toMatchObject({ markdown: "Follow-up answer on canonical B" });
    expect(page.staleSendClicks()).toBe(0);
    expect(page.sendClicks()).toBe(2);
    expect(page.formSubmits()).toBe(0);
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
  }, 12_000);

  it("rewrites the prompt when a delayed controlled-editor commit replaces the composer", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id);
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    page.replaceComposerOnNextCommit();
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );

    expect(page.composerReplacements()).toBe(1);
    expect(page.sendClicks()).toBe(1);
    expect(page.staleSendClicks()).toBe(0);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 8_000);

  it("adopts a replacement composer that already preserves the complete prompt", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id);
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    page.replaceComposerWithFullPromptAfterEveryCommit();
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );

    expect(page.composerReplacements()).toBe(1);
    expect(page.sendClicks()).toBe(1);
    expect(page.staleSendClicks()).toBe(0);
    expect(page.formSubmits()).toBe(0);
    expect(requireElement('[data-message-author-role="user"]').textContent).toBe(
      "Explain the relay race.",
    );
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 8_000);

  it("submits once when the controlled editor renders ordinary spaces as non-breaking spaces", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id);
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    page.replaceComposerWithRenderedEquivalentPromptAfterEveryCommit();
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );

    expect(page.composerReplacements()).toBe(1);
    expect(page.sendClicks()).toBe(1);
    expect(page.staleSendClicks()).toBe(0);
    expect(page.formSubmits()).toBe(0);
    expect(page.submittedPrompts()).toEqual(["Explain the relay race."]);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 8_000);

  it("uses the new send control when React replaces the complete composer form", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id);
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    page.replaceComposerFormWithFullPromptOnNextCommit();
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );

    expect(page.composerReplacements()).toBe(1);
    expect(page.sendClicks()).toBe(1);
    expect(page.staleSendClicks()).toBe(0);
    expect(page.formSubmits()).toBe(0);
    expect(requireElement('[data-message-author-role="user"]').textContent).toBe(
      "Explain the relay race.",
    );
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 8_000);

  it("ignores a transition composer inside an aria-hidden ancestor", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id);
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    page.addAriaHiddenComposerClone();
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );

    expect(page.sendClicks()).toBe(1);
    expect(page.formSubmits()).toBe(0);
    expect(page.submittedPrompts()).toEqual(["Explain the relay race."]);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 8_000);

  it("does not use a page-wide send control for a visible transition composer outside the form", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id);
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    page.showOnlyTransitionComposerOutsideForm();
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    const error = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "relay.error" && envelope.runId === FIRST_RUN_ID,
      12_000,
    );

    expect(error.payload).toMatchObject({ code: "SELECTOR_INCOMPATIBLE" });
    expect((error.payload as { message?: string }).message).toMatch(
      /raw=2 ready=0 visibility=visible/u,
    );
    expect(page.sendClicks()).toBe(0);
    expect(page.formSubmits()).toBe(0);
    expect(page.submittedPrompts()).toHaveLength(0);
  }, 15_000);

  it("revalidates the complete prompt after the page accepts the run intent", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id);
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    page.corruptComposerOnRunIntent();
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    const error = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "relay.error" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );

    expect(error.payload).toMatchObject({ code: "SELECTOR_INCOMPATIBLE" });
    expect(page.sendClicks()).toBe(0);
    expect(page.formSubmits()).toBe(0);
    expect(page.submittedPrompts()).toHaveLength(0);
  }, 8_000);

  it("rejects replacement composers whose text is not the complete prompt", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id);
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    page.replaceComposerWithCorruptedPromptAfterEveryCommit();
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    const error = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "relay.error" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );

    expect(error.payload).toMatchObject({ code: "SELECTOR_INCOMPATIBLE" });
    expect(page.sendClicks()).toBe(0);
    expect(page.formSubmits()).toBe(0);
    expect(page.submittedPrompts()).toHaveLength(0);
  }, 8_000);

  it("rejects false submission signals without retrying or adopting unrelated turns", async () => {
    const runId = "run-false-submission-signals";
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, {
      falseSubmissionSignals: true,
      autoCanonicalize: false,
    });
    const bridge = installRunLifecycleBridgeFixture();
    let contentSendResponse: unknown;
    harness.afterTabMessage = async (messageTabId, message, response) => {
      if (messageTabId === tab.id && isMessageType(message, "content.send")) {
        contentSendResponse = response;
      }
    };
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    requireElement<HTMLButtonElement>('[data-testid="send-button"]').addEventListener(
      "click",
      () => {
        const runId = bridge.pendingRunId();
        if (runId) bridge.emit(runId, "submitted");
      },
    );

    socket.deliverFromHost(sendEnvelope(runId));
    await waitUntil(() => page.sendClicks() === 1, 5_000);
    await waitUntil(
      () =>
        harness.timeline.filter(
          (entry) => entry === `tabs.sendMessage:response:${tab.id}:content.send`,
        ).length === 1,
      12_000,
    );

    expect(page.sendClicks()).toBe(1);
    expect(page.formSubmits()).toBe(0);
    expect(contentSendResponse).toMatchObject({ ok: false, ambiguousSubmission: true });
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ phase?: string; runId?: string }> | undefined
        )?.some((run) => run.runId === runId && run.phase === "active") === true,
      5_000,
    );
    expect(runErrors(harness, socket, runId)).toHaveLength(0);
    expect(
      (harness.sessionValue("activeRunsV2") as Array<{ runId?: string }> | undefined)?.some(
        (run) => run.runId === runId,
      ),
    ).toBe(true);
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) =>
            envelope.runId === runId &&
            ["generation.snapshot", "generation.complete"].includes(envelope.type),
        ),
    ).toBe(false);
  }, 16_000);

  it("keeps a rejected content.send response in read-only recovery with its run identity", async () => {
    const { harness, socket, tab } = await startHarness();
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.send")) return { ok: false };
      return { ok: false };
    });

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
    );
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
      ),
    ).toHaveLength(1);
  });

  it("terminates a definitively rejected content.send when the separate error event is lost", async () => {
    const { harness, socket, tab } = await startHarness();
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.send")) {
        return {
          ok: false,
          definitiveFailure: true,
          error: {
            code: "CHATGPT_REMOTE_UNAVAILABLE",
            message: "The conversation page changed before submission.",
          },
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    const error = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "relay.error" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );

    expect(error.payload).toMatchObject({ code: "CHATGPT_REMOTE_UNAVAILABLE" });
    expect((error.payload as { message?: string }).message).toContain(
      "The conversation page changed before submission.",
    );
    expect(
      (harness.sessionValue("activeRunsV2") as Array<{ runId?: string }> | undefined)?.some(
        (run) => run.runId === FIRST_RUN_ID,
      ),
    ).toBe(false);
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
      ),
    ).toHaveLength(1);
  });

  it("persists and replays a pre-dispatch terminal error when its first relay send fails", async () => {
    const { harness, socket, tab } = await startHarness({ acknowledgeTerminals: false });
    let statusChecks = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        statusChecks += 1;
        return {
          ok: true,
          ready: false,
          rawCandidateCount: 1,
          readyCandidateCount: 0,
          visibilityState: "visible",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });
    socket.failNextSendOfType("relay.error");

    vi.useFakeTimers();
    try {
      socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
      await vi.waitFor(() => expect(statusChecks).toBeGreaterThanOrEqual(2));
      await vi.advanceTimersByTimeAsync(15_500);
      await vi.waitFor(() =>
        expect(
          (
            harness.sessionValue("pendingEventsV2") as
              Array<{ event?: { eventType?: string; runId?: string } }> | undefined
          )?.some(
            (pending) =>
              pending.event?.eventType === "error" && pending.event.runId === FIRST_RUN_ID,
          ),
        ).toBe(true),
      );
    } finally {
      vi.useRealTimers();
    }
    const pendingBeforeReconnect = (
      harness.sessionValue("pendingEventsV2") as
        Array<{ eventId?: string; event?: { eventType?: string; runId?: string } }> | undefined
    )?.find(
      (pending) => pending.event?.eventType === "error" && pending.event.runId === FIRST_RUN_ID,
    );
    expect(pendingBeforeReconnect?.eventId).toEqual(expect.any(String));

    socket.close(1006, "simulated terminal error transport loss");
    await waitUntil(() => harness.socketsForPort().length >= 2);
    const replacement = harness.socketsForPort().at(-1)!;
    await connectFakeVsCodeHost(harness, replacement, { acknowledgeTerminals: false });
    const replayed = await harness.waitForEnvelope(
      replacement,
      (envelope) => envelope.type === "relay.error" && envelope.runId === FIRST_RUN_ID,
    );
    expect(replayed.payload).toMatchObject({ code: "SELECTOR_INCOMPATIBLE" });
    expect(replayed.id).toBe(pendingBeforeReconnect!.eventId);
    replacement.deliverFromHost(
      makeEnvelope({
        type: "generation.ack",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        runId: FIRST_RUN_ID,
        payload: { eventId: replayed.id, acknowledgedAt: new Date().toISOString() },
      }),
    );
    await waitUntil(
      () =>
        !(harness.sessionValue("pendingEventsV2") as Array<{ eventId?: string }> | undefined)?.some(
          (pending) => pending.eventId === replayed.id,
        ),
    );
  }, 10_000);

  it("does not recover a run while its terminal error is committing across reconnect", async () => {
    const { harness, socket, tab } = await startHarness({ acknowledgeTerminals: false });
    let statusChecks = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        statusChecks += 1;
        return {
          ok: true,
          ready: false,
          rawCandidateCount: 1,
          readyCandidateCount: 0,
          visibilityState: "visible",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });

    vi.useFakeTimers();
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await vi.waitFor(() => expect(statusChecks).toBeGreaterThanOrEqual(2));
    const terminalWriteBarrier = harness.pauseNextSessionWrite(
      (values) => Array.isArray(values.pendingEventsV2) && values.pendingEventsV2.length > 0,
    );
    try {
      await vi.advanceTimersByTimeAsync(15_500);
      await terminalWriteBarrier.entered;
      vi.useRealTimers();
      socket.close(1006, "terminal commit transport race");
      await waitUntil(() => harness.socketsForPort().length >= 2);
      const replacement = harness.socketsForPort().at(-1)!;
      await connectFakeVsCodeHost(harness, replacement, { acknowledgeTerminals: false });

      expect(harness.timeline.some((entry) => entry.includes("content.recover"))).toBe(false);
      terminalWriteBarrier.release();
      const replayed = await harness.waitForEnvelope(
        replacement,
        (envelope) => envelope.type === "relay.error" && envelope.runId === FIRST_RUN_ID,
      );
      expect(replayed.payload).toMatchObject({ code: "SELECTOR_INCOMPATIBLE" });
    } finally {
      vi.useRealTimers();
      terminalWriteBarrier.release();
    }
  }, 10_000);

  it("treats an identical active conversation.send replay as idempotent", async () => {
    const { harness, socket, tab } = await startHarness({ acknowledgeTerminals: false });
    let sendCount = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: PROJECT_ROOT,
          complete: true,
          messages: [],
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCount += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });
    await waitUntil(() =>
      harness.timeline.includes(`tabs.sendMessage:response:${tab.id}:content.inspectConversation`),
    );

    const request = sendEnvelope(FIRST_RUN_ID);
    socket.deliverFromHost(request);
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
    );
    socket.deliverFromHost(request);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sendCount).toBe(1);
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
      ),
    ).toHaveLength(1);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  });

  it("replays a pending terminal for a duplicate conversation.send without resending", async () => {
    const { harness, socket, tab } = await startHarness({ acknowledgeTerminals: false });
    let sendCount = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: PROJECT_ROOT,
          complete: true,
          messages: [],
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCount += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });
    await harness.importContentScript(tab.id, async () => undefined);
    await waitUntil(() =>
      harness.timeline.includes(`tabs.sendMessage:response:${tab.id}:content.inspectConversation`),
    );

    const request = sendEnvelope(FIRST_RUN_ID);
    socket.deliverFromHost(request);
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
    );
    const terminalRequest = chrome.runtime.sendMessage({
      type: "content.event",
      eventType: "error",
      conversationId: CONVERSATION_ID,
      runId: FIRST_RUN_ID,
      error: {
        code: "SELECTOR_INCOMPATIBLE",
        message: "Synthetic terminal for duplicate replay coverage.",
        recoverable: true,
        focusTab: false,
      },
    });
    const firstError = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "relay.error" && envelope.runId === FIRST_RUN_ID,
    );
    await expect(terminalRequest).resolves.toEqual({ ok: true });
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(1);
    socket.deliverFromHost(request);
    await waitUntil(() => runErrors(harness, socket, FIRST_RUN_ID).length >= 2);

    expect(sendCount).toBe(1);
    expect(
      new Set(runErrors(harness, socket, FIRST_RUN_ID).map((envelope) => envelope.id)),
    ).toEqual(new Set([firstError.id]));
  });

  it("never retries an ambiguously delivered content.regenerate click", async () => {
    const { harness, socket, tab } = await startHarness({ acknowledgeTerminals: false });
    let regenerateCount = 0;
    let recoverCount = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: harness.tabsById.get(tab.id)?.url,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: harness.tabsById.get(tab.id)?.url,
          complete: true,
          messages: [
            { role: "user", markdown: "Explain the relay race." },
            { role: "assistant", markdown: "Previous answer" },
          ],
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.regenerate")) {
        regenerateCount += 1;
        throw new Error("The message port closed before a response was received.");
      }
      if (isMessageType(message, "content.recover")) {
        recoverCount += 1;
        return {
          ok: true,
          active: true,
          matchedActiveRun: true,
          markdown: "",
          remoteUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });
    await waitUntil(() =>
      harness.timeline.includes(`tabs.sendMessage:response:${tab.id}:content.inspectConversation`),
    );
    harness.setTabUrl(tab.id, REMOTE_A);

    socket.deliverFromHost(regenerateEnvelope(FIRST_RUN_ID, REMOTE_A));
    await waitUntil(() => recoverCount === 1);
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
    );

    expect(regenerateCount).toBe(1);
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.regenerate`,
      ),
    ).toHaveLength(1);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  });

  it("revalidates an idle stable baseline once after parking its hidden tab", async () => {
    const { harness, socket, tab } = await startHarness();
    let sendCount = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: PROJECT_ROOT,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.composerStatus")) {
        return {
          ok: true,
          ready: true,
          rawCandidateCount: 1,
          readyCandidateCount: 1,
          visibilityState: harness.tabsById.get(tab.id!)?.active ? "visible" : "hidden",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: PROJECT_ROOT,
          complete: true,
          historyComplete: true,
          messages: [],
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCount += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });
    const inspectionEntry = `tabs.sendMessage:request:${tab.id}:content.inspectConversation`;
    await waitUntil(
      () => harness.timeline.filter((entry) => entry === inspectionEntry).length >= 3,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const inspectionsBeforeSend = harness.timeline.filter(
      (entry) => entry === inspectionEntry,
    ).length;

    socket.deliverFromHost(sendEnvelope("run-prewarmed-dispatch-baseline"));
    await waitUntil(() => sendCount === 1);

    // The idle prewarm already captured two equal candidates. The run must
    // inspect exactly once more and match that prepared baseline before send.
    expect(
      harness.timeline.filter((entry) => entry === inspectionEntry).length - inspectionsBeforeSend,
    ).toBe(1);
    expect(runErrors(harness, socket, "run-prewarmed-dispatch-baseline")).toHaveLength(0);
  });

  it("waits for a newly opened tab transcript to hydrate before sending", async () => {
    const { harness, socket, tab } = await startHarness();
    let dispatchStarted = false;
    let dispatchInspectCount = 0;
    let sendCount = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: PROJECT_ROOT,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.composerStatus")) {
        return {
          ok: true,
          ready: true,
          rawCandidateCount: 1,
          readyCandidateCount: 1,
          visibilityState: harness.tabsById.get(tab.id)?.active ? "visible" : "hidden",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        if (!dispatchStarted) {
          return {
            ok: true,
            remoteUrl: PROJECT_ROOT,
            complete: true,
            historyComplete: true,
            messages: [],
            observedAt: new Date().toISOString(),
            selectorVersion: CONTENT_RUNTIME_REVISION,
          };
        }
        dispatchInspectCount += 1;
        const hydrated = dispatchInspectCount >= 2;
        return {
          ok: true,
          remoteUrl: PROJECT_ROOT,
          complete: hydrated,
          historyComplete: hydrated,
          messages: [],
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCount += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });
    await waitUntil(() =>
      harness.timeline.includes(`tabs.sendMessage:response:${tab.id}:content.inspectConversation`),
    );

    dispatchStarted = true;
    socket.deliverFromHost(sendEnvelope("run-hydrating-dispatch-baseline"));
    await waitUntil(() => sendCount === 1);

    expect(dispatchInspectCount).toBeGreaterThanOrEqual(3);
    expect(sendCount).toBe(1);
    expect(runErrors(harness, socket, "run-hydrating-dispatch-baseline")).toHaveLength(0);
  });

  it("does not send when a complete durable pre-dispatch transcript cannot be captured", async () => {
    const { harness, socket, tab } = await startHarness();
    let sendCount = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: PROJECT_ROOT,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.composerStatus")) {
        return {
          ok: true,
          ready: true,
          rawCandidateCount: 1,
          readyCandidateCount: 1,
          visibilityState: "visible",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: PROJECT_ROOT,
          complete: false,
          historyComplete: false,
          messages: [],
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCount += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });

    socket.deliverFromHost(sendEnvelope("run-incomplete-dispatch-baseline"));
    const error = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "relay.error" && envelope.runId === "run-incomplete-dispatch-baseline",
      5_000,
    );
    expect(error.payload).toMatchObject({ code: "CHATGPT_REMOTE_UNAVAILABLE" });
    expect((error.payload as { message?: string }).message).toContain("was not sent");
    expect(sendCount).toBe(0);
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
      ),
    ).toHaveLength(0);
  });

  it("never replays an ambiguously delivered content.send and recovers the active run", async () => {
    const { harness, socket, tab } = await startHarness();
    let sendCount = 0;
    let recoverCount = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: harness.tabsById.get(tab.id)?.url,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCount += 1;
        // The command reached the content side, but its response channel was
        // lost. Replaying this non-idempotent message could submit twice.
        throw new Error("The message port closed before a response was received.");
      }
      if (isMessageType(message, "content.recover")) {
        recoverCount += 1;
        return {
          ok: true,
          active: true,
          matchedActiveRun: true,
          markdown: "",
          remoteUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });

    // Let the conversation.open issued by startHarness finish on the Project
    // root before moving the fake owned tab to an existing conversation.
    await waitUntil(() =>
      harness.timeline.includes(`tabs.sendMessage:response:${tab.id}:content.inspectConversation`),
    );
    harness.setTabUrl(tab.id, REMOTE_A);
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID, REMOTE_A));

    await waitUntil(() => recoverCount === 1);
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
    );

    expect(sendCount).toBe(1);
    expect(recoverCount).toBe(1);
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
      ),
    ).toHaveLength(1);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);

    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.close",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        payload: { closeTab: false },
      }),
    );
    await waitUntil(
      () =>
        !(harness.sessionValue("activeRunsV2") as Array<{ runId?: string }> | undefined)?.some(
          (run) => run.runId === FIRST_RUN_ID,
        ),
    );
  });

  it("settles a throttled active follow-up only from its exact completed transcript", async () => {
    const { harness, socket, tab } = await startHarness();
    const baselineMessages = [
      { role: "user" as const, markdown: "Earlier question" },
      { role: "assistant" as const, markdown: "Earlier answer" },
    ];
    let sendCount = 0;
    let recoverCount = 0;
    let terminalInspectCount = 0;
    let submitted = false;
    let terminalPrompt = "An unrelated manual question.";
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: harness.tabsById.get(tab.id)?.url,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        if (!submitted) {
          const remoteUrl = harness.tabsById.get(tab.id)?.url;
          return {
            ok: true,
            remoteUrl,
            complete: true,
            messages: remoteUrl === REMOTE_A ? baselineMessages : [],
            observedAt: new Date().toISOString(),
            selectorVersion: CONTENT_RUNTIME_REVISION,
          };
        }
        terminalInspectCount += 1;
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          title: "Exact follow-up",
          complete: true,
          messages: [
            ...baselineMessages,
            { role: "user", markdown: terminalPrompt },
            { role: "assistant", markdown: "Final answer from the throttled tab" },
          ],
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCount += 1;
        submitted = true;
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.recover")) {
        recoverCount += 1;
        return {
          ok: true,
          active: true,
          matchedActiveRun: true,
          markdown: "",
          remoteUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });
    await waitUntil(() =>
      harness.timeline.includes(`tabs.sendMessage:response:${tab.id}:content.inspectConversation`),
    );
    harness.setTabUrl(tab.id, REMOTE_A);

    socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_A));
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === SECOND_RUN_ID && run.phase === "active") === true,
    );
    await waitUntil(() => recoverCount >= 1 && terminalInspectCount >= 1, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
        ),
    ).toBe(false);

    terminalPrompt = "Explain the relay race.";
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
      5_000,
    );
    expect(complete.payload).toMatchObject({
      markdown: "Final answer from the throttled tab",
      remoteUrl: REMOTE_A,
    });
    expect(sendCount).toBe(1);
    expect(recoverCount).toBeGreaterThanOrEqual(2);
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
  }, 8_000);

  it("reloads one hidden partial response from the exact transcript instead of completing the prefix", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const tab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create the recovery tab.");
    const decoy = await chrome.tabs.create({ url: "https://example.test/user-tab", active: true });
    if (decoy.id === undefined) throw new Error("Fake Chrome did not create the user tab.");

    const startedAt = new Date(Date.now() - 8_000).toISOString();
    const baselineMessages = [
      { role: "user" as const, markdown: "Earlier question" },
      { role: "assistant" as const, markdown: "Earlier answer" },
    ];
    const transcriptSha256 = await sha256FixtureHex(
      JSON.stringify(baselineMessages.map((message) => [message.role, message.markdown])),
    );
    let reloaded = false;
    let hydratedWhileRelayTabActive = false;
    let recoverCount = 0;
    let sendCount = 0;
    harness.beforeTabReload = (tabId) => {
      expect(tabId).toBe(tab.id);
      reloaded = true;
    };
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.recover")) {
        recoverCount += 1;
        return {
          ok: true,
          active: true,
          matchedActiveRun: true,
          markdown: "Part 1",
          remoteUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
          runLifecycle: {
            documentVisible: false,
            intentAccepted: true,
            submissionConfirmed: true,
            networkSubmitted: true,
            networkResponseStarted: true,
            networkResponseComplete: true,
            networkResponseCompleteAgeMs: 5_000,
            userTurnObserved: true,
            responseAttributed: true,
            responseObserved: true,
            responseActionsPresent: false,
            stopVisible: false,
            sawStop: false,
            assistantAfterUser: true,
          },
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        const hydrated = reloaded && harness.tabsById.get(tab.id!)?.active === true;
        hydratedWhileRelayTabActive ||= hydrated;
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          title: "Hidden partial recovery",
          complete: hydrated,
          historyComplete: true,
          messages: reloaded
            ? [
                ...baselineMessages,
                { role: "user" as const, markdown: "Explain the relay race." },
                { role: "assistant" as const, markdown: "Part 1 Part 2" },
              ]
            : baselineMessages,
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCount += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });
    harness.seedSessionValue("conversationTabsV2", [
      {
        owned: true,
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        tabId: tab.id,
        remoteUrl: REMOTE_A,
        projectScope: PROJECT_SCOPE,
        createdAt: startedAt,
      },
    ]);
    harness.seedSessionValue("activeRunsV2", [
      {
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        runId: SECOND_RUN_ID,
        tabId: tab.id,
        phase: "active",
        remoteAdoptionStage: "locked",
        promptSha256: FIRST_PROMPT_SHA256,
        dispatchTranscriptBaseline: {
          tabId: tab.id,
          remoteUrl: REMOTE_A,
          messageCount: baselineMessages.length,
          transcriptSha256,
        },
        startedAt,
      },
    ]);

    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket, { acknowledgeTerminals: false });
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
      8_000,
    );

    expect(complete.payload).toMatchObject({ markdown: "Part 1 Part 2", remoteUrl: REMOTE_A });
    expect(
      harness
        .outboundEnvelopes(socket)
        .filter(
          (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
        )
        .map((envelope) => (envelope.payload as { markdown?: string }).markdown),
    ).toEqual(["Part 1 Part 2"]);
    expect(recoverCount).toBe(1);
    expect(sendCount).toBe(0);
    expect(harness.timeline.filter((entry) => entry === `tabs.reload:${tab.id}`)).toHaveLength(1);
    expect(hydratedWhileRelayTabActive).toBe(true);
    expect(harness.tabsById.get(decoy.id)?.active).toBe(true);
    expect(harness.tabsById.get(tab.id)?.active).toBe(false);
    expect(harness.timeline.filter((entry) => entry.includes(":content.send"))).toHaveLength(0);
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
  }, 12_000);

  it("recovers a minimized tab when refresh briefly exposes the Project root", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const tab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create the recovery tab.");
    const decoy = await chrome.tabs.create({
      url: "https://example.test/minimized-user-tab",
      active: true,
    });
    if (decoy.id === undefined) throw new Error("Fake Chrome did not create the user tab.");
    harness.setWindowFocused(tab.windowId, false);
    harness.setWindowState(tab.windowId, "minimized");

    const startedAt = new Date(Date.now() - 8_000).toISOString();
    const baselineMessages = [
      { role: "user" as const, markdown: "Earlier question" },
      { role: "assistant" as const, markdown: "Earlier answer" },
    ];
    const transcriptSha256 = await sha256FixtureHex(
      JSON.stringify(baselineMessages.map((message) => [message.role, message.markdown])),
    );
    let reloaded = false;
    let recoverCount = 0;
    harness.beforeTabReload = (tabId) => {
      expect(tabId).toBe(tab.id);
      reloaded = true;
      // ChatGPT can briefly expose the Project home route while a minimized
      // document is rebuilding. The transcript below is still the exact
      // conversation that owns this run.
      harness.setTabUrl(tab.id!, PROJECT_ROOT);
    };
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.recover")) {
        recoverCount += 1;
        return {
          ok: true,
          active: true,
          matchedActiveRun: true,
          markdown: "Part 1",
          remoteUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
          runLifecycle: {
            documentVisible: false,
            intentAccepted: true,
            submissionConfirmed: true,
            networkSubmitted: true,
            networkResponseStarted: true,
            networkResponseComplete: true,
            networkResponseCompleteAgeMs: 5_000,
            userTurnObserved: true,
            responseAttributed: true,
            responseObserved: true,
            responseActionsPresent: false,
            stopVisible: false,
            sawStop: false,
            assistantAfterUser: true,
          },
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          title: "Minimized exact recovery",
          complete: reloaded,
          historyComplete: true,
          messages: reloaded
            ? [
                ...baselineMessages,
                { role: "user" as const, markdown: "Explain the relay race." },
                { role: "assistant" as const, markdown: "Part 1 Part 2" },
              ]
            : baselineMessages,
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });
    harness.seedSessionValue("conversationTabsV2", [
      {
        owned: true,
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        tabId: tab.id,
        remoteUrl: REMOTE_A,
        projectScope: PROJECT_SCOPE,
        createdAt: startedAt,
      },
    ]);
    harness.seedSessionValue("activeRunsV2", [
      {
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        runId: SECOND_RUN_ID,
        tabId: tab.id,
        phase: "active",
        remoteAdoptionStage: "locked",
        promptSha256: FIRST_PROMPT_SHA256,
        dispatchTranscriptBaseline: {
          tabId: tab.id,
          remoteUrl: REMOTE_A,
          messageCount: baselineMessages.length,
          transcriptSha256,
        },
        startedAt,
      },
    ]);

    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket, { acknowledgeTerminals: false });
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
      10_000,
    );

    expect(complete.payload).toMatchObject({ markdown: "Part 1 Part 2", remoteUrl: REMOTE_A });
    expect(recoverCount).toBeGreaterThanOrEqual(1);
    expect(harness.timeline.filter((entry) => entry === `tabs.reload:${tab.id}`)).toHaveLength(1);
    expect(harness.tabsById.get(decoy.id)?.active).toBe(true);
    expect(harness.tabsById.get(tab.id)?.active).toBe(false);
    expect((await chrome.windows.get(tab.windowId)).state).toBe("minimized");
    expect(harness.timeline).not.toContain(`window-updated:${tab.windowId}:state:normal`);
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
  }, 15_000);

  it("recovers an externally reloaded repeated prompt only from the exact expanded transcript", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const tab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create the recovery tab.");

    const startedAt = new Date(Date.now() - 8_000).toISOString();
    const baselineMessages = [
      { role: "user" as const, markdown: "Explain the relay race." },
      { role: "assistant" as const, markdown: "Earlier answer to the repeated prompt" },
    ];
    const transcriptSha256 = await sha256FixtureHex(
      JSON.stringify(baselineMessages.map((message) => [message.role, message.markdown])),
    );
    let reloaded = false;
    let recoverCount = 0;
    let sendCount = 0;
    harness.beforeTabReload = (tabId) => {
      expect(tabId).toBe(tab.id);
      reloaded = true;
    };
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.recover")) {
        recoverCount += 1;
        return {
          ok: true,
          active: false,
          recoveryTurnMatched: true,
          markdown: "Part 1",
          remoteUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          title: "External reload recovery",
          complete: reloaded,
          historyComplete: true,
          messages: [
            ...baselineMessages,
            { role: "user" as const, markdown: "Explain the relay race." },
            {
              role: "assistant" as const,
              markdown: reloaded ? "Part 1 Part 2" : "Part 1",
            },
          ],
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCount += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });
    harness.seedSessionValue("conversationTabsV2", [
      {
        owned: true,
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        tabId: tab.id,
        remoteUrl: REMOTE_A,
        projectScope: PROJECT_SCOPE,
        createdAt: startedAt,
      },
    ]);
    harness.seedSessionValue("activeRunsV2", [
      {
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        runId: SECOND_RUN_ID,
        tabId: tab.id,
        phase: "active",
        remoteAdoptionStage: "locked",
        promptSha256: FIRST_PROMPT_SHA256,
        dispatchTranscriptBaseline: {
          tabId: tab.id,
          remoteUrl: REMOTE_A,
          messageCount: baselineMessages.length,
          transcriptSha256,
        },
        startedAt,
      },
    ]);

    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket, { acknowledgeTerminals: false });
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
      8_000,
    );

    expect(complete.payload).toMatchObject({ markdown: "Part 1 Part 2", remoteUrl: REMOTE_A });
    expect(
      harness
        .outboundEnvelopes(socket)
        .filter(
          (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
        )
        .map((envelope) => (envelope.payload as { markdown?: string }).markdown),
    ).toEqual(["Part 1 Part 2"]);
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) =>
            envelope.type === "generation.snapshot" &&
            envelope.runId === SECOND_RUN_ID &&
            (envelope.payload as { markdown?: string }).markdown === "Part 1",
        ),
    ).toBe(false);
    expect(recoverCount).toBe(1);
    expect(sendCount).toBe(0);
    expect(harness.timeline.filter((entry) => entry === `tabs.reload:${tab.id}`)).toHaveLength(1);
    expect(harness.timeline.filter((entry) => entry.includes(":content.send"))).toHaveLength(0);
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
  }, 12_000);

  it("fails closed after external reload when no durable transcript baseline exists", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const tab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create the recovery tab.");
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    harness.installTabMessageResponder(tab.id, (message) =>
      isMessageType(message, "content.recover")
        ? {
            ok: true,
            active: false,
            recoveryTurnMatched: true,
            markdown: "An unverified old or partial answer",
            remoteUrl: REMOTE_A,
            selectorVersion: CONTENT_RUNTIME_REVISION,
          }
        : { ok: false },
    );
    harness.seedSessionValue("conversationTabsV2", [
      {
        owned: true,
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        tabId: tab.id,
        remoteUrl: REMOTE_A,
        projectScope: PROJECT_SCOPE,
        createdAt: startedAt,
      },
    ]);
    harness.seedSessionValue("activeRunsV2", [
      {
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        runId: SECOND_RUN_ID,
        tabId: tab.id,
        phase: "active",
        remoteAdoptionStage: "locked",
        promptSha256: FIRST_PROMPT_SHA256,
        startedAt,
      },
    ]);

    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket, { acknowledgeTerminals: false });
    const error = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "relay.error" && envelope.runId === SECOND_RUN_ID,
      5_000,
    );
    expect(error.payload).toMatchObject({ code: "CHATGPT_REMOTE_UNAVAILABLE" });
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
        ),
    ).toBe(false);
    expect(harness.timeline.filter((entry) => entry.includes(":content.send"))).toHaveLength(0);
    expect(harness.timeline.filter((entry) => entry === `tabs.reload:${tab.id}`)).toHaveLength(0);
  }, 8_000);

  it("reloads only the exact mapped tab for a stale pre-dispatch content runtime", async () => {
    const { harness, socket, tab } = await startHarness();
    const decoy = await chrome.tabs.create({ url: REMOTE_C, active: false });
    if (decoy.id === undefined) throw new Error("Fake Chrome did not create a decoy tab.");
    let staleRuntime = false;
    let mappedSendCount = 0;
    let decoyMessageCount = 0;
    let durableSendObserved = false;
    harness.beforeTabReload = (tabId) => {
      expect(tabId).toBe(tab.id);
      staleRuntime = false;
    };
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: harness.tabsById.get(tab.id)?.url,
          selectorVersion: staleRuntime ? CONTENT_RUNTIME_REVISION - 1 : CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: harness.tabsById.get(tab.id)?.url,
          complete: true,
          historyComplete: true,
          messages: [],
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        mappedSendCount += 1;
        durableSendObserved = true;
        return {
          ok: true,
          pageUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });
    harness.installTabMessageResponder(decoy.id, () => {
      decoyMessageCount += 1;
      return {
        ok: true,
        pageUrl: REMOTE_C,
        selectorVersion: CONTENT_RUNTIME_REVISION,
      };
    });
    await waitUntil(() =>
      harness.timeline.includes(`tabs.sendMessage:response:${tab.id}:content.inspectConversation`),
    );
    harness.setTabUrl(tab.id, REMOTE_A);
    staleRuntime = true;

    socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_A));
    await waitUntil(
      () =>
        durableSendObserved &&
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === SECOND_RUN_ID && run.phase === "active") === true,
    );

    expect(harness.timeline.filter((entry) => entry === `tabs.reload:${tab.id}`)).toHaveLength(1);
    expect(harness.timeline.filter((entry) => entry === `tabs.reload:${decoy.id}`)).toHaveLength(0);
    expect(mappedSendCount).toBe(1);
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
      ),
    ).toHaveLength(1);
    expect(
      harness.timeline.filter((entry) => entry.startsWith(`tabs.sendMessage:request:${decoy.id}:`)),
    ).toHaveLength(0);
    expect(decoyMessageCount).toBe(0);
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
  });

  it("self-heals an absent content runtime in a minimized mapped tab without taking focus", async () => {
    const { harness, socket, tab } = await startHarness({ debuggerPermission: true });
    const homeWindowId = tab.windowId;
    const decoy = await chrome.tabs.create({ url: REMOTE_C, active: false });
    if (decoy.id === undefined) throw new Error("Fake Chrome did not create a decoy tab.");
    let runtimeMissing = false;
    let mappedSendCount = 0;
    let decoyMessageCount = 0;
    harness.beforeTabReload = (tabId) => {
      throw new Error(`Unexpected tab reload: ${tabId}`);
    };
    harness.scriptInjectionHandler = (tabId, files) => {
      expect(tabId).toBe(tab.id);
      if (files.includes("content-script.js")) runtimeMissing = false;
    };
    harness.installTabMessageResponder(tab.id, async (message) => {
      if (isMessageType(message, "content.ping")) {
        return runtimeMissing
          ? undefined
          : {
              ok: true,
              pageUrl: harness.tabsById.get(tab.id)?.url,
              selectorVersion: CONTENT_RUNTIME_REVISION,
            };
      }
      if (isMessageType(message, "content.composerStatus")) {
        const chromeWindow = await chrome.windows.get(tab.windowId);
        return {
          ok: true,
          ready: true,
          rawCandidateCount: 1,
          readyCandidateCount: 1,
          visibilityState: chromeWindow.state === "minimized" ? "hidden" : "visible",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: harness.tabsById.get(tab.id)?.url,
          complete: true,
          historyComplete: true,
          messages: [],
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        mappedSendCount += 1;
        return {
          ok: true,
          pageUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.recover")) {
        return {
          ok: true,
          active: true,
          matchedActiveRun: true,
          markdown: "",
          remoteUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });
    harness.installTabMessageResponder(decoy.id, () => {
      decoyMessageCount += 1;
      return {
        ok: true,
        pageUrl: REMOTE_C,
        selectorVersion: CONTENT_RUNTIME_REVISION,
      };
    });
    await waitUntil(() =>
      harness.timeline.includes(`tabs.sendMessage:response:${tab.id}:content.inspectConversation`),
    );
    harness.setTabUrl(tab.id, REMOTE_A);
    harness.setWindowFocused(homeWindowId, false);
    harness.setWindowState(homeWindowId, "minimized");
    runtimeMissing = true;
    const timelineStart = harness.timeline.length;

    socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_A));
    await waitUntil(
      () =>
        mappedSendCount === 1 &&
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === SECOND_RUN_ID && run.phase === "active") === true,
      8_000,
    ).catch((error: unknown) => {
      throw new Error(
        `${String(error)} Timeline: ${JSON.stringify(harness.timeline.slice(timelineStart))} Errors: ${JSON.stringify(runErrors(harness, socket, SECOND_RUN_ID))}`,
      );
    });

    const timeline = harness.timeline.slice(timelineStart);
    expect(timeline.filter((entry) => entry === `tabs.reload:${tab.id}`)).toHaveLength(0);
    expect(timeline.filter((entry) => entry === `tabs.reload:${decoy.id}`)).toHaveLength(0);
    expect(timeline).toContain(`scripting.executeScript:${tab.id}:MAIN:page-model-bridge.js`);
    expect(timeline).toContain(`scripting.executeScript:${tab.id}:ISOLATED:content-script.js`);
    expect(timeline).toContain(`window-updated:${homeWindowId}:state:normal`);
    expect(timeline.some((entry) => entry.includes("focused:true"))).toBe(false);
    expect(harness.tabsById.get(tab.id)?.windowId).toBe(homeWindowId);
    expect((await chrome.windows.get(homeWindowId)).state).toBe("normal");
    expect((await chrome.windows.get(homeWindowId)).type).toBe("normal");
    expect(harness.windowBounds(homeWindowId)).toEqual({
      height: 100,
      left: -16_000,
      top: -16_000,
      width: 100,
    });
    expect(mappedSendCount).toBe(1);
    expect(
      timeline.filter((entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`),
    ).toHaveLength(1);
    expect(decoyMessageCount).toBe(0);
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
  }, 12_000);

  it("uses and advances a durable fingerprint while the transcript remains virtualized", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const tab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a mapped tab.");
    const fullMessages = [
      { role: "user" as const, markdown: "First turn" },
      { role: "assistant" as const, markdown: "First answer" },
    ];
    const messageHashes = await Promise.all(
      fullMessages.map(async (message) => ({
        role: message.role,
        sha256: await sha256FixtureHex(JSON.stringify([message.role, message.markdown])),
      })),
    );
    const submittedPromptMessageSha256 = await sha256FixtureHex(
      JSON.stringify(["user", "Explain the relay race."]),
    );
    harness.seedLocalValue("conversationTranscriptFingerprintsV1", {
      version: 1,
      entries: [
        {
          remoteUrl: REMOTE_A,
          messageCount: fullMessages.length,
          messageHashes,
          transcriptSha256: await sha256FixtureHex(
            JSON.stringify(fullMessages.map((message) => [message.role, message.markdown])),
          ),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    harness.seedSessionValue("conversationTabsV2", [
      {
        owned: true,
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        tabId: tab.id,
        remoteUrl: REMOTE_A,
        projectScope: PROJECT_SCOPE,
        createdAt: new Date().toISOString(),
      },
    ]);
    let sendCount = 0;
    let visibleMessages = [fullMessages[1]];
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        return {
          ok: true,
          ready: true,
          rawCandidateCount: 1,
          readyCandidateCount: 1,
          visibilityState: "visible",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          // ChatGPT can hide both older turns and the latest response actions
          // while leaving the ready composer visible. The exact cached suffix
          // remains sufficient pre-send proof in that state.
          complete: false,
          historyComplete: false,
          messages: visibleMessages,
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCount += 1;
        return {
          ok: true,
          pageUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
          submittedPromptMessageSha256,
        };
      }
      if (isMessageType(message, "content.terminalAck")) return { ok: true };
      return { ok: false };
    });

    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);
    socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_A));
    await waitUntil(
      () =>
        sendCount === 1 &&
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === SECOND_RUN_ID && run.phase === "active") === true,
      5_000,
    );

    expect(sendCount).toBe(1);
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
      ),
    ).toHaveLength(1);
    expect(harness.timeline.filter((entry) => entry === `tabs.reload:${tab.id}`)).toHaveLength(0);
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);

    const completedUser = { role: "user" as const, markdown: "Explain the relay race." };
    const completedAssistant = { role: "assistant" as const, markdown: "Second answer" };
    visibleMessages = [completedUser, completedAssistant];
    await harness.importContentScript(tab.id, async () => undefined);
    harness.setPrimaryDocumentUrl(REMOTE_A);
    await expect(
      chrome.runtime.sendMessage({
        type: "content.event",
        eventType: "complete",
        conversationId: CONVERSATION_ID,
        runId: SECOND_RUN_ID,
        markdown: completedAssistant.markdown,
        remoteUrl: REMOTE_A,
      }),
    ).resolves.toEqual({ ok: true });
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
    );
    // Returning a minimized tab from its temporary parking window can expose
    // the ready composer before React remounts any transcript turns. The exact
    // chain was already attested by the non-empty suffix above and advanced by
    // this correlated terminal event.
    visibleMessages = [];

    const chainedRunId = "run-virtualized-chained";
    socket.deliverFromHost(sendEnvelope(chainedRunId, REMOTE_A));
    await waitUntil(
      () =>
        sendCount === 2 &&
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === chainedRunId && run.phase === "active") === true,
      5_000,
    );

    const stored = harness.localValue("conversationTranscriptFingerprintsV1") as
      | {
          entries?: Array<{
            messageCount?: number;
            transcriptChainSha256?: string;
          }>;
        }
      | undefined;
    expect(stored?.entries?.[0]?.messageCount).toBe(4);
    expect(stored?.entries?.[0]?.transcriptChainSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(sendCount).toBe(2);
    expect(runErrors(harness, socket, chainedRunId)).toHaveLength(0);
  }, 12_000);

  it("pre-attests a minimized conversation during open before its transcript virtualizes", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const mappedTab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    const decoyTab = await chrome.tabs.create({
      url: "https://example.test/foreground",
      active: true,
    });
    if (mappedTab.id === undefined || decoyTab.id === undefined) {
      throw new Error("Fake Chrome did not create the prewarm tabs.");
    }
    const homeWindowId = mappedTab.windowId;
    const messages = [
      { role: "user" as const, markdown: "First turn" },
      { role: "assistant" as const, markdown: "First answer" },
    ];
    const messageHashes = await Promise.all(
      messages.map(async (message) => ({
        role: message.role,
        sha256: await sha256FixtureHex(JSON.stringify([message.role, message.markdown])),
      })),
    );
    const transcriptProof = {
      remoteUrl: REMOTE_A,
      messageCount: messages.length,
      messageHashes,
      transcriptChainSha256: await sha256FixtureHex(
        JSON.stringify(messageHashes.map((message) => [message.role, message.sha256])),
      ),
    };
    harness.seedSessionValue("conversationTabsV2", [
      {
        owned: true,
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        tabId: mappedTab.id,
        remoteUrl: REMOTE_A,
        projectScope: PROJECT_SCOPE,
        createdAt: new Date().toISOString(),
      },
    ]);
    harness.setWindowFocused(homeWindowId, false);
    harness.setWindowState(homeWindowId, "minimized");
    let fullyVirtualized = false;
    let visibleInspectionCount = 0;
    let sendCount = 0;
    harness.installTabMessageResponder(mappedTab.id, async (message) => {
      const currentTab = await chrome.tabs.get(mappedTab.id!);
      const currentWindow = await chrome.windows.get(currentTab.windowId);
      const visible = currentWindow.state !== "minimized";
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        return {
          ok: true,
          ready: true,
          rawCandidateCount: 1,
          readyCandidateCount: 1,
          visibilityState: visible ? "visible" : "hidden",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        if (visible && !fullyVirtualized) visibleInspectionCount += 1;
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          complete: visible && !fullyVirtualized,
          historyComplete: visible && !fullyVirtualized,
          messages: visible && !fullyVirtualized ? messages : [],
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCount += 1;
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });

    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        payload: { active: false, remoteUrl: REMOTE_A, transcriptProof },
      }),
    );
    await waitUntil(
      () =>
        visibleInspectionCount >= 3 &&
        harness.timeline.includes(`window-updated:${homeWindowId}:state:minimized`),
      8_000,
    );
    expect((await chrome.windows.get(homeWindowId)).state).toBe("minimized");
    expect(harness.tabsById.get(decoyTab.id)?.active).toBe(true);

    // Simulate React unmounting every turn again after the idle prewarm. The
    // content-free chain attested above must let the first real Send proceed
    // without trusting the Host proof alone or waiting for another remount.
    fullyVirtualized = true;
    const runId = "run-after-idle-prewarm";
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.send",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        runId,
        payload: {
          prompt: "Explain the relay race.",
          messageId: `message-${runId}`,
          remoteUrl: REMOTE_A,
          transcriptProof,
        },
      }),
    );
    await waitUntil(() => sendCount === 1, 5_000);

    expect(sendCount).toBe(1);
    expect(runErrors(harness, socket, runId)).toHaveLength(0);
    expect((await chrome.windows.get(homeWindowId)).state).toBe("normal");
    expect(harness.windowBounds(homeWindowId)).toEqual({
      height: 100,
      left: -16_000,
      top: -16_000,
      width: 100,
    });
    expect(harness.tabsById.get(mappedTab.id)?.active).toBe(true);
    expect(harness.tabsById.get(decoyTab.id)?.active).toBe(false);
    expect(harness.timeline.some((entry) => entry.includes("focused:true"))).toBe(false);
  }, 15_000);

  it("refreshes history from an inactive normal-window tab before restoring the user's tab", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const mappedTab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    const decoyTab = await chrome.tabs.create({
      url: "https://example.test/history-foreground",
      active: true,
    });
    if (mappedTab.id === undefined || decoyTab.id === undefined) {
      throw new Error("Fake Chrome did not create the inactive-history tabs.");
    }
    const mappedTabId = mappedTab.id;
    const decoyTabId = decoyTab.id;
    harness.seedSessionValue("conversationTabsV2", [
      {
        owned: true,
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        tabId: mappedTabId,
        remoteUrl: REMOTE_A,
        projectScope: PROJECT_SCOPE,
        createdAt: new Date().toISOString(),
      },
    ]);
    const messages = [
      { role: "user" as const, markdown: "First turn" },
      { role: "assistant" as const, markdown: "First answer" },
    ];
    harness.installTabMessageResponder(mappedTabId, async (message) => {
      const visible = (await chrome.tabs.get(mappedTabId)).active === true;
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          complete: visible,
          historyComplete: visible,
          messages: visible ? messages : [],
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });

    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        payload: { active: false, remoteUrl: REMOTE_A },
      }),
    );
    const snapshot = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.snapshot" &&
        Array.isArray((envelope.payload as { messages?: unknown[] }).messages) &&
        (envelope.payload as { messages: unknown[] }).messages.length === messages.length,
      8_000,
    );
    await waitUntil(() => harness.tabsById.get(decoyTabId)?.active === true, 5_000);

    expect(snapshot.payload).toMatchObject({ complete: true, messages });
    expect(harness.tabsById.get(mappedTabId)?.active).toBe(false);
    expect(harness.tabsById.get(decoyTabId)?.active).toBe(true);
    expect(harness.timeline.some((entry) => entry.includes("focused:true"))).toBe(false);
  }, 12_000);

  it("publishes an attested rendered suffix as partial instead of truncating local history", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const mappedTab = await chrome.tabs.create({ url: REMOTE_A, active: true });
    if (mappedTab.id === undefined) throw new Error("Fake Chrome did not create the suffix tab.");
    const messages = [
      { role: "user" as const, markdown: "First turn" },
      { role: "assistant" as const, markdown: "First answer" },
      { role: "user" as const, markdown: "Second turn" },
      { role: "assistant" as const, markdown: "Second answer" },
    ];
    const messageHashes = await Promise.all(
      messages.map(async (message) => ({
        role: message.role,
        sha256: await sha256FixtureHex(JSON.stringify([message.role, message.markdown])),
      })),
    );
    const transcriptProof = {
      remoteUrl: REMOTE_A,
      messageCount: messageHashes.length,
      messageHashes,
      transcriptChainSha256: await sha256FixtureHex(
        JSON.stringify(messageHashes.map((message) => [message.role, message.sha256])),
      ),
    };
    harness.seedSessionValue("conversationTabsV2", [
      {
        owned: true,
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        tabId: mappedTab.id,
        remoteUrl: REMOTE_A,
        projectScope: PROJECT_SCOPE,
        createdAt: new Date().toISOString(),
      },
    ]);
    harness.installTabMessageResponder(mappedTab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          complete: true,
          historyComplete: true,
          messages: messages.slice(-2),
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });

    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        payload: { active: false, remoteUrl: REMOTE_A, transcriptProof },
      }),
    );
    const snapshot = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "conversation.snapshot",
      8_000,
    );

    expect(snapshot.payload).toMatchObject({
      complete: false,
      messages: messages.slice(-2),
    });
    await waitUntil(
      () =>
        (
          harness.localValue("conversationTranscriptFingerprintsV1") as
            { entries?: Array<{ messageCount?: number }> } | undefined
        )?.entries?.[0]?.messageCount === messages.length,
      5_000,
    );
  }, 12_000);

  it("keeps a dispatch-intent home window off-screen and hands it directly to the later send", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const mappedTab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    const decoyTab = await chrome.tabs.create({
      url: "https://example.test/prewarm-handoff-foreground",
      active: true,
    });
    if (mappedTab.id === undefined || decoyTab.id === undefined) {
      throw new Error("Fake Chrome did not create the prewarm handoff tabs.");
    }
    const homeWindowId = mappedTab.windowId;
    const messages = [
      { role: "user" as const, markdown: "First turn" },
      { role: "assistant" as const, markdown: "First answer" },
    ];
    const messageHashes = await Promise.all(
      messages.map(async (message) => ({
        role: message.role,
        sha256: await sha256FixtureHex(JSON.stringify([message.role, message.markdown])),
      })),
    );
    const transcriptProof = {
      remoteUrl: REMOTE_A,
      messageCount: messages.length,
      messageHashes,
      transcriptChainSha256: await sha256FixtureHex(
        JSON.stringify(messageHashes.map((message) => [message.role, message.sha256])),
      ),
    };
    harness.seedSessionValue("conversationTabsV2", [
      {
        owned: true,
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        tabId: mappedTab.id,
        remoteUrl: REMOTE_A,
        projectScope: PROJECT_SCOPE,
        createdAt: new Date().toISOString(),
      },
    ]);
    harness.setWindowFocused(homeWindowId, false);
    harness.setWindowState(homeWindowId, "minimized");

    let releaseVisibleInspection: (() => void) | undefined;
    const visibleInspectionGate = new Promise<void>((resolve) => {
      releaseVisibleInspection = resolve;
    });
    let visibleInspectionBlocked = false;
    let sendCount = 0;
    harness.installTabMessageResponder(mappedTab.id, async (message) => {
      const currentTab = await chrome.tabs.get(mappedTab.id!);
      const currentWindow = await chrome.windows.get(currentTab.windowId);
      const visible = currentWindow.state !== "minimized";
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        return {
          ok: true,
          ready: visible,
          rawCandidateCount: 1,
          readyCandidateCount: visible ? 1 : 0,
          visibilityState: visible ? "visible" : "hidden",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        if (visible && !visibleInspectionBlocked) {
          visibleInspectionBlocked = true;
          await visibleInspectionGate;
        }
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          complete: visible,
          historyComplete: visible,
          messages: visible ? messages : [],
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCount += 1;
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });

    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        payload: {
          active: false,
          dispatchIntent: true,
          remoteUrl: REMOTE_A,
          transcriptProof,
        },
      }),
    );
    await waitUntil(
      () =>
        visibleInspectionBlocked &&
        harness.timeline.includes(`window-updated:${homeWindowId}:bounds:-16000,-16000,100,100`),
      5_000,
    );

    releaseVisibleInspection?.();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(harness.timeline.some((entry) => entry.startsWith("window-created:"))).toBe(false);
    expect((await chrome.windows.get(homeWindowId)).state).toBe("normal");

    const runId = "run-after-dispatch-intent-prewarm";
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.send",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        runId,
        payload: {
          prompt: "Explain the relay race.",
          messageId: `message-${runId}`,
          remoteUrl: REMOTE_A,
          transcriptProof,
        },
      }),
    );
    await waitUntil(
      () =>
        (harness.sessionValue("activeRunsV2") as Array<{ runId?: string }> | undefined)?.some(
          (run) => run.runId === runId,
        ) === true,
      5_000,
    );
    await waitUntil(() => sendCount === 1, 5_000);

    const sendIndex = harness.timeline.indexOf(
      `tabs.sendMessage:request:${mappedTab.id}:content.send`,
    );
    expect(sendIndex).toBeGreaterThanOrEqual(0);
    expect(harness.timeline.filter((entry) => entry.startsWith("window-created:"))).toHaveLength(0);
    expect(harness.tabsById.get(mappedTab.id)?.windowId).toBe(homeWindowId);
    expect((await chrome.windows.get(homeWindowId)).state).toBe("normal");
    expect(harness.tabsById.get(mappedTab.id)?.active).toBe(true);
    expect(harness.tabsById.get(decoyTab.id)?.active).toBe(false);
    expect(runErrors(harness, socket, runId)).toHaveLength(0);
  }, 15_000);

  it("repairs a stale fingerprint from the Host proof before virtualized dispatch", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const tab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a mapped tab.");
    const staleMessages = [
      { role: "user" as const, markdown: "Stale turn" },
      { role: "assistant" as const, markdown: "Stale answer" },
    ];
    const currentMessages = [
      ...staleMessages,
      { role: "user" as const, markdown: "Current turn" },
      { role: "assistant" as const, markdown: "Current_answer" },
    ];
    const visibleCurrentMessages = currentMessages.map((message) =>
      message.role === "assistant" && message.markdown === "Current_answer"
        ? { ...message, markdown: "Current\\_answer" }
        : message,
    );
    const staleMessageHashes = await Promise.all(
      staleMessages.map(async (message) => ({
        role: message.role,
        sha256: await sha256FixtureHex(JSON.stringify([message.role, message.markdown])),
      })),
    );
    const currentMessageHashes = await Promise.all(
      currentMessages.map(async (message) => ({
        role: message.role,
        sha256: await sha256FixtureHex(JSON.stringify([message.role, message.markdown])),
      })),
    );
    const transcriptProof = {
      remoteUrl: REMOTE_A,
      messageCount: currentMessageHashes.length,
      messageHashes: currentMessageHashes,
      transcriptChainSha256: await sha256FixtureHex(
        JSON.stringify(currentMessageHashes.map((message) => [message.role, message.sha256])),
      ),
    };
    harness.seedLocalValue("conversationTranscriptFingerprintsV1", {
      version: 1,
      entries: [
        {
          remoteUrl: REMOTE_A,
          messageCount: staleMessages.length,
          messageHashes: staleMessageHashes,
          transcriptSha256: await sha256FixtureHex(
            JSON.stringify(staleMessages.map((message) => [message.role, message.markdown])),
          ),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    harness.seedSessionValue("conversationTabsV2", [
      {
        owned: true,
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        tabId: tab.id,
        remoteUrl: REMOTE_A,
        projectScope: PROJECT_SCOPE,
        createdAt: new Date().toISOString(),
      },
    ]);
    let sendCount = 0;
    const tabIsVisible = () => harness.tabsById.get(tab.id!)?.active === true;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        return {
          ok: true,
          ready: true,
          rawCandidateCount: 1,
          readyCandidateCount: 1,
          visibilityState: tabIsVisible() ? "visible" : "hidden",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          complete: false,
          historyComplete: false,
          messages: visibleCurrentMessages.slice(-2),
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCount += 1;
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });

    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        payload: { remoteUrl: REMOTE_A, active: false, transcriptProof },
      }),
    );
    await waitUntil(
      () =>
        (
          harness.localValue("conversationTranscriptFingerprintsV1") as
            { entries?: Array<{ messageCount?: number }> } | undefined
        )?.entries?.[0]?.messageCount === currentMessages.length,
    );

    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.send",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        runId: SECOND_RUN_ID,
        payload: {
          prompt: "Explain the relay race.",
          messageId: "message-host-proof",
          remoteUrl: REMOTE_A,
          transcriptProof,
        },
      }),
    );
    await waitUntil(() => sendCount === 1, 5_000);

    expect(sendCount).toBe(1);
    expect(harness.timeline.filter((entry) => entry === `tabs.reload:${tab.id}`)).toHaveLength(0);
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
  }, 12_000);

  it("durably claims and reloads a submitted stale-runtime follow-up before exact recovery", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const tab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    const decoy = await chrome.tabs.create({ url: REMOTE_C, active: false });
    if (tab.id === undefined || decoy.id === undefined) {
      throw new Error("Fake Chrome did not create the recovery tabs.");
    }
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    const baselineMessages = [
      { role: "user" as const, markdown: "Explain the relay race." },
      { role: "assistant" as const, markdown: "OK" },
    ];
    const transcriptSha256 = await sha256FixtureHex(
      JSON.stringify(baselineMessages.map((message) => [message.role, message.markdown])),
    );
    let reloadClaimWasDurable = false;
    let reloaded = false;
    let recoverCount = 0;
    let sendCount = 0;
    let decoyMessageCount = 0;
    harness.beforeTabReload = (tabId) => {
      expect(tabId).toBe(tab.id);
      const persistedRuns = harness.sessionValue("activeRunsV2") as
        | Array<{
            runId?: string;
            historyReloadClaimedAt?: string;
            dispatchTranscriptBaseline?: { transcriptSha256?: string };
          }>
        | undefined;
      const persistedRun = persistedRuns?.find((run) => run.runId === SECOND_RUN_ID);
      reloadClaimWasDurable =
        typeof persistedRun?.historyReloadClaimedAt === "string" &&
        persistedRun.dispatchTranscriptBaseline?.transcriptSha256 === transcriptSha256;
      reloaded = true;
    };
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.recover")) {
        recoverCount += 1;
        return {
          ok: true,
          active: true,
          matchedActiveRun: true,
          markdown: "",
          remoteUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION - 1,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          title: "Hot-update follow-up",
          complete: true,
          historyComplete: true,
          messages: reloaded
            ? [
                ...baselineMessages,
                { role: "user" as const, markdown: "Explain the relay race." },
                { role: "assistant" as const, markdown: "OK" },
              ]
            : baselineMessages,
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCount += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });
    harness.installTabMessageResponder(decoy.id, () => {
      decoyMessageCount += 1;
      return {
        ok: true,
        pageUrl: REMOTE_C,
        selectorVersion: CONTENT_RUNTIME_REVISION,
      };
    });
    harness.seedSessionValue("conversationTabsV2", [
      {
        owned: true,
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        tabId: tab.id,
        remoteUrl: REMOTE_A,
        projectScope: PROJECT_SCOPE,
        createdAt: startedAt,
      },
    ]);
    harness.seedSessionValue("activeRunsV2", [
      {
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        runId: SECOND_RUN_ID,
        tabId: tab.id,
        phase: "active",
        remoteAdoptionStage: "locked",
        promptSha256: FIRST_PROMPT_SHA256,
        dispatchTranscriptBaseline: {
          tabId: tab.id,
          remoteUrl: REMOTE_A,
          messageCount: baselineMessages.length,
          transcriptSha256,
        },
        startedAt,
      },
    ]);

    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket, { acknowledgeTerminals: false });
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
      8_000,
    );

    expect(complete.payload).toMatchObject({ markdown: "OK", remoteUrl: REMOTE_A });
    expect(reloadClaimWasDurable).toBe(true);
    expect(recoverCount).toBe(1);
    expect(sendCount).toBe(0);
    expect(harness.timeline.filter((entry) => entry === `tabs.reload:${tab.id}`)).toHaveLength(1);
    expect(harness.timeline.filter((entry) => entry === `tabs.reload:${decoy.id}`)).toHaveLength(0);
    expect(harness.timeline.filter((entry) => entry.includes(":content.send"))).toHaveLength(0);
    expect(
      harness.timeline.filter((entry) => entry.startsWith(`tabs.sendMessage:request:${decoy.id}:`)),
    ).toHaveLength(0);
    expect(decoyMessageCount).toBe(0);
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
  }, 12_000);

  it("accepts only the exact page-run recovery request and never resends", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const tab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create the recovery tab.");

    const startedAt = new Date(Date.now() - 5_000).toISOString();
    let recoverCount = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.recover")) {
        recoverCount += 1;
        return {
          ok: true,
          active: true,
          matchedActiveRun: true,
          markdown: "",
          remoteUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
          runLifecycle: {
            documentVisible: false,
            intentAccepted: true,
            submissionConfirmed: true,
            networkSubmitted: true,
            networkResponseStarted: true,
            networkResponseComplete: false,
            userTurnObserved: true,
            responseAttributed: false,
            responseObserved: false,
            stopVisible: true,
            sawStop: true,
            assistantAfterUser: false,
          },
        };
      }
      return { ok: false };
    });
    harness.seedSessionValue("conversationTabsV2", [
      {
        owned: true,
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        tabId: tab.id,
        remoteUrl: REMOTE_A,
        projectScope: PROJECT_SCOPE,
        createdAt: startedAt,
      },
    ]);
    harness.seedSessionValue("activeRunsV2", [
      {
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        runId: SECOND_RUN_ID,
        tabId: tab.id,
        phase: "active",
        remoteAdoptionStage: "locked",
        promptSha256: FIRST_PROMPT_SHA256,
        startedAt,
      },
    ]);
    await harness.importContentScript(tab.id, async () => undefined);
    await harness.importServiceWorker(async () => await import("./service-worker"));

    // MessageSender.url remains the document's original project URL after
    // ChatGPT moves the tab to a conversation with History API navigation.
    // Read-only recovery must accept that exact-project document identity too.
    harness.setRuntimeSenderUrlOverride(PROJECT_ROOT);
    const exactResponse: unknown = await chrome.runtime.sendMessage({
      type: "content.recovery.request",
      conversationId: CONVERSATION_ID,
      runId: SECOND_RUN_ID,
      selectorVersion: CONTENT_RUNTIME_REVISION,
      reason: "network-complete-dom-missing",
    });
    expect(exactResponse).toEqual({ ok: true });
    const recoverCountAfterExactRequest = recoverCount;
    expect(recoverCountAfterExactRequest).toBeGreaterThanOrEqual(1);

    const mismatchedResponse: unknown = await chrome.runtime.sendMessage({
      type: "content.recovery.request",
      conversationId: CONVERSATION_ID,
      runId: FIRST_RUN_ID,
      selectorVersion: CONTENT_RUNTIME_REVISION,
      reason: "network-complete-dom-missing",
    });
    expect(mismatchedResponse).toEqual({ ok: false });
    expect(recoverCount).toBe(recoverCountAfterExactRequest);
    expect(harness.timeline.filter((entry) => entry.includes(":content.send"))).toHaveLength(0);
    expect(
      (harness.sessionValue("activeRunsV2") as Array<{ runId?: string }> | undefined)?.some(
        (run) => run.runId === SECOND_RUN_ID,
      ),
    ).toBe(true);
  });

  it("lets a pending terminal beat an exact reload claim without creating two authorities", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const tab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create the recovery tab.");
    await harness.importContentScript(tab.id, async () => undefined);
    harness.setPrimaryDocumentUrl(REMOTE_A);
    const baselineMessages = [
      { role: "user" as const, markdown: "Earlier question" },
      { role: "assistant" as const, markdown: "Earlier answer" },
    ];
    const baselineSha256 = await sha256FixtureHex(
      JSON.stringify(baselineMessages.map((message) => [message.role, message.markdown])),
    );
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    const terminalMarkdown = "Terminal observer won";
    let terminalIssued = false;
    let exactRecoveryRequested = false;
    let recoverCount = 0;
    let armTabGetBarrier = false;
    let tabGetBarrier: ReturnType<FakeChromeRelayHarness["pauseNextTabGet"]> | undefined;

    harness.beforeTabMessage = (messageTabId, message) => {
      if (
        armTabGetBarrier &&
        messageTabId === tab.id &&
        isMessageType(message, "content.recover")
      ) {
        armTabGetBarrier = false;
        tabGetBarrier = harness.pauseNextTabGet(tab.id);
      }
    };
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.composerStatus")) {
        return {
          ok: true,
          ready: true,
          rawCandidateCount: 1,
          readyCandidateCount: 1,
          visibilityState: "visible",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          complete: true,
          historyComplete: true,
          messages: terminalIssued
            ? [
                ...baselineMessages,
                { role: "user" as const, markdown: "Explain the relay race." },
                { role: "assistant" as const, markdown: terminalMarkdown },
              ]
            : baselineMessages,
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.recover")) {
        recoverCount += 1;
        return {
          ok: true,
          active: true,
          matchedActiveRun: true,
          markdown: "",
          remoteUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
          runLifecycle: {
            documentVisible: false,
            intentAccepted: true,
            submissionConfirmed: true,
            networkSubmitted: true,
            networkResponseStarted: true,
            networkResponseComplete: exactRecoveryRequested,
            ...(exactRecoveryRequested ? { networkResponseCompleteAgeMs: 3_000 } : {}),
            userTurnObserved: true,
            responseAttributed: false,
            responseObserved: false,
            stopVisible: !exactRecoveryRequested,
            sawStop: true,
            assistantAfterUser: false,
          },
        };
      }
      return { ok: false };
    });
    harness.seedSessionValue("conversationTabsV2", [
      {
        owned: true,
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        tabId: tab.id,
        remoteUrl: REMOTE_A,
        projectScope: PROJECT_SCOPE,
        createdAt: startedAt,
      },
    ]);
    harness.seedSessionValue("activeRunsV2", [
      {
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        runId: SECOND_RUN_ID,
        tabId: tab.id,
        phase: "active",
        remoteAdoptionStage: "locked",
        promptSha256: FIRST_PROMPT_SHA256,
        dispatchTranscriptBaseline: {
          tabId: tab.id,
          remoteUrl: REMOTE_A,
          messageCount: baselineMessages.length,
          transcriptSha256: baselineSha256,
        },
        startedAt,
      },
    ]);
    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket, { acknowledgeTerminals: false });
    await waitUntil(() => recoverCount >= 1);

    exactRecoveryRequested = true;
    armTabGetBarrier = true;
    const recoveryRequest = chrome.runtime.sendMessage({
      type: "content.recovery.request",
      conversationId: CONVERSATION_ID,
      runId: SECOND_RUN_ID,
      selectorVersion: CONTENT_RUNTIME_REVISION,
      reason: "network-complete-dom-missing",
    });
    await waitUntil(() => tabGetBarrier !== undefined);
    await tabGetBarrier!.entered;

    terminalIssued = true;
    const terminalRequest = chrome.runtime.sendMessage({
      type: "content.event",
      eventType: "complete",
      conversationId: CONVERSATION_ID,
      runId: SECOND_RUN_ID,
      markdown: terminalMarkdown,
      remoteUrl: REMOTE_A,
    });
    await waitUntil(
      () =>
        (
          harness.sessionValue("pendingEventsV2") as
            Array<{ event?: { runId?: string; eventType?: string } }> | undefined
        )?.some(
          (pending) =>
            pending.event?.runId === SECOND_RUN_ID && pending.event.eventType === "complete",
        ) === true,
    );
    tabGetBarrier!.release();

    await expect(terminalRequest).resolves.toEqual({ ok: true });
    await expect(recoveryRequest).resolves.toEqual({ ok: true });
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
    );
    expect(complete.payload).toMatchObject({ markdown: terminalMarkdown, remoteUrl: REMOTE_A });
    expect(harness.timeline.filter((entry) => entry === `tabs.reload:${tab.id}`)).toHaveLength(0);
    expect(harness.timeline.filter((entry) => entry.includes(":content.send"))).toHaveLength(0);
    expect(
      harness
        .outboundEnvelopes(socket)
        .filter(
          (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
        ),
    ).toHaveLength(1);
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
  }, 12_000);

  it("never resends when the content runtime changes after the one allowed send", async () => {
    const { harness, socket, tab } = await startHarness();
    const baselineMessages = [
      { role: "user" as const, markdown: "Explain the relay race." },
      { role: "assistant" as const, markdown: "OK" },
    ];
    let sendCount = 0;
    let recoverCount = 0;
    let reloaded = false;
    harness.beforeTabReload = (tabId) => {
      expect(tabId).toBe(tab.id);
      reloaded = true;
    };
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: harness.tabsById.get(tab.id)?.url,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          complete: true,
          historyComplete: true,
          messages: reloaded
            ? [
                ...baselineMessages,
                { role: "user" as const, markdown: "Explain the relay race." },
                { role: "assistant" as const, markdown: "OK" },
              ]
            : baselineMessages,
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCount += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION - 1 };
      }
      if (isMessageType(message, "content.recover")) {
        recoverCount += 1;
        return {
          ok: true,
          active: true,
          matchedActiveRun: true,
          markdown: "",
          remoteUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION - 1,
        };
      }
      return { ok: false };
    });
    await waitUntil(() =>
      harness.timeline.includes(`tabs.sendMessage:response:${tab.id}:content.inspectConversation`),
    );
    harness.setTabUrl(tab.id, REMOTE_A);

    socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_A));
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
      8_000,
    );

    expect(complete.payload).toMatchObject({ markdown: "OK", remoteUrl: REMOTE_A });
    expect(sendCount).toBe(1);
    expect(recoverCount).toBe(1);
    expect(harness.timeline.filter((entry) => entry === `tabs.reload:${tab.id}`)).toHaveLength(1);
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
      ),
    ).toHaveLength(1);
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
  }, 12_000);

  it("reloads one stale hidden follow-up and settles only from the exact expanded transcript", async () => {
    const { harness, socket, tab } = await startHarness();
    let submitted = false;
    let reloaded = false;
    let sendCount = 0;
    let recoverCount = 0;
    const baselineMessages = [
      { role: "user" as const, markdown: "Explain the relay race." },
      { role: "assistant" as const, markdown: "OK" },
    ];
    harness.beforeTabReload = (tabId) => {
      expect(tabId).toBe(tab.id);
      reloaded = true;
    };
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: harness.tabsById.get(tab.id)?.url,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.composerStatus")) {
        const visible = harness.tabsById.get(tab.id)?.active === true;
        return {
          ok: true,
          ready: visible,
          rawCandidateCount: visible ? 1 : 0,
          readyCandidateCount: visible ? 1 : 0,
          visibilityState: visible ? "visible" : "hidden",
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          title: "Repeated OK",
          // Hidden ChatGPT pages can expose a structurally complete transcript
          // without terminal action controls. That is sufficient only for the
          // pre-dispatch prefix; settlement still requires complete=true after
          // the one claimed history refresh.
          complete: reloaded,
          historyComplete: true,
          messages:
            submitted && reloaded
              ? [
                  ...baselineMessages,
                  { role: "user" as const, markdown: "Explain the relay race." },
                  { role: "assistant" as const, markdown: "OK" },
                ]
              : baselineMessages,
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCount += 1;
        submitted = true;
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.recover")) {
        recoverCount += 1;
        return {
          ok: true,
          active: true,
          matchedActiveRun: true,
          markdown: "",
          remoteUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
          runLifecycle: {
            documentVisible: false,
            intentAccepted: true,
            submissionConfirmed: true,
            networkSubmitted: true,
            networkResponseStarted: true,
            networkResponseComplete: true,
            networkResponseCompleteAgeMs: 3_000,
            userTurnObserved: false,
            // An empty attributed assistant is ownership evidence, not answer
            // text. It must not block the exact render refresh.
            responseAttributed: true,
            responseObserved: false,
            // The response transport is authoritative here. A stale hidden
            // Stop/busy control must not block the one exact transcript reload.
            stopVisible: true,
            sawStop: true,
            assistantAfterUser: false,
          },
        };
      }
      return { ok: false };
    });
    await waitUntil(() =>
      harness.timeline.includes(`tabs.sendMessage:response:${tab.id}:content.inspectConversation`),
    );
    harness.setTabUrl(tab.id, REMOTE_A);

    socket.deliverFromHost(sendEnvelope(SECOND_RUN_ID, REMOTE_A));
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
      10_000,
    );

    expect(complete.payload).toMatchObject({ markdown: "OK", remoteUrl: REMOTE_A });
    expect(sendCount).toBe(1);
    expect(recoverCount).toBeGreaterThanOrEqual(1);
    expect(harness.timeline.filter((entry) => entry === `tabs.reload:${tab.id}`)).toHaveLength(1);
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
      ),
    ).toHaveLength(1);
    expect(runErrors(harness, socket, SECOND_RUN_ID)).toHaveLength(0);
    await waitUntil(
      () =>
        !(harness.sessionValue("activeRunsV2") as Array<{ runId?: string }> | undefined)?.some(
          (run) => run.runId === SECOND_RUN_ID,
        ),
    );
  }, 15_000);

  it("never accepts baseline plus four turns after a claimed history reload", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    seedProjectBinding(harness);
    const tab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    if (tab.id === undefined) throw new Error("Fake Chrome did not create a mapped tab.");
    const startedAt = new Date(Date.now() - 30_000).toISOString();
    const historyReloadClaimedAt = new Date(Date.now() - 21_000).toISOString();
    const transcriptSha256 = await sha256FixtureHex(
      JSON.stringify([
        ["user", "Explain the relay race."],
        ["assistant", "OK"],
      ]),
    );
    let recoverCount = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: REMOTE_A, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.recover")) {
        recoverCount += 1;
        return {
          ok: true,
          active: false,
          recoveryTurnMatched: true,
          markdown: "OK",
          remoteUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          complete: true,
          historyComplete: true,
          messages: [
            { role: "user", markdown: "Explain the relay race." },
            { role: "assistant", markdown: "OK" },
            { role: "user", markdown: "Explain the relay race." },
            { role: "assistant", markdown: "OK" },
            { role: "user", markdown: "Explain the relay race." },
            { role: "assistant", markdown: "OK" },
          ],
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });
    await harness.importContentScript(tab.id, async () => undefined);
    harness.seedSessionValue("conversationTabsV2", [
      {
        owned: true,
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        tabId: tab.id,
        remoteUrl: REMOTE_A,
        projectScope: PROJECT_SCOPE,
        createdAt: startedAt,
      },
    ]);
    harness.seedSessionValue("activeRunsV2", [
      {
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        runId: SECOND_RUN_ID,
        tabId: tab.id,
        phase: "active",
        remoteAdoptionStage: "locked",
        promptSha256: FIRST_PROMPT_SHA256,
        dispatchTranscriptBaseline: {
          tabId: tab.id,
          remoteUrl: REMOTE_A,
          messageCount: 2,
          transcriptSha256,
        },
        historyReloadClaimedAt,
        startedAt,
      },
    ]);

    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket, { acknowledgeTerminals: false });
    const terminal = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "relay.error" && envelope.runId === SECOND_RUN_ID,
      5_000,
    );

    expect(terminal.payload).toMatchObject({ code: "CHATGPT_REMOTE_UNAVAILABLE" });
    expect(recoverCount).toBe(0);
    expect(harness.timeline.filter((entry) => entry === `tabs.reload:${tab.id}`)).toHaveLength(0);
    expect(harness.timeline.filter((entry) => entry.includes(":content.send"))).toHaveLength(0);
    expect(
      harness
        .outboundEnvelopes(socket)
        .filter(
          (envelope) => envelope.type === "generation.complete" && envelope.runId === SECOND_RUN_ID,
        ),
    ).toHaveLength(0);
    expect(
      (harness.sessionValue("activeRunsV2") as Array<{ runId?: string }> | undefined)?.some(
        (run) => run.runId === SECOND_RUN_ID,
      ),
    ).toBe(false);
    await waitUntil(() => harness.tabsById.get(tab.id!)?.autoDiscardable === true);
  }, 10_000);

  it("bounds a permanently pending content.send and recovers without replaying it", async () => {
    const { harness, socket, tab } = await startHarness();
    let sendCount = 0;
    let recoverCount = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: harness.tabsById.get(tab.id)?.url,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCount += 1;
        return new Promise<never>(() => undefined);
      }
      if (isMessageType(message, "content.recover")) {
        recoverCount += 1;
        return {
          ok: true,
          active: true,
          matchedActiveRun: true,
          markdown: "",
          remoteUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });

    await waitUntil(() =>
      harness.timeline.includes(`tabs.sendMessage:response:${tab.id}:content.inspectConversation`),
    );
    harness.setTabUrl(tab.id, REMOTE_A);
    vi.useFakeTimers();
    try {
      socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID, REMOTE_A));
      await vi.waitFor(() => expect(sendCount).toBe(1));
      await vi.waitFor(() =>
        expect(
          (
            harness.sessionValue("activeRunsV2") as
              Array<{ runId?: string; phase?: string }> | undefined
          )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "dispatching"),
        ).toBe(true),
      );

      await vi.advanceTimersByTimeAsync(20_001);
      await vi.waitFor(() => expect(recoverCount).toBe(1));
      await vi.waitFor(() =>
        expect(
          (
            harness.sessionValue("activeRunsV2") as
              Array<{ runId?: string; phase?: string }> | undefined
          )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active"),
        ).toBe(true),
      );
    } finally {
      vi.useRealTimers();
    }

    expect(sendCount).toBe(1);
    expect(recoverCount).toBe(1);
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
      ),
    ).toHaveLength(1);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);

    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.close",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        payload: { closeTab: false },
      }),
    );
    await waitUntil(
      () =>
        !(harness.sessionValue("activeRunsV2") as Array<{ runId?: string }> | undefined)?.some(
          (run) => run.runId === FIRST_RUN_ID,
        ),
    );
  });

  it("allows an attachment content.send response after 75 seconds without recovering", async () => {
    const { harness, socket, tab } = await startHarness();
    let sendCount = 0;
    let recoverCount = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: harness.tabsById.get(tab.id)?.url,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCount += 1;
        return new Promise((resolve) => {
          scheduleFixtureTimeout(
            () => resolve({ ok: true, selectorVersion: CONTENT_RUNTIME_REVISION }),
            90_000,
          );
        });
      }
      if (isMessageType(message, "content.recover")) {
        recoverCount += 1;
        return { ok: false };
      }
      return { ok: false };
    });

    await waitUntil(() =>
      harness.timeline.includes(`tabs.sendMessage:response:${tab.id}:content.inspectConversation`),
    );
    harness.setTabUrl(tab.id, REMOTE_A);
    vi.useFakeTimers();
    try {
      socket.deliverFromHost(
        makeEnvelope({
          type: "conversation.send",
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          runId: FIRST_RUN_ID,
          payload: {
            prompt: "Read the attached probe.ts file.",
            messageId: `message-${FIRST_RUN_ID}`,
            remoteUrl: REMOTE_A,
            attachments: [
              {
                id: "attachment-probe",
                fileName: "probe.ts",
                mimeType: "text/typescript",
                content: "export const answer = 42;\n",
              },
            ],
          },
        }),
      );
      await vi.waitFor(() => expect(sendCount).toBe(1));
      await vi.waitFor(() =>
        expect(
          (
            harness.sessionValue("activeRunsV2") as
              Array<{ runId?: string; phase?: string }> | undefined
          )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "dispatching"),
        ).toBe(true),
      );

      await vi.advanceTimersByTimeAsync(75_001);
      expect(recoverCount).toBe(0);
      expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
      expect(
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "dispatching"),
      ).toBe(true);

      await vi.advanceTimersByTimeAsync(14_999);
      await vi.waitFor(() =>
        expect(
          (
            harness.sessionValue("activeRunsV2") as
              Array<{ runId?: string; phase?: string }> | undefined
          )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active"),
        ).toBe(true),
      );
    } finally {
      vi.useRealTimers();
    }

    expect(sendCount).toBe(1);
    expect(recoverCount).toBe(0);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);

    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.close",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        payload: { requestId: "close-after-delayed-attachment", closeTab: false },
      }),
    );
    await waitUntil(
      () =>
        !(harness.sessionValue("activeRunsV2") as Array<{ runId?: string }> | undefined)?.some(
          (run) => run.runId === FIRST_RUN_ID,
        ),
    );
  });

  it("retries a permanently pending read-only recovery inspection within its deadline", async () => {
    const { harness, socket, tab } = await startHarness();
    let sendCount = 0;
    let recoverCount = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: harness.tabsById.get(tab.id)?.url,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCount += 1;
        throw new Error("The message port closed before a response was received.");
      }
      if (isMessageType(message, "content.recover")) {
        recoverCount += 1;
        if (recoverCount === 1) return new Promise<never>(() => undefined);
        return {
          ok: true,
          active: true,
          matchedActiveRun: true,
          markdown: "",
          remoteUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });

    await waitUntil(() =>
      harness.timeline.includes(`tabs.sendMessage:response:${tab.id}:content.inspectConversation`),
    );
    harness.setTabUrl(tab.id, REMOTE_A);
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID, REMOTE_A));

    await waitUntil(() => recoverCount >= 2, 4_000);
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.phase === "active") === true,
      4_000,
    );

    expect(sendCount).toBe(1);
    expect(recoverCount).toBe(2);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 8_000);

  it("reactivates frozen and discarded ChatGPT tabs without resending", async () => {
    const { harness, socket, tab } = await startHarness();
    const runId = "run-frozen-discarded-lifecycle";
    let sendCount = 0;
    let recoverCount = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: harness.tabsById.get(tab.id)?.url,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCount += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.recover")) {
        recoverCount += 1;
        return {
          ok: true,
          active: true,
          matchedActiveRun: true,
          markdown: "",
          remoteUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });

    await waitUntil(() =>
      harness.timeline.includes(`tabs.sendMessage:response:${tab.id}:content.inspectConversation`),
    );
    harness.setTabUrl(tab.id, REMOTE_A);
    socket.deliverFromHost(sendEnvelope(runId, REMOTE_A));
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === runId && run.phase === "active") === true,
    );

    harness.setTabFrozen(tab.id, true);
    await waitUntil(() => harness.tabsById.get(tab.id)?.frozen === false, 5_000);
    await waitUntil(() => recoverCount >= 1, 5_000);

    harness.setTabDiscarded(tab.id, true);
    await waitUntil(() => harness.tabsById.get(tab.id)?.discarded === false, 5_000);
    await waitUntil(() => recoverCount >= 2, 5_000);

    expect(sendCount).toBe(1);
    expect(
      harness.tabsById.get(tab.id),
      [
        ...harness.timeline.slice(-40),
        `activeRuns=${JSON.stringify(harness.sessionValue("activeRunsV2"))}`,
        `errors=${JSON.stringify(runErrors(harness, socket, runId))}`,
      ].join("\n"),
    ).toMatchObject({
      discarded: false,
      frozen: false,
      autoDiscardable: false,
    });

    await harness.importContentScript(tab.id, async () => undefined);
    await expect(
      chrome.runtime.sendMessage({
        type: "content.event",
        eventType: "stopped",
        conversationId: CONVERSATION_ID,
        runId,
        markdown: "Stopped after lifecycle recovery",
        remoteUrl: REMOTE_A,
      }),
    ).resolves.toEqual({ ok: true });
    await waitUntil(() => harness.tabsById.get(tab.id)?.autoDiscardable === true);
  }, 10_000);

  it("wakes a frozen background tab and restores the user's active tab", async () => {
    const { harness, socket, tab } = await startHarness();
    const homeWindowId = tab.windowId;
    const previousTab = await chrome.tabs.create({
      url: "https://example.test/background-recovery-baseline",
      active: true,
    });
    if (previousTab.id === undefined) throw new Error("Fake Chrome did not create a user tab.");

    const runId = "run-frozen-background-tab";
    let sendCount = 0;
    let recoverCount = 0;
    harness.installTabMessageResponder(tab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return {
          ok: true,
          pageUrl: harness.tabsById.get(tab.id)?.url,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.send")) {
        sendCount += 1;
        return { ok: true, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      if (isMessageType(message, "content.recover")) {
        recoverCount += 1;
        return {
          ok: true,
          active: true,
          matchedActiveRun: true,
          markdown: "",
          remoteUrl: REMOTE_A,
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      if (isMessageType(message, "content.inspectConversation")) {
        return {
          ok: true,
          remoteUrl: REMOTE_A,
          complete: true,
          historyComplete: true,
          messages: [
            { role: "user", markdown: "Explain the relay race." },
            { role: "assistant", markdown: "Stopped after background recovery" },
          ],
          observedAt: new Date().toISOString(),
          selectorVersion: CONTENT_RUNTIME_REVISION,
        };
      }
      return { ok: false };
    });

    await waitUntil(() =>
      harness.timeline.includes(`tabs.sendMessage:response:${tab.id}:content.inspectConversation`),
    );
    harness.setTabUrl(tab.id, REMOTE_A);
    socket.deliverFromHost(sendEnvelope(runId, REMOTE_A));
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; phase?: string }> | undefined
        )?.some((run) => run.runId === runId && run.phase === "active") === true,
    );

    expect(harness.tabsById.get(tab.id)?.windowId).toBe(homeWindowId);
    expect(harness.tabsById.get(previousTab.id)?.active).toBe(true);
    expect(harness.tabsById.get(tab.id)?.active).toBe(false);
    harness.setTabFrozen(tab.id, true);
    await waitUntil(() => harness.tabsById.get(tab.id)?.frozen === false, 5_000);
    await waitUntil(() => recoverCount >= 1, 5_000);

    expect(sendCount).toBe(1);
    expect(recoverCount).toBeGreaterThanOrEqual(1);
    expect(harness.tabsById.get(previousTab.id)?.active).toBe(true);
    expect(harness.tabsById.get(tab.id)?.active).toBe(false);
    expect(harness.timeline.some((entry) => entry === `tab-active:${tab.id}:true`)).toBe(true);

    harness.setTabDiscarded(tab.id, true);
    await waitUntil(() => harness.tabsById.get(tab.id)?.discarded === false, 5_000);
    await waitUntil(() => recoverCount >= 2, 5_000);
    expect(sendCount).toBe(1);
    expect(harness.tabsById.get(previousTab.id)?.active).toBe(true);
    expect(harness.tabsById.get(tab.id)?.active).toBe(false);
    expect(runErrors(harness, socket, runId)).toHaveLength(0);

    await harness.importContentScript(tab.id, async () => undefined);
    await expect(
      chrome.runtime.sendMessage({
        type: "content.event",
        eventType: "stopped",
        conversationId: CONVERSATION_ID,
        runId,
        markdown: "Stopped after background recovery",
        remoteUrl: REMOTE_A,
      }),
    ).resolves.toEqual({ ok: true });
    await waitUntil(
      () =>
        harness.tabsById.get(tab.id)?.autoDiscardable === true &&
        harness.tabsById.get(tab.id)?.windowId === homeWindowId &&
        harness.tabsById.get(tab.id)?.active === false,
    );
    expect(harness.tabsById.get(previousTab.id)?.active).toBe(true);
    expect(harness.timeline.some((entry) => entry.startsWith("window-created:"))).toBe(false);
  }, 10_000);

  it("completes a fast answer when stop was missed and response actions require hover", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, { autoCanonicalize: false });
    const style = document.createElement("style");
    style.textContent = 'button[aria-label="Copy response"] { display: none; }';
    document.head.append(style);
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.snapshot" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );
    expect(
      getComputedStyle(requireElement<HTMLButtonElement>('button[aria-label="Copy response"]'))
        .display,
    ).toBe("none");
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );
    expect(complete.payload).toMatchObject({
      markdown: "Short answer completed on provisional A",
      remoteUrl: REMOTE_A,
    });
    const history = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.snapshot" &&
        (envelope.payload as { remoteUrl?: string; complete?: boolean }).remoteUrl === REMOTE_A &&
        (envelope.payload as { complete?: boolean }).complete === true,
      5_000,
    );
    expect(history.payload).toMatchObject({
      remoteUrl: REMOTE_A,
      complete: true,
      messages: [
        { role: "user", markdown: "Explain the relay race." },
        { role: "assistant", markdown: "Short answer completed on provisional A" },
      ],
    });
    expect(page.sendClicks()).toBe(1);
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
      ),
    ).toHaveLength(1);
    expect(
      harness
        .outboundEnvelopes(socket)
        .filter(
          (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
        ),
    ).toHaveLength(1);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 8_000);

  it("retries transcript synchronization when canonical content loads late", async () => {
    const { harness, socket, tab } = await startHarness();
    installChatGptComposerFixture(harness, tab.id, { canonicalContentDelayMs: 1_500 });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
    );
    const terminalEnvelopeIndex = harness
      .outboundEnvelopes(socket)
      .findIndex(
        (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      );
    expect(terminalEnvelopeIndex).toBeGreaterThanOrEqual(0);
    const history = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.snapshot" &&
        (envelope.payload as { remoteUrl?: string; complete?: boolean }).remoteUrl === REMOTE_B &&
        (envelope.payload as { complete?: boolean }).complete === true,
      8_000,
    );
    expect(history.payload).toMatchObject({ remoteUrl: REMOTE_B, complete: true });
    expect(
      harness
        .outboundEnvelopes(socket)
        .slice(terminalEnvelopeIndex + 1)
        .some(
          (envelope) =>
            envelope.type === "conversation.snapshot" &&
            envelope.conversationId === CONVERSATION_ID &&
            (envelope.payload as { complete?: boolean }).complete === false,
        ),
    ).toBe(false);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 12_000);

  it("finishes a fast answer before ChatGPT assigns a conversation URL", async () => {
    const { harness, socket, tab } = await startHarness();
    installChatGptComposerFixture(harness, tab.id, {
      provisionalUrlDelayMs: 3_500,
      canonicalUrlDelayMs: 4_200,
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    const sentAt = Date.now();
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
      3_000,
    );
    expect(Date.now() - sentAt).toBeLessThan(3_000);
    expect(complete.payload).toMatchObject({
      markdown: "Short answer completed on provisional A",
    });
    expect(complete.payload).not.toHaveProperty("remoteUrl");

    const canonicalHistory = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.snapshot" &&
        (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_B,
      10_000,
    );
    expect(canonicalHistory.payload).toMatchObject({
      remoteUrl: REMOTE_B,
      complete: true,
      messages: [
        { role: "user", markdown: "Explain the relay race." },
        { role: "assistant", markdown: "Short answer completed on provisional A" },
      ],
    });
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 15_000);

  it("does not bind a post-completion page that only copies the same answer", async () => {
    const { harness, socket, tab } = await startHarness();
    installChatGptComposerFixture(harness, tab.id, {
      provisionalUrlDelayMs: 10_000,
      canonicalUrlDelayMs: 11_000,
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
    );

    requireElement<HTMLElement>('[data-message-author-role="user"]').innerHTML =
      "<p>A different question that happens to receive the same answer.</p>";
    harness.setPrimaryDocumentUrl(REMOTE_C);
    harness.setTabUrl(tab.id, REMOTE_C);
    harness.emitTabUrlUpdated(tab.id, REMOTE_C);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) =>
            envelope.type === "conversation.snapshot" &&
            (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_C,
        ),
    ).toBe(false);
    const stored = (
      harness.sessionValue("conversationTabsV2") as
        Array<{ conversationId?: string; remoteUrl?: string }> | undefined
    )?.find((record) => record.conversationId === CONVERSATION_ID);
    expect(stored).toBeDefined();
    expect(stored).not.toHaveProperty("remoteUrl");
  }, 12_000);

  it("keeps a local conversation fixed to its original page after manual navigation", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id);
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.snapshot" &&
        (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_B,
    );

    page.renderOtherConversation();
    harness.setPrimaryDocumentUrl(REMOTE_C);
    harness.setTabUrl(tab.id, REMOTE_C);
    harness.emitTabUrlUpdated(tab.id, REMOTE_C);

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) =>
            envelope.type === "conversation.snapshot" &&
            (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_C,
        ),
    ).toBe(false);
    expect(harness.sessionValue("conversationTabsV2")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conversationId: CONVERSATION_ID, remoteUrl: REMOTE_B }),
      ]),
    );

    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        payload: { remoteUrl: REMOTE_B, active: false },
      }),
    );
    await waitUntil(() => harness.tabsById.get(tab.id)?.url === REMOTE_B);
    expect(harness.tabsById.get(tab.id)?.url).toBe(REMOTE_B);
  }, 12_000);

  it("restores the same remote page when switching conversations or recreating a closed tab", async () => {
    const { harness, socket, tab: firstTab } = await startHarness();
    installChatGptComposerFixture(harness, firstTab.id);
    await harness.importContentScript(firstTab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.snapshot" &&
        (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_B,
    );

    const secondConversationId = "conversation-b";
    const secondTabPromise = harness.waitForCreatedTab(1);
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: secondConversationId,
        payload: { active: false },
      }),
    );
    const secondTab = await secondTabPromise;
    harness.installTabMessageResponder(secondTab.id, (message) =>
      isMessageType(message, "content.ping")
        ? { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION }
        : { ok: false },
    );
    await waitUntil(
      () =>
        (
          harness.sessionValue("conversationTabsV2") as
            Array<{ conversationId?: string; tabId?: number }> | undefined
        )?.some(
          (record) =>
            record.conversationId === secondConversationId && record.tabId === secondTab.id,
        ) === true,
    );

    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        payload: { remoteUrl: REMOTE_B, active: false },
      }),
    );
    await waitUntil(() => harness.tabsById.get(firstTab.id)?.url === REMOTE_B);
    expect(harness.tabsById.size).toBe(2);
    expect(harness.tabsById.get(firstTab.id)?.url).toBe(REMOTE_B);
    expect(harness.tabsById.get(secondTab.id)?.url).toBe(PROJECT_ROOT);

    await chrome.tabs.remove(firstTab.id);
    const restoredTabPromise = harness.waitForCreatedTab(1);
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        payload: { remoteUrl: REMOTE_B, active: false },
      }),
    );
    const restoredTab = await restoredTabPromise;
    harness.installTabMessageResponder(restoredTab.id, (message) =>
      isMessageType(message, "content.ping")
        ? { ok: true, pageUrl: REMOTE_B, selectorVersion: CONTENT_RUNTIME_REVISION }
        : { ok: false },
    );
    await waitUntil(
      () =>
        (
          harness.sessionValue("conversationTabsV2") as
            Array<{ conversationId?: string; tabId?: number; remoteUrl?: string }> | undefined
        )?.some(
          (record) =>
            record.conversationId === CONVERSATION_ID &&
            record.tabId === restoredTab.id &&
            record.remoteUrl === REMOTE_B,
        ) === true,
    );

    expect(restoredTab.id).not.toBe(firstTab.id);
    expect(harness.tabsById.get(restoredTab.id)?.url).toBe(REMOTE_B);
    expect(harness.tabsById.get(secondTab.id)?.url).toBe(PROJECT_ROOT);
  }, 15_000);

  it("preserves an empty stopped response while a later canonical URL is synchronized", async () => {
    const { harness, socket, tab } = await startHarness();
    installChatGptComposerFixture(harness, tab.id, { terminalMode: "stopped-empty" });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await waitUntil(
      () =>
        (
          harness.sessionValue("conversationTabsV2") as Array<{ remoteUrl?: string }> | undefined
        )?.some((record) => record.remoteUrl === REMOTE_A) === true,
    );
    socket.deliverFromHost(stopEnvelope(FIRST_RUN_ID));
    const stopped = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.stopped" && envelope.runId === FIRST_RUN_ID,
    );
    expect(stopped.payload).toMatchObject({ markdown: "", remoteUrl: REMOTE_A });

    const history = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "conversation.snapshot" &&
        (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_B,
    );
    expect(history.payload).toMatchObject({
      complete: true,
      messages: [{ role: "user", markdown: "Explain the relay race." }],
    });
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 12_000);

  it("keeps receiving the exact run on its locked URL after the former 30-second window", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, {
      terminalMode: "streaming",
      autoCanonicalize: false,
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "generation.snapshot" &&
        envelope.runId === FIRST_RUN_ID &&
        (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_A,
    );

    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 31_000);
    page.updatePrimaryAssistant("Still streaming after thirty-one seconds");

    const continued = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "generation.snapshot" &&
        envelope.runId === FIRST_RUN_ID &&
        (envelope.payload as { remoteUrl?: string; markdown?: string }).remoteUrl === REMOTE_A &&
        (envelope.payload as { markdown?: string }).markdown ===
          "Still streaming after thirty-one seconds",
    );
    expect(continued.payload).toMatchObject({
      markdown: "Still streaming after thirty-one seconds",
      remoteUrl: REMOTE_A,
    });
    expect(
      (
        harness.sessionValue("activeRunsV2") as
          | Array<{
              runId?: string;
              remoteAdoptionStage?: string;
              dispatchTranscriptBaseline?: { remoteUrl?: string };
            }>
          | undefined
      )?.find((run) => run.runId === FIRST_RUN_ID),
    ).toMatchObject({
      remoteAdoptionStage: "locked",
      dispatchTranscriptBaseline: { remoteUrl: REMOTE_A },
    });
    expect(
      (
        harness.sessionValue("conversationTabsV2") as
          Array<{ conversationId?: string; remoteUrl?: string }> | undefined
      )?.find((record) => record.conversationId === CONVERSATION_ID),
    ).toMatchObject({ remoteUrl: REMOTE_A });
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) =>
            envelope.runId === FIRST_RUN_ID &&
            (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_B,
        ),
    ).toBe(false);
    expect(page.sendClicks()).toBe(1);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 12_000);

  it("fails closed when an active mapped tab is manually switched to an identical Project conversation", async () => {
    const { harness, socket, tab } = await startHarness();
    installChatGptComposerFixture(harness, tab.id, {
      terminalMode: "streaming",
      autoCanonicalize: false,
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "generation.snapshot" &&
        envelope.runId === FIRST_RUN_ID &&
        (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_A,
      5_000,
    );

    // Keep the exact same prompt, partial answer, and DOM-owned run in place.
    // Transcript equality cannot authorize a manual cross-conversation route.
    harness.setPrimaryDocumentUrl(REMOTE_C);
    harness.setTabUrl(tab.id, REMOTE_C);
    harness.emitTabUrlUpdated(tab.id, REMOTE_C);
    await chrome.runtime.sendMessage({
      type: "content.recovery.request",
      conversationId: CONVERSATION_ID,
      runId: FIRST_RUN_ID,
      selectorVersion: CONTENT_RUNTIME_REVISION,
      reason: "network-complete-dom-missing",
    });

    const error = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "relay.error" && envelope.runId === FIRST_RUN_ID,
      5_000,
    );
    expect(error.payload).toMatchObject({ code: "CHATGPT_REMOTE_UNAVAILABLE" });
    expect(
      harness
        .outboundEnvelopes(socket)
        .some(
          (envelope) =>
            envelope.runId === FIRST_RUN_ID &&
            (envelope.type === "generation.snapshot" || envelope.type === "generation.complete") &&
            (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_C,
        ),
    ).toBe(false);
    expect(
      (
        harness.sessionValue("conversationTabsV2") as
          Array<{ conversationId?: string; remoteUrl?: string }> | undefined
      )?.find((record) => record.conversationId === CONVERSATION_ID),
    ).toBeUndefined();
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
      ),
    ).toHaveLength(1);
  }, 12_000);

  it("keeps a locked URL after a reload recovers the run from one visible stop control", async () => {
    vi.resetModules();
    makeElementsVisibleToTheContentScript();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    const boundAt = "2026-07-28T00:00:00.000Z";
    harness.seedLocalValue("projectBindingV6", {
      version: 5,
      provenance: "strict-visible-project-v1",
      projectUrl: PROJECT_ROOT,
      scope: PROJECT_SCOPE,
      name: "Ask2GPT",
      boundAt,
    });
    const createdTab = await chrome.tabs.create({ url: REMOTE_A, active: false });
    if (createdTab.id === undefined) throw new Error("Fake Chrome did not create a tab id.");
    const tabId = createdTab.id;
    window.history.replaceState({}, "", REMOTE_A);
    document.title = "Recovered relay race";
    document.body.innerHTML = `<main><section id="thread">${primaryConversationMarkup(
      "streaming",
    )}</section></main>`;
    await harness.importContentScript(tabId, async () => await import("./content-script"));

    const startedAt = new Date().toISOString();
    const emptyTranscriptSha256 = await sha256FixtureHex(JSON.stringify([]));
    harness.seedLocalValue("relayReloadCheckpointV1", {
      version: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      conversationTabs: [
        {
          owned: true,
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          tabId,
          remoteUrl: REMOTE_A,
          projectScope: PROJECT_SCOPE,
          createdAt: startedAt,
        },
      ],
      activeRuns: [
        {
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          runId: FIRST_RUN_ID,
          tabId,
          phase: "active",
          remoteAdoptionStage: "locked",
          promptSha256: FIRST_PROMPT_SHA256,
          dispatchTranscriptBaseline: {
            tabId,
            remoteUrl: REMOTE_A,
            initialProjectUrl: PROJECT_ROOT,
            messageCount: 0,
            transcriptSha256: emptyTranscriptSha256,
          },
          startedAt,
        },
      ],
      completedCanonicalizations: [],
      projectBindingVerification: {
        version: 1,
        projectUrl: PROJECT_ROOT,
        boundAt,
      },
    });

    await harness.importServiceWorker(async () => await import("./service-worker"));
    const socket = await harness.waitForSocket();
    await connectFakeVsCodeHost(harness, socket);
    await waitUntil(() =>
      harness.timeline.includes(`tabs.sendMessage:response:${tabId}:content.recover`),
    );
    await waitUntil(
      () =>
        (
          harness.sessionValue("activeRunsV2") as
            Array<{ runId?: string; remoteAdoptionStage?: string }> | undefined
        )?.some((run) => run.runId === FIRST_RUN_ID && run.remoteAdoptionStage === "locked") ===
        true,
    );

    // The rebuilt observer may continue the exact in-flight turn on its fixed
    // mapped URL, but recovery never authorizes a cross-conversation move.
    requireElement<HTMLElement>('[data-message-author-role="assistant"]').innerHTML =
      "<p>Recovered stream continued on locked A</p>";

    const continued = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "generation.snapshot" &&
        envelope.runId === FIRST_RUN_ID &&
        (envelope.payload as { remoteUrl?: string; markdown?: string }).remoteUrl === REMOTE_A &&
        (envelope.payload as { markdown?: string }).markdown ===
          "Recovered stream continued on locked A",
    );
    expect(continued.payload).toMatchObject({
      markdown: "Recovered stream continued on locked A",
      remoteUrl: REMOTE_A,
    });

    requireElement<HTMLButtonElement>('[data-testid="stop-button"]').outerHTML =
      '<button type="button" aria-label="Copy response">Copy</button>';
    const complete = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === FIRST_RUN_ID,
    );
    expect(complete.payload).toMatchObject({ remoteUrl: REMOTE_A });
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tabId}:content.send`,
      ),
    ).toHaveLength(0);
    expect(
      (
        harness.sessionValue("conversationTabsV2") as
          Array<{ conversationId?: string; remoteUrl?: string }> | undefined
      )?.find((record) => record.conversationId === CONVERSATION_ID),
    ).toMatchObject({ remoteUrl: REMOTE_A });
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 15_000);

  it("stops synchronization if ChatGPT leaves the bound Project scope", async () => {
    const { harness, socket, tab } = await startHarness();
    installChatGptComposerFixture(harness, tab.id, {
      terminalMode: "streaming",
      autoCanonicalize: false,
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "generation.snapshot" &&
        envelope.runId === FIRST_RUN_ID &&
        (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_A,
    );

    const outsideProject = "https://chatgpt.com/c/outside-project";
    harness.setPrimaryDocumentUrl(outsideProject);
    harness.setTabUrl(tab.id, outsideProject);
    harness.emitTabUrlUpdated(tab.id, outsideProject);

    const error = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "relay.error" && envelope.runId === FIRST_RUN_ID,
    );
    expect(error.payload).toMatchObject({
      code: "CHATGPT_PROJECT_MISMATCH",
      focusTab: false,
    });
  }, 12_000);

  it("keeps two VS Code instances isolated while selected tabs change", async () => {
    const { harness, socket, tab } = await startHarness();
    const page = installChatGptComposerFixture(harness, tab.id, {
      terminalMode: "streaming",
      autoCanonicalize: false,
    });
    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    socket.deliverFromHost(sendEnvelope(FIRST_RUN_ID));
    await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "generation.snapshot" &&
        envelope.runId === FIRST_RUN_ID &&
        (envelope.payload as { remoteUrl?: string }).remoteUrl === REMOTE_A,
    );

    const otherSocket = await harness.waitForSocket(32_172);
    otherSocket.open();
    const otherInstance = "window-b";
    otherSocket.deliverFromHost(
      makeEnvelope({
        type: "relay.ready",
        instanceId: otherInstance,
        payload: { serverLabel: "Other Window", serverInstanceId: otherInstance },
      }),
    );
    await harness.waitForEnvelope(otherSocket, (envelope) => envelope.type === "relay.status");
    const otherTabPromise = harness.waitForCreatedTab(1);
    otherSocket.deliverFromHost(
      makeEnvelope({
        type: "conversation.open",
        instanceId: otherInstance,
        conversationId: CONVERSATION_ID,
        payload: { active: false },
      }),
    );
    const otherTab = await otherTabPromise;
    harness.installTabMessageResponder(otherTab.id, (message) => {
      if (isMessageType(message, "content.ping")) {
        return { ok: true, pageUrl: PROJECT_ROOT, selectorVersion: CONTENT_RUNTIME_REVISION };
      }
      return { ok: false };
    });
    await waitUntil(
      () =>
        (
          harness.sessionValue("conversationTabsV2") as
            Array<{ instanceId?: string; tabId?: number }> | undefined
        )?.some((record) => record.instanceId === otherInstance && record.tabId === otherTab.id) ===
        true,
    );

    harness.emitTabActivated(otherTab.id);
    expect(harness.tabsById.get(tab.id)?.active).toBe(false);
    page.updatePrimaryAssistant("First window continues in its owned background tab");

    const firstWindowUpdate = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "generation.snapshot" &&
        envelope.runId === FIRST_RUN_ID &&
        (envelope.payload as { remoteUrl?: string; markdown?: string }).remoteUrl === REMOTE_A &&
        (envelope.payload as { markdown?: string }).markdown ===
          "First window continues in its owned background tab",
    );
    expect(firstWindowUpdate.instanceId).toBe(INSTANCE_ID);
    expect(
      harness
        .outboundEnvelopes(otherSocket)
        .every(
          (envelope) =>
            ![
              "conversation.snapshot",
              "conversation.title",
              "generation.snapshot",
              "generation.complete",
              "generation.stopped",
            ].includes(envelope.type),
        ),
    ).toBe(true);
    expect(
      harness.sessionValue("conversationTabsV2") as
        Array<{ instanceId?: string; tabId?: number; remoteUrl?: string }> | undefined,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instanceId: INSTANCE_ID, tabId: tab.id, remoteUrl: REMOTE_A }),
        expect.objectContaining({ instanceId: otherInstance, tabId: otherTab.id }),
      ]),
    );
    expect(page.sendClicks()).toBe(1);
    expect(
      harness.timeline.filter(
        (entry) => entry === `tabs.sendMessage:request:${tab.id}:content.send`,
      ),
    ).toHaveLength(1);
    expect(runErrors(harness, socket, FIRST_RUN_ID)).toHaveLength(0);
  }, 12_000);

  it("waits for slow isolated-world model controls without dispatching duplicates", async () => {
    const { harness, socket, tab } = await startHarness();
    installChatGptComposerFixture(harness, tab.id);
    let modelListCommands = 0;
    let modelSelectCommands = 0;
    let selectingModel = false;
    harness.beforeTabMessage = (_tabId, message) => {
      if (isMessageType(message, "content.model.list")) modelListCommands += 1;
      if (isMessageType(message, "content.model.select")) modelSelectCommands += 1;
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://chatgpt.com/api/auth/session") {
        return delayedJsonResponse(
          { accessToken: "ask2gpt-session-token-123456" },
          selectingModel ? 650 : 2_500,
          init?.signal,
        );
      }
      if (url === "https://chatgpt.com/backend-api/models") {
        return delayedJsonResponse(
          {
            models: [
              {
                slug: "gpt-5-5",
                title: "GPT-5.5",
                reasoning_type: "auto",
                is_default: true,
              },
            ],
          },
          selectingModel ? 650 : 3_000,
          init?.signal,
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(
      makeEnvelope({
        type: "model.list",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        payload: { requestId: "slow-model-list" },
      }),
    );
    const catalog = await harness.waitForEnvelope(
      socket,
      (envelope) =>
        envelope.type === "model.catalog" &&
        (envelope.payload as { requestId?: string }).requestId === "slow-model-list",
      10_000,
    );

    expect(catalog.payload).toMatchObject({
      requestId: "slow-model-list",
      currentModelId: "mode-smart",
      options: [expect.objectContaining({ id: "mode-smart", modelId: "gpt-5-5" })],
    });

    selectingModel = true;
    const acceptIntent = () => {
      const intent = document.documentElement.getAttribute("data-ask2gpt-model-intent");
      if (intent) document.documentElement.setAttribute("data-ask2gpt-model-ready", intent);
    };
    document.addEventListener("ask2gpt:model-intent", acceptIntent);
    try {
      socket.deliverFromHost(
        makeEnvelope({
          type: "model.select",
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          payload: { requestId: "slow-model-select", modelId: "mode-smart" },
        }),
      );
      const selected = await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "model.selected" &&
          (envelope.payload as { requestId?: string }).requestId === "slow-model-select",
        5_000,
      );
      expect(selected.payload).toMatchObject({
        requestId: "slow-model-select",
        selected: { id: "mode-smart", modelId: "gpt-5-5", selected: true },
      });
    } finally {
      document.removeEventListener("ask2gpt:model-intent", acceptIntent);
    }

    expect(modelListCommands).toBe(1);
    expect(modelSelectCommands).toBe(1);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "https://chatgpt.com/api/auth/session",
      "https://chatgpt.com/backend-api/models",
      "https://chatgpt.com/api/auth/session",
      "https://chatgpt.com/backend-api/models",
    ]);
    expect(
      harness
        .outboundEnvelopes(socket)
        .filter(
          (envelope) =>
            envelope.type === "model.catalog" &&
            (envelope.payload as { requestId?: string }).requestId === "slow-model-list",
        ),
    ).toHaveLength(1);
    expect(
      harness
        .outboundEnvelopes(socket)
        .filter(
          (envelope) =>
            envelope.type === "model.selected" &&
            (envelope.payload as { requestId?: string }).requestId === "slow-model-select",
        ),
    ).toHaveLength(1);
    expect(
      harness.outboundEnvelopes(socket).filter((envelope) => envelope.type === "relay.error"),
    ).toHaveLength(0);
  }, 15_000);

  it("fails closed without opening a visible picker when account modes are unavailable", async () => {
    const { harness, socket, tab } = await startHarness();
    installChatGptComposerFixture(harness, tab.id);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("session model catalog unavailable");
      }),
    );
    const modelPicker = installVisibleModelPickerFixture();
    await harness.importContentScript(tab.id, async () => await import("./content-script"));

    socket.deliverFromHost(
      makeEnvelope({
        type: "model.list",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        payload: { requestId: "model-list-request" },
      }),
    );
    const error = await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "relay.error",
    );
    expect(error.payload).toMatchObject({ code: "CHATGPT_MODEL_UNAVAILABLE" });
    expect(modelPicker.triggerClicks()).toBe(0);
    modelPicker.removeFromPage();
  });

  it("uploads a large code context as a file before sending the compact prompt", async () => {
    const { harness, socket, tab } = await startHarness();
    installChatGptComposerFixture(harness, tab.id);
    const form = requireElement<HTMLFormElement>("form");
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.multiple = true;
    form.prepend(fileInput);

    let selectedFiles: File[] = [];
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      get: () => selectedFiles,
      set: (value: Iterable<File>) => {
        selectedFiles = [...value];
      },
    });
    fileInput.addEventListener("change", () => {
      for (const file of selectedFiles) {
        const chip = document.createElement("span");
        chip.textContent = file.name;
        form.append(chip);
      }
    });
    vi.stubGlobal(
      "DataTransfer",
      class {
        readonly files: File[] = [];
        readonly items = { add: (file: File) => this.files.push(file) };
      },
    );
    const attachmentDecorationObserver = new MutationObserver(() => {
      const user = document.querySelector<HTMLElement>('[data-message-author-role="user"]');
      if (!user || user.textContent?.includes("large.ts")) return;
      const fileName = document.createElement("span");
      fileName.textContent = "large.ts";
      user.append(fileName);
    });
    attachmentDecorationObserver.observe(requireElement("#thread"), {
      childList: true,
      subtree: true,
    });

    await harness.importContentScript(tab.id, async () => await import("./content-script"));
    socket.deliverFromHost(
      makeEnvelope({
        type: "conversation.send",
        instanceId: INSTANCE_ID,
        conversationId: CONVERSATION_ID,
        runId: "run-with-file",
        payload: {
          prompt: "Attached code files:\n- large.ts\n\nQuestion:\nReview it.",
          messageId: "message-with-file",
          attachments: [
            {
              id: "context-large",
              fileName: "large.ts",
              mimeType: "text/typescript",
              content: "export const answer = 42;",
            },
          ],
        },
      }),
    );

    await harness.waitForEnvelope(
      socket,
      (envelope) => envelope.type === "generation.complete" && envelope.runId === "run-with-file",
    );
    expect(selectedFiles).toHaveLength(1);
    expect(selectedFiles[0]).toMatchObject({ name: "large.ts", type: "text/typescript" });
    expect(requireElement<HTMLTextAreaElement>("#prompt-textarea").value).toBe("");
    expect(runErrors(harness, socket, "run-with-file")).toHaveLength(0);
    attachmentDecorationObserver.disconnect();
  });

  it("resolves a UI tier at send time and persists it without foregrounding the picker", async () => {
    const { harness, socket, tab } = await startHarness();
    // This case verifies deferred model resolution. Keep the unrelated
    // provisional-to-canonical URL transition outside the short pre-submit
    // composer stabilization window; dedicated tests cover that race.
    installChatGptComposerFixture(harness, tab.id, { canonicalUrlDelayMs: 3_000 });
    const contentSendMessages: Array<Record<string, unknown>> = [];
    harness.beforeTabMessage = (_tabId, message) => {
      if (isMessageType(message, "content.send")) {
        contentSendMessages.push(structuredClone(message as Record<string, unknown>));
      }
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                slug: "gpt-5-5",
                title: "GPT-5.5",
                reasoning_type: "auto",
                is_default: true,
              },
              {
                slug: "gpt-5-5-instant",
                title: "GPT-5.5 Instant",
                reasoning_type: "none",
              },
              {
                slug: "gpt-5-6-thinking",
                title: "GPT-5.6 Thinking",
                reasoning_type: "reasoning",
                configurable_thinking_effort: true,
                thinking_efforts: [
                  { thinking_effort: "standard", short_label: "Standard" },
                  { thinking_effort: "extended", short_label: "Deep" },
                  { thinking_effort: "max", short_label: "Deepest" },
                ],
              },
              {
                slug: "gpt-5.6-sol-wm",
                title: "GPT-5.6 Sol",
                reasoning_type: "reasoning",
                is_work_mode_model: true,
              },
              {
                slug: "gpt-5-6-pro",
                title: "GPT-5.6 Pro",
                reasoning_type: "pro",
                configurable_thinking_effort: true,
                thinking_efforts: [{ thinking_effort: "standard", short_label: "Standard" }],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const acceptIntent = () => {
      const modelId = document.documentElement.getAttribute("data-ask2gpt-model-intent");
      if (modelId) document.documentElement.setAttribute("data-ask2gpt-model-ready", modelId);
    };
    document.addEventListener("ask2gpt:model-intent", acceptIntent);
    try {
      await harness.importContentScript(tab.id, async () => await import("./content-script"));

      // The UI chooses a stable web tier without waiting for this catalog.
      // The Relay resolves and applies its account-specific model as part of
      // the first actual send.
      socket.deliverFromHost(
        makeEnvelope({
          type: "conversation.send",
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          runId: "run-with-deferred-model",
          payload: {
            prompt: "Explain deferred model selection.",
            messageId: "message-with-deferred-model",
            modelId: "mode-high",
          },
        }),
      );
      await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "generation.complete" && envelope.runId === "run-with-deferred-model",
        10_000,
      );
      expect(contentSendMessages[0]).toMatchObject({
        type: "content.send",
        runId: "run-with-deferred-model",
        modelId: "gpt-5-6-thinking",
        modelLabel: "GPT-5.6 Sol",
        reasoningEffort: "extended",
      });

      socket.deliverFromHost(
        makeEnvelope({
          type: "model.list",
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          payload: { requestId: "session-model-list" },
        }),
      );
      const catalog = await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "model.catalog" &&
          (envelope.payload as { requestId?: string }).requestId === "session-model-list",
        10_000,
      );
      expect(catalog.payload).toMatchObject({
        currentModelId: "mode-high",
        options: [
          { id: "mode-smart", mode: "smart", modelId: "gpt-5-5", selected: false },
          { id: "mode-fast", mode: "fast", modelId: "gpt-5-5-instant", selected: false },
          {
            id: "mode-medium",
            mode: "medium",
            modelId: "gpt-5-6-thinking",
            reasoningEffort: "standard",
          },
          {
            id: "mode-high",
            mode: "high",
            modelId: "gpt-5-6-thinking",
            reasoningEffort: "extended",
            selected: true,
          },
          {
            id: "mode-very-high",
            mode: "very-high",
            modelId: "gpt-5-6-thinking",
            reasoningEffort: "max",
          },
          { id: "mode-pro", mode: "pro", modelId: "gpt-5-6-pro" },
        ],
      });

      socket.deliverFromHost(
        makeEnvelope({
          type: "model.select",
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          payload: { requestId: "session-model-select", modelId: "mode-high" },
        }),
      );
      const selected = await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "model.selected" &&
          (envelope.payload as { requestId?: string }).requestId === "session-model-select",
        10_000,
      );
      expect(selected.payload).toMatchObject({
        selected: {
          id: "mode-high",
          modelId: "gpt-5-6-thinking",
          reasoningEffort: "extended",
          selected: true,
        },
      });

      socket.deliverFromHost(
        makeEnvelope({
          type: "conversation.send",
          instanceId: INSTANCE_ID,
          conversationId: CONVERSATION_ID,
          runId: "run-with-persisted-model",
          payload: {
            prompt: "Explain the persisted model selection.",
            messageId: "message-with-persisted-model",
          },
        }),
      );
      await harness.waitForEnvelope(
        socket,
        (envelope) =>
          envelope.type === "generation.complete" && envelope.runId === "run-with-persisted-model",
        10_000,
      );
      expect(contentSendMessages).toEqual([
        expect.objectContaining({
          type: "content.send",
          runId: "run-with-deferred-model",
          modelId: "gpt-5-6-thinking",
          modelLabel: "GPT-5.6 Sol",
          reasoningEffort: "extended",
        }),
        expect.objectContaining({
          type: "content.send",
          runId: "run-with-persisted-model",
          modelId: "gpt-5-6-thinking",
          modelLabel: "GPT-5.6 Sol",
          reasoningEffort: "extended",
        }),
      ]);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://chatgpt.com/backend-api/models",
        expect.objectContaining({ credentials: "include" }),
      );
    } finally {
      document.removeEventListener("ask2gpt:model-intent", acceptIntent);
    }
  }, 20_000);
});

function delayedJsonResponse(payload: unknown, delayMs: number, signal?: AbortSignal | null) {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
  }
  return new Promise<Response>((resolve, reject) => {
    let timer = 0;
    const handleAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }, delayMs);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

function installVisibleModelPickerFixture() {
  let triggerClickCount = 0;
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.dataset.testid = "model-switcher-dropdown-button";
  trigger.setAttribute("aria-label", "Model: GPT Fast");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-controls", "model-menu");

  const menu = document.createElement("div");
  menu.id = "model-menu";
  menu.setAttribute("role", "listbox");
  menu.style.display = "none";
  const options: HTMLButtonElement[] = [];
  for (const [index, label] of ["GPT Fast", "GPT Thinking"].entries()) {
    const option = document.createElement("button");
    option.type = "button";
    option.setAttribute("role", "option");
    option.setAttribute("aria-label", label);
    option.setAttribute("aria-selected", index === 0 ? "true" : "false");
    option.textContent = label;
    option.addEventListener("click", () => {
      for (const candidate of options) candidate.setAttribute("aria-selected", "false");
      option.setAttribute("aria-selected", "true");
      trigger.setAttribute("aria-label", `Model: ${label}`);
      menu.style.display = "none";
    });
    options.push(option);
    menu.append(option);
  }
  trigger.addEventListener("click", () => {
    triggerClickCount += 1;
    menu.style.display = menu.style.display === "none" ? "block" : "none";
  });
  document.body.prepend(trigger, menu);
  return {
    triggerClicks: () => triggerClickCount,
    removeFromPage: () => {
      trigger.remove();
      menu.remove();
    },
  };
}

async function startHarness(
  options: {
    acknowledgeTerminals?: boolean;
    debuggerPermission?: boolean;
    enhancedBackgroundReception?: boolean;
  } = {},
) {
  vi.resetModules();
  makeElementsVisibleToTheContentScript();
  const harness = new FakeChromeRelayHarness();
  harness.installGlobals();
  // The production manifest grants `debugger` at install time. Individual
  // permission-failure tests use a directly configured harness instead.
  if (options.debuggerPermission !== false) harness.setDebuggerPermission(true);
  if (options.enhancedBackgroundReception !== undefined) {
    harness.seedLocalValue("enhancedBackgroundReceptionV1", options.enhancedBackgroundReception);
  }
  seedProjectBinding(harness);
  await harness.importServiceWorker(async () => await import("./service-worker"));
  const socket = await harness.waitForSocket();
  await connectFakeVsCodeHost(harness, socket, options);
  const tabPromise = harness.waitForCreatedTab();
  // The tab is created by the first send; return a deferred-looking object by
  // issuing it in each test after installing the fixture is impossible, so
  // pre-create it with conversation.open.
  socket.deliverFromHost(
    makeEnvelope({
      type: "conversation.open",
      instanceId: INSTANCE_ID,
      conversationId: CONVERSATION_ID,
      payload: { active: false },
    }),
  );
  const tab = await tabPromise;
  window.history.replaceState({}, "", PROJECT_ROOT);
  return { harness, socket, tab };
}

function seedProjectBinding(harness: FakeChromeRelayHarness) {
  const boundAt = "2026-07-26T00:00:00.000Z";
  harness.seedLocalValue("projectBindingV6", {
    version: 5,
    provenance: "strict-visible-project-v1",
    projectUrl: PROJECT_ROOT,
    scope: PROJECT_SCOPE,
    name: "Ask2GPT",
    boundAt,
  });
  harness.seedSessionValue("projectBindingVerificationV1", {
    version: 1,
    projectUrl: PROJECT_ROOT,
    boundAt,
  });
}

function projectSidebarLink(projectUrl: string, name = "Ask2GPT") {
  return `<nav aria-label="Chat history"><ul><li><a href="${projectUrl}">${name}</a></li></ul></nav>`;
}

async function connectFakeVsCodeHost(
  harness: FakeChromeRelayHarness,
  socket: FakeRelayWebSocket,
  options: { acknowledgeTerminals?: boolean } = {},
) {
  socket.open();
  socket.deliverFromHost(
    makeEnvelope({
      type: "relay.ready",
      instanceId: INSTANCE_ID,
      payload: { serverLabel: "Integration Test", serverInstanceId: INSTANCE_ID },
    }),
  );
  await harness.waitForEnvelope(socket, (envelope) => envelope.type === "relay.status");
  expect(
    harness
      .outboundEnvelopes(socket)
      .some(
        (envelope) =>
          envelope.type === "relay.hello" &&
          (envelope.payload as { chromeExtensionId?: string }).chromeExtensionId ===
            CHROME_EXTENSION_ID,
      ),
  ).toBe(true);
  if (options.acknowledgeTerminals !== false) {
    socket.onChromeEnvelope = (envelope) => {
      if (
        !["generation.complete", "generation.stopped", "relay.error"].includes(envelope.type) ||
        !envelope.conversationId ||
        !envelope.runId
      ) {
        return;
      }
      queueMicrotask(() => {
        if (socket.readyState !== FakeRelayWebSocket.OPEN) return;
        socket.deliverFromHost(
          makeEnvelope({
            type: "generation.ack",
            instanceId: INSTANCE_ID,
            conversationId: envelope.conversationId!,
            runId: envelope.runId!,
            payload: { eventId: envelope.id, acknowledgedAt: new Date().toISOString() },
          }),
        );
      });
    };
  }
}

function sendEnvelope(runId: string, remoteUrl?: string): RelayEnvelope {
  return makeEnvelope({
    type: "conversation.send",
    instanceId: INSTANCE_ID,
    conversationId: CONVERSATION_ID,
    runId,
    payload: {
      prompt: "Explain the relay race.",
      messageId: `message-${runId}`,
      ...(remoteUrl ? { remoteUrl } : {}),
    },
  });
}

function stopEnvelope(runId: string): RelayEnvelope {
  return makeEnvelope({
    type: "generation.stop",
    instanceId: INSTANCE_ID,
    conversationId: CONVERSATION_ID,
    runId,
    payload: { requestedAt: new Date().toISOString() },
  });
}

function regenerateEnvelope(runId: string, remoteUrl: string): RelayEnvelope {
  return makeEnvelope({
    type: "generation.regenerate",
    instanceId: INSTANCE_ID,
    conversationId: CONVERSATION_ID,
    runId,
    payload: { messageId: `assistant-${runId}`, remoteUrl },
  });
}

function runErrors(harness: FakeChromeRelayHarness, socket: FakeRelayWebSocket, runId: string) {
  return harness
    .outboundEnvelopes(socket)
    .filter((envelope) => envelope.type === "relay.error" && envelope.runId === runId);
}

function installRunLifecycleBridgeFixture() {
  const acceptedRunIds: string[] = [];
  let pendingRunId: string | undefined;
  const intentListener = () => {
    const root = document.documentElement;
    const rawIntent = root.getAttribute("data-ask2gpt-run-intent");
    root.removeAttribute("data-ask2gpt-run-intent");
    root.removeAttribute("data-ask2gpt-run-ready");
    if (!rawIntent) return;
    const intent = JSON.parse(rawIntent) as { runId?: unknown };
    if (typeof intent.runId !== "string") return;
    pendingRunId = intent.runId;
    acceptedRunIds.push(intent.runId);
    root.setAttribute("data-ask2gpt-run-ready", rawIntent);
  };
  document.addEventListener("ask2gpt:run-intent", intentListener, true);

  return {
    acceptedRunIds: () => [...acceptedRunIds],
    pendingRunId: () => pendingRunId,
    emit(
      runId: string,
      phase: "submitted" | "response-started" | "response-complete" | "response-error",
      failure?: {
        failureKind: "http" | "network" | "stream";
        httpStatus?: number;
      },
    ) {
      const root = document.documentElement;
      const payload = JSON.stringify({ runId, phase, ...failure });
      root.setAttribute("data-ask2gpt-run-lifecycle", payload);
      document.dispatchEvent(new Event("ask2gpt:run-lifecycle"));
      if (root.getAttribute("data-ask2gpt-run-lifecycle") === payload) {
        root.removeAttribute("data-ask2gpt-run-lifecycle");
      }
    },
    dispose() {
      document.removeEventListener("ask2gpt:run-intent", intentListener, true);
      document.documentElement.removeAttribute("data-ask2gpt-run-ready");
      document.documentElement.removeAttribute("data-ask2gpt-run-lifecycle");
    },
  };
}

function installChatGptComposerFixture(
  harness: FakeChromeRelayHarness,
  tabId: number,
  {
    canonicalContentDelayMs = 0,
    terminalMode = "complete",
    autoCanonicalize = true,
    provisionalUrlDelayMs = 60,
    canonicalUrlDelayMs = 1_000,
    submissionMode = "button",
    submissionDelayMs = 0,
    falseSubmissionSignals = false,
    virtualizeFollowUp = false,
    reuseAssistantFollowUp,
    noFollowUpActions = false,
    followUpBusy = false,
    followUpStreaming = false,
    removeEmptyFollowUpSendControl = false,
  }: {
    canonicalContentDelayMs?: number;
    terminalMode?: "complete" | "stopped-empty" | "streaming" | "progress" | "visible-error";
    autoCanonicalize?: boolean;
    provisionalUrlDelayMs?: number;
    canonicalUrlDelayMs?: number;
    submissionMode?: "button" | "form";
    submissionDelayMs?: number;
    falseSubmissionSignals?: boolean;
    virtualizeFollowUp?: boolean;
    reuseAssistantFollowUp?:
      "identity-changed" | "identity-unavailable" | "network-only" | "in-place-user-text";
    noFollowUpActions?: boolean;
    followUpBusy?: boolean;
    followUpStreaming?: boolean;
    removeEmptyFollowUpSendControl?: boolean;
  } = {},
) {
  document.title = "Relay race";
  document.body.innerHTML = `
    <main>
      <section id="thread"></section>
      <form>
        <textarea id="prompt-textarea" aria-label="Message"></textarea>
        <button type="button" data-testid="send-button" aria-label="Send prompt">Send</button>
      </form>
    </main>`;
  const thread = requireElement<HTMLElement>("#thread");
  let form = requireElement<HTMLFormElement>("form");
  let composer = requireElement<HTMLTextAreaElement>("#prompt-textarea");
  let send = requireElement<HTMLButtonElement>('[data-testid="send-button"]');
  let submissionCount = 0;
  let sendClickCount = 0;
  let staleSendClickCount = 0;
  let formSubmitCount = 0;
  let composerReplacementCount = 0;
  let nextComposerInputNavigation:
    { remoteUrl: string; renderUnrelatedTranscript: boolean; urlEventDelayMs: number } | undefined;
  const submittedPrompts: string[] = [];
  const renderOtherConversation = () => {
    thread.innerHTML = `
      <article data-message-author-role="user">Other visible question</article>
      <article data-message-author-role="assistant"><p>Other visible answer</p></article>
      <button type="button" aria-label="Copy response">Copy</button>`;
  };
  const submit = () => {
    const submittedPrompt = composer.value.replaceAll("\u00a0", " ").replace(/\n$/u, "");
    submittedPrompts.push(submittedPrompt);
    submissionCount += 1;
    composer.value = "";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    if (submissionCount === 1) {
      thread.innerHTML = primaryConversationMarkup(
        terminalMode,
        reuseAssistantFollowUp !== "identity-unavailable",
        submittedPrompt,
      );
    } else if (reuseAssistantFollowUp === "network-only") {
      // React can retain the exact user and assistant subtree when a new
      // request produces text identical to the previous answer. The page
      // lifecycle bridge is the only new-run evidence in this fixture.
    } else if (reuseAssistantFollowUp) {
      const currentUser = requireElement<HTMLElement>('[data-message-author-role="user"]');
      if (reuseAssistantFollowUp === "in-place-user-text") {
        // ChatGPT's virtualized history can reuse the exact two visible turn
        // nodes for a follow-up whose answer is textually identical. Only the
        // current user text changes; the assistant subtree remains untouched.
        currentUser.textContent = submittedPrompt;
      } else {
        currentUser.setAttribute("data-message-id", "follow-up-user-message");
        currentUser.closest("article")?.setAttribute("data-turn-id", "follow-up-user-turn");
      }
      if (reuseAssistantFollowUp === "identity-changed") {
        const currentAssistant = requireElement<HTMLElement>(
          '[data-message-author-role="assistant"]',
        );
        const assistantTurn = currentAssistant.closest("article");
        assistantTurn?.setAttribute("data-testid", "conversation-turn-follow-up-assistant");
        assistantTurn?.setAttribute("data-turn-id", "follow-up-assistant-turn");
      }
    } else {
      const followUpMarkup = `<article data-testid="conversation-turn-follow-up-user">
           <div data-message-author-role="user">${escapeFixtureHtml(submittedPrompt)}</div>
         </article>
         <article data-testid="conversation-turn-follow-up">
           <div class="message-shell">
             <div data-message-author-role="assistant"><p>Follow-up answer on canonical B</p></div>
           </div>
           ${
             followUpStreaming
               ? '<button type="button" data-testid="stop-button" aria-label="Stop generating">Stop</button>'
               : noFollowUpActions
                 ? ""
                 : '<div class="message-actions"><button type="button" aria-label="Copy response">Copy</button></div>'
           }
         </article>`;
      const recycledFollowUpMarkup = `<article data-message-author-role="user">${escapeFixtureHtml(submittedPrompt)}</article>
         <article data-testid="conversation-turn-follow-up">
           <div class="message-shell">
             <div data-message-author-role="assistant"><p>Short answer completed on provisional A</p></div>
           </div>
           ${followUpBusy ? '<span data-streaming="true" style="display: none"></span>' : ""}
           ${
             followUpStreaming
               ? '<button type="button" data-testid="stop-button" aria-label="Stop generating">Stop</button>'
               : noFollowUpActions
                 ? ""
                 : '<div class="message-actions"><button type="button" aria-label="Copy response">Copy</button></div>'
           }
         </article>`;
      if (virtualizeFollowUp) thread.innerHTML = recycledFollowUpMarkup;
      else thread.insertAdjacentHTML("beforeend", followUpMarkup);
    }
    if (terminalMode === "stopped-empty") {
      requireElement<HTMLButtonElement>('[data-testid="stop-button"]').addEventListener(
        "click",
        (event) => {
          (event.currentTarget as HTMLButtonElement).outerHTML =
            '<button type="button" aria-label="Copy response">Copy</button>';
        },
      );
    }

    if (submissionCount === 1) {
      scheduleFixtureTimeout(
        () => harness.emitTabUrlUpdated(tabId, REMOTE_A),
        Math.max(0, provisionalUrlDelayMs - 40),
      );
      scheduleFixtureTimeout(() => {
        harness.setPrimaryDocumentUrl(REMOTE_A);
        harness.setTabUrl(tabId, REMOTE_A);
        harness.emitTabActivated(tabId);
      }, provisionalUrlDelayMs);
      if (autoCanonicalize) {
        scheduleFixtureTimeout(() => {
          harness.setPrimaryDocumentUrl(REMOTE_B);
          harness.setTabUrl(tabId, REMOTE_B);
          if (canonicalContentDelayMs > 0) thread.replaceChildren();
          harness.emitTabUrlUpdated(tabId, REMOTE_B);
          if (canonicalContentDelayMs > 0) {
            scheduleFixtureTimeout(() => {
              renderPrimaryConversation(thread, terminalMode);
              harness.emitTabLoadComplete(tabId);
            }, canonicalContentDelayMs);
          }
        }, canonicalUrlDelayMs);
      }
    }
  };
  const handleFormSubmit = (event: Event) => {
    formSubmitCount += 1;
    event.preventDefault();
    if (submissionMode === "form") submit();
  };
  const handleSendClick = (event: Event) => {
    const clicked = event.currentTarget as HTMLButtonElement;
    if (clicked.dataset.commitPending === "true") {
      staleSendClickCount += 1;
      return;
    }
    sendClickCount += 1;
    if (falseSubmissionSignals) {
      composer.value = "";
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      const replacement = composer.cloneNode() as HTMLTextAreaElement;
      replacement.value = "";
      composer.replaceWith(replacement);
      thread.insertAdjacentHTML(
        "beforeend",
        `<article data-testid="conversation-turn-unrelated-user">
           <div data-message-author-role="user">A different manual question.</div>
         </article>
         <article data-testid="conversation-turn-unrelated-assistant">
           <div data-message-author-role="assistant"><p>An unrelated old answer.</p></div>
         </article>`,
      );
      window.history.replaceState({}, "", REMOTE_A);
      harness.setPrimaryDocumentUrl(REMOTE_A);
      harness.setTabUrl(tabId, REMOTE_A);
      harness.emitTabUrlUpdated(tabId, REMOTE_A);
      return;
    }
    if (submissionMode === "form") return;
    if (submissionDelayMs > 0) scheduleFixtureTimeout(submit, submissionDelayMs);
    else submit();
  };
  const handleComposerInput = () => {
    if (submissionCount > 0 && composer.value.trim() && nextComposerInputNavigation) {
      const navigation = nextComposerInputNavigation;
      nextComposerInputNavigation = undefined;
      if (navigation.renderUnrelatedTranscript) renderOtherConversation();
      harness.setPrimaryDocumentUrl(navigation.remoteUrl);
      harness.setTabUrl(tabId, navigation.remoteUrl);
      if (navigation.urlEventDelayMs > 0) {
        scheduleFixtureTimeout(
          () => harness.emitTabUrlUpdated(tabId, navigation.remoteUrl),
          navigation.urlEventDelayMs,
        );
      } else {
        harness.emitTabUrlUpdated(tabId, navigation.remoteUrl);
      }
    }
    if ((virtualizeFollowUp || reuseAssistantFollowUp) && submissionCount > 0) {
      send.disabled = composer.value.trim() === "";
    }
    if (!removeEmptyFollowUpSendControl || submissionCount === 0) return;
    if (composer.value.trim() === "") {
      send.remove();
      return;
    }
    if (send.isConnected) return;
    send = document.createElement("button");
    send.type = "button";
    send.dataset.testid = "send-button";
    send.setAttribute("aria-label", "Send prompt");
    send.textContent = "Send";
    send.addEventListener("click", handleSendClick);
    form.append(send);
  };
  const bindComposerControls = () => {
    form.addEventListener("submit", handleFormSubmit);
    composer.addEventListener("input", handleComposerInput);
    send.addEventListener("click", handleSendClick);
  };
  bindComposerControls();

  return {
    sendClicks: () => sendClickCount,
    staleSendClicks: () => staleSendClickCount,
    formSubmits: () => formSubmitCount,
    composerReplacements: () => composerReplacementCount,
    submittedPrompts: () => [...submittedPrompts],
    addAriaHiddenComposerClone() {
      const hiddenShell = document.createElement("div");
      hiddenShell.setAttribute("aria-hidden", "true");
      hiddenShell.append(composer.cloneNode(true));
      document.body.append(hiddenShell);
    },
    showOnlyTransitionComposerOutsideForm() {
      const transitionComposer = composer.cloneNode(true) as HTMLTextAreaElement;
      transitionComposer.value = "stale draft";
      form.hidden = true;
      document.body.append(transitionComposer);
    },
    corruptComposerOnRunIntent() {
      document.addEventListener(
        "ask2gpt:run-intent",
        () => {
          composer.value = "tampered draft";
        },
        { capture: true, once: true },
      );
    },
    replaceComposerOnNextCommit(delayMs = 50) {
      const staleComposer = composer;
      staleComposer.addEventListener(
        "input",
        () => {
          scheduleFixtureTimeout(() => {
            const replacement = staleComposer.cloneNode() as HTMLTextAreaElement;
            replacement.value = "";
            staleComposer.replaceWith(replacement);
            composer = replacement;
            composerReplacementCount += 1;
          }, delayMs);
        },
        { once: true },
      );
    },
    replaceComposerWithFullPromptAfterEveryCommit(delayMs = 10) {
      const armReplacement = (target: HTMLTextAreaElement) => {
        target.addEventListener(
          "input",
          () => {
            const committedValue = target.value;
            if (!committedValue) return;
            scheduleFixtureTimeout(() => {
              if (!target.isConnected) return;
              const replacement = target.cloneNode() as HTMLTextAreaElement;
              replacement.value = committedValue;
              target.replaceWith(replacement);
              composer = replacement;
              composerReplacementCount += 1;
              armReplacement(replacement);
            }, delayMs);
          },
          { once: true },
        );
      };
      armReplacement(composer);
    },
    replaceComposerWithRenderedEquivalentPromptAfterEveryCommit(delayMs = 10) {
      const armReplacement = (target: HTMLTextAreaElement) => {
        target.addEventListener(
          "input",
          () => {
            const committedValue = target.value;
            if (!committedValue) return;
            scheduleFixtureTimeout(() => {
              if (!target.isConnected) return;
              const replacement = target.cloneNode() as HTMLTextAreaElement;
              replacement.value = committedValue.replaceAll(" ", "\u00a0");
              target.replaceWith(replacement);
              composer = replacement;
              composerReplacementCount += 1;
              armReplacement(replacement);
            }, delayMs);
          },
          { once: true },
        );
      };
      armReplacement(composer);
    },
    replaceComposerFormWithFullPromptOnNextCommit(delayMs = 10) {
      const staleComposer = composer;
      staleComposer.addEventListener(
        "input",
        () => {
          const committedValue = staleComposer.value;
          if (!committedValue) return;
          const staleForm = form;
          const staleSend = send;
          staleSend.dataset.commitPending = "true";
          scheduleFixtureTimeout(() => {
            if (!staleForm.isConnected) return;
            const replacement = staleForm.cloneNode(true) as HTMLFormElement;
            const replacementComposer =
              replacement.querySelector<HTMLTextAreaElement>("#prompt-textarea")!;
            const replacementSend = replacement.querySelector<HTMLButtonElement>(
              '[data-testid="send-button"]',
            )!;
            replacementComposer.value = committedValue;
            delete replacementSend.dataset.commitPending;
            staleForm.replaceWith(replacement);
            form = replacement;
            composer = replacementComposer;
            send = replacementSend;
            composerReplacementCount += 1;
            bindComposerControls();
          }, delayMs);
        },
        { once: true },
      );
    },
    replaceComposerWithCorruptedPromptAfterEveryCommit(delayMs = 10) {
      const armReplacement = (target: HTMLTextAreaElement) => {
        target.addEventListener(
          "input",
          () => {
            const committedValue = target.value;
            if (!committedValue) return;
            scheduleFixtureTimeout(() => {
              if (!target.isConnected) return;
              const replacement = target.cloneNode() as HTMLTextAreaElement;
              replacement.value = committedValue.slice(0, -1);
              target.replaceWith(replacement);
              composer = replacement;
              composerReplacementCount += 1;
              armReplacement(replacement);
            }, delayMs);
          },
          { once: true },
        );
      };
      armReplacement(composer);
    },
    deferNextControlledCommit(delayMs = 10) {
      composer.addEventListener(
        "input",
        () => {
          const staleSend = send;
          staleSend.dataset.commitPending = "true";
          scheduleFixtureTimeout(() => {
            const replacement = staleSend.cloneNode(true) as HTMLButtonElement;
            delete replacement.dataset.commitPending;
            replacement.addEventListener("click", handleSendClick);
            staleSend.replaceWith(replacement);
            send = replacement;
          }, delayMs);
        },
        { once: true },
      );
    },
    updatePrimaryAssistant(markdown: string) {
      const assistant = requireElement<HTMLElement>('[data-message-author-role="assistant"]');
      assistant.innerHTML = `<p>${markdown}</p>`;
    },
    navigateOnNextComposerInput(
      remoteUrl: string,
      {
        renderUnrelatedTranscript = false,
        urlEventDelayMs = 0,
      }: { renderUnrelatedTranscript?: boolean; urlEventDelayMs?: number } = {},
    ) {
      nextComposerInputNavigation = {
        remoteUrl,
        renderUnrelatedTranscript,
        urlEventDelayMs,
      };
    },
    renderOtherConversation() {
      renderOtherConversation();
    },
    finishVirtualizedFollowUp() {
      const busy = document.querySelector<HTMLElement>('[data-streaming="true"]');
      if (busy) busy.setAttribute("data-streaming", "false");
    },
    async flickerFollowUpStop(hiddenForMs = 180) {
      const stop = requireElement<HTMLButtonElement>('[data-testid="stop-button"]');
      const parent = stop.parentElement;
      if (!parent) throw new Error("Fixture Stop control has no parent.");
      stop.remove();
      await new Promise((resolve) => setTimeout(resolve, hiddenForMs));
      parent.append(stop);
    },
    finishFollowUpStreaming() {
      requireElement<HTMLButtonElement>('[data-testid="stop-button"]').outerHTML =
        '<button type="button" aria-label="Copy response">Copy</button>';
    },
  };
}

function renderPrimaryConversation(
  thread: HTMLElement,
  terminalMode: "complete" | "stopped-empty" | "streaming" | "progress" | "visible-error",
) {
  thread.innerHTML = primaryConversationMarkup(terminalMode);
}

function primaryConversationMarkup(
  terminalMode: "complete" | "stopped-empty" | "streaming" | "progress" | "visible-error",
  assistantIdentity = true,
  userPrompt = "Explain the relay race.",
) {
  return `
    <article data-testid="conversation-turn-primary-user" data-turn-id="primary-user-turn">
      <div data-message-author-role="user" data-message-id="primary-user-message">${escapeFixtureHtml(userPrompt)}</div>
    </article>
    ${
      terminalMode === "visible-error"
        ? `<div role="alert" data-testid="generation-error">
             <span>SENSITIVE_REMOTE_ERROR_TEXT</span>
             <button type="button" data-testid="retry-button">Try again</button>
           </div>`
        : `<article${
            assistantIdentity
              ? ' data-testid="conversation-turn-primary-assistant" data-turn-id="primary-assistant-turn"'
              : ""
          }>
             ${
               terminalMode === "stopped-empty"
                 ? ""
                 : `<div class="message-shell"><div data-message-author-role="assistant"${
                     assistantIdentity ? ' data-message-id="primary-assistant-message"' : ""
                   }><p>${
                     terminalMode === "streaming"
                       ? "Partial answer on provisional A"
                       : terminalMode === "progress"
                         ? "正在思考"
                         : "Short answer completed on provisional A"
                   }</p></div></div>`
             }
             ${
               terminalMode === "complete" || terminalMode === "progress"
                 ? '<button type="button" aria-label="Copy response">Copy</button>'
                 : '<button type="button" data-testid="stop-button" aria-label="Stop generating">Stop</button>'
             }
           </article>`
    }`;
}

function escapeFixtureHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function utf8Base64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256FixtureHex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function scheduleFixtureTimeout(callback: () => void, delayMs: number) {
  const timer = window.setTimeout(() => {
    fixtureTimeouts.delete(timer);
    callback();
  }, delayMs);
  fixtureTimeouts.add(timer);
  return timer;
}

function clearFixtureTimeouts() {
  for (const timer of fixtureTimeouts) window.clearTimeout(timer);
  fixtureTimeouts.clear();
}

async function installDirectMainWorldSendWorker(
  harness: FakeChromeRelayHarness,
  onMessage?: (message: unknown) => void,
) {
  await harness.importServiceWorker(async () => {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      onMessage?.(message);
      if (!isMessageType(message, "content.mainWorldSend.request")) {
        sendResponse({ ok: true });
        return false;
      }

      const runId = (message as { runId?: unknown }).runId;
      const scopes = [
        ...document.querySelectorAll<HTMLElement>("[data-ask2gpt-main-world-scope]"),
      ].filter((element) => element.getAttribute("data-ask2gpt-main-world-scope") === runId);
      const composers = [
        ...document.querySelectorAll<HTMLElement>("[data-ask2gpt-main-world-composer]"),
      ].filter((element) => element.getAttribute("data-ask2gpt-main-world-composer") === runId);
      const buttons = [
        ...document.querySelectorAll<HTMLButtonElement>("[data-ask2gpt-main-world-send]"),
      ].filter((element) => element.getAttribute("data-ask2gpt-main-world-send") === runId);
      const scope = scopes[0];
      const composer = composers[0];
      const button = buttons[0];
      const dispatched = Boolean(
        typeof runId === "string" &&
        sender.tab?.id !== undefined &&
        scopes.length === 1 &&
        composers.length === 1 &&
        buttons.length === 1 &&
        scope?.contains(composer!) &&
        scope.contains(button!) &&
        !button?.disabled,
      );
      if (dispatched) button!.click();
      sendResponse({ ok: dispatched, dispatched });
      return false;
    });
  });
}

function isMessageType(message: unknown, type: string) {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    (message as { type?: unknown }).type === type
  );
}

function requireElement<ElementType extends Element>(selector: string) {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing fixture element: ${selector}`);
  return element;
}

function makeElementsVisibleToTheContentScript() {
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? "";
    },
    set(this: HTMLElement, value: string) {
      this.textContent = value;
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        x: 0,
        y: 0,
        width: 320,
        height: 40,
        top: 0,
        right: 320,
        bottom: 40,
        left: 0,
        toJSON: () => ({}),
      }) satisfies DOMRect,
  );
}
