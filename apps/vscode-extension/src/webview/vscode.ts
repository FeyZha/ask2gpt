import type { HostToWebviewMessage, WebviewToHostMessage } from "../types";

interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscodeApi = acquireVsCodeApi();

export function postMessage(message: WebviewToHostMessage) {
  vscodeApi.postMessage(message);
}

export function onHostMessage(listener: (message: HostToWebviewMessage) => void) {
  let pendingState: Extract<HostToWebviewMessage, { type: "state" }> | undefined;
  const deliver = (message: HostToWebviewMessage) => {
    if (message.type === "state" && document.visibilityState === "hidden") {
      // VS Code may keep a retained webview alive while its sidebar is hidden
      // or while the workbench enters full screen. Keep accepting transport
      // frames, but render only the newest full snapshot once the document is
      // visible again.
      pendingState = message;
      return;
    }
    listener(message);
  };
  const flushPendingState = () => {
    if (document.visibilityState === "hidden" || !pendingState) return;
    const message = pendingState;
    pendingState = undefined;
    listener(message);
  };
  const handler = (event: MessageEvent<HostToWebviewMessage>) => deliver(event.data);
  window.addEventListener("message", handler);
  document.addEventListener("visibilitychange", flushPendingState);
  window.addEventListener("pageshow", flushPendingState);
  window.addEventListener("focus", flushPendingState);
  return () => {
    pendingState = undefined;
    window.removeEventListener("message", handler);
    document.removeEventListener("visibilitychange", flushPendingState);
    window.removeEventListener("pageshow", flushPendingState);
    window.removeEventListener("focus", flushPendingState);
  };
}
