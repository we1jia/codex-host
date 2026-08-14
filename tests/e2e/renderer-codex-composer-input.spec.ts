import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererBindingProbe } from "./packages/renderer-extension/src/renderer-binding-probe.ts";
      installRendererBindingProbe({ enabledAgents: ["codex", "pi"], defaultAgent: "pi" });
    `,
    resolveDir: repositoryRoot,
    sourcefile: "renderer-codex-composer-input-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl" },
  write: false,
});

const generatedBundle = outputFiles[0]?.text;
if (typeof generatedBundle !== "string") {
  throw new Error("Renderer Codex Composer input E2E bundle was not generated");
}
const browserBundle = generatedBundle;

async function installUnavailablePiComposer(page: Page): Promise<void> {
  await page.setContent(`
    <!doctype html>
    <body>
      <form data-codex-composer-root>
        <div contenteditable="true" role="textbox">draft</div>
        <button type="submit" aria-label="Send">Send</button>
      </form>
    </body>
  `);
  await page.addScriptTag({ content: browserBundle });
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(1);
}

test("Codex Composer editing stays available when the external route cannot be applied", async ({
  page,
}) => {
  await installUnavailablePiComposer(page);

  const results = await page.locator('[role="textbox"]').evaluate((editor) => {
    const dispatch = (name: string, event: Event) => ({
      name,
      accepted: editor.dispatchEvent(event),
      prevented: event.defaultPrevented,
    });
    return [
      dispatch(
        "character",
        new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }),
      ),
      dispatch(
        "ime",
        new KeyboardEvent("keydown", {
          key: "Process",
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
      dispatch(
        "backspace",
        new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
      ),
      dispatch(
        "delete",
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
      ),
      dispatch(
        "paste",
        new KeyboardEvent("keydown", {
          key: "v",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
      dispatch(
        "cut",
        new KeyboardEvent("keydown", {
          key: "x",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
      dispatch(
        "copy",
        new KeyboardEvent("keydown", {
          key: "c",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
      dispatch(
        "soft-newline",
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
      dispatch(
        "beforeinput-paste",
        new InputEvent("beforeinput", {
          inputType: "insertFromPaste",
          bubbles: true,
          cancelable: true,
        }),
      ),
      dispatch(
        "beforeinput-delete",
        new InputEvent("beforeinput", {
          inputType: "deleteContentBackward",
          bubbles: true,
          cancelable: true,
        }),
      ),
    ];
  });

  expect(results).toEqual(
    [
      "character",
      "ime",
      "backspace",
      "delete",
      "paste",
      "cut",
      "copy",
      "soft-newline",
      "beforeinput-paste",
      "beforeinput-delete",
    ].map((name) => ({ name, accepted: true, prevented: false })),
  );
});

test("Codex Composer blocks an unavailable route only at submission and preserves the draft", async ({
  page,
}) => {
  await installUnavailablePiComposer(page);

  const results = await page.locator("[data-codex-composer-root]").evaluate((composer) => {
    const editor = composer.querySelector('[role="textbox"]');
    const button = composer.querySelector("button[type=submit]");
    if (!editor || !button) throw new Error("Synthetic Composer controls are unavailable");
    const dispatch = (target: Element, event: Event) => ({
      accepted: target.dispatchEvent(event),
      prevented: event.defaultPrevented,
    });
    return {
      enter: dispatch(
        editor,
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
      submit: dispatch(composer, new SubmitEvent("submit", { bubbles: true, cancelable: true })),
      click: dispatch(button, new MouseEvent("click", { bubbles: true, cancelable: true })),
      draft: editor.textContent,
    };
  });

  expect(results).toEqual({
    enter: { accepted: false, prevented: true },
    submit: { accepted: false, prevented: true },
    click: { accepted: false, prevented: true },
    draft: "draft",
  });
  await expect(page.locator("[data-codexhost-submission-status]")).toBeVisible();
  await expect(page.locator("[data-codexhost-submission-status]")).toContainText("draft was kept");
});
