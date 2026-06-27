import { describe, expect, it } from "vitest";
import { adaptiveShadow, inkColor, adaptTint } from "./adaptive";

describe("adaptiveShadow", () => {
  it("casts a denser shadow over brighter backdrops", () => {
    const dark = adaptiveShadow(0);
    const bright = adaptiveShadow(1);
    const alpha = (s: string): number =>
      Number(/rgba\(0, 0, 0, ([0-9.]+)\)[^,]*$/.exec(s)?.[1] ?? 0);
    expect(alpha(bright)).toBeGreaterThan(alpha(dark));
  });

  it("stays a valid two-layer box-shadow across the range", () => {
    for (const l of [0, 0.25, 0.5, 0.75, 1]) {
      const shadow = adaptiveShadow(l);
      expect(shadow.split("rgba").length - 1).toBe(2);
    }
  });

  it("clamps out-of-range luminance", () => {
    expect(adaptiveShadow(-1)).toBe(adaptiveShadow(0));
    expect(adaptiveShadow(2)).toBe(adaptiveShadow(1));
  });
});

describe("inkColor", () => {
  it("uses light ink over dark backdrops and dark ink over light ones", () => {
    expect(inkColor(0.05).dark).toBe(false);
    expect(inkColor(0.95).dark).toBe(true);
  });

  it("holds its previous decision inside the hysteresis band", () => {
    // Mid-grey 0.5 sits between FLIP_LOW (0.45) and FLIP_HIGH (0.55): the
    // decision should stick to whatever it was, not flip.
    expect(inkColor(0.5, true).dark).toBe(true);
    expect(inkColor(0.5, false).dark).toBe(false);
  });

  it("flips only once the backdrop crosses the band", () => {
    // Coming from dark ink, a backdrop must drop below FLIP_LOW to go light.
    expect(inkColor(0.46, true).dark).toBe(true);
    expect(inkColor(0.44, true).dark).toBe(false);
    // Coming from light ink, it must rise above FLIP_HIGH to go dark.
    expect(inkColor(0.54, false).dark).toBe(false);
    expect(inkColor(0.56, false).dark).toBe(true);
  });
});

describe("adaptTint", () => {
  it("lightens the tint over dark content and darkens it over bright", () => {
    const base = "#4aa3ff";
    const overDark = adaptTint(base, 0);
    const overBright = adaptTint(base, 1);
    // Compare green channel as a brightness proxy; both keep the blue hue.
    const g = (hex: string): number => Number.parseInt(hex.slice(3, 5), 16);
    expect(g(overDark)).toBeGreaterThan(g(overBright));
  });

  it("leaves the tint near its base at mid luminance", () => {
    const base = "#4aa3ff";
    expect(adaptTint(base, 0.5)).toBe(base);
  });

  it("returns non-hex colours unchanged", () => {
    expect(adaptTint("rgb(0,0,0)", 0)).toBe("rgb(0,0,0)");
    expect(adaptTint("dodgerblue", 1)).toBe("dodgerblue");
  });

  it("keeps the hue while shifting lightness (stays recognisably blue)", () => {
    const adapted = adaptTint("#4aa3ff", 0.1);
    const r = Number.parseInt(adapted.slice(1, 3), 16);
    const b = Number.parseInt(adapted.slice(5, 7), 16);
    expect(b).toBeGreaterThan(r); // still blue-dominant
  });
});
