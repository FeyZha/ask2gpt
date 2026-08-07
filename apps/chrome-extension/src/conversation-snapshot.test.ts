// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://chatgpt.com/c/conversation-123"}

import { beforeEach, describe, expect, it, vi } from "vitest";

type ContentListener = (
  message: unknown,
  sender: { id: string },
  sendResponse: (response: Record<string, unknown>) => void,
) => boolean;

let contentListener: ContentListener;

beforeEach(async () => {
  vi.resetModules();
  history.replaceState(null, "", "/c/conversation-123");
  document.title = "Readable snapshot";
  document.body.replaceChildren();
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        id: "ask2gpt-test",
        sendMessage: vi.fn(async () => ({ ok: true })),
        onMessage: {
          addListener: vi.fn((listener: ContentListener) => {
            contentListener = listener;
          }),
        },
      },
    },
  });
  await import("./content-script");
});

describe("mapped ChatGPT conversation snapshots", () => {
  it("extracts visible user and assistant turns in page order", async () => {
    document.body.innerHTML = `
      <article data-message-author-role="user"><p>Why is this slow?</p></article>
      <article data-message-author-role="assistant">
        <h2>Reason</h2><p>There are two network hops.</p>
        <button type="button" aria-label="Copy response">Copy</button>
      </article>`;
    markElementVisible(
      document.querySelector<HTMLButtonElement>('button[aria-label="Copy response"]')!,
    );

    const response = await inspectConversation();

    expect(response).toMatchObject({
      ok: true,
      remoteUrl: "https://chatgpt.com/c/conversation-123",
      title: "Readable snapshot",
      complete: true,
      messages: [
        { role: "user", markdown: "Why is this slow?" },
        { role: "assistant", markdown: "## Reason\n\nThere are two network hops." },
      ],
    });
    expect(Number.isFinite(Date.parse(String(response.observedAt)))).toBe(true);
  });

  it("ignores same-document skip links and strips the Project prefix from the page title", async () => {
    history.replaceState(null, "", "/g/project-scope/c/conversation-123");
    document.title = "Ask2GPT - OK";
    document.body.innerHTML = `
      <a href="#main">跳至内容</a>
      <main id="main">
        <article data-message-author-role="user">Only reply OK</article>
        <article data-message-author-role="assistant">OK</article>
      </main>`;
    markAnchorsVisible();

    const response = await inspectConversation();

    expect(response).toMatchObject({
      ok: true,
      remoteUrl: "https://chatgpt.com/g/project-scope/c/conversation-123",
      title: "OK",
    });
  });

  it("prefers a real current-conversation link when a skip link is also visible", async () => {
    history.replaceState(null, "", "/g/project-scope/c/conversation-123");
    document.title = "Ask2GPT - Stale title";
    document.body.innerHTML = `
      <a href="#main">跳至内容</a>
      <a href="/g/project-scope/c/conversation-123">Correct conversation title</a>
      <main id="main">
        <article data-message-author-role="user">Question</article>
        <article data-message-author-role="assistant">Answer</article>
      </main>`;
    markAnchorsVisible();

    const response = await inspectConversation();

    expect(response.title).toBe("Correct conversation title");
  });

  it("marks a bounded snapshot partial when more than 200 turns are rendered", async () => {
    document.body.replaceChildren(
      ...Array.from({ length: 201 }, (_, index) => {
        const message = document.createElement("article");
        message.dataset.messageAuthorRole = index % 2 === 0 ? "user" : "assistant";
        message.textContent = `turn ${index}`;
        return message;
      }),
    );

    const response = await inspectConversation();
    const messages = response.messages as unknown[];

    expect(response.complete).toBe(false);
    expect(messages).toHaveLength(200);
    expect(messages.at(-1)).toEqual({ role: "user", markdown: "turn 200" });
  });

  it("marks the snapshot partial when ChatGPT exposes a virtualization signal", async () => {
    document.body.innerHTML = `
      <div data-virtualized="true"></div>
      <article data-message-author-role="user">Question</article>
      <article data-message-author-role="assistant">Answer</article>`;

    const response = await inspectConversation();
    expect(response.complete).toBe(false);
  });
});

async function inspectConversation() {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const asynchronous = contentListener(
      { type: "content.inspectConversation" },
      { id: "ask2gpt-test" },
      resolve,
    );
    if (!asynchronous) reject(new Error("Content script rejected the snapshot command."));
  });
}

function markAnchorsVisible() {
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    markElementVisible(anchor);
  }
}

function markElementVisible(element: HTMLElement) {
  element.getBoundingClientRect = () =>
    ({
      bottom: 20,
      height: 20,
      left: 0,
      right: 200,
      top: 0,
      width: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}
