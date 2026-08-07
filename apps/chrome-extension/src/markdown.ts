const OMITTED_TAGS = new Set([
  "audio",
  "button",
  "canvas",
  "embed",
  "form",
  "iframe",
  "input",
  "nav",
  "noscript",
  "object",
  "script",
  "style",
  "svg",
  "template",
  "video",
]);

export function serializeAssistant(element: HTMLElement) {
  const clone = element.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll(
      "button, svg, form, nav, iframe, object, embed, [aria-hidden='true'], [data-testid*='copy']",
    )
    .forEach((node) => node.remove());
  return normalizeBlocks(serializeChildren(clone));
}

function serializeChildren(element: Element): string {
  return [...element.childNodes]
    .map((node) => serializeNode(node))
    .filter(Boolean)
    .join("\n\n");
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeInline(node.textContent ?? "");
  if (!(node instanceof Element)) return "";
  const tag = node.tagName.toLowerCase();

  if (OMITTED_TAGS.has(tag)) return "";
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag[1]);
    return `${"#".repeat(level)} ${serializeInlineChildren(node).trim()}`;
  }
  if (tag === "p") return serializeInlineChildren(node).trim();
  if (tag === "br") return "\n";
  if (tag === "hr") return "---";
  if (tag === "pre") return serializeCodeBlock(node);
  if (tag === "ul" || tag === "ol") return serializeList(node, tag === "ol");
  if (tag === "blockquote") {
    return serializeChildren(node)
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }
  if (tag === "table") return serializeTable(node);
  if (tag === "div" || tag === "section" || tag === "article" || tag === "main") {
    return serializeChildren(node);
  }
  return serializeInlineElement(node);
}

function serializeCodeBlock(element: Element) {
  const code = element.querySelector("code");
  const languageCandidate = [...(code?.classList ?? [])]
    .find((name) => name.startsWith("language-"))
    ?.slice("language-".length);
  const language =
    languageCandidate && /^[A-Za-z0-9_+.-]{1,32}$/.test(languageCandidate) ? languageCandidate : "";
  const content = (code?.textContent ?? element.textContent ?? "").replace(/\n+$/g, "");
  if (!content) return "";
  const longestRun = Math.max(0, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${content}\n${fence}`;
}

function serializeInlineChildren(element: Element) {
  return [...element.childNodes].map((node) => serializeInlineNode(node)).join("");
}

function serializeInlineNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeInline(node.textContent ?? "");
  return node instanceof Element ? serializeInlineElement(node) : "";
}

function serializeInlineElement(element: Element): string {
  const tag = element.tagName.toLowerCase();
  if (OMITTED_TAGS.has(tag)) return "";
  const content = serializeInlineChildren(element);
  if (tag === "strong" || tag === "b") return content ? `**${content}**` : "";
  if (tag === "em" || tag === "i") return content ? `*${content}*` : "";
  if (tag === "del" || tag === "s") return content ? `~~${content}~~` : "";
  if (tag === "code") return serializeCodeSpan(element.textContent ?? "");
  if (tag === "a") {
    const href = safeLink(element.getAttribute("href"));
    return href ? `[${content || escapeInline(href)}](${escapeDestination(href)})` : content;
  }
  if (tag === "img") {
    const href = safeLink(element.getAttribute("src"));
    const alt = escapeInline(element.getAttribute("alt")?.trim() || "image");
    // Images are deliberately serialized as links so the VS Code webview never
    // downloads remote media just by rendering a response.
    return href ? `[Image: ${alt}](${escapeDestination(href)})` : `[Image: ${alt}]`;
  }
  if (tag === "br") return "\n";
  return content;
}

function serializeCodeSpan(content: string) {
  if (!content) return "";
  const longestRun = Math.max(0, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longestRun + 1);
  const needsPadding =
    content.startsWith("`") ||
    content.endsWith("`") ||
    (content.startsWith(" ") && content.endsWith(" "));
  return needsPadding ? `${fence} ${content} ${fence}` : `${fence}${content}${fence}`;
}

function serializeList(element: Element, ordered: boolean): string {
  const items = [...element.children].filter((child) => child.tagName.toLowerCase() === "li");
  const start = ordered ? parseOrderedListStart(element) : 1;
  return items
    .map((item, index) => {
      const prefix = ordered ? `${start + index}. ` : "- ";
      const content = [...item.childNodes]
        .filter(
          (node) => !(node instanceof Element && ["ul", "ol"].includes(node.tagName.toLowerCase())),
        )
        .map((node) => serializeInlineNode(node))
        .join("")
        .trim();
      const nested = [...item.children]
        .filter((child) => ["ul", "ol"].includes(child.tagName.toLowerCase()))
        .map((child) =>
          serializeList(child, child.tagName.toLowerCase() === "ol")
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n"),
        )
        .join("\n");
      return `${prefix}${content}${nested ? `\n${nested}` : ""}`;
    })
    .join("\n");
}

function parseOrderedListStart(element: Element) {
  const parsed = Number.parseInt(element.getAttribute("start") ?? "1", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function serializeTable(table: Element) {
  const rows = [...table.querySelectorAll("tr")].map((row) =>
    [...row.querySelectorAll(":scope > th, :scope > td")].map((cell) =>
      serializeInlineChildren(cell).trim().replace(/\|/g, "\\|").replace(/\n/g, "<br>"),
    ),
  );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  if (width === 0) return "";
  const normalized = rows.map((row) => [
    ...row,
    ...Array.from({ length: width - row.length }, (): string => ""),
  ]);
  const header = normalized[0]!;
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...normalized.slice(1).map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function safeLink(value: string | null) {
  if (!value) return undefined;
  try {
    const url = new URL(value, "https://chatgpt.com/");
    if (!["https:", "http:", "mailto:"].includes(url.protocol)) return undefined;
    if (url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function escapeDestination(value: string) {
  return value.replace(/\\/g, "%5C").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function escapeInline(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`[\]*_])/g, "\\$1");
}

function normalizeBlocks(value: string) {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
