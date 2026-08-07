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
  "ask2gpt.attachSelection",
  "ask2gpt.copyDiagnostics",
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
const hiddenPaletteEntry = vscodePackage.contributes.menus.commandPalette?.find(
  (entry) => entry.command === attachSelectionCommand,
);
if (
  attachSelectionContribution?.enablement !== undefined ||
  attachSelectionContribution?.icon !== undefined ||
  !vscodePackage.activationEvents.includes(`onCommand:${attachSelectionCommand}`) ||
  hiddenPaletteEntry?.when !== "false" ||
  editorShortcutMenus.length !== 0 ||
  visibleAttachSelectionMenus.length !== 0 ||
  vscodePackage.contributes.keybindings !== undefined
) {
  failures.push("VS Code selected-code surface must be reserved for one runtime lightbulb action");
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
if (
  !extensionSource.includes("registerSelectionCodeActionProvider()") ||
  !selectionCodeActionSource.includes("registerCodeActionsProvider") ||
  !selectionCodeActionSource.includes('QuickFix.append("ask2gpt.selection")') ||
  !selectionCodeActionSource.includes(`command: ATTACH_SELECTION_COMMAND`) ||
  !selectionCodeActionSource.includes("vscode.window.activeTextEditor") ||
  (selectionCodeActionSource.match(/new vscode\.CodeAction\(/gu)?.length ?? 0) !== 1 ||
  selectionCodeActionSource.includes("isPreferred = true") ||
  !productionSources.some((file) => normalize(file).endsWith("/selection-code-action.ts")) ||
  productionSources.some((file) => normalize(file).endsWith("/selection-context.ts")) ||
  vscodePackage.contributes.codeLens !== undefined ||
  vscodePackage.contributes.menus["editor/context"] !== undefined ||
  vscodePackage.contributes.menus["chat/editor/inlineGutter"] !== undefined ||
  vscodePackage.contributes.menus["editor/content"] !== undefined ||
  selectionHandoffSource.includes("workbench.action.chat.attachSelection") ||
  selectionHandoffSource.includes("nativeSelectionAffordanceAvailable") ||
  extensionSource.includes("NATIVE_ATTACH_SELECTION_COMMAND") ||
  extensionSource.includes("NATIVE_SELECTION_AFFORDANCE_CONTEXT")
) {
  failures.push(
    "VS Code selected-code handoff must avoid duplicate surfaces and private workbench commands",
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

function chromeExtensionId(key) {
  const alphabet = "abcdefghijklmnop";
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  return [...digest].map((byte) => `${alphabet[byte >> 4]}${alphabet[byte & 15]}`).join("");
}
