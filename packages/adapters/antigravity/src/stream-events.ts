import type { HostUsage } from "@codexhost/harness-adapter";
import { jsonValueSchema, type JsonValue } from "@codexhost/shared-contracts";

export type AntigravityStreamEvent =
  | { type: "init"; conversationId: string }
  | { type: "textDelta"; text: string }
  | {
      type: "tool";
      toolId: string;
      toolName: string;
      status: "active" | "done" | "failed";
      arguments: JsonValue;
      output?: string;
    }
  | { type: "subagent"; subagentId: string; label: string; status: string }
  | { type: "result"; status: "success" | "failed"; usage: HostUsage | null; message?: string }
  | { type: "unknown"; event: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Antigravity stream event requires ${key}`);
  }
  return value;
}

function optionalText(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function usageNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseUsage(value: unknown): HostUsage | null {
  if (!isRecord(value)) return null;
  const inputTokens = usageNumber(value, "input_tokens");
  const cachedInputTokens = usageNumber(value, "cached_input_tokens");
  const cacheWriteInputTokens = usageNumber(value, "cache_write_input_tokens");
  const outputTokens = usageNumber(value, "output_tokens");
  const reasoningOutputTokens = usageNumber(value, "reasoning_output_tokens");
  const totalTokens = usageNumber(value, "total_tokens");
  const totalCostUsd = usageNumber(value, "total_cost_usd");
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(totalCostUsd === undefined ? {} : { totalCostUsd }),
  };
}

function parseTool(record: Record<string, unknown>): AntigravityStreamEvent {
  const status = requiredText(record, "status").toUpperCase();
  const normalizedStatus =
    status === "ACTIVE"
      ? "active"
      : status === "DONE"
        ? "done"
        : status === "FAILED"
          ? "failed"
          : null;
  if (!normalizedStatus) throw new Error("Antigravity tool event has an invalid status");
  const parsedArguments = jsonValueSchema.safeParse(record.arguments ?? null);
  if (!parsedArguments.success) throw new Error("Antigravity tool event has invalid arguments");
  const output = optionalText(record, "output");
  return {
    type: "tool",
    toolId: requiredText(record, "tool_id"),
    toolName: requiredText(record, "tool_name"),
    status: normalizedStatus,
    arguments: parsedArguments.data,
    ...(output ? { output } : {}),
  };
}

export function parseAntigravityLine(line: string): AntigravityStreamEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Antigravity stream line is invalid JSON");
  }
  if (!isRecord(value)) throw new Error("Antigravity stream line must contain an object");
  const event = requiredText(value, "event");
  if (event === "init") {
    return { type: "init", conversationId: requiredText(value, "conversation_id") };
  }
  if (event === "step_update") {
    const stepType = requiredText(value, "step_type");
    if (stepType === "agent_response") {
      if (!isRecord(value.agent_response)) {
        throw new Error("Antigravity agent_response event requires agent_response");
      }
      return { type: "textDelta", text: requiredText(value.agent_response, "text_delta") };
    }
    if (stepType === "tool") return parseTool(value);
    if (stepType === "subagent_info") {
      return {
        type: "subagent",
        subagentId: requiredText(value, "subagent_id"),
        label: requiredText(value, "label"),
        status: requiredText(value, "status"),
      };
    }
    return { type: "unknown", event: `${event}:${stepType}` };
  }
  if (event === "result") {
    const status = requiredText(value, "status").toUpperCase();
    if (status !== "SUCCESS" && status !== "FAILED") {
      throw new Error("Antigravity result event has an invalid status");
    }
    const message = optionalText(value, "message");
    return {
      type: "result",
      status: status === "SUCCESS" ? "success" : "failed",
      usage: parseUsage(value.usage),
      ...(message ? { message } : {}),
    };
  }
  return { type: "unknown", event };
}
