import type { ContextSnapshot } from "@ask2gpt/protocol";
import * as vscode from "vscode";

import { assertAllowedContextFile } from "./services/context-policy";

const ALLOWED_CONTEXT_URI_SCHEMES = new Set(["file", "untitled", "vscode-remote"]);

export type TrustedContextUriFailure = "invalid-uri" | "unsupported-scheme" | "basename-mismatch";

export class TrustedContextUriError extends Error {
  constructor(readonly reason: TrustedContextUriFailure) {
    super(`Untrusted context URI: ${reason}`);
    this.name = "TrustedContextUriError";
  }
}

/** Resolves only the editor URI captured by a host-owned context snapshot. */
export function trustedContextUri(context: ContextSnapshot) {
  assertAllowedContextFile(context.fileName);

  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(context.uri, true);
  } catch {
    throw new TrustedContextUriError("invalid-uri");
  }
  if (!ALLOWED_CONTEXT_URI_SCHEMES.has(uri.scheme.toLowerCase())) {
    throw new TrustedContextUriError("unsupported-scheme");
  }

  const targetPath = uri.fsPath || uri.path || context.fileName;
  assertAllowedContextFile(targetPath);
  if (
    portableBasename(targetPath).toLowerCase() !== portableBasename(context.fileName).toLowerCase()
  ) {
    throw new TrustedContextUriError("basename-mismatch");
  }
  return uri;
}

function portableBasename(value: string) {
  return value.replace(/\\/gu, "/").split("/").at(-1) ?? value;
}
