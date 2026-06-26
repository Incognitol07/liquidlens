import { roundedRectShape, type ShapeSample } from "./shape";
import { clamp, smoothstep } from "./math";
import type { LensParams, DisplacementField } from "./types";

/**
 * Computes a per-pixel displacement field for a glass lens of the given shape.
 *
 * The field models a curved rim around the edge of the lens: pixels near the
 * boundary are pulled along the edge normal toward the flat center (or pushed
 * radially from the lens center, depending on `splay`), with the magnitude
 * tapering to zero both toward the flat interior and out past the edge.
 *
 * `resolution` is the number of field samples per CSS pixel; pass the
 * devicePixelRatio to generate a map that stays sharp on high-DPI displays.
 * Lens geometry and displacement values are in CSS pixels regardless.
 *
 * A doubly-symmetric shape (every built-in) is computed for the top-left
 * quadrant only and mirrored with the appropriate sign flips; a shape that
 * sets `symmetric: false` is sampled in full.
 */
export function computeDisplacementField(
  params: LensParams,
  resolution = 1,
): DisplacementField {
  const { width, height, borderRadius, depth, curvature, splay } = params;
  const shape = params.shape ?? roundedRectShape(borderRadius);
  const halfW = width / 2;
  const halfH = height / 2;
  const rimWidth = Math.max(1, curvature * Math.min(halfW, halfH));
  const outerFalloff = Math.max(1, rimWidth * 0.5);

  const fieldWidth = Math.max(1, Math.round(width * resolution));
  const fieldHeight = Math.max(1, Math.round(height * resolution));
  const dx = new Float32Array(fieldWidth * fieldHeight);
  const dy = new Float32Array(fieldWidth * fieldHeight);

  // Sample at the field's own center so mirrored pixels sit at exactly
  // negated coordinates even when rounding made fieldWidth/resolution
  // differ slightly from the CSS width.
  const centerX = fieldWidth / 2;
  const centerY = fieldHeight / 2;

  const sample: ShapeSample = { distance: 0, normalX: 0, normalY: 0 };
  // Displacement vector at the last sampled point, written by computeVec.
  let vx = 0;
  let vy = 0;

  /** Fills vx/vy with the displacement at (x, y); returns false where it is zero. */
  const computeVec = (x: number, y: number): boolean => {
    shape.sample(x, y, halfW, halfH, sample);
    const d = sample.distance;

    let weight: number;
    if (d <= 0) {
      const t = clamp(-d / rimWidth, 0, 1);
      weight = 1 - smoothstep(0, 1, t);
    } else {
      weight = clamp(1 - d / outerFalloff, 0, 1);
    }

    if (weight <= 0) {
      return false;
    }

    // Edge-normal direction, pointing inward toward the lens center.
    const normalX = -sample.normalX;
    const normalY = -sample.normalY;

    // Radial direction, pointing away from the lens center.
    const rLen = Math.sqrt(x * x + y * y) || 1;
    const radialX = x / rLen;
    const radialY = y / rLen;

    const dirX = normalX * (1 - splay) + radialX * splay;
    const dirY = normalY * (1 - splay) + radialY * splay;
    const dirLen = Math.sqrt(dirX * dirX + dirY * dirY) || 1;

    vx = (dirX / dirLen) * depth * weight;
    vy = (dirY / dirLen) * depth * weight;
    return true;
  };

  if (shape.symmetric === false) {
    // Asymmetric shape: sample every pixel; no mirroring is valid.
    for (let py = 0; py < fieldHeight; py++) {
      const y = (py + 0.5 - centerY) / resolution;
      for (let px = 0; px < fieldWidth; px++) {
        const x = (px + 0.5 - centerX) / resolution;
        if (!computeVec(x, y)) {
          continue;
        }
        const i = py * fieldWidth + px;
        dx[i] = vx;
        dy[i] = vy;
      }
    }
    return { width: fieldWidth, height: fieldHeight, dx, dy };
  }

  const quadrantW = (fieldWidth + 1) >> 1;
  const quadrantH = (fieldHeight + 1) >> 1;

  for (let py = 0; py < quadrantH; py++) {
    const y = (py + 0.5 - centerY) / resolution;
    const my = fieldHeight - 1 - py;
    for (let px = 0; px < quadrantW; px++) {
      const x = (px + 0.5 - centerX) / resolution;
      if (!computeVec(x, y)) {
        continue;
      }

      // Mirror into the other three quadrants: x-reflection negates the
      // horizontal component, y-reflection the vertical one.
      const mx = fieldWidth - 1 - px;
      const i00 = py * fieldWidth + px;
      const i10 = py * fieldWidth + mx;
      const i01 = my * fieldWidth + px;
      const i11 = my * fieldWidth + mx;
      dx[i00] = vx;
      dy[i00] = vy;
      dx[i10] = -vx;
      dy[i10] = vy;
      dx[i01] = vx;
      dy[i01] = -vy;
      dx[i11] = -vx;
      dy[i11] = -vy;
    }
  }

  return { width: fieldWidth, height: fieldHeight, dx, dy };
}
