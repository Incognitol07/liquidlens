import { sampleRoundedRect } from "./sdf";

/** A signed distance plus the outward unit normal at a sampled point. */
export interface ShapeSample {
  /** Signed distance to the boundary; negative inside, 0 on it, positive outside. */
  distance: number;
  /** Outward unit normal at the sampled point (zero components on symmetry axes). */
  normalX: number;
  normalY: number;
}

/**
 * A lens silhouette expressed as a signed-distance sampler. `sample` writes
 * the signed distance and outward unit normal at (x, y), measured from the
 * lens center in CSS px, into `out` and returns it. Both the refraction
 * and the specular rim are derived from this single function, so any shape
 * the sampler describes is rendered consistently.
 *
 * `key` must change whenever the shape or its parameters change: it is part
 * of the displacement/specular map cache key, so a stale key would reuse a
 * stale map. The built-in shapes derive it from their parameters; a custom
 * shape must supply a stable, distinct one (e.g. `` `blob:${seed}` ``).
 */
export interface LensShape {
  readonly key: string;
  /**
   * Whether the shape is mirror-symmetric across both the horizontal and
   * vertical center axes. When true (the default), the maps are sampled in
   * one quadrant and mirrored, four times cheaper to build. Set false for a
   * custom shape that is not doubly symmetric, so it is sampled in full and
   * rendered correctly. Both built-in shapes are symmetric.
   */
  readonly symmetric?: boolean;
  sample(
    x: number,
    y: number,
    halfWidth: number,
    halfHeight: number,
    out: ShapeSample,
  ): ShapeSample;
}

/**
 * A rounded rectangle with the given corner radius in px (the default
 * shape). A radius at or beyond the shorter half-extent yields a pill /
 * stadium, since the radius is clamped to what the box can hold.
 */
export function roundedRectShape(borderRadius: number): LensShape {
  return {
    key: `rrect:${borderRadius}`,
    sample(x, y, halfWidth, halfHeight, out) {
      return sampleRoundedRect(x, y, halfWidth, halfHeight, borderRadius, out);
    },
  };
}

/**
 * A superellipse (Lamé curve) `|x/a|^n + |y/b|^n = 1` inscribed in the lens
 * box. `exponent` 2 is an ellipse; higher values square the silhouette off
 * toward a rectangle, with ~4 reading as a squircle. Clamped to a minimum of
 * 2 (lower exponents pinch into a concave star, which is not a lens).
 *
 * The outward normal is the exact analytic gradient. The signed distance is
 * the radial distance to the boundary along the sample's own ray: exact on
 * the axes, a slight over-estimate elsewhere, which only narrows the rim
 * band a touch near the flattest part of the curve. Accuracy in the deep
 * interior does not matter: those pixels are past the rim and carry no
 * displacement.
 */
export function superellipseShape(exponent: number): LensShape {
  const n = Math.max(2, exponent);
  return {
    key: `superellipse:${n}`,
    sample(x, y, halfWidth, halfHeight, out) {
      const a = Math.max(halfWidth, 1e-6);
      const b = Math.max(halfHeight, 1e-6);
      const ux = Math.abs(x) / a;
      const uy = Math.abs(y) / b;
      const g = ux ** n + uy ** n; // 1 on the boundary

      // Outward normal from the analytic gradient of g. On a symmetry axis
      // the corresponding component vanishes (ux or uy is 0).
      const gx = ux > 0 ? (n * ux ** (n - 1) * Math.sign(x)) / a : 0;
      const gy = uy > 0 ? (n * uy ** (n - 1) * Math.sign(y)) / b : 0;
      const glen = Math.hypot(gx, gy) || 1;
      out.normalX = gx / glen;
      out.normalY = gy / glen;

      if (g <= 1e-9) {
        // At/near the center the ray is undefined; it is deep inside anyway.
        out.distance = -Math.min(a, b);
      } else {
        // Scaling the sample point by g^(-1/n) lands it on the boundary;
        // the gap along that ray is the (radial) signed distance.
        const scale = g ** (-1 / n);
        out.distance = Math.hypot(x, y) * (1 - scale);
      }
      return out;
    },
  };
}

/** Built-in shape names accepted wherever a `shape` option is taken. */
export type LensShapeName = "rect" | "pill" | "ellipse" | "squircle";

/**
 * Resolves a `shape` option into a concrete {@link LensShape}. A name maps to
 * its built-in sampler (`rect` and `pill` need the frame's corner radius); a
 * `LensShape` object is returned unchanged.
 */
export function resolveShape(
  shape: LensShapeName | LensShape | undefined,
  borderRadius: number,
): LensShape {
  if (shape == null || shape === "rect") {
    return roundedRectShape(borderRadius);
  }
  if (shape === "pill") {
    // The rounded-rect sampler clamps the radius to the shorter half-extent,
    // so an unbounded radius gives fully rounded ends at any size.
    return roundedRectShape(Number.POSITIVE_INFINITY);
  }
  if (shape === "ellipse") {
    return superellipseShape(2);
  }
  if (shape === "squircle") {
    return superellipseShape(4);
  }
  return shape;
}
