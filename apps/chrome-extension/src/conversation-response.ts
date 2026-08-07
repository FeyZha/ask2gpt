type JsonRecord = Record<string, unknown>;

export class ConversationResponseDecoder {
  private buffer = "";
  private latestMarkdown = "";
  private deltaMarkdown = "";
  private patchAssistantActive: boolean | undefined;
  private handoffTopicId: string | undefined;
  private readonly frameShapes = new Set<string>();

  push(chunk: string) {
    this.buffer += chunk;
    let changed: string | undefined;
    for (;;) {
      const boundary = nextEventBoundary(this.buffer);
      if (!boundary) break;
      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      changed = this.consumeFrame(frame) ?? changed;
    }
    return changed;
  }

  finish() {
    const tail = this.buffer.trim();
    this.buffer = "";
    if (tail) this.consumeFrame(tail);
    return this.latestMarkdown || undefined;
  }

  diagnosticSummary() {
    return [...this.frameShapes].join(",") || "none";
  }

  streamHandoffTopicId() {
    return this.handoffTopicId;
  }

  private consumeFrame(frame: string) {
    const data = frame
      .replaceAll("\r\n", "\n")
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    const payloadText = data || frame.trim();
    if (!payloadText || payloadText === "[DONE]") return undefined;

    let payload: unknown;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      return undefined;
    }
    if (this.frameShapes.size < 8) this.frameShapes.add(describeFrameShape(payload));
    this.handoffTopicId ??= extractStreamHandoffTopicId(payload);

    const messageRole = extractMessageRole(payload);
    if (messageRole !== undefined) this.patchAssistantActive = messageRole === "assistant";

    const full = extractAssistantMarkdown(payload);
    if (full !== undefined) {
      this.patchAssistantActive = true;
      if (full === this.latestMarkdown) return undefined;
      this.latestMarkdown = full;
      this.deltaMarkdown = "";
      return full;
    }

    const patches = extractAssistantTextPatches(payload);
    if (patches.length > 0 && this.patchAssistantActive !== false) {
      let patchedMarkdown = this.latestMarkdown;
      for (const patch of patches) {
        patchedMarkdown = patch.operation === "append" ? patchedMarkdown + patch.text : patch.text;
      }
      if (patchedMarkdown !== this.latestMarkdown) {
        this.patchAssistantActive = true;
        this.latestMarkdown = patchedMarkdown;
        this.deltaMarkdown = "";
        return patchedMarkdown;
      }
    }

    const delta = extractAssistantDelta(payload);
    if (!delta) return undefined;
    this.deltaMarkdown += delta;
    if (this.deltaMarkdown === this.latestMarkdown) return undefined;
    this.latestMarkdown = this.deltaMarkdown;
    return this.latestMarkdown;
  }
}

function extractStreamHandoffTopicId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "stream_handoff" && Array.isArray(value.options)) {
    for (const option of value.options) {
      if (
        isRecord(option) &&
        option.type === "subscribe_ws_topic" &&
        typeof option.topic_id === "string" &&
        option.topic_id.startsWith("conversation-turn-")
      ) {
        return option.topic_id;
      }
    }
  }
  for (const nested of [value.data, value.response, value.result]) {
    const topicId = extractStreamHandoffTopicId(nested);
    if (topicId !== undefined) return topicId;
  }
  return undefined;
}

function describeFrameShape(value: unknown) {
  if (!isRecord(value)) return Array.isArray(value) ? "array" : typeof value;
  const keys = Object.keys(value).sort().slice(0, 10).join("+") || "empty";
  const operation =
    typeof value.o === "string" ? value.o : typeof value.op === "string" ? value.op : "";
  const path =
    typeof value.p === "string" ? value.p : typeof value.path === "string" ? value.path : "";
  const patchValue = "v" in value ? value.v : "value" in value ? value.value : undefined;
  const valueType = Array.isArray(patchValue) ? "array" : typeof patchValue;
  return [
    keys,
    ...(operation ? [`op:${operation.slice(0, 24)}`] : []),
    ...(path ? [`path:${path.slice(0, 96)}`] : []),
    ...("v" in value || "value" in value ? [`value:${valueType}`] : []),
  ].join("|");
}

export function decodeConversationResponse(body: string) {
  const decoder = new ConversationResponseDecoder();
  decoder.push(body);
  return decoder.finish();
}

function nextEventBoundary(value: string) {
  const lf = value.indexOf("\n\n");
  const crlf = value.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return undefined;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function extractAssistantMarkdown(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct = assistantMessageMarkdown(value.message);
  if (direct !== undefined) return direct;
  if (Array.isArray(value.messages)) {
    for (let index = value.messages.length - 1; index >= 0; index -= 1) {
      const candidate = assistantMessageMarkdown(value.messages[index]);
      if (candidate !== undefined) return candidate;
    }
  }
  for (const nested of [value.data, value.response, value.result, rootPatchValue(value)]) {
    const candidate = extractAssistantMarkdown(nested);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function extractMessageRole(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct = messageRole(value.message);
  if (direct !== undefined) return direct;
  if (Array.isArray(value.messages)) {
    for (let index = value.messages.length - 1; index >= 0; index -= 1) {
      const candidate = messageRole(value.messages[index]);
      if (candidate !== undefined) return candidate;
    }
  }
  for (const nested of [value.data, value.response, value.result, rootPatchValue(value)]) {
    const candidate = extractMessageRole(nested);
    if (candidate !== undefined) return candidate;
  }
  return extractMessageRolePatch(value);
}

function messageRole(value: unknown) {
  if (!isRecord(value)) return undefined;
  if (typeof value.role === "string") return value.role;
  return isRecord(value.author) && typeof value.author.role === "string"
    ? value.author.role
    : undefined;
}

function rootPatchValue(value: JsonRecord) {
  const operation = patchOperation(value);
  const path = patchPath(value);
  if ((operation === "add" || operation === "replace") && path === "") {
    return patchValue(value);
  }
  return undefined;
}

function assistantMessageMarkdown(value: unknown) {
  if (!isRecord(value) || !isAssistantRole(value.author, value.role)) return undefined;
  return contentMarkdown(value.content) ?? textValue(value.text);
}

function contentMarkdown(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  if (Array.isArray(value.parts)) {
    const parts = value.parts
      .map((part) =>
        typeof part === "string" ? part : isRecord(part) ? textValue(part.text) : undefined,
      )
      .filter((part): part is string => part !== undefined);
    if (parts.length > 0) return parts.join("\n");
  }
  return textValue(value.text);
}

interface AssistantTextPatch {
  operation: "append" | "replace";
  text: string;
}

function extractAssistantTextPatches(
  value: unknown,
  patches: AssistantTextPatch[] = [],
): AssistantTextPatch[] {
  if (!isRecord(value)) return patches;
  const operation = patchOperation(value);
  const path = patchPath(value);
  const valueToApply = patchValue(value);
  if (operation === "patch" && Array.isArray(valueToApply)) {
    for (const nestedPatch of valueToApply) extractAssistantTextPatches(nestedPatch, patches);
  } else if (
    (operation === "append" || operation === "replace" || operation === "add") &&
    isAssistantTextPatchPath(path)
  ) {
    const text = patchText(valueToApply);
    if (text !== undefined) {
      patches.push({ operation: operation === "append" ? "append" : "replace", text });
    }
  }
  for (const nested of [value.data, value.response, value.result]) {
    extractAssistantTextPatches(nested, patches);
  }
  return patches;
}

function extractMessageRolePatch(value: JsonRecord): string | undefined {
  const operation = patchOperation(value);
  const valueToApply = patchValue(value);
  if (operation === "patch" && Array.isArray(valueToApply)) {
    for (const nested of valueToApply) {
      const role = isRecord(nested) ? extractMessageRolePatch(nested) : undefined;
      if (role !== undefined) return role;
    }
    return undefined;
  }
  const path = patchPath(value);
  if (path === "/message/author/role" || path === "/message/role") {
    return typeof valueToApply === "string" ? valueToApply : undefined;
  }
  if (path === "/message/author" && isRecord(valueToApply)) {
    return typeof valueToApply.role === "string" ? valueToApply.role : undefined;
  }
  return undefined;
}

function patchOperation(value: JsonRecord) {
  return typeof value.o === "string" ? value.o : typeof value.op === "string" ? value.op : "";
}

function patchPath(value: JsonRecord) {
  return typeof value.p === "string" ? value.p : typeof value.path === "string" ? value.path : "";
}

function patchValue(value: JsonRecord) {
  return "v" in value ? value.v : "value" in value ? value.value : undefined;
}

function isAssistantTextPatchPath(path: string) {
  return /^\/message\/content\/parts(?:\/\d+)?$/u.test(path);
}

function patchText(value: unknown) {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
    return value.join("\n");
  }
  return isRecord(value) ? textValue(value.text) : undefined;
}

function extractAssistantDelta(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const delta = isRecord(value.delta) ? value.delta : undefined;
  if (delta && isAssistantRole(delta.author, delta.role)) {
    return contentMarkdown(delta.content) ?? textValue(delta.text);
  }
  for (const nested of [value.data, value.response, value.result]) {
    const candidate = extractAssistantDelta(nested);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function isAssistantRole(author: unknown, role: unknown) {
  if (role === "assistant") return true;
  return isRecord(author) && author.role === "assistant";
}

function textValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
