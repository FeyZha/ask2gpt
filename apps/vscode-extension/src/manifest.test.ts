import { describe, expect, it } from "vitest";

import rootManifest from "../../../package.json";
import manifest from "../package.json";

describe("VS Code discoverability manifest", () => {
  it("contributes Codex-aligned composer preferences without unsupported modes", () => {
    const properties = manifest.contributes.configuration.properties;

    expect(properties["ask2gpt.followUpQueueMode"]).toMatchObject({
      type: "string",
      default: "queue",
      enum: ["queue", "interrupt"],
    });
    expect(properties["ask2gpt.followUpQueueMode"].enum).not.toContain("steer");
    expect(properties["ask2gpt.followUpQueueMode"].description).toBeTruthy();
    expect(properties["ask2gpt.followUpQueueMode"].enumDescriptions).toHaveLength(2);

    expect(properties["ask2gpt.composerEnterBehavior"]).toMatchObject({
      type: "string",
      default: "enter",
      enum: ["enter", "cmdIfMultiline", "cmdAlways"],
    });
    expect(properties["ask2gpt.composerEnterBehavior"].description).toBeTruthy();
    expect(properties["ask2gpt.composerEnterBehavior"].enumDescriptions).toHaveLength(3);
  });

  it("runs in the local UI host and exposes stable ways to open Ask2GPT", () => {
    expect(manifest.version).toBe(rootManifest.version);
    expect(manifest.publisher).toBe("FeyZha");
    expect(manifest.description).toBe(
      "Ask project code through your signed-in ChatGPT web session.",
    );
    expect(manifest.extensionKind).toEqual(["ui"]);
    expect(manifest.activationEvents).toEqual(
      expect.arrayContaining([
        "*",
        "onStartupFinished",
        "onView:ask2gpt.sidebar",
        "onCommand:ask2gpt.open",
      ]),
    );
    expect(manifest.activationEvents[0]).toBe("*");

    const openCommand = manifest.contributes.commands.find(
      ({ command }) => command === "ask2gpt.open",
    );
    expect(openCommand).toMatchObject({
      category: "Ask2GPT",
      title: "打开问答窗口 / Open Q&A",
    });
    expect(manifest.contributes.menus.commandPalette).toContainEqual({
      command: "ask2gpt.open",
    });
    expect(manifest.activationEvents).toContain("onCommand:ask2gpt.attachFiles");
    expect(manifest.contributes.commands).toContainEqual(
      expect.objectContaining({ command: "ask2gpt.attachFiles" }),
    );
    expect(manifest.contributes.commands).toContainEqual(
      expect.objectContaining({
        category: "Ask2GPT",
        command: "ask2gpt.retryConnection",
        title: "检查连接 / Check Connection",
      }),
    );
    expect(manifest.contributes.viewsContainers.activitybar).toContainEqual(
      expect.objectContaining({
        id: "ask2gptContainer",
        title: "Ask2GPT",
      }),
    );
    expect(manifest.contributes.views.ask2gptContainer).toContainEqual(
      expect.objectContaining({
        contextualTitle: "Ask2GPT",
        icon: "resources/icon.svg",
        id: "ask2gpt.sidebar",
      }),
    );
  });

  it("packages through the workspace's version-aware VSIX script", () => {
    expect(manifest.scripts.package).toBe("node ../../scripts/package-vscode.mjs");
  });

  it("keeps New conversation in the webview header and exposes selection in the view title", () => {
    expect(manifest.contributes.menus.commandPalette).toContainEqual({
      command: "ask2gpt.newConversation",
    });
    expect(manifest.contributes.menus["view/title"]).not.toContainEqual(
      expect.objectContaining({ command: "ask2gpt.newConversation" }),
    );
  });

  it("puts the selection command in standard editor action surfaces", () => {
    const attachCommand = "ask2gpt.attachSelection";
    const findRelatedTurnCommand = "ask2gpt.findRelatedTurn";
    const obsoleteCommand = "ask2gpt.askAboutSelection";
    const selectionWhen =
      "editorHasSelection && resourceScheme =~ /^(file|untitled|vscode-remote)$/";
    const exposedCommands = manifest.contributes.commands.map(({ command }) => command);

    expect(exposedCommands).toContain(attachCommand);
    expect(exposedCommands).not.toContain(obsoleteCommand);
    expect(manifest.activationEvents).toContain(`onCommand:${attachCommand}`);
    expect(manifest.activationEvents).not.toContain(`onCommand:${obsoleteCommand}`);
    expect(manifest.contributes.menus.commandPalette).toContainEqual({
      command: attachCommand,
      when: selectionWhen,
    });
    expect(manifest.contributes.commands).toContainEqual(
      expect.objectContaining({
        command: attachCommand,
        icon: "$(comment-discussion)",
        shortTitle: "Ask2GPT",
        title: "问 Ask2GPT（使用当前选区） / Ask About Selection",
      }),
    );
    expect(
      manifest.contributes.commands.find(({ command }) => command === attachCommand),
    ).not.toHaveProperty("enablement");
    expect(manifest.contributes.menus["editor/title"]).toContainEqual({
      command: attachCommand,
      group: "navigation@1",
      when: selectionWhen,
    });
    expect(manifest.contributes.menus["editor/context"]).toContainEqual({
      command: attachCommand,
      group: "navigation@10",
      when: selectionWhen,
    });
    expect(manifest.contributes.menus["view/title"]).toContainEqual({
      command: attachCommand,
      group: "navigation@1",
      when: "view == ask2gpt.sidebar",
    });
    expect(exposedCommands).toContain(findRelatedTurnCommand);
    expect(manifest.activationEvents).toContain(`onCommand:${findRelatedTurnCommand}`);
    expect(manifest.contributes.commands).toContainEqual(
      expect.objectContaining({
        category: "Ask2GPT",
        command: findRelatedTurnCommand,
        icon: "$(references)",
      }),
    );
    expect(
      manifest.contributes.commands.find(({ command }) => command === findRelatedTurnCommand),
    ).not.toHaveProperty("enablement");
    const relatedTurnMenuEntries = Object.entries(manifest.contributes.menus).flatMap(
      ([menu, entries]) =>
        entries
          .filter(({ command, when }) => command === findRelatedTurnCommand && when !== "false")
          .map((entry) => ({ menu, ...entry })),
    );
    expect(relatedTurnMenuEntries).toEqual([
      { menu: "commandPalette", command: findRelatedTurnCommand, when: selectionWhen },
      {
        menu: "editor/title",
        command: findRelatedTurnCommand,
        group: "navigation@2",
        when: selectionWhen,
      },
      {
        menu: "editor/context",
        command: findRelatedTurnCommand,
        group: "navigation@11",
        when: selectionWhen,
      },
    ]);
    expect(manifest.contributes.menus["view/title"]).not.toContainEqual(
      expect.objectContaining({ command: findRelatedTurnCommand }),
    );
    expect(manifest.contributes).not.toHaveProperty("keybindings");
    expect(manifest).not.toHaveProperty("enabledApiProposals");
    const visibleMenuEntries = Object.entries(manifest.contributes.menus).flatMap(
      ([menu, entries]) =>
        entries
          .filter(({ command, when }) => command === attachCommand && when !== "false")
          .map((entry) => ({ menu, ...entry })),
    );
    expect(visibleMenuEntries).toHaveLength(4);
    expect(visibleMenuEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ menu: "commandPalette", when: selectionWhen }),
        expect.objectContaining({ menu: "editor/title", when: selectionWhen }),
        expect.objectContaining({ menu: "editor/context", when: selectionWhen }),
        expect.objectContaining({ menu: "view/title", when: "view == ask2gpt.sidebar" }),
      ]),
    );
    expect(manifest.contributes).not.toHaveProperty("codeLens");
    expect(manifest.contributes.menus).not.toHaveProperty("chat/editor/inlineGutter");
    expect(manifest.contributes.menus).not.toHaveProperty("editor/content");
    expect(
      Object.keys(manifest.contributes.menus).filter(
        (menu) => menu.startsWith("editor/") || menu.startsWith("chat/editor/"),
      ),
    ).toEqual(["editor/title", "editor/context"]);
  });
});
