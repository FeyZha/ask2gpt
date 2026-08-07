import { composerTextMatchesPrompt, setComposerText } from "./composer-input";
import { serializeAssistant } from "./markdown";
import {
  PROMPT_INLINE_PRESENTATION_VERSION,
  renderedTextMatchesPrompt,
  singleBlockPromptPresentation,
} from "./prompt-presentation";
import type {
  ChatFileAttachment,
  ChatModelMode,
  ChatModelOption,
  ChatReasoningEffort,
} from "@ask2gpt/protocol";
import {
  contentPreDispatchPageMatches,
  isContentConversationRemoteUrl,
} from "./content-generation-policy";
import {
  type ContentProjectRoute,
  MAX_CONTENT_MARKDOWN_BYTES,
  chooseContentConversationTitle,
  contentProjectScopesMatch,
  contentUtf8ByteLength,
  hasResponseStarted,
  isContentRecord,
  isContentSafeId,
  lifecycleOwnsVisibleTurn,
  normalizeContentPromptText,
  normalizeContentRemoteUrl,
  parseContentProjectPageUrl,
  parseContentProjectRootUrl,
  stopControlDecision,
} from "./content-policy";
import {
  RESPONSE_COMPLETE_DOM_GRACE_MS,
  responseStartWatchdogDecision,
  networkResponseFailureDecision,
} from "./response-start-policy";
import {
  buildChatGptComposerOptions,
  normalizeVisibleModelText,
  type AccountModelCandidate,
} from "./model-picker";

// Keep this policy local to the classic content-script entry. Importing the
// service-worker copy would make Vite emit a shared ES module chunk, which a
// manifest content script cannot load.
const transientAssistantStatuses = new Set([
  "正在思考",
  "思考中",
  "正在生成",
  "生成中",
  "正在回答",
  "正在处理",
  "thinking",
  "working",
  "generating",
  "responding",
  "processing",
]);

function isTransientAssistantStatus(markdown: string) {
  const normalized = markdown
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .trim()
    .replace(/^[*_~`#>\s]+|[*_~`\s]+$/gu, "")
    .replace(/[.。!！…]+$/gu, "")
    .trim()
    .toLocaleLowerCase("en-US");
  return transientAssistantStatuses.has(normalized);
}

function usableAssistantMarkdown(markdown: string) {
  const trimmed = markdown.trim();
  return trimmed && !isTransientAssistantStatus(trimmed) ? trimmed : "";
}

type ContentCommandType =
  "content.send" | "content.stop" | "content.regenerate" | "content.recover";

interface ContentCommand {
  type: ContentCommandType;
  conversationId: string;
  runId: string;
  prompt?: string;
  startedAt?: string;
  expectedPromptSha256?: string;
  expectedPromptInlinePresentationVersion?: 1;
  expectedPromptInlinePresentationSha256?: string;
  allowPromptInlinePresentationMatch?: boolean;
  expectedRemoteUrl?: string;
  expectedProjectScope?: string;
  allowFirstConversation?: boolean;
  modelId?: string;
  modelLabel?: string;
  reasoningEffort?: ChatReasoningEffort;
  attachments?: ChatFileAttachment[];
}

interface Run {
  conversationId: string;
  runId: string;
  mode: "send" | "regenerate";
  observer?: MutationObserver;
  timer?: number;
  inspectTimer?: number;
  softTimer?: number;
  hardTimer?: number;
  responseStartTimer?: number;
  lastRecoveryRequestedAt?: number;
  lastMarkdown: string;
  lastObservedMarkdown: string;
  lastChangedAt: number;
  sawStop: boolean;
  sawResponseActions: boolean;
  baselineAssistants: number;
  baselineUsers: number;
  baselineMarkdown: string;
  baselineAssistantElement?: HTMLElement;
  baselineUserElement?: HTMLElement;
  baselineAssistantIdentity?: string;
  baselineUserIdentity?: string;
  baselineUserText: string;
  baselineRemoteUrl?: string;
  expectedPrompt?: string;
  submittedPromptPresentationSha256?: string;
  expectedAttachmentFileNames: string[];
  runIntentAccepted: boolean;
  networkSubmitted: boolean;
  networkResponseStarted: boolean;
  networkResponseComplete: boolean;
  networkResponseCompleteAt?: number;
  regenerationAssistantTransitioned: boolean;
  networkResponseError?: RunNetworkFailure;
  submissionConfirmed: boolean;
  submissionConfirmedAt?: number;
  adoptedGeneration: boolean;
  assistantDomChanged: boolean;
  userDomChanged: boolean;
  ownedAssistantElement?: HTMLElement;
  ownedUserElement?: HTMLElement;
  lastOwnedAssistantMutationAt: number;
  lastBusyAt: number;
  responseAttributedAt?: number;
  userTurnObservedAt?: number;
  consecutiveAttributionIdleSamples: number;
  consecutiveIdleSamples: number;
  inspecting: boolean;
  inspectQueued: boolean;
  urgentInspectQueued: boolean;
  urgentInspectPromise?: Promise<void>;
  urgentInspectResolve?: () => void;
  lastInspectedAt: number;
}

interface RunNetworkFailure {
  kind: "http" | "network" | "stream" | "unknown";
  httpStatus?: number;
}

type PageErrorCode =
  | "CHATGPT_LOGIN_REQUIRED"
  | "CHATGPT_CHALLENGE_REQUIRED"
  | "CHATGPT_REMOTE_UNAVAILABLE"
  | "CHATGPT_PROJECT_REQUIRED"
  | "CHATGPT_PROJECT_MISMATCH"
  | "CHATGPT_COMPOSER_MISSING"
  | "CHATGPT_ATTACHMENT_FAILED"
  | "CHATGPT_SEND_FAILED"
  | "CHATGPT_MODEL_UNAVAILABLE"
  | "CHATGPT_MODEL_SELECTION_FAILED"
  | "REGENERATE_CONTROL_UNAVAILABLE"
  | "RESPONSE_TIMEOUT"
  | "FRAME_TOO_LARGE"
  | "SELECTOR_INCOMPATIBLE";

// Keep the page-side runtime identity paired with CONTENT_RUNTIME_REVISION in
// content-runtime-policy.ts. This entrypoint must remain self-contained.
export const SELECTOR_VERSION = 50;
const REQUIRED_PROJECT_NAME = "Ask2GPT";
const MODEL_CATALOG_FETCH_TIMEOUT_MS = 12_000;
const selectors = {
  composer: [
    "#prompt-textarea",
    'textarea[name="prompt-textarea"]',
    '[contenteditable="true"][role="textbox"]',
    'textarea[placeholder*="Message"]',
    'textarea[placeholder*="消息"]',
  ],
  send: [
    '[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label="发送提示"]',
    'button[aria-label="发送消息"]',
  ],
  attachmentButtons: [
    'button[data-testid*="attach" i]',
    'button[aria-label*="attach" i]',
    'button[aria-label*="upload" i]',
    'button[aria-label*="file" i]',
  ],
  stop: [
    '[data-testid="stop-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="停止生成"]',
  ],
  assistants: '[data-message-author-role="assistant"]',
  users: '[data-message-author-role="user"]',
  modelTriggers: [
    'button[data-testid="model-switcher-dropdown-button"]',
    'button[data-testid*="model" i]',
    '[role="button"][data-testid*="model" i]',
    'button[aria-haspopup="menu"][aria-label*="model" i]',
    'button[aria-haspopup="listbox"][aria-label*="model" i]',
    'button[aria-haspopup="menu"][aria-label*="模型"]',
    'button[aria-haspopup="listbox"][aria-label*="模型"]',
    'button[aria-haspopup="menu"]',
    'button[aria-haspopup="listbox"]',
    '[role="button"][aria-haspopup="menu"]',
    '[role="button"][aria-haspopup="listbox"]',
  ],
  modelMenus: ['[role="menu"]', '[role="listbox"]'],
  modelOptions: ['[role="menuitemradio"]', '[role="option"]', '[role="menuitem"]'],
  regenerateLabels: ["Regenerate", "Regenerate response", "Try again", "重新生成", "重试"],
} as const;
const structuredComposerSelectors = [
  '.ProseMirror[contenteditable="true"]',
  '.ProseMirror[contenteditable="plaintext-only"]',
  '[contenteditable="true"][aria-multiline="true"]',
  '[contenteditable="plaintext-only"][aria-multiline="true"]',
  "textarea",
] as const;
const provisionalFormComposerSelectors = [
  "#prompt-textarea",
  'textarea[name="prompt-textarea"]',
  'textarea[placeholder*="Message"]',
  'textarea[placeholder*="消息"]',
  '[contenteditable][aria-label*="Message"]',
  '[contenteditable][aria-label*="消息"]',
  '[contenteditable][aria-placeholder*="Message"]',
  '[contenteditable][aria-placeholder*="消息"]',
] as const;
const SOFT_RUN_TIMEOUT_MS = 10 * 60 * 1000;
const HARD_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const SNAPSHOT_INSPECT_INTERVAL_MS = 60;
const COMPOSER_COMMIT_FRAME_FALLBACK_MS = 25;
const COMPOSER_STABILITY_SAMPLE_MS = 20;
const COMPOSER_STABILITY_SAMPLES = 3;
const COMPOSER_WRITE_ATTEMPTS = 4;
const TOTAL_SUBMISSION_CONFIRMATION_MS = 10_000;
const UNTOUCHED_DRAFT_CONFIRMATION_MS = 1_500;
const RESPONSE_START_WATCHDOG_MS = 30_000;
const COMPLETE_ACTION_STABILITY_MS = 400;
// Visible completion controls are not guaranteed in ChatGPT's compact/fast
// paths. A control-free completion therefore needs a verified current turn
// plus a substantially longer quiet window; assistant mutations and busy
// signals below keep pushing this window forward while output is still live.
const ATTRIBUTED_IDLE_COMPLETE_STABILITY_MS = 2_500;
// Chrome can keep an owned Relay tab hidden after dispatch. In that state
// ChatGPT may defer its response actions, and the page bridge may have no
// lifecycle event when the current transport was not intercepted. A response
// already acknowledged by the worker may still settle from DOM evidence, but
// only after a conservative text-stability window. Apply the same window when
// no lifecycle event was observed and when a cloned response started but never
// reached EOF: absence of lifecycle evidence must not make completion easier.
const HIDDEN_ATTRIBUTED_IDLE_RECOVERY_MS = 30_000;
const ASSISTANT_BUSY_SELECTOR = [
  '[aria-busy="true"]',
  '[data-is-streaming="true"]',
  '[data-streaming="true"]',
  '[data-testid*="streaming" i]',
  ".result-streaming",
  '[class*="streaming-animation"]',
].join(", ");
const CURRENT_TURN_GENERATION_ERROR_SELECTOR = [
  '[role="alert"]',
  '[data-testid*="error" i]',
  '[data-testid*="retry" i]',
].join(", ");
const MAX_HISTORY_MESSAGES = 200;
const MAX_HISTORY_MESSAGE_CHARS = 200_000;
const MAX_HISTORY_MARKDOWN_BYTES = MAX_CONTENT_MARKDOWN_BYTES - 64 * 1024;
// Keep these literals aligned with packages/protocol. Content scripts are
// emitted as classic scripts and cannot import the shared runtime chunk.
const MAX_CHAT_FILE_ATTACHMENTS = 8;
const MAX_CHAT_FILE_CHARS = 40_000;
const MAX_CHAT_FILE_BUNDLE_CHARS = 60_000;
const PROJECT_BINDING_ATTRIBUTE = "data-ask2gpt-project-binding";
const PROJECT_DIRECTORY_REFRESH_REQUEST_ATTRIBUTE =
  "data-ask2gpt-project-directory-refresh-request";
const PROJECT_DIRECTORY_REFRESH_RESULT_ATTRIBUTE = "data-ask2gpt-project-directory-refresh-result";
const PROJECT_DIRECTORY_REFRESH_REQUEST_EVENT = "ask2gpt:project-directory-refresh-request";
const PROJECT_DIRECTORY_REFRESH_RESULT_EVENT = "ask2gpt:project-directory-refresh-result";
// Do not block an inspect command on the network. The MAIN-world bridge may
// keep refreshing for up to three seconds; the Service Worker retries the
// bounded inspection and will pick up the resulting attribute on a later pass.
const PROJECT_DIRECTORY_REFRESH_WAIT_MS = 500;
const PROJECT_EVIDENCE_VERSION = 2;
const PROJECT_PASSIVE_EVIDENCE_TTL_MS = 30_000;
const PROJECT_CREATE_UI_TIMEOUT_MS = 12_000;
const PROJECT_CREATE_RESULT_TIMEOUT_MS = 18_000;
const RUN_INTENT_ATTRIBUTE = "data-ask2gpt-run-intent";
const RUN_READY_ATTRIBUTE = "data-ask2gpt-run-ready";
const RUN_INTENT_EVENT = "ask2gpt:run-intent";
const RUN_LIFECYCLE_ATTRIBUTE = "data-ask2gpt-run-lifecycle";
const RUN_LIFECYCLE_EVENT = "ask2gpt:run-lifecycle";
const RUN_RESPONSE_ATTRIBUTE = "data-ask2gpt-run-response";
const RUN_RESPONSE_EVENT = "ask2gpt:run-response";
const MAIN_WORLD_SEND_ATTRIBUTE = "data-ask2gpt-main-world-send";
const MAIN_WORLD_COMPOSER_ATTRIBUTE = "data-ask2gpt-main-world-composer";
const MAIN_WORLD_SCOPE_ATTRIBUTE = "data-ask2gpt-main-world-scope";
const RUN_LIFECYCLE_PHASES = [
  "submitted",
  "response-started",
  "response-complete",
  "response-error",
] as const;
const RUN_LIFECYCLE_FAILURE_KINDS = ["http", "network", "stream"] as const;

let activeRun: Run | undefined;
let pageResponseRelay: Promise<void> = Promise.resolve();

document.addEventListener(RUN_LIFECYCLE_EVENT, receivePageRunLifecycle, true);
document.addEventListener(RUN_RESPONSE_EVENT, receivePageRunResponse, true);

chrome.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse: (response: Record<string, unknown>) => void) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (isContentPingCommand(message)) {
      sendResponse({ ok: true, pageUrl: location.href, selectorVersion: SELECTOR_VERSION });
      return false;
    }
    if (isComposerStatusCommand(message)) {
      const rawCandidates = findRawComposerElements();
      const rawCandidateCount = rawCandidates.length;
      const readyCandidateCount = findComposerElements(true).length;
      const primaryComposer = rawCandidates.find((candidate) => candidate.id === "prompt-textarea");
      sendResponse({
        ok: true,
        ready: readyCandidateCount === 1,
        rawCandidateCount,
        readyCandidateCount,
        primaryOwnership: primaryComposer
          ? composerOwnership(primaryComposer) !== undefined
          : false,
        primaryVisible: primaryComposer ? isVisible(primaryComposer) : false,
        primaryVisibilityBlocker: primaryComposer
          ? (visibilityBlocker(primaryComposer) ?? "none")
          : "missing",
        primaryWritable: primaryComposer ? isWritableComposer(primaryComposer) : false,
        viewportHeight: Math.max(0, Math.min(20_000, Math.round(window.innerHeight))),
        viewportWidth: Math.max(0, Math.min(20_000, Math.round(window.innerWidth))),
        visibilityState: document.visibilityState === "visible" ? "visible" : "hidden",
        selectorVersion: SELECTOR_VERSION,
      });
      return false;
    }
    if (isInspectConversationSnapshotCommand(message)) {
      void Promise.resolve()
        .then(inspectConversationSnapshot)
        .then((snapshot) =>
          sendResponse({ ok: true, ...snapshot, selectorVersion: SELECTOR_VERSION }),
        )
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (isInspectProjectCommand(message)) {
      void Promise.resolve()
        .then(() => inspectVisibleProject(false))
        .then((project) => sendResponse({ ok: true, ...project }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: contentOperationError(error, "CHATGPT_PROJECT_REQUIRED"),
          }),
        );
      return true;
    }
    if (isListProjectsCommand(message)) {
      void Promise.resolve()
        .then(listVisibleProjects)
        .then((projects) =>
          sendResponse({
            ok: true,
            projects,
            selectorVersion: SELECTOR_VERSION,
            projectEvidenceVersion: PROJECT_EVIDENCE_VERSION,
          }),
        )
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: contentOperationError(error, "CHATGPT_PROJECT_REQUIRED"),
          }),
        );
      return true;
    }
    if (isCreateProjectCommand(message)) {
      void Promise.resolve()
        .then(createDefaultProject)
        .then((project) => sendResponse({ ok: true, ...project }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: contentOperationError(error, "CHATGPT_PROJECT_REQUIRED"),
          }),
        );
      return true;
    }
    if (isDiscoverProjectCommand(message)) {
      void Promise.resolve()
        .then(() => inspectVisibleProject(true))
        .then((project) => sendResponse({ ok: true, ...project }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: contentOperationError(error, "CHATGPT_PROJECT_REQUIRED"),
          }),
        );
      return true;
    }
    if (isOpenProjectHomeCommand(message)) {
      void Promise.resolve()
        .then(openVisibleAsk2GPTProjectHome)
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: contentOperationError(error, "CHATGPT_PROJECT_REQUIRED"),
          }),
        );
      return true;
    }
    if (isModelListCommand(message)) {
      void listAvailableModels()
        .then((catalog) => sendResponse({ ok: true, ...catalog }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: contentOperationError(error, "CHATGPT_MODEL_UNAVAILABLE"),
          }),
        );
      return true;
    }
    if (isModelSelectCommand(message)) {
      void selectAvailableModel(message.option)
        .then((selected) => sendResponse({ ok: true, selected }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: contentOperationError(error, "CHATGPT_MODEL_SELECTION_FAILED"),
          }),
        );
      return true;
    }
    if (isTerminalAcknowledgementCommand(message)) {
      stopRunIfMatching(message);
      sendResponse({ ok: true, selectorVersion: SELECTOR_VERSION });
      return false;
    }
    if (!isContentCommand(message)) return false;
    void handleCommand(message)
      .then((response) => sendResponse({ ok: true, ...response }))
      .catch(async (error: unknown) => {
        if (isAmbiguousSubmissionError(error)) {
          // The one permitted send actuation may already have reached ChatGPT. Keep the
          // page observer alive and tell the worker only that the response
          // channel is ambiguous; the worker switches to read-only recovery.
          sendResponse({
            ok: false,
            ambiguousSubmission: true,
            selectorVersion: SELECTOR_VERSION,
          });
          return;
        }
        stopRunIfMatching(message);
        const operationError = contentOperationError(error, "SELECTOR_INCOMPATIBLE");
        await emitError(message, operationError.code, operationError.message).catch(
          () => undefined,
        );
        // The page transaction proved that the single permitted click did not
        // submit. Return the same bounded failure on the direct response
        // channel as well: the worker must not leave a definitively rejected
        // command parked forever merely because the separate error event was
        // lost while the service worker was waking up.
        sendResponse({
          ok: false,
          definitiveFailure: true,
          error: operationError,
          selectorVersion: SELECTOR_VERSION,
        });
      });
    return true;
  },
);

async function inspectVisibleProject(allowDirectoryRefresh: boolean) {
  const currentRoute = parseContentProjectPageUrl(location.href);
  const currentRootRoute = parseContentProjectRootUrl(location.href);
  const visibleProjects: Array<{ route: ContentProjectRoute; name: string }> = [];
  const exactNamedRoutes = new Map<string, ContentProjectRoute>();
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (!isVisible(anchor)) continue;
    if (!verifiedProjectSidebarItem(anchor)) continue;
    const anchorRoute = parseContentProjectRootUrl(anchor.href);
    if (!anchorRoute) continue;
    const labels = [
      anchor.textContent?.trim() ?? "",
      anchor.getAttribute("aria-label") ?? "",
      anchor.getAttribute("title") ?? "",
    ];
    const visibleName = visibleProjectName(labels);
    if (visibleName) visibleProjects.push({ route: anchorRoute, name: visibleName });
    if (labels.some((label) => projectLabelMatchesName(label, REQUIRED_PROJECT_NAME))) {
      exactNamedRoutes.set(anchorRoute.scope, anchorRoute);
    }
  }

  const visibleCurrentProject = currentRoute
    ? visibleProjects.find((candidate) =>
        contentProjectScopesMatch(candidate.route.scope, currentRoute.scope),
      )
    : undefined;
  if (
    visibleCurrentProject &&
    !projectLabelMatchesName(visibleCurrentProject.name, REQUIRED_PROJECT_NAME)
  ) {
    throw pageError("CHATGPT_PROJECT_MISMATCH", "当前标签页属于另一个 ChatGPT Project，未绑定。");
  }

  let bridgedProject = readBridgedProjectBinding(REQUIRED_PROJECT_NAME);
  const exactNamedRoute = currentRoute
    ? [...exactNamedRoutes.values()].find((route) =>
        contentProjectScopesMatch(route.scope, currentRoute.scope),
      )
    : undefined;
  let discoveredRoute = currentRoute
    ? (exactNamedRoute ??
      (bridgedProject && contentProjectScopesMatch(bridgedProject.scope, currentRoute.scope)
        ? bridgedProject
        : undefined))
    : (uniqueProjectRoute(exactNamedRoutes) ?? bridgedProject);
  if (!discoveredRoute && allowDirectoryRefresh) {
    const refreshedProject = await requestProjectDirectoryRefresh();
    bridgedProject = refreshedProject ?? readBridgedProjectBinding(REQUIRED_PROJECT_NAME);
    const refreshedExactNamedRoute = currentRoute
      ? [...exactNamedRoutes.values()].find((route) =>
          contentProjectScopesMatch(route.scope, currentRoute.scope),
        )
      : undefined;
    discoveredRoute = currentRoute
      ? (refreshedExactNamedRoute ??
        (bridgedProject && contentProjectScopesMatch(bridgedProject.scope, currentRoute.scope)
          ? bridgedProject
          : undefined))
      : (uniqueProjectRoute(exactNamedRoutes) ?? bridgedProject);
  }
  if (
    !discoveredRoute &&
    currentRootRoute &&
    projectTitleMatchesName(document.title, REQUIRED_PROJECT_NAME) &&
    uniqueProjectControlAction(projectSidebarControlRows())
  ) {
    discoveredRoute = currentRootRoute;
  }
  if (!discoveredRoute) {
    throw pageError(
      "CHATGPT_PROJECT_REQUIRED",
      projectDiscoveryMessage(visibleProjects, currentRoute),
    );
  }

  return {
    projectUrl: discoveredRoute.projectUrl,
    scope: discoveredRoute.scope,
    // The route and exact name must come from one verified sidebar item or one
    // bridge record. A title can only corroborate a strict Project root that
    // also renders the unique sidebar Project controls.
    name: REQUIRED_PROJECT_NAME,
    selectorVersion: SELECTOR_VERSION,
    projectEvidenceVersion: PROJECT_EVIDENCE_VERSION,
  };
}

interface VisibleProjectCandidate {
  projectUrl: string;
  scope: string;
  name: string;
}

function listVisibleProjects(): VisibleProjectCandidate[] {
  const currentRootRoute = parseContentProjectRootUrl(location.href);
  const visibleProjects: VisibleProjectCandidate[] = [];
  const seenScopes = new Set<string>();

  for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (!isVisible(anchor)) continue;
    if (!verifiedProjectSidebarItem(anchor)) continue;
    const route = parseContentProjectRootUrl(anchor.href);
    if (!route || seenScopes.has(route.scope)) continue;
    const name = visibleProjectName([
      anchor.textContent?.trim() ?? "",
      anchor.getAttribute("aria-label") ?? "",
      anchor.getAttribute("title") ?? "",
    ]);
    if (!name) continue;
    seenScopes.add(route.scope);
    visibleProjects.push({ ...route, name });
  }

  if (currentRootRoute && !seenScopes.has(currentRootRoute.scope)) {
    const name = projectNameFromPageTitle(document.title);
    if (name) visibleProjects.push({ ...currentRootRoute, name });
  }

  return visibleProjects.sort((left, right) => left.name.localeCompare(right.name));
}

async function createDefaultProject() {
  const initialUrl = location.href;
  const existingDefaultProjectRows = new Set(projectRowsForName(REQUIRED_PROJECT_NAME));
  const existingScopes = new Set(
    listVisibleProjects()
      .filter((project) => isRequiredProjectName(project.name))
      .map((project) => project.scope),
  );
  const existingCurrentRoute = parseContentProjectRootUrl(initialUrl);
  const existingCurrentName = projectNameFromPageTitle(document.title);
  if (existingCurrentRoute && existingCurrentName && isRequiredProjectName(existingCurrentName)) {
    return {
      ...existingCurrentRoute,
      name: REQUIRED_PROJECT_NAME,
      created: false,
      selectorVersion: SELECTOR_VERSION,
      projectEvidenceVersion: PROJECT_EVIDENCE_VERSION,
    };
  }

  // ChatGPT hides this trailing action with opacity: 0 on pointer devices
  // until the “项目” section header is hovered. It remains an enabled,
  // on-screen button with pointer-events enabled, so a strict visible-only
  // check incorrectly reports that the action does not exist.
  const newProjectButton = uniqueInteractiveProjectControl(
    document,
    new Set(["新项目", "New project", "New Project"]),
  );
  if (!newProjectButton) {
    throw pageError(
      "CHATGPT_PROJECT_REQUIRED",
      "没有找到可用的 ChatGPT“新项目”按钮，请确认侧边栏中的“项目”区域已展开后重试。",
    );
  }
  newProjectButton.click();

  const dialog = await waitForProjectUi(
    findProjectCreationDialog,
    PROJECT_CREATE_UI_TIMEOUT_MS,
    "ChatGPT 的 Project 创建窗口没有打开。",
  );
  const nameInput = findProjectNameInput(dialog);
  if (!nameInput) {
    throw pageError("CHATGPT_PROJECT_REQUIRED", "没有找到 Project 名称输入框。");
  }
  setProjectNameInput(nameInput, REQUIRED_PROJECT_NAME);

  const createButton = await waitForProjectUi(
    () => {
      const button = uniqueVisibleProjectControl(
        dialog,
        new Set(["创建项目", "Create project", "Create Project"]),
      );
      return button && projectControlIsEnabled(button) ? button : undefined;
    },
    PROJECT_CREATE_UI_TIMEOUT_MS,
    "Project 名称输入后，创建按钮没有变为可用。",
  );
  createButton.click();

  let openedCreatedProjectHome = false;
  const project = await waitForProjectUi(
    () => {
      const currentProject = findCreatedDefaultProject(initialUrl, existingScopes);
      if (currentProject) return currentProject;
      if (!openedCreatedProjectHome) {
        const homeAction = uniqueCreatedProjectHomeAction(existingDefaultProjectRows);
        if (homeAction) {
          openedCreatedProjectHome = true;
          homeAction.click();
        }
      }
      return undefined;
    },
    PROJECT_CREATE_RESULT_TIMEOUT_MS,
    "ChatGPT 没有返回新建的 Ask2GPT Project。",
  );
  return {
    ...project,
    created: true,
    selectorVersion: SELECTOR_VERSION,
    projectEvidenceVersion: PROJECT_EVIDENCE_VERSION,
  };
}

function findCreatedDefaultProject(initialUrl: string, existingScopes: Set<string>) {
  const currentRoute = parseContentProjectRootUrl(location.href);
  const currentName = projectNameFromPageTitle(document.title);
  if (
    currentRoute &&
    currentRoute.projectUrl !== initialUrl &&
    !existingScopes.has(currentRoute.scope) &&
    currentName &&
    isRequiredProjectName(currentName)
  ) {
    return { ...currentRoute, name: REQUIRED_PROJECT_NAME };
  }

  const visibleProject = listVisibleProjects().find(
    (project) => isRequiredProjectName(project.name) && !existingScopes.has(project.scope),
  );
  if (visibleProject) return visibleProject;
  return undefined;
}

function isRequiredProjectName(name: string) {
  return normalizeProjectControlText(name) === REQUIRED_PROJECT_NAME;
}

function projectRowsForName(name: string) {
  const expectedName = new Set([name]);
  const expectedHomeLabels = new Set(["Open project home", "打开项目首页"]);
  return [...document.querySelectorAll<HTMLElement>('li, [role="listitem"]')].filter((row) => {
    if (!isVisible(row) || isProjectConversationContent(row)) return false;
    const controls = [...row.querySelectorAll<HTMLElement>('button, [role="button"]')].filter(
      isVisible,
    );
    const hasProjectName = controls.some(
      (control) => projectControlExactLabelSources(control, expectedName).size > 0,
    );
    const hasProjectHome = controls.some(
      (control) => projectControlExactLabelSources(control, expectedHomeLabels).size > 0,
    );
    if (!hasProjectName || !hasProjectHome) return false;
    return verifiedProjectSidebarItem(row) === row;
  });
}

function uniqueCreatedProjectHomeAction(existingRows: ReadonlySet<HTMLElement>) {
  const expectedHomeLabels = new Set(["Open project home", "打开项目首页"]);
  const actions = projectRowsForName(REQUIRED_PROJECT_NAME)
    .filter((row) => !existingRows.has(row))
    .flatMap((row) =>
      [...row.querySelectorAll<HTMLElement>('button, [role="button"]')].filter(
        (control) =>
          isVisible(control) &&
          projectControlExactLabelSources(control, expectedHomeLabels).size > 0,
      ),
    );
  return actions.length === 1 ? actions[0] : undefined;
}

function findProjectCreationDialog() {
  // ChatGPT currently uses a native <dialog> without an explicit role.
  // Keep the ARIA form for older/newer variants as well.
  const dialogs = [...document.querySelectorAll<HTMLElement>('dialog, [role="dialog"]')].filter(
    isVisible,
  );
  const matches = dialogs.filter((dialog) => findProjectNameInput(dialog) !== undefined);
  return matches.length === 1 ? matches[0] : undefined;
}

function findProjectNameInput(dialog: HTMLElement) {
  const expected = new Set(["项目名称", "Project name"]);
  const inputs = [
    ...dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"),
  ].filter(isVisible);
  const labelledInputs = inputs.filter((input) =>
    projectNameInputLabelTexts(input).some((label) => expected.has(label)),
  );
  if (labelledInputs.length === 1) return labelledInputs[0];

  // The current ChatGPT dialog renders “项目名称” as nearby field text and
  // uses a travel-example placeholder on the input. In that shape the label
  // is not exposed through aria-label, title, or the input's placeholder.
  // Keep the fallback bounded to a dialog that visibly contains the expected
  // field label and exactly one visible text field.
  if (inputs.length === 1 && projectDialogContainsLabel(dialog, expected)) return inputs[0];
  return undefined;
}

function projectNameInputLabelTexts(input: HTMLInputElement | HTMLTextAreaElement) {
  const labels = [
    input.getAttribute("aria-label"),
    input.getAttribute("title"),
    input.getAttribute("placeholder"),
    ...(input.labels
      ? [...input.labels].flatMap((label) => [label.innerText, label.textContent])
      : []),
  ];
  const labelledBy = input.getAttribute("aria-labelledby");
  if (labelledBy) {
    for (const id of [...new Set(labelledBy.trim().split(/\s+/u))].slice(0, 8)) {
      const label = document.getElementById(id);
      if (label instanceof HTMLElement && label.ownerDocument === document) {
        labels.push(label.innerText, label.textContent);
      }
    }
  }
  return labels
    .map(normalizeProjectControlText)
    .filter((label): label is string => label !== undefined);
}

function projectDialogContainsLabel(dialog: HTMLElement, expected: ReadonlySet<string>) {
  const text = (safeInnerText(dialog) ?? dialog.textContent ?? "").replace(/\s+/gu, " ").trim();
  return [...expected].some((label) => text.includes(label));
}

function setProjectNameInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function uniqueVisibleProjectControl(root: ParentNode, expected: ReadonlySet<string>) {
  const controls = [...root.querySelectorAll<HTMLElement>('button, [role="button"]')].filter(
    isVisible,
  );
  const matches = controls.filter(
    (control) => projectControlExactLabelSources(control, expected).size > 0,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function uniqueInteractiveProjectControl(root: ParentNode, expected: ReadonlySet<string>) {
  const controls = [...root.querySelectorAll<HTMLElement>('button, [role="button"]')].filter(
    (control) => isVisible(control) || isHoverHiddenProjectControl(control),
  );
  const matches = controls.filter(
    (control) => projectControlExactLabelSources(control, expected).size > 0,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function isHoverHiddenProjectControl(element: HTMLElement) {
  if (!(element instanceof HTMLButtonElement)) return false;
  if (element.disabled || element.getAttribute("aria-disabled") === "true") return false;

  const style = getComputedStyle(element);
  if (style.opacity !== "0" || style.pointerEvents === "none") return false;

  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (
      current.hidden ||
      current.hasAttribute("inert") ||
      current.getAttribute("aria-hidden") === "true"
    ) {
      return false;
    }
    const currentStyle = getComputedStyle(current);
    if (
      currentStyle.display === "none" ||
      currentStyle.visibility === "hidden" ||
      currentStyle.visibility === "collapse" ||
      (current !== element && currentStyle.opacity === "0")
    ) {
      return false;
    }
  }

  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.top < window.innerHeight
  );
}

function projectControlIsEnabled(control: HTMLElement) {
  return !(
    (control instanceof HTMLButtonElement && control.disabled) ||
    control.getAttribute("aria-disabled") === "true"
  );
}

async function waitForProjectUi<Result>(
  read: () => Result | undefined,
  timeoutMs: number,
  message: string,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = read();
    if (result !== undefined) return result;
    await delay(100);
  }
  throw pageError("CHATGPT_PROJECT_REQUIRED", message);
}

function projectNameFromPageTitle(title: string) {
  const normalized = title.replace(/\s+/gu, " ").trim();
  const match = normalized.match(/^(?:ChatGPT\s*[-|·]\s*(.+)|(.+?)\s*[-|·]\s*ChatGPT)$/iu);
  const name = match?.[1] ?? match?.[2];
  if (!name) return undefined;
  const cleaned = name.trim();
  if (
    cleaned.length < 1 ||
    cleaned.length > 120 ||
    /[\p{Cc}\p{Cf}]/u.test(cleaned) ||
    ["chatgpt", "project", "chatgpt project", "项目"].includes(cleaned.toLocaleLowerCase())
  ) {
    return undefined;
  }
  return cleaned;
}

function requestProjectDirectoryRefresh() {
  const root = document.documentElement;
  const requestId = createProjectDirectoryRefreshRequestId();
  return new Promise<ContentProjectRoute | undefined>((resolve) => {
    let settled = false;
    const finish = (route?: ContentProjectRoute) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      document.removeEventListener(PROJECT_DIRECTORY_REFRESH_RESULT_EVENT, receiveResult, true);
      resolve(route);
    };
    const receiveResult = () => {
      const rawResult = root.getAttribute(PROJECT_DIRECTORY_REFRESH_RESULT_ATTRIBUTE);
      if (!rawResult || rawResult.length > 256) return;
      try {
        const result: unknown = JSON.parse(rawResult);
        if (
          !isContentRecord(result) ||
          result.requestId !== requestId ||
          result.evidenceVersion !== PROJECT_EVIDENCE_VERSION
        ) {
          return;
        }
        root.removeAttribute(PROJECT_DIRECTORY_REFRESH_RESULT_ATTRIBUTE);
        const route =
          result.outcome === "matched" ? parseContentProjectRootUrl(result.projectUrl) : undefined;
        finish(route);
      } catch {
        // Ignore malformed page-owned wakeups and wait for the bounded timeout.
      }
    };
    const timeout = window.setTimeout(finish, PROJECT_DIRECTORY_REFRESH_WAIT_MS);
    document.addEventListener(PROJECT_DIRECTORY_REFRESH_RESULT_EVENT, receiveResult, true);
    root.setAttribute(PROJECT_DIRECTORY_REFRESH_REQUEST_ATTRIBUTE, requestId);
    document.dispatchEvent(new Event(PROJECT_DIRECTORY_REFRESH_REQUEST_EVENT));
  });
}

function createProjectDirectoryRefreshRequestId() {
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `project-${random[0]?.toString(36)}-${random[1]?.toString(36)}`;
}

function openVisibleAsk2GPTProjectHome() {
  const rows = projectSidebarControlRows();
  const action = uniqueProjectControlAction(rows);
  if (!action) {
    throw pageError("CHATGPT_PROJECT_REQUIRED", projectControlDiscoveryDiagnostics(rows));
  }
  action.click();
}

type ProjectControlLabelSource =
  "ariaLabel" | "title" | "innerText" | "textContent" | "ariaLabelledBy";

interface ProjectControlButtonEvidence {
  button: HTMLElement;
  mainSources: ReadonlySet<ProjectControlLabelSource>;
  homeSources: ReadonlySet<ProjectControlLabelSource>;
}

interface ProjectControlRowEvidence {
  buttons: ProjectControlButtonEvidence[];
  mainButtons: ProjectControlButtonEvidence[];
  homeActions: ProjectControlButtonEvidence[];
  combined: boolean;
}

function projectSidebarControlRows() {
  const mainLabels = new Set([REQUIRED_PROJECT_NAME]);
  const projectHomeLabels = new Set(["Open project home", "打开项目首页"]);
  const rows: ProjectControlRowEvidence[] = [];
  for (const row of document.querySelectorAll<HTMLElement>('li, [role="listitem"]')) {
    if (!isVisible(row) || isProjectConversationContent(row)) continue;
    const buttons = [...row.querySelectorAll<HTMLElement>('button, [role="button"]')].filter(
      isVisible,
    );
    const evidence = buttons.map((button) => ({
      button,
      mainSources: projectControlExactLabelSources(button, mainLabels),
      homeSources: projectControlExactLabelSources(button, projectHomeLabels),
    }));
    const mainButtons = evidence.filter((candidate) => candidate.mainSources.size > 0);
    const homeActions = evidence.filter((candidate) => candidate.homeSources.size > 0);
    const combined =
      mainButtons.length === 1 &&
      homeActions.length === 1 &&
      mainButtons[0]?.button !== homeActions[0]?.button;
    // Current ChatGPT builds do not always expose a nav/aside landmark around
    // the Project list. A visible listitem carrying both exact, distinct
    // Project controls is itself sufficient sidebar evidence, but only outside
    // main/conversation content. Links still require an explicit landmark.
    if (verifiedProjectSidebarItem(row) !== row && !combined) continue;
    rows.push({ buttons: evidence, mainButtons, homeActions, combined });
  }
  return rows;
}

function uniqueProjectControlAction(rows: readonly ProjectControlRowEvidence[]) {
  const actions = new Set(
    rows.flatMap((row) => (row.combined && row.homeActions[0] ? [row.homeActions[0].button] : [])),
  );
  return actions.size === 1 ? [...actions][0] : undefined;
}

function verifiedProjectSidebarItem(element: Element) {
  const item = element.matches('li, [role="listitem"]')
    ? element
    : element.closest('li, [role="listitem"]');
  if (!(item instanceof HTMLElement) || !isVisible(item)) return undefined;
  if (isProjectConversationContent(item)) return undefined;
  const navigation = item.closest(
    'nav, [role="navigation"], aside, [data-testid*="sidebar" i], [aria-label="Chat history"], [aria-label="历史聊天记录"]',
  );
  if (navigation instanceof HTMLElement && isVisible(navigation)) return item;
  for (let ancestor = item.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (isVisible(ancestor) && projectHistoryLandmarkLabel(ancestor)) return item;
  }
  return undefined;
}

function isProjectConversationContent(element: Element) {
  return Boolean(
    element.closest(
      'main, [role="main"], [data-message-author-role], [data-testid*="conversation-turn" i]',
    ),
  );
}

function projectHistoryLandmarkLabel(element: HTMLElement) {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (!labelledBy || labelledBy.length > 512 || /[\p{Cc}\p{Cf}]/u.test(labelledBy)) return false;
  const ids = [...new Set(labelledBy.trim().split(/\s+/u))].slice(0, 8);
  const expected = new Set(["Chat history", "历史聊天记录"]);
  return ids.some((id) => {
    if (id.length < 1 || id.length > 128) return false;
    const label = document.getElementById(id);
    if (!(label instanceof HTMLElement) || label.ownerDocument !== document) return false;
    return [safeInnerText(label), label.textContent]
      .map(normalizeProjectControlText)
      .some((value) => value !== undefined && expected.has(value));
  });
}

function projectTitleMatchesName(title: string, requiredName: string) {
  const normalized = title.replace(/\s+/gu, " ").trim();
  return normalized === `ChatGPT - ${requiredName}` || normalized === `${requiredName} - ChatGPT`;
}

function normalizeProjectControlText(value: string | null | undefined) {
  if (value === null || value === undefined) return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 0 && normalized.length <= 120 && !/[\p{Cc}\p{Cf}]/u.test(normalized)
    ? normalized
    : undefined;
}

function projectControlExactLabelSources(button: HTMLElement, expected: ReadonlySet<string>) {
  const matches = new Set<ProjectControlLabelSource>();
  for (const [label, sources] of projectControlLabels(button)) {
    if (!expected.has(label)) continue;
    for (const source of sources) matches.add(source);
  }
  return matches;
}

function projectControlLabels(button: HTMLElement) {
  const labels = new Map<string, Set<ProjectControlLabelSource>>();
  const add = (source: ProjectControlLabelSource, value: string | null | undefined) => {
    const normalized = normalizeProjectControlText(value);
    if (!normalized) return;
    const sources = labels.get(normalized) ?? new Set<ProjectControlLabelSource>();
    sources.add(source);
    labels.set(normalized, sources);
  };
  add("ariaLabel", button.getAttribute("aria-label"));
  add("title", button.getAttribute("title"));
  add("innerText", safeInnerText(button));
  add("textContent", button.textContent);

  const labelledBy = button.getAttribute("aria-labelledby");
  if (labelledBy && labelledBy.length <= 512 && !/[\p{Cc}\p{Cf}]/u.test(labelledBy)) {
    const ids = [...new Set(labelledBy.trim().split(/\s+/u))].slice(0, 8);
    for (const id of ids) {
      if (id.length < 1 || id.length > 128) continue;
      const label = document.getElementById(id);
      if (!label || label.ownerDocument !== document) continue;
      add("ariaLabelledBy", safeInnerText(label));
      add("ariaLabelledBy", label.textContent);
    }
  }
  return labels;
}

function safeInnerText(element: HTMLElement) {
  try {
    return typeof element.innerText === "string" ? element.innerText : undefined;
  } catch {
    return undefined;
  }
}

function projectControlDiscoveryDiagnostics(rows: readonly ProjectControlRowEvidence[]) {
  const exactNameRows = rows.filter((row) => row.mainButtons.length > 0);
  const homeActionRows = rows.filter((row) => row.homeActions.length > 0);
  const combinedRows = rows.filter((row) => row.combined);
  const target =
    (combinedRows.length === 1 ? combinedRows[0] : undefined) ??
    (exactNameRows.length === 1 ? exactNameRows[0] : undefined) ??
    (homeActionRows.length === 1 ? homeActionRows[0] : undefined);
  return [
    "Project 控件未通过唯一同容器验证",
    `visibleRows=${rows.length}`,
    `exactNameRows=${exactNameRows.length}`,
    `homeActionRows=${homeActionRows.length}`,
    `combinedRows=${combinedRows.length}`,
    `targetButtons=${target?.buttons.length ?? 0}`,
    `nameSources=${projectControlSourceBits(target, "mainSources")}`,
    `homeSources=${projectControlSourceBits(target, "homeSources")}`,
  ].join("; ");
}

function projectControlSourceBits(
  row: ProjectControlRowEvidence | undefined,
  key: "mainSources" | "homeSources",
) {
  const sources: readonly ProjectControlLabelSource[] = [
    "ariaLabel",
    "title",
    "innerText",
    "textContent",
    "ariaLabelledBy",
  ];
  return sources
    .map(
      (source) =>
        `${source}:${row?.buttons.some((button) => button[key].has(source)) === true ? "1" : "0"}`,
    )
    .join(",");
}

function readBridgedProjectBinding(requiredName: string) {
  const value = document.documentElement.getAttribute(PROJECT_BINDING_ATTRIBUTE);
  if (!value || value.length > 1_000) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isContentRecord(parsed) ||
      parsed.evidenceVersion !== PROJECT_EVIDENCE_VERSION ||
      typeof parsed.observedAt !== "number" ||
      !Number.isSafeInteger(parsed.observedAt) ||
      parsed.observedAt > Date.now() + 5_000 ||
      Date.now() - parsed.observedAt > PROJECT_PASSIVE_EVIDENCE_TTL_MS ||
      typeof parsed.name !== "string" ||
      parsed.name.replace(/\s+/gu, " ").trim().toLocaleLowerCase() !==
        requiredName.toLocaleLowerCase()
    ) {
      return undefined;
    }
    return parseContentProjectRootUrl(parsed.projectUrl);
  } catch {
    return undefined;
  }
}

function projectDiscoveryMessage(
  projects: ReadonlyArray<{ route: ContentProjectRoute; name: string }>,
  currentRoute: ContentProjectRoute | undefined,
) {
  if (projects.length === 0) {
    return "ChatGPT 当前页面和运行态中没有找到名为 Ask2GPT 的 Project。请确认当前账号、登录状态和 Project 名称。";
  }
  const names = projects
    .map((project) => project.name)
    .filter((name, index, all) => all.indexOf(name) === index)
    .slice(0, 5)
    .map((name) => `“${name.slice(0, 40)}”`)
    .join("、");
  return currentRoute
    ? `当前标签页不是 Ask2GPT Project。当前账号可见的 Project：${names}。`
    : `没有找到名为 Ask2GPT 的唯一 Project。当前账号可见的 Project：${names}。`;
}

function uniqueProjectRoute(entries: ReadonlyMap<string, ContentProjectRoute>) {
  return entries.size === 1 ? [...entries.values()][0] : undefined;
}

function visibleProjectName(labels: readonly string[]) {
  for (const label of labels) {
    const normalized = label.replace(/\s+/gu, " ").trim();
    if (normalized.length > 0 && normalized.length <= 120 && !/[\p{Cc}\p{Cf}]/u.test(normalized)) {
      return normalized;
    }
  }
  return undefined;
}

function projectLabelMatchesName(label: string, requiredName: string) {
  const normalized = label
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+(?:[-|·]|—)\s+chatgpt$/u, "");
  const expected = requiredName.toLocaleLowerCase();
  return [expected, `${expected} project`, `${expected} 项目`, `project ${expected}`].includes(
    normalized,
  );
}

document.addEventListener(
  "freeze",
  () => {
    const run = activeRun;
    if (!run) return;
    try {
      const markdown = responseMarkdown(run);
      if (!markdown || markdown === run.lastMarkdown) return;
      assertMarkdownFits(markdown);
      run.lastMarkdown = markdown;
      run.lastChangedAt = Date.now();
      // Initiate the extension message synchronously in the freeze callback.
      // Promise continuations may pause once Chrome freezes the page, but the
      // service worker still receives the latest full snapshot.
      void emitRunEvent(run, "snapshot", markdown).catch(() => undefined);
    } catch {
      // The regular recovery path will report a validated error after resume.
    }
  },
  { capture: true },
);

const resumeInspection = () => {
  if (activeRun) void scheduleInspect(activeRun, true);
};
document.addEventListener("resume", resumeInspection, { capture: true });
window.addEventListener("pageshow", resumeInspection, { capture: true });
window.addEventListener("pagehide", stopRun, { capture: true });
document.addEventListener(
  "visibilitychange",
  () => {
    if (document.visibilityState === "visible") resumeInspection();
  },
  { capture: true },
);

async function handleCommand(command: ContentCommand): Promise<Record<string, unknown>> {
  if (command.type === "content.send") return handleSend(command);
  if (command.type === "content.stop") return handleStop(command);
  if (command.type === "content.regenerate") return handleRegenerate(command);
  return handleRecover(command);
}

async function listAvailableModels() {
  assertPageReady();
  return readSessionModelCatalog();
}

interface SessionModelCatalog {
  options: ChatModelOption[];
  currentModelId: string;
  selectorVersion: number;
}

async function readSessionModelCatalog(): Promise<SessionModelCatalog> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), MODEL_CATALOG_FETCH_TIMEOUT_MS);
  try {
    return await readSessionModelCatalogWithSignal(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("ChatGPT model catalog request timed out.");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

async function readSessionModelCatalogWithSignal(
  signal: AbortSignal,
): Promise<SessionModelCatalog> {
  const accessToken = await readSessionAccessToken(signal);
  const headers = new Headers({ Accept: "application/json" });
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const response = await fetch("https://chatgpt.com/backend-api/models", {
    credentials: "include",
    headers,
    signal,
  });
  if (!response.ok) throw new Error("ChatGPT model catalog request was not accepted.");
  const payload: unknown = await response.json();
  if (!isContentRecord(payload) || !Array.isArray(payload.models)) {
    throw new Error("ChatGPT model catalog response is incompatible.");
  }
  const models = payload.models.filter(isContentRecord);
  const defaultModelId = readDefaultModelId(payload, models);
  const candidates: AccountModelCandidate[] = [];
  for (const model of models) {
    const id = normalizeModelId(model.slug);
    const label = normalizeVisibleModelText(
      typeof model.title === "string" ? model.title : (id ?? ""),
      80,
    );
    if (!id || !label || candidates.some((candidate) => candidate.id === id)) continue;
    const description = normalizeVisibleModelText(
      typeof model.description === "string" ? model.description : "",
      160,
    );
    candidates.push({
      id,
      label,
      ...(description ? { description } : {}),
      reasoningType: typeof model.reasoning_type === "string" ? model.reasoning_type : undefined,
      configurableThinkingEffort: model.configurable_thinking_effort === true,
      thinkingEfforts: readThinkingEfforts(model.thinking_efforts),
      isWorkModeModel: model.is_work_mode_model === true,
    });
  }
  const options = buildChatGptComposerOptions(candidates, defaultModelId);
  if (options.length === 0) throw new Error("ChatGPT model catalog was empty.");
  const currentModelId = options.find((option) => option.selected)?.id ?? options[0]!.id;
  return { options, currentModelId, selectorVersion: SELECTOR_VERSION };
}

function readThinkingEfforts(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isContentRecord(entry) || typeof entry.thinking_effort !== "string") return [];
    if (!["min", "standard", "extended", "max"].includes(entry.thinking_effort)) return [];
    const label = [entry.short_label, entry.mobile_full_label, entry.full_label].find(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.trim().length > 0,
    );
    return [{ id: entry.thinking_effort, ...(label ? { label } : {}) }];
  });
}

function readDefaultModelId(
  payload: Record<string, unknown>,
  models: Array<Record<string, unknown>>,
) {
  for (const key of ["default_model_slug", "default_model", "current_model_slug"] as const) {
    const value = normalizeModelId(payload[key]);
    if (value) return value;
  }
  const explicit = models.find(
    (model) => model.is_default === true || model.default === true || model.selected === true,
  );
  const explicitId = normalizeModelId(explicit?.slug);
  if (explicitId) return explicitId;
  if (Array.isArray(payload.categories)) {
    for (const category of payload.categories) {
      if (!isContentRecord(category)) continue;
      const value = normalizeModelId(category.default_model ?? category.default_model_slug);
      if (value) return value;
    }
  }
  return normalizeModelId(models[0]?.slug);
}

function normalizeModelId(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/u.test(value) ? value : undefined;
}

function readPageAccessToken() {
  const html = document.documentElement.innerHTML;
  for (const pattern of [
    /"accessToken"\s*:\s*"([^"\\]{20,10000})"/u,
    /\\"accessToken\\"\s*[:,]\s*\\"([^"\\]{20,10000})\\"/u,
    /"accessToken"\s*,\s*"([^"\\]{20,10000})"/u,
  ]) {
    const token = pattern.exec(html)?.[1];
    if (token && !/\s/u.test(token)) return token;
  }
  return undefined;
}

async function readSessionAccessToken(signal: AbortSignal) {
  const embedded = readPageAccessToken();
  if (embedded) return embedded;
  const response = await fetch("https://chatgpt.com/api/auth/session", {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) return undefined;
  const payload: unknown = await response.json();
  return isContentRecord(payload) &&
    typeof payload.accessToken === "string" &&
    payload.accessToken.length >= 20 &&
    payload.accessToken.length <= 10_000 &&
    !/\s/u.test(payload.accessToken)
    ? payload.accessToken
    : undefined;
}

async function selectAvailableModel(option: ChatModelOption) {
  assertPageReady();
  const sessionCatalog = await readSessionModelCatalog();
  const target = sessionCatalog.options.find(
    (candidate) =>
      candidate.id === option.id &&
      candidate.modelId === option.modelId &&
      candidate.reasoningEffort === option.reasoningEffort,
  );
  if (!target?.modelId) {
    throw pageError(
      "CHATGPT_MODEL_SELECTION_FAILED",
      "所选模式已不在 ChatGPT 当前账号的可用列表中。",
    );
  }
  if (!publishPageModelIntent(target.modelId, target.reasoningEffort)) {
    throw pageError("CHATGPT_MODEL_SELECTION_FAILED", "ChatGPT 页面没有接受所选模型与推理档位。");
  }
  return { ...target, selected: true as const };
}

async function ensureAvailableModel(
  modelId: string,
  reasoningEffort?: ChatReasoningEffort,
  modelLabel?: string,
) {
  if (publishPageModelIntent(modelId, reasoningEffort)) {
    return { id: modelId, label: modelLabel ?? modelId, selected: true as const };
  }
  throw pageError("CHATGPT_MODEL_SELECTION_FAILED", "ChatGPT 页面没有接受所选模型与推理档位。");
}

function publishPageModelIntent(modelId: string, reasoningEffort?: ChatReasoningEffort) {
  const root = document.documentElement;
  root.removeAttribute("data-ask2gpt-model-ready");
  const intent = JSON.stringify({ modelId, ...(reasoningEffort ? { reasoningEffort } : {}) });
  root.setAttribute("data-ask2gpt-model-intent", intent);
  document.dispatchEvent(new Event("ask2gpt:model-intent"));
  const accepted = root.getAttribute("data-ask2gpt-model-ready") === intent;
  root.removeAttribute("data-ask2gpt-model-intent");
  root.removeAttribute("data-ask2gpt-model-ready");
  return accepted;
}

function publishPageRunIntent(runId: string) {
  const root = document.documentElement;
  root.removeAttribute(RUN_READY_ATTRIBUTE);
  const intent = JSON.stringify({ runId });
  root.setAttribute(RUN_INTENT_ATTRIBUTE, intent);
  document.dispatchEvent(new Event(RUN_INTENT_EVENT));
  const accepted = root.getAttribute(RUN_READY_ATTRIBUTE) === intent;
  root.removeAttribute(RUN_INTENT_ATTRIBUTE);
  root.removeAttribute(RUN_READY_ATTRIBUTE);
  return accepted;
}

function receivePageRunLifecycle() {
  const rawEvent = document.documentElement.getAttribute(RUN_LIFECYCLE_ATTRIBUTE);
  if (!rawEvent || rawEvent.length > 256) return;
  let event: unknown;
  try {
    event = JSON.parse(rawEvent);
  } catch {
    return;
  }
  if (
    !isContentRecord(event) ||
    !isContentSafeId(event.runId) ||
    !RUN_LIFECYCLE_PHASES.includes(event.phase as (typeof RUN_LIFECYCLE_PHASES)[number])
  ) {
    return;
  }
  const failureKind = event.failureKind;
  const httpStatus = event.httpStatus;
  if (
    (failureKind !== undefined &&
      !RUN_LIFECYCLE_FAILURE_KINDS.includes(
        failureKind as (typeof RUN_LIFECYCLE_FAILURE_KINDS)[number],
      )) ||
    (httpStatus !== undefined &&
      (typeof httpStatus !== "number" ||
        !Number.isInteger(httpStatus) ||
        httpStatus < 100 ||
        httpStatus > 599)) ||
    (event.phase !== "response-error" && (failureKind !== undefined || httpStatus !== undefined)) ||
    (httpStatus !== undefined && failureKind !== "http")
  ) {
    return;
  }
  const run = activeRun;
  if (!run || run.runId !== event.runId || !run.runIntentAccepted) return;

  if (event.phase === "submitted") {
    run.networkSubmitted = true;
  } else if (event.phase === "response-started") {
    run.networkSubmitted = true;
    run.networkResponseStarted = true;
  } else if (event.phase === "response-complete") {
    run.networkSubmitted = true;
    run.networkResponseStarted = true;
    run.networkResponseComplete = true;
    run.networkResponseCompleteAt ??= Date.now();
    run.consecutiveIdleSamples = 0;
    if (run.responseStartTimer !== undefined) {
      window.clearTimeout(run.responseStartTimer);
      run.responseStartTimer = undefined;
    }
    scheduleResponseStartWatchdog(run, RESPONSE_COMPLETE_DOM_GRACE_MS);
  } else {
    run.networkResponseError = {
      kind:
        typeof failureKind === "string"
          ? (failureKind as Exclude<RunNetworkFailure["kind"], "unknown">)
          : "unknown",
      ...(typeof httpStatus === "number" ? { httpStatus } : {}),
    };
  }
  void scheduleInspect(run);
}

function receivePageRunResponse() {
  const rawEvent = document.documentElement.getAttribute(RUN_RESPONSE_ATTRIBUTE);
  if (!rawEvent || rawEvent.length > MAX_CONTENT_MARKDOWN_BYTES + 1_024) return;
  let event: unknown;
  try {
    event = JSON.parse(rawEvent);
  } catch {
    return;
  }
  if (
    !isContentRecord(event) ||
    !isContentSafeId(event.runId) ||
    (event.phase !== "snapshot" && event.phase !== "complete") ||
    typeof event.markdown !== "string"
  ) {
    return;
  }
  const run = activeRun;
  if (!run || run.runId !== event.runId || !event.markdown.trim()) return;
  try {
    assertMarkdownFits(event.markdown);
  } catch {
    return;
  }

  const phase = event.phase;
  const markdown = event.markdown;
  pageResponseRelay = pageResponseRelay
    .catch(() => undefined)
    .then(async () => {
      if (activeRun !== run) return;
      const accepted = await emitRunEvent(run, phase, markdown, { networkResponse: true });
      if (phase === "complete" && accepted) stopRunIfMatching(run);
    });
}

function contentOperationError(error: unknown, fallback: PageErrorCode) {
  const classified = classifyPageError(error);
  return {
    code: classified === "SELECTOR_INCOMPATIBLE" ? fallback : classified,
    message: error instanceof Error ? error.message.slice(0, 1_000) : "ChatGPT 页面操作失败。",
  };
}

function inspectConversationSnapshot() {
  const remoteUrl = currentRemoteUrl();
  if (!remoteUrl || remoteUrl === "https://chatgpt.com/") {
    throw pageError(
      "CHATGPT_REMOTE_UNAVAILABLE",
      "The visible ChatGPT page is not a conversation.",
    );
  }
  const history = visibleConversationMessages();
  const emptyInitialProjectHistory = Boolean(
    parseContentProjectRootUrl(remoteUrl) &&
    history.messages.length === 0 &&
    renderedConversationMessageElements().length === 0 &&
    !hasVisibleHistoryTruncationSignal(),
  );
  const historyComplete = history.complete || emptyInitialProjectHistory;
  const title = visibleConversationTitle(remoteUrl);
  return {
    remoteUrl,
    ...(title ? { title } : {}),
    messages: history.messages,
    observedAt: new Date().toISOString(),
    // Keep structural transcript completeness separate from terminal UI
    // evidence. Hidden ChatGPT tabs can defer response action controls even
    // after the exact owned run has reached a trusted network terminal. The
    // worker may attest that terminal against this full transcript, but must
    // never do so for a virtualized or otherwise truncated history.
    historyComplete,
    ...(activeRun?.submittedPromptPresentationSha256
      ? {
          activeRunId: activeRun.runId,
          submittedPromptPresentationSha256: activeRun.submittedPromptPresentationSha256,
        }
      : {}),
    // Completed assistant actions are stronger evidence than tab visibility.
    // ChatGPT deliberately keeps Relay tabs in the background; requiring a
    // foreground document here made the VS Code transcript stay partial until
    // the user manually opened Chrome.
    complete:
      historyComplete && !hasSingleRenderedStopControl() && hasResponseActions(latestAssistant()),
  };
}

async function handleSend(command: ContentCommand) {
  const prompt = normalizeContentPromptText(command.prompt);
  if (!prompt?.trim()) throw pageError("CHATGPT_SEND_FAILED", "问题内容为空。");
  if (activeRun) throw pageError("CHATGPT_SEND_FAILED", "该标签页已有回答正在生成。");
  assertExpectedCommandPage(command);
  assertPageReady();
  await dismissConversationHistoryRateLimitNotice();
  if (command.modelId) {
    await ensureAvailableModel(command.modelId, command.reasoningEffort, command.modelLabel);
  }

  const baselineAssistants = assistantCount();
  const baselineUsers = userMessageCount();
  const baselineMarkdown = latestAssistantMarkdown();
  const composer = await waitForUniqueComposer(10_000);
  const composerScope = requireComposerScope(composer);
  if (command.attachments?.length) {
    await attachCodeFiles(composer, composerScope, command.attachments);
  }
  const committedComposer = await writeStableComposerPrompt(prompt).catch((error: unknown) => {
    removeAttachedFiles(composerScope, command.attachments ?? []);
    throw error;
  });
  const committedComposerScope = requireComposerScope(committedComposer);
  if (command.attachments?.length) {
    await waitForAttachedFileEvidence(committedComposerScope, command.attachments, 2_000);
  }

  const sendButton = await waitForOwnedComposerSendButton(
    committedComposer,
    command.attachments?.length ? 30_000 : 10_000,
  ).catch((error: unknown) => {
    cleanupUnsubmittedComposer(
      committedComposer,
      committedComposerScope,
      prompt,
      command.attachments ?? [],
    );
    throw error;
  });
  // ChatGPT can mount this notice only after the first composer input event.
  // Recheck at the last reversible boundary, before the run is marked active
  // and before any send control can be actuated.
  await dismissConversationHistoryRateLimitNotice();
  let dispatchCommand: ContentCommand;
  try {
    dispatchCommand = await validateDispatchCommandPage(command);
  } catch (error) {
    cleanupUnsubmittedComposer(
      committedComposer,
      committedComposerScope,
      prompt,
      command.attachments ?? [],
    );
    throw error;
  }
  const run = startRun(
    dispatchCommand,
    "send",
    baselineAssistants,
    baselineMarkdown,
    undefined,
    baselineUsers,
    prompt,
    command.attachments?.map((attachment) => attachment.fileName),
  );
  run.runIntentAccepted = publishPageRunIntent(run.runId);
  try {
    assertExpectedCommandPage(dispatchCommand);
    assertConfirmedSubmissionControls(committedComposer, sendButton, prompt);
  } catch (error) {
    cleanupUnsubmittedComposer(
      committedComposer,
      committedComposerScope,
      prompt,
      command.attachments ?? [],
    );
    throw error;
  }
  // Ask ChatGPT's MAIN world to validate the exact run-marked button, wait for
  // its animated geometry to settle, and return the guarded hit point for one
  // trusted pointer click. There is no page-owned synthetic click, form-submit,
  // keyboard injection, fallback, or retry path.
  await dispatchSendThroughMainWorld(run, committedComposerScope, committedComposer, sendButton);
  const submissionDeadline = Date.now() + TOTAL_SUBMISSION_CONFIRMATION_MS;
  let submitted = await waitForSubmission(
    run,
    Math.min(UNTOUCHED_DRAFT_CONFIRMATION_MS, TOTAL_SUBMISSION_CONFIRMATION_MS),
  );
  if (!submitted && submissionActuationLeftDraftUntouched(run, committedComposer, prompt)) {
    // A successful ChatGPT submit clears or replaces the composer immediately,
    // publishes the current user turn, or emits the bound request lifecycle. If
    // none changed during the short grace window, the single activation was ignored;
    // fail now instead of spending the full answer timeout on an unsent draft.
    throw pageError(
      "CHATGPT_SEND_FAILED",
      "ChatGPT 未接受本次发送；问题仍保留在输入框中。Ask2GPT 未自动重试，以避免重复提交。",
    );
  }
  if (!submitted) {
    const remainingConfirmationMs = Math.max(0, submissionDeadline - Date.now());
    if (remainingConfirmationMs > 0) {
      submitted = await waitForSubmission(run, remainingConfirmationMs);
    }
  }
  if (!submitted) {
    // The single page-owned button activation is non-idempotent even when ChatGPT has not yet
    // exposed a user turn, fetch lifecycle, or cleared composer. Preserve the
    // draft and enter read-only recovery; never submit the form as a fallback.
    scheduleResponseStartWatchdog(run);
    void scheduleInspect(run, true);
    throw ambiguousSubmissionError(
      "CHATGPT_SEND_FAILED",
      "ChatGPT 未确认本次问题已发送；Ask2GPT 未自动重试，以避免重复提交。",
    );
  }
  const submittedUser = latestUser();
  let submittedPromptMessageSha256: string | undefined;
  if (submittedUser) {
    const submittedMarkdown = serializeAssistant(submittedUser).trim();
    run.submittedPromptPresentationSha256 = await sha256ContentHex(submittedMarkdown);
    submittedPromptMessageSha256 = await sha256ContentHex(
      JSON.stringify(["user", submittedMarkdown]),
    );
  }
  confirmRunSubmission(run);
  void scheduleInspect(run);
  return {
    selectorVersion: SELECTOR_VERSION,
    ...(submittedPromptMessageSha256 ? { submittedPromptMessageSha256 } : {}),
  };
}

async function dismissConversationHistoryRateLimitNotice() {
  const selector = '[data-testid="modal-conversation-history-rate-limit"]';
  const modals = [...document.querySelectorAll<HTMLElement>(selector)].filter(isVisible);
  if (modals.length === 0) return;
  if (modals.length !== 1) {
    throw pageError(
      "CHATGPT_REMOTE_UNAVAILABLE",
      "ChatGPT displayed more than one conversation-history notice; no question was sent.",
    );
  }
  const modal = modals[0]!;
  const buttons = [...modal.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) =>
      isVisible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true",
  );
  if (buttons.length !== 1) {
    throw pageError(
      "CHATGPT_REMOTE_UNAVAILABLE",
      "ChatGPT's conversation-history notice did not expose one safe confirmation button; no question was sent.",
    );
  }
  buttons[0]!.click();
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!modal.isConnected || !isVisible(modal)) return;
    await delay(50);
  }
  throw pageError(
    "CHATGPT_REMOTE_UNAVAILABLE",
    "ChatGPT's conversation-history notice remained open; no question was sent.",
  );
}

function submissionActuationLeftDraftUntouched(run: Run, composer: HTMLElement, prompt: string) {
  return Boolean(
    activeRun === run &&
    !run.networkSubmitted &&
    !run.networkResponseStarted &&
    !run.networkResponseComplete &&
    !run.networkResponseError &&
    !currentUserTurnMatchesPrompt(run) &&
    userMessageCount() === run.baselineUsers &&
    assistantCount() === run.baselineAssistants &&
    findRenderedControlEvidence(selectors.stop).length === 0 &&
    composer.isConnected &&
    composerTextMatchesPrompt(composer, prompt),
  );
}

async function dispatchSendThroughMainWorld(
  run: Run,
  scope: HTMLElement,
  composer: HTMLElement,
  sendButton: HTMLButtonElement,
) {
  scope.setAttribute(MAIN_WORLD_SCOPE_ATTRIBUTE, run.runId);
  composer.setAttribute(MAIN_WORLD_COMPOSER_ATTRIBUTE, run.runId);
  sendButton.setAttribute(MAIN_WORLD_SEND_ATTRIBUTE, run.runId);
  let response: unknown;
  try {
    response = await chrome.runtime.sendMessage({
      type: "content.mainWorldSend.request",
      conversationId: run.conversationId,
      runId: run.runId,
      selectorVersion: SELECTOR_VERSION,
    });
  } catch {
    throw ambiguousSubmissionError(
      "CHATGPT_SEND_FAILED",
      "ChatGPT 页面的主世界发送通道中断；Ask2GPT 未自动重试，以避免重复提交。",
    );
  } finally {
    if (scope.getAttribute(MAIN_WORLD_SCOPE_ATTRIBUTE) === run.runId) {
      scope.removeAttribute(MAIN_WORLD_SCOPE_ATTRIBUTE);
    }
    if (composer.getAttribute(MAIN_WORLD_COMPOSER_ATTRIBUTE) === run.runId) {
      composer.removeAttribute(MAIN_WORLD_COMPOSER_ATTRIBUTE);
    }
    if (sendButton.getAttribute(MAIN_WORLD_SEND_ATTRIBUTE) === run.runId) {
      sendButton.removeAttribute(MAIN_WORLD_SEND_ATTRIBUTE);
    }
  }
  if (!isContentRecord(response) || response.ok !== true || response.dispatched !== true) {
    if (isContentRecord(response) && response.attempted === false) {
      const reason =
        typeof response.reason === "string" && /^[a-z0-9-]{1,64}$/u.test(response.reason)
          ? ` reason=${response.reason}`
          : "";
      throw pageError(
        "CHATGPT_SEND_FAILED",
        `Chrome 未能完成 ChatGPT 的页面发送激活；问题尚未提交。${reason}`,
      );
    }
    throw ambiguousSubmissionError(
      "CHATGPT_SEND_FAILED",
      "Chrome 未确认 ChatGPT 页面已接受本次发送；Ask2GPT 未自动重试，以避免重复提交。",
    );
  }
}

function cleanupUnsubmittedComposer(
  composer: HTMLElement,
  scope: HTMLElement | Document,
  prompt: string,
  attachments: readonly ChatFileAttachment[],
) {
  if (composer.isConnected && composerTextMatchesPrompt(composer, prompt)) {
    setComposerText(composer, "");
  }
  removeAttachedFiles(scope, attachments);
}

function requireComposerScope(composer: HTMLElement) {
  const ownership = composerOwnership(composer);
  if (!ownership) {
    throw pageError(
      "SELECTOR_INCOMPATIBLE",
      "ChatGPT input is not inside one safe composer scope; Ask2GPT stopped before clicking anything.",
    );
  }
  return ownership.scope;
}

function assertConfirmedSubmissionControls(
  composer: HTMLElement,
  sendButton: HTMLButtonElement,
  prompt: string,
) {
  const ownership = composerOwnership(composer);
  const scope = requireComposerScope(composer);
  const composers = findComposerElements(true, scope);
  if (
    !ownership ||
    ownership.scope !== scope ||
    ownership.sendControl !== sendButton ||
    composers.length !== 1 ||
    composers[0] !== composer ||
    !composer.isConnected ||
    !composerTextMatchesPrompt(composer, prompt) ||
    !isComposerActuationVisible(sendButton) ||
    !isEnabledSendButton(sendButton)
  ) {
    throw pageError(
      "SELECTOR_INCOMPATIBLE",
      "ChatGPT replaced the confirmed input or send control before it could be clicked.",
    );
  }
}

function isEnabledSendButton(element: HTMLElement): element is HTMLButtonElement {
  return (
    element instanceof HTMLButtonElement &&
    !element.disabled &&
    element.getAttribute("aria-disabled") !== "true"
  );
}

async function attachCodeFiles(
  composer: HTMLElement,
  composerScope: HTMLElement | Document,
  attachments: readonly ChatFileAttachment[],
) {
  const input = await findFileInput(composer, composerScope, 5_000);
  if (!input) {
    throw pageError(
      "CHATGPT_ATTACHMENT_FAILED",
      "ChatGPT 当前页面没有提供可用的文件附件入口；问题尚未发送。",
    );
  }
  if (typeof DataTransfer !== "function" || typeof File !== "function") {
    throw pageError(
      "CHATGPT_ATTACHMENT_FAILED",
      "当前 Chrome 页面不支持安全构造代码文件附件；问题尚未发送。",
    );
  }

  const transfer = new DataTransfer();
  for (const attachment of attachments) {
    transfer.items.add(
      new File([attachment.content], attachment.fileName, {
        type: attachment.mimeType,
        lastModified: Date.now(),
      }),
    );
  }
  input.files = transfer.files;
  if (input.files.length !== attachments.length) {
    throw pageError("CHATGPT_ATTACHMENT_FAILED", "ChatGPT 文件输入框没有接受全部代码附件。");
  }
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  await waitForAttachedFileEvidence(composerScope, attachments, 20_000);
}

async function findFileInput(
  composer: HTMLElement,
  composerScope: HTMLElement | Document,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let requestedAttachmentUi = false;
  let fileInputsBeforeRequest: Set<HTMLInputElement> | undefined;
  while (Date.now() < deadline) {
    const ownership = composerOwnership(composer);
    if (!composer.isConnected || !ownership || ownership.scope !== composerScope) return undefined;
    const scoped = [
      ...composerScope.querySelectorAll<HTMLInputElement>('input[type="file"]'),
    ].filter((candidate) => !candidate.disabled);
    if (scoped.length === 1) return scoped[0];
    if (scoped.length > 1) return undefined;

    if (fileInputsBeforeRequest) {
      const previousInputs = fileInputsBeforeRequest;
      const newlyCreated = [
        ...document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
      ].filter((candidate) => !candidate.disabled && !previousInputs.has(candidate));
      if (newlyCreated.length === 1) return newlyCreated[0];
      if (newlyCreated.length > 1) return undefined;
    }

    if (!requestedAttachmentUi) {
      const buttons = findVisibleElements(selectors.attachmentButtons, composerScope);
      if (buttons.length === 1) {
        fileInputsBeforeRequest = new Set(
          document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
        );
        buttons[0]!.click();
        requestedAttachmentUi = true;
      }
    }
    await delay(100);
  }
  return undefined;
}

async function waitForAttachedFileEvidence(
  scope: HTMLElement | Document,
  attachments: readonly ChatFileAttachment[],
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visibleText = [
      scope.textContent ?? "",
      ...[...scope.querySelectorAll<HTMLElement>("[aria-label], [title]")].flatMap((element) => [
        element.getAttribute("aria-label") ?? "",
        element.getAttribute("title") ?? "",
      ]),
    ].join("\n");
    if (
      /(?:upload|file|attachment).{0,50}(?:failed|error|unsupported|too large)|(?:上传|文件|附件).{0,30}(?:失败|错误|不支持|过大)/iu.test(
        visibleText,
      )
    ) {
      throw pageError("CHATGPT_ATTACHMENT_FAILED", "ChatGPT 拒绝了一个或多个代码文件附件。");
    }
    if (attachments.every((attachment) => visibleText.includes(attachment.fileName))) return;
    await delay(100);
  }
  removeAttachedFiles(scope, attachments);
  throw pageError(
    "CHATGPT_ATTACHMENT_FAILED",
    "未能确认 ChatGPT 已接收全部代码文件附件；为避免漏发，问题尚未发送。",
  );
}

function removeAttachedFiles(
  scope: HTMLElement | Document,
  attachments: readonly ChatFileAttachment[],
) {
  if (attachments.length === 0) return;
  const fileNames = attachments.map((attachment) => attachment.fileName.toLocaleLowerCase());
  for (const button of scope.querySelectorAll<HTMLButtonElement>("button")) {
    const label = accessibleLabel(button).toLocaleLowerCase();
    if (
      /remove|delete|移除|删除/iu.test(label) &&
      (fileNames.some((fileName) => label.includes(fileName)) ||
        removalControlHasLocalFileEvidence(button, fileNames, scope))
    ) {
      button.click();
    }
  }
}

function removalControlHasLocalFileEvidence(
  button: HTMLButtonElement,
  fileNames: readonly string[],
  boundary: HTMLElement | Document,
) {
  let candidate = button.parentElement;
  for (let depth = 0; candidate && depth < 4; depth += 1, candidate = candidate.parentElement) {
    if (candidate === boundary || candidate.matches("main, body, html")) break;
    const evidence = [
      candidate.textContent ?? "",
      candidate.getAttribute("aria-label") ?? "",
      candidate.getAttribute("title") ?? "",
    ]
      .join("\n")
      .toLocaleLowerCase();
    if (fileNames.some((fileName) => evidence.includes(fileName))) return true;
  }
  return false;
}

async function handleStop(command: ContentCommand) {
  const run = activeRun;
  if (!run || run.runId !== command.runId || run.conversationId !== command.conversationId) {
    return { alreadyStopped: true };
  }

  const stopButtons = findVisibleElements(selectors.stop);
  const markdown = responseMarkdown(run);
  const decision = stopControlDecision(
    stopButtons.length,
    Boolean(markdown),
    hasResponseActions(run.ownedAssistantElement),
  );
  if (decision !== "click") {
    if (decision === "already-complete") {
      const delivered = await emitRunEvent(run, "complete", markdown);
      stopRun();
      if (!delivered) {
        await emitError(
          run,
          "CHATGPT_REMOTE_UNAVAILABLE",
          "ChatGPT 已完成回答，但页面未进入可识别的会话 URL。",
        );
      }
      return { alreadyCompleted: true, markdown };
    }
    throw pageError(
      "SELECTOR_INCOMPATIBLE",
      stopButtons.length === 0
        ? "找不到当前回答的可见停止控件；未执行停止，请在 ChatGPT 页面中处理。"
        : "页面出现多个停止控件；未执行停止，请在 ChatGPT 页面中处理。",
    );
  }
  stopButtons[0]!.click();
  if (!(await waitForStopControlToDisappear(5_000))) {
    throw pageError("SELECTOR_INCOMPATIBLE", "ChatGPT 停止控件未响应。");
  }
  if (activeRun !== run) return { alreadyCompleted: true };

  const finalMarkdown = responseMarkdown(run);
  const delivered = await emitRunEvent(run, "stopped", finalMarkdown);
  stopRun();
  if (!delivered) {
    await emitError(
      run,
      "CHATGPT_REMOTE_UNAVAILABLE",
      "回答已停止，但页面未进入可识别的会话 URL。",
    );
  }
  return { stopped: true, markdown: finalMarkdown };
}

async function handleRegenerate(command: ContentCommand) {
  if (activeRun) {
    throw pageError("REGENERATE_CONTROL_UNAVAILABLE", "该标签页已有回答正在生成。");
  }
  assertExpectedCommandPage(command);
  assertPageReady();
  const assistant = latestAssistant();
  if (!assistant) {
    throw pageError("REGENERATE_CONTROL_UNAVAILABLE", "找不到可重新生成的回答。");
  }
  const scope = assistant.parentElement ?? assistant;
  const candidates = [...scope.querySelectorAll<HTMLButtonElement>("button")].filter(
    (candidate) =>
      isVisible(candidate) &&
      !candidate.disabled &&
      selectors.regenerateLabels.some((label) =>
        accessibleLabel(candidate).toLowerCase().includes(label.toLowerCase()),
      ),
  );
  if (candidates.length !== 1) {
    throw pageError(
      "REGENERATE_CONTROL_UNAVAILABLE",
      candidates.length === 0
        ? "ChatGPT 当前页面没有可见的重新生成控件。"
        : "ChatGPT 页面出现多个重新生成控件，已停止以避免误操作。",
    );
  }

  const baselineAssistants = assistantCount();
  const baselineMarkdown = latestAssistantMarkdown();
  const run = startRun(command, "regenerate", baselineAssistants, baselineMarkdown);
  run.runIntentAccepted = publishPageRunIntent(run.runId);
  if (!run.runIntentAccepted) {
    stopRun();
    throw pageError(
      "REGENERATE_CONTROL_UNAVAILABLE",
      "ChatGPT did not accept the tagged regeneration intent; nothing was clicked.",
    );
  }
  // Re-check the exact route immediately before the one non-idempotent click.
  assertExpectedCommandPage(command);
  candidates[0]!.click();
  if (!(await waitForRegenerationStart(run, 10_000))) {
    throw pageError(
      "REGENERATE_CONTROL_UNAVAILABLE",
      "ChatGPT 未确认重新生成已经开始；Ask2GPT 未自动重试，以避免重复提交。",
    );
  }
  confirmRunSubmission(run);
  void scheduleInspect(run);
  return { selectorVersion: SELECTOR_VERSION };
}

async function handleRecover(command: ContentCommand) {
  let run = activeRun;
  if (run && run.runId === command.runId && run.conversationId === command.conversationId) {
    // Chrome can still deliver extension messages while an occluded page's
    // timers are suspended. Wait for one unthrottled, serialized pass so a
    // recovery checkpoint observes the current DOM instead of merely joining
    // a timer that may never fire until the user foregrounds the tab.
    await scheduleInspect(run, true);
    return {
      active: true,
      // Only this branch proves that the page-side observer still belongs to
      // the exact relay run. Page UI alone cannot attest a cross-ID recovery.
      matchedActiveRun: true,
      markdown: responseMarkdown(run),
      runLifecycle: runLifecycleDiagnostic(run),
      ...conversationMetadataPayload(),
      selectorVersion: SELECTOR_VERSION,
    };
  }
  const stopVisible = hasSingleRenderedStopControl();
  const recoveryTurnMatched = await visibleRecoveryTurnMatches(
    command.expectedPromptSha256,
    command.expectedPromptInlinePresentationVersion,
    command.expectedPromptInlinePresentationSha256,
    command.allowPromptInlinePresentationMatch === true,
    stopVisible,
  );
  if (!run && stopVisible && recoveryTurnMatched) {
    run = startRun(command, "send", Math.max(0, assistantCount() - 1), "", command.startedAt);
    run.sawStop = true;
    // A mapped tab with exactly one visible Stop control is the recovery-time
    // equivalent of a confirmed submission for this adopted generation.
    confirmRunSubmission(run);
    run.adoptedGeneration = true;
    void scheduleInspect(run);
    return {
      active: true,
      adopted: true,
      matchedActiveRun: false,
      recoveryTurnMatched: true,
      markdown: responseMarkdown(run),
      ...conversationMetadataPayload(),
      selectorVersion: SELECTOR_VERSION,
    };
  }
  return {
    active: false,
    stopVisible,
    recoveryTurnMatched,
    markdown: recoveryTurnMatched ? latestAssistantMarkdown() : "",
    ...conversationMetadataPayload(),
    selectorVersion: SELECTOR_VERSION,
  };
}

async function visibleRecoveryTurnMatches(
  expectedPromptSha256: string | undefined,
  expectedPromptInlinePresentationVersion: 1 | undefined,
  expectedPromptInlinePresentationSha256: string | undefined,
  allowPromptInlinePresentationMatch: boolean,
  stopVisible: boolean,
) {
  if (!expectedPromptSha256) return false;
  const user = latestUser();
  if (!user) return false;
  const visiblePrompt = visibleMessageText(user);
  const visiblePromptSha256 = await sha256ContentHex(visiblePrompt);
  const exactPromptMatched = visiblePromptSha256 === expectedPromptSha256;
  // `serializeAssistant` is already the exact v1 presentation of this DOM.
  // Do not feed it through the source canonicalizer again: that would escape
  // the backslashes a second time and make the recovery fingerprint unstable.
  const inlinePresentationPromptMatched = Boolean(
    !exactPromptMatched &&
    allowPromptInlinePresentationMatch &&
    expectedPromptInlinePresentationVersion === PROMPT_INLINE_PRESENTATION_VERSION &&
    expectedPromptInlinePresentationSha256 &&
    (await sha256ContentHex(serializeAssistant(user).trim())) ===
      expectedPromptInlinePresentationSha256,
  );
  if (!exactPromptMatched && !inlinePresentationPromptMatched) return false;
  if (stopVisible) return true;
  const assistant = latestAssistant();
  return Boolean(assistant && messageAppearsAfter(assistant, user));
}

async function sha256ContentHex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function runLifecycleDiagnostic(run: Run) {
  const user = latestUser();
  const assistant = latestAssistant();
  const inspectedAt = Date.now();
  const userTurnObserved = run.userTurnObservedAt !== undefined;
  const stopVisible = findRenderedControlEvidence(selectors.stop).length === 1;
  const ownedStopEnded = Boolean(
    run.sawStop &&
    !stopVisible &&
    user === run.ownedUserElement &&
    assistant === run.ownedAssistantElement,
  );
  return {
    documentVisible: document.visibilityState === "visible",
    intentAccepted: run.runIntentAccepted,
    submissionConfirmed: run.submissionConfirmed,
    networkSubmitted: run.networkSubmitted,
    networkResponseStarted: run.networkResponseStarted,
    networkResponseComplete: run.networkResponseComplete,
    networkResponseCompleteAgeMs:
      run.networkResponseCompleteAt === undefined
        ? undefined
        : Math.max(0, inspectedAt - run.networkResponseCompleteAt),
    userTurnObserved,
    responseAttributed: run.responseAttributedAt !== undefined,
    responseObserved: Boolean(run.lastObservedMarkdown || run.lastMarkdown),
    // Only monotonic evidence captured while the assistant was attributed to
    // this run is safe here. `latestAssistant()` may still be the previous
    // turn while ChatGPT is mounting the new response in a hidden document.
    responseActionsPresent: run.sawResponseActions,
    stopVisible,
    sawStop: stopVisible || ownedStopEnded,
    // Old history always has an assistant after a user. It is response
    // evidence for this run only after the current run's user turn was
    // structurally observed or matched exactly.
    assistantAfterUser: Boolean(
      userTurnObserved &&
      user &&
      assistant &&
      user === run.ownedUserElement &&
      assistant === run.ownedAssistantElement &&
      messageAppearsAfter(assistant, user),
    ),
  };
}

function confirmRunSubmission(run: Run) {
  run.submissionConfirmed = true;
  run.submissionConfirmedAt ??= Date.now();
  run.consecutiveAttributionIdleSamples = 0;
  scheduleResponseStartWatchdog(run);
}

function scheduleResponseStartWatchdog(run: Run, delayMs = RESPONSE_START_WATCHDOG_MS) {
  if (run.responseStartTimer !== undefined) return;
  run.responseStartTimer = window.setTimeout(() => {
    run.responseStartTimer = undefined;
    if (activeRun !== run) return;
    const inspectedAt = Date.now();
    const stopVisible = findRenderedControlEvidence(selectors.stop).length === 1;
    const user = latestUser();
    const assistant = latestAssistant();
    const ownedStopEnded = Boolean(
      run.sawStop &&
      !stopVisible &&
      user === run.ownedUserElement &&
      assistant === run.ownedAssistantElement,
    );
    const terminalDomEvidence = run.sawResponseActions || ownedStopEnded;
    const decision = responseStartWatchdogDecision({
      documentVisible: document.visibilityState === "visible",
      generationBusy: stopVisible || hasAssistantBusySignal(latestAssistant()),
      networkResponseComplete: run.networkResponseComplete,
      networkResponseCompleteAgeMs:
        run.networkResponseCompleteAt === undefined
          ? undefined
          : inspectedAt - run.networkResponseCompleteAt,
      networkResponseStarted: run.networkResponseStarted,
      responseAttributed: run.responseAttributedAt !== undefined,
      // Serialized text is monotonic evidence that this exact run produced a
      // visible response. Do not let later DOM ownership churn contradict a
      // snapshot that this observer has already seen (and may have emitted).
      responseObserved: Boolean(run.lastObservedMarkdown || run.lastMarkdown),
      terminalDomEvidence,
    });
    if (decision === "satisfied") return;
    if (decision === "defer") {
      scheduleResponseStartWatchdog(run, 5_000);
      return;
    }
    if (decision === "recover") {
      // The exact network stream completed, but ChatGPT has not committed the
      // assistant DOM. Keep this page-side run alive so the worker can verify
      // its durable pre-dispatch transcript, wake/reload the owned tab once,
      // and settle without ever replaying content.send.
      void scheduleInspect(run, true);
      void emitRecoveryRequest(run).catch(() => undefined);
      scheduleResponseStartWatchdog(run, 5_000);
      return;
    }
    // An empty assistant placeholder can remain after a failed response. DOM
    // ordering alone is not evidence that this run owns a visible answer.
    const lifecycle = [
      `intent=${run.runIntentAccepted ? 1 : 0}`,
      `submitted=${run.networkSubmitted ? 1 : 0}`,
      `started=${run.networkResponseStarted ? 1 : 0}`,
      `complete=${run.networkResponseComplete ? 1 : 0}`,
    ].join(" ");
    const submissionObserved =
      run.networkResponseStarted ||
      run.networkResponseComplete ||
      currentUserTurnMatchesPrompt(run);
    stopRun();
    void emitError(
      run,
      "CHATGPT_REMOTE_UNAVAILABLE",
      submissionObserved
        ? `ChatGPT 已显示本轮用户消息，但 30 秒内没有开始可见回答（Run lifecycle: ${lifecycle}）。Ask2GPT 未自动重试，以免重复提交；请检查对应 ChatGPT 标签页。`
        : `ChatGPT 未确认本轮问题已发送，且 30 秒内没有开始可见回答（Run lifecycle: ${lifecycle}）。问题可能仍保留在输入框中；Ask2GPT 未自动重试，以免重复提交。`,
      true,
    ).catch(() => undefined);
  }, delayMs);
}

function startRun(
  command: ContentCommand,
  mode: Run["mode"],
  baselineAssistants: number,
  baselineMarkdown: string,
  startedAt?: string,
  baselineUsers = userMessageCount(),
  expectedPrompt?: string,
  expectedAttachmentFileNames: readonly string[] = [],
) {
  const baselineUserElement = latestUser();
  const run: Run = {
    conversationId: command.conversationId,
    runId: command.runId,
    mode,
    lastMarkdown: "",
    lastObservedMarkdown: "",
    lastChangedAt: Date.now(),
    sawStop: false,
    sawResponseActions: false,
    baselineAssistants,
    baselineUsers,
    baselineMarkdown,
    baselineAssistantElement: latestAssistant(),
    baselineUserElement,
    baselineAssistantIdentity: messageDomIdentity(latestAssistant()),
    baselineUserIdentity: messageDomIdentity(baselineUserElement),
    baselineUserText: visibleMessageText(baselineUserElement),
    baselineRemoteUrl: currentRemoteUrl(),
    expectedPrompt,
    expectedAttachmentFileNames: [...expectedAttachmentFileNames],
    runIntentAccepted: false,
    networkSubmitted: false,
    networkResponseStarted: false,
    networkResponseComplete: false,
    regenerationAssistantTransitioned: false,
    networkResponseError: undefined,
    submissionConfirmed: false,
    adoptedGeneration: false,
    assistantDomChanged: false,
    userDomChanged: false,
    lastOwnedAssistantMutationAt: Date.now(),
    lastBusyAt: 0,
    consecutiveAttributionIdleSamples: 0,
    consecutiveIdleSamples: 0,
    inspecting: false,
    inspectQueued: false,
    urgentInspectQueued: false,
    lastInspectedAt: 0,
  };
  activeRun = run;

  const inspect = (mutations?: MutationRecord[]) => {
    if (mutations) observeRunMessageMutations(run, mutations);
    void scheduleInspect(run);
  };
  run.observer = new MutationObserver(inspect);
  run.observer.observe(document.body, {
    attributes: true,
    attributeFilter: [
      "aria-busy",
      "class",
      "data-is-streaming",
      "data-message-id",
      "data-streaming",
      "data-testid",
      "data-turn-id",
      "id",
    ],
    childList: true,
    characterData: true,
    subtree: true,
  });
  run.timer = window.setInterval(inspect, 350);
  const parsedStartedAt = typeof startedAt === "string" ? Date.parse(startedAt) : Number.NaN;
  const elapsed = Number.isFinite(parsedStartedAt) ? Math.max(0, Date.now() - parsedStartedAt) : 0;
  run.softTimer = window.setTimeout(
    () => {
      if (activeRun !== run) return;
      void emitRunEvent(run, "slow", run.lastMarkdown).catch(() => undefined);
    },
    Math.max(0, SOFT_RUN_TIMEOUT_MS - elapsed),
  );
  run.hardTimer = window.setTimeout(
    () => {
      if (activeRun !== run) return;
      stopRun();
      void emitError(
        run,
        "RESPONSE_TIMEOUT",
        "等待 ChatGPT 回答超过 30 分钟，标签页已保留，可稍后恢复。",
      ).catch(() => undefined);
    },
    Math.max(0, HARD_RUN_TIMEOUT_MS - elapsed),
  );
  void scheduleInspect(run);
  return run;
}

function observeRunMessageMutations(run: Run, mutations: readonly MutationRecord[]) {
  const latestAssistantElement = latestAssistant();
  const latestUserElement = latestUser();
  const assistantScopes = messageMutationScopes(
    run.responseAttributedAt === undefined
      ? [run.baselineAssistantElement, latestAssistantElement]
      : [run.ownedAssistantElement, latestAssistantElement],
  );
  const userScopes = messageMutationScopes(
    run.responseAttributedAt === undefined
      ? [run.baselineUserElement, latestUserElement]
      : [run.ownedUserElement, latestUserElement],
  );
  for (const mutation of mutations) {
    if (mutationTouchesScopes(mutation, assistantScopes)) {
      run.assistantDomChanged = true;
      run.lastOwnedAssistantMutationAt = Date.now();
      // inspectRun owns the completion sample state. Text changes advance
      // lastChangedAt and visible busy controls make idleSample false; blindly
      // clearing here let harmless class/cursor churn prevent the second
      // confirming idle sample forever.
    }
    if (mutationTouchesScopes(mutation, userScopes)) {
      run.userDomChanged = true;
    }
  }
}

function messageMutationScopes(elements: Array<HTMLElement | undefined>) {
  return [
    ...new Set(
      elements
        .filter((element): element is HTMLElement => Boolean(element))
        .map((element) => boundedMessageTurnScope(element)),
    ),
  ];
}

function mutationTouchesScopes(mutation: MutationRecord, scopes: readonly HTMLElement[]) {
  const target =
    mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
  if (target && scopes.some((scope) => scope === target || scope.contains(target))) return true;

  for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
    const element = node instanceof Element ? node : node.parentElement;
    if (
      element &&
      scopes.some(
        (scope) => scope === element || scope.contains(element) || element.contains(scope),
      )
    ) {
      return true;
    }
  }
  return false;
}

function scheduleInspect(run: Run, urgent = false): Promise<void> {
  if (activeRun !== run) return Promise.resolve();
  let urgentCompletion = Promise.resolve();
  if (urgent) {
    if (!run.urgentInspectQueued) {
      run.urgentInspectQueued = true;
      run.urgentInspectPromise = new Promise<void>((resolve) => {
        run.urgentInspectResolve = resolve;
      });
    }
    urgentCompletion = run.urgentInspectPromise!;
    if (run.inspectTimer !== undefined) {
      window.clearTimeout(run.inspectTimer);
      run.inspectTimer = undefined;
    }
  }
  run.inspectQueued = true;
  if (run.inspecting || run.inspectTimer !== undefined) return urgentCompletion;
  const elapsed = Date.now() - run.lastInspectedAt;
  const forced = run.urgentInspectQueued;
  const wait =
    forced || run.lastInspectedAt === 0 ? 0 : Math.max(0, SNAPSHOT_INSPECT_INTERVAL_MS - elapsed);
  if (wait > 0) {
    run.inspectTimer = window.setTimeout(() => {
      run.inspectTimer = undefined;
      void scheduleInspect(run);
    }, wait);
    return urgentCompletion;
  }
  run.inspectQueued = false;
  const urgentResolve = forced ? run.urgentInspectResolve : undefined;
  if (forced) {
    run.urgentInspectQueued = false;
    run.urgentInspectPromise = undefined;
    run.urgentInspectResolve = undefined;
  }
  run.lastInspectedAt = Date.now();
  run.inspecting = true;
  void (async () => {
    try {
      await inspectRun(run);
    } catch (error) {
      if (activeRun !== run) return;
      stopRun();
      await emitError(
        run,
        classifyPageError(error),
        error instanceof Error ? error.message : "读取 ChatGPT 回答失败。",
      ).catch(() => undefined);
    } finally {
      run.inspecting = false;
      urgentResolve?.();
      if (run.inspectQueued && activeRun === run) {
        void scheduleInspect(run, run.urgentInspectQueued);
      }
    }
  })();
  return urgentCompletion;
}

async function inspectRun(run: Run) {
  if (activeRun !== run) return;
  // Do not fail before the normal attribution pass. The page bridge can report
  // an HTTP/network error after ChatGPT has already rendered this run's answer,
  // especially while the tab is hidden. The policy below distinguishes an
  // empty failed turn (terminal failure) from an observed answer (read-only
  // recovery).
  const blocker = visiblePageBlocker();
  if (blocker) {
    stopRun();
    await emitError(run, blocker.code, blocker.message);
    return;
  }
  const visibleGenerationErrorSignal = visibleCurrentTurnGenerationErrorSignal(run);
  if (visibleGenerationErrorSignal) {
    stopRun();
    await emitError(
      run,
      "CHATGPT_REMOTE_UNAVAILABLE",
      "ChatGPT 页面显示本轮回答生成失败。请打开对应标签页查看原因后重试；本次未自动重试，避免重复提交。",
    );
    return;
  }

  const stopVisible = hasSingleRenderedStopControl();
  if (stopVisible) run.sawStop = true;

  const assistants = assistantCount();
  const assistant = latestAssistant();
  const user = latestUser();
  const serializedCandidate = assistant ? serializeAssistant(assistant) : "";
  const transientAssistantStatus = isTransientAssistantStatus(serializedCandidate);
  const candidate = transientAssistantStatus ? "" : serializedCandidate;
  const inspectedAt = Date.now();
  const assistantBusy = hasAssistantBusySignal(assistant) || transientAssistantStatus;
  const generationBusy = stopVisible || assistantBusy;
  if (generationBusy) {
    run.lastBusyAt = inspectedAt;
    run.consecutiveAttributionIdleSamples = 0;
    run.consecutiveIdleSamples = 0;
  }

  const assistantDomIdentity = messageDomIdentity(assistant);
  const userDomIdentity = messageDomIdentity(user);
  const confirmedUserTurnObserved =
    userMessageCount() > run.baselineUsers ||
    Boolean(user && user !== run.baselineUserElement) ||
    messageIdentityChanged(userDomIdentity, run.baselineUserIdentity);
  const userTurnObserved = confirmedUserTurnObserved || run.userDomChanged;
  const currentSendUserObserved = Boolean(
    run.mode === "send" && user && currentUserTurnMatchesPrompt(run),
  );
  if (currentSendUserObserved || confirmedUserTurnObserved) {
    run.userTurnObservedAt ??= inspectedAt;
  }
  const assistantIdentityChanged =
    Boolean(assistant && assistant !== run.baselineAssistantElement) ||
    messageIdentityChanged(assistantDomIdentity, run.baselineAssistantIdentity);
  const assistantTurnObserved =
    assistants > run.baselineAssistants || assistantIdentityChanged || run.assistantDomChanged;
  if (
    run.mode === "regenerate" &&
    (assistants > run.baselineAssistants ||
      Boolean(assistant && assistant !== run.baselineAssistantElement) ||
      messageIdentityChanged(assistantDomIdentity, run.baselineAssistantIdentity) ||
      Boolean(assistant && candidate !== run.baselineMarkdown))
  ) {
    // The old answer and its Copy/Regenerate actions remain visible while a
    // regeneration request is starting. Do not let those controls prove the
    // new run complete until the assistant output has actually transitioned.
    run.regenerationAssistantTransitioned = true;
  }
  const assistantFollowsCurrentUser = Boolean(
    assistant && user && messageAppearsAfter(assistant, user),
  );
  const lifecycleAttributedTurn =
    run.mode === "send" &&
    lifecycleOwnsVisibleTurn({
      assistantFollowsCurrentUser,
      assistantTurnObserved,
      networkResponseComplete: run.networkResponseComplete,
      networkResponseStarted: run.networkResponseStarted,
      runIntentAccepted: run.runIntentAccepted,
      submissionConfirmed: run.submissionConfirmed,
      userTurnObserved,
    });
  const assistantBelongsToCurrentRun = Boolean(
    (run.mode === "regenerate" &&
      (run.regenerationAssistantTransitioned || run.networkResponseComplete)) ||
    run.adoptedGeneration ||
    ((currentSendUserObserved || lifecycleAttributedTurn) && assistantFollowsCurrentUser),
  );
  const networkAttributed = Boolean(
    run.submissionConfirmed &&
    (run.networkResponseStarted || run.networkResponseComplete) &&
    assistantBelongsToCurrentRun &&
    candidate,
  );
  const directlyAttributed =
    networkAttributed ||
    (run.submissionConfirmed && assistantTurnObserved && assistantBelongsToCurrentRun);
  const attributionQuietFor =
    inspectedAt -
    Math.max(
      run.submissionConfirmedAt ?? inspectedAt,
      run.userTurnObservedAt ?? inspectedAt,
      run.lastChangedAt,
      run.lastOwnedAssistantMutationAt,
      run.lastBusyAt,
    );
  const quietReuseCandidate = Boolean(
    run.submissionConfirmed &&
    run.mode === "send" &&
    !run.adoptedGeneration &&
    !assistantTurnObserved &&
    currentSendUserObserved &&
    assistantFollowsCurrentUser &&
    candidate &&
    !generationBusy &&
    attributionQuietFor >= ATTRIBUTED_IDLE_COMPLETE_STABILITY_MS,
  );
  run.consecutiveAttributionIdleSamples = quietReuseCandidate
    ? run.consecutiveAttributionIdleSamples + 1
    : 0;
  const quietlyAttributed = quietReuseCandidate && run.consecutiveAttributionIdleSamples >= 2;
  const previousOwnedAssistant = run.ownedAssistantElement;
  const previousOwnedUser = run.ownedUserElement;
  const previousOwnedUserIdentity = messageDomIdentity(previousOwnedUser);
  const sameOwnedUser = Boolean(
    user &&
    previousOwnedUser &&
    (user === previousOwnedUser ||
      (userDomIdentity &&
        previousOwnedUserIdentity &&
        userDomIdentity === previousOwnedUserIdentity)),
  );
  const assistantOwnershipEligible = Boolean(
    assistant &&
    assistantBelongsToCurrentRun &&
    (!previousOwnedAssistant || assistant === previousOwnedAssistant || sameOwnedUser),
  );
  const responseAttributed =
    (directlyAttributed || quietlyAttributed) && assistantOwnershipEligible;
  if (responseAttributed && run.responseAttributedAt === undefined) {
    const attributedAt = inspectedAt;
    run.responseAttributedAt = attributedAt;
    run.ownedAssistantElement = assistant;
    run.ownedUserElement = user;
    // Direct evidence may arrive mid-generation, so completion must settle
    // after attribution. The quiet-reuse fallback has already proved 2.5 s of
    // stable ownership and must not restart that whole delay.
    if (!quietlyAttributed) run.lastOwnedAssistantMutationAt = attributedAt;
    run.consecutiveIdleSamples = 0;
  } else if (responseAttributed) {
    // Ownership is sticky. React may replace the assistant node while keeping
    // (or stably identifying) this run's user node, but a virtualized current
    // turn must never let the previous user/assistant pair take ownership.
    if (assistant !== previousOwnedAssistant && sameOwnedUser) {
      run.ownedAssistantElement = assistant;
    }
    if (user !== previousOwnedUser && sameOwnedUser) {
      run.ownedUserElement = user;
    }
  }
  const responsePreviouslyObserved = Boolean(run.lastObservedMarkdown || run.lastMarkdown);
  const assistantIsOwned = Boolean(assistant && assistant === run.ownedAssistantElement);
  const ownedStopEnded = Boolean(
    run.sawStop && !stopVisible && assistantIsOwned && user === run.ownedUserElement,
  );
  const cachedResponseCanSettle = Boolean(
    responsePreviouslyObserved &&
    (!assistant || assistantIsOwned) &&
    (run.networkResponseComplete || ownedStopEnded),
  );
  const responseStarted = Boolean(
    run.submissionConfirmed &&
    (cachedResponseCanSettle ||
      (assistantIsOwned &&
        (run.responseAttributedAt !== undefined ||
          hasResponseStarted({
            assistantCount: assistants,
            baselineAssistants: run.baselineAssistants,
            sawStop: run.sawStop,
            submissionConfirmed: run.submissionConfirmed,
            assistantIdentityChanged,
            assistantDomChanged: run.assistantDomChanged,
            userTurnObserved,
            regeneration: run.mode === "regenerate",
            markdown: candidate,
            baselineMarkdown: run.baselineMarkdown,
          })))),
  );

  if (responseStarted && assistantIsOwned && candidate && run.responseAttributedAt === undefined) {
    // Once this exact submitted turn has produced serializable assistant text,
    // the response-start watchdog must never later describe it as invisible.
    run.responseAttributedAt = inspectedAt;
    run.ownedAssistantElement = assistant;
    run.ownedUserElement = user;
    run.lastOwnedAssistantMutationAt = inspectedAt;
    run.consecutiveIdleSamples = 0;
  }

  if (responseStarted && assistantIsOwned && candidate && candidate !== run.lastObservedMarkdown) {
    assertMarkdownFits(candidate);
    run.lastObservedMarkdown = candidate;
    run.lastChangedAt = Date.now();
  }
  if (responseStarted && assistantIsOwned && candidate && candidate !== run.lastMarkdown) {
    const delivered = await emitRunEvent(run, "snapshot", candidate);
    if (delivered) run.lastMarkdown = candidate;
  }
  if (activeRun !== run) return;

  const responseActionsPresent = Boolean(
    assistantIsOwned &&
    hasResponseActions(assistant) &&
    (run.mode !== "regenerate" || run.regenerationAssistantTransitioned),
  );
  if (responseStarted && responseActionsPresent) run.sawResponseActions = true;
  if (run.submissionConfirmed && run.networkResponseError) {
    const failure = run.networkResponseError;
    const failureDecision = networkResponseFailureDecision({
      failureKind: failure.kind,
      generationBusy,
      responseObserved: Boolean(run.lastObservedMarkdown || run.lastMarkdown),
      terminalEvidence: run.sawResponseActions || ownedStopEnded,
    });
    if (failureDecision === "fail") {
      throw networkResponseFailure(failure);
    }
    if (failureDecision === "recover") {
      // A cloned stream can fail independently after ChatGPT has already
      // rendered text. Keep the exact run alive and ask the worker for
      // read-only recovery instead of surfacing a contradictory tail error.
      void emitRecoveryRequest(run, "network-complete-dom-missing").catch(() => undefined);
    }
    run.networkResponseError = undefined;
  }
  // Non-text UI churn such as cursor/class animations must not keep extending
  // an attributed run forever. Markdown changes and visible busy controls are
  // the signals that reset terminal text stability through
  // lastChangedAt/lastBusyAt; lastOwnedAssistantMutationAt remains relevant to
  // the stricter attribution fallback above, but not after ownership is known.
  const documentVisible = document.visibilityState === "visible";
  const terminalDomEvidence = run.sawResponseActions || ownedStopEnded;
  // A completed transport is useful terminal evidence only while the document
  // is visible. Hidden React trees can freeze after rendering a prefix of the
  // answer, so they must either expose a strong terminal control or enter the
  // worker's exact-transcript recovery path.
  const terminalResponseEvidence = documentVisible
    ? terminalDomEvidence || run.networkResponseComplete
    : terminalDomEvidence;
  const settledFor =
    inspectedAt - Math.max(run.lastChangedAt, run.lastBusyAt, run.networkResponseCompleteAt ?? 0);
  const hiddenAttributedStall = Boolean(
    !documentVisible &&
    !run.networkResponseComplete &&
    !terminalResponseEvidence &&
    run.submissionConfirmed &&
    run.responseAttributedAt !== undefined &&
    (run.lastObservedMarkdown || run.lastMarkdown) &&
    !generationBusy &&
    settledFor >= HIDDEN_ATTRIBUTED_IDLE_RECOVERY_MS,
  );
  if (
    hiddenAttributedStall &&
    (run.lastRecoveryRequestedAt === undefined ||
      inspectedAt - run.lastRecoveryRequestedAt >= 5_000)
  ) {
    run.lastRecoveryRequestedAt = inspectedAt;
    void emitRecoveryRequest(run, "hidden-attributed-stall").catch(() => undefined);
  }
  const requiredStability = terminalDomEvidence
    ? COMPLETE_ACTION_STABILITY_MS
    : documentVisible && run.networkResponseComplete
      ? RESPONSE_COMPLETE_DOM_GRACE_MS
      : ATTRIBUTED_IDLE_COMPLETE_STABILITY_MS;
  const hiddenTerminalEvidence = terminalDomEvidence;
  const idleSample = Boolean(
    (documentVisible || hiddenTerminalEvidence) &&
    responseStarted &&
    run.responseAttributedAt !== undefined &&
    (run.lastObservedMarkdown || run.lastMarkdown) &&
    !generationBusy &&
    settledFor >= requiredStability,
  );
  run.consecutiveIdleSamples = idleSample ? run.consecutiveIdleSamples + 1 : 0;
  if (idleSample && run.consecutiveIdleSamples >= 2) {
    const markdown = run.lastObservedMarkdown || run.lastMarkdown;
    const delivered = await emitRunEvent(run, "complete", markdown);
    if (delivered && activeRun === run) stopRun();
  }
}

function stopRun() {
  const run = activeRun;
  if (!run) return;
  run.observer?.disconnect();
  if (run.timer) window.clearInterval(run.timer);
  if (run.inspectTimer !== undefined) window.clearTimeout(run.inspectTimer);
  if (run.softTimer) window.clearTimeout(run.softTimer);
  if (run.hardTimer) window.clearTimeout(run.hardTimer);
  if (run.responseStartTimer !== undefined) window.clearTimeout(run.responseStartTimer);
  run.urgentInspectResolve?.();
  run.urgentInspectQueued = false;
  run.urgentInspectPromise = undefined;
  run.urgentInspectResolve = undefined;
  activeRun = undefined;
}

function stopRunIfMatching(command: Pick<ContentCommand, "conversationId" | "runId">) {
  if (activeRun?.conversationId === command.conversationId && activeRun.runId === command.runId) {
    stopRun();
  }
}

function assertExpectedCommandPage(command: ContentCommand) {
  const currentPageUrl = currentRemoteUrl();
  const currentProject = parseContentProjectPageUrl(currentPageUrl);
  if (
    !command.expectedProjectScope ||
    !currentProject ||
    !contentProjectScopesMatch(currentProject.scope, command.expectedProjectScope)
  ) {
    throw pageError("CHATGPT_PROJECT_MISMATCH", "ChatGPT 页面已离开 Ask2GPT Project；未提交问题。");
  }
  if (
    !contentPreDispatchPageMatches({
      expectedRemoteUrl: command.expectedRemoteUrl,
      currentPageUrl,
      allowFirstConversation: command.allowFirstConversation === true,
    })
  ) {
    throw pageError("CHATGPT_REMOTE_UNAVAILABLE", "ChatGPT 页面已离开当前映射的会话；未提交问题。");
  }
}

async function validateDispatchCommandPage(command: ContentCommand): Promise<ContentCommand> {
  try {
    assertExpectedCommandPage(command);
    return command;
  } catch (originalError) {
    if (classifyPageError(originalError) !== "CHATGPT_REMOTE_UNAVAILABLE") {
      throw originalError;
    }
    const expectedRemoteUrl = command.expectedRemoteUrl;
    const observedRemoteUrl = currentRemoteUrl();
    const observedProject = parseContentProjectPageUrl(observedRemoteUrl);
    if (
      command.allowFirstConversation ||
      !expectedRemoteUrl ||
      !observedRemoteUrl ||
      !isContentConversationRemoteUrl(observedRemoteUrl) ||
      !command.expectedProjectScope ||
      !observedProject ||
      !contentProjectScopesMatch(observedProject.scope, command.expectedProjectScope)
    ) {
      throw originalError;
    }

    const response = await emit({
      type: "content.validateDispatchPage",
      conversationId: command.conversationId,
      runId: command.runId,
      expectedRemoteUrl,
      observedRemoteUrl,
    }).catch(() => undefined);
    if (
      !isContentRecord(response) ||
      response.ok !== true ||
      normalizeContentRemoteUrl(response.expectedRemoteUrl) !== observedRemoteUrl
    ) {
      throw originalError;
    }

    const validatedCommand = { ...command, expectedRemoteUrl: observedRemoteUrl };
    assertExpectedCommandPage(validatedCommand);
    return validatedCommand;
  }
}

function assertPageReady() {
  const blocker = visiblePageBlocker();
  if (blocker) throw pageError(blocker.code, blocker.message);
}

function visiblePageBlocker():
  { code: "CHATGPT_LOGIN_REQUIRED" | "CHATGPT_CHALLENGE_REQUIRED"; message: string } | undefined {
  const text = document.body.innerText.slice(0, 12_000);
  if (/log in|sign up|登录|登入|注册/i.test(text) && findComposerElements(true).length === 0) {
    return { code: "CHATGPT_LOGIN_REQUIRED", message: "请先在 Chrome 中登录 ChatGPT。" };
  }
  if (
    /captcha|verify you are human|checking your browser|challenge-platform|验证您是人类/i.test(text)
  ) {
    return {
      code: "CHATGPT_CHALLENGE_REQUIRED",
      message: "ChatGPT 正在请求人工验证，请在 Chrome 中完成。",
    };
  }
  return undefined;
}

async function waitForComposerCommit() {
  await waitForComposerCommitTurn();
  await waitForComposerCommitTurn();
}

async function writeStableComposerPrompt(prompt: string) {
  for (let attempt = 0; attempt < COMPOSER_WRITE_ATTEMPTS; attempt += 1) {
    let composer = await waitForUniqueComposer(attempt === 0 ? 10_000 : 2_000);
    if (!composerTextMatchesPrompt(composer, prompt)) setComposerText(composer, prompt);
    if (!composerTextMatchesPrompt(composer, prompt)) continue;

    // A synthetic input can cause React to replace the editor after the event
    // handler has returned. Only pre-submit writes are retried: once a send
    // control is clicked, the existing submission proof remains authoritative
    // and this helper is never called again.
    await waitForComposerCommit();
    let stable = true;
    for (let sample = 0; sample < COMPOSER_STABILITY_SAMPLES; sample += 1) {
      await delay(COMPOSER_STABILITY_SAMPLE_MS);
      const live = findComposerElements(true);
      if (live.length !== 1) {
        stable = false;
        break;
      }
      const currentComposer = live[0]!;
      if (!currentComposer.isConnected || !composerTextMatchesPrompt(currentComposer, prompt)) {
        stable = false;
        break;
      }
      // React may replace the editor node while preserving its controlled
      // value. The unique, connected editor with an exact full-text match is
      // the authoritative pre-submit composer, even when its node identity
      // changed. Returning it also moves subsequent form/button lookup to the
      // replacement form instead of the stale one.
      composer = currentComposer;
    }
    if (stable) return composer;
  }
  throw pageError(
    "SELECTOR_INCOMPATIBLE",
    "ChatGPT 输入框在发送前反复刷新，Ask2GPT 未提交问题。请稍后重试。",
  );
}

function waitForComposerCommitTurn() {
  return new Promise<void>((resolve) => {
    let settled = false;
    let frame: number | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(fallback);
      if (frame !== undefined && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(frame);
      }
      resolve();
    };
    const fallback = window.setTimeout(finish, COMPOSER_COMMIT_FRAME_FALLBACK_MS);
    if (typeof window.requestAnimationFrame === "function") {
      frame = window.requestAnimationFrame(finish);
    }
  });
}

async function waitForUniqueComposer(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates = findComposerElements(true);
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length > 1) {
      throw pageError(
        "SELECTOR_INCOMPATIBLE",
        `ChatGPT 页面出现多个可见输入框，已停止以避免误发送。 ${composerErrorDiagnostic()}`,
      );
    }
    await delay(150);
  }
  const rawCandidateCount = findRawComposerElements().length;
  if (rawCandidateCount > 0) {
    throw pageError(
      "SELECTOR_INCOMPATIBLE",
      `检测到 ChatGPT 输入候选，但无法确认唯一安全的发送区域；问题尚未写入或发送。 ${composerErrorDiagnostic()}`,
    );
  }
  throw pageError(
    "CHATGPT_COMPOSER_MISSING",
    `页面中未检测到 ChatGPT 主输入框；问题尚未发送。 ${composerErrorDiagnostic()}`,
  );
}

function composerErrorDiagnostic() {
  const boundedCount = (count: number) => Math.min(32, count);
  return `raw=${boundedCount(findRawComposerElements().length)} ready=${boundedCount(findComposerElements(true).length)} visibility=${document.visibilityState === "visible" ? "visible" : "hidden"}`;
}

function findComposerElements(visibleOnly: boolean, scope: ParentNode = document) {
  const candidates = new Set<HTMLElement>();
  const ariaHiddenFallbacks = new Set<HTMLElement>();
  for (const candidate of findRawComposerElements(scope)) {
    if (!isWritableComposer(candidate)) continue;
    const ownership = composerOwnership(candidate);
    if (!ownership) continue;
    // ChatGPT can remove the empty-state send button after a completed turn and
    // create it only after the next prompt is written. A visible writable
    // composer in one bounded form is sufficient pre-write proof; submission
    // still requires one exact owned control to appear, become visible and
    // become enabled before anything is clicked.
    if (visibleOnly && !isVisible(candidate)) {
      if (visibilityBlocker(candidate) === "aria-hidden" && candidate.id === "prompt-textarea") {
        ariaHiddenFallbacks.add(candidate);
      }
      continue;
    }
    candidates.add(candidate);
  }
  if (candidates.size > 0 || !visibleOnly) return [...candidates];
  return ariaHiddenFallbacks.size === 1 ? [...ariaHiddenFallbacks] : [];
}

const excludedComposerScopeSelector = [
  "[data-message-author-role]",
  '[data-testid^="conversation-turn"]',
  "dialog",
  '[role="dialog"]',
  '[aria-modal="true"]',
  "[popover]",
].join(", ");

interface ComposerOwnership {
  scope: HTMLElement;
  form?: HTMLFormElement;
  sendControl?: HTMLElement;
}

function composerOwnership(candidate: HTMLElement): ComposerOwnership | undefined {
  if (candidate.closest(excludedComposerScopeSelector)) return undefined;
  const form = candidate.closest("form");
  if (form) {
    if (form.closest(excludedComposerScopeSelector)) return undefined;
    const ownedSendControls = composerSendControls(candidate, form, true);
    const sendControl = uniqueComposerSendControl(candidate, form, true);
    if (sendControl) return { scope: form, form, sendControl };
    // Current ChatGPT removes the submit control while a follow-up composer is
    // empty, then inserts a new one in response to the input event. Zero known
    // visible controls is a safe provisional state for a high-confidence
    // composer inside its own form. Generic feedback/settings textareas do not
    // qualify without a send-control ownership proof. Multiple visible
    // controls remain ambiguous and fail closed.
    if (
      ownedSendControls.every((control) => !isVisible(control)) &&
      provisionalFormComposerSelectors.some((selector) => candidate.matches(selector))
    ) {
      return { scope: form, form };
    }
    return undefined;
  }

  let scope = candidate.parentElement;
  for (let depth = 0; scope && depth < 10; depth += 1, scope = scope.parentElement) {
    if (
      scope.matches('main, [role="main"], body, html') ||
      scope.closest(excludedComposerScopeSelector) ||
      scope.querySelector('[data-message-author-role], [data-testid^="conversation-turn"]')
    ) {
      break;
    }
    const visibleWritableComposers = findRawComposerElements(scope).filter(
      (composer) =>
        isWritableComposer(composer) &&
        isVisible(composer) &&
        !composer.closest(excludedComposerScopeSelector),
    );
    if (visibleWritableComposers.length !== 1 || visibleWritableComposers[0] !== candidate) {
      continue;
    }
    const sendControl = uniqueComposerSendControl(candidate, scope, false, true);
    if (sendControl) return { scope, sendControl };
  }
  return undefined;
}

function uniqueComposerSendControl(
  candidate: HTMLElement,
  scope: HTMLElement,
  requireSameForm: boolean,
  requireVisible = false,
) {
  const ownedSendControls = composerSendControls(candidate, scope, requireSameForm);
  const visibleSendControls = ownedSendControls.filter(isComposerActuationVisible);
  if (requireVisible) return visibleSendControls.length === 1 ? visibleSendControls[0] : undefined;
  const sendControls = visibleSendControls.length > 0 ? visibleSendControls : ownedSendControls;
  return sendControls.length === 1 ? sendControls[0] : undefined;
}

function composerSendControls(
  candidate: HTMLElement,
  scope: HTMLElement,
  requireSameForm: boolean,
) {
  const candidateForm = candidate.closest("form");
  return findElements(selectors.send, scope).filter(
    (control) =>
      !control.closest(excludedComposerScopeSelector) &&
      (!requireSameForm || control.closest("form") === scope) &&
      (candidateForm
        ? control.closest("form") === candidateForm
        : control.closest("form") === null),
  );
}

function isWritableComposer(candidate: HTMLElement) {
  if (
    candidate.hasAttribute("disabled") ||
    candidate.getAttribute("aria-disabled") === "true" ||
    candidate.hasAttribute("readonly") ||
    candidate.getAttribute("aria-readonly") === "true"
  ) {
    return false;
  }
  if (candidate instanceof HTMLTextAreaElement) {
    return !candidate.disabled && !candidate.readOnly;
  }
  if (candidate.matches('#prompt-textarea.ProseMirror[role="textbox"][aria-multiline="true"]')) {
    return true;
  }
  const editable = candidate.getAttribute("contenteditable");
  return editable === "" || editable === "true" || editable === "plaintext-only";
}

function findRawComposerElements(scope: ParentNode = document) {
  const candidates = new Set<HTMLElement>(findElements(selectors.composer, scope));
  for (const candidate of findElements(structuredComposerSelectors, scope)) {
    if (
      candidate instanceof HTMLTextAreaElement ||
      candidate.getAttribute("contenteditable") === "" ||
      candidate.getAttribute("contenteditable") === "true" ||
      candidate.getAttribute("contenteditable") === "plaintext-only"
    ) {
      candidates.add(candidate);
    }
  }
  return [...candidates];
}

async function waitForOwnedComposerSendButton(composer: HTMLElement, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ownership = composerOwnership(composer);
    const sendControl = ownership?.sendControl;
    if (
      sendControl &&
      composer.isConnected &&
      isWritableComposer(composer) &&
      isComposerActuationVisible(composer) &&
      isComposerActuationVisible(sendControl) &&
      isEnabledSendButton(sendControl)
    ) {
      return sendControl;
    }
    await delay(120);
  }
  throw pageError("CHATGPT_SEND_FAILED", "ChatGPT 发送按钮不可用。");
}

function findVisibleElements(selectorList: readonly string[], scope: ParentNode = document) {
  return findElements(selectorList, scope).filter(isVisible);
}

function findRenderedControlEvidence(
  selectorList: readonly string[],
  scope: ParentNode = document,
) {
  return findElements(selectorList, scope).filter(isRenderedControlEvidence);
}

function findElements(selectorList: readonly string[], scope: ParentNode = document) {
  const results = new Set<HTMLElement>();
  for (const selector of selectorList) {
    for (const candidate of scope.querySelectorAll<HTMLElement>(selector)) {
      results.add(candidate);
    }
  }
  return [...results];
}

function hasSingleRenderedStopControl() {
  const candidates = findRenderedControlEvidence(selectors.stop);
  if (candidates.length > 1) {
    throw pageError(
      "SELECTOR_INCOMPATIBLE",
      "ChatGPT 页面出现多个停止控件，无法可靠识别当前生成任务。",
    );
  }
  return candidates.length === 1;
}

function visibilityBlocker(element: HTMLElement) {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden) return "hidden";
    if (current.hasAttribute("inert")) return "inert";
    if (current.getAttribute("aria-hidden") === "true") return "aria-hidden";
    const currentStyle = getComputedStyle(current);
    if (currentStyle.display === "none") return "display";
    if (currentStyle.visibility === "hidden" || currentStyle.visibility === "collapse") {
      return "visibility";
    }
    // `pointer-events: none` on an HTML ancestor does not necessarily make a
    // descendant inert: ChatGPT's fixed thread-bottom shell disables pointer
    // events and its inner composer explicitly restores `auto`. The candidate's
    // computed value already includes inheritance, so reject only the candidate.
    if (current === element && currentStyle.pointerEvents === "none") return "pointer";
    if (currentStyle.opacity === "0") return "opacity";
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return "geometry";
  if (
    rect.right <= 0 ||
    rect.bottom <= 0 ||
    rect.left >= window.innerWidth ||
    rect.top >= window.innerHeight
  ) {
    return "outside";
  }
  return undefined;
}

function isVisible(element: HTMLElement) {
  return visibilityBlocker(element) === undefined;
}

function isComposerActuationVisible(element: HTMLElement) {
  const blocker = visibilityBlocker(element);
  return blocker === undefined || blocker === "aria-hidden";
}

// Completed-response actions are read-only terminal evidence, not controls
// Relay intends to click. ChatGPT can leave them rendered while applying
// `pointer-events: none` to a background tab, so keep the stricter `isVisible`
// predicate for composer/send/stop controls and ignore hit-testing only here.
function isRenderedControlEvidence(element: HTMLElement) {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (
      current.hidden ||
      current.hasAttribute("inert") ||
      current.getAttribute("aria-hidden") === "true"
    ) {
      return false;
    }
    const currentStyle = getComputedStyle(current);
    if (
      currentStyle.display === "none" ||
      currentStyle.visibility === "hidden" ||
      currentStyle.visibility === "collapse" ||
      currentStyle.opacity === "0"
    ) {
      return false;
    }
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isRenderedConversationMessage(element: HTMLElement) {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden || current.inert || current.getAttribute("aria-hidden") === "true") {
      return false;
    }
    const style = getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.opacity === "0"
    ) {
      return false;
    }
    if (current === document.body || current === document.documentElement) break;
  }
  return true;
}

function renderedConversationMessageElements() {
  return [
    ...document.querySelectorAll<HTMLElement>(`${selectors.users}, ${selectors.assistants}`),
  ].filter(isRenderedConversationMessage);
}

function renderedMessages(selector: string) {
  return [...document.querySelectorAll<HTMLElement>(selector)].filter(
    isRenderedConversationMessage,
  );
}

function latestAssistant() {
  return renderedMessages(selectors.assistants).at(-1);
}

function latestUser() {
  return renderedMessages(selectors.users).at(-1);
}

function messageAppearsAfter(message: HTMLElement, precedingMessage: HTMLElement) {
  return Boolean(
    precedingMessage.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

function visibleCurrentTurnGenerationErrorSignal(run: Run) {
  if (run.mode !== "send" || !run.submissionConfirmed || !currentUserTurnMatchesPrompt(run)) {
    return undefined;
  }
  const user = latestUser();
  if (!user) return undefined;
  const assistant = latestAssistant();
  // A current assistant turn owns its own actions. In particular, never
  // mistake an older assistant's Retry/Error control for this run.
  if (assistant && messageAppearsAfter(assistant, user)) return undefined;
  for (const candidate of document.querySelectorAll<HTMLElement>(
    CURRENT_TURN_GENERATION_ERROR_SELECTOR,
  )) {
    if (
      candidate === user ||
      user.contains(candidate) ||
      !isVisible(candidate) ||
      !messageAppearsAfter(candidate, user)
    ) {
      continue;
    }
    const signal = generationErrorCandidateSignal(candidate);
    if (signal) return signal;
  }
  return undefined;
}

function generationErrorCandidateSignal(candidate: HTMLElement) {
  const testId = candidate.getAttribute("data-testid") ?? "";
  if (/error/iu.test(testId)) return "testid-error";
  if (/retry/iu.test(testId)) return "testid-retry";
  if (candidate.getAttribute("role") !== "alert") return undefined;
  const text = visibleMessageText(candidate).slice(0, 1_000);
  return /(?:error|failed|failure|something went wrong|try again|retry|出错|失败|重试|无法生成|未能生成)/iu.test(
    text,
  )
    ? "role-alert-error-text"
    : undefined;
}

function messageDomIdentity(message: HTMLElement | undefined) {
  if (!message) return undefined;
  const parts: string[] = [];
  let candidate: HTMLElement | null = message;
  for (let depth = 0; candidate && depth < 8; depth += 1) {
    const messageId = normalizedDomIdentity(candidate.getAttribute("data-message-id"));
    if (messageId) parts.push(`${depth}:data-message-id:${messageId}`);

    const testId = normalizedDomIdentity(candidate.getAttribute("data-testid"));
    if (testId && /(?:^|-)conversation-turn(?:-|$)/iu.test(testId)) {
      parts.push(`${depth}:data-testid:${testId}`);
    }

    const turnId = normalizedDomIdentity(candidate.getAttribute("data-turn-id"));
    if (turnId) parts.push(`${depth}:data-turn-id:${turnId}`);

    const id = normalizedDomIdentity(candidate.id);
    if (id) parts.push(`${depth}:id:${id}`);
    candidate = candidate.parentElement;
  }
  return parts.length > 0 ? JSON.stringify(parts) : undefined;
}

function normalizedDomIdentity(value: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 256) : undefined;
}

function messageIdentityChanged(current: string | undefined, baseline: string | undefined) {
  return current !== undefined && current !== baseline;
}

function visibleMessageText(message: HTMLElement | undefined) {
  return (message?.innerText ?? message?.textContent ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/\u00a0/gu, " ")
    .trim();
}

function currentUserTurnMatchesPrompt(run: Run) {
  if (!run.expectedPrompt) return false;
  const user = latestUser();
  if (!user) return false;
  const currentText = visibleMessageText(user);
  const expectedPrompt = run.expectedPrompt.trim();
  // This comparison is scoped to the content-side run created immediately
  // before the one owned send actuation. ChatGPT may expose that multiline prompt
  // as one paragraph in both the composer and the resulting user turn.
  const renderedPromptMatches = renderedTextMatchesPrompt(currentText, expectedPrompt, {
    allowSingleBlockLineFolding: true,
  });
  const attachmentPromptPresentation = expectedPrompt.includes("\u00a0")
    ? expectedPrompt
    : singleBlockPromptPresentation(expectedPrompt);
  const promptMatches =
    renderedPromptMatches ||
    (run.expectedAttachmentFileNames.length > 0 &&
      (currentText.includes(expectedPrompt) ||
        currentText.includes(attachmentPromptPresentation)) &&
      run.expectedAttachmentFileNames.every((fileName) => currentText.includes(fileName)));
  if (!promptMatches) return false;
  // Polling must be able to prove an in-place virtualized follow-up even when
  // Chrome delayed the MutationObserver callback while the owned tab was in
  // the background. The exact expected prompt plus a value different from the
  // dispatch baseline is itself new-turn evidence; requiring userDomChanged
  // here made the observer a hidden single point of failure and left a fully
  // rendered user/assistant pair unattributed indefinitely.
  return Boolean(
    userMessageCount() > run.baselineUsers ||
    user !== run.baselineUserElement ||
    messageIdentityChanged(messageDomIdentity(user), run.baselineUserIdentity) ||
    currentText !== run.baselineUserText,
  );
}

function networkResponseFailure(failure: RunNetworkFailure) {
  if (failure.kind === "http") {
    const status = failure.httpStatus;
    if (status === 401 || status === 403) {
      return pageError(
        "CHATGPT_REMOTE_UNAVAILABLE",
        `ChatGPT 返回 HTTP ${status}：当前网页登录状态或账户权限无效。请在该 ChatGPT 标签页完成登录或访问确认后重试；本次未自动重试，避免重复提交。`,
      );
    }
    if (status === 413) {
      return pageError(
        "CHATGPT_REMOTE_UNAVAILABLE",
        "ChatGPT 返回 HTTP 413：本次问题或附件过大。请缩小上下文或附件后重试；本次未自动重试。",
      );
    }
    if (status === 429) {
      return pageError(
        "CHATGPT_REMOTE_UNAVAILABLE",
        "ChatGPT 返回 HTTP 429：请求过于频繁或账户暂时受限。请稍后重试；本次未自动重试，避免重复提交。",
      );
    }
    if (status !== undefined && status >= 500) {
      return pageError(
        "CHATGPT_REMOTE_UNAVAILABLE",
        `ChatGPT 返回 HTTP ${status}：服务暂时不可用。请稍后重试；本次未自动重试，避免重复提交。`,
      );
    }
    return pageError(
      "CHATGPT_REMOTE_UNAVAILABLE",
      `ChatGPT 拒绝了本次请求${status === undefined ? "" : `（HTTP ${status}）`}。请打开对应标签页检查会话、模型、Project 或附件状态后重试；本次未自动重试。`,
    );
  }
  if (failure.kind === "network") {
    return pageError(
      "CHATGPT_REMOTE_UNAVAILABLE",
      "浏览器未能连接到 ChatGPT。请检查网络和 ChatGPT 标签页后重试；本次未自动重试，避免重复提交。",
    );
  }
  if (failure.kind === "stream") {
    return pageError(
      "CHATGPT_REMOTE_UNAVAILABLE",
      "ChatGPT 回答流在传输过程中断。请打开对应标签页确认远端状态后再重试；本次未自动重试，避免重复提交。",
    );
  }
  return pageError(
    "CHATGPT_REMOTE_UNAVAILABLE",
    "ChatGPT 响应连接失败；Ask2GPT 已停止本次生成，未自动重试，以避免重复提交。",
  );
}

function latestAssistantMarkdown() {
  const element = latestAssistant();
  return element ? usableAssistantMarkdown(serializeAssistant(element)) : "";
}

function assistantCount() {
  return renderedMessages(selectors.assistants).length;
}

function userMessageCount() {
  return renderedMessages(selectors.users).length;
}

function responseMarkdown(run: Run) {
  // Recovery checkpoints may inspect a candidate before the page observer has
  // proved that it belongs to this run. Never forward that text to the Host;
  // doing so can overwrite an older assistant in a virtualized transcript.
  if (run.responseAttributedAt === undefined) return "";
  const assistant = latestAssistant();
  const ownedCandidate =
    assistant && assistant === run.ownedAssistantElement
      ? usableAssistantMarkdown(serializeAssistant(assistant))
      : "";
  return ownedCandidate || run.lastObservedMarkdown || run.lastMarkdown;
}

function hasResponseActions(assistant = latestAssistant()) {
  const scope = assistant ? boundedMessageTurnScope(assistant) : undefined;
  if (!scope) return false;
  return [...scope.querySelectorAll<HTMLElement>('button, [role="button"]')].some(
    (button) =>
      isRenderedControlEvidence(button) &&
      button.getAttribute("aria-disabled") !== "true" &&
      !(button instanceof HTMLButtonElement && button.disabled) &&
      (button.dataset.testid === "copy-turn-action-button" ||
        /copy|regenerate|more actions|good response|bad response|share|复制|重新生成|更多操作/i.test(
          accessibleLabel(button),
        )),
  );
}

function hasAssistantBusySignal(assistant: HTMLElement | undefined) {
  if (!assistant) return false;
  const scope = boundedMessageTurnScope(assistant);
  const busySignals = [
    ...(scope.matches(ASSISTANT_BUSY_SELECTOR) ? [scope] : []),
    ...scope.querySelectorAll<HTMLElement>(ASSISTANT_BUSY_SELECTOR),
  ];
  if (busySignals.some((signal) => isRenderedControlEvidence(signal))) {
    return true;
  }
  return [...scope.querySelectorAll<HTMLElement>("button")].some(
    (button) =>
      isRenderedControlEvidence(button) &&
      /stop generating|stop response|停止生成/i.test(accessibleLabel(button)),
  );
}

function boundedMessageTurnScope(message: HTMLElement) {
  let candidate: HTMLElement | null = message;
  for (let depth = 0; candidate && depth < 8; depth += 1) {
    if (
      candidate.matches(
        'article, [data-testid^="conversation-turn-"], [data-turn-id], [data-turn="assistant"]',
      ) &&
      scopeContainsOnlyMessage(candidate, message)
    ) {
      return candidate;
    }
    candidate = candidate.parentElement;
  }
  return message;
}

function scopeContainsOnlyMessage(scope: HTMLElement, message: HTMLElement) {
  const messages = [
    ...(scope.matches(selectors.assistants) || scope.matches(selectors.users) ? [scope] : []),
    ...scope.querySelectorAll<HTMLElement>(`${selectors.users}, ${selectors.assistants}`),
  ];
  return messages.length === 1 && messages[0] === message;
}

function accessibleLabel(element: Element) {
  return (
    element.getAttribute("aria-label") ||
    element.getAttribute("data-testid") ||
    element.textContent ||
    ""
  ).trim();
}

async function waitForSubmission(run: Run, timeoutMs: number) {
  return await waitForRunEvidence(
    run,
    timeoutMs,
    () =>
      run.networkResponseStarted ||
      run.networkResponseComplete ||
      currentUserTurnMatchesPrompt(run),
  );
}

async function waitForRegenerationStart(run: Run, timeoutMs: number) {
  // DOM mutations are not enough to confirm a non-idempotent regenerate
  // click: an old answer's actions can churn without a request being sent.
  return await waitForRunEvidence(run, timeoutMs, () => run.networkSubmitted);
}

function waitForRunEvidence(run: Run, timeoutMs: number, hasEvidence: () => boolean) {
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      observer.disconnect();
      document.removeEventListener(RUN_LIFECYCLE_EVENT, inspect, true);
      window.clearTimeout(timeout);
    };
    const settle = (value: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const inspect = () => {
      if (settled) return;
      try {
        if (activeRun !== run) {
          settle(false);
          return;
        }
        if (run.networkResponseError) {
          settle(false, networkResponseFailure(run.networkResponseError));
          return;
        }
        if (hasEvidence()) {
          settle(true);
          return;
        }
        const blocker = visiblePageBlocker();
        if (blocker) settle(false, pageError(blocker.code, blocker.message));
      } catch (error) {
        settle(
          false,
          error instanceof Error ? error : new Error("ChatGPT page inspection failed."),
        );
      }
    };

    const observer = new MutationObserver(inspect);
    observer.observe(document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    document.addEventListener(RUN_LIFECYCLE_EVENT, inspect, true);
    const timeout = window.setTimeout(() => settle(false), timeoutMs);
    inspect();
  });
}

async function waitForStopControlToDisappear(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (findRenderedControlEvidence(selectors.stop).length === 0) return true;
    await delay(100);
  }
  return false;
}

function assertMarkdownFits(markdown: string) {
  if (contentUtf8ByteLength(markdown) > MAX_CONTENT_MARKDOWN_BYTES) {
    throw pageError("FRAME_TOO_LARGE", "ChatGPT 回答超过本地中转单帧上限，已停止读取。");
  }
}

async function emitRunEvent(
  run: Pick<Run, "conversationId" | "runId">,
  eventType: "snapshot" | "slow" | "complete" | "stopped",
  markdown: string,
  options: { networkResponse?: boolean } = {},
) {
  assertMarkdownFits(markdown);
  // A fast answer can reach its terminal DOM state before ChatGPT promotes the
  // page from `/` (or a project root) to `/c/...`. The exact page-side run id
  // is already bound to the owned tab, so do not hold back answer events on a
  // route transition. The relay will retry non-terminal snapshots without a
  // URL and can finalize terminal events with an optional remote URL.
  const pageUrl = currentRemoteUrl();
  const networkRun = run as Pick<Run, "baselineRemoteUrl">;
  const remoteUrl =
    pageUrl &&
    isContentConversationRemoteUrl(pageUrl) &&
    (!options.networkResponse || Boolean(networkRun.baselineRemoteUrl))
      ? pageUrl
      : undefined;
  const title =
    eventType === "slow" || !remoteUrl ? undefined : visibleConversationTitle(remoteUrl);
  const acknowledgement = await emit({
    type: "content.event",
    eventType,
    conversationId: run.conversationId,
    runId: run.runId,
    markdown,
    ...(remoteUrl ? { remoteUrl } : {}),
    ...(title ? { title } : {}),
  });
  return isContentRecord(acknowledgement) && acknowledgement.ok === true;
}

async function emit(event: Record<string, unknown>): Promise<unknown> {
  return (await chrome.runtime.sendMessage(event)) as unknown;
}

async function emitRecoveryRequest(
  run: Pick<Run, "conversationId" | "runId">,
  reason:
    "network-complete-dom-missing" | "hidden-attributed-stall" = "network-complete-dom-missing",
) {
  return await emit({
    type: "content.recovery.request",
    conversationId: run.conversationId,
    runId: run.runId,
    selectorVersion: SELECTOR_VERSION,
    reason,
  });
}

async function emitError(
  source: Pick<ContentCommand, "conversationId" | "runId">,
  code: PageErrorCode,
  message: string,
  focusTab = false,
) {
  await emit({
    type: "content.event",
    eventType: "error",
    conversationId: source.conversationId,
    runId: source.runId,
    ...remoteUrlPayload(),
    error: { code, message: message.slice(0, 1_000), recoverable: true, focusTab },
  });
}

function remoteUrlPayload() {
  const remoteUrl = currentRemoteUrl();
  return remoteUrl ? { remoteUrl } : {};
}

function conversationMetadataPayload() {
  const remoteUrl = currentRemoteUrl();
  if (!remoteUrl) return {};
  const title = visibleConversationTitle(remoteUrl);
  return {
    remoteUrl,
    ...(title ? { title } : {}),
  };
}

function currentRemoteUrl() {
  return normalizeContentRemoteUrl(location.href);
}

function visibleConversationTitle(remoteUrl: string) {
  const exactLinkLabels: string[] = [];
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const rawHref = anchor.getAttribute("href")?.trim();
    if (
      !rawHref ||
      rawHref.startsWith("#") ||
      rawHref.startsWith("?") ||
      anchor.hash ||
      !isVisible(anchor)
    ) {
      continue;
    }
    const anchorRemoteUrl = normalizeContentRemoteUrl(anchor.href);
    if (!isContentConversationRemoteUrl(anchorRemoteUrl) || anchorRemoteUrl !== remoteUrl) {
      continue;
    }
    exactLinkLabels.push(
      anchor.textContent?.trim() ||
        anchor.getAttribute("aria-label") ||
        anchor.getAttribute("title") ||
        "",
    );
  }
  return chooseContentConversationTitle(exactLinkLabels, document.title, REQUIRED_PROJECT_NAME);
}

function visibleConversationMessages() {
  const candidates = renderedConversationMessageElements();
  const messages: Array<{ role: "user" | "assistant"; markdown: string }> = [];
  let totalBytes = 0;
  let complete =
    candidates.length <= MAX_HISTORY_MESSAGES &&
    candidates.at(0)?.dataset.messageAuthorRole === "user" &&
    !hasVisibleHistoryTruncationSignal();

  // Preserve the most recent visible history when ChatGPT has rendered more
  // than the bounded relay snapshot can safely carry in one frame.
  for (const element of candidates.slice(-MAX_HISTORY_MESSAGES).reverse()) {
    const role = element.dataset.messageAuthorRole;
    if (role !== "user" && role !== "assistant") continue;
    const serializedMarkdown = serializeAssistant(element).trim();
    const markdown =
      role === "assistant" ? usableAssistantMarkdown(serializedMarkdown) : serializedMarkdown;
    if (role === "assistant" && serializedMarkdown && !markdown) complete = false;
    if (!markdown) continue;
    if (markdown.length > MAX_HISTORY_MESSAGE_CHARS) {
      complete = false;
      continue;
    }
    const bytes = contentUtf8ByteLength(markdown);
    if (bytes > MAX_HISTORY_MARKDOWN_BYTES) {
      complete = false;
      continue;
    }
    if (totalBytes + bytes > MAX_HISTORY_MARKDOWN_BYTES) {
      complete = false;
      break;
    }
    totalBytes += bytes;
    messages.push({ role, markdown });
  }
  return { messages: messages.reverse(), complete };
}

function hasVisibleHistoryTruncationSignal() {
  if (
    document.querySelector(
      '[data-virtualized="true"], [data-testid*="virtualized" i], [data-virtuoso-scroller="true"]',
    )
  ) {
    return true;
  }
  return (
    findVisibleElements([
      'button[aria-label*="earlier" i]',
      'button[aria-label*="older" i]',
      'button[aria-label*="更早"]',
      'button[aria-label*="历史"]',
    ]).length > 0
  );
}

function classifyPageError(error: unknown): PageErrorCode {
  if (isContentRecord(error) && typeof error.code === "string") {
    const code = error.code as PageErrorCode;
    if (
      [
        "CHATGPT_LOGIN_REQUIRED",
        "CHATGPT_CHALLENGE_REQUIRED",
        "CHATGPT_REMOTE_UNAVAILABLE",
        "CHATGPT_PROJECT_REQUIRED",
        "CHATGPT_PROJECT_MISMATCH",
        "CHATGPT_COMPOSER_MISSING",
        "CHATGPT_ATTACHMENT_FAILED",
        "CHATGPT_SEND_FAILED",
        "CHATGPT_MODEL_UNAVAILABLE",
        "CHATGPT_MODEL_SELECTION_FAILED",
        "REGENERATE_CONTROL_UNAVAILABLE",
        "RESPONSE_TIMEOUT",
        "FRAME_TOO_LARGE",
        "SELECTOR_INCOMPATIBLE",
      ].includes(code)
    ) {
      return code;
    }
  }
  return "SELECTOR_INCOMPATIBLE";
}

function pageError(code: PageErrorCode, message: string) {
  return Object.assign(new Error(message), { code });
}

function ambiguousSubmissionError(code: PageErrorCode, message: string) {
  return Object.assign(pageError(code, message), { ambiguousSubmission: true as const });
}

function isAmbiguousSubmissionError(error: unknown) {
  return Boolean(
    typeof error === "object" &&
    error !== null &&
    "ambiguousSubmission" in error &&
    error.ambiguousSubmission === true,
  );
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isContentCommand(value: unknown): value is ContentCommand {
  if (
    !isContentRecord(value) ||
    !["content.send", "content.stop", "content.regenerate", "content.recover"].includes(
      String(value.type),
    ) ||
    !isContentSafeId(value.conversationId) ||
    !isContentSafeId(value.runId)
  ) {
    return false;
  }
  if (value.type === "content.send") {
    const expectedProjectRoute =
      typeof value.expectedProjectScope === "string"
        ? parseContentProjectRootUrl(`${value.expectedProjectScope}project`)
        : undefined;
    if (
      normalizeContentPromptText(value.prompt) === undefined ||
      typeof value.allowFirstConversation !== "boolean" ||
      !expectedProjectRoute ||
      expectedProjectRoute.scope !== value.expectedProjectScope ||
      value.expectedPromptSha256 !== undefined ||
      (value.modelId !== undefined && !isContentSafeId(value.modelId)) ||
      (value.reasoningEffort !== undefined && !isChatReasoningEffort(value.reasoningEffort)) ||
      (value.modelLabel !== undefined &&
        (typeof value.modelLabel !== "string" || value.modelLabel.length > 80)) ||
      !isContentAttachments(value.attachments)
    ) {
      return false;
    }
    if (value.allowFirstConversation) return value.expectedRemoteUrl === undefined;
    return (
      typeof value.expectedRemoteUrl === "string" &&
      normalizeContentRemoteUrl(value.expectedRemoteUrl) === value.expectedRemoteUrl &&
      isContentConversationRemoteUrl(value.expectedRemoteUrl)
    );
  }
  if (value.type === "content.regenerate") {
    const expectedProjectRoute =
      typeof value.expectedProjectScope === "string"
        ? parseContentProjectRootUrl(`${value.expectedProjectScope}project`)
        : undefined;
    return (
      value.prompt === undefined &&
      value.startedAt === undefined &&
      value.expectedPromptSha256 === undefined &&
      value.expectedPromptInlinePresentationVersion === undefined &&
      value.expectedPromptInlinePresentationSha256 === undefined &&
      value.allowPromptInlinePresentationMatch === undefined &&
      value.modelId === undefined &&
      value.modelLabel === undefined &&
      value.reasoningEffort === undefined &&
      value.attachments === undefined &&
      value.allowFirstConversation === false &&
      Boolean(expectedProjectRoute) &&
      expectedProjectRoute!.scope === value.expectedProjectScope &&
      typeof value.expectedRemoteUrl === "string" &&
      normalizeContentRemoteUrl(value.expectedRemoteUrl) === value.expectedRemoteUrl &&
      isContentConversationRemoteUrl(value.expectedRemoteUrl)
    );
  }
  if (
    value.prompt !== undefined ||
    value.expectedRemoteUrl !== undefined ||
    value.expectedProjectScope !== undefined ||
    value.allowFirstConversation !== undefined ||
    value.modelId !== undefined ||
    value.modelLabel !== undefined ||
    value.reasoningEffort !== undefined ||
    value.attachments !== undefined
  ) {
    return false;
  }
  if (value.type === "content.recover") {
    const expectedPromptSha256 = value.expectedPromptSha256;
    const expectedPromptInlinePresentationVersion = value.expectedPromptInlinePresentationVersion;
    const expectedPromptInlinePresentationSha256 = value.expectedPromptInlinePresentationSha256;
    const allowPromptInlinePresentationMatch = value.allowPromptInlinePresentationMatch;
    return (
      typeof value.startedAt === "string" &&
      value.startedAt.length >= 20 &&
      value.startedAt.length <= 32 &&
      Number.isFinite(Date.parse(value.startedAt)) &&
      (value.expectedPromptSha256 === undefined ||
        (typeof value.expectedPromptSha256 === "string" &&
          /^[a-f0-9]{64}$/.test(value.expectedPromptSha256))) &&
      (expectedPromptInlinePresentationVersion === undefined ||
        expectedPromptInlinePresentationVersion === PROMPT_INLINE_PRESENTATION_VERSION) &&
      (expectedPromptInlinePresentationSha256 === undefined ||
        (typeof expectedPromptInlinePresentationSha256 === "string" &&
          /^[a-f0-9]{64}$/.test(expectedPromptInlinePresentationSha256))) &&
      (allowPromptInlinePresentationMatch === undefined ||
        allowPromptInlinePresentationMatch === true) &&
      (allowPromptInlinePresentationMatch === true
        ? typeof expectedPromptSha256 === "string" &&
          expectedPromptInlinePresentationVersion === PROMPT_INLINE_PRESENTATION_VERSION &&
          typeof expectedPromptInlinePresentationSha256 === "string"
        : expectedPromptInlinePresentationVersion === undefined &&
          expectedPromptInlinePresentationSha256 === undefined)
    );
  }
  return (
    value.startedAt === undefined &&
    value.expectedPromptSha256 === undefined &&
    value.expectedPromptInlinePresentationVersion === undefined &&
    value.expectedPromptInlinePresentationSha256 === undefined &&
    value.allowPromptInlinePresentationMatch === undefined
  );
}

function isContentAttachments(value: unknown): value is ChatFileAttachment[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > MAX_CHAT_FILE_ATTACHMENTS) return false;
  let totalChars = 0;
  for (const item of value) {
    if (
      !isContentRecord(item) ||
      !isContentSafeId(item.id) ||
      typeof item.fileName !== "string" ||
      item.fileName.length < 1 ||
      item.fileName.length > 240 ||
      item.fileName !== item.fileName.trim() ||
      /[\\/\p{Cc}\p{Cf}]/u.test(item.fileName) ||
      typeof item.mimeType !== "string" ||
      item.mimeType.length < 1 ||
      item.mimeType.length > 120 ||
      item.mimeType !== item.mimeType.trim() ||
      typeof item.content !== "string" ||
      item.content.length > MAX_CHAT_FILE_CHARS
    ) {
      return false;
    }
    totalChars += item.content.length;
  }
  return totalChars <= MAX_CHAT_FILE_BUNDLE_CHARS;
}

function isContentPingCommand(value: unknown) {
  return isContentRecord(value) && value.type === "content.ping" && Object.keys(value).length === 1;
}

function isComposerStatusCommand(value: unknown) {
  return (
    isContentRecord(value) &&
    value.type === "content.composerStatus" &&
    Object.keys(value).length === 1
  );
}

function isInspectConversationSnapshotCommand(value: unknown) {
  return (
    isContentRecord(value) &&
    value.type === "content.inspectConversation" &&
    Object.keys(value).length === 1
  );
}

function isTerminalAcknowledgementCommand(
  value: unknown,
): value is { type: "content.terminalAck"; conversationId: string; runId: string } {
  return (
    isContentRecord(value) &&
    value.type === "content.terminalAck" &&
    isContentSafeId(value.conversationId) &&
    isContentSafeId(value.runId) &&
    Object.keys(value).length === 3
  );
}

function isInspectProjectCommand(value: unknown) {
  return (
    isContentRecord(value) &&
    value.type === "content.inspectProject" &&
    Object.keys(value).length === 1
  );
}

function isListProjectsCommand(value: unknown) {
  return (
    isContentRecord(value) &&
    value.type === "content.listProjects" &&
    Object.keys(value).length === 1
  );
}

function isCreateProjectCommand(value: unknown) {
  return (
    isContentRecord(value) &&
    value.type === "content.createProject" &&
    Object.keys(value).length === 1
  );
}

function isDiscoverProjectCommand(value: unknown) {
  return (
    isContentRecord(value) &&
    value.type === "content.discoverProject" &&
    Object.keys(value).length === 1
  );
}

function isOpenProjectHomeCommand(value: unknown) {
  return (
    isContentRecord(value) &&
    value.type === "content.openProjectHome" &&
    Object.keys(value).length === 1
  );
}

function isModelListCommand(value: unknown) {
  return (
    isContentRecord(value) && value.type === "content.model.list" && Object.keys(value).length === 1
  );
}

function isModelSelectCommand(
  value: unknown,
): value is { type: "content.model.select"; option: ChatModelOption } {
  const option = isContentRecord(value) && isContentRecord(value.option) ? value.option : undefined;
  return (
    isContentRecord(value) &&
    value.type === "content.model.select" &&
    option !== undefined &&
    isContentSafeId(option.id) &&
    isContentSafeId(option.modelId) &&
    typeof option.label === "string" &&
    option.label === normalizeVisibleModelText(option.label, 80) &&
    typeof option.familyLabel === "string" &&
    option.familyLabel === normalizeVisibleModelText(option.familyLabel, 80) &&
    isChatModelMode(option.mode) &&
    (option.secondaryLabel === undefined ||
      (typeof option.secondaryLabel === "string" &&
        option.secondaryLabel === normalizeVisibleModelText(option.secondaryLabel, 24))) &&
    (option.reasoningEffort === undefined || isChatReasoningEffort(option.reasoningEffort)) &&
    typeof option.selected === "boolean" &&
    Object.keys(value).length === 2
  );
}

function isChatModelMode(value: unknown): value is ChatModelMode {
  return ["smart", "fast", "low", "medium", "high", "very-high", "pro"].includes(String(value));
}

function isChatReasoningEffort(value: unknown): value is ChatReasoningEffort {
  return ["min", "standard", "extended", "max"].includes(String(value));
}
