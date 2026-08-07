// @vitest-environment jsdom

import { makeEnvelope } from "@ask2gpt/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FakeChromeRelayHarness,
  FakeRelayWebSocket,
  waitUntil,
} from "./test-support/fake-chrome-relay";

const INSTANCE_ID = "version-mismatch-window";
const PORT = 32_171;

describe("relay version mismatch diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("consumes a post-hello version error without touching ChatGPT or resetting backoff", async () => {
    vi.resetModules();
    const harness = new FakeChromeRelayHarness();
    harness.installGlobals();
    await harness.importServiceWorker(async () => await import("./service-worker"));

    const firstSocket = await harness.waitForSocket(PORT);
    await completeRelayHello(harness, firstSocket);
    firstSocket.deliverFromHost(versionMismatchEnvelope("0.1.11"));

    await waitUntil(() => firstSocket.readyState === FakeRelayWebSocket.CLOSED);
    expect(firstSocket.closeCode).toBe(1002);
    expect(firstSocket.closeReason).toBe("Protocol mismatch");

    const firstSocketCount = harness.socketsForPort(PORT).length;
    await waitUntil(() => harness.socketsForPort(PORT).length > firstSocketCount, 900);
    const secondSocket = harness.socketsForPort(PORT).at(-1)!;
    await completeRelayHello(harness, secondSocket);
    secondSocket.deliverFromHost(versionMismatchEnvelope("0.1.11"));
    await waitUntil(() => secondSocket.readyState === FakeRelayWebSocket.CLOSED);

    const secondSocketCount = harness.socketsForPort(PORT).length;
    await delay(700);
    expect(harness.socketsForPort(PORT)).toHaveLength(secondSocketCount);
    await waitUntil(() => harness.socketsForPort(PORT).length > secondSocketCount, 700);

    const mismatchStatus = (await harness.sendPopupMessage({ type: "popup.status" })) as {
      lastError?: string;
    };
    expect(mismatchStatus.lastError).toContain("PROTOCOL_MISMATCH");
    expect(mismatchStatus.lastError).toContain("0.1.11");
    expect(mismatchStatus.lastError).toContain("重新加载 Relay");
    expect(harness.tabsById.size).toBe(0);
    expect(harness.runtimeReloadCalls).toBe(0);

    const thirdSocket = harness.socketsForPort(PORT).at(-1)!;
    thirdSocket.open();
    thirdSocket.close(1008, "Update Ask2GPT Relay");
    const closeStatus = (await harness.sendPopupMessage({ type: "popup.status" })) as {
      lastError?: string;
    };
    expect(closeStatus.lastError).toContain("PROTOCOL_MISMATCH");
    expect(closeStatus.lastError).toContain("Chrome 工具栏");
    expect(harness.tabsById.size).toBe(0);
    expect(harness.runtimeReloadCalls).toBe(0);
  }, 6_000);
});

async function completeRelayHello(harness: FakeChromeRelayHarness, socket: FakeRelayWebSocket) {
  socket.open();
  socket.deliverFromHost(
    makeEnvelope({
      type: "relay.ready",
      instanceId: INSTANCE_ID,
      payload: { serverLabel: "Version Test", serverInstanceId: INSTANCE_ID },
    }),
  );
  await harness.waitForEnvelope(socket, (envelope) => envelope.type === "relay.hello");
}

function versionMismatchEnvelope(detectedVersion: string) {
  return makeEnvelope({
    type: "relay.error",
    instanceId: INSTANCE_ID,
    payload: {
      code: "PROTOCOL_MISMATCH",
      message: `VS Code extension requires Relay 0.0.1; detected ${detectedVersion}.`,
      recoverable: false,
    },
  });
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
