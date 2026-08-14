import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererBindingProbe } from "./packages/renderer-extension/src/renderer-binding-probe.ts";

      const composer = document.createElement("div");
      composer.setAttribute("data-codex-composer-root", "true");
      const editor = document.createElement("div");
      editor.setAttribute("data-codex-composer", "true");
      editor.setAttribute("contenteditable", "true");
      editor.setAttribute("role", "textbox");
      editor.textContent = "run with antigravity";
      const modelState = {
        atom: {},
        get: () => ({ isManuallyChanged: false, modelSettings: null, serviceTier: null }),
        set: () => undefined,
      };
      Object.defineProperty(editor, "__reactFiber$antigravity", {
        configurable: true,
        value: {
          updateQueue: {
            memoCache: {
              data: [
                [undefined, modelState, modelState],
                [{}, {}, null, modelState],
              ],
            },
          },
          return: null,
        },
      });
      const send = document.createElement("button");
      send.type = "submit";
      send.textContent = "Send";
      composer.append(editor, send);
      document.body.append(composer);

      const calls = [];
      const submissions = [];
      Reflect.set(globalThis, "antigravityApplyCalls", calls);
      Reflect.set(globalThis, "antigravitySubmissions", submissions);
      window.addEventListener("codexhost:renderer-submission", (event) => {
        submissions.push(event.detail);
      });
      window.__codexhostDraftPrewarmPolicyV1 = {
        state: "ready",
        clear: async () => undefined,
      };

      const unavailable = async () => {
        throw new Error("unused fixed control");
      };
      const binding = installRendererBindingProbe({
        enabledAgents: ["codex", "antigravity"],
        defaultAgent: "antigravity",
      });
      binding.setAdapter(
        { state: "ready", reason: "ready", modelUpdates: 0, hook: "model-state" },
        undefined,
        (agent, model, thinking, permission) => {
          calls.push({
            agent,
            model: model ?? null,
            thinking: thinking ?? null,
            permission: permission ?? null,
          });
          return true;
        },
        {
          inspectHarness: async () => ({
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
          }),
          inspectThread: unavailable,
          forkThread: unavailable,
          inspectThreadUsage: unavailable,
          subscribeThreadUsage: () => {
            throw new Error("Usage notification transport is not ready");
          },
          listThreadOwnership: unavailable,
          selectThreadModel: unavailable,
          selectThreadThinking: unavailable,
          selectThreadPermissionMode: unavailable,
          checkUpdate: unavailable,
          startUpdate: unavailable,
          readUpdateStatus: unavailable,
        },
      );
    `,
    resolveDir: repositoryRoot,
    sourcefile: "renderer-antigravity-composer-e2e-entry.ts",
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
if (!browserBundle) throw new Error("Antigravity Composer E2E bundle was not generated");

test("Antigravity can submit without a Renderer Model selection", async ({ page }) => {
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: browserBundle });

  const agent = page.locator('[data-codexhost-agent-control] > button[aria-haspopup="menu"]');
  const model = page.locator("[data-codexhost-model-control]");
  const send = page.getByRole("button", { name: "Send" });
  await expect(agent).toHaveAttribute("aria-label", "Select Agent, current Antigravity");
  await expect(model).toBeHidden();
  await expect(send).toBeEnabled();

  await send.click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(globalThis, "antigravitySubmissions")?.length ?? 0))
    .toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const calls = Reflect.get(globalThis, "antigravityApplyCalls") ?? [];
        return calls.at(-1);
      }),
    )
    .toEqual({ agent: "antigravity", model: null, thinking: null, permission: null });
  await expect(agent).toHaveAttribute("aria-label", "Agent: Antigravity");
});
