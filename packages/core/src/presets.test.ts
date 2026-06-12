import { describe, expect, it } from "vitest";
import { presets } from "./presets";

describe("presets", () => {
  it("share the same shape so they are interchangeable", () => {
    const keys = Object.keys(presets.full).sort();
    expect(Object.keys(presets.lean).sort()).toEqual(keys);
    expect(Object.keys(presets.minimal).sort()).toEqual(keys);
  });

  it("lean disables the two expensive passes and nothing else", () => {
    expect(presets.lean.aberration).toBe(0);
    expect(presets.lean.blur).toBe(0);
    expect(presets.lean.specular).toBe(presets.full.specular);
    expect(presets.lean.saturation).toBe(presets.full.saturation);
  });

  it("minimal reduces to refraction only", () => {
    expect(presets.minimal.aberration).toBe(0);
    expect(presets.minimal.blur).toBe(0);
    expect(presets.minimal.saturation).toBe(1);
    expect(presets.minimal.specular).toBe(0);
  });

  it("keeps the lens geometry feel identical across presets", () => {
    for (const preset of [presets.lean, presets.minimal]) {
      expect(preset.depth).toBe(presets.full.depth);
      expect(preset.curvature).toBe(presets.full.curvature);
      expect(preset.splay).toBe(presets.full.splay);
    }
  });
});
