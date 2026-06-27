import { describe, expect, it } from "vitest";
import { relativeLuminance } from "./luminance";

describe("relativeLuminance", () => {
  it("is 0 for black and 1 for white", () => {
    expect(relativeLuminance(0, 0, 0)).toBeCloseTo(0, 6);
    expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 6);
  });

  it("weights green above red above blue (per WCAG coefficients)", () => {
    const green = relativeLuminance(0, 255, 0);
    const red = relativeLuminance(255, 0, 0);
    const blue = relativeLuminance(0, 0, 255);
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
  });

  it("applies the sRGB transfer curve, not a linear average", () => {
    // Mid-grey 128 is well below 0.5 luminance because of gamma.
    const mid = relativeLuminance(128, 128, 128);
    expect(mid).toBeGreaterThan(0.18);
    expect(mid).toBeLessThan(0.25);
  });

  it("is monotonic in brightness", () => {
    const dark = relativeLuminance(40, 40, 40);
    const light = relativeLuminance(200, 200, 200);
    expect(light).toBeGreaterThan(dark);
  });
});
