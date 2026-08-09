import { PROTOCOL_VERSION } from "@ask2gpt/protocol";
import * as vscode from "vscode";

import { Ask2GPTController } from "./controller";
import {
  createFindRelatedTurnCommand,
  type ActiveTraceSelection,
} from "./find-related-turn-command";
import { BrowserChatBackend } from "./services/browser-chat-backend";
import { ChromeRelayServer } from "./services/chrome-relay-server";
import { ContextService } from "./services/context-service";
import {
  acquireConversationNamespaceLease,
  ConversationStore,
  type ConversationNamespaceLease,
} from "./services/conversation-store";
import { SafeLogger } from "./services/logger";
import { relayInstanceIdForSlot, resolveStorageNamespaceId } from "./services/runtime-identity";
import { disposeExtensionResources } from "./services/shutdown";
import {
  ATTACH_SELECTION_COMMAND,
  createActiveSelectionCommand,
  createSelectionHandoff,
} from "./selection-handoff";
import { registerSelectionCodeActionProvider } from "./selection-code-action";
import {
  isClaimedNotebookCellCommandTarget,
  isNotebookCellReference,
  isOpenNotebookDocumentCommandTarget,
  notebookCellReferencesFromEditor,
  resolveNotebookCellCommandTarget,
  selectionReferenceFromEditor,
  type NotebookCellReference,
  type SelectionReference,
} from "./selection-reference";
import { Ask2GPTViewProvider } from "./webview-provider";

let shutdownResources:
  | {
      controller: Ask2GPTController;
      backend: BrowserChatBackend;
      relay: ChromeRelayServer;
      logger: SafeLogger;
      storageLease: ConversationNamespaceLease;
    }
  | undefined;
let shutdownPromise: Promise<void> | undefined;

export const FIND_RELATED_TURN_COMMAND = "ask2gpt.findRelatedTurn";
export const ATTACH_NOTEBOOK_CELL_COMMAND = "ask2gpt.attachNotebookCell";

export async function activate(context: vscode.ExtensionContext) {
  const logger = new SafeLogger();

  // Keep the existing workspace namespace stable so encrypted conversation
  // history and Chrome relay state remain available after an upgrade.
  const storageNamespaceId = await resolveStorageNamespaceId(context.workspaceState);
  const packageJson: unknown = context.extension.packageJSON;
  const extensionVersion =
    typeof packageJson === "object" &&
    packageJson !== null &&
    "version" in packageJson &&
    typeof packageJson.version === "string"
      ? packageJson.version
      : "0.1.3";

  // Records remain inside extension-private global storage, but each relay
  // instance gets its own namespace to prevent cross-window lost updates.
  const instanceStorageUri = vscode.Uri.joinPath(
    context.globalStorageUri,
    "instances",
    storageNamespaceId,
  );
  const storageLease = await acquireConversationNamespaceLease(instanceStorageUri.fsPath);
  // The relay route follows the leased slot, rather than this activation.
  // Reloading a window can therefore adopt its existing tab/run/event state,
  // while concurrent windows for the same workspace remain isolated.
  const routeInstanceId = relayInstanceIdForSlot(storageNamespaceId, storageLease.slotIndex);
  const store = new ConversationStore(
    storageLease.storagePath,
    context.secrets,
    context.globalStorageUri.fsPath,
  );
  const relay = new ChromeRelayServer(
    routeInstanceId,
    vscode.workspace.name ?? "VS Code",
    extensionVersion,
    logger,
  );
  // Subscribe before opening the listener. On a VS Code reload Chrome can
  // reconnect immediately. The backend and controller subscribe before the
  // port opens, and encrypted conversations finish loading before Chrome can
  // replay a terminal event that requires a durable acknowledgement.
  const backend = new BrowserChatBackend(relay);
  const contextService = new ContextService();
  const controller = new Ask2GPTController(
    context,
    store,
    contextService,
    backend,
    logger,
    routeInstanceId,
    storageLease.stateKeySuffix,
  );
  shutdownResources = { controller, backend, relay, logger, storageLease };
  shutdownPromise = undefined;
  try {
    await controller.initialize();
  } catch (error) {
    await disposeActiveResources();
    throw error;
  }
  try {
    await relay.startWithRetry();
  } catch (error) {
    logger.error("relay.start-failed", "RELAY_PORT_UNAVAILABLE", {
      name: error instanceof Error ? error.name : "Unknown",
    });
  }

  const copyDiagnostics = async () => {
    await controller.refreshBackendStatus();
    const status = controller.getState().backend;
    const diagnostics = logger.diagnostics({
      hostVersion: status.connection.hostVersion ?? extensionVersion,
      relayVersion: status.connection.relayVersion,
      port: status.port,
      connected: status.connected,
      authenticated: status.authenticated,
      connectionPhase: status.connection.phase,
      detectedProtocol: status.connection.detectedProtocol,
      protocolVersion: status.connection.protocolVersion ?? PROTOCOL_VERSION,
      connectedAt: status.connection.lastConnectedAt,
      projectBound: status.project?.bound === true,
      selectorVersion: status.selectorVersion,
    });
    await vscode.env.clipboard.writeText(diagnostics);
  };

  const provider = new Ask2GPTViewProvider(
    context.extensionUri,
    controller,
    logger,
    copyDiagnostics,
    async () => relay.retryConnection(),
  );
  const handoffSelection = createSelectionHandoff(controller, provider);
  const attachSelectionAndOpen = async (reference: SelectionReference | undefined) => {
    if (!reference) {
      void vscode.window.showWarningMessage(
        vscode.env.language.toLowerCase().startsWith("zh")
          ? "请先在编辑器中选择代码。"
          : "Select code in the editor first.",
      );
      return;
    }
    try {
      await handoffSelection(reference);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : vscode.env.language.toLowerCase().startsWith("zh")
            ? "无法附加当前选区。"
            : "Could not attach the current selection.";
      void vscode.window.showWarningMessage(message);
    }
  };
  const attachActiveSelection = createActiveSelectionCommand(
    () => selectionReferenceFromEditor(vscode.window.activeTextEditor),
    attachSelectionAndOpen,
  );
  const attachNotebookCellsAndOpen = async (
    references: readonly NotebookCellReference[] | undefined,
  ) => {
    if (!references?.length) {
      void vscode.window.showWarningMessage(
        vscode.env.language.toLowerCase().startsWith("zh")
          ? "请先在 Notebook 中选择一个或多个 Cell。"
          : "Select one or more notebook cells first.",
      );
      return;
    }
    try {
      if (!(await controller.attachNotebookCellsToActiveConversation(references))) return;
      await provider.show(true);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : vscode.env.language.toLowerCase().startsWith("zh")
            ? "无法附加当前 Notebook Cell。"
            : "Could not attach the current notebook cell.";
      void vscode.window.showWarningMessage(message);
    }
  };
  const notebookTraceSelection = (
    cell: vscode.NotebookCell,
    reference: NotebookCellReference,
  ): ActiveTraceSelection => {
    const range =
      reference.scope === "range"
        ? new vscode.Range(
            reference.startLine,
            reference.startCharacter,
            reference.endLine,
            reference.endCharacter,
          )
        : undefined;
    const selectedContent = range ? cell.document.getText(range) : cell.document.getText();
    const notebook = cell.notebook;
    const viewColumn = vscode.window.visibleNotebookEditors.find(
      (editor) => editor.notebook === notebook,
    )?.viewColumn;
    return {
      reference,
      selectedContent,
      restoreFocus: async () => {
        try {
          const restored = await vscode.window.showNotebookDocument(notebook, {
            preserveFocus: false,
            selections: [new vscode.NotebookRange(reference.cellIndex, reference.cellIndex + 1)],
            viewColumn,
          });
          restored.revealRange(
            new vscode.NotebookRange(reference.cellIndex, reference.cellIndex + 1),
            vscode.NotebookEditorRevealType.InCenterIfOutsideViewport,
          );
        } catch {
          // A closed notebook cannot turn a successful trace into a command failure.
        }
      },
    };
  };
  const findRelatedTurn = createFindRelatedTurnCommand({
    getActiveSelection: (commandTarget) => {
      const resolvedTarget = resolveNotebookCellCommandTarget(
        commandTarget,
        vscode.workspace.notebookDocuments,
        vscode.window.activeTextEditor,
      );
      if (resolvedTarget) {
        return notebookTraceSelection(resolvedTarget.cell, resolvedTarget.reference);
      }
      if (isClaimedNotebookCellCommandTarget(commandTarget)) return undefined;

      const editor = vscode.window.activeTextEditor;
      const reference = selectionReferenceFromEditor(editor);
      if (editor && reference) {
        const document = editor.document;
        const selection = editor.selection;
        const viewColumn = editor.viewColumn;
        return {
          reference,
          selectedContent: document.getText(selection),
          restoreFocus: async () => {
            try {
              await vscode.window.showTextDocument(document, {
                preserveFocus: false,
                selection,
                viewColumn,
              });
            } catch {
              // Navigation already succeeded; a closing editor must not turn
              // focus restoration into a false command failure.
            }
          },
        };
      }

      const notebookEditor = vscode.window.activeNotebookEditor;
      const notebookReference = notebookCellReferencesFromEditor(notebookEditor, editor)?.[0];
      if (!notebookEditor || !notebookReference) return undefined;
      const cell = notebookEditor.notebook.cellAt(notebookReference.cellIndex);
      return notebookTraceSelection(cell, notebookReference);
    },
    getState: () => controller.getState(),
    isZh: () => vscode.env.language.toLowerCase().startsWith("zh"),
    showWarningMessage: (message) => vscode.window.showWarningMessage(message),
    showInformationMessage: (message, ...items) =>
      vscode.window.showInformationMessage(message, ...items),
    showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
    attachSelectionAndOpen: async (reference) => {
      if ("type" in reference) return attachNotebookCellsAndOpen([reference]);
      return attachSelectionAndOpen(reference);
    },
    selectConversation: async (conversationId) => controller.selectConversation(conversationId),
    unarchiveConversation: async (conversationId, activate) =>
      controller.unarchiveConversation(conversationId, activate),
    revealTurn: async (conversationId, messageId, contextId) =>
      provider.revealTurn(conversationId, messageId, contextId),
  });
  const selectionCodeActions = registerSelectionCodeActionProvider();
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(Ask2GPTViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    selectionCodeActions,
    vscode.commands.registerCommand("ask2gpt.open", async () => provider.show(true)),
    vscode.commands.registerCommand("ask2gpt.newConversation", async () => {
      const sourceConversationId = controller.activeConversation?.id;
      if (!sourceConversationId) return;
      await controller.newConversation(sourceConversationId);
      await provider.show(true);
    }),
    // The selection-only lightbulb action passes a click-time document version
    // and range. The wrapper also safely recaptures the active range if another
    // extension invokes the command without the internal reference.
    vscode.commands.registerCommand(ATTACH_SELECTION_COMMAND, attachActiveSelection),
    vscode.commands.registerCommand(ATTACH_NOTEBOOK_CELL_COMMAND, async (candidate?: unknown) => {
      const resolvedTarget = resolveNotebookCellCommandTarget(
        candidate,
        vscode.workspace.notebookDocuments,
        vscode.window.activeTextEditor,
      );
      const validReference = isNotebookCellReference(candidate) ? candidate : undefined;
      const activeNotebookFallback =
        candidate === undefined ||
        isOpenNotebookDocumentCommandTarget(candidate, vscode.workspace.notebookDocuments);
      if (
        (!resolvedTarget && !validReference && !activeNotebookFallback) ||
        (isClaimedNotebookCellReference(candidate) && !validReference) ||
        (isClaimedNotebookCellCommandTarget(candidate) && !resolvedTarget)
      ) {
        void vscode.window.showWarningMessage(
          vscode.env.language.toLowerCase().startsWith("zh")
            ? "Notebook Cell 选区已失效，请重新选择后再试。"
            : "The notebook cell selection is invalid. Select it again and retry.",
        );
        return;
      }
      await attachNotebookCellsAndOpen(
        resolvedTarget
          ? [resolvedTarget.reference]
          : validReference
            ? [validReference]
            : notebookCellReferencesFromEditor(
                vscode.window.activeNotebookEditor,
                vscode.window.activeTextEditor,
              ),
      );
    }),
    vscode.commands.registerCommand(FIND_RELATED_TURN_COMMAND, findRelatedTurn),
    vscode.commands.registerCommand("ask2gpt.attachCurrentFile", async () => {
      const conversationId = controller.activeConversation?.id;
      if (!conversationId) return;
      controller.attachCurrentFile(conversationId);
      await provider.show(true);
    }),
    vscode.commands.registerCommand("ask2gpt.attachFiles", async () => {
      const conversationId = controller.activeConversation?.id;
      if (!conversationId) return;
      await controller.attachFiles(conversationId);
      await provider.show(true);
    }),
    vscode.commands.registerCommand("ask2gpt.copyDiagnostics", async () => {
      await copyDiagnostics();
      void vscode.window.showInformationMessage("已复制脱敏诊断信息。");
    }),
    vscode.commands.registerCommand("ask2gpt.retryConnection", async () => {
      await relay.retryConnection();
      await controller.refreshBackendStatus();
      await provider.show(false);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("ask2gpt.followUpQueueMode") ||
        event.affectsConfiguration("ask2gpt.composerEnterBehavior")
      ) {
        controller.refreshComposerPreferences();
      }
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      // VS Code cannot await ExtensionContext subscription disposal. The
      // exported deactivate() awaits the same shared promise; this branch only
      // prevents a rejected background cleanup from becoming unhandled.
      void disposeActiveResources().catch(() => undefined);
    },
  });

  logger.info("extension.activated", {
    version: extensionVersion,
    port: relay.port,
  });
}

function isClaimedNotebookCellReference(value: unknown) {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type?: unknown }).type === "notebook-cell"
  );
}

export async function deactivate() {
  await disposeActiveResources();
}

function disposeActiveResources() {
  if (!shutdownResources) return shutdownPromise ?? Promise.resolve();
  if (!shutdownPromise) {
    const resources = shutdownResources;
    // ExtensionContext subscriptions are synchronous: VS Code does not await
    // their dispose callbacks before closing the OutputChannel IPC. Establish
    // the logger fence synchronously, then finish the async resource teardown.
    shutdownPromise = disposeExtensionResources(resources).finally(() => {
      if (shutdownResources === resources) shutdownResources = undefined;
    });
  }
  return shutdownPromise;
}
