// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://chatgpt.com/g/ask2gpt/project"}

import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeChromeRelayHarness } from "./test-support/fake-chrome-relay";

describe("Fake Chrome tab-message lifecycle", () => {
  afterEach(() => {
    FakeChromeRelayHarness.suspendActive();
    vi.unstubAllGlobals();
  });

  it("preserves immediate tabs.sendMessage responses by default", async () => {
    const { harness, tabId } = await createHarness();

    await expect(
      chrome.tabs.sendMessage(tabId, { type: "content.inspectConversation" }),
    ).resolves.toEqual({ ok: true });
    expect(harness.timeline).toContain(
      `tabs.sendMessage:response:${tabId}:content.inspectConversation`,
    );
    expect(harness.timeline.some((entry) => entry.includes("tabs.sendMessage:suspended"))).toBe(
      false,
    );
  });

  it.each(["hidden", "frozen", "discarded"] as const)(
    "holds a selected response while the tab is %s and resumes it after restoration",
    async (lifecycle) => {
      const { harness, tabId } = await createHarness();
      const message = { type: `content.lifecycle.${lifecycle}` };
      const barrier = harness.pauseNextTabMessageResponseWhile(
        tabId,
        lifecycle,
        (candidate) =>
          typeof candidate === "object" &&
          candidate !== null &&
          "type" in candidate &&
          candidate.type === message.type,
      );
      setLifecycle(harness, tabId, lifecycle, true);

      let settled = false;
      const response = chrome.tabs.sendMessage(tabId, message).then((value) => {
        settled = true;
        return value;
      });
      await barrier.entered;
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(harness.timeline).toContain(
        `tabs.sendMessage:suspended:${tabId}:${message.type}:${lifecycle}`,
      );
      expect(harness.timeline).not.toContain(`tabs.sendMessage:response:${tabId}:${message.type}`);

      setLifecycle(harness, tabId, lifecycle, false);

      await expect(response).resolves.toEqual({ ok: true });
      expect(harness.timeline).toContain(
        `tabs.sendMessage:resumed:${tabId}:${message.type}:${lifecycle}`,
      );
      expect(harness.timeline).toContain(`tabs.sendMessage:response:${tabId}:${message.type}`);
    },
  );

  it("only suspends the selected message type", async () => {
    const { harness, tabId } = await createHarness();
    harness.setTabFrozen(tabId, true);
    const barrier = harness.pauseNextTabMessageResponseWhile(
      tabId,
      "frozen",
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "content.recover",
    );

    await expect(chrome.tabs.sendMessage(tabId, { type: "content.ping" })).resolves.toEqual({
      ok: true,
    });
    const recovery = chrome.tabs.sendMessage(tabId, { type: "content.recover" });
    await barrier.entered;
    harness.setTabFrozen(tabId, false);

    await expect(recovery).resolves.toEqual({ ok: true });
  });

  it("tracks normal and minimized fake window state through get and update", async () => {
    const { harness, windowId } = await createHarness();

    await expect(chrome.windows.get(windowId)).resolves.toMatchObject({ state: "normal" });

    harness.setWindowState(windowId, "minimized");
    await expect(chrome.windows.get(windowId)).resolves.toMatchObject({ state: "minimized" });
    expect(harness.timeline).toContain(`window-state:${windowId}:state:minimized`);

    await expect(chrome.windows.update(windowId, { state: "normal" })).resolves.toMatchObject({
      state: "normal",
    });
    await expect(chrome.windows.update(windowId, { state: "minimized" })).resolves.toMatchObject({
      state: "minimized",
    });
    await expect(chrome.windows.get(windowId)).resolves.toMatchObject({ state: "minimized" });
    expect(harness.timeline).toContain(`window-updated:${windowId}:state:normal`);
    expect(harness.timeline).toContain(`window-updated:${windowId}:state:minimized`);
  });

  it("matches Chrome's refusal to move a tab into a popup window", async () => {
    const { tabId, windowId } = await createHarness();

    await expect(chrome.windows.create({ focused: false, tabId, type: "popup" })).rejects.toThrow(
      "Tabs can only be moved to and from normal windows.",
    );
    await expect(chrome.tabs.get(tabId)).resolves.toMatchObject({ windowId });
  });
});

async function createHarness() {
  const harness = new FakeChromeRelayHarness();
  harness.installGlobals();
  const tab = await chrome.tabs.create({
    active: true,
    url: "https://chatgpt.com/g/ask2gpt/c/fake-lifecycle",
  });
  if (tab.id === undefined) throw new Error("Fake Chrome did not assign a tab id.");
  harness.installTabMessageResponder(tab.id, () => ({ ok: true }));
  return { harness, tabId: tab.id, windowId: tab.windowId };
}

function setLifecycle(
  harness: FakeChromeRelayHarness,
  tabId: number,
  lifecycle: "hidden" | "frozen" | "discarded",
  value: boolean,
) {
  if (lifecycle === "hidden") harness.setTabHidden(tabId, value);
  if (lifecycle === "frozen") harness.setTabFrozen(tabId, value);
  if (lifecycle === "discarded") harness.setTabDiscarded(tabId, value);
}
