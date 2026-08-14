import { describe, expect, it } from "vitest";

import { createRendererAgentIcon, RENDERER_AGENT_LABELS } from "../src/renderer-agent-icon.js";

describe("Renderer Agent icons", () => {
  it("labels Antigravity in the Agent picker", () => {
    expect(RENDERER_AGENT_LABELS.antigravity).toBe("Antigravity");
  });

  it("renders Grok with the bundled image asset", () => {
    const image = {
      src: "",
      alt: "unset",
      draggable: true,
      style: {},
    } as unknown as HTMLImageElement;
    const ownerDocument = {
      createElement(tagName: string) {
        expect(tagName).toBe("img");
        return image;
      },
    } as unknown as Document;

    expect(createRendererAgentIcon("grok", 16, ownerDocument)).toBe(image);
    expect(image.src).toMatch(/grok-agent\.png$/);
    expect(image.alt).toBe("");
    expect(image.draggable).toBe(false);
    expect(image.style.width).toBe("16px");
    expect(image.style.height).toBe("16px");
    expect(image.style.borderRadius).toBe("22.37%");
  });
});
