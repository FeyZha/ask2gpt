// This intentionally duplicates a few tiny relay-policy helpers. Keeping the
// content-script dependency graph separate prevents Rollup from emitting an
// ESM shared chunk, which Chrome manifest content scripts cannot import.
export const MAX_CONTENT_PROMPT_CHARS = 100_000;
export const MAX_CONTENT_MARKDOWN_BYTES = 2 * 1024 * 1024 - 64 * 1024;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STABLE_PROJECT_ID = /^g-p-[0-9a-f]{32}$/iu;

export interface ContentProjectRoute {
  projectUrl: string;
  scope: string;
}

const GENERIC_PROJECT_TITLES = new Set([
  "chatgpt",
  "chatgpt project",
  "project",
  "项目",
  "项目 - chatgpt",
]);
const GENERIC_CONVERSATION_TITLES = new Set([
  "chatgpt",
  "new chat",
  "new conversation",
  "temporary chat",
  "untitled",
  "ask anything",
  "新对话",
  "新聊天",
  "临时聊天",
  "未命名",
  "skip to content",
  "skip to main content",
  "jump to content",
  "jump to main content",
  "main content",
  "跳至内容",
  "跳到内容",
  "跳至主要内容",
  "跳到主要内容",
  "主要内容",
  "跳至內容",
  "跳到內容",
  "跳至主要內容",
  "跳到主要內容",
  "主要內容",
]);

export function isContentSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

export function contentUtf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function normalizeContentPromptText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\r\n?/g, "\n");
  if (normalized.length < 1 || normalized.length > MAX_CONTENT_PROMPT_CHARS) return undefined;
  return normalized;
}

export function normalizeContentRemoteUrl(value: unknown): string | undefined {
  const url = parseSafeContentChatGptUrl(value);
  if (!url) return undefined;
  const isRoot = url.pathname === "/" || url.pathname === "";
  const isConversation = /^\/c\/[^/]+\/?$/.test(url.pathname);
  const isProjectRoute = isConservativeContentProjectPath(url.pathname);
  if (!isRoot && !isConversation && !isProjectRoute) return undefined;
  url.pathname = canonicalContentPathname(url.pathname);
  return url.href;
}

export function parseContentProjectRootUrl(value: unknown): ContentProjectRoute | undefined {
  const url = parseSafeContentChatGptUrl(value);
  if (!url) return undefined;
  const segments = safeContentPathSegments(url.pathname);
  if (!segments || segments.length < 3 || segments.at(-1) !== "project") return undefined;
  return contentProjectRouteFromScopeSegments(url.origin, segments.slice(0, -1));
}

export function parseContentProjectPageUrl(value: unknown): ContentProjectRoute | undefined {
  const url = parseSafeContentChatGptUrl(value);
  if (!url) return undefined;
  const segments = safeContentPathSegments(url.pathname);
  if (!segments) return undefined;
  if (segments.length >= 3 && segments.at(-1) === "project") {
    return contentProjectRouteFromScopeSegments(url.origin, segments.slice(0, -1));
  }
  if (
    segments.length >= 4 &&
    segments.at(-2) === "c" &&
    isSafeContentPathSegment(segments.at(-1)!)
  ) {
    return contentProjectRouteFromScopeSegments(url.origin, segments.slice(0, -2));
  }
  return undefined;
}

/**
 * ChatGPT's Project root uses the stable `g-p-<hex>` scope, while a
 * conversation URL may append the visible Project slug. Keep this alias
 * narrow so a genuinely different Project is still rejected.
 */
export function contentProjectScopesMatch(left: unknown, right: unknown): boolean {
  const leftScope = canonicalContentProjectScope(left);
  const rightScope = canonicalContentProjectScope(right);
  return Boolean(leftScope && rightScope && leftScope === rightScope);
}

function contentProjectRouteFromScopeSegments(origin: string, scopeSegments: string[]) {
  // This mirrors the service-worker policy without sharing a runtime chunk:
  // only ChatGPT's /g/<project-scope>/... namespace can be bound.
  if (scopeSegments.length !== 2 || scopeSegments[0] !== "g") return undefined;
  const scopePath = `/${scopeSegments.join("/")}/`;
  return {
    projectUrl: `${origin}${scopePath}project`,
    scope: `${origin}${scopePath}`,
  };
}

export function normalizeContentProjectScopedUrl(
  value: unknown,
  binding: ContentProjectRoute,
): string | undefined {
  const route = parseContentProjectRootUrl(binding.projectUrl);
  if (!route || !contentProjectScopesMatch(route.scope, binding.scope)) return undefined;
  const url = parseSafeContentChatGptUrl(value);
  if (!url) return undefined;
  const observedRoute = parseContentProjectPageUrl(url.href);
  if (!observedRoute || !contentProjectScopesMatch(observedRoute.scope, route.scope)) {
    return undefined;
  }
  const segments = safeContentPathSegments(url.pathname);
  if (!segments) return undefined;
  if (segments.at(-1) === "project") return route.projectUrl;
  const conversationId = segments.at(-1);
  if (segments.at(-2) !== "c" || !conversationId || !isSafeContentPathSegment(conversationId)) {
    return undefined;
  }
  const scopePath = new URL(route.scope).pathname;
  return `${url.origin}${scopePath}c/${conversationId}`;
}

function canonicalContentProjectScope(value: unknown): string | undefined {
  const url = parseSafeContentChatGptUrl(value);
  if (!url) return undefined;
  const segments = safeContentPathSegments(url.pathname);
  if (!segments || segments.length !== 2 || segments[0] !== "g") return undefined;
  const segment = segments[1]!;
  const stableSegment = STABLE_PROJECT_ID.test(segment)
    ? segment
    : (segment.match(/^(g-p-[0-9a-f]{32})-[A-Za-z0-9][A-Za-z0-9._-]*$/iu)?.[1] ?? segment);
  return `${url.origin}/g/${stableSegment}/`;
}

export function chooseContentProjectDisplayName(
  candidates: readonly unknown[],
  pageTitle: unknown,
) {
  for (const candidate of candidates) {
    const name = normalizeContentProjectDisplayName(candidate);
    if (name) return name;
  }

  if (typeof pageTitle === "string") {
    const withoutProductSuffix = pageTitle
      .replace(/\s*[-|·]\s*chatgpt(?:\s*[-|·].*)?$/iu, "")
      .trim();
    const name = normalizeContentProjectDisplayName(withoutProductSuffix);
    if (name) return name;
  }

  // The URL scope, not this optional label, is the identity boundary.
  return "ChatGPT Project";
}

/**
 * Selects a display-only title already rendered by ChatGPT.
 *
 * Exact current-conversation links are preferred over the browser-tab title.
 * Conflicting link labels are rejected instead of guessing. The returned value
 * is never used to operate ChatGPT; it is only copied into local metadata.
 */
export function chooseContentConversationTitle(
  exactConversationLinkLabels: readonly unknown[],
  pageTitle: unknown,
  projectName?: unknown,
) {
  const excludedProjectName = normalizeContentConversationTitle(projectName);
  const linkTitles = new Set(
    exactConversationLinkLabels
      .map(normalizeContentConversationTitle)
      .filter((title): title is string => Boolean(title && title !== excludedProjectName)),
  );
  if (linkTitles.size === 1) return [...linkTitles][0];
  if (linkTitles.size > 1) return undefined;

  const title = normalizeContentPageConversationTitle(pageTitle, excludedProjectName);
  return title && title !== excludedProjectName ? title : undefined;
}

export function isContentRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasResponseStarted(input: {
  assistantCount: number;
  baselineAssistants: number;
  sawStop: boolean;
  submissionConfirmed: boolean;
  assistantIdentityChanged: boolean;
  assistantDomChanged: boolean;
  userTurnObserved: boolean;
  regeneration: boolean;
  markdown: string;
  baselineMarkdown: string;
}) {
  const observedCurrentAssistant =
    (input.assistantIdentityChanged || input.assistantDomChanged) &&
    (input.userTurnObserved || input.regeneration || input.sawStop);
  return (
    input.assistantCount > input.baselineAssistants ||
    (input.submissionConfirmed && observedCurrentAssistant) ||
    ((input.sawStop || input.submissionConfirmed) && input.markdown !== input.baselineMarkdown)
  );
}

/**
 * Attributes a DOM turn without relying on ChatGPT preserving the exact text
 * presentation of a rich prompt. The page bridge tags network progress with
 * the Relay run id, while the DOM still has to prove that both a new user turn
 * and its following assistant turn appeared after the dispatch baseline.
 */
export function lifecycleOwnsVisibleTurn(input: {
  assistantFollowsCurrentUser: boolean;
  assistantTurnObserved: boolean;
  networkResponseComplete: boolean;
  networkResponseStarted: boolean;
  runIntentAccepted: boolean;
  submissionConfirmed: boolean;
  userTurnObserved: boolean;
}) {
  return Boolean(
    input.runIntentAccepted &&
    input.submissionConfirmed &&
    (input.networkResponseStarted || input.networkResponseComplete) &&
    input.userTurnObserved &&
    input.assistantTurnObserved &&
    input.assistantFollowsCurrentUser,
  );
}

export function stopControlDecision(
  visibleControls: number,
  hasFinalMarkdown: boolean,
  hasFinalActions: boolean,
): "click" | "already-complete" | "unsafe" {
  if (visibleControls === 1) return "click";
  if (visibleControls === 0 && hasFinalMarkdown && hasFinalActions) {
    return "already-complete";
  }
  return "unsafe";
}

function parseSafeContentChatGptUrl(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "chatgpt.com" ||
      url.port ||
      url.username ||
      url.password ||
      !safeContentPathSegments(url.pathname)
    ) {
      return undefined;
    }
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return undefined;
  }
}

function isConservativeContentProjectPath(pathname: string) {
  const segments = safeContentPathSegments(pathname);
  if (!segments || segments.length < 3) return false;
  if (segments.at(-1) === "project") return true;
  return segments.length >= 4 && segments.at(-2) === "c";
}

function safeContentPathSegments(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  return segments.every(isSafeContentPathSegment) ? segments : undefined;
}

function isSafeContentPathSegment(segment: string) {
  if (segment.length < 1 || segment.length > 256 || segment.includes("\\")) return false;
  try {
    const decoded = decodeURIComponent(segment);
    return decoded !== "." && decoded !== ".." && !decoded.includes("/") && !decoded.includes("\\");
  } catch {
    return false;
  }
}

function normalizeContentProjectDisplayName(value: unknown) {
  if (typeof value !== "string") return undefined;
  const name = value.replace(/\s+/gu, " ").trim();
  if (
    name.length < 1 ||
    name.length > 120 ||
    /\p{Cc}/u.test(name) ||
    GENERIC_PROJECT_TITLES.has(name.toLocaleLowerCase())
  ) {
    return undefined;
  }
  return name;
}

function normalizeContentConversationTitle(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalizedWhitespace = value.replace(/\s+/gu, " ");
  if (/[\p{Cc}\p{Cf}]/u.test(normalizedWhitespace)) {
    return undefined;
  }
  const title = normalizedWhitespace.replace(/\s*[-|·]\s*chatgpt(?:\s*[-|·].*)?$/iu, "").trim();
  if (
    title.length < 1 ||
    title.length > 80 ||
    GENERIC_CONVERSATION_TITLES.has(title.toLocaleLowerCase())
  ) {
    return undefined;
  }
  return title;
}

function normalizeContentPageConversationTitle(
  pageTitle: unknown,
  projectName: string | undefined,
) {
  const title = normalizeContentConversationTitle(pageTitle);
  if (!title || !projectName) return title;
  if (!title.toLocaleLowerCase().startsWith(projectName.toLocaleLowerCase())) return title;

  const remainder = title.slice(projectName.length);
  const match = /^\s*[-|·]\s*(.+)$/u.exec(remainder);
  return match ? normalizeContentConversationTitle(match[1]) : title;
}

function canonicalContentPathname(pathname: string) {
  if (pathname === "" || pathname === "/") return "/";
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}
