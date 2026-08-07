// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeStatus {
  connected: boolean;
  scanning?: boolean;
  lastError?: string;
  project?: { bound: false } | { bound: true; name: string; projectUrl?: string };
  projectSetup?:
    | { phase: "idle" }
    | { phase: "working"; startedAt: string }
    | {
        phase: "error";
        reason: "LOGIN_REQUIRED" | "PROJECT_NOT_FOUND" | "PROJECT_AMBIGUOUS" | "PAGE_UNAVAILABLE";
      };
  backgroundReception?: {
    enhancedEnabled: boolean;
    permissionGranted: boolean;
  };
  servers: Array<{
    port: number;
    instanceId: string;
    authenticated: boolean;
    label: string;
    transportState: string;
  }>;
}

const popupHtmlPath = resolve(process.cwd(), "popup.html");

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  document.open();
  document.write(await readFile(popupHtmlPath, "utf8"));
  document.close();
});

afterEach(() => {
  window.dispatchEvent(new Event("unload"));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Chrome popup automatic multi-window feedback", () => {
  it("enables enhanced background reception without requesting an impossible optional permission", async () => {
    const status: FakeStatus = {
      connected: true,
      backgroundReception: { enhancedEnabled: false, permissionGranted: true },
      servers: [server(32_171, "工作区 A", true, "authenticated")],
    };
    const sendMessage = installChromeMock(async (message) => {
      if (message.type === "popup.status") return status;
      if (message.type === "popup.setEnhancedBackground") {
        return { ok: true, enabled: true, permissionGranted: true };
      }
      return { ok: true };
    });

    await import("./popup");
    await flushPromises();
    const toggle = document.querySelector<HTMLInputElement>("#enhanced-background-toggle")!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await flushPromises();

    expect(sendMessage).toHaveBeenCalledWith({
      type: "popup.setEnhancedBackground",
      enabled: true,
    });
    expect(document.querySelector("#background-reception-badge")?.textContent).toBe("已增强");
    expect(document.querySelector("#background-reception-detail")?.textContent).toContain(
      "完成后会立即断开",
    );
  });

  it("shows only contextual actions for a partial connection without a Project", async () => {
    const status: FakeStatus = {
      connected: true,
      project: { bound: false },
      servers: [
        server(32_171, "工作区 A", true, "authenticated"),
        server(32_172, "工作区 B", false, "open"),
      ],
    };
    installChromeMock(async (message) => (message.type === "popup.status" ? status : { ok: true }));

    await import("./popup");
    await flushPromises();

    expect(document.querySelector("#status-title")?.textContent).toBe("1 个窗口已就绪");
    expect(document.querySelector("#status-detail")?.textContent).toContain("可先在已就绪窗口提问");
    expect(document.querySelector<HTMLElement>("#guidance")?.hidden).toBe(true);
    expect(document.querySelector("#window-list")?.textContent).toContain("工作区 A");
    expect(document.querySelector("#window-list")?.textContent).toContain("工作区 B");
    expect(document.querySelector("#window-list")?.textContent).toContain("自动握手中");
    expect(document.querySelector("#window-list")?.textContent).toContain("127.0.0.1:32171");
    expect(document.querySelector("#server-list")).toBeNull();
    expect(document.querySelector("#pair-form")).toBeNull();
    expect(document.querySelector("#project-title")?.textContent).toBe("选择会话保存位置");
    expect(document.querySelector<HTMLButtonElement>("#bind-project")?.hidden).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#rescan")?.hidden).toBe(false);
    expect(document.querySelector("#rescan")?.textContent).toBe("重试待连接窗口");
    expect(visibleButtonLabels()).toEqual([
      expect.stringContaining("选择已有 Project"),
      expect.stringContaining("新建专用 Project"),
      "打开 ChatGPT",
      "重试待连接窗口",
    ]);
    expect(document.querySelector("#relay-recovery")?.getAttribute("data-recommended")).toBe(
      "false",
    );
    expect(document.querySelector<HTMLElement>("#relay-recovery")?.hidden).toBe(true);
  });

  it("automatically creates and binds the default Ask2GPT Project", async () => {
    let status: FakeStatus = {
      connected: true,
      project: { bound: false },
      servers: [server(32_171, "工作区 A", true, "authenticated")],
    };
    const sendMessage = installChromeMock(async (message) => {
      if (message.type === "popup.status") return status;
      if (message.type === "popup.openChatGpt") {
        status = {
          ...status,
          project: {
            bound: true,
            name: "Ask2GPT",
            projectUrl: "https://chatgpt.com/g/ask2gpt/project",
          },
        };
        return {
          ok: true,
          created: true,
          project: {
            bound: true,
            name: "Ask2GPT",
            projectUrl: "https://chatgpt.com/g/ask2gpt/project",
          },
        };
      }
      return { ok: true };
    });

    await import("./popup");
    await flushPromises();
    document.querySelector<HTMLButtonElement>("#create-project")!.click();
    await flushPromises();

    expect(sendMessage).toHaveBeenCalledWith({ type: "popup.openChatGpt", mode: "create" });
    expect(document.querySelector("#project-title")?.textContent).toBe("Ask2GPT");
    expect(document.querySelector("#project-badge")?.textContent).toBe("已关联");
    expect(document.querySelector("#guidance-title")?.textContent).toBe("已创建并关联 Ask2GPT");
    expect(document.querySelector("#guidance-detail")?.textContent).toContain("自动保存");
  });

  it("lets the user choose an existing Project and renders the shared result", async () => {
    let status: FakeStatus = {
      connected: true,
      project: { bound: false },
      servers: [server(32_171, "工作区 A", true, "authenticated")],
    };
    const sendMessage = installChromeMock(async (message) => {
      if (message.type === "popup.status") return status;
      if (message.type === "popup.listProjects") {
        return {
          ok: true,
          projects: [
            {
              name: "团队研发",
              projectUrl: "https://chatgpt.com/g/team/project",
              scope: "https://chatgpt.com/g/team/",
            },
          ],
        };
      }
      if (message.type === "popup.bindProject") {
        status = {
          ...status,
          project: {
            bound: true,
            name: "团队研发",
            projectUrl: "https://chatgpt.com/g/team/project",
          },
        };
        return { ok: true };
      }
      return { ok: true };
    });

    await import("./popup");
    await flushPromises();
    document.querySelector<HTMLButtonElement>("#discover-projects")!.click();
    await flushPromises();
    document.querySelector<HTMLButtonElement>(".project-candidate")!.click();
    document.querySelector<HTMLButtonElement>("#bind-project")!.click();
    await flushPromises();

    expect(sendMessage).toHaveBeenCalledWith({ type: "popup.listProjects" });
    expect(sendMessage).toHaveBeenCalledWith({
      type: "popup.bindProject",
      projectUrl: "https://chatgpt.com/g/team/project",
    });
    expect(document.querySelector("#project-title")?.textContent).toBe("团队研发");
    expect(document.querySelector("#project-detail")?.textContent).toBe(
      "之后的新会话会保存到这里。需要时可以更换。",
    );
    expect(document.querySelector("#bind-project")?.textContent).toBe("更换 Project");
    expect(document.querySelector("#bind-project")?.parentElement?.id).toBe("project-action-slot");
    expect(document.querySelector<HTMLElement>("#project-action-slot")?.children).toHaveLength(1);
    expect(document.querySelector<HTMLButtonElement>("#rescan")?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#guidance")?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#relay-recovery")?.hidden).toBe(true);
    expect(document.querySelector<HTMLDetailsElement>("#advanced")?.open).toBe(false);
    expect(visibleButtonLabels()).toEqual(["更换 Project"]);
  });

  it("keeps a bounded Project bind pending beyond the worker's old five-second popup deadline", async () => {
    let status: FakeStatus = {
      connected: true,
      project: { bound: false },
      servers: [server(32_171, "工作区 A", true, "authenticated")],
    };
    const sendMessage = installChromeMock(async (message) => {
      if (message.type === "popup.status") return status;
      if (message.type === "popup.listProjects") {
        return {
          ok: true,
          projects: [
            {
              name: "团队研发",
              projectUrl: "https://chatgpt.com/g/team/project",
              scope: "https://chatgpt.com/g/team/",
            },
          ],
        };
      }
      if (message.type === "popup.bindProject") {
        return await new Promise<{ ok: true }>((resolve) => {
          window.setTimeout(() => {
            status = {
              ...status,
              project: {
                bound: true,
                name: "团队研发",
                projectUrl: "https://chatgpt.com/g/team/project",
              },
            };
            resolve({ ok: true });
          }, 7_000);
        });
      }
      return { ok: true };
    });

    await import("./popup");
    await flushPromises();
    document.querySelector<HTMLButtonElement>("#discover-projects")!.click();
    await flushPromises();
    document.querySelector<HTMLButtonElement>(".project-candidate")!.click();
    const bindButton = document.querySelector<HTMLButtonElement>("#bind-project")!;
    bindButton.click();
    await flushPromises();

    expect(document.querySelector("#project-section")?.getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector("#project-title")?.textContent).toBe("正在确认 Project");
    expect(document.querySelector("#project-detail")?.textContent).toContain("ChatGPT 页面");
    expect(bindButton.textContent).toBe("正在关联…");
    expect(bindButton.disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(5_100);
    await flushPromises();

    expect(sendMessage).toHaveBeenCalledWith({
      type: "popup.bindProject",
      projectUrl: "https://chatgpt.com/g/team/project",
    });
    expect(bindButton.disabled).toBe(true);
    expect(document.querySelector<HTMLElement>("#guidance")?.hidden).toBe(true);

    await vi.advanceTimersByTimeAsync(1_900);
    await flushPromises();
    expect(document.querySelector("#project-title")?.textContent).toBe("团队研发");
    expect(bindButton.disabled).toBe(false);
    expect(bindButton.parentElement?.id).toBe("project-action-slot");
  });

  it("keeps a safe Project binding failure visible across status polling", async () => {
    const status: FakeStatus = {
      connected: true,
      project: { bound: false },
      servers: [server(32_171, "工作区 A", true, "authenticated")],
    };
    const sendMessage = installChromeMock(async (message) => {
      if (message.type === "popup.status") return status;
      if (message.type === "popup.listProjects") {
        return {
          ok: true,
          projects: [
            {
              name: "团队研发",
              projectUrl: "https://chatgpt.com/g/team/project",
              scope: "https://chatgpt.com/g/team/",
            },
          ],
        };
      }
      if (message.type === "popup.bindProject") {
        return {
          ok: false,
          error: "Secret Project /g/private-scope/project could not be verified",
        };
      }
      return { ok: true };
    });

    await import("./popup");
    await flushPromises();
    document.querySelector<HTMLButtonElement>("#discover-projects")!.click();
    await flushPromises();
    document.querySelector<HTMLButtonElement>(".project-candidate")!.click();
    const bindButton = document.querySelector<HTMLButtonElement>("#bind-project")!;
    bindButton.click();
    await flushPromises();

    expect(document.querySelector("#project-section")?.getAttribute("aria-busy")).toBe("false");
    expect(document.querySelector("#project-title")?.textContent).toBe("还没有关联 Project");
    expect(document.querySelector("#project-detail")?.textContent).toContain("目标 Project");
    expect(bindButton.textContent).toBe("关联所选 Project");
    expect(document.body.textContent).not.toContain("Secret Project");
    expect(document.body.textContent).not.toContain("private-scope");

    await vi.advanceTimersByTimeAsync(2_600);
    await flushPromises();

    expect(
      sendMessage.mock.calls.filter(([message]) => message.type === "popup.bindProject"),
    ).toHaveLength(1);
    expect(document.querySelector("#project-title")?.textContent).toBe("还没有关联 Project");
    expect(document.querySelector<HTMLElement>("#guidance")?.hidden).toBe(false);
    expect(bindButton.textContent).toBe("关联所选 Project");
    expect(document.body.textContent).not.toContain("Secret Project");
    expect(document.body.textContent).not.toContain("private-scope");
  });

  it("restores an in-progress Project binding from the Relay status", async () => {
    const status: FakeStatus = {
      connected: true,
      project: { bound: false },
      projectSetup: { phase: "working", startedAt: "2026-07-28T15:00:00.000Z" },
      servers: [server(32_171, "工作区 A", true, "authenticated")],
    };
    installChromeMock(async (message) => (message.type === "popup.status" ? status : { ok: true }));

    await import("./popup");
    await flushPromises();

    expect(document.querySelector("#project-section")?.getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector("#project-title")?.textContent).toBe("正在确认 Project");
    expect(document.querySelector<HTMLButtonElement>("#bind-project")?.disabled).toBe(true);
  });

  it("restores a safe Project binding failure from the Relay status", async () => {
    const status: FakeStatus = {
      connected: true,
      project: { bound: false },
      projectSetup: { phase: "error", reason: "PROJECT_NOT_FOUND" },
      servers: [server(32_171, "工作区 A", true, "authenticated")],
    };
    installChromeMock(async (message) => (message.type === "popup.status" ? status : { ok: true }));

    await import("./popup");
    await flushPromises();

    expect(document.querySelector("#project-section")?.getAttribute("aria-busy")).toBe("false");
    expect(document.querySelector("#project-title")?.textContent).toBe("还没有关联 Project");
    expect(document.querySelector("#project-detail")?.textContent).toBe(
      "没有找到可选择的 Project。请先打开 ChatGPT 中的目标 Project。",
    );
    expect(document.querySelector<HTMLElement>("#guidance")?.hidden).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#bind-project")?.hidden).toBe(true);
  });

  it("distinguishes an active scan from a completed scan with no windows", async () => {
    const status: FakeStatus = { connected: false, scanning: true, servers: [] };
    installChromeMock(async (message) => (message.type === "popup.status" ? status : { ok: true }));

    await import("./popup");
    await flushPromises();

    expect(document.querySelector("#status-title")?.textContent).toBe("正在查找 VS Code");
    expect(document.querySelector("#status-detail")?.textContent).toContain("通常几秒内完成");
    expect(document.querySelector<HTMLElement>("#guidance")?.hidden).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#rescan")?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#project-section")?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#relay-recovery")?.hidden).toBe(true);
    expect(visibleButtonLabels()).toEqual([]);
  });

  it("gives a concrete recovery command when no VS Code window responds", async () => {
    const status: FakeStatus = {
      connected: false,
      scanning: false,
      lastError: "No relay listener responded.",
      servers: [],
    };
    installChromeMock(async (message) => (message.type === "popup.status" ? status : { ok: true }));

    await import("./popup");
    await flushPromises();

    expect(document.querySelector("#status-title")?.textContent).toBe("还没连上 VS Code");
    expect(document.querySelector("#guidance-title")?.textContent).toBe("下一步");
    expect(document.querySelector("#guidance-detail")?.textContent).toContain("Ctrl+Shift+P");
    expect(document.querySelector("#last-error")?.textContent).toContain(
      "No relay listener responded.",
    );
    expect(document.querySelector("#relay-recovery")?.getAttribute("data-recommended")).toBe(
      "false",
    );
    expect(document.querySelector<HTMLElement>("#relay-recovery")?.hidden).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#rescan")?.hidden).toBe(false);
    expect(document.querySelector("#rescan")?.textContent).toBe("重新检测");
    expect(document.querySelector("#reload-relay")?.parentElement?.id).toBe("recovery-action-slot");
    expect(visibleButtonLabels()).toEqual(["重新检测"]);
  });

  it("rescans immediately and refreshes the discovered window list", async () => {
    let status: FakeStatus = { connected: false, scanning: false, servers: [] };
    const sendMessage = installChromeMock(async (message) => {
      if (message.type === "popup.status") return status;
      if (message.type === "popup.rescan") {
        status = {
          connected: true,
          scanning: false,
          servers: [server(32_173, "新窗口", true, "authenticated")],
        };
        return { ok: true };
      }
      return { ok: true };
    });

    await import("./popup");
    await flushPromises();
    document.querySelector<HTMLButtonElement>("#rescan")!.click();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();

    expect(sendMessage).toHaveBeenCalledWith({ type: "popup.rescan" });
    expect(document.querySelector("#status-title")?.textContent).toBe("已就绪，可以提问");
    expect(document.querySelector("#status-detail")?.textContent).toContain("新窗口");
    expect(document.querySelector("#window-list")?.textContent).toContain("新窗口");
    expect(document.querySelector<HTMLButtonElement>("#rescan")?.hidden).toBe(true);
  });

  it("shows only the Relay restart action when the worker does not respond", async () => {
    installChromeMock(async () => {
      throw new Error("worker unavailable");
    });

    await import("./popup");
    await flushPromises();

    expect(document.querySelector("#status-title")?.textContent).toBe("Relay 未响应");
    expect(document.querySelector<HTMLElement>("#project-section")?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#guidance")?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#primary-actions")?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#relay-recovery")?.hidden).toBe(false);
    expect(document.querySelector("#relay-recovery")?.getAttribute("data-recommended")).toBe(
      "true",
    );
    expect(document.querySelector("#reload-relay")?.parentElement?.id).toBe("recovery-action-slot");
    expect(document.querySelector("#status-detail")?.textContent).toContain("不会重复发送");
    expect(visibleButtonLabels()).toEqual(["重启 Relay"]);
  });

  it("falls back to popup-owned reload for an older worker without duplicating clicks", async () => {
    const reload = vi.fn();
    let finishCheckpoint: (() => void) | undefined;
    const checkpoint = new Promise<{ ok: true }>((resolve) => {
      finishCheckpoint = () => resolve({ ok: true });
    });
    const sendMessage = installChromeMock(async (message) => {
      if (message.type === "popup.status") throw new Error("worker unavailable");
      if (message.type === "popup.prepareReload") return await checkpoint;
      return { ok: true };
    }, reload);

    await import("./popup");
    await flushPromises();

    const recovery = document.querySelector("#relay-recovery")!;
    const reloadButton = document.querySelector<HTMLButtonElement>("#reload-relay")!;
    expect((recovery as HTMLElement).hidden).toBe(false);
    expect(reloadButton.parentElement?.id).toBe("recovery-action-slot");

    reloadButton.click();
    reloadButton.click();

    expect(
      sendMessage.mock.calls.filter(([message]) => message.type === "popup.prepareReload"),
    ).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
    expect(reloadButton.disabled).toBe(true);
    expect(document.querySelector("#guidance-title")?.textContent).toBe("正在重启 Relay");

    finishCheckpoint?.();
    await flushPromises();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not double reload when the current worker already scheduled it", async () => {
    const reload = vi.fn();
    const sendMessage = installChromeMock(async (message) => {
      if (message.type === "popup.status") throw new Error("worker unavailable");
      if (message.type === "popup.prepareReload") {
        return { ok: true, reloadScheduled: true };
      }
      return { ok: true };
    }, reload);

    await import("./popup");
    await flushPromises();
    document.querySelector<HTMLButtonElement>("#reload-relay")!.click();
    await flushPromises();

    expect(
      sendMessage.mock.calls.filter(([message]) => message.type === "popup.prepareReload"),
    ).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload or duplicate requests when the checkpoint cannot be saved", async () => {
    const reload = vi.fn();
    const sendMessage = installChromeMock(async (message) => {
      if (message.type === "popup.status") throw new Error("worker unavailable");
      if (message.type === "popup.prepareReload") {
        return { ok: false, error: "checkpoint unavailable" };
      }
      return { ok: true };
    }, reload);

    await import("./popup");
    await flushPromises();
    const reloadButton = document.querySelector<HTMLButtonElement>("#reload-relay")!;
    reloadButton.click();
    reloadButton.click();
    await flushPromises();

    expect(
      sendMessage.mock.calls.filter(([message]) => message.type === "popup.prepareReload"),
    ).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
    expect(reloadButton.disabled).toBe(false);
    expect(document.querySelector("#guidance-title")?.textContent).toBe("Relay 重启失败");
  });
});

function server(port: number, label: string, authenticated: boolean, transportState: string) {
  return {
    port,
    instanceId: `instance-${port}`,
    authenticated,
    label,
    transportState,
  };
}

function installChromeMock(
  responder: (message: Record<string, unknown>) => Promise<unknown>,
  reload = vi.fn(),
) {
  const sendMessage = vi.fn(responder);
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { runtime: { reload, sendMessage } },
  });
  return sendMessage;
}

function visibleButtonLabels() {
  return [...document.querySelectorAll<HTMLButtonElement>("button")]
    .filter((button) => {
      if (button.hidden || button.closest("[hidden]")) return false;
      const details = button.closest("details");
      return !(details instanceof HTMLDetailsElement) || details.open;
    })
    .map((button) => button.textContent?.trim() ?? "");
}

async function flushPromises() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}
