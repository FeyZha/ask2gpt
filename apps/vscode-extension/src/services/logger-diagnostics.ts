export interface DiagnosticStatus {
  hostVersion: string;
  relayVersion?: string;
  port?: number;
  connected: boolean;
  authenticated: boolean;
  connectionPhase?: string;
  detectedProtocol?: string;
  protocolVersion?: number;
  connectedAt?: string;
  selectorVersion: number;
  projectBound: boolean;
}

export interface DiagnosticError {
  code: string;
  at: string;
}

const SAFE_LOG_FIELDS = new Set([
  "action",
  "averageGapMs",
  "authenticated",
  "code",
  "connected",
  "connectedAt",
  "connectionPhase",
  "detectedProtocol",
  "durationMs",
  "failures",
  "migrated",
  "migrationFailures",
  "name",
  "hostVersion",
  "maxChunkChars",
  "maxGapMs",
  "port",
  "projectBound",
  "protocolVersion",
  "recoverable",
  "relayVersion",
  "recovered",
  "repairFailures",
  "selectorVersion",
  "snapshots",
  "streamDurationMs",
  "unreadable",
  "version",
]);

export function buildSafeDiagnostics(
  input: DiagnosticStatus,
  lastError?: DiagnosticError,
  generatedAt = new Date().toISOString(),
) {
  return JSON.stringify(
    {
      hostVersion: input.hostVersion,
      relayVersion: input.relayVersion,
      port: input.port,
      connected: input.connected,
      authenticated: input.authenticated,
      connectionPhase: input.connectionPhase,
      protocolVersion: input.protocolVersion,
      detectedProtocol: input.detectedProtocol,
      connectedAt: input.connectedAt,
      projectBound: input.projectBound,
      selectorVersion: input.selectorVersion,
      lastError,
      generatedAt,
    },
    null,
    2,
  );
}

export function sanitizeLogEvent(event: string) {
  return /^[a-z0-9.-]{1,80}$/i.test(event) ? event : "invalid-event";
}

export function sanitizeLogCode(code: string) {
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : "INVALID_ERROR_CODE";
}

export function sanitizeLogFields(fields: Record<string, string | number | boolean | undefined>) {
  const safeFields: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_LOG_FIELDS.has(key) || value === undefined) continue;
    if (typeof value === "number") {
      if (Number.isFinite(value)) safeFields[key] = value;
    } else if (typeof value === "boolean") {
      safeFields[key] = value;
    } else {
      safeFields[key] = value.replace(/[\r\n\u2028\u2029]+/g, " ").slice(0, 80);
    }
  }
  return safeFields;
}
