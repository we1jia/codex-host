import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import readline from "node:readline";
import type { Readable } from "node:stream";

import { antigravityInvocation, resolveAntigravityExecutable } from "./command.js";
import { parseAntigravityLine, type AntigravityStreamEvent } from "./stream-events.js";

export type AntigravityTransportEvent =
  | { type: "stream"; event: AntigravityStreamEvent }
  | { type: "diagnostic"; message: string }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null };

export interface AntigravityProcessTransportOptions {
  command?: string;
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnProcess?: AntigravitySpawnProcess;
}

type AntigravityChildProcess = ChildProcessByStdio<null, Readable, Readable>;
interface AntigravitySpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ["ignore", "pipe", "pipe"];
  detached: boolean;
  windowsVerbatimArguments: boolean;
}
type AntigravitySpawnProcess = (
  command: string,
  arguments_: readonly string[],
  options: AntigravitySpawnOptions,
) => AntigravityChildProcess;

interface ActiveProcess {
  child: AntigravityChildProcess;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const STDERR_LIMIT = 16 * 1024;
const CANCEL_GRACE_MS = 1_500;

export function windowsTaskkillArguments(pid: number, force: boolean): string[] {
  return ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])];
}

function killWindowsProcessTree(pid: number, force: boolean): boolean {
  const result = spawnSync("taskkill", windowsTaskkillArguments(pid, force), {
    windowsHide: true,
    stdio: "ignore",
  });
  return result.status === 0 && !result.error;
}

function sanitizedDiagnostic(value: string, environment: NodeJS.ProcessEnv): string {
  let message = value.trim().slice(0, STDERR_LIMIT);
  const home = environment.HOME ?? environment.USERPROFILE;
  if (home) message = message.replaceAll(home, "<home>");
  return message.replace(/(token|key|secret|password)\s*[=:]\s*\S+/giu, "$1=<redacted>");
}

export class AntigravityProcessTransport {
  readonly #command: string;
  readonly #cwd: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #platform: NodeJS.Platform;
  readonly #spawn: AntigravitySpawnProcess;
  #active: ActiveProcess | null = null;

  constructor(options: AntigravityProcessTransportOptions) {
    this.#environment = options.environment ?? process.env;
    this.#platform = options.platform ?? process.platform;
    this.#command = resolveAntigravityExecutable({
      ...(options.command ? { command: options.command } : {}),
      environment: this.#environment,
      platform: this.#platform,
    });
    this.#cwd = options.cwd;
    this.#spawn =
      options.spawnProcess ??
      ((command, arguments_, spawnOptions) =>
        spawn(command, [...arguments_], {
          ...spawnOptions,
          stdio: ["ignore", "pipe", "pipe"],
        }));
  }

  async *run(input: {
    prompt: string;
    conversationId?: string;
  }): AsyncIterable<AntigravityTransportEvent> {
    if (this.#active) throw new Error("Antigravity process transport already has an active run");
    const invocation = antigravityInvocation({
      command: this.#command,
      prompt: input.prompt,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      platform: this.#platform,
    });
    const child = this.#spawn(invocation.command, invocation.arguments, {
      cwd: this.#cwd,
      env: this.#environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: this.#platform !== "win32",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    this.#active = { child, exit };
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.slice(0, STDERR_LIMIT - stderr.length);
    });
    const lines = readline.createInterface({ input: child.stdout });
    try {
      for await (const line of lines) {
        if (line.trim().length === 0) continue;
        yield { type: "stream", event: parseAntigravityLine(line) };
      }
      const terminal = await exit;
      const diagnostic = sanitizedDiagnostic(stderr, this.#environment);
      if (diagnostic) yield { type: "diagnostic", message: diagnostic };
      yield { type: "exit", ...terminal };
    } finally {
      lines.close();
      const active = this.#active?.child === child ? this.#active : null;
      if (active && child.exitCode === null && child.signalCode === null) {
        this.#terminate(active, true);
      }
      await exit.catch(() => undefined);
      if (this.#active?.child === child) this.#active = null;
    }
  }

  #terminate(active: ActiveProcess, force: boolean): void {
    const pid = active.child.pid;
    if (pid === undefined) return;
    try {
      if (this.#platform === "win32") {
        if (!killWindowsProcessTree(pid, force)) {
          active.child.kill(force ? "SIGKILL" : "SIGTERM");
        }
      } else {
        process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
      }
    } catch {
      active.child.kill(force ? "SIGKILL" : "SIGTERM");
    }
  }

  async cancel(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    this.#terminate(active, false);
    const exited = active.exit.then(
      () => true,
      () => true,
    );
    const graceful = await Promise.race([
      exited,
      new Promise<false>((resolve) => setTimeout(() => resolve(false), CANCEL_GRACE_MS)),
    ]);
    if (!graceful) this.#terminate(active, true);
    await active.exit.catch(() => undefined);
  }
}
