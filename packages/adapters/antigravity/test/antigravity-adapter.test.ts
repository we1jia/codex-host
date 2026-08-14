import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessOutput, HarnessSession, HostEvent } from "@codexhost/harness-adapter";
import {
  harnessModelRefSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { AntigravityAdapter } from "../src/antigravity-adapter.js";

const fixture = path.resolve(import.meta.dirname, "fixtures/fake-agy.mjs");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function executableFixture(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-adapter-agy-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "agy");
  await writeFile(executable, await fs.promises.readFile(fixture), { mode: 0o700 });
  return executable;
}

async function openSession(
  adapter: AntigravityAdapter,
  input:
    | { kind: "create"; cwd: string }
    | { kind: "resume"; cwd: string; nativeRef: ReturnType<typeof nativeSessionRefSchema.parse> },
): Promise<HarnessSession> {
  const opened = await adapter.open(input);
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
}

async function outputsThroughTurn(session: HarnessSession): Promise<HarnessOutput[]> {
  const outputs: HarnessOutput[] = [];
  for await (const output of session.outputs) {
    outputs.push(output);
    if (output.kind === "event" && output.event.type === "turn.completed") break;
  }
  return outputs;
}

function eventOfType<T extends HostEvent["type"]>(
  outputs: HarnessOutput[],
  type: T,
): Extract<HostEvent, { type: T }> | undefined {
  const output = outputs.find(
    (candidate) => candidate.kind === "event" && candidate.event.type === type,
  );
  return output?.kind === "event" ? (output.event as Extract<HostEvent, { type: T }>) : undefined;
}

describe("Antigravity Adapter", () => {
  it("inspects an installed CLI without advertising invented Model controls", async () => {
    const command = await executableFixture();
    const adapter = new AntigravityAdapter({ command, environment: process.env });

    await expect(adapter.inspect()).resolves.toEqual({
      status: "ready",
      catalog: { models: [], thinkingOptions: [] },
      capabilities: {
        configuration: {
          selectModel: false,
          selectThinkingOption: false,
          selectPermissionMode: false,
        },
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      },
    });
    await adapter.close();
  });

  it("projects a new conversation, streaming text, Tool lifecycle and Usage", async () => {
    const command = await executableFixture();
    const adapter = new AntigravityAdapter({ command, environment: process.env });
    const session = await openSession(adapter, { kind: "create", cwd: process.cwd() });
    const turnId = hostTurnIdSchema.parse("turn-1");

    await expect(
      session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "success:" }] }),
    ).resolves.toEqual({ ok: true, value: { turnId } });
    const outputs = await outputsThroughTurn(session);

    expect(outputs).toContainEqual({
      kind: "event",
      event: {
        type: "session.state.changed",
        state: {
          nativeRef: {
            formatVersion: 1,
            harnessId: "antigravity",
            nativeSessionId: "conv-fixture",
          },
        },
      },
    });
    expect(outputs).toContainEqual({
      kind: "event",
      event: {
        type: "session.usage.changed",
        observedForTurnId: turnId,
        usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      },
    });
    expect(
      outputs.some(
        (output) =>
          output.kind === "event" &&
          output.event.type === "item.updated" &&
          output.event.update.type === "text.append" &&
          output.event.update.text === "hello",
      ),
    ).toBe(true);
    expect(
      outputs.some(
        (output) =>
          output.kind === "event" &&
          output.event.type === "item.completed" &&
          output.event.snapshot.item.type === "toolExecution" &&
          output.event.snapshot.item.toolName === "search" &&
          output.event.snapshot.outcome.status === "succeeded",
      ),
    ).toBe(true);
    expect(eventOfType(outputs, "turn.completed")).toMatchObject({
      turnId,
      outcome: { status: "succeeded" },
      nativeTurnRef: { nativeSessionId: "conv-fixture" },
    });
    await session.close();
    await adapter.close();
  });

  it("resumes using the confirmed Native Session ID", async () => {
    const command = await executableFixture();
    const adapter = new AntigravityAdapter({ command, environment: process.env });
    const nativeRef = nativeSessionRefSchema.parse({
      formatVersion: 1,
      harnessId: "antigravity",
      nativeSessionId: "conv-existing",
    });
    const session = await openSession(adapter, { kind: "resume", cwd: process.cwd(), nativeRef });
    const turnId = hostTurnIdSchema.parse("turn-resume");

    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "success:" }],
    });
    const outputs = await outputsThroughTurn(session);

    expect(
      outputs.some(
        (output) =>
          output.kind === "event" &&
          output.event.type === "item.updated" &&
          output.event.update.type === "text.append" &&
          output.event.update.text === "resumed",
      ),
    ).toBe(true);
    expect(eventOfType(outputs, "turn.completed")).toMatchObject({
      nativeTurnRef: { nativeSessionId: "conv-existing" },
      outcome: { status: "succeeded" },
    });
    await session.close();
    await adapter.close();
  });

  it("does not complete a successful result before the CLI exits", async () => {
    const command = await executableFixture();
    const adapter = new AntigravityAdapter({ command, environment: process.env });
    const session = await openSession(adapter, { kind: "create", cwd: process.cwd() });
    const firstTurnId = hostTurnIdSchema.parse("turn-delayed");
    const secondTurnId = hostTurnIdSchema.parse("turn-after-exit");
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute({
      type: "turn.start",
      turnId: firstTurnId,
      input: [{ type: "text", text: "delayed-exit:" }],
    });
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error("Session ended before Usage");
      if (next.value.kind === "event" && next.value.event.type === "session.usage.changed") break;
    }
    await expect(
      session.execute({
        type: "turn.start",
        turnId: secondTurnId,
        input: [{ type: "text", text: "success:" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });

    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error("Session ended before completion");
      if (next.value.kind === "event" && next.value.event.type === "turn.completed") break;
    }
    await expect(
      session.execute({
        type: "turn.start",
        turnId: secondTurnId,
        input: [{ type: "text", text: "success:" }],
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: secondTurnId } });
    await session.close();
    await adapter.close();
  });

  it("lets a non-zero process exit override an earlier success result", async () => {
    const command = await executableFixture();
    const adapter = new AntigravityAdapter({ command, environment: process.env });
    const session = await openSession(adapter, { kind: "create", cwd: process.cwd() });
    const turnId = hostTurnIdSchema.parse("turn-result-exit");

    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "result-exit:7" }],
    });
    const outputs = await outputsThroughTurn(session);
    expect(eventOfType(outputs, "turn.completed")).toMatchObject({
      outcome: { status: "failed", error: { code: "processExited" } },
    });
    await session.close();
    await adapter.close();
  });

  it("keeps protocol failures active until the CLI exits", async () => {
    const command = await executableFixture();
    const adapter = new AntigravityAdapter({ command, environment: process.env });
    const nativeRef = nativeSessionRefSchema.parse({
      formatVersion: 1,
      harnessId: "antigravity",
      nativeSessionId: "conv-existing",
    });
    const conflicting = await openSession(adapter, {
      kind: "resume",
      cwd: process.cwd(),
      nativeRef,
    });
    await conflicting.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-conflicting-init"),
      input: [{ type: "text", text: "conflicting-init:" }],
    });
    expect(eventOfType(await outputsThroughTurn(conflicting), "turn.completed")).toMatchObject({
      outcome: { status: "failed", error: { code: "protocolError" } },
    });

    const unknownTool = await openSession(adapter, { kind: "create", cwd: process.cwd() });
    const firstTurnId = hostTurnIdSchema.parse("turn-unknown-tool");
    const secondTurnId = hostTurnIdSchema.parse("turn-after-unknown-tool");
    const iterator = unknownTool.outputs[Symbol.asyncIterator]();
    await unknownTool.execute({
      type: "turn.start",
      turnId: firstTurnId,
      input: [{ type: "text", text: "unknown-tool-delay:" }],
    });
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error("Session ended before Tool start");
      if (next.value.kind === "event" && next.value.event.type === "item.started") break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(
      unknownTool.execute({
        type: "turn.start",
        turnId: secondTurnId,
        input: [{ type: "text", text: "success:" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    const remaining: HarnessOutput[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error("Session ended before protocol failure");
      remaining.push(next.value);
      if (next.value.kind === "event" && next.value.event.type === "turn.completed") break;
    }
    expect(eventOfType(remaining, "turn.completed")).toMatchObject({
      outcome: { status: "failed", error: { code: "protocolError" } },
    });
    await conflicting.close();
    await unknownTool.close();
    await adapter.close();
  });

  it("closes unfinished Tools and preserves the Subagent lifecycle", async () => {
    const command = await executableFixture();
    const adapter = new AntigravityAdapter({ command, environment: process.env });
    const unfinished = await openSession(adapter, { kind: "create", cwd: process.cwd() });
    await unfinished.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-open-tool"),
      input: [{ type: "text", text: "active-tool:" }],
    });
    const unfinishedOutputs = await outputsThroughTurn(unfinished);
    expect(eventOfType(unfinishedOutputs, "turn.completed")).toMatchObject({
      outcome: { status: "failed", error: { code: "protocolError" } },
    });
    expect(
      unfinishedOutputs.filter(
        (output) =>
          output.kind === "event" &&
          output.event.type === "item.completed" &&
          output.event.snapshot.item.type === "toolExecution" &&
          output.event.snapshot.item.toolName === "unfinished",
      ),
    ).toHaveLength(1);

    const subagent = await openSession(adapter, { kind: "create", cwd: process.cwd() });
    await subagent.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-subagent"),
      input: [{ type: "text", text: "subagent:" }],
    });
    const subagentOutputs = await outputsThroughTurn(subagent);
    expect(
      subagentOutputs.filter(
        (output) =>
          output.kind === "event" &&
          output.event.type === "item.started" &&
          output.event.item.type === "toolExecution" &&
          output.event.item.namespace === "antigravity.subagent",
      ),
    ).toHaveLength(1);
    expect(
      subagentOutputs.filter(
        (output) =>
          output.kind === "event" &&
          output.event.type === "item.completed" &&
          output.event.snapshot.item.type === "toolExecution" &&
          output.event.snapshot.item.namespace === "antigravity.subagent" &&
          output.event.snapshot.outcome.status === "succeeded",
      ),
    ).toHaveLength(1);
    await unfinished.close();
    await subagent.close();
    await adapter.close();
  });

  it("closes an active Tool when its Turn is cancelled", async () => {
    const command = await executableFixture();
    const adapter = new AntigravityAdapter({ command, environment: process.env });
    const session = await openSession(adapter, { kind: "create", cwd: process.cwd() });
    const turnId = hostTurnIdSchema.parse("turn-cancel-tool");
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "wait-tool:" }],
    });
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error("Session ended before Tool start");
      if (next.value.kind === "event" && next.value.event.type === "item.started") break;
    }
    await session.execute({ type: "turn.cancel", turnId });
    const remaining: HarnessOutput[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
      if (next.value.kind === "event" && next.value.event.type === "turn.completed") break;
    }
    expect(
      remaining.some(
        (output) =>
          output.kind === "event" &&
          output.event.type === "item.completed" &&
          output.event.snapshot.outcome.status === "cancelled",
      ),
    ).toBe(true);
    await session.close();
    await adapter.close();
  });

  it.each([
    ["malformed:", "protocolError"],
    ["missing-result:", "protocolError"],
    ["exit:7", "processExited"],
    ["auth:", "authenticationRequired"],
    ["duplicate-result:", "protocolError"],
  ] as const)("maps %s to a single failed terminal event", async (prompt, errorCode) => {
    const command = await executableFixture();
    const adapter = new AntigravityAdapter({ command, environment: process.env });
    const session = await openSession(adapter, { kind: "create", cwd: process.cwd() });
    const turnId = hostTurnIdSchema.parse(`turn-${errorCode}`);

    await session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: prompt }] });
    const outputs = await outputsThroughTurn(session);

    expect(
      outputs.filter((output) => output.kind === "event" && output.event.type === "turn.completed"),
    ).toHaveLength(1);
    expect(eventOfType(outputs, "turn.completed")).toMatchObject({
      outcome: { status: "failed", error: { code: errorCode } },
    });
    await session.close();
    await adapter.close();
  });

  it("cancels an active turn exactly once", async () => {
    const command = await executableFixture();
    const adapter = new AntigravityAdapter({ command, environment: process.env });
    const session = await openSession(adapter, { kind: "create", cwd: process.cwd() });
    const turnId = hostTurnIdSchema.parse("turn-cancel");

    await session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "wait:" }] });
    await expect(session.execute({ type: "turn.cancel", turnId })).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    const outputs = await outputsThroughTurn(session);

    expect(
      outputs.filter((output) => output.kind === "event" && output.event.type === "turn.completed"),
    ).toHaveLength(1);
    expect(eventOfType(outputs, "turn.completed")).toMatchObject({
      outcome: { status: "cancelled" },
    });
    await session.close();
    await adapter.close();
  });

  it("rejects unsupported first-phase configuration and history mutation", async () => {
    const command = await executableFixture();
    const adapter = new AntigravityAdapter({ command, environment: process.env });
    const model = harnessModelRefSchema.parse({ id: "manual-model" });

    await expect(
      adapter.open({ kind: "create", cwd: process.cwd(), model }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    await expect(
      adapter.open({
        kind: "rollbackLastTurn",
        cwd: process.cwd(),
        sourceRef: nativeSessionRefSchema.parse({
          formatVersion: 1,
          harnessId: "antigravity",
          nativeSessionId: "conv-existing",
        }),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    await adapter.close();
  });
});
