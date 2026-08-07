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
assertProtocolBundle(extensionBundle, "VSIX extension host");
assertSelectionShortcutBundle(extensionBundle, readText(vsixArchive, "extension/readme.md"));
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
  const hiddenPaletteEntry = Array.isArray(menus.commandPalette)
    ? menus.commandPalette.find((entry) => entry?.command === selectionCommandId)
    : undefined;
  const expectedCommands = [
    "ask2gpt.attachCurrentFile",
    "ask2gpt.attachFiles",
    selectionCommandId,
    "ask2gpt.copyDiagnostics",
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
    selectionCommand?.icon !== undefined ||
    selectionCommand?.title !== "问 Ask2GPT（使用当前选区） / Ask About Selection" ||
    !extensionPackage.activationEvents?.includes(`onCommand:${selectionCommandId}`) ||
    hiddenPaletteEntry?.when !== "false" ||
    editorShortcutMenus.length !== 0 ||
    selectionMenuEntries.length !== 0 ||
    contributes.keybindings !== undefined ||
    contributes.codeLens !== undefined ||
    menus["editor/context"] !== undefined ||
    menus["editor/content"] !== undefined ||
    menus["chat/editor/inlineGutter"] !== undefined
  ) {
    throw new Error("VSIX selected-code surface is not reserved for one runtime lightbulb action.");
  }
}

function assertSelectionShortcutBundle(bundle, readme) {
  const selectionCommand = "ask2gpt.attachSelection";
  const selectionContext = "ask2gpt.hasAttachableSelection";
  const currentTitle = "Ask Ask2GPT about this selection";
  const obsoleteTitles = ["Add selection to Ask2GPT", "Add Selection to Chat"];
  if (
    !bundle.includes(selectionCommand) ||
    !bundle.includes("ask2gpt.selection") ||
    !bundle.includes("registerCodeActionsProvider") ||
    !readme.includes(currentTitle) ||
    bundle.includes(selectionContext) ||
    obsoleteTitles.some((title) => bundle.includes(title) || readme.includes(title))
  ) {
    throw new Error(
      "VSIX selected-code shortcut bundle is stale relative to the reviewed lightbulb source.",
    );
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
