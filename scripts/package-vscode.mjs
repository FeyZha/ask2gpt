import { spawn } from "node:child_process";
import { access, copyFile, readFile, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = rootPackage.version;
const target = path.join(root, `ask2gpt-${version}.vsix`);
const pnpmCli = process.env.npm_execpath;
const noticeSource = path.join(root, "THIRD_PARTY_NOTICES.txt");
const stagedNotice = path.join(root, "apps", "vscode-extension", "THIRD_PARTY_NOTICES.txt");

if (!pnpmCli) {
  throw new Error("pnpm executable path is unavailable; run this script through pnpm package.");
}

try {
  await access(stagedNotice);
  throw new Error(`${path.relative(root, stagedNotice)} must not exist before packaging.`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

await copyFile(noticeSource, stagedNotice);
try {
  const child = spawn(
    process.execPath,
    [
      pnpmCli,
      "--filter",
      "./apps/vscode-extension",
      "exec",
      "vsce",
      "package",
      "--no-dependencies",
      "--allow-star-activation",
      "--out",
      target,
    ],
    { cwd: root, stdio: "inherit" },
  );

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`vsce packaging was terminated by ${signal}.`));
      else resolve(code);
    });
  });

  if (exitCode !== 0) {
    throw new Error(`vsce packaging failed with exit code ${String(exitCode)}.`);
  }
} finally {
  await rm(stagedNotice, { force: true });
}

console.log(`Created ${path.relative(root, target)}.`);
