import { readFile } from "node:fs/promises";
import path from "node:path";

import { strFromU8, unzipSync } from "fflate";

import {
  PROTOCOL_VERSION,
  RELAY_WEBSOCKET_PROTOCOL,
} from "../packages/protocol/src/runtime-contract.mjs";
import { readContentRuntimeRevision } from "./content-runtime-revision.mjs";

const root = path.resolve(import.meta.dirname, "..");
const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = rootPackage.version;
const contentRuntimeRevision = await readContentRuntimeRevision(root);
const rootReadme = await readFile(path.join(root, "README.md"), "utf8");
const thirdPartyNotices = await readFile(path.join(root, "THIRD_PARTY_NOTICES.txt"), "utf8");
const relayArchive = await openArchive(`ask2gpt-relay-${version}.zip`);
const vsixArchive = await openArchive(`ask2gpt-${version}.vsix`);
const legacyTokens = [
  ["ask2" + "insight", "legacy product name"],
  ["qa" + "-assistant", "legacy package namespace"],
  ["qa" + "Assistant", "legacy VS Code namespace"],
  ["QA" + "Assistant", "legacy class namespace"],
];
const textExtensions = new Set([
  ".css",
  ".cjs",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".vsixmanifest",
  ".xml",
]);

assertReleaseDocumentation(rootReadme, version, contentRuntimeRevision);

const relayManifest = JSON.parse(readText(relayArchive, "manifest.json"));
readText(relayArchive, "LICENSE");
assertNotices(readText(relayArchive, "THIRD_PARTY_NOTICES.txt"), "Relay ZIP");
if (relayManifest.version !== version) {
  throw new Error(
    `Relay artifact version ${String(relayManifest.version)} does not match ${version}.`,
  );
}
if (
  !Array.isArray(relayManifest.permissions) ||
  !relayManifest.permissions.includes("debugger") ||
  relayManifest.optional_permissions?.includes("debugger")
) {
  throw new Error(
    "Relay artifact must declare debugger as a required permission; Chrome does not allow it as optional.",
  );
}
const relayServiceWorker = readText(relayArchive, "service-worker.js");
const relayContentScript = readText(relayArchive, "content-script.js");
assertProtocolBundle(relayServiceWorker, "Relay service worker");
assertContentRuntimeBundle(relayServiceWorker, "Relay service worker", contentRuntimeRevision);
assertContentRuntimeBundle(relayContentScript, "Relay content script", contentRuntimeRevision);
assertNoLegacyContent(relayArchive, "Relay ZIP");

const extensionPackage = JSON.parse(readText(vsixArchive, "extension/package.json"));
readText(vsixArchive, "extension/LICENSE.txt");
assertNotices(readText(vsixArchive, "extension/THIRD_PARTY_NOTICES.txt"), "VSIX");
if (extensionPackage.version !== version) {
  throw new Error(
    `VSIX artifact version ${String(extensionPackage.version)} does not match ${version}.`,
  );
}
if (extensionPackage.publisher !== "FeyZha") {
  throw new Error(
    `VSIX artifact publisher ${String(extensionPackage.publisher)} does not match FeyZha.`,
  );
}
assertVSIXShortcutSurface(extensionPackage);
const extensionBundle = readText(vsixArchive, "extension/dist/extension.cjs");
const webviewBundle = readText(vsixArchive, "extension/dist/webview/webview.js");
const webviewStyles = readText(vsixArchive, "extension/dist/webview/webview.css");
assertProtocolBundle(extensionBundle, "VSIX extension host");
assertSelectionShortcutBundle(extensionBundle, readText(vsixArchive, "extension/readme.md"));
assertCodeTaskShortcutWebview(webviewBundle, webviewStyles);
assertTraceabilityBundles(extensionBundle, webviewBundle, webviewStyles);
assertNoLegacyContent(vsixArchive, "VSIX");

process.stdout.write(
  `Verified Ask2GPT ${version} artifacts use ${RELAY_WEBSOCKET_PROTOCOL} and content runtime ${contentRuntimeRevision}.\n`,
);

async function openArchive(fileName) {
  const bytes = await readFile(path.join(root, fileName));
  return unzipSync(new Uint8Array(bytes));
}

function readText(archive, entryName) {
  const entry = archive[entryName];
  if (!entry) throw new Error(`Artifact is missing ${entryName}.`);
  return strFromU8(entry);
}

function assertNotices(actual, label) {
  if (actual !== thirdPartyNotices) {
    throw new Error(`${label} third-party notices differ from THIRD_PARTY_NOTICES.txt.`);
  }
}

function assertReleaseDocumentation(readme, expectedVersion, expectedRuntimeRevision) {
  const expectedLines = [
    `- 当前版本：\`${expectedVersion}\``,
    `- Relay 协议：\`v${PROTOCOL_VERSION}\``,
    `- 内容运行时：\`${expectedRuntimeRevision}\``,
  ];
  const missing = expectedLines.filter((line) => !readme.includes(line));
  if (missing.length > 0) {
    throw new Error(`README release metadata is stale: missing ${missing.join(", ")}.`);
  }
}

function assertNoLegacyContent(archive, label) {
  for (const [entryName, bytes] of Object.entries(archive)) {
    if (!textExtensions.has(path.extname(entryName).toLowerCase())) continue;

    const source = strFromU8(bytes).toLowerCase();
    for (const [token, description] of legacyTokens) {
      if (source.includes(token.toLowerCase())) {
        throw new Error(`${label} entry ${entryName} contains ${description}.`);
      }
    }
  }
}

function assertProtocolBundle(bundle, label) {
  if (bundle.includes(RELAY_WEBSOCKET_PROTOCOL)) return;

  const template =
    /(?:var|let|const)\s+([A-Za-z_$][\w$]*)=(\d+),[A-Za-z_$][\w$]*=`ask2gpt\.v\$\{\1\}`/u.exec(
      bundle,
    );
  if (Number(template?.[2]) === PROTOCOL_VERSION) return;

  throw new Error(`${label} does not contain protocol v${PROTOCOL_VERSION}.`);
}

function assertContentRuntimeBundle(bundle, label, expectedRevision) {
  if (bundle.includes(`selectorVersion:${expectedRevision}`)) return;

  for (const match of bundle.matchAll(/selectorVersion:([A-Za-z_$][\w$]*)/gu)) {
    const identifier = match[1];
    const assignment = new RegExp(
      `(?:^|[^\\w$])${escapeRegExp(identifier)}=${expectedRevision}(?!\\d)`,
      "u",
    );
    if (assignment.test(bundle)) return;
  }

  throw new Error(`${label} does not contain content runtime ${expectedRevision}.`);
}

function assertVSIXShortcutSurface(extensionPackage) {
  const selectionCommandId = "ask2gpt.attachSelection";
  const findRelatedTurnCommandId = "ask2gpt.findRelatedTurn";
  const selectionWhen = "editorHasSelection && resourceScheme =~ /^(file|untitled|vscode-remote)$/";
  const selectionViewWhen = "view == ask2gpt.sidebar";
  const contributes = extensionPackage.contributes ?? {};
  const commands = Array.isArray(contributes.commands) ? contributes.commands : [];
  const menus =
    typeof contributes.menus === "object" && contributes.menus !== null ? contributes.menus : {};
  const editorShortcutMenus = Object.keys(menus).filter(
    (menu) => menu.startsWith("editor/") || menu.startsWith("chat/editor/"),
  );
  const selectionCommand = commands.find((entry) => entry?.command === selectionCommandId);
  const selectionMenuEntries = Object.entries(menus).flatMap(([menu, entries]) =>
    Array.isArray(entries)
      ? entries
          .filter((entry) => entry?.command === selectionCommandId && entry.when !== "false")
          .map((entry) => ({ menu, entry }))
      : [],
  );
  const paletteEntry = Array.isArray(menus.commandPalette)
    ? menus.commandPalette.find((entry) => entry?.command === selectionCommandId)
    : undefined;
  const findRelatedTurnCommand = commands.find(
    (entry) => entry?.command === findRelatedTurnCommandId,
  );
  const findRelatedTurnMenuEntries = Object.entries(menus).flatMap(([menu, entries]) =>
    Array.isArray(entries)
      ? entries
          .filter((entry) => entry?.command === findRelatedTurnCommandId && entry.when !== "false")
          .map((entry) => ({ menu, entry }))
      : [],
  );
  const expectedCommands = [
    "ask2gpt.attachCurrentFile",
    "ask2gpt.attachFiles",
    selectionCommandId,
    "ask2gpt.copyDiagnostics",
    findRelatedTurnCommandId,
    "ask2gpt.newConversation",
    "ask2gpt.open",
    "ask2gpt.retryConnection",
  ];
  const actualCommands = commands.map((entry) => entry?.command).sort();

  if (
    extensionPackage.activationEvents?.[0] !== "*" ||
    JSON.stringify(actualCommands) !== JSON.stringify(expectedCommands) ||
    commands.some((entry) => entry?.command === "ask2gpt.askAboutSelection") ||
    selectionCommand?.enablement !== undefined ||
    selectionCommand?.icon !== "$(comment-discussion)" ||
    findRelatedTurnCommand?.enablement !== undefined ||
    findRelatedTurnCommand?.icon !== "$(references)" ||
    selectionCommand?.title !== "问 Ask2GPT（使用当前选区） / Ask About Selection" ||
    !extensionPackage.activationEvents?.includes(`onCommand:${selectionCommandId}`) ||
    !extensionPackage.activationEvents?.includes(`onCommand:${findRelatedTurnCommandId}`) ||
    paletteEntry?.when !== selectionWhen ||
    JSON.stringify(editorShortcutMenus) !== JSON.stringify(["editor/title", "editor/context"]) ||
    selectionMenuEntries.length !== 4 ||
    !selectionMenuEntries.every(({ menu, entry }) =>
      menu === "view/title" ? entry.when === selectionViewWhen : entry.when === selectionWhen,
    ) ||
    findRelatedTurnMenuEntries.length !== 3 ||
    !findRelatedTurnMenuEntries.some(
      ({ menu, entry }) =>
        menu === "commandPalette" && entry.when === selectionWhen && entry.group === undefined,
    ) ||
    !findRelatedTurnMenuEntries.some(
      ({ menu, entry }) =>
        menu === "editor/title" && entry.when === selectionWhen && entry.group === "navigation@2",
    ) ||
    !findRelatedTurnMenuEntries.some(
      ({ menu, entry }) =>
        menu === "editor/context" &&
        entry.when === selectionWhen &&
        entry.group === "navigation@11",
    ) ||
    findRelatedTurnMenuEntries.some(({ menu }) => menu === "view/title") ||
    contributes.keybindings !== undefined ||
    contributes.codeLens !== undefined ||
    menus["editor/title"]?.[0]?.group !== "navigation@1" ||
    menus["editor/context"]?.[0]?.group !== "navigation@10" ||
    menus["view/title"]?.[0]?.group !== "navigation@1" ||
    menus["editor/content"] !== undefined ||
    menus["chat/editor/inlineGutter"] !== undefined
  ) {
    throw new Error(
      "VSIX selected-code surface does not use the reviewed editor and view actions.",
    );
  }
}

function assertSelectionShortcutBundle(bundle, readme) {
  const selectionCommand = "ask2gpt.attachSelection";
  const selectionContext = "ask2gpt.hasAttachableSelection";
  const codeActionTitle = "Ask Ask2GPT about this selection";
  const publicTitle = "Ask About Selection";
  const obsoleteTitles = ["Add selection to Ask2GPT", "Add Selection to Chat"];
  if (
    !bundle.includes(selectionCommand) ||
    !bundle.includes("ask2gpt.selection") ||
    !bundle.includes("registerCodeActionsProvider") ||
    !bundle.includes(codeActionTitle) ||
    !readme.includes(publicTitle) ||
    bundle.includes(selectionContext) ||
    obsoleteTitles.some((title) => bundle.includes(title) || readme.includes(title))
  ) {
    throw new Error(
      "VSIX selected-code shortcut bundle is stale relative to the reviewed editor actions.",
    );
  }
}

function assertCodeTaskShortcutWebview(bundle, styles) {
  const actionIds = [
    "explain",
    "find-issues",
    "fix-error",
    "review",
    "refactor",
    "comments",
    "tests",
    "performance-security",
  ];
  const missingIds = actionIds.filter((id) => !bundle.includes(id));
  const requiredCopy = [
    "代码任务快捷动作",
    "只填入，不自动发送",
    "Code task shortcuts",
    "Fills the draft without sending",
  ];
  const missingCopy = requiredCopy.filter((copy) => !bundle.includes(copy));
  const requiredSelectors = [
    ".code-task-actions",
    ".code-task-actions__list",
    ".code-task-action",
    ".code-task-action:focus-visible",
  ];
  const missingSelectors = requiredSelectors.filter((selector) => !styles.includes(selector));

  if (missingIds.length > 0 || missingCopy.length > 0 || missingSelectors.length > 0) {
    throw new Error(
      `VSIX code-task shortcut webview is stale: missing ${[
        ...missingIds,
        ...missingCopy,
        ...missingSelectors,
      ].join(", ")}.`,
    );
  }
}

function assertTraceabilityBundles(extensionBundle, webviewBundle, styles) {
  const extensionMarkers = [
    "ask2gpt.findRelatedTurn",
    "openSourceReference",
    "sourceTraceHints",
    "source-trace-policy:active-only;assistant=200;file-references=1000;symbols=4096",
    "sourceAnchor",
    "contentSha256",
    "normalizedContentSha256",
    "documentVersion",
    "beforeLineSha256",
    "afterLineSha256",
    "workspaceRelativePath",
    "vscode.executeDocumentSymbolProvider",
    "CONTEXT_RANGE_AMBIGUOUS",
    "SOURCE_CONTEXT_UNTRUSTED",
  ];
  const webviewMarkers = [
    "openSourceReference",
    "sourceTraceHints",
    "source.ask2gpt.invalid",
    "source-reference",
    "Clear selection match",
  ];
  const styleMarkers = [
    ".source-reference",
    ".source-reference:focus-visible",
    ".message-trace-label",
    ".sent-context--trace-target",
  ];
  const missing = [
    ...extensionMarkers.filter((marker) => !extensionBundle.includes(marker)),
    ...webviewMarkers.filter((marker) => !webviewBundle.includes(marker)),
    ...styleMarkers.filter((marker) => !styles.includes(marker)),
  ];
  if (missing.length > 0) {
    throw new Error(`VSIX traceability bundle is stale: missing ${missing.join(", ")}.`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
