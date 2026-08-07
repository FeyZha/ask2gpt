/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BRIDGE_STATE_KEY = Symbol.for("ask2gpt.pageModelBridge");
const RUN_INTENT_ATTRIBUTE = "data-ask2gpt-run-intent";
const RUN_READY_ATTRIBUTE = "data-ask2gpt-run-ready";
const RUN_INTENT_EVENT = "ask2gpt:run-intent";
const RUN_LIFECYCLE_ATTRIBUTE = "data-ask2gpt-run-lifecycle";
const RUN_LIFECYCLE_EVENT = "ask2gpt:run-lifecycle";
const RUN_RESPONSE_ATTRIBUTE = "data-ask2gpt-run-response";
const RUN_RESPONSE_EVENT = "ask2gpt:run-response";
const PROJECT_DIRECTORY_REFRESH_REQUEST_ATTRIBUTE =
  "data-ask2gpt-project-directory-refresh-request";
const PROJECT_DIRECTORY_REFRESH_RESULT_ATTRIBUTE = "data-ask2gpt-project-directory-refresh-result";
const PROJECT_DIRECTORY_REFRESH_REQUEST_EVENT = "ask2gpt:project-directory-refresh-request";
const PROJECT_DIRECTORY_REFRESH_RESULT_EVENT = "ask2gpt:project-directory-refresh-result";

type RunLifecycle = {
  runId: string;
  phase: "submitted" | "response-started" | "response-complete" | "response-error";
  failureKind?: "http" | "network" | "stream";
  httpStatus?: number;
};

describe("page model bridge", () => {
  beforeEach(() => {
    disposeBridge();
    vi.resetModules();
    for (const attribute of [
      "data-ask2gpt-project-binding",
      "data-ask2gpt-model-intent",
      "data-ask2gpt-model-ready",
      RUN_INTENT_ATTRIBUTE,
      RUN_READY_ATTRIBUTE,
      RUN_LIFECYCLE_ATTRIBUTE,
      RUN_RESPONSE_ATTRIBUTE,
      PROJECT_DIRECTORY_REFRESH_REQUEST_ATTRIBUTE,
      PROJECT_DIRECTORY_REFRESH_RESULT_ATTRIBUTE,
    ]) {
      document.documentElement.removeAttribute(attribute);
    }
  });

  afterEach(disposeBridge);

  it("applies one accepted model intent to the next ChatGPT conversation request", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}"),
    );
    window.fetch = fetchMock as typeof window.fetch;
    await import("./page-model-bridge");

    const intent = JSON.stringify({ modelId: "gpt-5-6-thinking", reasoningEffort: "max" });
    document.documentElement.setAttribute("data-ask2gpt-model-intent", intent);
    document.dispatchEvent(new Event("ask2gpt:model-intent"));
    expect(document.documentElement.getAttribute("data-ask2gpt-model-ready")).toBe(intent);

    await window.fetch(`${location.origin}/backend-api/conversation`, {
      method: "POST",
      body: JSON.stringify({ model: "auto", action: "next" }),
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({
      model: "gpt-5-6-thinking",
      thinking_effort: "max",
      action: "next",
    });

    await window.fetch(`${location.origin}/backend-api/conversation`, {
      method: "POST",
      body: JSON.stringify({ model: "auto", action: "next" }),
    });
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toMatchObject({
      model: "auto",
    });
  });

  it("rejects an unsafe model intent", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}"),
    );
    window.fetch = fetchMock as typeof window.fetch;
    await import("./page-model-bridge");
    document.documentElement.removeAttribute("data-ask2gpt-model-ready");

    document.documentElement.setAttribute("data-ask2gpt-model-intent", "../../unsafe");
    document.dispatchEvent(new Event("ask2gpt:model-intent"));
    expect(document.documentElement.hasAttribute("data-ask2gpt-model-ready")).toBe(false);
  });

  it("publishes a content-free lifecycle around exactly one conversation response", async () => {
    const timeline: string[] = [];
    let closeBody: (() => void) | undefined;
    let fetchCount = 0;
    const fetchMock = vi.fn(async () => {
      timeline.push("fetch");
      fetchCount += 1;
      if (fetchCount !== 1) return new Response("{}");
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            closeBody = () => controller.close();
          },
        }),
      );
    });
    window.fetch = fetchMock as typeof window.fetch;
    await import("./page-model-bridge");
    const capture = captureRunLifecycle(timeline);

    try {
      publishRunIntent("run-lifecycle-1");
      expect(document.documentElement.hasAttribute(RUN_INTENT_ATTRIBUTE)).toBe(false);
      expect(document.documentElement.getAttribute(RUN_READY_ATTRIBUTE)).toBe(
        JSON.stringify({ runId: "run-lifecycle-1" }),
      );

      const response = await window.fetch(`${location.origin}/backend-api/conversation`, {
        method: "POST",
        body: JSON.stringify({ action: "next" }),
      });
      expect(response).toBeInstanceOf(Response);
      expect(timeline.slice(0, 3)).toEqual(["submitted", "fetch", "response-started"]);
      expect(capture.events).toEqual([
        { runId: "run-lifecycle-1", phase: "submitted" },
        { runId: "run-lifecycle-1", phase: "response-started" },
      ]);
      expect(document.documentElement.hasAttribute(RUN_LIFECYCLE_ATTRIBUTE)).toBe(false);

      closeBody?.();
      await vi.waitFor(() =>
        expect(capture.events).toContainEqual({
          runId: "run-lifecycle-1",
          phase: "response-complete",
        }),
      );
      expect(capture.events.every((event) => Object.keys(event).length === 2)).toBe(true);

      const lifecycleCount = capture.events.length;
      await window.fetch(`${location.origin}/backend-api/conversation`, {
        method: "POST",
        body: JSON.stringify({ action: "next" }),
      });
      await Promise.resolve();
      expect(capture.events).toHaveLength(lifecycleCount);
    } finally {
      capture.dispose();
    }
  });

  it("streams assistant text from the conversation response without waiting for rendered DOM", async () => {
    const body = [
      'data: {"message":{"author":{"role":"assistant"},"content":{"parts":["Background answer"]}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    window.fetch = vi.fn(async () => new Response(body)) as typeof window.fetch;
    await import("./page-model-bridge");
    const capture = captureRunResponses();

    try {
      publishRunIntent("run-network-response");
      await window.fetch(`${location.origin}/backend-api/conversation`, {
        method: "POST",
        body: JSON.stringify({ action: "next" }),
      });
      await vi.waitFor(() =>
        expect(capture.events).toContainEqual({
          runId: "run-network-response",
          phase: "complete",
          markdown: "Background answer",
        }),
      );
      expect(capture.events).toContainEqual({
        runId: "run-network-response",
        phase: "snapshot",
        markdown: "Background answer",
      });
      expect(document.documentElement.hasAttribute(RUN_RESPONSE_ATTRIBUTE)).toBe(false);
    } finally {
      capture.dispose();
    }
  });

  it("accepts only a safe run id and preserves it until the next matching POST", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    window.fetch = fetchMock as typeof window.fetch;
    await import("./page-model-bridge");
    const capture = captureRunLifecycle();

    try {
      publishRunIntent("../../unsafe");
      expect(document.documentElement.hasAttribute(RUN_INTENT_ATTRIBUTE)).toBe(false);
      expect(document.documentElement.hasAttribute(RUN_READY_ATTRIBUTE)).toBe(false);
      await window.fetch(`${location.origin}/backend-api/conversation`, { method: "POST" });
      expect(capture.events).toEqual([]);

      publishRunIntent("run-spa-1");
      await window.fetch("https://example.com/backend-api/conversation", { method: "POST" });
      await window.fetch(`${location.origin}/backend-api/conversation`, { method: "GET" });
      await window.fetch(`${location.origin}/backend-api/other`, { method: "POST" });
      expect(capture.events).toEqual([]);

      await window.fetch(`${location.origin}/backend-api/f/conversation?source=spa`, {
        method: "POST",
      });
      await vi.waitFor(() =>
        expect(capture.events).toContainEqual({
          runId: "run-spa-1",
          phase: "response-complete",
        }),
      );

      publishRunIntent("run-spa-2");
      await window.fetch(`${location.origin}/backend-api/conversation`, { method: "POST" });
      await vi.waitFor(() =>
        expect(capture.events).toContainEqual({
          runId: "run-spa-2",
          phase: "response-complete",
        }),
      );
    } finally {
      capture.dispose();
    }
  });

  it("publishes response-error when the conversation fetch rejects", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("network unavailable");
    });
    window.fetch = fetchMock as typeof window.fetch;
    await import("./page-model-bridge");
    const capture = captureRunLifecycle();

    try {
      publishRunIntent("run-fetch-error");
      await expect(
        window.fetch(`${location.origin}/backend-api/conversation`, { method: "POST" }),
      ).rejects.toThrow("network unavailable");
      expect(capture.events).toEqual([
        { runId: "run-fetch-error", phase: "submitted" },
        { runId: "run-fetch-error", phase: "response-error", failureKind: "network" },
      ]);
    } finally {
      capture.dispose();
    }
  });

  it("publishes response-error when the cloned response reader fails", async () => {
    let failBody: (() => void) | undefined;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              failBody = () => controller.error(new Error("stream failed"));
            },
          }),
        ),
    );
    window.fetch = fetchMock as typeof window.fetch;
    await import("./page-model-bridge");
    const capture = captureRunLifecycle();

    try {
      publishRunIntent("run-reader-error");
      await expect(
        window.fetch(`${location.origin}/backend-api/conversation`, { method: "POST" }),
      ).resolves.toBeInstanceOf(Response);
      expect(capture.events).toEqual([
        { runId: "run-reader-error", phase: "submitted" },
        { runId: "run-reader-error", phase: "response-started" },
      ]);

      failBody?.();
      await vi.waitFor(() =>
        expect(capture.events).toContainEqual({
          runId: "run-reader-error",
          phase: "response-error",
          failureKind: "stream",
        }),
      );
      expect(capture.events).not.toContainEqual({
        runId: "run-reader-error",
        phase: "response-complete",
      });
    } finally {
      capture.dispose();
    }
  });

  it("reports a non-2xx status immediately without reading or exposing its body", async () => {
    const body = vi.fn(() => "private server detail");
    const response = new Response("private server detail", { status: 429 });
    Object.defineProperty(response, "text", { value: body });
    const fetchMock = vi.fn(async () => response);
    window.fetch = fetchMock as typeof window.fetch;
    await import("./page-model-bridge");
    const capture = captureRunLifecycle();

    try {
      publishRunIntent("run-http-error");
      await expect(
        window.fetch(`${location.origin}/backend-api/conversation`, {
          method: "POST",
          body: JSON.stringify({ prompt: "private prompt" }),
        }),
      ).resolves.toBe(response);
      expect(capture.events).toEqual([
        { runId: "run-http-error", phase: "submitted" },
        {
          runId: "run-http-error",
          phase: "response-error",
          failureKind: "http",
          httpStatus: 429,
        },
      ]);
      expect(body).not.toHaveBeenCalled();
      expect(JSON.stringify(capture.events)).not.toContain("private");
    } finally {
      capture.dispose();
    }
  });

  it("captures the exact Ask2GPT Project from ChatGPT runtime responses", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          { id: "g-p-other", name: "Other" },
          {
            id: "g-p-ask2gpt-123",
            name: "Ask2GPT",
            short_url: "/g/g-p-ask2gpt-123/project",
          },
        ],
      }),
    );
    window.fetch = fetchMock as typeof window.fetch;
    await import("./page-model-bridge");

    await window.fetch(`${location.origin}/backend-api/gizmos/snorlax/sidebar`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      JSON.parse(document.documentElement.getAttribute("data-ask2gpt-project-binding") ?? "null"),
    ).toMatchObject({
      name: "Ask2GPT",
      projectUrl: `${location.origin}/g/g-p-ask2gpt-123/project`,
      evidenceVersion: 2,
    });
  });

  it("actively refreshes only the fixed Project directory endpoint", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        items: [
          {
            name: "Ask2GPT",
            short_url: "/g/g-p-ask2gpt-active/project",
          },
        ],
      }),
    );
    window.fetch = fetchMock as typeof window.fetch;
    await import("./page-model-bridge");
    const results: Array<{
      requestId?: string;
      outcome?: string;
      projectUrl?: string;
      evidenceVersion?: number;
    }> = [];
    const listener = () => {
      const raw = document.documentElement.getAttribute(PROJECT_DIRECTORY_REFRESH_RESULT_ATTRIBUTE);
      if (raw) {
        results.push(
          JSON.parse(raw) as {
            requestId?: string;
            outcome?: string;
            projectUrl?: string;
            evidenceVersion?: number;
          },
        );
      }
    };
    document.addEventListener(PROJECT_DIRECTORY_REFRESH_RESULT_EVENT, listener);

    try {
      document.documentElement.setAttribute(
        PROJECT_DIRECTORY_REFRESH_REQUEST_ATTRIBUTE,
        "refresh-safe-1",
      );
      document.dispatchEvent(
        new CustomEvent(PROJECT_DIRECTORY_REFRESH_REQUEST_EVENT, {
          detail: {
            url: `${location.origin}/backend-api/private-account-export`,
            method: "POST",
            body: "must-not-be-used",
          },
        }),
      );

      await vi.waitFor(() =>
        expect(results).toContainEqual({
          requestId: "refresh-safe-1",
          outcome: "matched",
          projectUrl: `${location.origin}/g/g-p-ask2gpt-active/project`,
          evidenceVersion: 2,
        }),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [input, init] = fetchMock.mock.calls[0]!;
      expect(String(input)).toBe(`${location.origin}/backend-api/gizmos/snorlax/sidebar`);
      expect(init).toMatchObject({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
      expect(init?.body).toBeUndefined();
      expect(
        JSON.parse(document.documentElement.getAttribute("data-ask2gpt-project-binding") ?? "null"),
      ).toMatchObject({
        name: "Ask2GPT",
        projectUrl: `${location.origin}/g/g-p-ask2gpt-active/project`,
        evidenceVersion: 2,
      });
    } finally {
      document.removeEventListener(PROJECT_DIRECTORY_REFRESH_RESULT_EVENT, listener);
    }
  });

  it("clears stale Project evidence when an active refresh has no exact match", async () => {
    const fetchMock = vi.fn(async () => Response.json({ items: [] }));
    window.fetch = fetchMock as typeof window.fetch;
    document.documentElement.setAttribute(
      "data-ask2gpt-project-binding",
      JSON.stringify({
        name: "Ask2GPT",
        projectUrl: `${location.origin}/g/stale-project/project`,
      }),
    );
    await import("./page-model-bridge");

    document.documentElement.setAttribute(
      PROJECT_DIRECTORY_REFRESH_REQUEST_ATTRIBUTE,
      "refresh-stale-1",
    );
    document.dispatchEvent(new Event(PROJECT_DIRECTORY_REFRESH_REQUEST_EVENT));

    await vi.waitFor(() =>
      expect(
        document.documentElement.hasAttribute(PROJECT_DIRECTORY_REFRESH_RESULT_ATTRIBUTE),
      ).toBe(true),
    );
    expect(document.documentElement.getAttribute("data-ask2gpt-project-binding")).toBeNull();
  });

  it("coalesces concurrent active Project refreshes into one fixed request", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        await new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    window.fetch = fetchMock as typeof window.fetch;
    await import("./page-model-bridge");
    const results: string[] = [];
    const listener = () => {
      const raw = document.documentElement.getAttribute(PROJECT_DIRECTORY_REFRESH_RESULT_ATTRIBUTE);
      if (!raw) return;
      const result = JSON.parse(raw) as { requestId?: string };
      if (result.requestId) results.push(result.requestId);
    };
    document.addEventListener(PROJECT_DIRECTORY_REFRESH_RESULT_EVENT, listener);
    try {
      for (const requestId of ["refresh-concurrent-1", "refresh-concurrent-2"]) {
        document.documentElement.setAttribute(
          PROJECT_DIRECTORY_REFRESH_REQUEST_ATTRIBUTE,
          requestId,
        );
        document.dispatchEvent(new Event(PROJECT_DIRECTORY_REFRESH_REQUEST_EVENT));
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      resolveFetch?.(
        Response.json({
          items: [
            {
              name: "Ask2GPT",
              short_url: "/g/g-p-coalesced/project",
            },
          ],
        }),
      );
      await vi.waitFor(() =>
        expect(new Set(results)).toEqual(new Set(["refresh-concurrent-1", "refresh-concurrent-2"])),
      );
    } finally {
      document.removeEventListener(PROJECT_DIRECTORY_REFRESH_RESULT_EVENT, listener);
    }
  });

  it("does not read an active Project response from a different endpoint", async () => {
    const getReader = vi.fn();
    const response = {
      ok: true,
      redirected: false,
      url: `${location.origin}/backend-api/private-account-export`,
      headers: new Headers({ "content-type": "application/json" }),
      body: { getReader },
    } as unknown as Response;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);
    window.fetch = fetchMock as typeof window.fetch;
    await import("./page-model-bridge");

    document.documentElement.setAttribute(
      PROJECT_DIRECTORY_REFRESH_REQUEST_ATTRIBUTE,
      "refresh-wrong-response-1",
    );
    document.dispatchEvent(new Event(PROJECT_DIRECTORY_REFRESH_REQUEST_EVENT));

    await vi.waitFor(() =>
      expect(
        document.documentElement.hasAttribute(PROJECT_DIRECTORY_REFRESH_RESULT_ATTRIBUTE),
      ).toBe(true),
    );
    expect(getReader).not.toHaveBeenCalled();
    expect(document.documentElement.getAttribute("data-ask2gpt-project-binding")).toBeNull();
  });

  it("does not synthesize a Project route from a bare Project id", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        projects: [{ id: "g-p-6a62676fc580819184d35ae6715d6943", name: "Ask2GPT" }],
      }),
    );
    window.fetch = fetchMock as typeof window.fetch;
    await import("./page-model-bridge");

    await window.fetch(`${location.origin}/backend-api/gizmos/snorlax/sidebar`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.documentElement.getAttribute("data-ask2gpt-project-binding")).toBeNull();
  });

  it("revokes passive Project evidence when a later directory response has no match", async () => {
    const fetchMock = vi
      .fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ items: [] }))
      .mockResolvedValueOnce(
        Response.json({
          items: [
            {
              name: "Ask2GPT",
              short_url: "/g/g-p-passive-freshness/project",
            },
          ],
        }),
      );
    window.fetch = fetchMock as typeof window.fetch;
    await import("./page-model-bridge");

    await window.fetch(`${location.origin}/backend-api/gizmos/snorlax/sidebar`);
    await vi.waitFor(() =>
      expect(document.documentElement.hasAttribute("data-ask2gpt-project-binding")).toBe(true),
    );
    await window.fetch(`${location.origin}/backend-api/gizmos/snorlax/sidebar`);
    await vi.waitFor(() =>
      expect(document.documentElement.getAttribute("data-ask2gpt-project-binding")).toBeNull(),
    );
  });

  it("does not join an exact name to a route from a different response object", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        projects: [
          { id: "g-p-name-only", name: "Ask2GPT" },
          { short_url: "/g/g-p-unrelated/project", name: "Other" },
        ],
      }),
    );
    window.fetch = fetchMock as typeof window.fetch;
    await import("./page-model-bridge");

    await window.fetch(`${location.origin}/backend-api/gizmos/snorlax/sidebar`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.documentElement.getAttribute("data-ask2gpt-project-binding")).toBeNull();
  });

  it("does not clone or read arbitrary same-origin backend responses", async () => {
    const response = Response.json({
      items: [
        {
          name: "Ask2GPT",
          short_url: "/g/g-p-private-wrong/project",
        },
      ],
    });
    const clone = vi.spyOn(response, "clone");
    const text = vi.spyOn(response, "text");
    const fetchMock = vi.fn(async () => response);
    window.fetch = fetchMock as typeof window.fetch;
    await import("./page-model-bridge");

    await window.fetch(`${location.origin}/backend-api/private-account-export`);
    await Promise.resolve();

    expect(clone).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(document.documentElement.getAttribute("data-ask2gpt-project-binding")).toBeNull();
  });

  it("preserves the page-owned fetch result when a Project response cannot be cloned", async () => {
    const response = Response.json({ items: [] });
    vi.spyOn(response, "clone").mockImplementation(() => {
      throw new TypeError("body is already locked");
    });
    const fetchMock = vi.fn(async () => response);
    window.fetch = fetchMock as typeof window.fetch;
    await import("./page-model-bridge");

    await expect(
      window.fetch(`${location.origin}/backend-api/gizmos/snorlax/sidebar`),
    ).resolves.toBe(response);
    expect(document.documentElement.getAttribute("data-ask2gpt-project-binding")).toBeNull();
  });

  it("rejects a Project match hidden outside the directory endpoint top-level items schema", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        payload: {
          items: [
            {
              name: "Ask2GPT",
              short_url: "/g/g-p-nested-wrong/project",
            },
          ],
        },
      }),
    );
    window.fetch = fetchMock as typeof window.fetch;
    await import("./page-model-bridge");

    await window.fetch(`${location.origin}/backend-api/gizmos/snorlax/sidebar`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.documentElement.getAttribute("data-ask2gpt-project-binding")).toBeNull();
  });

  it("cancels a chunked Project directory response as soon as it crosses the byte cap", async () => {
    const chunkBytes = 1024 * 1024;
    let reads = 0;
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const read = vi.fn(async () => {
      reads += 1;
      if (reads > 5) throw new Error("bridge read beyond the byte cap");
      return { done: false as const, value: new Uint8Array(chunkBytes) };
    });
    const inspectionResponse = {
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        getReader: () => ({ read, cancel, releaseLock }),
      },
    } as unknown as Response;
    const response = new Response("page-owned response");
    const clone = vi.spyOn(response, "clone").mockReturnValue(inspectionResponse);
    const text = vi.spyOn(response, "text");
    const fetchMock = vi.fn(async () => response);
    window.fetch = fetchMock as typeof window.fetch;
    await import("./page-model-bridge");

    await window.fetch(`${location.origin}/backend-api/gizmos/snorlax/sidebar`);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));

    expect(clone).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(5);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
    expect(document.documentElement.getAttribute("data-ask2gpt-project-binding")).toBeNull();
  });
});

function publishRunIntent(runId: string) {
  document.documentElement.setAttribute(RUN_INTENT_ATTRIBUTE, JSON.stringify({ runId }));
  document.dispatchEvent(new Event(RUN_INTENT_EVENT));
}

function captureRunLifecycle(timeline?: string[]) {
  const events: RunLifecycle[] = [];
  const listener = () => {
    const raw = document.documentElement.getAttribute(RUN_LIFECYCLE_ATTRIBUTE);
    document.documentElement.removeAttribute(RUN_LIFECYCLE_ATTRIBUTE);
    if (!raw) return;
    const event = JSON.parse(raw) as RunLifecycle;
    events.push(event);
    timeline?.push(event.phase);
  };
  document.addEventListener(RUN_LIFECYCLE_EVENT, listener);
  return {
    events,
    dispose: () => document.removeEventListener(RUN_LIFECYCLE_EVENT, listener),
  };
}

function captureRunResponses() {
  const events: Array<{ runId: string; phase: "snapshot" | "complete"; markdown: string }> = [];
  const listener = () => {
    const raw = document.documentElement.getAttribute(RUN_RESPONSE_ATTRIBUTE);
    document.documentElement.removeAttribute(RUN_RESPONSE_ATTRIBUTE);
    if (raw) events.push(JSON.parse(raw) as (typeof events)[number]);
  };
  document.addEventListener(RUN_RESPONSE_EVENT, listener);
  return {
    events,
    dispose: () => document.removeEventListener(RUN_RESPONSE_EVENT, listener),
  };
}

function disposeBridge() {
  const pageWindow = window as typeof window & {
    [key: symbol]: { dispose?: () => void } | undefined;
  };
  pageWindow[BRIDGE_STATE_KEY]?.dispose?.();
  delete pageWindow[BRIDGE_STATE_KEY];
}
