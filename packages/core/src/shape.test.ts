import { describe, expect, it } from "vitest";
import {
  resolveShape,
  roundedRectShape,
  superellipseShape,
  type LensShape,
  type ShapeSample,
} from "./shape";
import { roundedRectSDF } from "./sdf";

const scratch = (): ShapeSample => ({ distance: 0, normalX: 0, normalY: 0 });

describe("roundedRectShape", () => {
  it("matches roundedRectSDF and carries the radius in its key", () => {
    const shape = roundedRectShape(8);
    expect(shape.key).toBe("rrect:8");
    expect(shape.sample(30, 5, 50, 30, scratch()).distance).toBeCloseTo(
      roundedRectSDF(30, 5, 50, 30, 8),
      10,
    );
  });
});

describe("superellipseShape", () => {
  it("clamps the exponent to at least 2 and keys on the clamped value", () => {
    expect(superellipseShape(2).key).toBe("superellipse:2");
    expect(superellipseShape(0.5).key).toBe("superellipse:2");
    expect(superellipseShape(4).key).toBe("superellipse:4");
  });

  for (const exponent of [2, 4]) {
    describe(`exponent ${exponent}`, () => {
      const shape = superellipseShape(exponent);

      it("is negative at the center, positive well outside", () => {
        expect(shape.sample(0, 0, 50, 30, scratch()).distance).toBeLessThan(0);
        expect(shape.sample(80, 0, 50, 30, scratch()).distance).toBeGreaterThan(0);
      });

      it("is ~zero on the axis-crossing boundary points", () => {
        expect(shape.sample(50, 0, 50, 30, scratch()).distance).toBeCloseTo(0, 6);
        expect(shape.sample(0, 30, 50, 30, scratch()).distance).toBeCloseTo(0, 6);
      });

      it("gives the exact axial distance outside (ray is the normal there)", () => {
        expect(shape.sample(60, 0, 50, 30, scratch()).distance).toBeCloseTo(10, 6);
      });

      it("returns a unit outward normal off the axes", () => {
        const s = shape.sample(20, 12, 50, 30, scratch());
        expect(Math.hypot(s.normalX, s.normalY)).toBeCloseTo(1, 6);
        expect(s.normalX).toBeGreaterThan(0);
        expect(s.normalY).toBeGreaterThan(0);
      });

      it("zeroes the ambiguous normal component on the symmetry axes", () => {
        expect(shape.sample(0, 20, 50, 30, scratch()).normalX).toBe(0);
        expect(shape.sample(20, 0, 50, 30, scratch()).normalY).toBe(0);
      });
    });
  }
});

describe("resolveShape", () => {
  it("defaults to a rounded rect of the given radius", () => {
    expect(resolveShape(undefined, 12).key).toBe("rrect:12");
    expect(resolveShape("rect", 12).key).toBe("rrect:12");
  });

  it("maps pill to an unbounded-radius rounded rect", () => {
    expect(resolveShape("pill", 12).key).toBe(`rrect:${Number.POSITIVE_INFINITY}`);
  });

  it("maps ellipse and squircle to superellipses", () => {
    expect(resolveShape("ellipse", 12).key).toBe("superellipse:2");
    expect(resolveShape("squircle", 12).key).toBe("superellipse:4");
  });

  it("passes a custom shape through unchanged", () => {
    const custom: LensShape = {
      key: "blob",
      sample: (x, y, _hw, _hh, out) => {
        out.distance = 0;
        out.normalX = 0;
        out.normalY = 0;
        return out;
      },
    };
    expect(resolveShape(custom, 12)).toBe(custom);
  });
});
