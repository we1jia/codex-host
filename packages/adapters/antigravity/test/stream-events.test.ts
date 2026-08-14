import { describe, expect, it } from "vitest";

import { parseAntigravityLine } from "../src/stream-events.js";

describe("Antigravity stream-json normalization", () => {
  it("normalizes init, text, tool, subagent and result events", () => {
    expect(parseAntigravityLine('{"event":"init","conversation_id":"conv-1"}')).toEqual({
      type: "init",
      conversationId: "conv-1",
    });
    expect(
      parseAntigravityLine(
        '{"event":"step_update","step_type":"agent_response","agent_response":{"text_delta":"Hel"}}',
      ),
    ).toEqual({ type: "textDelta", text: "Hel" });
    expect(
      parseAntigravityLine(
        '{"event":"step_update","step_type":"tool","status":"ACTIVE","tool_name":"search","tool_id":"tool-1","arguments":{"q":"codexhost"}}',
      ),
    ).toEqual({
      type: "tool",
      status: "active",
      toolName: "search",
      toolId: "tool-1",
      arguments: { q: "codexhost" },
    });
    expect(
      parseAntigravityLine(
        '{"event":"step_update","step_type":"subagent_info","subagent_id":"sub-1","label":"research","status":"RUNNING"}',
      ),
    ).toEqual({
      type: "subagent",
      subagentId: "sub-1",
      label: "research",
      status: "RUNNING",
    });
    expect(
      parseAntigravityLine(
        '{"event":"result","status":"SUCCESS","usage":{"input_tokens":10,"output_tokens":4,"total_tokens":14}}',
      ),
    ).toEqual({
      type: "result",
      status: "success",
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
  });

  it("keeps unknown event types observable without treating them as failures", () => {
    expect(parseAntigravityLine('{"event":"step_update","step_type":"future_event"}')).toEqual({
      type: "unknown",
      event: "step_update:future_event",
    });
    expect(parseAntigravityLine('{"event":"future_event"}')).toEqual({
      type: "unknown",
      event: "future_event",
    });
  });

  it("rejects malformed JSON and malformed known events without echoing the input", () => {
    expect(() => parseAntigravityLine("not-json-secret-value")).toThrow(
      "Antigravity stream line is invalid JSON",
    );
    expect(() => parseAntigravityLine('{"event":"init","conversation_id":""}')).toThrow(
      "conversation_id",
    );
    expect(() =>
      parseAntigravityLine(
        '{"event":"step_update","step_type":"agent_response","agent_response":{}}',
      ),
    ).toThrow("text_delta");
    expect(() => parseAntigravityLine("not-json-secret-value")).not.toThrow("secret-value");
  });

  it("normalizes failed results and only maps finite non-negative Usage", () => {
    expect(
      parseAntigravityLine(
        '{"event":"result","status":"FAILED","message":"authentication required","usage":{"input_tokens":-1,"output_tokens":"4","total_tokens":9}}',
      ),
    ).toEqual({
      type: "result",
      status: "failed",
      message: "authentication required",
      usage: { totalTokens: 9 },
    });
  });
});
