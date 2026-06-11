import { describe, expect, it } from "vitest";
import { computeDisplacementField } from "./displacement";

const baseParams = {
  width: 100,
  height: 60,
  borderRadius: 16,
  depth: 12,
  curvature: 0.4,
  splay: 0,
};

describe("computeDisplacementField", () => {
  it("produces zero displacement at the lens center", () => {
    const field = computeDisplacementField(baseParams);
    const i = 30 * field.width + 50; // center pixel
    expect(field.dx[i]).toBeCloseTo(0, 1);
    expect(field.dy[i]).toBeCloseTo(0, 1);
  });

  it("produces nonzero displacement near the edge", () => {
    const field = computeDisplacementField(baseParams);
    const i = 30 * field.width + 1; // near left edge, vertically centered
    expect(Math.hypot(field.dx[i], field.dy[i])).toBeGreaterThan(0);
  });

  it("clamps magnitude to depth", () => {
    const field = computeDisplacementField(baseParams);
    for (let i = 0; i < field.dx.length; i++) {
      const mag = Math.hypot(field.dx[i], field.dy[i]);
      expect(mag).toBeLessThanOrEqual(baseParams.depth + 1e-6);
    }
  });

  it("is mirror-symmetric across the vertical center line", () => {
    const field = computeDisplacementField(baseParams);
    const { width, height } = field;
    const py = 10;
    const left = 5;
    const right = width - 1 - left;
    const iLeft = py * width + left;
    const iRight = py * width + right;
    expect(field.dx[iRight]).toBeCloseTo(-field.dx[iLeft], 4);
    expect(field.dy[iRight]).toBeCloseTo(field.dy[iLeft], 4);
  });

  it("scales sample count with resolution while keeping values in CSS px", () => {
    const field1x = computeDisplacementField(baseParams);
    const field2x = computeDisplacementField(baseParams, 2);

    expect(field2x.width).toBe(baseParams.width * 2);
    expect(field2x.height).toBe(baseParams.height * 2);

    // The same physical location (near the left edge, vertically centered)
    // carries roughly the same displacement at both resolutions.
    const i1 = 30 * field1x.width + 2;
    const i2 = 60 * field2x.width + 4;
    const mag1 = Math.hypot(field1x.dx[i1], field1x.dy[i1]);
    const mag2 = Math.hypot(field2x.dx[i2], field2x.dy[i2]);
    expect(mag2).toBeGreaterThan(0);
    expect(mag2).toBeCloseTo(mag1, 0);
  });
});
