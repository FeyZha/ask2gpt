type TransportState = "connecting" | "open" | "authenticated" | "error";
type ProjectSetupFailureReason =
  "LOGIN_REQUIRED" | "PROJECT_NOT_FOUND" | "PROJECT_AMBIGUOUS" | "PAGE_UNAVAILABLE";
type ProjectDiscoveryPhase = "idle" | "working" | "ready" | "empty" | "error";

interface ProjectCandidate {
  name: string;
  projectUrl: string;
}

export {};

interface ServerStatus {
  port: number;
  instanceId?: string;
  authenticated: boolean;
  label?: string;
  transportState?: TransportState;
}

interface TabPoolStatus {
  managed: number;
  active: number;
  reusable: number;
  protected: number;
  borrowed: number;
  legacyCandidates: number;
  cleanupEligible: number;
  capacity: number;
}

interface PopupStatus {
  servers: ServerStatus[];
  connected?: boolean;
  scanning?: boolean;
  project?: { bound: false } | { bound: true; name: string; projectUrl?: string };
  projectSetup?:
    | { phase: "idle" }
    | { phase: "working"; startedAt: string }
    | { phase: "error"; reason: ProjectSetupFailureReason };
  backgroundReception?: {
    enhancedEnabled: boolean;
    permissionGranted: boolean;
  };
  tabPool?: TabPoolStatus;
  lastError?: string;
}

interface OpenChatGptResponse {
  ok?: boolean;
  error?: string;
  created?: boolean;
  project?: { bound: true; name: string; projectUrl?: string };
  projectSetup?: PopupStatus["projectSetup"];
}

interface CleanupManagedTabsResponse {
  ok: boolean;
  closed: number;
  skipped: number;
  tabPool?: TabPoolStatus;
  error?: string;
}

const STATUS_POLL_MS = 2_500;
const PROJECT_BIND_TIMEOUT_MS = 55_000;
const title = requiredElement<HTMLElement>("#status-title");
const detail = requiredElement<HTMLElement>("#status-detail");
const dot = requiredElement<HTMLElement>("#status-dot");
const windowSection = requiredElement<HTMLElement>("#window-section");
const windowCount = requiredElement<HTMLElement>("#window-count");
const windowList = requiredElement<HTMLElement>("#window-list");
const guidance = requiredElement<HTMLElement>("#guidance");
const guidanceTitle = requiredElement<HTMLElement>("#guidance-title");
const guidanceDetail = requiredElement<HTMLElement>("#guidance-detail");
const projectSection = requiredElement<HTMLElement>("#project-section");
const projectTitle = requiredElement<HTMLElement>("#project-title");
const projectDetail = requiredElement<HTMLElement>("#project-detail");
const projectBadge = requiredElement<HTMLElement>("#project-badge");
const projectChooser = requiredElement<HTMLElement>("#project-chooser");
const projectActionSlot = requiredElement<HTMLElement>("#project-action-slot");
const projectDiscovery = requiredElement<HTMLElement>("#project-discovery");
const projectCandidates = requiredElement<HTMLElement>("#project-candidates");
const projectDiscoveryMessage = requiredElement<HTMLElement>("#project-discovery-message");
const projectDiscoveryActions = requiredElement<HTMLElement>("#project-discovery-actions");
const bindProjectButton = requiredElement<HTMLButtonElement>("#bind-project");
const cancelProjectChangeButton = requiredElement<HTMLButtonElement>("#cancel-project-change");
const discoverProjectsButton = requiredElement<HTMLButtonElement>("#discover-projects");
const refreshProjectsButton = requiredElement<HTMLButtonElement>("#refresh-projects");
const createProjectButton = requiredElement<HTMLButtonElement>("#create-project");
const openChatGptButton = requiredElement<HTMLButtonElement>("#open-chatgpt");
const primaryActions = requiredElement<HTMLElement>("#primary-actions");
const rescanButton = requiredElement<HTMLButtonElement>("#rescan");
const relayRecovery = requiredElement<HTMLElement>("#relay-recovery");
const maintenanceActions = requiredElement<HTMLElement>("#maintenance-actions");
const reloadRelayButton = requiredElement<HTMLButtonElement>("#reload-relay");
const lastError = requiredElement<HTMLElement>("#last-error");
const enhancedBackgroundToggle = requiredElement<HTMLInputElement>("#enhanced-background-toggle");
const backgroundReceptionBadge = requiredElement<HTMLElement>("#background-reception-badge");
const backgroundReceptionDetail = requiredElement<HTMLElement>("#background-reception-detail");
const tabPoolSection = requiredElement<HTMLElement>("#tab-pool-section");
const tabPoolCapacity = requiredElement<HTMLElement>("#tab-pool-capacity");
const tabPoolSummary = requiredElement<HTMLElement>("#tab-pool-summary");
const tabPoolManaged = requiredElement<HTMLElement>("#tab-pool-managed");
const tabPoolActive = requiredElement<HTMLElement>("#tab-pool-active");
const tabPoolReusable = requiredElement<HTMLElement>("#tab-pool-reusable");
const tabPoolProtected = requiredElement<HTMLElement>("#tab-pool-protected");
const tabPoolLegacy = requiredElement<HTMLElement>("#tab-pool-legacy");
const cleanupManagedTabsButton = requiredElement<HTMLButtonElement>("#cleanup-managed-tabs");
const tabPoolSafety = requiredElement<HTMLElement>("#tab-pool-safety");
const tabPoolLegacyWarning = requiredElement<HTMLElement>("#tab-pool-legacy-warning");
const tabPoolLegacyCount = requiredElement<HTMLElement>("#tab-pool-legacy-count");
const tabPoolLegacyDetail = requiredElement<HTMLElement>("#tab-pool-legacy-detail");
const tabPoolFeedback = requiredElement<HTMLElement>("#tab-pool-feedback");

let refreshInFlight = false;
let projectBindInFlight = false;
let projectDiscoveryInFlight = false;
let projectBindFeedback:
  { phase: "working" } | { phase: "error"; reason?: ProjectSetupFailureReason } | undefined;
let projectBindFailureReason: ProjectSetupFailureReason | undefined;
let projectDiscoveryPhase: ProjectDiscoveryPhase = "idle";
let projectDiscoveryMessageText = "";
let projectCandidatesState: ProjectCandidate[] = [];
let selectedProjectUrl: string | undefined;
let projectChooserOpen = false;
let openChatGptInFlight = false;
let cleanupManagedTabsInFlight = false;
let tabPoolFeedbackState: { kind: "success" | "error"; message: string } | undefined;
let lastStatus: PopupStatus | undefined;
let lastRenderedStatusKey: string | undefined;

async function refresh(options: { forceRender?: boolean; quiet?: boolean } = {}) {
  if (refreshInFlight) return lastStatus;
  refreshInFlight = true;
  try {
    const status = await fetchStatus();
    lastStatus = status;
    const key = stableStatusKey(status);
    if (options.forceRender || key !== lastRenderedStatusKey) {
      render(status);
      lastRenderedStatusKey = key;
    }
    return status;
  } catch {
    if (!options.quiet || !lastStatus) renderUnavailable();
    return undefined;
  } finally {
    refreshInFlight = false;
  }
}

function render(status: PopupStatus) {
  const servers = normalizedServers(status.servers);
  const readyCount = servers.filter((server) => server.authenticated).length;
  const pendingCount = servers.length - readyCount;

  hideGuidance();
  showRelayRecovery(false);
  dot.className = `status-dot ${summaryDotClass(servers, status.scanning === true)}`;
  if (servers.length === 0 && status.scanning) {
    title.textContent = "正在查找 VS Code";
    detail.textContent = "请保持弹窗打开，通常几秒内完成。";
  } else if (servers.length === 0) {
    title.textContent = "还没连上 VS Code";
    detail.textContent = "先在 VS Code 打开 Ask2GPT，再重新检测。";
    setGuidance("attention", "下一步", "在 VS Code 按 Ctrl+Shift+P，运行“Ask2GPT: 打开”。");
  } else if (pendingCount === 0) {
    title.textContent = "已就绪，可以提问";
    detail.textContent = connectedWindowSummary(servers);
  } else if (readyCount > 0) {
    title.textContent = `${readyCount} 个窗口已就绪`;
    detail.textContent = `另有 ${pendingCount} 个窗口待连接；可先在已就绪窗口提问。`;
  } else {
    title.textContent = "正在连接 VS Code";
    detail.textContent = `已发现 ${servers.length} 个窗口，正在完成连接。`;
  }

  syncProjectBindFeedback(status);
  renderProject(status.project);
  renderControls(status, servers, readyCount);
  renderServers(servers);
  renderBackgroundReception(status.backgroundReception);
  renderTabPool(status.tabPool);
  renderLastError(status.lastError, servers.length === 0 && !status.scanning);
}

function renderBackgroundReception(status: PopupStatus["backgroundReception"]) {
  const enabled = status?.enhancedEnabled === true && status.permissionGranted === true;
  enhancedBackgroundToggle.checked = enabled;
  backgroundReceptionBadge.textContent = enabled ? "已增强" : "已关闭";
  backgroundReceptionBadge.dataset.enabled = String(enabled);
  backgroundReceptionDetail.textContent = enabled
    ? "仅在回答期间启用，完成后会立即断开调试连接。"
    : "已手动关闭；Chrome 最小化时，流式内容可能延迟。";
}

function renderTabPool(status: PopupStatus["tabPool"]) {
  const ready = status !== undefined;
  tabPoolSection.dataset.ready = String(ready);
  tabPoolSection.dataset.pending = String(cleanupManagedTabsInFlight);
  tabPoolSection.setAttribute("aria-busy", String(cleanupManagedTabsInFlight));

  tabPoolCapacity.textContent = `上限 ${status?.capacity ?? 3}`;
  tabPoolSummary.textContent = status
    ? `Relay 最多并行使用 ${status.capacity} 个工作页；空闲页会优先复用。`
    : "正在读取页面池状态…";
  tabPoolManaged.textContent = poolCountLabel(status?.managed);
  tabPoolActive.textContent = poolCountLabel(status?.active);
  tabPoolReusable.textContent = poolCountLabel(status?.reusable);
  tabPoolProtected.textContent = poolCountLabel(status?.protected);
  tabPoolLegacy.textContent = poolCountLabel(status?.legacyCandidates);

  cleanupManagedTabsButton.disabled =
    cleanupManagedTabsInFlight || !status || status.cleanupEligible === 0;
  cleanupManagedTabsButton.textContent = cleanupManagedTabsInFlight
    ? "正在安全清理…"
    : status && status.cleanupEligible > 0
      ? `清理安全闲置页 · ${status.cleanupEligible}`
      : "清理安全闲置页";
  tabPoolSafety.textContent =
    status && status.borrowed > 0
      ? `仅关闭由 Relay 创建、确认无任务且可安全复用的闲置页；${status.borrowed} 个借用页受保护。`
      : "仅关闭由 Relay 创建、确认无任务且可安全复用的闲置页。";

  const legacyCount = status?.legacyCandidates ?? 0;
  tabPoolLegacyWarning.hidden = legacyCount === 0;
  tabPoolLegacyCount.textContent = String(legacyCount);
  tabPoolLegacyDetail.textContent = "旧页面不会自动删除；请在 Chrome 标签栏逐一确认后手动关闭。";

  tabPoolFeedback.hidden = tabPoolFeedbackState === undefined;
  tabPoolFeedback.dataset.kind = tabPoolFeedbackState?.kind ?? "";
  tabPoolFeedback.textContent = tabPoolFeedbackState?.message ?? "";
}

function poolCountLabel(value: number | undefined) {
  return value === undefined ? "—" : String(value);
}

function connectedWindowSummary(servers: ServerStatus[]) {
  if (servers.length === 1) {
    return `“${serverLabel(servers[0]!, 0)}”已连接。返回 VS Code，在 Ask2GPT 面板发送问题。`;
  }
  return `${servers.length} 个 VS Code 窗口已连接。返回任一窗口的 Ask2GPT 面板发送问题。`;
}

function renderControls(status: PopupStatus, servers: ServerStatus[], readyCount: number) {
  const bound = status.project?.bound === true;
  const pendingCount = servers.length - readyCount;
  const canRetryConnection = status.scanning !== true && (servers.length === 0 || pendingCount > 0);

  projectSection.hidden = readyCount === 0 && !bound && projectBindFeedback === undefined;
  maintenanceActions.hidden = true;

  rescanButton.hidden = !canRetryConnection;
  rescanButton.textContent = readyCount > 0 ? "重试待连接窗口" : "重新检测";
  primaryActions.hidden = rescanButton.hidden;
}

function syncProjectBindFeedback(status: PopupStatus) {
  if (projectBindInFlight && projectBindFeedback?.phase === "working") return;
  if (status.project?.bound === true) {
    projectBindFeedback = undefined;
    return;
  }
  if (status.projectSetup?.phase === "working") {
    projectBindFeedback = { phase: "working" };
  } else if (status.projectSetup?.phase === "error") {
    projectBindFeedback = { phase: "error", reason: status.projectSetup.reason };
  } else if (!projectBindInFlight) {
    projectBindFeedback = undefined;
  }
}

function renderProject(project: PopupStatus["project"]) {
  const bound = project?.bound === true;
  const chooserVisible = !bound || projectChooserOpen;
  projectSection.dataset.bound = String(bound);
  projectSection.dataset.chooser = String(chooserVisible);
  projectSection.dataset.state = projectBindFeedback?.phase ?? (bound ? "bound" : "unbound");
  projectSection.setAttribute("aria-busy", String(projectBindFeedback?.phase === "working"));

  projectBadge.textContent = bound ? "已关联" : "未选择";
  projectChooser.hidden = !chooserVisible;
  projectActionSlot.hidden = chooserVisible;
  const controlsLocked =
    projectDiscoveryInFlight ||
    projectBindInFlight ||
    openChatGptInFlight ||
    projectBindFeedback?.phase === "working";
  discoverProjectsButton.disabled = controlsLocked;
  createProjectButton.disabled = controlsLocked;
  openChatGptButton.disabled = controlsLocked;

  if (!chooserVisible && bound) {
    projectTitle.textContent = project.name;
    projectDetail.textContent = "之后的新会话会保存到这里。需要时可以更换。";
    moveAction(bindProjectButton, projectActionSlot, "maintenance-button");
    bindProjectButton.textContent = "更换 Project";
    bindProjectButton.setAttribute("aria-label", "更换关联的 Project");
    bindProjectButton.disabled = false;
    bindProjectButton.hidden = false;
    renderProjectDiscovery(false, bound);
    return;
  }

  if (projectBindFeedback?.phase === "working") {
    projectTitle.textContent = "正在确认 Project";
    projectDetail.textContent = "请保持 ChatGPT 页面打开，通常几秒内完成。";
  } else if (projectBindFeedback?.phase === "error") {
    projectTitle.textContent = "还没有关联 Project";
    projectDetail.textContent = projectSetupFailureDetail(projectBindFeedback.reason);
  } else {
    projectTitle.textContent = "选择会话保存位置";
    projectDetail.textContent = "选择一个已有 Project，或新建一个专用 Project。";
  }

  moveAction(bindProjectButton, projectDiscoveryActions, "project-button");
  bindProjectButton.textContent = projectBindInFlight ? "正在关联…" : "关联所选 Project";
  bindProjectButton.setAttribute("aria-label", "关联所选 Project");
  bindProjectButton.disabled = projectBindInFlight || selectedProjectUrl === undefined;
  bindProjectButton.hidden = selectedProjectUrl === undefined;
  cancelProjectChangeButton.hidden = !bound;
  cancelProjectChangeButton.disabled = projectBindInFlight;
  renderProjectDiscovery(chooserVisible, bound);
}

function projectSetupFailureDetail(reason?: ProjectSetupFailureReason) {
  if (reason === "LOGIN_REQUIRED") return "请先在 Chrome 登录 ChatGPT，再重试。";
  if (reason === "PROJECT_NOT_FOUND") {
    return "没有找到可选择的 Project。请先打开 ChatGPT 中的目标 Project。";
  }
  if (reason === "PROJECT_AMBIGUOUS") {
    return "检测到多个 Project，请从列表中选择要使用的 Project。";
  }
  if (reason === "PAGE_UNAVAILABLE") {
    return "Project 页面还没有加载完成，请刷新 ChatGPT 后再查找。";
  }
  return "请打开 ChatGPT 中的目标 Project，再重新查找。";
}

function renderProjectDiscovery(chooserVisible: boolean, bound: boolean) {
  const showDiscovery =
    chooserVisible &&
    (projectDiscoveryPhase !== "idle" ||
      projectCandidatesState.length > 0 ||
      projectBindFeedback?.phase === "working");
  projectDiscovery.hidden = !showDiscovery;
  if (!showDiscovery) {
    projectCandidates.replaceChildren();
    projectDiscoveryMessage.hidden = true;
    return;
  }

  refreshProjectsButton.disabled = projectDiscoveryInFlight || projectBindInFlight;
  refreshProjectsButton.textContent = projectDiscoveryInFlight ? "查找中…" : "重新查找";
  projectCandidates.replaceChildren(
    ...projectCandidatesState.map((candidate) => createProjectCandidate(candidate)),
  );
  const message =
    projectDiscoveryMessageText ||
    (projectBindFeedback?.phase === "working" ? "正在确认所选 Project…" : "");
  projectDiscoveryMessage.hidden = message.length === 0;
  projectDiscoveryMessage.textContent = message;
  cancelProjectChangeButton.hidden = !bound;
}

function createProjectCandidate(candidate: ProjectCandidate) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "project-candidate";
  button.setAttribute("role", "option");
  button.setAttribute("aria-selected", String(selectedProjectUrl === candidate.projectUrl));
  button.addEventListener("click", () => {
    selectedProjectUrl = candidate.projectUrl;
    projectDiscoveryMessageText = "已选择。确认后，Ask2GPT 的新会话会保存到这里。";
    renderProject(lastStatus?.project);
  });

  const marker = document.createElement("span");
  marker.className = "project-candidate__marker";
  marker.setAttribute("aria-hidden", "true");
  const name = document.createElement("strong");
  name.className = "project-candidate__name";
  name.textContent = candidate.name;
  const state = document.createElement("span");
  state.className = "project-candidate__state";
  state.textContent = selectedProjectUrl === candidate.projectUrl ? "已选" : "选择";
  button.append(marker, name, state);
  return button;
}

function moveAction(button: HTMLButtonElement, target: HTMLElement, className: string) {
  if (button.parentElement !== target) target.append(button);
  button.className = className;
}

function setGuidance(
  state: "working" | "attention" | "success" | "error",
  heading: string,
  copy: string,
) {
  guidance.hidden = false;
  guidance.dataset.state = state;
  guidanceTitle.textContent = heading;
  guidanceDetail.textContent = copy;
}

function hideGuidance() {
  guidance.hidden = true;
}

function renderServers(servers: ServerStatus[]) {
  windowSection.hidden = servers.length === 0;
  windowCount.textContent = String(servers.length);
  windowList.replaceChildren(
    ...servers.map((server, index) => createServerRow(server, index, true)),
  );
}

function createServerRow(server: ServerStatus, index: number, detailed: boolean) {
  const row = document.createElement("div");
  row.className = detailed ? "server-row server-row--detailed" : "server-row";

  const indicator = document.createElement("span");
  indicator.className = `window-indicator ${server.authenticated ? "window-indicator--ready" : ""}`;
  indicator.setAttribute("aria-hidden", "true");

  const identity = document.createElement("div");
  identity.className = "server-identity";
  const name = document.createElement("strong");
  name.textContent = serverLabel(server, index);
  identity.append(name);
  if (detailed) {
    const meta = document.createElement("small");
    meta.textContent = `127.0.0.1:${server.port}`;
    identity.append(meta);
  }

  const state = document.createElement("span");
  state.className = `server-state ${server.authenticated ? "server-state--ready" : ""}`;
  state.textContent = serverStateLabel(server);
  row.append(indicator, identity, state);
  return row;
}

function renderLastError(value: string | undefined, relevant: boolean) {
  const message = value ? cleanFeedback(value) : "";
  lastError.hidden = !message || !relevant;
  lastError.textContent = message ? `最近一次检测：${message}` : "";
}

function showRelayRecovery(recommended: boolean) {
  relayRecovery.dataset.recommended = String(recommended);
  relayRecovery.hidden = !recommended;
}

function renderUnavailable() {
  dot.className = "status-dot status-dot--error";
  title.textContent = "Relay 未响应";
  detail.textContent = "重启会恢复连接，不会重复发送已提交的问题。";
  windowSection.hidden = true;
  projectSection.hidden = true;
  bindProjectButton.hidden = true;
  maintenanceActions.hidden = true;
  rescanButton.hidden = true;
  primaryActions.hidden = true;
  renderTabPool(undefined);
  hideGuidance();
  showRelayRecovery(true);
}

rescanButton.addEventListener("click", () => {
  rescanButton.disabled = true;
  rescanButton.textContent = "检测中…";
  setGuidance("working", "正在重新检测", "请保持弹窗打开，通常几秒内完成。");
  void sendRuntimeMessage<{ ok?: boolean }>({ type: "popup.rescan" }, 3_000)
    .then(async (response) => {
      if (!response?.ok) throw new Error("Rescan failed");
      await delay(250);
      await refresh({ forceRender: true });
    })
    .catch(renderUnavailable)
    .finally(() => {
      rescanButton.disabled = false;
    });
});

cleanupManagedTabsButton.addEventListener("click", () => {
  const eligible = lastStatus?.tabPool?.cleanupEligible ?? 0;
  if (cleanupManagedTabsInFlight || eligible === 0) return;

  cleanupManagedTabsInFlight = true;
  tabPoolFeedbackState = undefined;
  renderTabPool(lastStatus?.tabPool);
  void sendRuntimeMessage<unknown>({ type: "popup.cleanupManagedTabs" }, 8_000)
    .then(async (value) => {
      if (!isCleanupManagedTabsResponse(value)) {
        throw new Error("Relay 返回了无法验证的清理结果。");
      }
      if (!value.ok) throw new Error(value.error || "Relay 无法完成安全清理。");

      if (value.tabPool && lastStatus) {
        lastStatus = { ...lastStatus, tabPool: value.tabPool };
        lastRenderedStatusKey = stableStatusKey(lastStatus);
      } else {
        await refresh({ forceRender: true, quiet: true });
      }
      tabPoolFeedbackState = {
        kind: "success",
        message:
          value.closed > 0
            ? `已关闭 ${value.closed} 个安全闲置页；跳过 ${value.skipped} 个受保护页面。`
            : `没有需要关闭的安全闲置页；跳过 ${value.skipped} 个受保护页面。`,
      };
    })
    .catch((error: unknown) => {
      tabPoolFeedbackState = {
        kind: "error",
        message:
          error instanceof Error ? cleanFeedback(error.message) : "安全清理失败，请稍后重试。",
      };
    })
    .finally(() => {
      cleanupManagedTabsInFlight = false;
      renderTabPool(lastStatus?.tabPool);
    });
});

discoverProjectsButton.addEventListener("click", () => void discoverProjects());
refreshProjectsButton.addEventListener("click", () => void discoverProjects());

createProjectButton.addEventListener("click", () => void openChatGpt("create"));
openChatGptButton.addEventListener("click", () => void openChatGpt("open"));

cancelProjectChangeButton.addEventListener("click", () => {
  projectChooserOpen = false;
  projectDiscoveryPhase = "idle";
  projectDiscoveryMessageText = "";
  projectCandidatesState = [];
  selectedProjectUrl = undefined;
  renderProject(lastStatus?.project);
});

bindProjectButton.addEventListener("click", () => {
  const bound = lastStatus?.project?.bound === true;
  if (bound && !projectChooserOpen) {
    projectChooserOpen = true;
    projectDiscoveryPhase = "idle";
    projectDiscoveryMessageText = "";
    selectedProjectUrl = undefined;
    renderProject(lastStatus?.project);
    return;
  }
  const projectUrl = selectedProjectUrl;
  if (projectBindInFlight || !projectUrl) return;

  projectBindInFlight = true;
  projectBindFeedback = { phase: "working" };
  projectBindFailureReason = undefined;
  projectDiscoveryPhase = "working";
  projectDiscoveryMessageText = "正在确认所选 Project…";
  renderProject(lastStatus?.project);
  hideGuidance();
  void sendRuntimeMessage<{
    ok?: boolean;
    error?: string;
    project?: { bound: true; name: string; projectUrl?: string };
    projectSetup?:
      | { phase: "idle" }
      | { phase: "working"; startedAt: string }
      | { phase: "error"; reason: ProjectSetupFailureReason };
  }>({ type: "popup.bindProject", projectUrl }, PROJECT_BIND_TIMEOUT_MS)
    .then(async (response) => {
      if (!response?.ok) {
        projectBindFailureReason =
          response?.projectSetup?.phase === "error" ? response.projectSetup.reason : undefined;
        throw new Error(response?.error || "Project binding failed");
      }
      projectBindFeedback = undefined;
      projectChooserOpen = false;
      projectDiscoveryPhase = "idle";
      projectDiscoveryMessageText = "";
      projectCandidatesState = [];
      selectedProjectUrl = undefined;
      if (response.project && lastStatus) {
        lastStatus = {
          ...lastStatus,
          project: response.project,
          projectSetup: { phase: "idle" },
        };
        render(lastStatus);
        lastRenderedStatusKey = stableStatusKey(lastStatus);
      } else {
        await refresh({ forceRender: true });
      }
    })
    .catch(() => {
      const keptExistingBinding = lastStatus?.project?.bound === true;
      projectBindFeedback = {
        phase: "error",
        ...(projectBindFailureReason ? { reason: projectBindFailureReason } : {}),
      };
      projectDiscoveryPhase = "error";
      projectDiscoveryMessageText = "没有验证这个 Project。请重新查找后再试。";
      renderProject(lastStatus?.project);
      setGuidance(
        "error",
        keptExistingBinding ? "原 Project 仍保留" : "还没有关联 Project",
        keptExistingBinding
          ? "新 Project 未通过确认，当前会话仍会保存到原 Project。"
          : "请打开 ChatGPT 中的目标 Project，然后重新查找。",
      );
    })
    .finally(() => {
      projectBindInFlight = false;
      projectBindFailureReason = undefined;
      renderProject(lastStatus?.project);
    });
});

function discoverProjects() {
  if (projectDiscoveryInFlight || projectBindInFlight) return;
  projectChooserOpen = true;
  projectDiscoveryInFlight = true;
  projectDiscoveryPhase = "working";
  projectDiscoveryMessageText = "正在查找已打开的 ChatGPT Project…";
  projectCandidatesState = [];
  selectedProjectUrl = undefined;
  renderProject(lastStatus?.project);
  hideGuidance();
  void sendRuntimeMessage<{ ok?: boolean; error?: string; projects?: unknown }>(
    { type: "popup.listProjects" },
    8_000,
  )
    .then((response) => {
      if (!response?.ok) throw new Error(response?.error || "Project discovery failed");
      projectCandidatesState = parseProjectCandidates(response.projects);
      projectDiscoveryPhase = projectCandidatesState.length > 0 ? "ready" : "empty";
      projectDiscoveryMessageText =
        projectCandidatesState.length > 0
          ? "选择一个 Project，然后点击“关联所选 Project”。"
          : "没有找到已打开的 Project。可以先打开 ChatGPT，或新建一个专用 Project。";
    })
    .catch(() => {
      projectDiscoveryPhase = "error";
      projectDiscoveryMessageText = "暂时无法读取 ChatGPT 页面。请先打开 ChatGPT 并确认已登录。";
    })
    .finally(() => {
      projectDiscoveryInFlight = false;
      renderProject(lastStatus?.project);
    });
}

function openChatGpt(mode: "open" | "create") {
  if (openChatGptInFlight) return;
  const creating = mode === "create";
  let createFailureDetail = "";
  openChatGptInFlight = true;
  discoverProjectsButton.disabled = true;
  refreshProjectsButton.disabled = true;
  createProjectButton.disabled = true;
  openChatGptButton.disabled = true;
  setGuidance(
    "working",
    creating ? "正在创建 Ask2GPT Project" : "正在打开 ChatGPT",
    creating
      ? "请保持新打开的 ChatGPT 页面在前台，创建完成后会自动关联。"
      : "打开后，返回此弹窗查找你想关联的 Project。",
  );
  void sendRuntimeMessage<OpenChatGptResponse>(
    { type: "popup.openChatGpt", mode },
    creating ? PROJECT_BIND_TIMEOUT_MS : 4_000,
  )
    .then(async (response) => {
      if (!response?.ok) {
        if (creating) {
          projectBindFailureReason =
            response?.projectSetup?.phase === "error" ? response.projectSetup.reason : undefined;
          projectBindFeedback = {
            phase: "error",
            ...(projectBindFailureReason ? { reason: projectBindFailureReason } : {}),
          };
          projectDiscoveryPhase = "error";
          createFailureDetail = projectCreationFailureDetail(response);
          projectDiscoveryMessageText = createFailureDetail;
          renderProject(lastStatus?.project);
        }
        throw new Error(
          response?.error || (creating ? "Project creation failed" : "Unable to open ChatGPT"),
        );
      }
      if (creating) {
        if (
          response.project?.bound !== true ||
          response.project.name !== "Ask2GPT" ||
          response.created !== true
        ) {
          throw new Error("Ask2GPT Project creation was not verified");
        }
        projectBindFeedback = undefined;
        projectBindFailureReason = undefined;
        projectChooserOpen = false;
        projectDiscoveryPhase = "idle";
        projectDiscoveryMessageText = "";
        projectCandidatesState = [];
        selectedProjectUrl = undefined;
        if (lastStatus) {
          lastStatus = {
            ...lastStatus,
            project: response.project,
            projectSetup: { phase: "idle" },
          };
          render(lastStatus);
          lastRenderedStatusKey = stableStatusKey(lastStatus);
        } else {
          await refresh({ forceRender: true });
        }
        setGuidance("success", "已创建并关联 Ask2GPT", "之后的新会话会自动保存到这个 Project。");
      }
    })
    .catch((error: unknown) => {
      if (creating) {
        setGuidance(
          "error",
          "自动创建 Project 失败",
          createFailureDetail ||
            (error instanceof Error
              ? compactPopupDetail(error.message)
              : "请保持 ChatGPT 页面打开后重试。"),
        );
      } else {
        setGuidance("error", "无法打开 ChatGPT", "请手动打开 chatgpt.com，然后重新查找 Project。");
      }
    })
    .finally(() => {
      openChatGptInFlight = false;
      renderProject(lastStatus?.project);
    });
}

function projectCreationFailureDetail(response: OpenChatGptResponse) {
  if (response.error?.trim()) return compactPopupDetail(response.error);
  const reason =
    response.projectSetup?.phase === "error" ? response.projectSetup.reason : undefined;
  if (reason === "LOGIN_REQUIRED") return "ChatGPT 登录状态未就绪，请先在 ChatGPT 页面完成登录。";
  if (reason === "PAGE_UNAVAILABLE") return "ChatGPT 页面没有响应，请保持页面打开后重试。";
  if (reason === "PROJECT_AMBIGUOUS") return "检测到多个 Project，请改用“选择已有 Project”。";
  if (reason === "PROJECT_NOT_FOUND")
    return "没有检测到新建的 Ask2GPT Project，请保持 ChatGPT 页面打开后重试。";
  return "请保持 ChatGPT 页面打开后重试。";
}

function compactPopupDetail(value: string) {
  return value
    .replace(/[\r\n\u2028\u2029]+/gu, " ")
    .trim()
    .slice(0, 300);
}

reloadRelayButton.addEventListener("click", () => {
  reloadRelayButton.disabled = true;
  reloadRelayButton.textContent = "正在重启…";
  setGuidance("working", "正在重启 Relay", "正在保存任务状态，随后会刷新相关 ChatGPT 标签页。");
  void sendRuntimeMessage<{ ok?: boolean; error?: string; reloadScheduled?: boolean }>(
    { type: "popup.prepareReload" },
    4_000,
  )
    .then((response) => {
      if (!response?.ok) throw new Error(response?.error || "Reload checkpoint failed");
      // Runtime 13 workers checkpoint successfully but leave the final
      // chrome.runtime.reload() call to the popup. Runtime 14 workers own that
      // final step so the reload survives an immediately closed popup.
      if (response.reloadScheduled !== true) chrome.runtime.reload();
    })
    .catch((error: unknown) => {
      reloadRelayButton.disabled = false;
      reloadRelayButton.textContent = "重启 Relay";
      setGuidance(
        "error",
        "Relay 重启失败",
        error instanceof Error
          ? cleanFeedback(error.message)
          : "无法保存当前运行状态，请稍后重试。",
      );
    });
});

enhancedBackgroundToggle.addEventListener("change", () => {
  const requestedEnabled = enhancedBackgroundToggle.checked;
  enhancedBackgroundToggle.disabled = true;
  void updateEnhancedBackgroundReception(requestedEnabled).finally(() => {
    enhancedBackgroundToggle.disabled = false;
  });
});

async function updateEnhancedBackgroundReception(enabled: boolean) {
  try {
    const response = await sendRuntimeMessage<{
      ok?: boolean;
      enabled?: boolean;
      permissionGranted?: boolean;
      permissionRequired?: boolean;
    }>({ type: "popup.setEnhancedBackground", enabled }, 4_000);
    if (!response?.ok) {
      throw new Error(
        response?.permissionRequired
          ? "Chrome 尚未确认扩展的调试权限，请在扩展管理页完成授权后重试。"
          : "无法更新后台接收设置。",
      );
    }

    const backgroundReception = {
      enhancedEnabled: response.enabled === true,
      permissionGranted: response.permissionGranted === true,
    };
    if (lastStatus) lastStatus = { ...lastStatus, backgroundReception };
    renderBackgroundReception(backgroundReception);
    if (lastStatus) lastRenderedStatusKey = stableStatusKey(lastStatus);
  } catch (error) {
    enhancedBackgroundToggle.checked = lastStatus?.backgroundReception?.enhancedEnabled === true;
    setGuidance(
      "error",
      "增强后台接收未开启",
      error instanceof Error ? cleanFeedback(error.message) : "请稍后重试。",
    );
  }
}

void refresh({ forceRender: true });
const refreshTimer = window.setInterval(() => void refresh({ quiet: true }), STATUS_POLL_MS);
window.addEventListener("unload", () => window.clearInterval(refreshTimer));

async function fetchStatus() {
  const status = await sendRuntimeMessage<PopupStatus>({ type: "popup.status" }, 4_000);
  if (!isPopupStatus(status)) throw new Error("Invalid status response");
  return status;
}

function normalizedServers(servers: ServerStatus[]) {
  return [...servers].sort(
    (left, right) =>
      Number(right.authenticated) - Number(left.authenticated) || left.port - right.port,
  );
}

function stableStatusKey(status: PopupStatus) {
  return JSON.stringify({
    servers: normalizedServers(status.servers),
    scanning: status.scanning === true,
    project: status.project,
    projectSetup: status.projectSetup,
    backgroundReception: status.backgroundReception,
    tabPool: status.tabPool,
    lastError: status.lastError,
  });
}

function summaryDotClass(servers: ServerStatus[], scanning: boolean) {
  if (servers.length === 0) return scanning ? "status-dot--pending" : "status-dot--offline";
  const ready = servers.filter((server) => server.authenticated).length;
  if (ready === servers.length) return "status-dot--ready";
  if (ready > 0) return "status-dot--partial";
  return "status-dot--pending";
}

function serverLabel(server: ServerStatus, index: number) {
  const label = server.label?.replace(/\s+/gu, " ").trim().slice(0, 80);
  if (label) return label;
  if (server.instanceId) return `VS Code · ${server.instanceId.slice(0, 8)}`;
  return `VS Code 窗口 ${index + 1}`;
}

function serverStateLabel(server: ServerStatus) {
  if (server.authenticated || server.transportState === "authenticated") return "已连接";
  if (server.transportState === "error") return "连接异常";
  if (server.transportState === "connecting") return "检测中";
  return "自动握手中";
}

function cleanFeedback(value: string) {
  return value
    .replace(/[\r\n\u2028\u2029]+/gu, " ")
    .trim()
    .slice(0, 500);
}

function parseProjectCandidates(value: unknown): ProjectCandidate[] {
  if (!Array.isArray(value)) return [];
  const candidates = new Map<string, ProjectCandidate>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.projectUrl !== "string") {
      continue;
    }
    const name = item.name.replace(/\s+/gu, " ").trim();
    if (!isProjectRootUrl(item.projectUrl) || name.length < 1 || name.length > 120) continue;
    candidates.set(item.projectUrl, { name, projectUrl: item.projectUrl });
  }
  return [...candidates.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.projectUrl.localeCompare(right.projectUrl),
  );
}

function isProjectRootUrl(value: string) {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    return (
      url.protocol === "https:" &&
      url.hostname === "chatgpt.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      segments.length === 3 &&
      segments[0] === "g" &&
      segments[2] === "project"
    );
  } catch {
    return false;
  }
}

function isPopupStatus(value: unknown): value is PopupStatus {
  if (!isRecord(value) || !Array.isArray(value.servers)) return false;
  if (value.connected !== undefined && typeof value.connected !== "boolean") return false;
  if (value.scanning !== undefined && typeof value.scanning !== "boolean") return false;
  if (value.project !== undefined && !isProjectStatus(value.project)) return false;
  if (value.projectSetup !== undefined && !isProjectSetupStatus(value.projectSetup)) return false;
  if (
    value.backgroundReception !== undefined &&
    (!isRecord(value.backgroundReception) ||
      typeof value.backgroundReception.enhancedEnabled !== "boolean" ||
      typeof value.backgroundReception.permissionGranted !== "boolean")
  ) {
    return false;
  }
  if (value.tabPool !== undefined && !isTabPoolStatus(value.tabPool)) return false;
  if (
    value.lastError !== undefined &&
    (typeof value.lastError !== "string" || value.lastError.length > 1_000)
  ) {
    return false;
  }
  return value.servers.every(
    (server) =>
      isRecord(server) &&
      Number.isInteger(server.port) &&
      Number(server.port) >= 32_171 &&
      Number(server.port) <= 32_180 &&
      typeof server.authenticated === "boolean" &&
      (server.instanceId === undefined || typeof server.instanceId === "string") &&
      (server.label === undefined || typeof server.label === "string") &&
      (server.transportState === undefined ||
        ["connecting", "open", "authenticated", "error"].includes(String(server.transportState))),
  );
}

function isCleanupManagedTabsResponse(value: unknown): value is CleanupManagedTabsResponse {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set(["ok", "closed", "skipped", "tabPool", "error"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  if (typeof value.ok !== "boolean") return false;
  if (!isBoundedCount(value.closed) || !isBoundedCount(value.skipped)) return false;
  if (value.tabPool !== undefined && !isTabPoolStatus(value.tabPool)) return false;
  return (
    value.error === undefined ||
    (typeof value.error === "string" &&
      value.error.trim().length >= 1 &&
      value.error.length <= 1_000)
  );
}

function isTabPoolStatus(value: unknown): value is TabPoolStatus {
  if (!isRecord(value)) return false;
  const keys = [
    "managed",
    "active",
    "reusable",
    "protected",
    "borrowed",
    "legacyCandidates",
    "cleanupEligible",
    "capacity",
  ] as const;
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !isBoundedCount(value[key]))
  ) {
    return false;
  }
  const managed = Number(value.managed);
  const capacity = Number(value.capacity);
  return (
    capacity >= 1 &&
    capacity <= 32 &&
    Number(value.active) <= managed &&
    Number(value.reusable) <= managed &&
    Number(value.protected) <= managed &&
    Number(value.cleanupEligible) <= managed
  );
}

function isBoundedCount(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 10_000;
}

function isProjectSetupStatus(value: unknown) {
  if (!isRecord(value) || typeof value.phase !== "string") return false;
  if (value.phase === "idle") return Object.keys(value).length === 1;
  if (value.phase === "working") {
    return (
      Object.keys(value).length === 2 &&
      typeof value.startedAt === "string" &&
      Number.isFinite(Date.parse(value.startedAt))
    );
  }
  return (
    value.phase === "error" &&
    Object.keys(value).length === 2 &&
    ["LOGIN_REQUIRED", "PROJECT_NOT_FOUND", "PROJECT_AMBIGUOUS", "PAGE_UNAVAILABLE"].includes(
      String(value.reason),
    )
  );
}

function isProjectStatus(value: unknown) {
  if (!isRecord(value) || typeof value.bound !== "boolean") return false;
  if (value.bound === false) return Object.keys(value).length === 1;
  return (
    typeof value.name === "string" &&
    value.name.length >= 1 &&
    value.name.length <= 120 &&
    (value.projectUrl === undefined || typeof value.projectUrl === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredElement<T extends Element>(selector: string) {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Popup element was missing: ${selector}`);
  return element;
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function sendRuntimeMessage<T>(message: Record<string, unknown>, timeoutMs: number) {
  let timeout: number | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = window.setTimeout(() => reject(new Error("请求超时，请重新检测后重试。")), timeoutMs);
  });
  try {
    return (await Promise.race([chrome.runtime.sendMessage(message), deadline])) as T;
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}
