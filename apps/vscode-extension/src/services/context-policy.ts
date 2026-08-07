import { Ask2GPTError } from "./errors";

export const MAX_CONTEXT_CHARS = 40_000;
export const MAX_CONTEXT_ATTACHMENTS = 8;
export const MAX_CONTEXT_BUNDLE_CHARS = 60_000;

const blockedBasenames = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_ed25519",
  "id_dsa",
  "id_ecdsa",
  "credentials",
  "credentials.json",
  "service-account.json",
  "service_account.json",
  "secrets.json",
]);
const blockedExtensions = new Set([
  ".cer",
  ".crt",
  ".der",
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".p7b",
  ".p7c",
  ".p8",
  ".pk8",
  ".ppk",
  ".jks",
  ".keystore",
]);

export function isSensitiveContextFile(fileName: string) {
  const basename = portableBasename(fileName).toLowerCase();
  const extensionIndex = basename.lastIndexOf(".");
  const extension = extensionIndex >= 0 ? basename.slice(extensionIndex) : "";
  return (
    basename.startsWith(".env") ||
    blockedBasenames.has(basename) ||
    blockedExtensions.has(extension) ||
    /^(?:credentials|secrets?)(?:[._-].+)?$/.test(basename) ||
    /^service[-_]account(?:[._-].+)?\.json$/.test(basename)
  );
}

export function assertAllowedContextFile(fileName: string) {
  if (isSensitiveContextFile(fileName)) {
    throw new Ask2GPTError("SENSITIVE_CONTEXT", "该文件可能包含密钥或凭据，Ask2GPT 不允许附加。");
  }
}

export function assertAllowedContext(fileName: string, content: string) {
  assertAllowedContextFile(fileName);
  if (isProbablyBinary(content)) {
    throw new Ask2GPTError("BINARY_CONTEXT", "不支持附加二进制内容。");
  }
  if (content.length > MAX_CONTEXT_CHARS) {
    throw new Ask2GPTError(
      "CONTEXT_TOO_LARGE",
      `上下文超过 ${MAX_CONTEXT_CHARS.toLocaleString()} 字符，请选择更小的代码范围。`,
    );
  }
}

export function assertAllowedContextBundle(
  contexts: ReadonlyArray<{ fileName: string; content: string }>,
) {
  if (contexts.length > MAX_CONTEXT_ATTACHMENTS) {
    throw new Ask2GPTError(
      "TOO_MANY_CONTEXTS",
      `最多只能附加 ${MAX_CONTEXT_ATTACHMENTS} 段代码或文件。`,
    );
  }

  let totalChars = 0;
  for (const context of contexts) {
    assertAllowedContext(context.fileName, context.content);
    totalChars += context.content.length;
  }
  if (totalChars > MAX_CONTEXT_BUNDLE_CHARS) {
    throw new Ask2GPTError(
      "CONTEXT_BUNDLE_TOO_LARGE",
      `附件内容合计超过 ${MAX_CONTEXT_BUNDLE_CHARS.toLocaleString()} 字符，请移除或缩小部分附件。`,
    );
  }
}

function isProbablyBinary(content: string) {
  if (content.includes("\u0000")) return true;
  if (!content) return false;

  let suspiciousControls = 0;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0xfffd) {
      suspiciousControls += 1;
    }
  }
  return suspiciousControls > Math.max(2, Math.floor(content.length * 0.01));
}

function portableBasename(fileName: string) {
  return fileName.split(/[\\/]/).at(-1) ?? fileName;
}
