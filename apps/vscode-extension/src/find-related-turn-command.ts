import { findConversationTraceMatches, type ConversationTraceMatch } from "./conversation-trace";
import type { SelectionReference } from "./selection-reference";
import type { AppState } from "./types";

export interface ActiveTraceSelection {
  reference: SelectionReference;
  selectedContent: string;
  /** Restores the exact editor after a first-time sidebar reveal takes focus. */
  restoreFocus?(): Promise<void>;
}

export interface RelatedTurnQuickPickItem {
  label: string;
  description: string;
  detail: string;
  match: ConversationTraceMatch;
}

export interface RelatedTurnQuickPickOptions {
  matchOnDescription: boolean;
  matchOnDetail: boolean;
  placeHolder: string;
}

export interface FindRelatedTurnCommandDependencies {
  getActiveSelection(): ActiveTraceSelection | undefined;
  getState(): Pick<AppState, "conversations">;
  isZh(): boolean;
  showWarningMessage(message: string): unknown;
  showInformationMessage(message: string, ...items: string[]): PromiseLike<string | undefined>;
  showQuickPick(
    items: RelatedTurnQuickPickItem[],
    options: RelatedTurnQuickPickOptions,
  ): PromiseLike<RelatedTurnQuickPickItem | undefined>;
  attachSelectionAndOpen(reference: SelectionReference): Promise<void>;
  selectConversation(conversationId: string): Promise<void>;
  unarchiveConversation(conversationId: string, activate: boolean): Promise<void>;
  revealTurn(conversationId: string, messageId: string, contextId: string): Promise<void>;
}

/**
 * Creates the editor-to-conversation trace command as a testable orchestration
 * boundary. Selection capture and all VS Code UI stay injected so the command
 * can be verified without activating sockets, storage, or a Webview.
 */
export function createFindRelatedTurnCommand(deps: FindRelatedTurnCommandDependencies) {
  return async () => {
    const activeSelection = deps.getActiveSelection();
    const isZh = deps.isZh();
    if (!activeSelection) {
      void deps.showWarningMessage(
        isZh ? "请先在编辑器中选择代码。" : "Select code in the editor first.",
      );
      return;
    }

    const matches = findConversationTraceMatches(
      deps.getState(),
      activeSelection.reference,
      activeSelection.selectedContent,
    );
    if (matches.length === 0) {
      const attachLabel = isZh ? "使用此选区提问" : "Ask about this selection";
      const action = await deps.showInformationMessage(
        isZh
          ? "没有找到与当前选区关联的已发送对话。"
          : "No sent conversation is linked to the current selection.",
        attachLabel,
      );
      if (action === attachLabel) {
        await deps.attachSelectionAndOpen(activeSelection.reference);
      }
      return;
    }

    const directMatch = strictlyBestTraceMatch(matches);
    const selected = directMatch
      ? directMatch
      : (
          await deps.showQuickPick(traceQuickPickItems(matches, isZh), {
            matchOnDescription: true,
            matchOnDetail: true,
            placeHolder: isZh
              ? "选择与当前代码关联的对话轮次和上下文"
              : "Choose a conversation turn and context linked to this code",
          })
        )?.match;
    if (!selected) return;

    if (selected.conversationArchivedAt) {
      const restoreLabel = isZh ? "恢复并打开" : "Restore and open";
      const action = await deps.showInformationMessage(
        isZh ? "关联轮次位于已归档对话中。" : "The linked turn is in an archived conversation.",
        restoreLabel,
      );
      if (action !== restoreLabel) return;
      await deps.unarchiveConversation(selected.conversationId, true);
    } else {
      await deps.selectConversation(selected.conversationId);
    }
    await deps.revealTurn(selected.conversationId, selected.messageId, selected.contextId);
    await activeSelection.restoreFocus?.();
  };
}

function strictlyBestTraceMatch(matches: ConversationTraceMatch[]) {
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return undefined;
  const highestScore = Math.max(...matches.map((match) => match.score));
  const highestMatches = matches.filter((match) => match.score === highestScore);
  return highestMatches.length === 1 ? highestMatches[0] : undefined;
}

function traceQuickPickItems(matches: ConversationTraceMatch[], isZh: boolean) {
  const turnContextCounts = new Map<string, number>();
  for (const match of matches) {
    const key = traceTurnKey(match);
    turnContextCounts.set(key, (turnContextCounts.get(key) ?? 0) + 1);
  }

  const turnContextIndexes = new Map<string, number>();
  return matches.map((match) => {
    const key = traceTurnKey(match);
    const contextCount = turnContextCounts.get(key) ?? 1;
    const contextIndex = (turnContextIndexes.get(key) ?? 0) + 1;
    turnContextIndexes.set(key, contextIndex);
    const contextKind = traceContextKindLabel(match, isZh);
    const contextPosition =
      contextCount > 1 ? ` · ${isZh ? "上下文" : "Context"} ${contextIndex}/${contextCount}` : "";
    return {
      label: `$(comment-discussion) ${match.conversationTitle}`,
      description: `${match.conversationArchivedAt ? `${isZh ? "已归档" : "Archived"} · ` : ""}${match.contextFileName}:L${match.contextStartLine}–${match.contextEndLine} · ${contextKind}${contextPosition}`,
      detail: traceQuestionPreview(match.messageMarkdown),
      match,
    };
  });
}

function traceTurnKey(match: ConversationTraceMatch) {
  return JSON.stringify([match.conversationId, match.messageId]);
}

function traceContextKindLabel(match: ConversationTraceMatch, isZh: boolean) {
  if (isZh) {
    if (match.contextKind === "selection") return "选区";
    if (match.contextKind === "current-file") return "当前文件";
    return "文件";
  }
  if (match.contextKind === "selection") return "Selection";
  if (match.contextKind === "current-file") return "Current file";
  return "File";
}

function traceQuestionPreview(markdown: string) {
  const preview = markdown.replace(/\s+/gu, " ").trim();
  return preview.length > 120 ? `${preview.slice(0, 119)}…` : preview;
}
