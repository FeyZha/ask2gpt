export {};

const MODEL_INTENT_ATTRIBUTE = "data-ask2gpt-model-intent";
const MODEL_READY_ATTRIBUTE = "data-ask2gpt-model-ready";
const MODEL_INTENT_EVENT = "ask2gpt:model-intent";
const RUN_INTENT_ATTRIBUTE = "data-ask2gpt-run-intent";
const RUN_READY_ATTRIBUTE = "data-ask2gpt-run-ready";
const RUN_INTENT_EVENT = "ask2gpt:run-intent";
const RUN_LIFECYCLE_ATTRIBUTE = "data-ask2gpt-run-lifecycle";
const RUN_LIFECYCLE_EVENT = "ask2gpt:run-lifecycle";
const RUN_RESPONSE_ATTRIBUTE = "data-ask2gpt-run-response";
const RUN_RESPONSE_EVENT = "ask2gpt:run-response";
const PROJECT_BINDING_ATTRIBUTE = "data-ask2gpt-project-binding";
const PROJECT_DIRECTORY_REFRESH_REQUEST_ATTRIBUTE =
  "data-ask2gpt-project-directory-refresh-request";
const PROJECT_DIRECTORY_REFRESH_RESULT_ATTRIBUTE = "data-ask2gpt-project-directory-refresh-result";
const PROJECT_DIRECTORY_REFRESH_REQUEST_EVENT = "ask2gpt:project-directory-refresh-request";
const PROJECT_DIRECTORY_REFRESH_RESULT_EVENT = "ask2gpt:project-directory-refresh-result";
const REQUIRED_PROJECT_NAME = "Ask2GPT";
const PROJECT_DIRECTORY_PATH = "/backend-api/gizmos/snorlax/sidebar";
const MODEL_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_DISCOVERY_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RUN_RESPONSE_CHARS = 1_500_000;
const MAX_PROJECT_DIRECTORY_ITEMS = 1_000;
const MAX_RUN_INTENT_CHARS = 192;
const PROJECT_DIRECTORY_REFRESH_TIMEOUT_MS = 2_500;
const PROJECT_DIRECTORY_REFRESH_COOLDOWN_MS = 1_000;
const PROJECT_DIRECTORY_REFRESH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const PROJECT_EVIDENCE_VERSION = 2;
const stateKey = Symbol.for("ask2gpt.pageModelBridge");

type RunLifecyclePhase = "submitted" | "response-started" | "response-complete" | "response-error";
type RunLifecycleFailureKind = "http" | "network" | "stream";

interface BridgeState {
  pendingModel?: {
    modelId: string;
    reasoningEffort?: "min" | "standard" | "extended" | "max";
  };
  pendingRunId?: string;
  projectDirectoryFetch?: typeof window.fetch;
  projectDirectoryRefresh?: Promise<void>;
  projectDirectoryRefreshWaiters?: Set<string>;
  lastProjectDirectoryRefreshAt?: number;
  lastProjectDirectoryRefreshResult?: ProjectDirectoryRefreshResult;
  installed: boolean;
  dispose?: () => void;
}

type ProjectDirectoryRefreshOutcome = "matched" | "no-match" | "unavailable";
interface ProjectDirectoryRefreshResult {
  outcome: ProjectDirectoryRefreshOutcome;
  projectUrl?: string;
}

const pageWindow = window as typeof window & { [stateKey]?: BridgeState };
const state = pageWindow[stateKey] ?? { installed: false };
pageWindow[stateKey] = state;

if (!state.installed) {
  state.installed = true;
  document.addEventListener(MODEL_INTENT_EVENT, receiveModelIntent, true);
  document.addEventListener(RUN_INTENT_EVENT, receiveRunIntent, true);
  document.addEventListener(
    PROJECT_DIRECTORY_REFRESH_REQUEST_EVENT,
    receiveProjectDirectoryRefresh,
    true,
  );
  const originalFetch = window.fetch;
  state.projectDirectoryFetch = originalFetch;
  const bridgeFetch: typeof window.fetch = async function ask2gptModelFetch(input, init) {
    const conversationSubmission = isConversationSubmission(input, init);
    const model = state.pendingModel;
    let requestInput = input;
    let requestInit = init;
    if (model && conversationSubmission) {
      const rewritten = await rewriteConversationRequest(input, init, model);
      if (rewritten) {
        state.pendingModel = undefined;
        requestInput = rewritten.input;
        requestInit = rewritten.init;
      }
    }
    const runId = conversationSubmission ? state.pendingRunId : undefined;
    if (runId) {
      state.pendingRunId = undefined;
      publishRunLifecycle(runId, "submitted");
    }
    let response: Response;
    try {
      response = await originalFetch.call(window, requestInput, requestInit);
    } catch (error) {
      if (runId) publishRunLifecycle(runId, "response-error", { failureKind: "network" });
      throw error;
    }
    if (runId) {
      if (response.ok) {
        publishRunLifecycle(runId, "response-started");
        void observeRunResponse(runId, response);
      } else {
        publishRunLifecycle(runId, "response-error", {
          failureKind: "http",
          httpStatus: response.status,
        });
      }
    }
    if (isProjectDirectoryRequest(requestInput, requestInit)) {
      try {
        void inspectProjectDirectoryResponse(response.clone());
      } catch {
        // Project discovery is best-effort and must never change page-owned fetch semantics.
      }
    }
    return response;
  };
  window.fetch = bridgeFetch;
  state.dispose = () => {
    document.removeEventListener(MODEL_INTENT_EVENT, receiveModelIntent, true);
    document.removeEventListener(RUN_INTENT_EVENT, receiveRunIntent, true);
    document.removeEventListener(
      PROJECT_DIRECTORY_REFRESH_REQUEST_EVENT,
      receiveProjectDirectoryRefresh,
      true,
    );
    if (window.fetch === bridgeFetch) window.fetch = originalFetch;
    state.pendingModel = undefined;
    state.pendingRunId = undefined;
    state.projectDirectoryFetch = undefined;
    state.projectDirectoryRefreshWaiters?.clear();
    state.projectDirectoryRefreshWaiters = undefined;
    state.projectDirectoryRefresh = undefined;
    state.installed = false;
  };
}

function receiveProjectDirectoryRefresh() {
  const root = document.documentElement;
  const requestId = root.getAttribute(PROJECT_DIRECTORY_REFRESH_REQUEST_ATTRIBUTE);
  root.removeAttribute(PROJECT_DIRECTORY_REFRESH_REQUEST_ATTRIBUTE);
  if (!requestId || !PROJECT_DIRECTORY_REFRESH_ID_PATTERN.test(requestId)) return;

  const now = Date.now();
  if (
    !state.projectDirectoryRefresh &&
    state.lastProjectDirectoryRefreshResult &&
    state.lastProjectDirectoryRefreshAt !== undefined &&
    now - state.lastProjectDirectoryRefreshAt < PROJECT_DIRECTORY_REFRESH_COOLDOWN_MS
  ) {
    publishProjectDirectoryRefreshResult(requestId, state.lastProjectDirectoryRefreshResult);
    return;
  }

  const waiters = state.projectDirectoryRefreshWaiters ?? new Set<string>();
  state.projectDirectoryRefreshWaiters = waiters;
  waiters.add(requestId);
  if (state.projectDirectoryRefresh) return;

  root.removeAttribute(PROJECT_BINDING_ATTRIBUTE);
  state.lastProjectDirectoryRefreshAt = now;
  const refresh = refreshProjectDirectory()
    .then((result) => {
      state.lastProjectDirectoryRefreshResult = result;
      for (const waiter of state.projectDirectoryRefreshWaiters ?? []) {
        publishProjectDirectoryRefreshResult(waiter, result);
      }
    })
    .finally(() => {
      state.projectDirectoryRefreshWaiters?.clear();
      if (state.projectDirectoryRefresh === refresh) state.projectDirectoryRefresh = undefined;
    });
  state.projectDirectoryRefresh = refresh;
}

async function refreshProjectDirectory(): Promise<ProjectDirectoryRefreshResult> {
  const fetchProjectDirectory = state.projectDirectoryFetch;
  if (!fetchProjectDirectory) return { outcome: "unavailable" };
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), PROJECT_DIRECTORY_REFRESH_TIMEOUT_MS);
  try {
    const response = await fetchProjectDirectory.call(
      window,
      `${location.origin}${PROJECT_DIRECTORY_PATH}`,
      {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { accept: "application/json" },
        signal: controller.signal,
      },
    );
    return await inspectProjectDirectoryResponse(response);
  } catch {
    document.documentElement.removeAttribute(PROJECT_BINDING_ATTRIBUTE);
    return { outcome: "unavailable" };
  } finally {
    window.clearTimeout(timeout);
  }
}

function publishProjectDirectoryRefreshResult(
  requestId: string,
  result: ProjectDirectoryRefreshResult,
) {
  const root = document.documentElement;
  root.setAttribute(
    PROJECT_DIRECTORY_REFRESH_RESULT_ATTRIBUTE,
    JSON.stringify({ requestId, evidenceVersion: PROJECT_EVIDENCE_VERSION, ...result }),
  );
  document.dispatchEvent(new Event(PROJECT_DIRECTORY_REFRESH_RESULT_EVENT));
}

function receiveRunIntent() {
  const root = document.documentElement;
  const rawIntent = root.getAttribute(RUN_INTENT_ATTRIBUTE);
  root.removeAttribute(RUN_INTENT_ATTRIBUTE);
  root.removeAttribute(RUN_READY_ATTRIBUTE);
  if (!rawIntent || rawIntent.length > MAX_RUN_INTENT_CHARS) return;
  let intent: unknown;
  try {
    intent = JSON.parse(rawIntent);
  } catch {
    return;
  }
  if (
    !isPlainRecord(intent) ||
    typeof intent.runId !== "string" ||
    !RUN_ID_PATTERN.test(intent.runId)
  ) {
    return;
  }
  state.pendingRunId = intent.runId;
  root.setAttribute(RUN_READY_ATTRIBUTE, rawIntent);
}

function publishRunLifecycle(
  runId: string,
  phase: RunLifecyclePhase,
  failure?: { failureKind: RunLifecycleFailureKind; httpStatus?: number },
) {
  const root = document.documentElement;
  // This page-to-content bridge deliberately carries only lifecycle metadata.
  // Never include the request body, response body, URL, prompt, or answer.
  const payload = JSON.stringify({ runId, phase, ...failure });
  try {
    root.setAttribute(RUN_LIFECYCLE_ATTRIBUTE, payload);
    document.dispatchEvent(new Event(RUN_LIFECYCLE_EVENT));
  } finally {
    if (root.getAttribute(RUN_LIFECYCLE_ATTRIBUTE) === payload) {
      root.removeAttribute(RUN_LIFECYCLE_ATTRIBUTE);
    }
  }
}

function publishRunResponse(runId: string, phase: "snapshot" | "complete", markdown: string) {
  if (!markdown || markdown.length > MAX_RUN_RESPONSE_CHARS) return;
  const root = document.documentElement;
  const payload = JSON.stringify({ runId, phase, markdown });
  try {
    root.setAttribute(RUN_RESPONSE_ATTRIBUTE, payload);
    document.dispatchEvent(new Event(RUN_RESPONSE_EVENT));
  } finally {
    if (root.getAttribute(RUN_RESPONSE_ATTRIBUTE) === payload) {
      root.removeAttribute(RUN_RESPONSE_ATTRIBUTE);
    }
  }
}

async function observeRunResponse(runId: string, response: Response) {
  try {
    const reader = response.clone().body?.getReader();
    const decoder = new PageConversationResponseDecoder();
    const textDecoder = new TextDecoder();
    if (reader) {
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          const markdown = decoder.push(textDecoder.decode(result.value, { stream: true }));
          if (markdown) publishRunResponse(runId, "snapshot", markdown);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const markdown = decoder.push(textDecoder.decode()) ?? decoder.finish();
    if (markdown) publishRunResponse(runId, "complete", markdown);
    publishRunLifecycle(runId, "response-complete");
  } catch {
    publishRunLifecycle(runId, "response-error", { failureKind: "stream" });
  }
}

// MAIN-world content scripts must remain one classic, import-free file. Keep
// this narrow decoder in this entrypoint; the worker uses the shared decoder.
class PageConversationResponseDecoder {
  private buffer = "";
  private latestMarkdown = "";
  private deltaMarkdown = "";

  push(chunk: string) {
    this.buffer += chunk;
    let changed: string | undefined;
    for (;;) {
      const boundary = nextPageResponseBoundary(this.buffer);
      if (!boundary) break;
      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      changed = this.consumeFrame(frame) ?? changed;
    }
    return changed;
  }

  finish() {
    const tail = this.buffer.trim();
    this.buffer = "";
    if (tail) this.consumeFrame(tail);
    return this.latestMarkdown || undefined;
  }

  private consumeFrame(frame: string) {
    const data = frame
      .replaceAll("\r\n", "\n")
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    const payloadText = data || frame.trim();
    if (!payloadText || payloadText === "[DONE]") return undefined;

    let payload: unknown;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      return undefined;
    }
    const full = pageAssistantMarkdown(payload);
    if (full !== undefined) {
      if (full === this.latestMarkdown) return undefined;
      this.latestMarkdown = full;
      this.deltaMarkdown = "";
      return full;
    }
    const delta = pageAssistantDelta(payload);
    if (!delta) return undefined;
    this.deltaMarkdown += delta;
    if (this.deltaMarkdown === this.latestMarkdown) return undefined;
    this.latestMarkdown = this.deltaMarkdown;
    return this.latestMarkdown;
  }
}

function nextPageResponseBoundary(value: string) {
  const lf = value.indexOf("\n\n");
  const crlf = value.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return undefined;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function pageAssistantMarkdown(value: unknown): string | undefined {
  if (!isPlainRecord(value)) return undefined;
  const direct = pageAssistantMessageMarkdown(value.message);
  if (direct !== undefined) return direct;
  if (Array.isArray(value.messages)) {
    for (let index = value.messages.length - 1; index >= 0; index -= 1) {
      const candidate = pageAssistantMessageMarkdown(value.messages[index]);
      if (candidate !== undefined) return candidate;
    }
  }
  for (const nested of [value.data, value.response, value.result]) {
    const candidate = pageAssistantMarkdown(nested);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function pageAssistantMessageMarkdown(value: unknown) {
  if (!isPlainRecord(value) || !pageIsAssistantRole(value.author, value.role)) return undefined;
  return pageContentMarkdown(value.content) ?? pageTextValue(value.text);
}

function pageContentMarkdown(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isPlainRecord(value)) return undefined;
  if (Array.isArray(value.parts)) {
    const parts = value.parts
      .map((part) =>
        typeof part === "string" ? part : isPlainRecord(part) ? pageTextValue(part.text) : "",
      )
      .filter(Boolean);
    if (parts.length > 0) return parts.join("\n");
  }
  return pageTextValue(value.text);
}

function pageAssistantDelta(value: unknown): string | undefined {
  if (!isPlainRecord(value)) return undefined;
  const delta = isPlainRecord(value.delta) ? value.delta : undefined;
  if (delta && pageIsAssistantRole(delta.author, delta.role)) {
    return pageContentMarkdown(delta.content) ?? pageTextValue(delta.text);
  }
  for (const nested of [value.data, value.response, value.result]) {
    const candidate = pageAssistantDelta(nested);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function pageIsAssistantRole(author: unknown, role: unknown) {
  return role === "assistant" || (isPlainRecord(author) && author.role === "assistant");
}

function pageTextValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

async function inspectProjectDirectoryResponse(
  response: Response,
): Promise<ProjectDirectoryRefreshResult> {
  if (
    !response.ok ||
    response.redirected ||
    !isExpectedProjectDirectoryResponseUrl(response.url) ||
    !isJsonResponse(response)
  ) {
    document.documentElement.removeAttribute(PROJECT_BINDING_ATTRIBUTE);
    return { outcome: "unavailable" };
  }
  const text = await readResponseTextWithinByteCap(response);
  if (!text) {
    document.documentElement.removeAttribute(PROJECT_BINDING_ATTRIBUTE);
    return { outcome: "unavailable" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    document.documentElement.removeAttribute(PROJECT_BINDING_ATTRIBUTE);
    return { outcome: "unavailable" };
  }
  const matches = findExactProjectRoutes(payload);
  if (matches.size !== 1) {
    document.documentElement.removeAttribute(PROJECT_BINDING_ATTRIBUTE);
    return { outcome: "no-match" };
  }
  const [projectUrl] = matches;
  const observedAt = Date.now();
  document.documentElement.setAttribute(
    PROJECT_BINDING_ATTRIBUTE,
    JSON.stringify({
      name: REQUIRED_PROJECT_NAME,
      projectUrl,
      evidenceVersion: PROJECT_EVIDENCE_VERSION,
      observedAt,
    }),
  );
  return { outcome: "matched", projectUrl };
}

function isExpectedProjectDirectoryResponseUrl(rawUrl: string) {
  if (!rawUrl) return true;
  try {
    const url = new URL(rawUrl, location.origin);
    return url.origin === location.origin && url.pathname === PROJECT_DIRECTORY_PATH;
  } catch {
    return false;
  }
}

function findExactProjectRoutes(payload: unknown) {
  const projectUrls = new Set<string>();
  if (!isPlainRecord(payload) || !Array.isArray(payload.items)) return projectUrls;
  if (payload.items.length > MAX_PROJECT_DIRECTORY_ITEMS) return projectUrls;
  for (const item of payload.items) {
    if (!isPlainRecord(item)) continue;
    const project = isPlainRecord(item.gizmo) ? item.gizmo : item;
    const display = isPlainRecord(project.display) ? project.display : undefined;
    const name = [display?.name, project.name].find(
      (value): value is string => typeof value === "string",
    );
    const projectUrl = [
      project.short_url,
      project.project_url,
      project.url,
      display?.short_url,
      display?.project_url,
      display?.url,
    ]
      .map(projectRootUrlFromStructuredRoute)
      .find((value): value is string => Boolean(value));
    if (name && isRequiredProjectName(name) && projectUrl) {
      projectUrls.add(projectUrl);
    }
  }
  return projectUrls;
}

function isRequiredProjectName(value: string) {
  const normalized = value.trim().toLocaleLowerCase();
  return normalized === REQUIRED_PROJECT_NAME.toLocaleLowerCase();
}

function isProjectDirectoryRequest(input: RequestInfo | URL, init: RequestInit | undefined) {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "GET") return false;
  const rawUrl = input instanceof Request ? input.url : input.toString();
  try {
    const url = new URL(rawUrl, location.origin);
    return url.origin === location.origin && url.pathname === PROJECT_DIRECTORY_PATH;
  } catch {
    return false;
  }
}

function isJsonResponse(response: Response) {
  const contentType = response.headers.get("content-type")?.toLocaleLowerCase() ?? "";
  return contentType === "application/json" || contentType.startsWith("application/json;");
}

async function readResponseTextWithinByteCap(response: Response) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/u.test(declaredLength)) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes > MAX_DISCOVERY_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
  }
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        text += decoder.decode();
        return text;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_DISCOVERY_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

function projectRootUrlFromStructuredRoute(value: unknown) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) return undefined;
  if (!value.startsWith("/") && !/^https:\/\//iu.test(value)) return undefined;
  try {
    const url = new URL(value, location.origin);
    if (
      url.origin !== location.origin ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== new URL(location.origin).port
    ) {
      return undefined;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (
      segments.length !== 3 ||
      segments[0] !== "g" ||
      segments[2] !== "project" ||
      !segments.every(isSafeProjectPathSegment)
    ) {
      return undefined;
    }
    url.pathname = `/${segments.join("/")}`;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function isSafeProjectPathSegment(segment: string) {
  if (segment.length < 1 || segment.length > 256 || segment.includes("\\")) return false;
  try {
    const decoded = decodeURIComponent(segment);
    return decoded !== "." && decoded !== ".." && !decoded.includes("/") && !decoded.includes("\\");
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function receiveModelIntent() {
  const rawIntent = document.documentElement.getAttribute(MODEL_INTENT_ATTRIBUTE);
  document.documentElement.removeAttribute(MODEL_INTENT_ATTRIBUTE);
  if (!rawIntent || rawIntent.length > 256) return;
  let intent: unknown;
  try {
    intent = JSON.parse(rawIntent);
  } catch {
    return;
  }
  if (!isPlainRecord(intent) || !MODEL_ID_PATTERN.test(String(intent.modelId))) return;
  const reasoningEffort = intent.reasoningEffort;
  if (
    reasoningEffort !== undefined &&
    !["min", "standard", "extended", "max"].includes(String(reasoningEffort))
  ) {
    return;
  }
  state.pendingModel = {
    modelId: String(intent.modelId),
    ...(reasoningEffort
      ? { reasoningEffort: reasoningEffort as "min" | "standard" | "extended" | "max" }
      : {}),
  };
  document.documentElement.setAttribute(MODEL_READY_ATTRIBUTE, rawIntent);
}

function isConversationSubmission(input: RequestInfo | URL, init?: RequestInit) {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "POST") return false;
  const rawUrl = input instanceof Request ? input.url : input.toString();
  try {
    const url = new URL(rawUrl, location.origin);
    return (
      url.origin === location.origin &&
      (url.pathname === "/backend-api/conversation" ||
        url.pathname === "/backend-api/f/conversation")
    );
  } catch {
    return false;
  }
}

async function rewriteConversationRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  model: NonNullable<BridgeState["pendingModel"]>,
) {
  if (input instanceof Request) {
    const body = await input
      .clone()
      .text()
      .catch(() => undefined);
    const rewrittenBody = rewriteJsonBody(body, model);
    if (!rewrittenBody) return undefined;
    return {
      input: new Request(input, { body: rewrittenBody }),
      init,
    };
  }
  const rewrittenBody = rewriteJsonBody(
    typeof init?.body === "string" ? init.body : undefined,
    model,
  );
  if (!rewrittenBody) return undefined;
  return {
    input,
    init: { ...init, body: rewrittenBody },
  };
}

function rewriteJsonBody(
  body: string | undefined,
  model: NonNullable<BridgeState["pendingModel"]>,
) {
  if (!body || body.length > 2 * 1024 * 1024) return undefined;
  try {
    const payload: unknown = JSON.parse(body);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const rewritten: Record<string, unknown> = {
      ...(payload as Record<string, unknown>),
      model: model.modelId,
    };
    if (model.reasoningEffort) rewritten.thinking_effort = model.reasoningEffort;
    else delete rewritten.thinking_effort;
    return JSON.stringify(rewritten);
  } catch {
    return undefined;
  }
}
