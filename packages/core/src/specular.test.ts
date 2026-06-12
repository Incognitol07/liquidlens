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
});
