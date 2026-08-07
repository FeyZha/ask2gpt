import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const vscodeMock = vi.hoisted(() => {
  class FakeCodeActionKind {
    constructor(readonly value: string) {}

    append(part: string) {
      return new FakeCodeActionKind(`${this.value}.${part}`);
    }

    intersects(other: FakeCodeActionKind) {
      return (
        this.value === other.value ||
        this.value.startsWith(`${other.value}.`) ||
        other.value.startsWith(`${this.value}.`)
      );
    }
  }

  class FakeCodeAction {
    command:
      | {
          command: string;
          title: string;
          arguments?: unknown[];
        }
      | undefined;

    constructor(
      readonly title: string,
      readonly kind?: FakeCodeActionKind,
    ) {}
  }

  return {
    CodeAction: FakeCodeAction,
    CodeActionKind: {
      QuickFix: new FakeCodeActionKind("quickfix"),
      Refactor: new FakeCodeActionKind("refactor"),
    },
    activeTextEditor: undefined as unknown,
    language: "zh-cn",
    registerCodeActionsProvider: vi.fn(() => ({ dispose: vi.fn() })),
  };
});

vi.mock("vscode", () => ({
  CodeAction: vscodeMock.CodeAction,
  CodeActionKind: vscodeMock.CodeActionKind,
  env: {
    get language() {
      return vscodeMock.language;
    },
  },
  languages: {
    registerCodeActionsProvider: vscodeMock.registerCodeActionsProvider,
  },
  window: {
    get activeTextEditor() {
      return vscodeMock.activeTextEditor;
    },
  },
}));

import {
  ASK_SELECTION_ACTION_KIND,
  registerSelectionCodeActionProvider,
  SelectionCodeActionProvider,
} from "./selection-code-action";
import { ATTACH_SELECTION_COMMAND } from "./selection-handoff";

describe("SelectionCodeActionProvider", () => {
  beforeEach(() => {
    vscodeMock.activeTextEditor = undefined;
    vscodeMock.language = "zh-cn";
    vscodeMock.registerCodeActionsProvider.mockClear();
  });

  it("registers one selection quick fix for supported editor schemes", () => {
    const disposable = registerSelectionCodeActionProvider();

    expect(vscodeMock.registerCodeActionsProvider).toHaveBeenCalledOnce();
    expect(vscodeMock.registerCodeActionsProvider).toHaveBeenCalledWith(
      [{ scheme: "file" }, { scheme: "untitled" }, { scheme: "vscode-remote" }],
      expect.any(SelectionCodeActionProvider),
      { providedCodeActionKinds: [ASK_SELECTION_ACTION_KIND] },
    );
    expect(typeof disposable.dispose).toBe("function");
  });

  it("captures the exact document version and selected range without sending", () => {
    const provider = new SelectionCodeActionProvider();
    const activeDocument = document();
    const activeRange = range();
    vscodeMock.activeTextEditor = { document: activeDocument, selection: activeRange };
    const actions = provider.provideCodeActions(
      activeDocument,
      activeRange,
      codeActionContext(),
      cancellationToken(),
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      title: "问 Ask2GPT（使用当前选区）",
      kind: ASK_SELECTION_ACTION_KIND,
      command: {
        command: ATTACH_SELECTION_COMMAND,
        title: "问 Ask2GPT（使用当前选区）",
        arguments: [
          {
            uri: "file:///repo/src/index.ts",
            documentVersion: 7,
            startLine: 3,
            startCharacter: 2,
            endLine: 8,
            endCharacter: 5,
          },
        ],
      },
    });
    expect(actions[0]?.isPreferred).toBeUndefined();
    expect(actions[0]?.edit).toBeUndefined();
    expect(actions[0]?.diagnostics).toBeUndefined();
  });

  it.each(["file", "untitled", "vscode-remote"])(
    "offers exactly one action for an explicit %s editor selection",
    (scheme) => {
      const activeDocument = document(scheme);
      const activeRange = range();
      vscodeMock.activeTextEditor = { document: activeDocument, selection: activeRange };

      expect(
        new SelectionCodeActionProvider().provideCodeActions(
          activeDocument,
          activeRange,
          codeActionContext(),
          cancellationToken(),
        ),
      ).toHaveLength(1);
    },
  );

  it("uses a concise English label outside Chinese locales", () => {
    vscodeMock.language = "en";
    const activeDocument = document();
    const activeRange = range();
    vscodeMock.activeTextEditor = { document: activeDocument, selection: activeRange };

    const [action] = new SelectionCodeActionProvider().provideCodeActions(
      activeDocument,
      activeRange,
      codeActionContext(),
      cancellationToken(),
    );

    expect(action?.title).toBe("Ask Ask2GPT about this selection");
  });

  it("stays absent for empty ranges, cancelled requests, and unrelated editors", () => {
    const provider = new SelectionCodeActionProvider();
    const emptyDocument = document();
    const emptyRange = range(true);
    vscodeMock.activeTextEditor = { document: emptyDocument, selection: emptyRange };

    expect(
      provider.provideCodeActions(
        emptyDocument,
        emptyRange,
        codeActionContext(),
        cancellationToken(),
      ),
    ).toEqual([]);
    const activeDocument = document();
    const activeRange = range();
    vscodeMock.activeTextEditor = { document: activeDocument, selection: activeRange };
    expect(
      provider.provideCodeActions(
        activeDocument,
        activeRange,
        codeActionContext(),
        cancellationToken(true),
      ),
    ).toEqual([]);
    const outputDocument = document("output");
    const outputRange = range();
    vscodeMock.activeTextEditor = { document: outputDocument, selection: outputRange };
    expect(
      provider.provideCodeActions(
        outputDocument,
        outputRange,
        codeActionContext(),
        cancellationToken(),
      ),
    ).toEqual([]);
  });

  it("does not leak into unrelated code-action menus", () => {
    const provider = new SelectionCodeActionProvider();
    const activeDocument = document();
    const activeRange = range();
    vscodeMock.activeTextEditor = { document: activeDocument, selection: activeRange };

    expect(
      provider.provideCodeActions(
        activeDocument,
        activeRange,
        codeActionContext(vscodeMock.CodeActionKind.Refactor),
        cancellationToken(),
      ),
    ).toEqual([]);
    expect(
      provider.provideCodeActions(
        activeDocument,
        activeRange,
        codeActionContext(vscodeMock.CodeActionKind.QuickFix),
        cancellationToken(),
      ),
    ).toHaveLength(1);
  });

  it("never turns a diagnostic or background document range into selected context", () => {
    const provider = new SelectionCodeActionProvider();
    const activeDocument = document();
    const activeRange = range();
    vscodeMock.activeTextEditor = { document: activeDocument, selection: activeRange };

    expect(
      provider.provideCodeActions(
        activeDocument,
        {
          ...range(),
          start: { line: 20, character: 0 },
          end: { line: 20, character: 5 },
        } as unknown as vscode.Range,
        codeActionContext(),
        cancellationToken(),
      ),
    ).toEqual([]);
    expect(
      provider.provideCodeActions(
        document("file", "file:///repo/src/other.ts"),
        activeRange,
        codeActionContext(),
        cancellationToken(),
      ),
    ).toEqual([]);

    vscodeMock.activeTextEditor = {
      document: { ...activeDocument, version: activeDocument.version + 1 },
      selection: activeRange,
    };
    expect(
      provider.provideCodeActions(
        activeDocument,
        activeRange,
        codeActionContext(),
        cancellationToken(),
      ),
    ).toEqual([]);
  });
});

function document(scheme = "file", uri = `${scheme}:///repo/src/index.ts`): vscode.TextDocument {
  return {
    uri: {
      scheme,
      toString: () => uri,
    },
    version: 7,
  } as unknown as vscode.TextDocument;
}

function range(isEmpty = false): vscode.Range {
  return {
    isEmpty,
    start: { line: 3, character: 2 },
    end: { line: 8, character: 5 },
  } as unknown as vscode.Range;
}

function codeActionContext(only?: unknown): vscode.CodeActionContext {
  return { diagnostics: [], only, triggerKind: 2 } as unknown as vscode.CodeActionContext;
}

function cancellationToken(isCancellationRequested = false): vscode.CancellationToken {
  return { isCancellationRequested } as unknown as vscode.CancellationToken;
}
