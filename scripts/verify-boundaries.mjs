import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const failures = [];

const vscodeSourceRoot = path.join(root, "apps", "vscode-extension", "src");
const chromeSourceRoot = path.join(root, "apps", "chrome-extension", "src");
const conversationStore = normalize(
  path.join(vscodeSourceRoot, "services", "conversation-store.ts"),
);

const productionSources = [
  ...(await walk(vscodeSourceRoot)),
  ...(await walk(chromeSourceRoot)),
].filter(
  (file) =>
    /\.(?:ts|tsx)$/.test(file) && !/\.test\.(?:ts|tsx)$/.test(file) && !file.endsWith(".d.ts"),
);
let productionCodeActionConstructions = 0;

const forbiddenRuntimePatterns = [
  [/\b(?:node:)?child_process\b/, "child_process"],
  [/\bcreateTerminal\s*\(/, "VS Code terminal creation"],
  [/\bworkspace\.fs\.(?:writeFile|delete|rename|copy|createDirectory)\s*\(/, "workspace write"],
  [/\bworkspace\.findFiles\s*\(/, "workspace search"],
  [/\bworkspace\.textDocuments\b/, "ambient workspace document collection"],
  [/\btasks\.(?:executeTask|registerTaskProvider)\s*\(/, "VS Code task execution"],
  [/\btests\.createTestController\s*\(/, "VS Code test execution"],
  [/\bextensions\.getExtension\s*\(\s*["']vscode\.git["']/, "VS Code Git API"],
  [/\b(?:fetch|XMLHttpRequest|EventSource)\s*\(/, "unapproved network client"],
  [/["']inlineChat\.start["']/, "Inline Chat command interception"],
];

for (const file of productionSources) {
  const source = await readFile(file, "utf8");
  const relative = normalize(path.relative(root, file));
  productionCodeActionConstructions += source.match(/new vscode\.CodeAction\s*\(/gu)?.length ?? 0;

  for (const [pattern, label] of forbiddenRuntimePatterns) {
    if (
      label === "unapproved network client" &&
      relative === "apps/chrome-extension/src/content-script.ts" &&
      (source.match(/\bfetch\s*\(/gu)?.length ?? 0) === 2 &&
      source.includes('fetch("https://chatgpt.com/backend-api/models"') &&
      source.includes('fetch("https://chatgpt.com/api/auth/session"')
    ) {
      continue;
    }
    if (pattern.test(source)) failures.push(`${relative}: forbidden ${label}`);
  }

  if (
    /from\s+["'](?:node:)?fs(?:\/promises)?["']|require\s*\(\s*["'](?:node:)?fs/.test(source) &&
    normalize(file) !== conversationStore
  ) {
    failures.push(`${relative}: filesystem access is only allowed in ConversationStore`);
  }

  const approvedExecuteCommands = new Set([
    "setContext",
    "workbench.view.extension.ask2gptContainer",
    "ask2gpt.sidebar.focus",
    "vscode.executeDocumentSymbolProvider",
  ]);
  for (const match of source.matchAll(/\bcommands\.executeCommand\s*\(\s*(["'`])([^"'`]+)\1/g)) {
    if (!approvedExecuteCommands.has(match[2])) {
      failures.push(`${relative}: unapproved executeCommand target ${match[2]}`);
    }
  }
}

const chromeServiceWorker = await readFile(
  path.join(chromeSourceRoot, "service-worker.ts"),
  "utf8",
);
if (
  !chromeServiceWorker.includes("new WebSocket(`ws://127.0.0.1:${port}`, RELAY_WEBSOCKET_PROTOCOL)")
) {
  failures.push("Chrome relay WebSocket is not statically pinned to 127.0.0.1");
}

const chromeContentScript = await readFile(
  path.join(chromeSourceRoot, "content-script.ts"),
  "utf8",
);
for (const [pattern, label] of [
  [/\b(?:localStorage|sessionStorage)\b/, "website storage access"],
  [/\bdocument\.cookie\b/, "website cookie access"],
  [/__react|webpack|nextjs/i, "hidden framework model state"],
]) {
  if (pattern.test(chromeContentScript)) {
    failures.push(`Chrome content script has forbidden ${label}`);
  }
}

const vscodePackage = await readJson(path.join(root, "apps", "vscode-extension", "package.json"));
const rootPackage = await readJson(path.join(root, "package.json"));
const chromePackage = await readJson(path.join(root, "apps", "chrome-extension", "package.json"));
const protocolPackage = await readJson(path.join(root, "packages", "protocol", "package.json"));
const expectedCommands = [
  "ask2gpt.attachCurrentFile",
  "ask2gpt.attachFiles",
  "ask2gpt.attachNotebookCell",
  "ask2gpt.attachSelection",
  "ask2gpt.copyDiagnostics",
  "ask2gpt.findRelatedTurn",
  "ask2gpt.newConversation",
  "ask2gpt.open",
  "ask2gpt.retryConnection",
];
const actualCommands = vscodePackage.contributes.commands.map((entry) => entry.command).sort();
if (JSON.stringify(actualCommands) !== JSON.stringify(expectedCommands)) {
  failures.push("VS Code command surface differs from the reviewed read-only allowlist");
}
if (
  vscodePackage.name !== "ask2gpt" ||
  vscodePackage.displayName !== "Ask2GPT" ||
  JSON.stringify(vscodePackage.extensionKind) !== JSON.stringify(["ui"]) ||
  vscodePackage.contributes.viewsContainers.activitybar?.[0]?.title !== "Ask2GPT" ||
  vscodePackage.contributes.views.ask2gptContainer?.[0]?.name !== "Ask2GPT"
) {
  failures.push("Ask2GPT branding or the standalone extension identity is invalid");
}
if (
  !vscodePackage.contributes.commands.every(
    (entry) => entry.category === "Ask2GPT" && entry.command.startsWith("ask2gpt."),
  )
) {
  failures.push("VS Code commands do not preserve the Ask2GPT brand and legacy command namespace");
}
const attachSelectionCommand = "ask2gpt.attachSelection";
const attachNotebookCellCommand = "ask2gpt.attachNotebookCell";
const findRelatedTurnCommand = "ask2gpt.findRelatedTurn";
const attachSelectionWhen =
  "editorHasSelection && resourceScheme =~ /^(file|untitled|vscode-remote)$/";
const attachSelectionViewWhen = "view == ask2gpt.sidebar";
const visibleAttachSelectionMenus = Object.entries(vscodePackage.contributes.menus ?? {}).flatMap(
  ([menu, entries]) =>
    entries
      .filter((entry) => entry.command === attachSelectionCommand && entry.when !== "false")
      .map((entry) => ({ menu, entry })),
);
const editorShortcutMenus = Object.keys(vscodePackage.contributes.menus ?? {}).filter(
  (menu) => menu.startsWith("editor/") || menu.startsWith("chat/editor/"),
);
const attachSelectionContribution = vscodePackage.contributes.commands.find(
  (entry) => entry.command === attachSelectionCommand,
);
const paletteEntry = vscodePackage.contributes.menus.commandPalette?.find(
  (entry) => entry.command === attachSelectionCommand,
);
if (
  attachSelectionContribution?.enablement !== undefined ||
  attachSelectionContribution?.icon !== "$(comment-discussion)" ||
  !vscodePackage.activationEvents.includes(`onCommand:${attachSelectionCommand}`) ||
  paletteEntry?.when !== attachSelectionWhen ||
  JSON.stringify(editorShortcutMenus) !== JSON.stringify(["editor/title", "editor/context"]) ||
  visibleAttachSelectionMenus.length !== 4 ||
  !visibleAttachSelectionMenus.every(({ menu, entry }) =>
    menu === "view/title"
      ? entry.when === attachSelectionViewWhen
      : entry.when === attachSelectionWhen,
  ) ||
  vscodePackage.contributes.menus["editor/title"]?.[0]?.group !== "navigation@1" ||
  vscodePackage.contributes.menus["editor/context"]?.[0]?.group !== "navigation@10" ||
  vscodePackage.contributes.menus["view/title"]?.[0]?.group !== "navigation@1" ||
  vscodePackage.contributes.keybindings !== undefined
) {
  failures.push("VS Code selected-code surface must use the reviewed editor and view actions");
}
const attachNotebookCellContribution = vscodePackage.contributes.commands.find(
  (entry) => entry.command === attachNotebookCellCommand,
);
const visibleAttachNotebookCellMenus = Object.entries(
  vscodePackage.contributes.menus ?? {},
).flatMap(([menu, entries]) =>
  entries
    .filter((entry) => entry.command === attachNotebookCellCommand && entry.when !== "false")
    .map((entry) => ({ menu, entry })),
);
const expectedAttachNotebookCellMenus = [
  { menu: "commandPalette", group: undefined },
  { menu: "notebook/cell/title", group: "inline/cell@1" },
  { menu: "notebook/toolbar", group: "navigation@1" },
];
if (
  attachNotebookCellContribution?.enablement !== undefined ||
  attachNotebookCellContribution?.icon !== "$(notebook)" ||
  !vscodePackage.activationEvents.includes(`onCommand:${attachNotebookCellCommand}`) ||
  visibleAttachNotebookCellMenus.length !== expectedAttachNotebookCellMenus.length ||
  !expectedAttachNotebookCellMenus.every(({ menu, group }) =>
    visibleAttachNotebookCellMenus.some(
      (candidate) =>
        candidate.menu === menu &&
        candidate.entry.when === undefined &&
        candidate.entry.group === group,
    ),
  )
) {
  failures.push(
    "VS Code Notebook source capture must stay on the reviewed Cell title, Notebook toolbar, and palette surfaces",
  );
}
const findRelatedTurnContribution = vscodePackage.contributes.commands.find(
  (entry) => entry.command === findRelatedTurnCommand,
);
const visibleFindRelatedTurnMenus = Object.entries(vscodePackage.contributes.menus ?? {}).flatMap(
  ([menu, entries]) =>
    entries
      .filter((entry) => entry.command === findRelatedTurnCommand && entry.when !== "false")
      .map((entry) => ({ menu, entry })),
);
const expectedFindRelatedTurnMenus = [
  { menu: "commandPalette", group: undefined, when: attachSelectionWhen },
  { menu: "editor/title", group: "navigation@2", when: attachSelectionWhen },
  { menu: "editor/context", group: "navigation@11", when: attachSelectionWhen },
  { menu: "notebook/cell/title", group: "inline/cell@2", when: undefined },
];
if (
  findRelatedTurnContribution?.enablement !== undefined ||
  findRelatedTurnContribution?.icon !== "$(references)" ||
  !vscodePackage.activationEvents.includes(`onCommand:${findRelatedTurnCommand}`) ||
  visibleFindRelatedTurnMenus.length !== expectedFindRelatedTurnMenus.length ||
  !expectedFindRelatedTurnMenus.every(({ menu, group, when }) =>
    visibleFindRelatedTurnMenus.some(
      (candidate) =>
        candidate.menu === menu && candidate.entry.when === when && candidate.entry.group === group,
    ),
  ) ||
  visibleFindRelatedTurnMenus.some(({ menu }) => menu === "view/title")
) {
  failures.push(
    "VS Code related-turn command must stay on the reviewed text-selection and Notebook Cell surfaces",
  );
}
const selectionHandoffSource = await readFile(
  path.join(vscodeSourceRoot, "selection-handoff.ts"),
  "utf8",
);
const selectionCodeActionSource = await readFile(
  path.join(vscodeSourceRoot, "selection-code-action.ts"),
  "utf8",
);
const extensionSource = await readFile(path.join(vscodeSourceRoot, "extension.ts"), "utf8");
const sourceTraceIndexSource = await readFile(
  path.join(vscodeSourceRoot, "source-trace-index.ts"),
  "utf8",
);
const webviewProviderSource = await readFile(
  path.join(vscodeSourceRoot, "webview-provider.ts"),
  "utf8",
);
const contextServiceSource = await readFile(
  path.join(vscodeSourceRoot, "services", "context-service.ts"),
  "utf8",
);
const promptBuilderSource = await readFile(
  path.join(vscodeSourceRoot, "services", "prompt-builder.ts"),
  "utf8",
);
const selectionReferenceSource = await readFile(
  path.join(vscodeSourceRoot, "selection-reference.ts"),
  "utf8",
);
const notebookSourceNavigationSource = await readFile(
  path.join(vscodeSourceRoot, "notebook-source-navigation.ts"),
  "utf8",
);
const contextNavigationSource = await readFile(
  path.join(vscodeSourceRoot, "context-navigation.ts"),
  "utf8",
);
const sourceTraceSource = await readFile(path.join(vscodeSourceRoot, "source-trace.ts"), "utf8");
const conversationTraceSource = await readFile(
  path.join(vscodeSourceRoot, "conversation-trace.ts"),
  "utf8",
);
const conversationStoreSource = await readFile(
  path.join(vscodeSourceRoot, "services", "conversation-store.ts"),
  "utf8",
);
const controllerSource = await readFile(path.join(vscodeSourceRoot, "controller.ts"), "utf8");
const browserChatBackendSource = await readFile(
  path.join(vscodeSourceRoot, "services", "browser-chat-backend.ts"),
  "utf8",
);
const sourceAnchorSource = await readFile(path.join(vscodeSourceRoot, "source-anchor.ts"), "utf8");
const protocolSource = await readFile(
  path.join(root, "packages", "protocol", "src", "index.ts"),
  "utf8",
);
const protocolRuntimeContractSource = await readFile(
  path.join(root, "packages", "protocol", "src", "runtime-contract.mjs"),
  "utf8",
);
const relayStateSource = await readFile(path.join(chromeSourceRoot, "relay-state.ts"), "utf8");
const tabLeasePolicySource = await readFile(
  path.join(chromeSourceRoot, "tab-lease-policy.ts"),
  "utf8",
);
const contentIdlePolicySource = await readFile(
  path.join(chromeSourceRoot, "content-idle-policy.ts"),
  "utf8",
);
const chromePopupSource = await readFile(path.join(chromeSourceRoot, "popup.ts"), "utf8");
const allocateConversationTabSource = boundedSourceSlice(
  chromeServiceWorker,
  "async function allocateConversationTab(",
  "async function selectReusableManagedTabCandidate(",
);
const inspectManagedTabCandidateSource = boundedSourceSlice(
  chromeServiceWorker,
  "async function inspectManagedTabCandidate(",
  "function managedTabCandidate(",
);
const handleReleaseSource = boundedSourceSlice(
  chromeServiceWorker,
  "async function handleRelease(",
  "function markConversationReleaseRequested(",
);
const tryMarkManagedTabIdleSource = boundedSourceSlice(
  chromeServiceWorker,
  "async function tryMarkManagedTabIdle(",
  "async function settleReleasedManagedTabs(",
);
const managedTabGcSource = boundedSourceSlice(
  chromeServiceWorker,
  "async function runManagedTabGc()",
  "async function closeManagedTabLease(",
);
const closeManagedTabLeaseSource = boundedSourceSlice(
  chromeServiceWorker,
  "async function closeManagedTabLease(",
  "async function removeOwnedTab(",
);
const removeOwnedTabSource = boundedSourceSlice(
  chromeServiceWorker,
  "async function removeOwnedTab(",
  "async function handleTabRemoved(",
);
const popupManagedTabCleanupSource = boundedSourceSlice(
  chromeServiceWorker,
  "async function cleanupManagedTabsFromPopup()",
  "async function handlePopupMessage(",
);
const notebookAnchorContractSource = boundedSourceSlice(
  protocolSource,
  "export interface NotebookSourceAnchorV2 {",
  "export type SourceAnchor =",
);
const notebookCaptureSource = boundedSourceSlice(
  contextServiceSource,
  "captureNotebookCells(",
  "async captureFiles(",
);
const notebookSnapshotSource = boundedSourceSlice(
  contextServiceSource,
  "function notebookSnapshot(",
  "function notebookSourceAnchor(",
);
const activeEditorSource = boundedSourceSlice(
  contextServiceSource,
  "function activeEditor()",
  "function baseSnapshot(",
);
const captureSelectionSource = boundedSourceSlice(
  contextServiceSource,
  "captureSelection(",
  "captureCurrentFile(",
);
const captureCurrentFileSource = boundedSourceSlice(
  contextServiceSource,
  "captureCurrentFile(",
  "captureNotebookCells(",
);
const captureFilesSource = boundedSourceSlice(
  contextServiceSource,
  "async captureFiles(",
  "function notebookSnapshot(",
);
const typesSource = await readFile(path.join(vscodeSourceRoot, "types.ts"), "utf8");
const webviewMessageValidationSource = await readFile(
  path.join(vscodeSourceRoot, "webview-message-validation.ts"),
  "utf8",
);
const openSourceReferenceStart = webviewMessageValidationSource.indexOf(
  'case "openSourceReference":',
);
const openSourceReferenceEnd = webviewMessageValidationSource.indexOf(
  'case "selectConversation":',
  openSourceReferenceStart,
);
const openSourceReferenceValidation =
  openSourceReferenceStart >= 0 && openSourceReferenceEnd > openSourceReferenceStart
    ? webviewMessageValidationSource.slice(openSourceReferenceStart, openSourceReferenceEnd)
    : "";
if (
  !extensionSource.includes("registerSelectionCodeActionProvider()") ||
  !selectionCodeActionSource.includes("registerCodeActionsProvider") ||
  !selectionCodeActionSource.includes('QuickFix.append("ask2gpt.selection")') ||
  !selectionCodeActionSource.includes(
    "command: notebookCell ? ATTACH_NOTEBOOK_CELL_COMMAND : ATTACH_SELECTION_COMMAND",
  ) ||
  !selectionCodeActionSource.includes('{ notebookType: "*" }') ||
  !selectionCodeActionSource.includes(
    'createNotebookCellReference(notebookCell, "range", range)',
  ) ||
  !selectionCodeActionSource.includes("vscode.window.activeTextEditor") ||
  (selectionCodeActionSource.match(/new vscode\.CodeAction\(/gu)?.length ?? 0) !== 1 ||
  productionCodeActionConstructions !== 1 ||
  selectionCodeActionSource.includes("isPreferred = true") ||
  !productionSources.some((file) => normalize(file).endsWith("/selection-code-action.ts")) ||
  productionSources.some((file) => normalize(file).endsWith("/selection-context.ts")) ||
  vscodePackage.contributes.codeLens !== undefined ||
  vscodePackage.contributes.menus["chat/editor/inlineGutter"] !== undefined ||
  vscodePackage.contributes.menus["editor/content"] !== undefined ||
  selectionHandoffSource.includes("workbench.action.chat.attachSelection") ||
  selectionHandoffSource.includes("nativeSelectionAffordanceAvailable") ||
  extensionSource.includes("NATIVE_ATTACH_SELECTION_COMMAND") ||
  extensionSource.includes("NATIVE_SELECTION_AFFORDANCE_CONTEXT")
) {
  failures.push(
    "VS Code selected-code handoff must support reviewed text/Notebook Quick Fix surfaces without private workbench commands",
  );
}
if (
  !/hasOnlyKeys\(\s*value,\s*\[\s*"type"\s*,\s*"conversationId"\s*,\s*"messageId"\s*,\s*"kind"\s*,\s*"reference"\s*\]\s*\)/u.test(
    openSourceReferenceValidation,
  ) ||
  /\buri\b/u.test(openSourceReferenceValidation)
) {
  failures.push(
    "Webview source-reference navigation must send bounded references, never a URI or path authority",
  );
}
if (
  (webviewProviderSource.match(/withSourceTraceHints\(/gu)?.length ?? 0) < 3 ||
  !sourceTraceIndexSource.includes("nearestTraceContexts") ||
  !sourceTraceIndexSource.includes('message.status === "streaming"') ||
  !sourceTraceIndexSource.includes("candidate.id === state.activeConversationId") ||
  !sourceTraceIndexSource.includes("MAX_HINTED_ASSISTANT_MESSAGES = 200") ||
  !sourceTraceIndexSource.includes("MAX_SOURCE_FILE_REFERENCES = 1_000") ||
  !sourceTraceIndexSource.includes("MAX_SOURCE_SYMBOLS = 4_096") ||
  !sourceTraceIndexSource.includes("delete decorated.sourceTraceHints") ||
  !sourceTraceIndexSource.includes(
    "source-trace-policy:active-only;assistant=200;file-references=1000;symbols=4096",
  ) ||
  /from\s+["']vscode["']/u.test(sourceTraceIndexSource) ||
  !/interface SourceTraceHint\s*\{\s*\/\*[\s\S]*?fileReferences:\s*string\[\];[\s\S]*?sourceSymbols:\s*string\[\];\s*\}/u.test(
    typesSource,
  )
) {
  failures.push(
    "Source affordances must be host-derived, terminal-only, URI-free hints scoped to the nearest user turn",
  );
}
if (
  !protocolSource.includes("interface SourceAnchorV1") ||
  !protocolSource.includes("normalizedContentSha256: string") ||
  !contextServiceSource.includes("sourceAnchor: sourceAnchor(") ||
  (contextServiceSource.match(/\.\.\.baseSnapshot\(/gu)?.length ?? 0) !== 3 ||
  !contextServiceSource.includes("sourceAnchorSha256") ||
  !conversationStoreSource.includes("normalizeSourceAnchor(") ||
  !conversationStoreSource.includes("value.sourceAnchor,") ||
  !conversationStoreSource.includes("value.content,") ||
  !conversationStoreSource.includes("sourceAnchorSha256") ||
  !sourceAnchorSource.includes("normalizeSourceAnchorContent") ||
  !sourceAnchorSource.includes("sourceAnchorMatchesContent") ||
  conversationStoreSource.includes("sourceTraceHints") ||
  controllerSource.includes("sourceTraceHints")
) {
  failures.push(
    "SourceAnchor V1 must be captured and strictly restored while derived trace hints remain non-persistent",
  );
}
const notebookAnchorV2Fields = [
  "formatVersion: 2",
  "notebookUri: string",
  "notebookType: string",
  "notebookVersion: number",
  "cellIndex: number",
  'cellKind: "code" | "markup"',
  "cellLanguage: string",
  'scope: "range" | "cell"',
  "documentVersion: number",
  "range: NotebookCellTextRangeV2",
  "contentSha256: string",
  "normalizedContentSha256: string",
  "cellContentSha256: string",
  "normalizedCellContentSha256: string",
  "beforeCellSha256?: string",
  "afterCellSha256?: string",
  "workspaceRelativePath?: string",
];
if (
  notebookAnchorV2Fields.some((field) => !notebookAnchorContractSource.includes(field)) ||
  !protocolSource.includes("SourceAnchorV1 | NotebookSourceAnchorV2") ||
  !conversationStoreSource.includes("normalizeNotebookSourceAnchor(") ||
  !conversationStoreSource.includes("value.notebookUri !== contextUri") ||
  !conversationStoreSource.includes("isAllowedNotebookContainerUri(value.notebookUri)") ||
  !conversationStoreSource.includes("value.formatVersion !== 2") ||
  !conversationStoreSource.includes("Object.keys(value).some((key) => !allowedKeys.has(key))") ||
  !conversationStoreSource.includes("/^(?:file|untitled|vscode-remote):/u.test(value)") ||
  !protocolSource.includes("A `vscode-notebook-cell:` URI is intentionally not persisted")
) {
  failures.push(
    "NotebookSourceAnchorV2 must remain a strict container-URI, cell/range, content, and neighbor-fingerprint contract",
  );
}
if (
  !selectionReferenceSource.includes('type: "notebook-cell"') ||
  !selectionReferenceSource.includes("notebookCellReferencesFromEditor(") ||
  !selectionReferenceSource.includes('new Set(["file", "untitled", "vscode-remote"])') ||
  !notebookCaptureSource.includes("MAX_CONTEXT_ATTACHMENTS") ||
  !notebookCaptureSource.includes("assertAllowedContextBundle(snapshots)") ||
  !notebookSnapshotSource.includes("const cellContent = cell.document.getText()") ||
  !notebookSnapshotSource.includes("cell.document.getText(range)") ||
  !notebookSnapshotSource.includes("assertAllowedContext(fileName, content)") ||
  /(?:\.outputs\b|\.metadata\b|\.executionSummary\b|JSON\.stringify\s*\()/u.test(
    notebookSnapshotSource,
  )
) {
  failures.push(
    "Notebook capture must use only explicit Cell TextDocument source and the shared 8/40k/60k context limits",
  );
}
if (
  !selectionReferenceSource.includes("resolveNotebookCellCommandTarget(") ||
  !selectionReferenceSource.includes("candidate === value") ||
  !selectionReferenceSource.includes("allowedNotebookSchemes.has(notebook.uri.scheme)") ||
  !selectionReferenceSource.includes(
    'createNotebookCellReference(cell, exactRange ? "range" : "cell", exactRange)',
  ) ||
  !selectionReferenceSource.includes("isClaimedNotebookCellCommandTarget(") ||
  !selectionReferenceSource.includes("isOpenNotebookDocumentCommandTarget(") ||
  (extensionSource.match(/resolveNotebookCellCommandTarget\(/gu)?.length ?? 0) < 2 ||
  !extensionSource.includes("resolvedTarget\n          ? [resolvedTarget.reference]") ||
  !extensionSource.includes("candidate === undefined ||") ||
  !extensionSource.includes(
    "isOpenNotebookDocumentCommandTarget(candidate, vscode.workspace.notebookDocuments)",
  ) ||
  !extensionSource.includes("isClaimedNotebookCellCommandTarget(candidate) && !resolvedTarget") ||
  !extensionSource.includes("notebookTraceSelection(resolvedTarget.cell, resolvedTarget.reference)")
) {
  failures.push(
    "Notebook Cell-title commands must bind the clicked host-owned Cell by object identity and never fall back from a forged Cell target",
  );
}
if (
  !contextServiceSource.includes('editor.document.uri.scheme === "vscode-notebook-cell"') ||
  !activeEditorSource.includes("isRawNotebookTextDocument(editor.document)") ||
  !activeEditorSource.includes("throw rawNotebookFileError()") ||
  activeEditorSource.indexOf("isRawNotebookTextDocument(editor.document)") >
    activeEditorSource.indexOf("return editor") ||
  captureSelectionSource.indexOf("activeEditor()") < 0 ||
  captureSelectionSource.indexOf("activeEditor()") > captureSelectionSource.indexOf(".getText(") ||
  captureCurrentFileSource.indexOf("activeEditor()") < 0 ||
  captureCurrentFileSource.indexOf("activeEditor()") >
    captureCurrentFileSource.indexOf(".getText(") ||
  captureFilesSource.indexOf('endsWith(".ipynb")') < 0 ||
  captureFilesSource.indexOf('endsWith(".ipynb")') >
    captureFilesSource.indexOf("openTextDocument(uri)") ||
  !contextServiceSource.includes('endsWith(".ipynb")') ||
  !contextServiceSource.includes('"NOTEBOOK_FILE_REQUIRES_NOTEBOOK_API"') ||
  !promptBuilderSource.includes('"NOTEBOOK_RAW_CONTEXT_UNSUPPORTED"') ||
  !promptBuilderSource.includes("/\\.ipynb(?:$|[\\p{Cc}\\p{Cf}])/iu") ||
  !promptBuilderSource.includes("content: context.content") ||
  !promptBuilderSource.includes("`${base}.cell-${cellNumber}${range}.${format.extension}`")
) {
  failures.push(
    "Raw ipynb transport must fail closed while Notebook source uses bounded synthetic per-Cell attachments",
  );
}
if (
  !notebookSourceNavigationSource.includes("resolveNotebookContextCell") ||
  !notebookSourceNavigationSource.includes("resolveNotebookCell") ||
  !notebookSourceNavigationSource.includes("showNotebookContextRange") ||
  !notebookSourceNavigationSource.includes("vscode.workspace.openNotebookDocument(containerUri)") ||
  !notebookSourceNavigationSource.includes("vscode.window.showNotebookDocument") ||
  !notebookSourceNavigationSource.includes("new vscode.NotebookRange") ||
  !notebookSourceNavigationSource.includes("editor.revealRange") ||
  !notebookSourceNavigationSource.includes('return { status: "ambiguous" }') ||
  !notebookSourceNavigationSource.includes('return { status: "missing" }') ||
  !contextNavigationSource.includes("resolveNotebookContextCell(context)") ||
  !contextNavigationSource.includes("showNotebookContextRange(resolution)") ||
  !sourceTraceSource.includes("trustedNotebookResolution") ||
  !sourceTraceSource.includes("notebookContextIdentity") ||
  !conversationTraceSource.includes("notebookReferenceMatchesAnchor") ||
  !conversationTraceSource.includes("notebookRangeMatches") ||
  !extensionSource.includes("registerCommand(ATTACH_NOTEBOOK_CELL_COMMAND")
) {
  failures.push(
    "Notebook cards, answer lines, symbols, and reverse traces must share fail-closed host-authoritative Cell navigation",
  );
}
if (
  !controllerSource.includes("const SAFE_CONVERSATION_ID") ||
  !controllerSource.includes("SAFE_CONVERSATION_ID.test(storedActive)") ||
  !controllerSource.includes("this.createConversation(storedActive)") ||
  !controllerSource.includes(
    "!conversation.remoteUrl && !hasVisibleConversationMessages(conversation)",
  ) ||
  !controllerSource.includes("prepareConversationForDispatch(conversationId: string)") ||
  !controllerSource.includes("buildConversationTranscriptProof(conversation),\n        true,") ||
  !controllerSource.includes("releaseInactiveConversation(conversationId: string)")
) {
  failures.push(
    "Blank drafts must keep a stable reload identity, stay lazy before dispatch, and release inactive views best-effort",
  );
}
if (
  !browserChatBackendSource.includes(
    "const TAB_LEASE_MINIMUM_RELAY_VERSION = [0, 1, 2] as const",
  ) ||
  !browserChatBackendSource.includes("private supportsTabLeases()") ||
  !browserChatBackendSource.includes(
    '...(supportsTabLeases ? { purpose: dispatchIntent ? "dispatch" : "view" } : {})',
  ) ||
  !browserChatBackendSource.includes("!this.supportsTabLeases()") ||
  !browserChatBackendSource.includes(
    "version[0] === minimum[0] && version[1] === minimum[1] && version[2]! >= minimum[2]",
  ) ||
  !browserChatBackendSource.includes('type: "conversation.release"') ||
  !protocolSource.includes('type: z.literal("conversation.release")') ||
  !protocolSource.includes('type: z.literal("conversation.released")') ||
  !protocolRuntimeContractSource.includes("export const PROTOCOL_VERSION = 15")
) {
  failures.push(
    "Protocol v15 tab leases must stay optional and gated to Relay product version 0.1.2 or newer",
  );
}
if (
  !relayStateSource.includes(
    'export type TabProvenance = "created" | "borrowed" | "legacy-unknown"',
  ) ||
  !relayStateSource.includes('value.provenance === undefined ? "legacy-unknown"') ||
  !relayStateSource.includes("owned: boolean;") ||
  !relayStateSource.includes('provenance === "borrowed" ? value.owned !== false') ||
  !relayStateSource.includes('owned: provenance !== "borrowed"') ||
  !relayStateSource.includes("leaseEpoch") ||
  !relayStateSource.includes("releaseRequestedAt") ||
  !relayStateSource.includes("userClaimedAt") ||
  !tabLeasePolicySource.includes("MANAGED_TAB_CAPACITY = MAX_CONCURRENT_RUNS") ||
  !protocolSource.includes("export const MAX_CONCURRENT_RUNS = 3") ||
  !tabLeasePolicySource.includes("selectReusableManagedTab") ||
  !tabLeasePolicySource.includes("isManagedTabCloseCandidate") ||
  !tabLeasePolicySource.includes('record.provenance ?? "legacy-unknown"') ||
  !chromeServiceWorker.includes("async function withTabAllocator") ||
  !chromeServiceWorker.includes('provenance: "borrowed"') ||
  !chromeServiceWorker.includes("owned: false") ||
  !chromeServiceWorker.includes('provenance: "created"') ||
  !chromeServiceWorker.includes("MANAGED_TAB_SURPLUS_IDLE_MS = 10 * 60_000") ||
  !chromeServiceWorker.includes("MANAGED_TAB_DISCONNECTED_IDLE_MS = 30 * 60_000") ||
  !chromeServiceWorker.includes('const MANAGED_TAB_GC_ALARM = "relay-managed-tab-gc"') ||
  !chromeServiceWorker.includes("runManagedTabGc") ||
  !chromeServiceWorker.includes("managedTabCandidateIsAuthoritative") ||
  !chromeServiceWorker.includes("releaseRequestedAt") ||
  !chromeServiceWorker.includes("markManagedTabUserClaimed") ||
  !chromeServiceWorker.includes("cleanupManagedTabsFromPopup") ||
  !allocateConversationTabSource.includes("return withTabAllocator(async () => {") ||
  !allocateConversationTabSource.includes("owned: false") ||
  !allocateConversationTabSource.includes('provenance: "borrowed"') ||
  allocateConversationTabSource.indexOf("owned: false") >
    allocateConversationTabSource.indexOf('provenance: "borrowed"') ||
  (allocateConversationTabSource.match(/await persistSession\(\)/gu)?.length ?? 0) < 3 ||
  (allocateConversationTabSource.match(/conversationTabs\.delete\(input\.key\)/gu)?.length ?? 0) <
    3 ||
  !allocateConversationTabSource.includes(
    "restoreConversationTabLeaseState(oldKey, previousLeaseState)",
  ) ||
  !allocateConversationTabSource.includes("await chrome.tabs.remove(tab.id)") ||
  !inspectManagedTabCandidateSource.includes("const latestTab = await chrome.tabs.get") ||
  !inspectManagedTabCandidateSource.includes(
    "managedTabCandidateIsAuthoritative(authoritativeCandidate)",
  ) ||
  !inspectManagedTabCandidateSource.includes(
    "selectReusableManagedTab([authoritativeCandidate]) === authoritativeCandidate",
  ) ||
  !handleReleaseSource.includes("const previousReleaseRequestedAt") ||
  !handleReleaseSource.includes("record.leaseEpoch === expectedLeaseEpoch") ||
  !handleReleaseSource.includes("delete record.releaseRequestedAt") ||
  !handleReleaseSource.includes("the tab remains leased") ||
  !tryMarkManagedTabIdleSource.includes("const previousIdleSince") ||
  !tryMarkManagedTabIdleSource.includes("record.leaseEpoch === expectedEpoch") ||
  !tryMarkManagedTabIdleSource.includes("releasedConversationKeys.add(key)") ||
  !managedTabGcSource.includes('tabProvenance(entry[1]) !== "created"') ||
  !managedTabGcSource.includes("MANAGED_TAB_DISCONNECTED_IDLE_MS") ||
  !managedTabGcSource.includes("MANAGED_TAB_SURPLUS_IDLE_MS") ||
  !closeManagedTabLeaseSource.includes("inspectContentIdleState(key, record") ||
  !closeManagedTabLeaseSource.includes("conversationTabs.delete(key)") ||
  !closeManagedTabLeaseSource.includes("chrome.tabs.remove(record.tabId)") ||
  closeManagedTabLeaseSource.indexOf("conversationTabs.delete(key)") >
    closeManagedTabLeaseSource.indexOf("chrome.tabs.remove(record.tabId)") ||
  !removeOwnedTabSource.includes('tabProvenance(record) !== "created"') ||
  !removeOwnedTabSource.includes('return "left-open"') ||
  !popupManagedTabCleanupSource.includes('tabProvenance(entry[1]) !== "created"') ||
  !popupManagedTabCleanupSource.includes("inspectManagedTabCandidate") ||
  !popupManagedTabCleanupSource.includes("closeManagedTabLease")
) {
  failures.push(
    "Relay managed tabs must preserve provenance, exclusive leases, soft capacity, LRU reuse, user claims, and conservative GC",
  );
}
if (
  !chromeContentScript.includes('"content.inspectIdleState"') ||
  !chromeContentScript.includes("function inspectIdleState()") ||
  !contentIdlePolicySource.includes('"ambiguous-composer"') ||
  !contentIdlePolicySource.includes('"composer-not-empty"') ||
  !contentIdlePolicySource.includes('"attachments-present"') ||
  !contentIdlePolicySource.includes('"response-control-present"') ||
  !contentIdlePolicySource.includes('"modal-present"')
) {
  failures.push(
    "Managed-tab reuse must require fail-closed page idle attestation with composer, attachment, response-control, and modal checks",
  );
}
if (vscodePackage.scripts.package !== "node ../../scripts/package-vscode.mjs") {
  failures.push("VS Code package command does not use the version-aware package script");
}

const dependencyNames = Object.keys({
  ...vscodePackage.dependencies,
  ...vscodePackage.optionalDependencies,
});
for (const name of dependencyNames) {
  if (/(?:^|[/@-])(?:openai|codex)(?:$|[/@-])/i.test(name)) {
    failures.push(`VS Code extension has forbidden backend dependency: ${name}`);
  }
}

const manifest = await readJson(
  path.join(root, "apps", "chrome-extension", "public", "manifest.json"),
);
const expectedProductVersion = rootPackage.version;
if (
  !/^\d+\.\d+\.\d+$/u.test(expectedProductVersion) ||
  vscodePackage.version !== expectedProductVersion ||
  chromePackage.version !== expectedProductVersion ||
  protocolPackage.version !== expectedProductVersion ||
  manifest.version !== expectedProductVersion
) {
  failures.push("Root, VS Code, Chrome, protocol, and manifest versions must match SemVer");
}
if (
  [rootPackage, vscodePackage, chromePackage, protocolPackage].some(
    (packageManifest) => packageManifest.license !== "MIT",
  )
) {
  failures.push("All publishable package manifests must declare the MIT license");
}
const rootLicense = await readFile(path.join(root, "LICENSE"), "utf8");
const vscodeLicense = await readFile(
  path.join(root, "apps", "vscode-extension", "LICENSE"),
  "utf8",
);
if (rootLicense !== vscodeLicense) {
  failures.push("The packaged VS Code license differs from the repository MIT license");
}
const repositoryUrl = rootPackage.repository?.url;
if (
  typeof repositoryUrl !== "string" ||
  !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/u.test(repositoryUrl) ||
  vscodePackage.repository?.url !== repositoryUrl ||
  vscodePackage.homepage !== rootPackage.homepage ||
  vscodePackage.bugs?.url !== rootPackage.bugs?.url
) {
  failures.push("Root and packaged VS Code GitHub metadata must be valid and identical");
}
if (
  rootPackage.packageManager !== "pnpm@11.20.0" ||
  rootPackage.engines?.node !== "^22.13.0 || >=24.0.0"
) {
  failures.push("The supported Node and pinned pnpm release baseline is stale");
}
const nodeVersion = (await readFile(path.join(root, ".node-version"), "utf8")).trim();
if (nodeVersion !== "24") {
  failures.push(".node-version must select the current Node 24 LTS release line");
}
const thirdPartyNotices = await readFile(path.join(root, "THIRD_PARTY_NOTICES.txt"), "utf8");
if (
  !thirdPartyNotices.startsWith("ASK2GPT THIRD-PARTY NOTICES\n") ||
  !vscodePackage.files.includes("THIRD_PARTY_NOTICES.txt") ||
  !rootPackage.scripts.verify.includes("pnpm notices:check") ||
  !rootPackage.scripts.package.includes("pnpm notices:check")
) {
  failures.push("Third-party license notices are not generated, checked, and packaged");
}
const workspaceConfig = await readFile(path.join(root, "pnpm-workspace.yaml"), "utf8");
for (const safeOverride of [
  '"brace-expansion@<1.1.18": "1.1.18"',
  '"brace-expansion@>=2.0.0 <2.1.4": "2.1.4"',
  '"brace-expansion@>=4.0.0 <5.0.9": "5.0.9"',
  '"fast-uri@>=3.0.0 <3.1.5": "3.1.5"',
  '"ini@<1.3.6": "1.3.8"',
  '"js-yaml@>=4.0.0 <4.3.1": "4.3.1"',
  '"semver@>=2.0.0-alpha <5.7.2": "5.7.2"',
  '"undici@>=7.0.0 <7.29.0": "7.29.0"',
]) {
  if (!workspaceConfig.includes(safeOverride)) {
    failures.push(`pnpm security override is missing: ${safeOverride}`);
  }
}
const ciWorkflow = await readFile(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
const releaseWorkflow = await readFile(
  path.join(root, ".github", "workflows", "release.yml"),
  "utf8",
);
for (const artifact of ["ask2gpt-*.vsix", "ask2gpt-relay-*.zip"]) {
  if (!ciWorkflow.includes(artifact)) failures.push(`CI artifact path is stale: ${artifact}`);
}
for (const [workflow, label] of [
  [ciWorkflow, "CI"],
  [releaseWorkflow, "release"],
]) {
  if (
    workflow.includes("node-version: 20") ||
    workflow.includes("actions/checkout@v4") ||
    workflow.includes("actions/setup-node@v4") ||
    workflow.includes("pnpm/action-setup@v4")
  ) {
    failures.push(`${label} workflow still uses an end-of-life Node or action runtime`);
  }
  if (!workflow.includes("pnpm audit:dependencies")) {
    failures.push(`${label} workflow does not gate on a complete dependency audit`);
  }
}
for (const required of [
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
]) {
  if (!ciWorkflow.includes(required) || !releaseWorkflow.includes(required)) {
    failures.push(`GitHub workflow action pin is missing: ${required}`);
  }
}
if (
  !ciWorkflow.includes("node: 22") ||
  !ciWorkflow.includes("node: 24") ||
  !releaseWorkflow.includes("node-version: 24") ||
  !ciWorkflow.includes("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a")
) {
  failures.push("GitHub workflows do not cover supported Node LTS releases and packaging");
}
if (!rootPackage.scripts.verify.includes("pnpm verify:smoke-harness")) {
  failures.push("pnpm verify does not include the repeatable smoke-harness protocol gate");
}
if (!rootPackage.scripts.verify.includes("pnpm test:webview-preview")) {
  failures.push("pnpm verify does not include the webview preview contract tests");
}
if (!rootPackage.scripts.package?.includes("pnpm verify:artifacts")) {
  failures.push("pnpm package does not verify the generated VSIX and Relay ZIP contents");
}
if (
  rootPackage.scripts["audit:dependencies"] !==
    "pnpm audit --registry=https://registry.npmjs.org --audit-level=low" ||
  rootPackage.scripts["audit:production"] !==
    "pnpm audit --registry=https://registry.npmjs.org --prod --audit-level=low"
) {
  failures.push("Dependency audit scripts do not use the official advisory endpoint");
}
const repeatableSmokeRuns =
  rootPackage.scripts["verify:smoke-harness"]?.match(/\bpnpm test:smoke-script\b/gu)?.length ?? 0;
if (repeatableSmokeRuns < 2) {
  failures.push("verify:smoke-harness does not run the legal protocol probe tests twice");
}
const gitignore = await readFile(path.join(root, ".gitignore"), "utf8");
if (!/(?:^|\n)\.smoke\/(?:\n|$)/u.test(gitignore)) {
  failures.push("Legacy .smoke state is not excluded from source control");
}
if (manifest.name !== "Ask2GPT Relay" || manifest.action?.default_title !== "Ask2GPT Relay") {
  failures.push("Chrome companion branding is not Ask2GPT Relay");
}
const chromePopup = await readFile(
  path.join(root, "apps", "chrome-extension", "popup.html"),
  "utf8",
);
if (!chromePopup.includes("<title>Ask2GPT Relay</title>")) {
  failures.push("Chrome popup title is not branded as Ask2GPT Relay");
}
if (
  !chromePopup.includes('id="tab-pool-section"') ||
  !chromePopup.includes('id="cleanup-managed-tabs"') ||
  !chromePopupSource.includes('type: "popup.cleanupManagedTabs"') ||
  !chromePopupSource.includes('"legacyCandidates"') ||
  !chromePopupSource.includes('"cleanupEligible"')
) {
  failures.push(
    "Chrome popup must expose managed-pool status and a provenance-safe idle-page cleanup action",
  );
}
const chromePackageScript = await readFile(
  path.join(root, "scripts", "package-chrome.mjs"),
  "utf8",
);
const vscodePackageScript = await readFile(
  path.join(root, "scripts", "package-vscode.mjs"),
  "utf8",
);
if (!chromePackageScript.includes("`ask2gpt-relay-${version}.zip`")) {
  failures.push("Chrome package output is not version-aware Ask2GPT Relay");
}
if (
  !chromePackageScript.includes('files["THIRD_PARTY_NOTICES.txt"]') ||
  !vscodePackageScript.includes("await copyFile(noticeSource, stagedNotice)")
) {
  failures.push("Package scripts do not include third-party license notices");
}
if (!vscodePackageScript.includes("`ask2gpt-${version}.vsix`")) {
  failures.push("VS Code package output is not version-aware Ask2GPT");
}
if (
  JSON.stringify([...manifest.permissions].sort()) !==
  JSON.stringify(["alarms", "debugger", "scripting", "storage", "tabs"])
) {
  failures.push("Chrome permissions differ from alarms/debugger/scripting/storage/tabs");
}
if (
  JSON.stringify(manifest.host_permissions) !==
  JSON.stringify(["https://chatgpt.com/*", "http://127.0.0.1/*"])
) {
  failures.push("Chrome host permissions differ from ChatGPT plus the loopback relay");
}
if (
  manifest.minimum_chrome_version !== "116" ||
  manifest.background?.service_worker !== "service-worker.js" ||
  manifest.background?.type !== "module" ||
  manifest.content_scripts?.[0]?.world !== "MAIN" ||
  manifest.content_scripts?.[0]?.run_at !== "document_start" ||
  JSON.stringify(manifest.content_scripts?.[0]?.js) !== JSON.stringify(["page-model-bridge.js"]) ||
  manifest.content_scripts?.[1]?.world !== "ISOLATED" ||
  JSON.stringify(manifest.content_scripts?.[1]?.js) !== JSON.stringify(["content-script.js"])
) {
  failures.push("Chrome MV3/minimum-version/model-bridge/isolated-world invariants changed");
}

const csp = manifest.content_security_policy?.extension_pages ?? "";
for (let port = 32_171; port <= 32_180; port += 1) {
  if (!csp.includes(`ws://127.0.0.1:${port}`)) {
    failures.push(`Chrome CSP is missing relay port ${port}`);
  }
}
if (/ws:\/\/127\.0\.0\.1:\*|ws:\/\/localhost|wss?:\/\/(?!127\.0\.0\.1)/.test(csp)) {
  failures.push("Chrome CSP contains an unreviewed network destination");
}

const extensionId = chromeExtensionId(manifest.key);
if (extensionId !== "jieljndeocnmdlfbmfknfgglfaoneceb") {
  failures.push(`Chrome extension ID changed unexpectedly: ${extensionId}`);
}

if (failures.length > 0) {
  console.error("Read-only architecture boundary verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Read-only architecture boundaries verified across ${productionSources.length} runtime source files.`,
  );
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolute)));
    else files.push(absolute);
  }
  return files;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function normalize(file) {
  return file.split(path.sep).join("/");
}

function boundedSourceSlice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, Math.max(0, start + startMarker.length));
  return start >= 0 && end > start ? source.slice(start, end) : "";
}

function chromeExtensionId(key) {
  const alphabet = "abcdefghijklmnop";
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  return [...digest].map((byte) => `${alphabet[byte >> 4]}${alphabet[byte & 15]}`).join("");
}
