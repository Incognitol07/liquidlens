import { describe, expect, it } from "vitest";
import { specularIntensity } from "./specular";

describe("specularIntensity", () => {
  it("is brightest where the normal faces the light", () => {
    const lit = specularIntensity(1, 1, 1);
    const side = specularIntensity(0, 1, 1);
    expect(lit).toBeGreaterThan(side);
  });

  it("gives the counter-highlight half the main highlight's strength", () => {
    const ambient = specularIntensity(0, 1, 1);
    const main = specularIntensity(0.9, 1, 1) - ambient;
    const counter = specularIntensity(-0.9, 1, 1) - ambient;
    expect(counter).toBeCloseTo(main * 0.5, 10);
  });

  it("keeps the faint ambient ring at facing 0", () => {
    expect(specularIntensity(0, 1, 1)).toBeGreaterThan(0);
  });

  it("scales with mask and strength and clamps to 1", () => {
    expect(specularIntensity(1, 0, 1)).toBe(0);
    expect(specularIntensity(1, 1, 0)).toBe(0);
    expect(specularIntensity(1, 1, 1)).toBeLessThanOrEqual(1);
    const half = specularIntensity(0, 0.5, 1);
    const full = specularIntensity(0, 1, 1);
    expect(half).toBeCloseTo(full / 2, 10);
  });

  it("tightens the hot spot as sharpness rises", () => {
    // At a partly-facing normal, a higher exponent yields a dimmer highlight
    // (the lobe is narrower), while the dead-on highlight is unchanged.
    const soft = specularIntensity(0.6, 1, 1, 4);
    const sharp = specularIntensity(0.6, 1, 1, 20);
    expect(sharp).toBeLessThan(soft);
    expect(specularIntensity(1, 1, 1, 4)).toBeCloseTo(
      specularIntensity(1, 1, 1, 20),
      10,
    );
  });

  it("defaults to the same exponent as passing 10 explicitly", () => {
    expect(specularIntensity(0.6, 1, 1)).toBeCloseTo(specularIntensity(0.6, 1, 1, 10), 10);
  });
});
