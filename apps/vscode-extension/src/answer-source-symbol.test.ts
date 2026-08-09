import { describe, expect, it } from "vitest";

import {
  extractAnswerSourceDefinitions,
  matchKnownAnswerSourceSymbol,
  normalizeAnswerSourceSymbol,
} from "./answer-source-symbol";

describe("answer source symbols", () => {
  it("normalizes plain, qualified and empty-call references but rejects expressions", () => {
    expect(normalizeAnswerSourceSymbol("get_embeddings_endpoint()")).toBe(
      "get_embeddings_endpoint",
    );
    expect(normalizeAnswerSourceSymbol("VectorStore.search()")).toBe("VectorStore.search");
    expect(normalizeAnswerSourceSymbol("search(query)")).toBeUndefined();
    expect(normalizeAnswerSourceSymbol("value + 1")).toBeUndefined();
  });

  it("matches a qualified reference to an attached definition leaf", () => {
    const known = new Set(["search", "VectorStore"]);
    expect(matchKnownAnswerSourceSymbol("VectorStore.search()", known)).toBe("search");
    expect(matchKnownAnswerSourceSymbol("VectorStore.missing()", known)).toBeUndefined();
  });

  it("extracts common Python, TypeScript, Go and method definitions with locations", () => {
    const content = [
      "def python_task(value):",
      "export async function tsTask() {}",
      "const arrowTask = async (value) => value;",
      "func (store *Store) Search(query string) {}",
      "  review(input: string) { return input; }",
      "if (ignored) {",
    ].join("\n");

    expect(extractAnswerSourceDefinitions(content)).toMatchObject([
      { name: "python_task", lineOffset: 0 },
      { name: "tsTask", lineOffset: 1 },
      { name: "arrowTask", lineOffset: 2 },
      { name: "Search", lineOffset: 3 },
      { name: "review", lineOffset: 4 },
    ]);
  });
});
