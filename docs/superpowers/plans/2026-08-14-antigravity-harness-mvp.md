# Antigravity Harness MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 codexhost 中增加基于 `agy --output-format stream-json` 的 Antigravity 外部 Harness，完成新会话、流式文本、工具状态、Usage、继续会话、取消和错误呈现的第一阶段闭环。

**Architecture:** 新的 `@codexhost/adapter-antigravity` 独占可执行文件解析、受监督子进程和 NDJSON 事件归一化，对外只实现通用 `HarnessAdapter`/`HarnessSession`。`protocol-core` 只新增稳定 Harness 路由，`host-runtime` 只注册 Adapter，Renderer 只新增 Agent 选项与无模型选择的 Transport ID；第一阶段不引入 Python SDK、审批、Artifacts 或 Manager UI。

**Tech Stack:** TypeScript 6、Node.js 24 `child_process`/`readline`、Vitest 4、Zod 4、现有 codexhost Harness contracts

## Global Constraints

- Harness ID 必须是 `antigravity`，Transport Model ID 必须是 `codexhost/antigravity-native`。
- 环境变量必须是 `CODEXHOST_ANTIGRAVITY_COMMAND`，未设置时默认解析 `agy`。
- 新会话调用 `agy -p <prompt> --output-format stream-json`；继续会话增加 `--conversation <conversation_id>`。
- 第一阶段不得传 `--dangerously-skip-permissions`。
- 第一阶段使用用户配置的默认模型，不解析人类可读的 `agy models` 输出。
- stderr 只用于脱敏诊断，不得混入 Agent 正文。
- 未知事件安全忽略并记录诊断；损坏 JSON、缺少终止事件、矛盾终态和非零退出必须成为明确错误。
- Fork 和内部开发可以继续；许可证明确前不发布安装包、npm 包或二进制 Release。

---

## File Map

- `packages/protocol-core/src/model-routing.ts`：新增 Antigravity 路由常量、Harness ID 和无配置 Transport 编解码。
- `packages/adapters/antigravity/src/command.ts`：跨平台解析 `agy` 可执行文件并构造不泄密的参数数组。
- `packages/adapters/antigravity/src/stream-events.ts`：把单行未知 JSON 归一化为内部事件，不管理进程。
- `packages/adapters/antigravity/src/process-transport.ts`：启动/取消子进程、逐行读取 stdout、隔离 stderr、产生传输事件。
- `packages/adapters/antigravity/src/antigravity-adapter.ts`：实现 Harness Adapter/Session、事件投影、会话恢复和终态幂等。
- `packages/adapters/antigravity/test/*`：纯解析测试和假 `agy` 进程集成测试，不访问 Google 服务。
- `packages/host-runtime/src/adapter-composition.ts`：注册 Antigravity Adapter。
- `packages/renderer-extension/src/*`：Agent Picker、图标、Ownership 恢复和 Transport Model 映射。
- `packages/host-runtime/scripts/build-release.mjs`、`tests/release/host-bundle.test.mjs`：确保生产 Host bundle 包含新 Adapter 且不含 Python SDK。
- `docs/antigravity-harness.md`：认证、能力、限制、环境变量和本地验收说明。

### Task 1: Add the stable Antigravity routing contract

**Files:**
- Modify: `packages/protocol-core/src/model-routing.ts`
- Modify: `packages/protocol-core/src/index.ts`
- Modify: `packages/protocol-core/test/model-routing.test.ts`

**Interfaces:**
- Consumes: `ExternalHarnessId`, `ExternalConfigurationSelection`, `CreateRoute` and existing Transport Model dispatch.
- Produces: `ANTIGRAVITY_NATIVE_TRANSPORT_MODEL_ID`, `encodeAntigravityTransportModel()`, `decodeAntigravityTransportSelection(value)`, and `ExternalHarnessId` containing `"antigravity"`.

- [ ] **Step 1: Write failing route tests**

Add these assertions to `model-routing.test.ts`:

```ts
expect(EXTERNAL_HARNESS_IDS).toContain("antigravity");
expect(transportModelIdForHarness("antigravity")).toBe("codexhost/antigravity-native");
expect(encodeExternalTransportSelection("antigravity", {})).toBe("codexhost/antigravity-native");
expect(decodeExternalTransportSelection("antigravity", "codexhost/antigravity-native")).toEqual({});
expect(() =>
  encodeExternalTransportSelection("antigravity", { model: { id: "manual-model" } }),
).toThrow("Antigravity MVP does not support Model selection");
expect(
  decodeCreateRoute({
    id: 1,
    method: "thread/start",
    params: { model: "codexhost/antigravity-native" },
  }),
).toMatchObject({ harnessId: "antigravity", routeMode: "native" });
```

- [ ] **Step 2: Run the protocol test and confirm the missing contract**

Run:

```bash
npx vitest run --config tests/vitest.config.js packages/protocol-core/test/model-routing.test.ts
```

Expected: TypeScript/test failure because `antigravity` and its transport functions do not exist.

- [ ] **Step 3: Implement the no-model-selection transport contract**

Add:

```ts
export const ANTIGRAVITY_NATIVE_TRANSPORT_MODEL_ID = "codexhost/antigravity-native";
export const EXTERNAL_HARNESS_IDS = [
  "pi",
  "claude-code",
  "deepseek-harness",
  "grok",
  "antigravity",
] as const;

export function encodeAntigravityTransportModel(
  selection: ExternalConfigurationSelection = {},
): string {
  if (selection.model || selection.thinkingOptionId || selection.permissionModeId) {
    throw new Error("Antigravity MVP does not support Model, Thinking, or Permission selection");
  }
  return ANTIGRAVITY_NATIVE_TRANSPORT_MODEL_ID;
}

export function decodeAntigravityTransportSelection(
  value: unknown,
): ExternalConfigurationSelection | null {
  return value === ANTIGRAVITY_NATIVE_TRANSPORT_MODEL_ID ? {} : null;
}
```

Add `antigravity` to `transportModelByHarness`, both encode/decode switches, and `decodeCreateRoute` before the final Codex fallback. Re-export the new constant/functions from `packages/protocol-core/src/index.ts`.

- [ ] **Step 4: Run the focused protocol tests**

```bash
npx vitest run --config tests/vitest.config.js packages/protocol-core/test/model-routing.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the routing contract**

```bash
git add packages/protocol-core/src/model-routing.ts packages/protocol-core/src/index.ts packages/protocol-core/test/model-routing.test.ts
git commit -m "feat: 新增 Antigravity 路由契约"
```

### Task 2: Parse Antigravity stream-json without process concerns

**Files:**
- Create: `packages/adapters/antigravity/package.json`
- Create: `packages/adapters/antigravity/tsconfig.json`
- Create: `packages/adapters/antigravity/src/stream-events.ts`
- Create: `packages/adapters/antigravity/test/stream-events.test.ts`
- Modify: `tsconfig.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: unknown NDJSON values and `HostUsage` from `@codexhost/harness-adapter`.
- Produces: `parseAntigravityLine(line: string): AntigravityStreamEvent`; discriminated union variants `init`, `textDelta`, `tool`, `subagent`, `result`, and `unknown`.

- [ ] **Step 1: Create workspace metadata and failing parser tests**

Use package name `@codexhost/adapter-antigravity`, dependencies only on `@codexhost/harness-adapter` and `@codexhost/shared-contracts`, and the same `tsconfig` shape as `packages/adapters/grok`. Add the root project reference.

Test one JSON line per documented event:

```ts
expect(parseAntigravityLine('{"event":"init","conversation_id":"conv-1"}')).toEqual({
  type: "init",
  conversationId: "conv-1",
});
expect(parseAntigravityLine('{"event":"step_update","step_type":"agent_response","agent_response":{"text_delta":"Hel"}}')).toEqual({
  type: "textDelta",
  text: "Hel",
});
expect(parseAntigravityLine('{"event":"step_update","step_type":"tool","status":"ACTIVE","tool_name":"search","tool_id":"tool-1","arguments":{"q":"codexhost"}}')).toMatchObject({
  type: "tool",
  status: "active",
  toolName: "search",
  toolId: "tool-1",
});
expect(parseAntigravityLine('{"event":"result","status":"SUCCESS","usage":{"input_tokens":10,"output_tokens":4,"total_tokens":14}}')).toEqual({
  type: "result",
  status: "success",
  usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
});
expect(() => parseAntigravityLine("not-json")).toThrow("invalid JSON");
expect(parseAntigravityLine('{"event":"step_update","step_type":"future"}')).toEqual({
  type: "unknown",
  event: "step_update:future",
});
```

- [ ] **Step 2: Run the parser tests and confirm the module is missing**

```bash
npx vitest run --config tests/vitest.config.js packages/adapters/antigravity/test/stream-events.test.ts
```

Expected: FAIL because `stream-events.ts` does not exist.

- [ ] **Step 3: Implement strict normalization helpers and event union**

Define the public union exactly:

```ts
export type AntigravityStreamEvent =
  | { type: "init"; conversationId: string }
  | { type: "textDelta"; text: string }
  | { type: "tool"; toolId: string; toolName: string; status: "active" | "done" | "failed"; arguments: JsonValue; output?: string }
  | { type: "subagent"; subagentId: string; label: string; status: string }
  | { type: "result"; status: "success" | "failed"; usage: HostUsage | null; message?: string }
  | { type: "unknown"; event: string };
```

Parse with `JSON.parse`, reject non-object roots, require non-blank `conversation_id`, text deltas and tool IDs, normalize `ACTIVE`/`DONE`/`FAILED`, and map snake_case Usage keys to `HostUsage`. Unknown `event` or `step_type` returns `unknown`; malformed known events throw an error whose message names the missing field but does not echo the complete line.

- [ ] **Step 4: Regenerate workspace lock metadata and run tests**

```bash
npm install --package-lock-only --ignore-scripts
npx vitest run --config tests/vitest.config.js packages/adapters/antigravity/test/stream-events.test.ts
npm run typecheck
```

Expected: parser tests PASS and the workspace reference typechecks.

- [ ] **Step 5: Commit the parser package**

```bash
git add package-lock.json tsconfig.json packages/adapters/antigravity/package.json packages/adapters/antigravity/tsconfig.json packages/adapters/antigravity/src/stream-events.ts packages/adapters/antigravity/test/stream-events.test.ts
git commit -m "feat: 解析 Antigravity 流式事件"
```

### Task 3: Add executable resolution and a supervised agy transport

**Files:**
- Create: `packages/adapters/antigravity/src/command.ts`
- Create: `packages/adapters/antigravity/src/process-transport.ts`
- Create: `packages/adapters/antigravity/test/process-transport.test.ts`
- Create: `packages/adapters/antigravity/test/fixtures/fake-agy.mjs`

**Interfaces:**
- Consumes: `parseAntigravityLine(line)` from Task 2.
- Produces: `resolveAntigravityExecutable(options): string`; `antigravityInvocation(input): { command; arguments; windowsVerbatimArguments }`; `AntigravityProcessTransport.run(input): AsyncIterable<AntigravityTransportEvent>`; `cancel(): Promise<void>`.

- [ ] **Step 1: Write failing command and fake-process tests**

Verify explicit command precedence, PATH discovery, missing executable, exact arguments, line ordering, stderr isolation, non-zero exit, missing result and cancellation. The exact invocation assertions are:

```ts
expect(antigravityInvocation({ command: "/bin/agy", prompt: "hello" })).toMatchObject({
  command: "/bin/agy",
  arguments: ["-p", "hello", "--output-format", "stream-json"],
});
expect(antigravityInvocation({ command: "/bin/agy", prompt: "again", conversationId: "conv-1" }).arguments).toEqual([
  "-p", "again",
  "--conversation", "conv-1",
  "--output-format", "stream-json",
]);
expect(antigravityInvocation({ command: "/bin/agy", prompt: "hello" }).arguments).not.toContain("--dangerously-skip-permissions");
```

The fixture reads the prompt and optional conversation ID, emits deterministic init/text/tool/result NDJSON, writes `diagnostic-only` to stderr, and supports modes selected by a prompt prefix: `exit:`, `malformed:`, `missing-result:`, and `wait:`.

- [ ] **Step 2: Run tests and confirm transport modules are missing**

```bash
npx vitest run --config tests/vitest.config.js packages/adapters/antigravity/test/process-transport.test.ts
```

Expected: FAIL on missing exports.

- [ ] **Step 3: Implement executable resolution and safe invocation**

Mirror the tested cross-platform discovery from `packages/adapters/grok/src/command.ts`, but use `CODEXHOST_ANTIGRAVITY_COMMAND`, default command `agy`, and candidates `~/.local/bin/agy`, `/opt/homebrew/bin/agy`, `/usr/local/bin/agy`, plus Windows PATHEXT discovery. Define:

```ts
export interface AntigravityInvocationInput {
  command: string;
  prompt: string;
  conversationId?: string;
  platform?: NodeJS.Platform;
}
```

Construct arguments as tested and never serialize environment values or credentials into an error.

- [ ] **Step 4: Implement the supervised child process transport**

Use `spawn` with `{ cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: platform !== "win32" }`, `readline.createInterface({ input: child.stdout })`, and an injected spawn dependency for tests. Emit:

```ts
export type AntigravityTransportEvent =
  | { type: "stream"; event: AntigravityStreamEvent }
  | { type: "diagnostic"; message: string }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null };
```

Cap collected stderr at 16 KiB, replace home-directory and token-like substrings before diagnostics, and never emit it as `textDelta`. On Unix, cancel by sending `SIGTERM` to the detached process group, wait 1,500 ms, then send `SIGKILL` if still active. On Windows, invoke `taskkill /PID <pid> /T /F` through an injected process-tree killer. Resolve `cancel()` only after the exit event and ensure one active run per transport instance.

- [ ] **Step 5: Run transport tests and commit**

```bash
npx vitest run --config tests/vitest.config.js packages/adapters/antigravity/test/process-transport.test.ts
git add packages/adapters/antigravity/src/command.ts packages/adapters/antigravity/src/process-transport.ts packages/adapters/antigravity/test/process-transport.test.ts packages/adapters/antigravity/test/fixtures/fake-agy.mjs
git commit -m "feat: 管理 agy 流式进程"
```

Expected: tests PASS; fixture stderr is absent from projected text; cancellation produces one exit.

### Task 4: Implement HarnessSession projection and resume semantics

**Files:**
- Create: `packages/adapters/antigravity/src/antigravity-adapter.ts`
- Create: `packages/adapters/antigravity/src/index.ts`
- Create: `packages/adapters/antigravity/test/antigravity-adapter.test.ts`

**Interfaces:**
- Consumes: `AntigravityProcessTransport`, `AntigravityStreamEvent`, `HarnessAdapter`, `HarnessSession`, `NativeSessionRef`.
- Produces: `AntigravityAdapter implements HarnessAdapter`; sessions supporting `turn.start`, `turn.cancel`, `readSnapshot`, `close`, create/resume; unsupported model/thinking/permission/fork/rollback operations return `HarnessError` with `code: "unsupported"`.

- [ ] **Step 1: Write failing Adapter lifecycle tests**

Cover exact Host output order:

```ts
expect(events.map((output) => output.kind === "event" ? output.event.type : output.kind)).toEqual([
  "turn.started",
  "session.state.changed",
  "item.started",
  "item.updated",
  "item.started",
  "item.completed",
  "session.usage.changed",
  "item.completed",
  "turn.completed",
]);
```

Assert the init state contains:

```ts
{
  nativeRef: {
    formatVersion: 1,
    harnessId: "antigravity",
    nativeSessionId: "conv-1"
  }
}
```

Then resume that ref and assert the next transport call receives `conversationId: "conv-1"`. Also assert: combined text remains in source order; Tool ACTIVE creates one `toolExecution`, DONE completes the same item; `result.usage` produces `session.usage.changed`; `turn.cancel` ends once with `status: "cancelled"`; malformed/missing/non-zero terminal paths end once with `status: "failed"`; a CLI result indicating authentication maps to `authenticationRequired`; invalid resume IDs map to `sessionNotFound`.

- [ ] **Step 2: Run tests and confirm the Adapter is missing**

```bash
npx vitest run --config tests/vitest.config.js packages/adapters/antigravity/test/antigravity-adapter.test.ts
```

Expected: FAIL because `AntigravityAdapter` does not exist.

- [ ] **Step 3: Implement Adapter inspection and open validation**

Use branded ID parsing once at module scope:

```ts
const antigravityHarnessId = harnessIdSchema.parse("antigravity");
```

`inspect()` resolves the executable and runs a light `agy --version` probe through an injected dependency, returning this schema-valid ready inspection:

```ts
{
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
}
```

`open()` rejects empty cwd, create requests containing model/thinking/permission, foreign Native refs, fork and rollback; resume accepts only this Harness and a non-blank `nativeSessionId`. Map a missing executable to `notInstalled`; map stderr/result phrases for missing login, expired login or interactive authentication to `authenticationRequired`; map permission-policy refusal to `nativeFailure` with a user-facing permission message; map an invalid conversation response to `sessionNotFound`.

- [ ] **Step 4: Implement one-active-turn session projection**

Concatenate all `HostTextInput.text` values with `\n`, allocate stable Host item IDs from an injected `randomUUID`, and maintain:

```ts
interface ActiveTurn {
  turnId: HostTurnId;
  agentItemId: HostItemId | null;
  toolItems: Map<string, HostItemId>;
  conversationId: string | null;
  terminal: boolean;
  cancelled: boolean;
}
```

On first text delta, start one empty `agentMessage`, then append each delta. On Tool ACTIVE, start `toolExecution`; on DONE/FAILED, complete that same item. Project `subagent` as a `toolExecution` with namespace `antigravity.subagent`. Persist the first init conversation ID and emit `session.state.changed`; reject a conflicting second ID as `protocolError`. A successful result completes all open items, emits usage, and completes the turn once. Failed result, malformed line, missing result at exit, or non-zero exit complete once with the matching `HarnessError`. Preserve confirmed `nativeRef` after failure.

- [ ] **Step 5: Implement close, cancel, snapshots and unsupported commands**

`turn.cancel` calls transport cancellation and returns `{ cancellationRequested: true }`; the exit handler emits one cancelled outcome. `close()` cancels an active process, ends the output channel and is idempotent. `readSnapshot()` returns confirmed completed turns captured by the session. Model, Thinking, Permission and Interaction commands return:

```ts
{
  ok: false,
  error: {
    code: "unsupported",
    message: "Antigravity CLI MVP does not support this command",
    retryable: false,
  },
}
```

Export Adapter, transport, parser, command resolver and `packageMetadata` from `src/index.ts`.

- [ ] **Step 6: Run Adapter tests and commit**

```bash
npx vitest run --config tests/vitest.config.js packages/adapters/antigravity/test/stream-events.test.ts packages/adapters/antigravity/test/process-transport.test.ts packages/adapters/antigravity/test/antigravity-adapter.test.ts
git add packages/adapters/antigravity/src/antigravity-adapter.ts packages/adapters/antigravity/src/index.ts packages/adapters/antigravity/test/antigravity-adapter.test.ts
git commit -m "feat: 实现 Antigravity Harness 会话"
```

Expected: all Adapter tests PASS with no network access.

### Task 5: Register Antigravity in Host Runtime and release closure

**Files:**
- Modify: `packages/host-runtime/package.json`
- Modify: `packages/host-runtime/src/adapter-composition.ts`
- Modify: `packages/host-runtime/src/app-server-host.ts:160-210`
- Modify: `packages/host-runtime/test/adapter-composition.test.ts`
- Modify: `packages/host-runtime/test/app-server-host.test.ts`
- Modify: `packages/host-runtime/scripts/build-release.mjs`
- Modify: `tests/release/host-bundle.test.mjs`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `AntigravityAdapter` and protocol `ExternalHarnessId` from prior tasks.
- Produces: `ANTIGRAVITY_COMMAND_ENV = "CODEXHOST_ANTIGRAVITY_COMMAND"`; default Adapter map entry; release bundle requirement.

- [ ] **Step 1: Write failing Host registration and bundle tests**

Update expected keys to:

```ts
["pi", "claude-code", "deepseek-harness", "grok", "antigravity"]
```

Assert `adapters.get("antigravity")?.harnessId === "antigravity"`, explicit command preservation, removal of `CODEXHOST_ANTIGRAVITY_COMMAND` from the official Codex environment, the Antigravity approval/server display label through the observable Host response path, and `/packages/adapters/antigravity/` as a required release input.

- [ ] **Step 2: Run Host tests and confirm missing registration**

```bash
npx vitest run --config tests/vitest.config.js packages/host-runtime/test/adapter-composition.test.ts packages/host-runtime/test/app-server-host.test.ts tests/release/host-bundle.test.mjs
```

Expected: FAIL on the missing Adapter key, environment filter, server label and bundle input.

- [ ] **Step 3: Register the Adapter and protect the official environment**

Import `AntigravityAdapter`, export the environment constant, and append:

```ts
[
  "antigravity",
  new AntigravityAdapter({
    ...(environment[ANTIGRAVITY_COMMAND_ENV]
      ? { command: environment[ANTIGRAVITY_COMMAND_ENV] }
      : {}),
    environment,
  }),
],
```

Add the workspace dependency, add the environment key to `officialEnvironment()` filtering, and add the exhaustive switch label. Extend bundle source checks to contain `CODEXHOST_ANTIGRAVITY_COMMAND` and not contain `antigravity_agent_sdk` or `python` bridge entrypoints.

- [ ] **Step 4: Regenerate lock data, run tests and commit**

```bash
npm install --package-lock-only --ignore-scripts
npx vitest run --config tests/vitest.config.js packages/host-runtime/test/adapter-composition.test.ts packages/host-runtime/test/app-server-host.test.ts tests/release/host-bundle.test.mjs
git add package-lock.json packages/host-runtime/package.json packages/host-runtime/src/adapter-composition.ts packages/host-runtime/src/app-server-host.ts packages/host-runtime/test/adapter-composition.test.ts packages/host-runtime/test/app-server-host.test.ts packages/host-runtime/scripts/build-release.mjs tests/release/host-bundle.test.mjs
git commit -m "feat: 注册 Antigravity Host Adapter"
```

Expected: focused Host and release tests PASS.

### Task 6: Add Antigravity to Renderer selection and ownership restoration

**Files:**
- Modify: `packages/renderer-extension/src/agent-selection-state.ts`
- Modify: `packages/renderer-extension/src/renderer-agent-icon.ts`
- Modify: `packages/renderer-extension/src/renderer-agent-picker.ts`
- Modify: `packages/renderer-extension/src/renderer-binding-probe.ts`
- Modify: `packages/renderer-extension/src/versioned-renderer-adapter.ts`
- Modify: `packages/renderer-extension/test/agent-selection-state.test.ts`
- Modify: `packages/renderer-extension/test/renderer-agent-icon.test.ts`
- Modify: `packages/renderer-extension/test/renderer-agent-picker.test.ts`
- Modify: `packages/renderer-extension/test/renderer-binding-probe.test.ts`
- Modify: `packages/renderer-extension/test/versioned-renderer-adapter.test.ts`

**Interfaces:**
- Consumes: protocol Transport Model ID and Host inspection.
- Produces: `RendererAgent` value `"antigravity"`; label/icon/install URL; Renderer transport mapping; restored Ownership with no model/thinking/permission fields; explicit no-model Harness readiness.

- [ ] **Step 1: Write failing Renderer registration tests**

Assert:

```ts
expect(KNOWN_RENDERER_AGENTS).toContain("antigravity");
expect(RENDERER_AGENT_LABELS.antigravity).toBe("Antigravity");
expect(RENDERER_AGENT_INSTALL_URLS.antigravity).toBe("https://antigravity.google/docs/cli/getting-started");
expect(transportModelIdForAgent("antigravity")).toBe("codexhost/antigravity-native");
expect(restoredThreadOwnership({
  harnessId: harnessIdSchema.parse("antigravity"),
  transportModelId: "codexhost/antigravity-native",
  state: {},
} as ThreadInspection)).toEqual({ agent: "antigravity" });
```

Verify the icon is an inline SVG with `aria-hidden="true"`, not a copied Antigravity trademark asset. Add Renderer Composer assertions that Antigravity's `selectModel: false` inspection makes submission ready, hides the external model picker, and calls `applyAgent("antigravity", undefined, undefined, undefined, composer)`.

- [ ] **Step 2: Run Renderer tests and confirm missing union cases**

```bash
npx vitest run --config tests/vitest.config.js packages/renderer-extension/test/agent-selection-state.test.ts packages/renderer-extension/test/renderer-agent-icon.test.ts packages/renderer-extension/test/renderer-agent-picker.test.ts packages/renderer-extension/test/renderer-binding-probe.test.ts packages/renderer-extension/test/versioned-renderer-adapter.test.ts
```

Expected: type/test failures for unknown `antigravity` cases.

- [ ] **Step 3: Implement no-model Renderer registration**

Append `antigravity` to `KNOWN_RENDERER_AGENTS`, labels, external IDs and availability arrays. Add `ANTIGRAVITY_TRANSPORT_MODEL_ID = "codexhost/antigravity-native"`; include it in transport detection and make its encode/decode path reject model/thinking/permission fields. Add Ownership restoration that validates the exact Transport ID and returns `{ agent: "antigravity" }`.

Because the shared inspection contract requires a catalog but Antigravity MVP deliberately exposes no selectable model, add a pure policy:

```ts
export function rendererAgentRequiresModel(agent: RendererAgent): boolean {
  return agent !== "codex" && agent !== "antigravity";
}
```

In `loadExternalCatalog`, accept `selectModel: false` only for `antigravity`, keep `modelView` at `{ status: "empty", catalog, thinkingSelectionSupported: false }`, and mark configuration ready when permission mode is ready. In `renderComposerAgentControl`, compute `modelBlocked` only when `rendererAgentRequiresModel(state.agent)` is true and call `renderRendererModelPicker(..., state.agent !== "codex" && rendererAgentRequiresModel(state.agent))`. `applyComposerAgent` then passes no model and `modelSelectionForAgent` writes the fixed Antigravity Transport ID.

Create a neutral original inline SVG mark using two simple paths:

```ts
const ANTIGRAVITY_PATHS = [
  { d: "M12 2 4.5 21h3.8l1.4-4h4.6l1.4 4h3.8L12 2zm0 7.1 1.3 4.2h-2.6L12 9.1z", fillRule: "evenodd" },
  { d: "M4 5.5h4v2H4zm12 0h4v2h-4z" },
] as const;
```

Use `currentColor`; do not add an external image file. Antigravity exposes no model control in phase one, so the default transport is applied without a `HarnessModelRef`.

- [ ] **Step 4: Run Renderer tests and commit**

```bash
npx vitest run --config tests/vitest.config.js packages/renderer-extension/test/agent-selection-state.test.ts packages/renderer-extension/test/renderer-agent-icon.test.ts packages/renderer-extension/test/renderer-agent-picker.test.ts packages/renderer-extension/test/renderer-binding-probe.test.ts packages/renderer-extension/test/versioned-renderer-adapter.test.ts
git add packages/renderer-extension/src/agent-selection-state.ts packages/renderer-extension/src/renderer-agent-icon.ts packages/renderer-extension/src/renderer-agent-picker.ts packages/renderer-extension/src/renderer-binding-probe.ts packages/renderer-extension/src/versioned-renderer-adapter.ts packages/renderer-extension/test/agent-selection-state.test.ts packages/renderer-extension/test/renderer-agent-icon.test.ts packages/renderer-extension/test/renderer-agent-picker.test.ts packages/renderer-extension/test/renderer-binding-probe.test.ts packages/renderer-extension/test/versioned-renderer-adapter.test.ts
git commit -m "feat: 在 Renderer 中接入 Antigravity"
```

Expected: all focused Renderer tests PASS.

### Task 7: Document capability limits and run the first-phase gate

**Files:**
- Create: `docs/antigravity-harness.md`
- Modify: `README.md`
- Modify: `docs/README.en.md`

**Interfaces:**
- Consumes: complete first-phase Adapter behavior.
- Produces: reproducible installation/authentication/configuration guide and a truthful acceptance record boundary.

- [ ] **Step 1: Write the user-facing Antigravity guide**

Document these exact commands and limits:

```md
## 配置

1. 安装并完成 Antigravity CLI 的交互式认证。
2. 确认 `agy --version` 可在终端执行。
3. 非标准路径使用 `CODEXHOST_ANTIGRAVITY_COMMAND=/absolute/path/to/agy`。

codexhost 调用新会话：`agy -p <prompt> --output-format stream-json`；继续会话会增加 `--conversation <conversation_id>`。它不会传 `--dangerously-skip-permissions`。

## 第一阶段限制

- 使用 Antigravity 用户配置的默认模型。
- 不提供交互式审批、结构化提问、Artifacts、Subagent 管理界面或跨工作区 Manager。
- Fork 上游许可证文件缺失，在授权明确前不提供安装包、npm 包或二进制 Release。
```

Add a feature-table row and link in both READMEs, without claiming SDK Bridge or approval support.

- [ ] **Step 2: Run automated verification with fresh evidence**

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:typescript
npm run build:renderer
node packages/host-runtime/scripts/build-release.mjs --output /tmp/codexhost-antigravity-host-runtime.mjs
```

Expected: every command exits 0; the bundle audit lists `/packages/adapters/antigravity/`; no Python SDK is bundled.

- [ ] **Step 3: Run conditional macOS live acceptance**

First run:

```bash
command -v agy
agy --version
```

If both succeed and the user account is already authenticated, launch codexhost and verify one new Thread plus one resumed turn, text streaming, at least one real tool event, Usage and cancellation. If installation or authentication is missing, record the exact external prerequisite as `未完成`, keep fixture tests as automated evidence only, and do not label live acceptance as passed.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md docs/README.en.md docs/antigravity-harness.md
git commit -m "docs: 说明 Antigravity 能力与限制"
```

- [ ] **Step 5: Verify branch and push without publishing a release**

```bash
git status --short
git log --oneline --decorate -10
git push origin agent/antigravity-harness
```

Expected: worktree clean, all implementation commits visible on `origin/agent/antigravity-harness`, and no package/Release publication command executed.
