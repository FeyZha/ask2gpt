const MAX_SYMBOL_LENGTH = 160;
const SYMBOL_SEGMENT = "[\\p{L}_$][\\p{L}\\p{N}_$]*";
const QUALIFIED_SYMBOL_PATTERN = new RegExp(`^${SYMBOL_SEGMENT}(?:\\.${SYMBOL_SEGMENT})*$`, "u");
const DECLARATION_PATTERN = new RegExp(
  `^\\s*(?:(?:export|default|public|private|protected|static|abstract|async|final|open|override|inline)\\s+)*(?:def|fn|function|class|interface|enum|struct|trait|type|record|module|namespace)\\s+(${SYMBOL_SEGMENT})\\b`,
  "u",
);
const GO_FUNCTION_PATTERN = new RegExp(
  `^\\s*func\\s+(?:\\([^)]*\\)\\s*)?(${SYMBOL_SEGMENT})\\s*\\(`,
  "u",
);
const ARROW_FUNCTION_PATTERN = new RegExp(
  `^\\s*(?:(?:export|default)\\s+)*(?:const|let|var)\\s+(${SYMBOL_SEGMENT})\\b[^=]*=\\s*(?:async\\s+)?(?:${SYMBOL_SEGMENT}|\\([^)]*\\))\\s*=>`,
  "u",
);
const METHOD_PATTERN = new RegExp(
  `^\\s*(?:(?:public|private|protected|static|abstract|async|final|open|override|readonly|virtual|sealed)\\s+)*(?:(?:${SYMBOL_SEGMENT}|[\\w.$<>?,\\[\\]]+)\\s+)?(${SYMBOL_SEGMENT})\\s*\\([^;]*\\)\\s*(?:\\{|:|=>)`,
  "u",
);
const CONTROL_FLOW_NAMES = new Set(["catch", "for", "if", "match", "switch", "while", "with"]);

export interface AnswerSourceDefinition {
  name: string;
  lineOffset: number;
  startCharacter: number;
  endCharacter: number;
}

/** Normalizes an inline-code function/symbol reference without accepting expressions. */
export function normalizeAnswerSourceSymbol(value: string): string | undefined {
  let normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_SYMBOL_LENGTH) return undefined;
  normalized = normalized.replace(/\(\s*\)$/u, "");
  if (!QUALIFIED_SYMBOL_PATTERN.test(normalized)) return undefined;
  return normalized;
}

/** Returns the exact known definition name addressed by a qualified answer token. */
export function matchKnownAnswerSourceSymbol(
  value: string,
  knownSymbols: ReadonlySet<string>,
): string | undefined {
  const normalized = normalizeAnswerSourceSymbol(value);
  if (!normalized) return undefined;
  if (knownSymbols.has(normalized)) return normalized;
  const leaf = normalized.split(".").at(-1)!;
  return knownSymbols.has(leaf) ? leaf : undefined;
}

/**
 * Builds a bounded, language-agnostic definition index from an already
 * attached context snapshot. Host language providers remain authoritative;
 * this index controls link affordances and is also a no-provider fallback.
 */
export function extractAnswerSourceDefinitions(content: string): AnswerSourceDefinition[] {
  const definitions: AnswerSourceDefinition[] = [];
  const seen = new Set<string>();
  const lines = content.split(/\r?\n/u);

  for (let lineOffset = 0; lineOffset < lines.length && definitions.length < 512; lineOffset += 1) {
    const line = lines[lineOffset]!;
    const match =
      DECLARATION_PATTERN.exec(line) ??
      GO_FUNCTION_PATTERN.exec(line) ??
      ARROW_FUNCTION_PATTERN.exec(line) ??
      METHOD_PATTERN.exec(line);
    const name = match?.[1];
    if (!name || CONTROL_FLOW_NAMES.has(name) || seen.has(name)) continue;
    const startCharacter = line.indexOf(name, match.index);
    if (startCharacter < 0) continue;
    seen.add(name);
    definitions.push({
      name,
      lineOffset,
      startCharacter,
      endCharacter: startCharacter + name.length,
    });
  }

  return definitions;
}
