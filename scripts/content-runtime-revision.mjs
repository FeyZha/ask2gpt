import { readFile } from "node:fs/promises";
import path from "node:path";

export async function readContentRuntimeRevision(
  workspaceRoot = path.resolve(import.meta.dirname, ".."),
) {
  const policySource = await readFile(
    path.join(workspaceRoot, "apps", "chrome-extension", "src", "content-runtime-policy.ts"),
    "utf8",
  );
  const contentSource = await readFile(
    path.join(workspaceRoot, "apps", "chrome-extension", "src", "content-script.ts"),
    "utf8",
  );
  const policyRevision = Number(/CONTENT_RUNTIME_REVISION\s*=\s*(\d+)/u.exec(policySource)?.[1]);
  const contentRevision = Number(/SELECTOR_VERSION\s*=\s*(\d+)/u.exec(contentSource)?.[1]);

  if (!Number.isSafeInteger(policyRevision) || policyRevision <= 0) {
    throw new Error("Unable to read the expected content runtime revision.");
  }
  if (contentRevision !== policyRevision) {
    throw new Error(
      `Content script revision ${String(contentRevision)} does not match worker policy ${policyRevision}.`,
    );
  }
  return policyRevision;
}
