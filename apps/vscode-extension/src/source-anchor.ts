import { createHash } from "node:crypto";

import type { SourceAnchorV1 } from "@ask2gpt/protocol";

/** V1 normalization is a persistence contract; change it only in a new format version. */
export function normalizeSourceAnchorContent(content: string) {
  return content
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

export function sourceAnchorSha256(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function sourceAnchorMatchesContent(anchor: SourceAnchorV1, content: string) {
  return (
    anchor.contentSha256 === sourceAnchorSha256(content) ||
    anchor.normalizedContentSha256 === sourceAnchorSha256(normalizeSourceAnchorContent(content))
  );
}
