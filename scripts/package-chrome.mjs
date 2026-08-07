import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { zipSync } from "fflate";

const root = path.resolve(import.meta.dirname, "..");
const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = rootPackage.version;
const source = path.join(root, "apps", "chrome-extension", "dist");
const target = path.join(root, `ask2gpt-relay-${version}.zip`);
const files = {};

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(absolute);
    } else {
      const relative = path.relative(source, absolute).split(path.sep).join("/");
      files[relative] = new Uint8Array(await readFile(absolute));
    }
  }
}

await collect(source);
files.LICENSE = new Uint8Array(await readFile(path.join(root, "LICENSE")));
files["THIRD_PARTY_NOTICES.txt"] = new Uint8Array(
  await readFile(path.join(root, "THIRD_PARTY_NOTICES.txt")),
);
await writeFile(target, zipSync(files, { level: 9 }));
console.log(`Created ${path.relative(root, target)} with ${Object.keys(files).length} files.`);
