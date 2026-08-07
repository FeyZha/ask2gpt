// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { composerTextMatchesPrompt, readComposerText, setComposerText } from "./composer-input";
import { renderedTextMatchesPrompt } from "./prompt-presentation";

afterEach(() => {
  Reflect.deleteProperty(document, "execCommand");
  document.body.replaceChildren();
});

describe("ChatGPT composer input", () => {
  it("does not emit a duplicate input event after native contenteditable insertion", () => {
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"></div>';
    const composer = document.querySelector<HTMLElement>("#prompt-textarea")!;
    let inputEvents = 0;
    composer.addEventListener("input", () => {
      inputEvents += 1;
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn((_command: string, _showUi: boolean, value: string) => {
        composer.replaceChildren(document.createTextNode(value));
        composer.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }),
        );
        return true;
      }),
    });

    setComposerText(composer, "解释这段代码");

    expect(readComposerText(composer)).toBe("解释这段代码");
    expect(inputEvents).toBe(1);
  });

  it("emits one owned input event when native insertion makes no DOM change", () => {
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"></div>';
    const composer = document.querySelector<HTMLElement>("#prompt-textarea")!;
    const input = vi.fn();
    composer.addEventListener("input", input);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });

    setComposerText(composer, "fallback question");

    expect(readComposerText(composer)).toBe("fallback question");
    expect(input).toHaveBeenCalledTimes(1);
  });

  it("recognizes a multiline prompt preserved in ProseMirror block DOM", () => {
    document.body.innerHTML =
      '<div id="prompt-textarea" class="ProseMirror" contenteditable="true" role="textbox"></div>';
    const composer = document.querySelector<HTMLElement>("#prompt-textarea")!;
    const prompt = "Context:\nalpha\nbeta\n\nQuestion:\n解释代码";
    let inputEvents = 0;
    composer.addEventListener("input", () => {
      inputEvents += 1;
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn((command: string, _showUi: boolean, value?: string) => {
        let paragraph = composer.querySelector("p");
        if (!paragraph) {
          paragraph = document.createElement("p");
          composer.append(paragraph);
        }
        if (command === "insertText") {
          expect(value).not.toContain("\n");
          paragraph.append(document.createTextNode(value ?? ""));
        } else if (command === "insertLineBreak") {
          paragraph.append(document.createElement("br"));
        } else {
          throw new Error(`Unexpected native edit command: ${command}`);
        }
        composer.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: command, data: value ?? null }),
        );
        return true;
      }),
    });

    setComposerText(composer, prompt);

    expect(readComposerText(composer)).toBe(prompt);
    expect(inputEvents).toBe(10);
    expect(composer.querySelectorAll("p")).toHaveLength(1);
    expect(composer.querySelectorAll("br")).toHaveLength(5);
  });

  it("does not approve a multiline prompt that the composer collapsed into one paragraph", () => {
    document.body.innerHTML =
      '<div id="prompt-textarea" class="ProseMirror" contenteditable="true" role="textbox"><p>Context: alpha beta  Question: 解释代码</p></div>';
    const composer = document.querySelector<HTMLElement>("#prompt-textarea")!;
    const prompt = "Context:\nalpha\nbeta\n\nQuestion:\n解释代码";

    expect(readComposerText(composer)).toBe("Context: alpha beta  Question: 解释代码");
    expect(composerTextMatchesPrompt(composer, prompt)).toBe(false);
    expect(
      renderedTextMatchesPrompt(readComposerText(composer), prompt, {
        allowSingleBlockLineFolding: true,
      }),
    ).toBe(true);
    expect(
      renderedTextMatchesPrompt("Context: alpha beta Question: 解释代码", prompt, {
        allowSingleBlockLineFolding: true,
      }),
    ).toBe(false);
  });

  it("does not erase a trailing-break marker placed between meaningful text", () => {
    document.body.innerHTML =
      '<div id="prompt-textarea" class="ProseMirror" contenteditable="true" role="textbox"><p>a<br class="ProseMirror-trailingBreak">b</p></div>';
    const composer = document.querySelector<HTMLElement>("#prompt-textarea")!;

    expect(readComposerText(composer)).toBe("a\nb");
    expect(composerTextMatchesPrompt(composer, "ab")).toBe(false);
  });

  it("accepts only a one-way controlled-editor non-breaking-space rendering", () => {
    document.body.innerHTML =
      '<div id="prompt-textarea" class="ProseMirror" contenteditable="true" role="textbox"></div>';
    const composer = document.querySelector<HTMLElement>("#prompt-textarea")!;
    composer.textContent = "Explain\u00a0this code.";

    expect(composerTextMatchesPrompt(composer, "Explain this code.")).toBe(true);

    composer.textContent = "Explain this code.";
    expect(composerTextMatchesPrompt(composer, "Explain\u00a0this code.")).toBe(false);

    composer.textContent = "Explain this code.\n";
    expect(composerTextMatchesPrompt(composer, "Explain this code.")).toBe(false);

    composer.textContent = "Explain\u00a0this cod.";
    expect(composerTextMatchesPrompt(composer, "Explain this code.")).toBe(false);
  });

  it("does not treat a textarea terminal newline as editor decoration", () => {
    document.body.innerHTML = '<textarea id="prompt-textarea"></textarea>';
    const composer = document.querySelector<HTMLTextAreaElement>("#prompt-textarea")!;
    composer.value = "Explain this code.\n";

    expect(composerTextMatchesPrompt(composer, "Explain this code.")).toBe(false);
  });
});
