import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  HarnessOutputChannel,
  type HarnessAdapter,
  type HarnessError,
  type HarnessInspection,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HostAgentMessageItem,
  type HostCommand,
  type HostEvent,
  type HostItemSnapshot,
  type HostThreadSnapshot,
  type HostToolExecutionItem,
  type HostTurnSnapshot,
  type InspectHarnessInput,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type OpenSessionInput,
  type PermissionModeSelectCommand,
  type PermissionModeSelectCompleted,
  type ThinkingSelectCommand,
  type ThinkingSelectCompleted,
  type TurnCancelAccepted,
  type TurnCancelCommand,
  type TurnOutcome,
  type TurnStartAccepted,
  type TurnStartCommand,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  hostItemIdSchema,
  nativeSessionRefSchema,
  type HarnessId,
  type HostItemId,
  type HostTurnId,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import { AntigravityExecutableError, resolveAntigravityExecutable } from "./command.js";
import {
  AntigravityProcessTransport,
  type AntigravityProcessTransportOptions,
} from "./process-transport.js";
import type { AntigravityStreamEvent } from "./stream-events.js";

const antigravityHarnessId = harnessIdSchema.parse("antigravity");

const capabilities: HarnessSessionCapabilities = {
  configuration: {
    selectModel: false,
    selectThinkingOption: false,
    selectPermissionMode: false,
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
};

function error(
  code: HarnessError["code"],
  message: string,
  retryable = false,
  diagnostic?: string,
): HarnessError {
  return { code, message, retryable, ...(diagnostic ? { diagnostic } : {}) };
}

function unsupported(): HarnessError {
  return error("unsupported", "Antigravity CLI MVP does not support this command");
}

function nativeRef(conversationId: string): NativeSessionRef {
  return nativeSessionRefSchema.parse({
    formatVersion: 1,
    harnessId: antigravityHarnessId,
    nativeSessionId: conversationId,
  });
}

function nativeTurnRef(conversationId: string, turnId: HostTurnId): NativeTurnRef {
  return {
    formatVersion: 1,
    harnessId: antigravityHarnessId,
    nativeSessionId: conversationId,
    nativeTurnKey: turnId,
  };
}

interface ActiveTurn {
  turnId: HostTurnId;
  input: TurnStartCommand["input"];
  agentItem: HostAgentMessageItem | null;
  toolItems: Map<string, HostToolExecutionItem>;
  subagentItems: Map<string, HostToolExecutionItem>;
  completedItems: HostItemSnapshot[];
  terminal: boolean;
  cancelled: boolean;
  resultSeen: boolean;
  pendingOutcome: TurnOutcome | null;
  diagnostic: string | null;
}

type TransportFactory = (
  options: AntigravityProcessTransportOptions,
) => AntigravityProcessTransport;

export interface AntigravityAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface AntigravityAdapterDependencies {
  randomUUID(): string;
  createTransport: TransportFactory;
  probeVersion(command: string, cwd: string, environment: NodeJS.ProcessEnv): boolean;
}

class AntigravityHarnessSession implements HarnessSession {
  readonly harnessId: HarnessId = antigravityHarnessId;
  readonly capabilities = capabilities;
  readonly initialState: HarnessSessionState;
  readonly initialUsage = null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #onClosed: () => void;
  readonly #randomUUID: () => string;
  readonly #transport: AntigravityProcessTransport;
  readonly #turns: HostTurnSnapshot[] = [];
  #active: ActiveTurn | null = null;
  #closed = false;
  #state: HarnessSessionState;

  constructor(
    transport: AntigravityProcessTransport,
    initialNativeRef: NativeSessionRef | undefined,
    randomId: () => string,
    onClosed: () => void,
  ) {
    this.#transport = transport;
    this.#randomUUID = randomId;
    this.#onClosed = onClosed;
    this.#state = initialNativeRef ? { nativeRef: initialNativeRef } : {};
    this.initialState = this.#state;
    this.outputs = this.#channel.outputs;
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed) return { ok: false, error: error("invalidState", "Session is closed") };
    if (this.#active) {
      return {
        ok: false,
        error: error("sessionBusy", "Antigravity Session has an active Turn", true),
      };
    }
    return { ok: true, value: { turns: [...this.#turns], state: this.#state } };
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  execute(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>>;
  async execute(
    command: HostCommand,
  ): Promise<
    HarnessResult<
      | TurnStartAccepted
      | TurnCancelAccepted
      | InteractionRespondAccepted
      | ModelSelectCompleted
      | ThinkingSelectCompleted
      | PermissionModeSelectCompleted
    >
  > {
    if (this.#closed) return { ok: false, error: error("invalidState", "Session is closed") };
    if (command.type === "turn.cancel") return this.#cancel(command);
    if (command.type !== "turn.start") return { ok: false, error: unsupported() };
    if (this.#active) {
      return { ok: false, error: error("sessionBusy", "A Turn is already active", true) };
    }
    const prompt = command.input.map(({ text }) => text).join("\n");
    if (prompt.trim().length === 0) {
      return { ok: false, error: error("invalidRequest", "Turn text must not be empty") };
    }
    const active: ActiveTurn = {
      turnId: command.turnId,
      input: [...command.input],
      agentItem: null,
      toolItems: new Map(),
      subagentItems: new Map(),
      completedItems: [],
      terminal: false,
      cancelled: false,
      resultSeen: false,
      pendingOutcome: null,
      diagnostic: null,
    };
    this.#active = active;
    this.#event({ type: "turn.started", turnId: active.turnId });
    void this.#consume(active, prompt);
    return { ok: true, value: { turnId: command.turnId } };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#active) {
      this.#active.cancelled = true;
      await this.#transport.cancel();
      if (!this.#active.terminal) this.#finish(this.#active, { status: "cancelled" });
    }
    this.#channel.end();
    this.#onClosed();
  }

  async #cancel(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    const active = this.#active;
    if (!active || active.turnId !== command.turnId) {
      return { ok: false, error: error("invalidState", "Turn is not active") };
    }
    active.cancelled = true;
    await this.#transport.cancel();
    if (!active.terminal) this.#finish(active, { status: "cancelled" });
    return { ok: true, value: { cancellationRequested: true } };
  }

  async #consume(active: ActiveTurn, prompt: string): Promise<void> {
    try {
      const conversationId = this.#state.nativeRef?.nativeSessionId;
      for await (const transportEvent of this.#transport.run({
        prompt,
        ...(conversationId ? { conversationId } : {}),
      })) {
        if (active.terminal) continue;
        if (transportEvent.type === "diagnostic") {
          active.diagnostic = transportEvent.message;
          continue;
        }
        if (transportEvent.type === "exit") {
          if (active.cancelled) {
            this.#finish(active, { status: "cancelled" });
          } else if (transportEvent.code !== 0) {
            this.#finish(active, {
              status: "failed",
              error: error(
                "processExited",
                `Antigravity CLI exited with status ${transportEvent.code ?? "unknown"}`,
                true,
                active.diagnostic ?? undefined,
              ),
            });
          } else if (!active.resultSeen || !active.pendingOutcome) {
            this.#finish(active, {
              status: "failed",
              error: error(
                "protocolError",
                "Antigravity stream ended without a result event",
                true,
                active.diagnostic ?? undefined,
              ),
            });
          } else if (
            active.pendingOutcome.status === "succeeded" &&
            (active.toolItems.size > 0 || active.subagentItems.size > 0)
          ) {
            this.#finish(active, {
              status: "failed",
              error: error("protocolError", "Antigravity result left active items unfinished"),
            });
          } else {
            this.#finish(active, active.pendingOutcome);
          }
          continue;
        }
        this.#project(active, transportEvent.event);
      }
    } catch (caught) {
      if (!active.terminal) {
        this.#finish(active, {
          status: "failed",
          error: error(
            "protocolError",
            caught instanceof Error ? caught.message : "Antigravity stream failed",
            false,
          ),
        });
      }
    }
  }

  #project(active: ActiveTurn, event: AntigravityStreamEvent): void {
    if (event.type === "unknown") {
      active.diagnostic = `Ignored Antigravity stream event: ${event.event}`;
      return;
    }
    if (active.resultSeen) {
      active.pendingOutcome = {
        status: "failed",
        error: error("protocolError", "Antigravity emitted data after its result event"),
      };
      return;
    }
    if (event.type === "init") {
      const current = this.#state.nativeRef?.nativeSessionId;
      if (current && current !== event.conversationId) {
        active.resultSeen = true;
        active.pendingOutcome = {
          status: "failed",
          error: error("protocolError", "Antigravity changed conversation_id during a Session"),
        };
        return;
      }
      if (!current) {
        this.#state = { nativeRef: nativeRef(event.conversationId) };
        this.#event({ type: "session.state.changed", state: this.#state });
      }
      return;
    }
    if (event.type === "textDelta") {
      if (!active.agentItem) {
        active.agentItem = {
          type: "agentMessage",
          itemId: this.#itemId(),
          text: "",
        };
        this.#event({ type: "item.started", turnId: active.turnId, item: active.agentItem });
      }
      active.agentItem.text += event.text;
      this.#event({
        type: "item.updated",
        turnId: active.turnId,
        itemId: active.agentItem.itemId,
        update: { type: "text.append", text: event.text },
      });
      return;
    }
    if (event.type === "tool") {
      if (event.status === "active") {
        if (active.toolItems.has(event.toolId)) return;
        const item: HostToolExecutionItem = {
          type: "toolExecution",
          itemId: this.#itemId(),
          toolName: event.toolName,
          namespace: "antigravity",
          arguments: event.arguments,
        };
        active.toolItems.set(event.toolId, item);
        this.#event({ type: "item.started", turnId: active.turnId, item });
        return;
      }
      const item = active.toolItems.get(event.toolId);
      if (!item) {
        active.resultSeen = true;
        active.pendingOutcome = {
          status: "failed",
          error: error("protocolError", "Antigravity completed an unknown Tool"),
        };
        return;
      }
      const snapshot: HostItemSnapshot = {
        item: {
          ...item,
          ...(event.output ? { output: { content: [{ type: "text", text: event.output }] } } : {}),
        },
        outcome:
          event.status === "done"
            ? { status: "succeeded" }
            : {
                status: "failed",
                error: error("nativeFailure", `Antigravity Tool ${event.toolName} failed`, true),
              },
      };
      active.toolItems.delete(event.toolId);
      active.completedItems.push(snapshot);
      this.#event({ type: "item.completed", turnId: active.turnId, snapshot });
      return;
    }
    if (event.type === "subagent") {
      let item = active.subagentItems.get(event.subagentId);
      if (!item) {
        item = {
          type: "toolExecution",
          itemId: this.#itemId(),
          toolName: event.label,
          namespace: "antigravity.subagent",
          arguments: { subagentId: event.subagentId, status: event.status },
        };
        active.subagentItems.set(event.subagentId, item);
        this.#event({ type: "item.started", turnId: active.turnId, item });
      }
      const status = event.status.toUpperCase();
      const succeeded = ["DONE", "COMPLETED", "SUCCESS", "SUCCEEDED"].includes(status);
      const failed = ["FAILED", "ERROR"].includes(status);
      const cancelled = ["CANCELLED", "CANCELED"].includes(status);
      if (!succeeded && !failed && !cancelled) return;
      const completedItem = {
        ...item,
        arguments: { subagentId: event.subagentId, status: event.status },
      };
      const snapshot: HostItemSnapshot = {
        item: completedItem,
        outcome: succeeded
          ? { status: "succeeded" }
          : cancelled
            ? { status: "cancelled" }
            : {
                status: "failed",
                error: error("nativeFailure", `Antigravity Subagent ${event.label} failed`, true),
              },
      };
      active.subagentItems.delete(event.subagentId);
      active.completedItems.push(snapshot);
      this.#event({ type: "item.completed", turnId: active.turnId, snapshot });
      return;
    }
    active.resultSeen = true;
    if (event.usage) {
      this.#event({
        type: "session.usage.changed",
        usage: event.usage,
        observedForTurnId: active.turnId,
      });
    }
    if (event.status === "failed") {
      const message = event.message ?? "Antigravity reported a failed result";
      active.pendingOutcome = {
        status: "failed",
        error: error(
          /auth|login|credential/iu.test(message) ? "authenticationRequired" : "nativeFailure",
          message,
          true,
        ),
      };
      return;
    }
    if (!this.#state.nativeRef) {
      active.pendingOutcome = {
        status: "failed",
        error: error("protocolError", "Antigravity result omitted conversation_id initialization"),
      };
      return;
    }
    active.pendingOutcome = { status: "succeeded" };
  }

  #finish(active: ActiveTurn, outcome: TurnOutcome): void {
    if (active.terminal) return;
    active.terminal = true;
    if (active.agentItem) {
      const snapshot: HostItemSnapshot = {
        item: active.agentItem,
        outcome:
          outcome.status === "succeeded"
            ? { status: "succeeded" }
            : outcome.status === "cancelled"
              ? { status: "cancelled" }
              : { status: "failed", error: outcome.error },
      };
      active.completedItems.push(snapshot);
      this.#event({ type: "item.completed", turnId: active.turnId, snapshot });
    }
    for (const item of [...active.toolItems.values(), ...active.subagentItems.values()]) {
      const snapshot: HostItemSnapshot = {
        item,
        outcome:
          outcome.status === "succeeded"
            ? { status: "succeeded" }
            : outcome.status === "cancelled"
              ? { status: "cancelled" }
              : { status: "failed", error: outcome.error },
      };
      active.completedItems.push(snapshot);
      this.#event({ type: "item.completed", turnId: active.turnId, snapshot });
    }
    active.toolItems.clear();
    active.subagentItems.clear();
    const conversationId = this.#state.nativeRef?.nativeSessionId;
    const turnRef = conversationId ? nativeTurnRef(conversationId, active.turnId) : undefined;
    if (turnRef) {
      this.#turns.push({
        nativeTurnRef: turnRef,
        input: [...active.input],
        items: [...active.completedItems],
        outcome:
          outcome.status === "succeeded"
            ? { status: "succeeded" }
            : outcome.status === "cancelled"
              ? { status: "cancelled", ...(outcome.reason ? { reason: outcome.reason } : {}) }
              : { status: "failed", error: outcome.error },
      });
    }
    this.#event({
      type: "turn.completed",
      turnId: active.turnId,
      ...(turnRef ? { nativeTurnRef: turnRef } : {}),
      outcome,
    });
    if (this.#active === active) this.#active = null;
  }

  #itemId(): HostItemId {
    return hostItemIdSchema.parse(this.#randomUUID());
  }

  #event(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }
}

export class AntigravityAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = antigravityHarnessId;
  readonly #command: string | undefined;
  readonly #dependencies: AntigravityAdapterDependencies;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #sessions = new Set<AntigravityHarnessSession>();
  #closed = false;

  constructor(
    options: AntigravityAdapterOptions = {},
    dependencies: AntigravityAdapterDependencies = {
      randomUUID,
      createTransport: (transportOptions) => new AntigravityProcessTransport(transportOptions),
      probeVersion(command, cwd, environment) {
        const result = spawnSync(command, ["--version"], {
          cwd,
          env: environment,
          encoding: "utf8",
          timeout: 5_000,
        });
        return result.status === 0 && !result.error;
      },
    },
  ) {
    this.#command = options.command;
    this.#environment = options.environment ?? process.env;
    this.#dependencies = dependencies;
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closed) {
      return { status: "unavailable", error: error("invalidState", "Adapter is closed") };
    }
    try {
      const cwd = path.resolve(input.cwd ?? process.cwd());
      const command = this.#executable();
      if (!this.#dependencies.probeVersion(command, cwd, this.#environment)) {
        return {
          status: "unavailable",
          error: error("unavailable", "Antigravity CLI version probe failed", true),
        };
      }
      return {
        status: "ready",
        catalog: { models: [], thinkingOptions: [] },
        capabilities,
      };
    } catch (caught) {
      const missing = caught instanceof AntigravityExecutableError;
      return {
        status: missing ? "notInstalled" : "error",
        error: error(
          missing ? "notInstalled" : "unavailable",
          missing ? "Antigravity CLI is not installed" : "Antigravity CLI is unavailable",
          !missing,
        ),
      };
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) return { ok: false, error: error("invalidState", "Adapter is closed") };
    if (input.cwd.trim().length === 0) {
      return { ok: false, error: error("invalidRequest", "Antigravity requires cwd") };
    }
    if (input.kind === "fork" || input.kind === "rollbackLastTurn") {
      return { ok: false, error: unsupported() };
    }
    if (
      input.kind === "create" &&
      (input.model || input.thinkingOptionId || input.permissionModeId)
    ) {
      return { ok: false, error: unsupported() };
    }
    let initialNativeRef: NativeSessionRef | undefined;
    if (input.kind === "resume") {
      const parsed = nativeSessionRefSchema.safeParse(input.nativeRef);
      if (!parsed.success || parsed.data.harnessId !== this.harnessId) {
        return {
          ok: false,
          error: error("invalidRequest", "Antigravity cannot resume another Harness Session"),
        };
      }
      initialNativeRef = parsed.data;
    }
    try {
      const session = new AntigravityHarnessSession(
        this.#dependencies.createTransport({
          command: this.#executable(),
          cwd: path.resolve(input.cwd),
          environment: this.#environment,
        }),
        initialNativeRef,
        this.#dependencies.randomUUID,
        () => this.#sessions.delete(session),
      );
      this.#sessions.add(session);
      return { ok: true, value: session };
    } catch (caught) {
      const missing = caught instanceof AntigravityExecutableError;
      return {
        ok: false,
        error: error(
          missing ? "notInstalled" : "unavailable",
          missing ? "Antigravity CLI is not installed" : "Antigravity Session could not open",
          !missing,
        ),
      };
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#sessions].map((session) => session.close()));
    this.#sessions.clear();
  }

  #executable(): string {
    return resolveAntigravityExecutable({
      ...(this.#command ? { command: this.#command } : {}),
      environment: this.#environment,
    });
  }
}
