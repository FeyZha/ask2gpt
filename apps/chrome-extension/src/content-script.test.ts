// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { serializeAssistant } from "./markdown";

describe("ChatGPT DOM serializer", () => {
  it("preserves headings, lists, tables, links and code blocks", () => {
    document.body.innerHTML = `
      <article data-message-author-role="assistant">
        <h2>Result</h2>
        <p>A <strong>useful</strong> <a href="https://example.com">link</a>.</p>
        <ul><li>One</li><li>Two</li></ul>
        <pre><code class="language-ts">const answer = 42;</code></pre>
        <table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
        <button aria-label="Copy response">Copy</button>
      </article>`;

    const markdown = serializeAssistant(document.querySelector("article")!);
    expect(markdown).toContain("## Result");
    expect(markdown).toContain("**useful**");
    expect(markdown).toContain("[link](https://example.com/)");
    expect(markdown).toContain("- One\n- Two");
    expect(markdown).toContain("```ts\nconst answer = 42;\n```");
    expect(markdown).toContain("| A | B |");
    expect(markdown).not.toContain("Copy response");
  });

  it("does not emit active images, unsafe links, raw HTML, or breakable fences", () => {
    document.body.innerHTML = `
      <article>
        <p>&lt;script&gt;alert(1)&lt;/script&gt;</p>
        <p><a href="javascript:alert(1)">unsafe</a></p>
        <img src="https://cdn.example.com/a.png" alt="diagram" />
        <pre><code class="language-ts">const fence = \`\`\`;</code></pre>
        <p><code>value\`with\`ticks</code></p>
      </article>`;

    const markdown = serializeAssistant(document.querySelector("article")!);
    expect(markdown).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markdown).toContain("unsafe");
    expect(markdown).not.toContain("javascript:");
    expect(markdown).toContain("[Image: diagram](https://cdn.example.com/a.png)");
    expect(markdown).not.toContain("![");
    expect(markdown).toContain("````ts\nconst fence = ```;\n````");
    expect(markdown).toContain("``value`with`ticks``");
  });
});
