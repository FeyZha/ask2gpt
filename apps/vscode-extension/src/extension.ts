import { PROTOCOL_VERSION } from "@ask2gpt/protocol";
import * as vscode from "vscode";

import { Ask2GPTController } from "./controller";
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
import { selectionReferenceFromEditor, type SelectionReference } from "./selection-reference";
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

export async function activate(context: vscode.ExtensionContext) {
  const logger = new SafeLogger();

  // Keep the existing workspace namespace stable so 0.1.3 conversation
  // history and Chrome relay state remain available after an upgrade.
  const storageNamespaceId = await resolveStorageNamespaceId(context.workspaceState);
  const packageJson: unknown = context.extension.packageJSON;
  const extensionVersion =
    typeof packageJson === "object" &&
    packageJson !== null &&
    "version" in packageJson &&
    typeof packageJson.version === "string"
      ? packageJson.version
      : "0.0.1";

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
