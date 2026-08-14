import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AntigravityExecutableError,
  antigravityInvocation,
  resolveAntigravityExecutable,
} from "../src/command.js";
import {
  AntigravityProcessTransport,
  type AntigravityTransportEvent,
  windowsTaskkillArguments,
} from "../src/process-transport.js";

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
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-fake-agy-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "agy");
  await writeFile(executable, await fs.promises.readFile(fixture), { mode: 0o700 });
  return executable;
}

async function collect(
  transport: AntigravityProcessTransport,
  prompt: string,
  conversationId?: string,
): Promise<AntigravityTransportEvent[]> {
  const events: AntigravityTransportEvent[] = [];
  for await (const event of transport.run({
    prompt,
    ...(conversationId ? { conversationId } : {}),
  })) {
    events.push(event);
  }
  return events;
}

describe("Antigravity command resolution", () => {
  it("prefers an explicit executable and finds agy on PATH", async () => {
    const executable = await executableFixture();
    expect(resolveAntigravityExecutable({ command: executable, environment: { PATH: "" } })).toBe(
      executable,
    );
    expect(
      resolveAntigravityExecutable({
        environment: { PATH: path.dirname(executable) },
        homeDirectory: "/synthetic/home",
      }),
    ).toBe(executable);
  });

  it("reports a missing executable without exposing environment values", () => {
    expect(() =>
      resolveAntigravityExecutable({
        environment: { PATH: "", SECRET_TOKEN: "do-not-echo" },
        homeDirectory: "/missing/home",
        platform: "linux",
      }),
    ).toThrow(AntigravityExecutableError);
    expect(() =>
      resolveAntigravityExecutable({
        environment: { PATH: "", SECRET_TOKEN: "do-not-echo" },
        homeDirectory: "/missing/home",
        platform: "linux",
      }),
    ).not.toThrow("do-not-echo");
  });

  it("builds exact new and resumed invocations without bypassing permissions", () => {
    expect(antigravityInvocation({ command: "/bin/agy", prompt: "hello" })).toEqual({
      command: "/bin/agy",
      arguments: ["-p", "hello", "--output-format", "stream-json"],
      windowsVerbatimArguments: false,
    });
    const resumed = antigravityInvocation({
      command: "/bin/agy",
      prompt: "again",
      conversationId: "conv-1",
    });
    expect(resumed.arguments).toEqual([
      "-p",
      "again",
      "--conversation",
      "conv-1",
      "--output-format",
      "stream-json",
    ]);
    expect(resumed.arguments).not.toContain("--dangerously-skip-permissions");
  });
});

describe("Antigravity process transport", () => {
  it("terminates the complete Windows process tree", () => {
    expect(windowsTaskkillArguments(42, false)).toEqual(["/pid", "42", "/t"]);
    expect(windowsTaskkillArguments(42, true)).toEqual(["/pid", "42", "/t", "/f"]);
  });

  it("streams normalized stdout, keeps stderr diagnostic-only and reports exit", async () => {
    const executable = await executableFixture();
    const transport = new AntigravityProcessTransport({
      command: executable,
      cwd: process.cwd(),
      environment: process.env,
    });

    const events = await collect(transport, "success:");

    expect(events.filter(({ type }) => type === "stream")).toHaveLength(5);
    expect(events).toContainEqual({ type: "diagnostic", message: "diagnostic-only" });
    expect(events.at(-1)).toEqual({ type: "exit", code: 0, signal: null });
    expect(JSON.stringify(events)).not.toContain('"text":"diagnostic-only"');
  });

  it("passes the confirmed conversation ID to resumed turns", async () => {
    const executable = await executableFixture();
    const transport = new AntigravityProcessTransport({
      command: executable,
      cwd: process.cwd(),
      environment: process.env,
    });

    const events = await collect(transport, "success:", "conv-1");

    expect(events).not.toContainEqual({
      type: "stream",
      event: { type: "init", conversationId: "conv-fixture" },
    });
    expect(events).toContainEqual({
      type: "stream",
      event: { type: "textDelta", text: "resumed" },
    });
  });

  it("reports non-zero exit separately from stderr", async () => {
    const executable = await executableFixture();
    const transport = new AntigravityProcessTransport({
      command: executable,
      cwd: process.cwd(),
      environment: process.env,
    });

    const events = await collect(transport, "exit:7");

    expect(events).toContainEqual({ type: "diagnostic", message: "diagnostic-only" });
    expect(events.at(-1)).toEqual({ type: "exit", code: 7, signal: null });
  });

  it("redacts token-like stderr values before exposing diagnostics", async () => {
    const executable = await executableFixture();
    const transport = new AntigravityProcessTransport({
      command: executable,
      cwd: process.cwd(),
      environment: process.env,
    });

    const events = await collect(transport, "secret:");

    expect(events).toContainEqual({ type: "diagnostic", message: "token=<redacted>" });
    expect(JSON.stringify(events)).not.toContain("do-not-echo");
  });

  it("rejects malformed stdout instead of silently dropping it", async () => {
    const executable = await executableFixture();
    const transport = new AntigravityProcessTransport({
      command: executable,
      cwd: process.cwd(),
      environment: process.env,
    });

    await expect(collect(transport, "malformed:")).rejects.toThrow("invalid JSON");
  });

  it.runIf(process.platform !== "win32")(
    "kills the process tree after a parser failure",
    async () => {
      const executable = await executableFixture();
      const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-tree-"));
      temporaryDirectories.push(directory);
      const pidPath = path.join(directory, "child.pid");
      const transport = new AntigravityProcessTransport({
        command: executable,
        cwd: process.cwd(),
        environment: process.env,
      });

      await expect(collect(transport, `orphan:${pidPath}`)).rejects.toThrow("invalid JSON");
      const pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    },
  );

  it("cancels the active process and emits one terminal exit", async () => {
    const executable = await executableFixture();
    const transport = new AntigravityProcessTransport({
      command: executable,
      cwd: process.cwd(),
      environment: process.env,
    });
    const iterator = transport.run({ prompt: "wait:" })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "stream", event: { type: "init" } },
    });

    await transport.cancel();
    const remaining: AntigravityTransportEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }

    expect(remaining.filter(({ type }) => type === "exit")).toHaveLength(1);
  });
});
