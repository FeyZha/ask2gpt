import { describe, expect, it } from "vitest";

import { ConversationResponseDecoder, decodeConversationResponse } from "./conversation-response";

describe("ChatGPT conversation response decoding", () => {
  it("extracts the latest full assistant message from a split SSE stream", () => {
    const decoder = new ConversationResponseDecoder();
    expect(
      decoder.push(
        'data: {"message":{"author":{"role":"assistant"},"content":{"parts":["Hello"]}}}\n',
      ),
    ).toBeUndefined();
    expect(decoder.push('\ndata: {"message":{"author":{"role":"assistant"},')).toBe("Hello");
    expect(decoder.push('"content":{"parts":["Hello world"]}}}\n\n')).toBe("Hello world");
    expect(decoder.finish()).toBe("Hello world");
  });

  it("ignores user and unrelated payloads", () => {
    expect(
      decodeConversationResponse(
        'data: {"message":{"author":{"role":"user"},"content":{"parts":["secret"]}}}\n\n' +
          'data: {"status":"ok"}\n\n',
      ),
    ).toBeUndefined();
  });

  it("supports assistant delta streams", () => {
    expect(
      decodeConversationResponse(
        'data: {"delta":{"role":"assistant","content":"Hello "}}\n\n' +
          'data: {"delta":{"role":"assistant","content":"world"}}\n\n' +
          "data: [DONE]\n\n",
      ),
    ).toBe("Hello world");
  });

  it("decodes ChatGPT JSON-patch append frames", () => {
    const decoder = new ConversationResponseDecoder();
    expect(
      decoder.push(
        'event: delta\ndata: {"o":"add","p":"","v":{"message":{"author":{"role":"assistant"},"content":{"parts":[""]}}}}\n\n',
      ),
    ).toBeUndefined();
    expect(
      decoder.push(
        'event: delta\ndata: {"o":"append","p":"/message/content/parts/0","v":"Hello "}\n\n',
      ),
    ).toBe("Hello ");
    expect(
      decoder.push(
        'event: delta\ndata: {"o":"append","p":"/message/content/parts/0","v":"world"}\n\n',
      ),
    ).toBe("Hello world");
    expect(decoder.finish()).toBe("Hello world");
    expect(decoder.diagnosticSummary()).toContain("op:append");
  });

  it("applies batched ChatGPT patch frames in order", () => {
    expect(
      decodeConversationResponse(
        'data: {"message":{"author":{"role":"assistant"},"content":{"parts":["Start"]}}}\n\n' +
          'event: delta\ndata: {"o":"patch","p":"","v":[' +
          '{"o":"append","p":"/message/content/parts/0","v":" middle"},' +
          '{"o":"append","p":"/message/content/parts/0","v":" end"},' +
          '{"o":"replace","p":"/message/status","v":"finished_successfully"}' +
          "]}\n\n" +
          "data: [DONE]\n\n",
      ),
    ).toBe("Start middle end");
  });

  it("does not treat a known non-assistant message patch as the answer", () => {
    expect(
      decodeConversationResponse(
        'data: {"o":"add","p":"","v":{"message":{"author":{"role":"tool"},"content":{"parts":[""]}}}}\n\n' +
          'data: {"o":"append","p":"/message/content/parts/0","v":"private tool output"}\n\n' +
          "data: [DONE]\n\n",
      ),
    ).toBeUndefined();
  });

  it("exposes ChatGPT WebSocket handoff metadata without treating its token as answer text", () => {
    const decoder = new ConversationResponseDecoder();
    expect(
      decoder.push(
        'event: delta_encoding\ndata: "v1"\n\n' +
          'data: {"type":"resume_conversation_token","kind":"topic","token":"secret","conversation_id":"remote"}\n\n' +
          'data: {"type":"stream_handoff","conversation_id":"remote","turn_exchange_id":"turn","options":[' +
          '{"type":"resume_sse_endpoint","topic_id":"conversation-turn-ignore"},' +
          '{"type":"subscribe_ws_topic","topic_id":"conversation-turn-active"}' +
          "]}\n\n" +
          "data: [DONE]\n\n",
      ),
    ).toBeUndefined();
    expect(decoder.streamHandoffTopicId()).toBe("conversation-turn-active");
    expect(decoder.finish()).toBeUndefined();
  });
});
