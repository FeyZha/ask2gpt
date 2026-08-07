import {
  MAX_RELAY_FRAME_BYTES,
  isGenericConversationTitle,
  type RelayErrorCode,
  type RelayErrorPayload,
} from "@ask2gpt/protocol";

export const MAX_PROMPT_CHARS = 100_000;
export const MAX_MARKDOWN_BYTES = MAX_RELAY_FRAME_BYTES - 64 * 1024;
export const RELAY_CONNECT_TIMEOUT_MS = 5_000;
export const RECONNECT_BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000] as const;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STABLE_PROJECT_ID = /^g-p-[0-9a-f]{32}$/iu;
const ERROR_CODES = new Set<RelayErrorCode>([
  "AUTH_REQUIRED",
  "AUTH_FAILED",
  "PAIRING_CODE_INVALID",
  "PAIRING_CODE_EXPIRED",
  "PROTOCOL_MISMATCH",
  "FRAME_TOO_LARGE",
  "CHROME_DISCONNECTED",
  "CONCURRENT_RUN_LIMIT",
  "CONVERSATION_BUSY",
  "CHATGPT_LOGIN_REQUIRED",
  "CHATGPT_CHALLENGE_REQUIRED",
  "CHATGPT_PROJECT_REQUIRED",
  "CHATGPT_PROJECT_MISMATCH",
  "CHATGPT_COMPOSER_MISSING",
  "CHATGPT_ATTACHMENT_FAILED",
  "CHATGPT_SEND_FAILED",
  "CHATGPT_REMOTE_UNAVAILABLE",
  "CHATGPT_MODEL_UNAVAILABLE",
  "CHATGPT_MODEL_SELECTION_FAILED",
  "REGENERATE_CONTROL_UNAVAILABLE",
  "RESPONSE_TIMEOUT",
  "SELECTOR_INCOMPATIBLE",
  "INTERNAL_ERROR",
]);

export type ContentEventType = "snapshot" | "slow" | "complete" | "stopped" | "error";

export interface ValidatedContentEvent {
  type: "content.event";
  eventType: ContentEventType;
  conversationId: string;
  runId: string;
  markdown?: string;
  remoteUrl?: string;
  title?: string;
  error?: RelayErrorPayload;
}

export interface ProjectRoute {
  projectUrl: string;
  scope: string;
}

export interface ProjectBinding extends ProjectRoute {
  version: 4 | 5;
  name: string;
  boundAt: string;
  provenance?: "strict-visible-project-v1";
}

export function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

export function reconnectDelay(attempt: number) {
  const safeAttempt = Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : 0;
  return RECONNECT_BACKOFF_MS[Math.min(safeAttempt, RECONNECT_BACKOFF_MS.length - 1)]!;
}

export function isChatGptPageUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "chatgpt.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function normalizePromptText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\r\n?/g, "\n");
  if (normalized.length < 1 || normalized.length > MAX_PROMPT_CHARS) return undefined;
  return normalized;
}

export function normalizeRemoteConversationUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const url = parseSafeChatGptUrl(value);
  if (!url) return undefined;
  const isRoot = url.pathname === "/" || url.pathname === "";
  const isConversation = /^\/c\/[^/]+\/?$/.test(url.pathname);
  const isProjectRoute = isConservativeProjectPath(url.pathname);
  if (!isRoot && !isConversation && !isProjectRoute) return undefined;
  url.pathname = canonicalPathname(url.pathname);
  return url.href;
}

export function normalizeRemoteConversationTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value.replace(/\s+/gu, " ").trim();
  if (/[\p{Cc}\p{Cf}]/u.test(title)) {
    return undefined;
  }
  if (title.length < 1 || title.length > 80 || isGenericConversationTitle(title)) {
    return undefined;
  }
  return title;
}

export function parseProjectRootUrl(value: unknown): ProjectRoute | undefined {
  const url = parseSafeChatGptUrl(value);
  if (!url) return undefined;
  const segments = safePathSegments(url.pathname);
  if (!segments || segments.length < 3 || segments.at(-1) !== "project") return undefined;
  return projectRouteFromScopeSegments(url.origin, segments.slice(0, -1));
}

export function parseProjectPageUrl(value: unknown): ProjectRoute | undefined {
  const url = parseSafeChatGptUrl(value);
  if (!url) return undefined;
  const segments = safePathSegments(url.pathname);
  if (!segments) return undefined;
  if (segments.length >= 3 && segments.at(-1) === "project") {
    return projectRouteFromScopeSegments(url.origin, segments.slice(0, -1));
  }
  if (segments.length >= 4 && segments.at(-2) === "c" && isSafePathSegment(segments.at(-1)!)) {
    return projectRouteFromScopeSegments(url.origin, segments.slice(0, -2));
  }
  return undefined;
}

/**
 * ChatGPT currently exposes one Project through two URL forms: the Project
 * root uses the stable `g-p-<hex>` scope, while an in-Project conversation may
 * append the display slug (for example `g-p-<hex>-ask2gpt`). Treat only that
 * documented-looking stable-ID alias as equivalent; unrelated Project scopes
 * remain different.
 */
export function canonicalProjectScope(value: unknown): string | undefined {
  const descriptor = projectScopeDescriptor(value);
  if (!descriptor) return undefined;
  const stableSegment = stableProjectScopeSegment(descriptor.segment);
  return `${descriptor.origin}/g/${stableSegment}/`;
}

export function projectScopesMatch(left: unknown, right: unknown): boolean {
  const leftScope = canonicalProjectScope(left);
  const rightScope = canonicalProjectScope(right);
  return Boolean(leftScope && rightScope && leftScope === rightScope);
}

function projectRouteFromScopeSegments(origin: string, scopeSegments: string[]) {
  // ChatGPT Projects use the dedicated /g/<project-scope>/... namespace.
  // Keep this exact so another future scoped ChatGPT surface cannot be
  // mistaken for a Project merely because its URL ends in /project or /c/:id.
  if (scopeSegments.length !== 2 || scopeSegments[0] !== "g") return undefined;
  const scopePath = `/${scopeSegments.join("/")}/`;
  return {
    projectUrl: `${origin}${scopePath}project`,
    scope: `${origin}${scopePath}`,
  };
}

export function normalizeProjectScopedUrl(
  value: unknown,
  binding: Pick<ProjectRoute, "projectUrl" | "scope">,
): string | undefined {
  const route = parseProjectRootUrl(binding.projectUrl);
  if (!route || !projectScopesMatch(route.scope, binding.scope)) return undefined;
  const url = parseSafeChatGptUrl(value);
  if (!url) return undefined;
  const observedRoute = parseProjectPageUrl(url.href);
  if (!observedRoute || !projectScopesMatch(observedRoute.scope, route.scope)) {
    return undefined;
  }
  const segments = safePathSegments(url.pathname);
  if (!segments) return undefined;
  if (segments.at(-1) === "project") return route.projectUrl;
  const conversationId = segments.at(-1);
  if (segments.at(-2) !== "c" || !conversationId || !isSafePathSegment(conversationId)) {
    return undefined;
  }
  const scopePath = new URL(route.scope).pathname;
  return `${url.origin}${scopePath}c/${conversationId}`;
}

function projectScopeDescriptor(value: unknown) {
  const url = parseSafeChatGptUrl(value);
  if (!url) return undefined;
  const segments = safePathSegments(url.pathname);
  if (!segments || segments.length !== 2 || segments[0] !== "g") return undefined;
  return { origin: url.origin, segment: segments[1]! };
}

function stableProjectScopeSegment(segment: string) {
  if (STABLE_PROJECT_ID.test(segment)) return segment;
  const alias = segment.match(/^(g-p-[0-9a-f]{32})-[A-Za-z0-9][A-Za-z0-9._-]*$/iu);
  return alias?.[1] ?? segment;
}

export function parseStoredProjectBinding(value: unknown): ProjectBinding | undefined {
  if (
    !isRecord(value) ||
    value.version !== 4 ||
    typeof value.projectUrl !== "string" ||
    typeof value.scope !== "string" ||
    typeof value.name !== "string" ||
    typeof value.boundAt !== "string"
  ) {
    return undefined;
  }
  const route = parseProjectRootUrl(value.projectUrl);
  const name = value.name.trim();
  if (
    !route ||
    route.projectUrl !== value.projectUrl ||
    route.scope !== value.scope ||
    name !== value.name ||
    name.length < 1 ||
    name.length > 120 ||
    /\p{Cc}/u.test(name) ||
    !isIsoDate(value.boundAt)
  ) {
    return undefined;
  }
  return {
    version: 4,
    projectUrl: route.projectUrl,
    scope: route.scope,
    name,
    boundAt: value.boundAt,
  };
}

export function parseStoredTrustedProjectBinding(value: unknown): ProjectBinding | undefined {
  if (
    !isRecord(value) ||
    value.version !== 5 ||
    value.provenance !== "strict-visible-project-v1" ||
    typeof value.projectUrl !== "string" ||
    typeof value.scope !== "string" ||
    typeof value.name !== "string" ||
    typeof value.boundAt !== "string"
  ) {
    return undefined;
  }
  const route = parseProjectRootUrl(value.projectUrl);
  const name = value.name.trim();
  if (
    !route ||
    route.projectUrl !== value.projectUrl ||
    route.scope !== value.scope ||
    name !== value.name ||
    name.length < 1 ||
    name.length > 120 ||
    /\p{Cc}/u.test(name) ||
    !isIsoDate(value.boundAt)
  ) {
    return undefined;
  }
  return {
    version: 5,
    provenance: "strict-visible-project-v1",
    projectUrl: route.projectUrl,
    scope: route.scope,
    name,
    boundAt: value.boundAt,
  };
}

export function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function parseContentEvent(value: unknown): ValidatedContentEvent | undefined {
  if (!isRecord(value) || value.type !== "content.event") return undefined;
  if (
    !["snapshot", "slow", "complete", "stopped", "error"].includes(String(value.eventType)) ||
    !isSafeId(value.conversationId) ||
    !isSafeId(value.runId)
  ) {
    return undefined;
  }

  const eventType = value.eventType as ContentEventType;
  if (
    value.markdown !== undefined &&
    (typeof value.markdown !== "string" || utf8ByteLength(value.markdown) > MAX_MARKDOWN_BYTES)
  ) {
    return undefined;
  }

  const remoteUrl =
    value.remoteUrl === undefined ? undefined : normalizeRemoteConversationUrl(value.remoteUrl);
  if (value.remoteUrl !== undefined && !remoteUrl) return undefined;

  const title =
    value.title === undefined ? undefined : normalizeRemoteConversationTitle(value.title);
  if (value.title !== undefined && !title) return undefined;
  if (
    title &&
    (eventType === "error" ||
      eventType === "slow" ||
      !remoteUrl ||
      !isNormalizedConversationUrl(remoteUrl))
  ) {
    return undefined;
  }

  const error = value.error === undefined ? undefined : parseRelayError(value.error);
  if ((eventType === "error") !== Boolean(error)) return undefined;

  return {
    type: "content.event",
    eventType,
    conversationId: value.conversationId,
    runId: value.runId,
    ...(value.markdown === undefined ? {} : { markdown: value.markdown }),
    ...(remoteUrl === undefined ? {} : { remoteUrl }),
    ...(title === undefined ? {} : { title }),
    ...(error === undefined ? {} : { error }),
  };
}

export function parseRelayError(value: unknown): RelayErrorPayload | undefined {
  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    !ERROR_CODES.has(value.code as RelayErrorCode) ||
    typeof value.message !== "string" ||
    value.message.length < 1 ||
    value.message.length > 1_000 ||
    typeof value.recoverable !== "boolean" ||
    (value.focusTab !== undefined && typeof value.focusTab !== "boolean")
  ) {
    return undefined;
  }
  return {
    code: value.code as RelayErrorCode,
    message: value.message,
    recoverable: value.recoverable,
    ...(value.focusTab === undefined ? {} : { focusTab: value.focusTab }),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSafeChatGptUrl(value: unknown) {
  if (!isChatGptPageUrl(value)) return undefined;
  const url = new URL(value);
  if (!safePathSegments(url.pathname)) return undefined;
  url.search = "";
  url.hash = "";
  return url;
}

function isConservativeProjectPath(pathname: string) {
  const segments = safePathSegments(pathname);
  if (!segments || segments.length < 3) return false;
  if (segments.at(-1) === "project") return true;
  return segments.length >= 4 && segments.at(-2) === "c";
}

function isNormalizedConversationUrl(value: string) {
  const url = new URL(value);
  if (/^\/c\/[^/]+$/.test(url.pathname)) return true;
  const segments = url.pathname.split("/").filter(Boolean);
  return (
    segments.length === 4 &&
    segments[0] === "g" &&
    segments[2] === "c" &&
    segments.every(isSafePathSegment)
  );
}

function safePathSegments(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  return segments.every(isSafePathSegment) ? segments : undefined;
}

function isSafePathSegment(segment: string) {
  if (segment.length < 1 || segment.length > 256 || segment.includes("\\")) return false;
  try {
    const decoded = decodeURIComponent(segment);
    return decoded !== "." && decoded !== ".." && !decoded.includes("/") && !decoded.includes("\\");
  } catch {
    return false;
  }
}

function canonicalPathname(pathname: string) {
  if (pathname === "" || pathname === "/") return "/";
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function isIsoDate(value: string) {
  return (
    value.length >= 20 &&
    value.length <= 32 &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
