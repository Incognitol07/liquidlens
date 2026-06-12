/**
 * Signed distance from (x, y) to a rounded rectangle centered at the origin.
 * Negative inside the shape, zero on its boundary, positive outside.
 */
export function roundedRectSDF(
  x: number,
  y: number,
  halfWidth: number,
  halfHeight: number,
  radius: number,
): number {
  const r = Math.min(radius, halfWidth, halfHeight);
  const qx = Math.abs(x) - (halfWidth - r);
  const qy = Math.abs(y) - (halfHeight - r);
  const outsideX = Math.max(qx, 0);
  const outsideY = Math.max(qy, 0);
  const outsideDist = Math.hypot(outsideX, outsideY);
  const insideDist = Math.min(Math.max(qx, qy), 0);
  return outsideDist + insideDist - r;
}

/** A signed distance plus the outward unit normal at the sampled point. */
export interface RoundedRectSample {
  distance: number;
  normalX: number;
  normalY: number;
}

/**
 * Signed distance and outward unit normal at (x, y) for the same rounded
 * rectangle as `roundedRectSDF`, in a single evaluation. The normal is the
 * analytic SDF gradient; on the axes of symmetry, where the gradient is
 * ambiguous, the corresponding component is 0 (matching the numeric
 * central-difference gradient this replaces).
 *
 * Writes into `out` so per-pixel loops can reuse one scratch object.
 */
export function sampleRoundedRect(
  x: number,
  y: number,
  halfWidth: number,
  halfHeight: number,
  radius: number,
  out: RoundedRectSample,
): RoundedRectSample {
  const r = Math.min(radius, halfWidth, halfHeight);
  const qx = Math.abs(x) - (halfWidth - r);
  const qy = Math.abs(y) - (halfHeight - r);

  if (qx > 0 && qy > 0) {
    // Corner region: distance and normal come from the corner circle.
    const len = Math.sqrt(qx * qx + qy * qy) || 1;
    out.distance = len - r;
    out.normalX = (Math.sign(x) * qx) / len;
    out.normalY = (Math.sign(y) * qy) / len;
  } else if (qx > qy) {
    // Nearest feature is a vertical edge.
    out.distance = qx - r;
    out.normalX = Math.sign(x);
    out.normalY = 0;
  } else {
    // Nearest feature is a horizontal edge (or the tie, resolved to it).
    out.distance = qy - r;
    out.normalX = 0;
    out.normalY = Math.sign(y);
  }

  return out;
}
