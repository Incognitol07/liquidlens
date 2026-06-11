import { roundedRectSDF } from "./sdf";
import { clamp, smoothstep } from "./math";
import type { LensParams, DisplacementField } from "./types";

/** Step used for the numeric gradient of the rounded-rect SDF, in pixels */
const GRADIENT_EPSILON = 0.5;

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
 */
export function computeDisplacementField(
  params: LensParams,
  resolution = 1,
): DisplacementField {
  const { width, height, borderRadius, depth, curvature, splay } = params;
  const halfW = width / 2;
  const halfH = height / 2;
  const rimWidth = Math.max(1, curvature * Math.min(halfW, halfH));
  const outerFalloff = Math.max(1, rimWidth * 0.5);

  const fieldWidth = Math.max(1, Math.round(width * resolution));
  const fieldHeight = Math.max(1, Math.round(height * resolution));
  const dx = new Float32Array(fieldWidth * fieldHeight);
  const dy = new Float32Array(fieldWidth * fieldHeight);

  for (let py = 0; py < fieldHeight; py++) {
    const y = (py + 0.5) / resolution - halfH;
    for (let px = 0; px < fieldWidth; px++) {
      const x = (px + 0.5) / resolution - halfW;
      const i = py * fieldWidth + px;

      const d = roundedRectSDF(x, y, halfW, halfH, borderRadius);

      let weight: number;
      if (d <= 0) {
        const t = clamp(-d / rimWidth, 0, 1);
        weight = 1 - smoothstep(0, 1, t);
      } else {
        weight = clamp(1 - d / outerFalloff, 0, 1);
      }

      if (weight <= 0) {
        continue;
      }

      // Numeric gradient of the SDF gives the outward surface normal.
      const gx =
        (roundedRectSDF(x + GRADIENT_EPSILON, y, halfW, halfH, borderRadius) -
          roundedRectSDF(x - GRADIENT_EPSILON, y, halfW, halfH, borderRadius)) /
        (2 * GRADIENT_EPSILON);
      const gy =
        (roundedRectSDF(x, y + GRADIENT_EPSILON, halfW, halfH, borderRadius) -
          roundedRectSDF(x, y - GRADIENT_EPSILON, halfW, halfH, borderRadius)) /
        (2 * GRADIENT_EPSILON);
      const gLen = Math.hypot(gx, gy) || 1;

      // Edge-normal direction, pointing inward toward the lens center.
      const normalX = -gx / gLen;
      const normalY = -gy / gLen;

      // Radial direction, pointing away from the lens center.
      const rLen = Math.hypot(x, y) || 1;
      const radialX = x / rLen;
      const radialY = y / rLen;

      let dirX = normalX * (1 - splay) + radialX * splay;
      let dirY = normalY * (1 - splay) + radialY * splay;
      const dirLen = Math.hypot(dirX, dirY) || 1;
      dirX /= dirLen;
      dirY /= dirLen;

      const magnitude = depth * weight;
      dx[i] = dirX * magnitude;
      dy[i] = dirY * magnitude;
    }
  }

  return { width: fieldWidth, height: fieldHeight, dx, dy };
}
