import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const failures = [];

const legacyTokens = [
  ["ask2" + "insight", "legacy product name"],
  ["qa" + "-assistant", "legacy package namespace"],
  ["qa" + "Assistant", "legacy VS Code namespace"],
  ["QA" + "Assistant", "legacy class namespace"],
  ["vscode-" + "qa" + "-assistant", "legacy workspace name"],
];
const ignoredDirectories = new Set([
  ".git",
  ".smoke",
  ".vscode-test",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);
const textExtensions = new Set([
  ".css",
  ".cjs",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

for (const file of await walk(root)) {
  if (!textExtensions.has(path.extname(file).toLowerCase())) continue;

  const source = await readFile(file, "utf8");
  const relative = normalize(path.relative(root, file));
  for (const [token, label] of legacyTokens) {
    if (source.toLowerCase().includes(token.toLowerCase())) {
      failures.push(`${relative}: contains ${label}`);
    }
  }
}

const rootPackage = await readJson(path.join(root, "package.json"));
const protocolPackage = await readJson(path.join(root, "packages", "protocol", "package.json"));
const chromePackage = await readJson(path.join(root, "apps", "chrome-extension", "package.json"));
const vscodePackage = await readJson(path.join(root, "apps", "vscode-extension", "package.json"));
if (
  rootPackage.name !== "ask2gpt-workspace" ||
  protocolPackage.name !== "@ask2gpt/protocol" ||
  chromePackage.name !== "@ask2gpt/chrome" ||
  vscodePackage.name !== "ask2gpt"
) {
  failures.push("current package identities are not Ask2GPT-specific");
}

if (failures.length > 0) {
  console.error("Ask2GPT isolation verification failed:");
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Ask2GPT isolation verified: legacy content is absent from the publishable source.");
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;

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
