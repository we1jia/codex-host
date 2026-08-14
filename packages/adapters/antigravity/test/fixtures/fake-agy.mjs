#!/usr/bin/env node

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("agy 1.0.0\n");
  process.exit(0);
}

const prompt = valueAfter("-p") ?? "";
const conversationId = valueAfter("--conversation");
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (!conversationId) emit({ event: "init", conversation_id: "conv-fixture" });
if (prompt === "malformed:") {
  process.stdout.write("not-json\n");
  process.exit(0);
}
if (prompt === "missing-result:") {
  emit({
    event: "step_update",
    step_type: "agent_response",
    agent_response: { text_delta: "partial" },
  });
  process.exit(0);
}
if (prompt.startsWith("exit:")) {
  process.stderr.write("diagnostic-only\n");
  process.exit(Number.parseInt(prompt.slice("exit:".length), 10) || 7);
}
if (prompt === "secret:") {
  process.stderr.write("token=do-not-echo\n");
  emit({ event: "result", status: "SUCCESS" });
  process.exit(0);
}
if (prompt === "auth:") {
  emit({ event: "result", status: "FAILED", message: "authentication required" });
  process.exit(0);
}
if (prompt === "delayed-exit:") {
  emit({
    event: "result",
    status: "SUCCESS",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  });
  setTimeout(() => process.exit(0), 250);
} else if (prompt === "result-exit:7") {
  emit({ event: "result", status: "SUCCESS" });
  setTimeout(() => process.exit(7), 25);
} else if (prompt === "active-tool:") {
  emit({
    event: "step_update",
    step_type: "tool",
    status: "ACTIVE",
    tool_name: "unfinished",
    tool_id: "tool-open",
    arguments: {},
  });
  emit({ event: "result", status: "SUCCESS" });
} else if (prompt === "duplicate-result:") {
  emit({ event: "result", status: "SUCCESS" });
  emit({ event: "result", status: "FAILED", message: "conflicting result" });
} else if (prompt === "conflicting-init:") {
  emit({ event: "init", conversation_id: "conv-conflict" });
  setTimeout(() => process.exit(0), 100);
} else if (prompt === "unknown-tool-delay:") {
  emit({
    event: "step_update",
    step_type: "tool",
    status: "ACTIVE",
    tool_name: "known",
    tool_id: "tool-known",
    arguments: {},
  });
  emit({
    event: "step_update",
    step_type: "tool",
    status: "DONE",
    tool_name: "unknown",
    tool_id: "tool-unknown",
    arguments: {},
  });
  setTimeout(() => process.exit(0), 250);
} else if (prompt === "wait-tool:") {
  emit({
    event: "step_update",
    step_type: "tool",
    status: "ACTIVE",
    tool_name: "waiting",
    tool_id: "tool-wait",
    arguments: {},
  });
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => undefined, 1_000);
} else if (prompt === "subagent:") {
  emit({
    event: "step_update",
    step_type: "subagent_info",
    subagent_id: "sub-1",
    label: "researcher",
    status: "RUNNING",
  });
  emit({
    event: "step_update",
    step_type: "subagent_info",
    subagent_id: "sub-1",
    label: "researcher",
    status: "DONE",
  });
  emit({ event: "result", status: "SUCCESS" });
} else if (prompt.startsWith("orphan:")) {
  const pidPath = prompt.slice("orphan:".length);
  const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
    stdio: "ignore",
  });
  writeFileSync(pidPath, String(child.pid));
  process.stdout.write("not-json\n");
  setInterval(() => undefined, 1_000);
} else if (prompt === "wait:") {
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => undefined, 1_000);
} else {
  process.stderr.write("diagnostic-only\n");
  emit({
    event: "step_update",
    step_type: "agent_response",
    agent_response: { text_delta: conversationId ? "resumed" : "hello" },
  });
  emit({
    event: "step_update",
    step_type: "tool",
    status: "ACTIVE",
    tool_name: "search",
    tool_id: "tool-1",
    arguments: { query: "codexhost" },
  });
  emit({
    event: "step_update",
    step_type: "tool",
    status: "DONE",
    tool_name: "search",
    tool_id: "tool-1",
    arguments: { query: "codexhost" },
    output: "found",
  });
  emit({
    event: "result",
    status: "SUCCESS",
    usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
  });
}
