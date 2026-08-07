import * as vscode from "vscode";

import {
  buildSafeDiagnostics,
  sanitizeLogCode,
  sanitizeLogEvent,
  sanitizeLogFields,
  type DiagnosticStatus,
} from "./logger-diagnostics";

export class SafeLogger {
  readonly output = vscode.window.createOutputChannel("Ask2GPT");
  private lastError?: { code: string; at: string };
  private disposed = false;

  info(event: string, fields: Record<string, string | number | boolean | undefined> = {}) {
    if (this.disposed) return;
    this.write("INFO", event, fields);
  }

  error(
    event: string,
    code: string,
    fields: Record<string, string | number | boolean | undefined> = {},
  ) {
    if (this.disposed) return;
    const safeCode = sanitizeLogCode(code);
    this.lastError = { code: safeCode, at: new Date().toISOString() };
    this.write("ERROR", event, { ...fields, code: safeCode });
  }

  diagnostics(input: DiagnosticStatus) {
    return buildSafeDiagnostics(input, this.lastError);
  }

  dispose() {
    if (this.disposed) return;
    // Mark the logger closed before disposing VS Code's output channel. Relay
    // socket events can arrive on a later tick while the extension host is
    // shutting down; those callbacks must never write to the closed channel.
    this.disposed = true;
    try {
      this.output.dispose();
    } catch {
      // During host termination VS Code can close the channel before extension
      // subscriptions run. The write fence above is the required cleanup.
    }
  }

  private write(
    level: string,
    event: string,
    fields: Record<string, string | number | boolean | undefined>,
  ) {
    const safeFields = sanitizeLogFields(fields);
    this.output.appendLine(
      `${new Date().toISOString()} ${level} ${sanitizeLogEvent(event)} ${JSON.stringify(safeFields)}`,
    );
  }
}
