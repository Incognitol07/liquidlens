import { describe, expect, it } from "vitest";
import { roundedRectSDF, sampleRoundedRect, type RoundedRectSample } from "./sdf";

describe("roundedRectSDF", () => {
  it("is negative at the center", () => {
    expect(roundedRectSDF(0, 0, 50, 30, 8)).toBeLessThan(0);
  });

  it("is approximately zero on a flat edge", () => {
    expect(roundedRectSDF(50, 0, 50, 30, 8)).toBeCloseTo(0, 5);
  });

  it("is positive outside the shape", () => {
    expect(roundedRectSDF(60, 0, 50, 30, 8)).toBeGreaterThan(0);
  });

  it("is symmetric across both axes", () => {
    const a = roundedRectSDF(20, 10, 50, 30, 8);
    expect(roundedRectSDF(-20, 10, 50, 30, 8)).toBeCloseTo(a, 10);
    expect(roundedRectSDF(20, -10, 50, 30, 8)).toBeCloseTo(a, 10);
    expect(roundedRectSDF(-20, -10, 50, 30, 8)).toBeCloseTo(a, 10);
  });
});

describe("sampleRoundedRect", () => {
  const scratch = (): RoundedRectSample => ({ distance: 0, normalX: 0, normalY: 0 });

  // Points covering every branch: edge regions, corner regions (inside and
  // outside), and both signs of each axis. None sit on a symmetry axis or
  // an equidistant diagonal, where the gradient is legitimately ambiguous.
  const points: Array<[number, number]> = [
    [30, 5], // interior, nearest the right edge
    [10, 25], // interior, nearest the bottom edge
    [-30, 5], // left edge
    [10, -25], // top edge
    [46, 27], // inside the corner circle
    [55, 35], // outside, past the corner
    [60, 5], // outside, past the right edge
    [-47, -28], // opposite corner
  ];

  it("matches roundedRectSDF exactly", () => {
    for (const [x, y] of points) {
      const sample = sampleRoundedRect(x, y, 50, 30, 8, scratch());
      expect(sample.distance).toBeCloseTo(roundedRectSDF(x, y, 50, 30, 8), 10);
    }
  });

  it("matches the numeric SDF gradient", () => {
    const eps = 1e-4;
    for (const [x, y] of points) {
      const sample = sampleRoundedRect(x, y, 50, 30, 8, scratch());
      const gx =
        (roundedRectSDF(x + eps, y, 50, 30, 8) - roundedRectSDF(x - eps, y, 50, 30, 8)) /
        (2 * eps);
      const gy =
        (roundedRectSDF(x, y + eps, 50, 30, 8) - roundedRectSDF(x, y - eps, 50, 30, 8)) /
        (2 * eps);
      expect(sample.normalX).toBeCloseTo(gx, 5);
      expect(sample.normalY).toBeCloseTo(gy, 5);
    }
  });

  it("returns a unit normal", () => {
    for (const [x, y] of points) {
      const sample = sampleRoundedRect(x, y, 50, 30, 8, scratch());
      expect(Math.hypot(sample.normalX, sample.normalY)).toBeCloseTo(1, 10);
    }
  });

  it("zeroes the ambiguous normal component on the symmetry axes", () => {
    expect(sampleRoundedRect(0, 25, 50, 30, 8, scratch()).normalX).toBe(0);
    expect(sampleRoundedRect(45, 0, 50, 30, 8, scratch()).normalY).toBe(0);
  });
});
