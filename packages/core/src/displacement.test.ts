import { describe, expect, it } from "vitest";
import { computeDisplacementField } from "./displacement";
import { sampleRoundedRect } from "./sdf";
import { superellipseShape, type LensShape } from "./shape";

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
    const { width } = field;
    const py = 10;
    const left = 5;
    const right = width - 1 - left;
    const iLeft = py * width + left;
    const iRight = py * width + right;
    expect(field.dx[iRight]).toBeCloseTo(-field.dx[iLeft], 4);
    expect(field.dy[iRight]).toBeCloseTo(field.dy[iLeft], 4);
  });

  it("is mirror-symmetric across the horizontal center line", () => {
    const field = computeDisplacementField(baseParams);
    const { width, height } = field;
    const px = 5;
    const top = 10;
    const bottom = height - 1 - top;
    const iTop = top * width + px;
    const iBottom = bottom * width + px;
    expect(field.dx[iBottom]).toBeCloseTo(field.dx[iTop], 4);
    expect(field.dy[iBottom]).toBeCloseTo(-field.dy[iTop], 4);
  });

  it("points inward at the edge midpoints with no splay", () => {
    const field = computeDisplacementField(baseParams);
    const { width, height } = field;
    const midY = Math.floor(height / 2);
    const midX = Math.floor(width / 2);
    const leftEdge = midY * width + 1;
    const topEdge = 1 * width + midX;
    expect(field.dx[leftEdge]).toBeGreaterThan(0);
    expect(field.dy[topEdge]).toBeGreaterThan(0);
  });

  it("follows a non-rectangular shape (ellipse) and stays doubly symmetric", () => {
    const field = computeDisplacementField({
      ...baseParams,
      shape: superellipseShape(2),
    });
    // Center still flat.
    const center = 30 * field.width + 50;
    expect(Math.hypot(field.dx[center], field.dy[center])).toBeCloseTo(0, 1);
    // Symmetric across the vertical center line, like the built-in rect.
    const py = 10;
    const left = 6;
    const right = field.width - 1 - left;
    expect(field.dx[py * field.width + right]).toBeCloseTo(
      -field.dx[py * field.width + left],
      4,
    );
  });

  it("samples only one quadrant for a symmetric shape but every pixel for an asymmetric one", () => {
    const count = (symmetric: boolean): number => {
      let calls = 0;
      const probe: LensShape = {
        key: `probe:${symmetric}`,
        symmetric,
        sample: (_x, _y, _hw, _hh, out) => {
          calls += 1;
          out.distance = 1; // outside everywhere → no displacement written
          out.normalX = 0;
          out.normalY = 0;
          return out;
        },
      };
      computeDisplacementField({ ...baseParams, shape: probe });
      return calls;
    };
    // width 100, height 60 → quadrant is 50 x 30 = 1500; full is 6000.
    expect(count(true)).toBe(1500);
    expect(count(false)).toBe(6000);
  });

  it("renders an asymmetric shape without forcing it symmetric", () => {
    // A rounded rect whose center is shifted right: its left rim sits inside
    // the frame while the right rim falls outside it, so a correct field is
    // not mirror-symmetric. Sampling the same shape under the symmetric fast
    // path (which mirrors one quadrant) must give a different — wrong — field.
    const sample = (x: number, y: number, hw: number, hh: number, out: any) =>
      sampleRoundedRect(x - 15, y, hw, hh, 8, out);
    const correct = computeDisplacementField({
      ...baseParams,
      shape: { key: "shifted", symmetric: false, sample } as LensShape,
    });
    const mirrored = computeDisplacementField({
      ...baseParams,
      shape: { key: "shifted-sym", symmetric: true, sample } as LensShape,
    });

    let maxDiff = 0;
    for (let i = 0; i < correct.dx.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(correct.dx[i] - mirrored.dx[i]));
    }
    expect(maxDiff).toBeGreaterThan(0.5);
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
