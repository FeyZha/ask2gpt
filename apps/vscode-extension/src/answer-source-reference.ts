const MAX_PATH_LENGTH = 512;
const MAX_LINE_NUMBER = 2_147_483_647;
const MAX_REFERENCES = 200;

const COMMON_SOURCE_EXTENSIONS = new Set([
  "astro",
  "bash",
  "c",
  "cc",
  "cfg",
  "clj",
  "cljs",
  "cmake",
  "coffee",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "cxx",
  "dart",
  "diff",
  "env",
  "ex",
  "exs",
  "fs",
  "fsx",
  "go",
  "graphql",
  "gql",
  "groovy",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "json",
  "jsonc",
  "jsx",
  "kt",
  "kts",
  "less",
  "lua",
  "md",
  "mdx",
  "mjs",
  "mli",
  "ml",
  "php",
  "pl",
  "proto",
  "ps1",
  "py",
  "r",
  "rb",
  "rs",
  "sass",
  "scala",
  "scss",
  "sh",
  "sol",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zig",
  "zsh",
]);

const COMMON_EXTENSIONLESS_FILES = new Set([
  "cmakelists.txt",
  "containerfile",
  "dockerfile",
  "gemfile",
  "justfile",
  "makefile",
  "procfile",
  "rakefile",
]);

const PATH_TOKEN_CHARACTER = /[\p{L}\p{N}_@+.~:/\\-]/u;
const FILE_NAME = /^[\p{L}\p{N}_@+.-]+$/u;
const FILE_EXTENSION = /^[\p{L}][\p{L}\p{N}_+-]{0,31}$/u;

/** A half-open UTF-16 range in the original answer text. */
export interface AnswerSourceTextRange {
  start: number;
  end: number;
}

/** A source location explicitly written in an assistant answer. */
export interface AnswerSourceReference {
  path: string;
  startLine: number;
  endLine: number;
  raw: string;
  textRange: AnswerSourceTextRange;
}

/**
 * Finds explicit `path:line` and `path#Lline` references in answer text.
 *
 * This parser intentionally does not resolve paths. Callers must still resolve a
 * result against trusted workspace files before opening it.
 */
export function parseAnswerSourceReferences(answer: string): AnswerSourceReference[] {
  const references: AnswerSourceReference[] = [];
  const locationPattern = /(?::(\d+)(?:-(\d+))?|#L(\d+)(?:-L?(\d+))?)(?![\p{L}\p{N}_:-])/giu;

  for (const match of answer.matchAll(locationPattern)) {
    if (references.length >= MAX_REFERENCES) break;

    const locationStart = match.index;
    const locationEnd = locationStart + match[0].length;
    if (!hasSafeTrailingBoundary(answer, locationEnd)) continue;

    const pathStart = findPathStart(answer, locationStart, locationEnd);
    if (pathStart === locationStart) continue;
    if (!hasSafeLeadingBoundary(answer, pathStart)) continue;

    const path = answer.slice(pathStart, locationStart);
    if (!isSafeSourcePath(path)) continue;

    const startLine = parseLineNumber(match[1] ?? match[3]);
    const endLine = parseLineNumber(match[2] ?? match[4] ?? match[1] ?? match[3]);
    if (startLine === undefined || endLine === undefined || endLine < startLine) continue;

    references.push({
      path,
      startLine,
      endLine,
      raw: answer.slice(pathStart, locationEnd),
      textRange: { start: pathStart, end: locationEnd },
    });
  }

  return references;
}

function findPathStart(answer: string, pathEnd: number, locationEnd: number) {
  const lineStart = answer.lastIndexOf("\n", pathEnd - 1) + 1;
  const openingBacktick = answer.lastIndexOf("`", pathEnd - 1);
  if (
    openingBacktick >= lineStart &&
    answer[locationEnd] === "`" &&
    answer.slice(openingBacktick + 1, pathEnd).length <= MAX_PATH_LENGTH
  ) {
    return openingBacktick + 1;
  }

  let start = pathEnd;
  while (start > lineStart && PATH_TOKEN_CHARACTER.test(answer[start - 1]!)) start -= 1;
  return start;
}

function parseLineNumber(value: string | undefined) {
  if (!value || value.length > 10) return undefined;
  const line = Number(value);
  if (!Number.isSafeInteger(line) || line < 1 || line > MAX_LINE_NUMBER) return undefined;
  return line;
}

function hasSafeTrailingBoundary(answer: string, locationEnd: number) {
  const next = answer[locationEnd];
  if (next === undefined) return true;
  if (next === "." && /\d/u.test(answer[locationEnd + 1] ?? "")) return false;
  return next !== ":" && next !== "-";
}

function hasSafeLeadingBoundary(answer: string, pathStart: number) {
  const previous = answer[pathStart - 1];
  if (previous === "%") return false;

  const tokenStart = Math.max(
    answer.lastIndexOf(" ", pathStart - 1),
    answer.lastIndexOf("\n", pathStart - 1),
    answer.lastIndexOf("\t", pathStart - 1),
  );
  const prefix = answer.slice(tokenStart + 1, pathStart);
  return !/(?:[a-z][a-z\d+.-]*:\/\/|www\.)/iu.test(prefix);
}

function isSafeSourcePath(path: string) {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH || path.trim() !== path) return false;
  if (hasControlCharacter(path) || /[<>"|?*]/u.test(path)) return false;
  const hasWindowsDrive = /^[A-Za-z]:[\\/]/u.test(path);
  if (!hasWindowsDrive && /^(?:[a-z][a-z\d+.-]*:|www\.)/iu.test(path)) return false;
  if (/^(?:\\\\|\/\/|~[\\/])/u.test(path)) return false;
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(path)) return false;
  if (/%(?:00|2e|2f|5c)/iu.test(path)) return false;
  if (path.includes("@") && !/[\\/]/u.test(path)) return false;

  let relativePath = path;
  const drive = /^[A-Za-z]:[\\/]/u.exec(relativePath);
  if (drive) relativePath = relativePath.slice(drive[0].length);
  if (relativePath.includes(":")) return false;

  relativePath = relativePath.replace(/^\.[\\/]/u, "");
  const components = relativePath.split(/[\\/]/u);
  if (components.length === 0 || components.some((component) => !isSafePathComponent(component))) {
    return false;
  }

  if (looksLikeWebHostPath(components)) return false;

  const fileName = components.at(-1)!;
  if (COMMON_EXTENSIONLESS_FILES.has(fileName.toLowerCase())) return true;
  if (!FILE_NAME.test(fileName)) return false;

  const extension = fileName.split(".").at(-1)?.toLowerCase();
  if (!extension || !FILE_EXTENSION.test(extension)) return false;
  return components.length > 1 || COMMON_SOURCE_EXTENSIONS.has(extension);
}

function isSafePathComponent(component: string) {
  if (component.length === 0 || component === "." || component === "..") return false;
  if (component.endsWith(".") || component.endsWith(" ")) return false;
  return !hasControlCharacter(component) && !/[<>:"|?*]/u.test(component);
}

function hasControlCharacter(value: string) {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function looksLikeWebHostPath(components: string[]) {
  if (components.length < 2) return false;
  const first = components[0]!.toLowerCase();
  return /^(?:localhost|(?:[a-z\d-]+\.)+(?:com|dev|io|net|org))$/u.test(first);
}
