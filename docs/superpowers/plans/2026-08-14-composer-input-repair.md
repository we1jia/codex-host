# Composer Input Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让普通 Chat 完全脱离 codexhost Composer 绑定，并确保真实 Codex Composer 在路由异常时仍可编辑、仅在提交时 fail-closed。

**Architecture:** Renderer 只接受官方 `[data-codex-composer-root]` 作为 Composer 根节点；捕获阶段事件处理按“编辑”和“提交”拆开。编辑事件仅 best-effort 同步路由且永不阻止默认行为，Enter、submit 与发送按钮在路由未就绪时阻止提交，并通过 Composer 内的 `aria-live` 状态保留草稿、显示原因。

**Tech Stack:** TypeScript 6、DOM Event API、Vitest 4、Playwright 1.62、esbuild

## Global Constraints

- 不修改、重签名或重新分发官方 Codex Desktop。
- Composer 只允许由官方 `[data-codex-composer-root]` 标记识别。
- 普通字符、IME、Backspace、Delete、Cmd/Ctrl+V/X/C、`beforeinput` 和 `Shift+Enter` 必须 fail-open。
- Enter、form submit 与发送按钮必须在路由、外部配置或 Ownership 未就绪时 fail-closed。
- 被阻止的提交必须保留草稿并显示可理解的错误，不得静默吞掉事件。
- 保留当前 `main` 的 Pi、Claude Code、DeepSeek Harness 与 Grok 能力；只移植上游 PR #11 的目标改动，不合并其旧基线删除项。

---

## File Map

- `packages/renderer-extension/src/renderer-composer-dom.ts`：严格识别 Codex Composer，承载提交状态的 DOM 控件。
- `packages/renderer-extension/src/renderer-binding-probe.ts`：管理挂载生命周期，并把编辑事件与提交事件分流。
- `packages/renderer-extension/test/renderer-binding-probe.test.ts`：验证键盘事件分类和纯函数边界。
- `tests/e2e/renderer-chat-composer-isolation.spec.ts`：验证普通 Chat 不挂载、不拦截，标记移除后销毁绑定。
- `tests/e2e/renderer-codex-composer-input.spec.ts`：验证真实 Codex Composer 路由失败时编辑放行、提交阻止、草稿和错误状态保留。
- `README.md`、`docs/README.en.md`：记录输入修复行为和诊断边界。

### Task 1: Strict Chat/Codex Composer isolation

**Files:**
- Modify: `packages/renderer-extension/src/renderer-composer-dom.ts:113-135`
- Modify: `packages/renderer-extension/src/renderer-binding-probe.ts:360-390,1310-1465,1540-1610,1628-1640`
- Create: `tests/e2e/renderer-chat-composer-isolation.spec.ts`

**Interfaces:**
- Consumes: `CODEX_COMPOSER_SELECTOR = "[data-codex-composer-root]"`, `disposeComposerAgentControl(control)` and existing `mountedByComposer` lifecycle.
- Produces: `composerForEditor(editor: Element): Element | null` and `composerForElement(element: Element): Element | null` that never infer a Composer from a generic form or send button; local `isMountedComposer(composer: Element): boolean` used by all capture listeners.

- [ ] **Step 1: Add the failing ordinary Chat isolation E2E**

Create `tests/e2e/renderer-chat-composer-isolation.spec.ts` with the upstream PR #11 regression setup, while bundling the current branch rather than its historical branch:

```ts
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererBindingProbe } from "./packages/renderer-extension/src/renderer-binding-probe.ts";
      installRendererBindingProbe({ enabledAgents: ["codex", "pi"], defaultAgent: "pi" });
    `,
    resolveDir: repositoryRoot,
    sourcefile: "renderer-chat-composer-isolation-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl" },
  write: false,
});

const browserBundle = outputFiles[0]?.text;
if (typeof browserBundle !== "string") throw new Error("Renderer bundle was not generated");

async function dispatchInputIntents(page: Page): Promise<unknown> {
  return page.locator('[role="textbox"]').evaluate((editor) => {
    const dispatch = (event: Event) => ({
      accepted: editor.dispatchEvent(event),
      prevented: event.defaultPrevented,
    });
    return {
      backspace: dispatch(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true })),
      paste: dispatch(new KeyboardEvent("keydown", { key: "v", metaKey: true, bubbles: true, cancelable: true })),
      beforeInput: dispatch(new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true })),
    };
  });
}

const untouched = {
  backspace: { accepted: true, prevented: false },
  paste: { accepted: true, prevented: false },
  beforeInput: { accepted: true, prevented: false },
};

test("ordinary Chat composers remain untouched", async ({ page }) => {
  await page.setContent(`<form data-chat-composer><div contenteditable="true" role="textbox">draft</div><button type="submit">Send</button></form>`);
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => new Promise<void>((resolve) => queueMicrotask(resolve)));
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(0);
  await expect(page.locator("button[type=submit]")).toBeEnabled();
  expect(await dispatchInputIntents(page)).toEqual(untouched);
});

test("removing and restoring the Codex marker disposes and remounts the binding", async ({ page }) => {
  await page.setContent(`<form data-codex-composer-root><div contenteditable="true" role="textbox">draft</div><button type="submit">Send</button></form>`);
  await page.addScriptTag({ content: browserBundle });
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(1);
  await page.locator("form").evaluate((composer) => composer.removeAttribute("data-codex-composer-root"));
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(0);
  await expect(page.locator("button[type=submit]")).toBeEnabled();
  expect(await dispatchInputIntents(page)).toEqual(untouched);
  await page.locator("form").evaluate((composer) => composer.setAttribute("data-codex-composer-root", ""));
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(1);
});
```

- [ ] **Step 2: Run the E2E and confirm the current fallback misidentifies Chat**

Run:

```bash
npx playwright test tests/e2e/renderer-chat-composer-isolation.spec.ts --config tests/e2e/playwright.config.js
```

Expected: FAIL because the ordinary Chat form receives one codexhost Agent control or because its input intent is prevented.

- [ ] **Step 3: Restrict Composer lookup to the official marker**

Replace the fallback logic in `renderer-composer-dom.ts` with:

```ts
export function composerForEditor(editor: Element): Element | null {
  return editor.closest(CODEX_COMPOSER_SELECTOR);
}

export function composerForElement(element: Element): Element | null {
  return element.closest(CODEX_COMPOSER_SELECTOR);
}
```

In `renderer-binding-probe.ts`, add and use the mounted predicate:

```ts
const isMountedComposer = (composer: Element): boolean =>
  composer.isConnected &&
  composer.matches(CODEX_COMPOSER_SELECTOR) &&
  mountedByComposer.has(composer);
```

Require the marker in `mount()`, require `isMountedComposer()` in keydown/submit/click lookup, and add `data-codex-composer-root` to the MutationObserver `attributeFilter`. During scan, dispose a binding when the root is disconnected, loses the marker, or loses its injected control; clear its usage timer and increment `usageRequestGeneration` before deletion.

- [ ] **Step 4: Run isolation tests and focused Renderer tests**

Run:

```bash
npx playwright test tests/e2e/renderer-chat-composer-isolation.spec.ts --config tests/e2e/playwright.config.js
npx vitest run --config tests/vitest.config.js packages/renderer-extension/test/renderer-binding-probe.test.ts
```

Expected: both E2E cases PASS and all Renderer binding unit tests PASS.

- [ ] **Step 5: Commit the isolated change**

```bash
git add packages/renderer-extension/src/renderer-composer-dom.ts packages/renderer-extension/src/renderer-binding-probe.ts tests/e2e/renderer-chat-composer-isolation.spec.ts
git commit -m "fix: 隔离 Chat 与 Codex 输入框"
```

### Task 2: Fail-open editing and visible fail-closed submission

**Files:**
- Modify: `packages/renderer-extension/src/renderer-composer-dom.ts:53-65,340-425,427-485`
- Modify: `packages/renderer-extension/src/renderer-binding-probe.ts:250-265,418-445,1514-1608`
- Modify: `packages/renderer-extension/test/renderer-binding-probe.test.ts:125-150`
- Create: `tests/e2e/renderer-codex-composer-input.spec.ts`

**Interfaces:**
- Consumes: `isComposerInputIntent(event)`, `isComposerSubmissionKey(event)`, `applyComposerAgent(composer)` and `prepareComposer(composer)`.
- Produces: `ComposerAgentControl.submissionStatus: HTMLElement`; `renderComposerAgentControl(..., submissionError?: string | null): void`; `MountedComposer.submissionError: string | null`; editing handlers that never call `blockEvent`.

- [ ] **Step 1: Add a failing Codex Composer E2E with a deliberately unavailable route**

Bundle the probe with `defaultAgent: "pi"` and no installed Renderer adapter, mount a marked Composer containing `draft`, then dispatch the full matrix below:

```ts
const editEvents = [
  new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }),
  new KeyboardEvent("keydown", { key: "Process", bubbles: true, cancelable: true, isComposing: true }),
  new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
  new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
  new KeyboardEvent("keydown", { key: "v", metaKey: true, bubbles: true, cancelable: true }),
  new KeyboardEvent("keydown", { key: "x", metaKey: true, bubbles: true, cancelable: true }),
  new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true }),
  new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }),
  new InputEvent("beforeinput", { inputType: "insertFromPaste", bubbles: true, cancelable: true }),
  new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true }),
];

for (const event of editEvents) {
  expect(editor.dispatchEvent(event), `${event.type}:${"key" in event ? event.key : event.inputType}`).toBe(true);
  expect(event.defaultPrevented).toBe(false);
}

const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
expect(editor.dispatchEvent(enter)).toBe(false);
expect(enter.defaultPrevented).toBe(true);
expect(editor.textContent).toBe("draft");
```

Assert that `[data-codexhost-submission-status]` is visible and contains `draft was kept` after Enter. Also submit the form and click the send button; both must be prevented without changing the editor text.

- [ ] **Step 2: Run the E2E and confirm editing is currently blocked**

Run:

```bash
npx playwright test tests/e2e/renderer-codex-composer-input.spec.ts --config tests/e2e/playwright.config.js
```

Expected: FAIL on Backspace/paste/beforeinput because capture listeners call `preventDefault()`, and FAIL because no visible submission status exists.

- [ ] **Step 3: Add a Composer-local accessible status element**

Extend `ComposerAgentControl` and mount a non-intrusive live region beside the Agent picker:

Add `submissionStatus: HTMLElement` to `ComposerAgentControl`, then create it during mounting:

```ts
const submissionStatus = document.createElement("span");
submissionStatus.setAttribute("data-codexhost-submission-status", "");
submissionStatus.setAttribute("role", "status");
submissionStatus.setAttribute("aria-live", "polite");
submissionStatus.hidden = true;
submissionStatus.style.maxWidth = "260px";
submissionStatus.style.overflow = "hidden";
submissionStatus.style.textOverflow = "ellipsis";
submissionStatus.style.whiteSpace = "nowrap";
submissionStatus.style.color = "#d97757";
submissionStatus.style.font = "500 12px/1.3 system-ui, sans-serif";
```

Insert it before the send button, include it in the returned control, remove it in `disposeComposerAgentControl`, and append this parameter to `renderComposerAgentControl`:

```ts
submissionError: string | null = null,
```

Render it with:

```ts
control.submissionStatus.textContent = submissionError ?? "";
control.submissionStatus.hidden = submissionError === null;
```

- [ ] **Step 4: Split edit synchronization from submission enforcement**

Add `submissionError: null` when mounting. Replace the current capture handlers with this behavior:

```ts
const setSubmissionError = (mounted: MountedComposer, message: string): false => {
  mounted.submissionError = message;
  renderMounted(mounted);
  return false;
};

const onBeforeInput = (event: InputEvent): void => {
  const composer = composerForTarget(event.target);
  if (!composer) return;
  void applyComposerAgent(composer);
};

const onKeyDown = (event: KeyboardEvent): void => {
  const composer = composerForTarget(event.target);
  if (!composer) return;
  if (!isComposerSubmissionKey(event)) {
    if (isComposerInputIntent(event)) void applyComposerAgent(composer);
    return;
  }
  const mounted = mountedByComposer.get(composer);
  if (!mounted) return;
  if (!prepareComposer(composer)) {
    setSubmissionError(mounted, "Agent route is not ready; your draft was kept.");
    blockEvent(event);
    return;
  }
  mounted.submissionError = null;
  renderMounted(mounted);
  notifySubmission(composer, "enter");
};
```

Apply the same error helper to `onSubmit` and `onClick`. Refine `prepareComposer` messages at each failing branch: `Agent switch is still in progress`, `Thread ownership is unavailable`, `External Harness configuration is unavailable`, or `Agent route could not be applied`; successful preparation clears `submissionError` before notification. Pass `mounted.submissionError` from `renderMounted` to `renderComposerAgentControl`.

- [ ] **Step 5: Run the E2E and unit tests**

Run:

```bash
npx playwright test tests/e2e/renderer-codex-composer-input.spec.ts --config tests/e2e/playwright.config.js
npx vitest run --config tests/vitest.config.js packages/renderer-extension/test/renderer-binding-probe.test.ts packages/renderer-extension/test/renderer-composer-permissions.test.ts
```

Expected: all editing events are accepted and unprevented; Enter/submit/click are prevented; the draft remains; the live-region error is visible; focused unit tests PASS.

- [ ] **Step 6: Commit the input policy change**

```bash
git add packages/renderer-extension/src/renderer-composer-dom.ts packages/renderer-extension/src/renderer-binding-probe.ts packages/renderer-extension/test/renderer-binding-probe.test.ts tests/e2e/renderer-codex-composer-input.spec.ts
git commit -m "fix: 编辑事件放行并保护提交"
```

### Task 3: Document and verify the regression boundary

**Files:**
- Modify: `README.md`
- Modify: `docs/README.en.md`

**Interfaces:**
- Consumes: Task 1 strict marker boundary and Task 2 edit/submit policy.
- Produces: user-facing description of the fixed behavior and commands for reproducible verification.

- [ ] **Step 1: Add concise troubleshooting text in both READMEs**

Add the following Chinese text under the Renderer/Agent picker description in `README.md`:

```md
### 输入框边界

codexhost 只接管带有 `data-codex-composer-root` 的 Codex Work Composer。普通 Chat 不挂载 Agent 控件。即使外部 Harness 路由暂时不可用，输入、粘贴、剪切、删除、中文输入法和 `Shift+Enter` 仍保持可用；只有发送动作会被阻止，并在 Composer 中显示原因且保留草稿。
```

Add the equivalent English section to `docs/README.en.md`, retaining the exact DOM attribute and key names.

- [ ] **Step 2: Run the complete focused verification set**

Run:

```bash
npm run build:typescript
npm run build:renderer
npx vitest run --config tests/vitest.config.js packages/renderer-extension/test/renderer-binding-probe.test.ts
npx playwright test tests/e2e/renderer-chat-composer-isolation.spec.ts tests/e2e/renderer-codex-composer-input.spec.ts --config tests/e2e/playwright.config.js
npm run lint
npm run format:check
```

Expected: every command exits 0. Record any unrelated pre-existing repository-wide failure separately; do not classify it as an input-fix pass.

- [ ] **Step 3: Commit documentation and verification metadata**

```bash
git add README.md docs/README.en.md
git commit -m "docs: 说明 Composer 输入与提交边界"
```

- [ ] **Step 4: Run the macOS Composer acceptance**

Launch the current branch through `npm start` against the installed Codex Desktop. In ordinary Chat, verify no codexhost Agent control exists and test typing, Cmd+V, Cmd+X, Backspace, Delete, Chinese IME and Shift+Enter. In Work, repeat the same edit matrix, attach one file and edit before/after the attachment, then temporarily select an unavailable external Harness and verify edits continue while Enter is blocked with the draft-preserved status. Switch Work → Chat → Work and verify the control is removed and remounted exactly once.

Expected: all edit actions succeed, ordinary Chat is untouched, invalid external submission is blocked with visible status, and no draft content is lost. Record a missing local Codex Desktop prerequisite as `未完成`; automated E2E evidence does not replace this manual acceptance.
