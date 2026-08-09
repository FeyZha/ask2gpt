import { describe, expect, it } from "vitest";

import { parseAnswerSourceReferences } from "./answer-source-reference";

describe("answer source reference parser", () => {
  it("parses colon line references and preserves their exact answer ranges", () => {
    const answer = "查看 06_vector_store.py:34，以及 path/to/a.ts:10-12。";

    const references = parseAnswerSourceReferences(answer);

    expect(references).toEqual([
      {
        path: "06_vector_store.py",
        startLine: 34,
        endLine: 34,
        raw: "06_vector_store.py:34",
        textRange: {
          start: answer.indexOf("06_vector_store.py"),
          end: answer.indexOf("06_vector_store.py") + "06_vector_store.py:34".length,
        },
      },
      {
        path: "path/to/a.ts",
        startLine: 10,
        endLine: 12,
        raw: "path/to/a.ts:10-12",
        textRange: {
          start: answer.indexOf("path/to/a.ts"),
          end: answer.indexOf("path/to/a.ts") + "path/to/a.ts:10-12".length,
        },
      },
    ]);
  });

  it("parses GitHub-style single lines and ranges", () => {
    expect(parseAnswerSourceReferences("a.py#L34 a.py#L34-L40 a.py#l7-l9")).toMatchObject([
      { path: "a.py", startLine: 34, endLine: 34, raw: "a.py#L34" },
      { path: "a.py", startLine: 34, endLine: 40, raw: "a.py#L34-L40" },
      { path: "a.py", startLine: 7, endLine: 9, raw: "a.py#l7-l9" },
    ]);
  });

  it("keeps Windows drive letters and accepts local absolute paths", () => {
    expect(
      parseAnswerSourceReferences("C:\\work\\src\\main.ts:9-11 D:/repo/lib/a.py#L4"),
    ).toMatchObject([
      { path: "C:\\work\\src\\main.ts", startLine: 9, endLine: 11 },
      { path: "D:/repo/lib/a.py", startLine: 4, endLine: 4 },
    ]);
  });

  it("supports Unicode paths and whitespace when a reference is code-quoted", () => {
    expect(
      parseAnswerSourceReferences("`src/向量 搜索/入口.py:12` 和 模块/处理器.ts#L8"),
    ).toMatchObject([
      { path: "src/向量 搜索/入口.py", raw: "src/向量 搜索/入口.py:12", startLine: 12 },
      { path: "模块/处理器.ts", raw: "模块/处理器.ts#L8", startLine: 8 },
    ]);
  });

  it("recognizes common extensionless source files without treating prose as a path", () => {
    expect(
      parseAnswerSourceReferences("Dockerfile:12 src/Containerfile:5 sentence.end:42"),
    ).toMatchObject([
      { path: "Dockerfile", startLine: 12 },
      { path: "src/Containerfile", startLine: 5 },
    ]);
  });

  it("rejects URLs even when their tail resembles a source reference", () => {
    const answer = [
      "https://example.com/src/a.ts:34",
      "http://localhost/a.py#L8",
      "file:///workspace/a.ts:9",
      "www.example.org/a.rs:10",
      "example.dev/a.go:11",
    ].join(" ");

    expect(parseAnswerSourceReferences(answer)).toEqual([]);
  });

  it("rejects traversal, network, encoded-dangerous, and overlong paths", () => {
    const longPath = `${"a".repeat(513)}.ts:7`;
    const answer = [
      "../secret.ts:1",
      "src/../../secret.ts:2",
      "\\\\server\\share\\a.py:3",
      "~/private/a.ts:4",
      "src/%2e%2e/secret.ts:5",
      longPath,
    ].join(" ");

    expect(parseAnswerSourceReferences(answer)).toEqual([]);
  });

  it("rejects missing, zero, reversed, huge, and malformed line locations", () => {
    const answer = [
      "a.py",
      "a.py:0",
      "a.py#L0",
      "a.py:12-8",
      "a.py#L12-L8",
      "a.py:2147483648",
      "a.py:99999999999",
      "a.py:12:4",
      "a.py:12-14-16",
      "a.py:12.5",
      "a.py:12suffix",
    ].join(" ");

    expect(parseAnswerSourceReferences(answer)).toEqual([]);
  });

  it("does not confuse times, versions, email addresses, or doubled punctuation with files", () => {
    const answer = "12:34 v1.2:34 test@example.py:34 foo.py::34 object.method:34";

    expect(parseAnswerSourceReferences(answer)).toEqual([]);
  });

  it("accepts ordinary surrounding Markdown punctuation", () => {
    expect(parseAnswerSourceReferences("(**src/a.ts:7**), [`b.py#L8-L10`].")).toMatchObject([
      { path: "src/a.ts", startLine: 7, endLine: 7 },
      { path: "b.py", startLine: 8, endLine: 10 },
    ]);
  });

  it("caps the number of references returned from an untrusted answer", () => {
    const answer = Array.from({ length: 250 }, (_, index) => `src/f${index}.ts:1`).join(" ");

    expect(parseAnswerSourceReferences(answer)).toHaveLength(200);
  });
});
