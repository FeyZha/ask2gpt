import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const target = path.join(root, "THIRD_PARTY_NOTICES.txt");
const mode = process.argv[2];
// inline-style-parser omits a license file from its npm tarball; its README points to the
// reworkcss/css v2.2.4 license for the copied parser implementation.
const fallbackNoticeFiles = new Map([
  [
    "inline-style-parser@0.1.1",
    [
      {
        name: "UPSTREAM-LICENSE",
        text: `(The MIT License)

Copyright (c) 2012 TJ Holowaychuk <tj@vision-media.ca>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the 'Software'), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
      },
    ],
  ],
]);
// micromark 4.0.0 publishes these packages from one repository whose license lives at the tag root.
const micromarkMonorepoNotice = {
  name: "MONOREPO-LICENSE",
  text: `(The MIT License)

Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
};

if (mode !== "--write" && mode !== "--check") {
  throw new Error("Use --write to regenerate notices or --check to verify them.");
}

const report = await readProductionLicenseReport();
const packages = await collectPackages(report);
const generated = renderNotices(packages);

if (mode === "--write") {
  await writeFile(target, generated, "utf8");
  console.log(`Wrote ${path.relative(root, target)} for ${packages.length} production packages.`);
} else {
  let existing;
  try {
    existing = await readFile(target, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (existing !== generated) {
    throw new Error(
      "THIRD_PARTY_NOTICES.txt is missing or stale; run pnpm notices:generate and review it.",
    );
  }
  console.log(`Verified third-party notices for ${packages.length} production packages.`);
}

async function readProductionLicenseReport() {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) {
    throw new Error("pnpm executable path is unavailable; run this script through pnpm.");
  }

  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [pnpmCli, "licenses", "list", "--prod", "--json"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`pnpm licenses was terminated by ${signal}.`));
      } else if (code !== 0) {
        reject(
          new Error(
            `pnpm licenses failed with exit code ${String(code)}: ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
      } else {
        resolve(Buffer.concat(stdout).toString("utf8"));
      }
    });
  });

  return JSON.parse(output);
}

async function collectPackages(report) {
  const packagesByKey = new Map();
  const missingNoticeFiles = [];

  for (const [reportedLicense, entries] of Object.entries(report)) {
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      for (const packageDirectory of entry.paths ?? []) {
        const packageManifest = JSON.parse(
          await readFile(path.join(packageDirectory, "package.json"), "utf8"),
        );
        const name = packageManifest.name ?? entry.name;
        const version = packageManifest.version;
        const key = `${name}@${version}`;
        if (packagesByKey.has(key)) continue;

        const noticeFiles = await readNoticeFiles(packageDirectory);
        const fallback = fallbackFor(key);
        if (noticeFiles.length === 0 && fallback) {
          noticeFiles.push(...fallback);
        }
        if (noticeFiles.length === 0) {
          missingNoticeFiles.push(key);
          continue;
        }

        packagesByKey.set(key, {
          key,
          license: normalizeLicense(packageManifest.license ?? entry.license ?? reportedLicense),
          source: normalizeSource(packageManifest),
          noticeFiles,
        });
      }
    }
  }

  if (missingNoticeFiles.length > 0) {
    throw new Error(
      `Production packages without license or notice files:\n${missingNoticeFiles
        .sort(compare)
        .map((key) => `- ${key}`)
        .join("\n")}`,
    );
  }

  return [...packagesByKey.values()].sort((left, right) => compare(left.key, right.key));
}

async function readNoticeFiles(packageDirectory) {
  const candidates = (await readdir(packageDirectory, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        /^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/iu.test(entry.name),
    )
    .sort((left, right) => compare(left.name.toLowerCase(), right.name.toLowerCase()));

  return Promise.all(
    candidates.map(async (entry) => ({
      name: entry.name,
      text: normalizeText(await readFile(path.join(packageDirectory, entry.name), "utf8")),
    })),
  );
}

function renderNotices(packages) {
  const blocks = new Map();

  for (const packageEntry of packages) {
    for (const notice of packageEntry.noticeFiles) {
      const hash = createHash("sha256").update(notice.text).digest("hex");
      const block = blocks.get(hash) ?? { text: notice.text, appliesTo: [] };
      block.appliesTo.push(`${packageEntry.key} (${notice.name})`);
      blocks.set(hash, block);
    }
  }

  const sortedBlocks = [...blocks.values()]
    .map((block) => ({
      ...block,
      appliesTo: block.appliesTo.sort(compare),
    }))
    .sort((left, right) => compare(left.appliesTo[0], right.appliesTo[0]));

  const lines = [
    "ASK2GPT THIRD-PARTY NOTICES",
    "",
    "Ask2GPT incorporates the production dependencies listed below. Their license and notice",
    "texts are reproduced after the dependency index. This file does not change the license",
    "terms of those projects. It is generated deterministically from pnpm-lock.yaml and the",
    "installed production dependency tree by scripts/generate-third-party-notices.mjs.",
    "",
    "DEPENDENCY INDEX",
    "",
  ];

  for (const packageEntry of packages) {
    const source = packageEntry.source ? ` - ${packageEntry.source}` : "";
    lines.push(`${packageEntry.key} - ${packageEntry.license}${source}`);
  }

  lines.push("", "LICENSE AND NOTICE TEXTS", "");
  for (const block of sortedBlocks) {
    lines.push("=".repeat(80), "Applies to:");
    for (const value of block.appliesTo) lines.push(`- ${value}`);
    lines.push("", block.text, "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function normalizeLicense(license) {
  if (typeof license === "string") return license;
  if (license && typeof license.type === "string") return license.type;
  return "UNKNOWN";
}

function fallbackFor(key) {
  const exact = fallbackNoticeFiles.get(key);
  if (exact) return exact;
  if (key.startsWith("micromark@") || key.startsWith("micromark-")) {
    return [micromarkMonorepoNotice];
  }
  return undefined;
}

function normalizeSource(packageManifest) {
  if (typeof packageManifest.homepage === "string") return packageManifest.homepage;
  const repository = packageManifest.repository;
  if (typeof repository === "string") return repository;
  if (repository && typeof repository.url === "string") {
    return repository.url.replace(/^git\+/u, "").replace(/\.git$/u, "");
  }
  return "";
}

function normalizeText(value) {
  return value.replace(/\r\n?/gu, "\n").trimEnd();
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
