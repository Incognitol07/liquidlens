import { describe, expect, it } from "vitest";
import { accessibleEffect, CONTRAST_DEPTH_SCALE, FROST_BLUR } from "./a11y";

const base = { depth: 24, aberration: 0.05, blur: 0.2, saturation: 1.15, specular: 1 };

describe("accessibleEffect", () => {
  it("passes the effect through unchanged when no treatment is active", () => {
    expect(
      accessibleEffect(base, { reducedTransparency: false, increasedContrast: false }),
    ).toEqual(base);
  });

  it("does not mutate the input", () => {
    const input = { ...base };
    accessibleEffect(input, { reducedTransparency: true, increasedContrast: true });
    expect(input).toEqual(base);
  });

  describe("reduced transparency", () => {
    const out = accessibleEffect(base, {
      reducedTransparency: true,
      increasedContrast: false,
    });

    it("frosts: floors the blur and drops aberration", () => {
      expect(out.blur).toBe(FROST_BLUR);
      expect(out.aberration).toBe(0);
    });

    it("never lowers an already-stronger blur", () => {
      const strong = accessibleEffect(
        { ...base, blur: 10 },
        { reducedTransparency: true, increasedContrast: false },
      );
      expect(strong.blur).toBe(10);
    });

    it("leaves depth and specular alone", () => {
      expect(out.depth).toBe(base.depth);
      expect(out.specular).toBe(base.specular);
    });
  });

  describe("increased contrast", () => {
    const out = accessibleEffect(base, {
      reducedTransparency: false,
      increasedContrast: true,
    });

    it("flattens the refraction", () => {
      expect(out.depth).toBeCloseTo(base.depth * CONTRAST_DEPTH_SCALE, 10);
    });

    it("removes shimmer and vibrancy noise, drops aberration", () => {
      expect(out.specular).toBe(0);
      expect(out.saturation).toBe(1);
      expect(out.aberration).toBe(0);
    });
  });

  it("composes both treatments", () => {
    const out = accessibleEffect(base, {
      reducedTransparency: true,
      increasedContrast: true,
    });
    expect(out.blur).toBe(FROST_BLUR);
    expect(out.depth).toBeCloseTo(base.depth * CONTRAST_DEPTH_SCALE, 10);
    expect(out.specular).toBe(0);
    expect(out.aberration).toBe(0);
  });
});
