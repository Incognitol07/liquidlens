import { sampleRoundedRect, type RoundedRectSample } from "./sdf";
import { clamp, smoothstep } from "./math";
import type { LensParams } from "./types";

/** Tightness of the directional highlight; higher means a narrower hot spot */
const SPECULAR_EXPONENT = 10;
/** Relative strength of the counter-highlight on the edge facing away */
const COUNTER_LIGHT = 0.5;
/** Relative strength of the faint all-around fresnel ring */
const AMBIENT_RING = 0.22;

export interface SpecularOptions {
  /** Light direction in degrees: 0 lights the top edge, 90 the right edge */
  lightAngle: number;
  /** 0..1 overall highlight strength */
  strength: number;
}

/**
 * Highlight alpha for one rim sample: `facing` is the dot product of the
 * outward surface normal with the light direction, `mask` the rim band
 * weight. Shared by the single-lens and scene renderers so the two looks
 * never drift apart.
 */
export function specularIntensity(facing: number, mask: number, strength: number): number {
  // facing > 0 and facing < 0 are mutually exclusive, so only one of the
  // main and counter highlights is ever nonzero; compute just that one.
  const lit =
    facing >= 0
      ? facing ** SPECULAR_EXPONENT
      : (-facing) ** SPECULAR_EXPONENT * COUNTER_LIGHT;
  return clamp(mask * strength * (AMBIENT_RING + lit), 0, 1);
}

/**
 * Renders the specular rim light for a lens onto a canvas: white pixels
 * whose alpha encodes highlight intensity, meant to be screen-blended over
 * the refracted output.
 *
 * The highlight hugs the inside of the lens edge, derived from the same SDF
 * as the refraction: brightest where the outward surface normal faces the
 * light, with a weaker counter-highlight on the opposite edge and a faint
 * ring everywhere. Because it is computed rather than CSS box-shadow, it
 * follows any shape the SDF describes.
 *
 * `resolution` is samples per CSS pixel, as in `computeDisplacementField`.
 *
 * The mask and normal are symmetric across both axes, so they are computed
 * for the top-left quadrant only; the light-dependent part is re-evaluated
 * per mirrored pixel with the normal's components sign-flipped.
 */
export function renderSpecularToCanvas(
  canvas: HTMLCanvasElement,
  params: LensParams,
  options: SpecularOptions,
  resolution = 1,
): void {
  const { width, height, borderRadius, curvature } = params;
  const { lightAngle, strength } = options;
  const halfW = width / 2;
  const halfH = height / 2;

  // The highlight band is narrower than the refraction rim, so it reads as
  // the bright bevel right at the edge of the glass.
  const rimWidth = Math.max(1, curvature * Math.min(halfW, halfH));
  const band = Math.max(1.5, rimWidth * 0.3);

  const radians = (lightAngle * Math.PI) / 180;
  const lightX = Math.sin(radians);
  const lightY = -Math.cos(radians);

  const outWidth = Math.max(1, Math.round(width * resolution));
  const outHeight = Math.max(1, Math.round(height * resolution));
  canvas.width = outWidth;
  canvas.height = outHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D canvas context is not available");
  }

  const image = ctx.createImageData(outWidth, outHeight);
  const data = image.data;

  // Sample at the canvas's own center so mirrored pixels sit at exactly
  // negated coordinates (see computeDisplacementField).
  const centerX = outWidth / 2;
  const centerY = outHeight / 2;
  const quadrantW = (outWidth + 1) >> 1;
  const quadrantH = (outHeight + 1) >> 1;

  const sample: RoundedRectSample = { distance: 0, normalX: 0, normalY: 0 };

  const write = (i: number, alpha: number): void => {
    const o = i * 4;
    data[o] = 255;
    data[o + 1] = 255;
    data[o + 2] = 255;
    data[o + 3] = Math.round(alpha * 255);
  };

  for (let py = 0; py < quadrantH; py++) {
    const y = (py + 0.5 - centerY) / resolution;
    const my = outHeight - 1 - py;
    for (let px = 0; px < quadrantW; px++) {
      const x = (px + 0.5 - centerX) / resolution;

      sampleRoundedRect(x, y, halfW, halfH, borderRadius, sample);
      const d = sample.distance;
      if (d > 0) {
        continue; // outside the lens; the frame clips this away regardless
      }

      const t = clamp(-d / band, 0, 1);
      const mask = 1 - smoothstep(0, 1, t);
      if (mask <= 0) {
        continue;
      }

      const fx = sample.normalX * lightX;
      const fy = sample.normalY * lightY;
      const mx = outWidth - 1 - px;

      write(py * outWidth + px, specularIntensity(fx + fy, mask, strength));
      write(py * outWidth + mx, specularIntensity(-fx + fy, mask, strength));
      write(my * outWidth + px, specularIntensity(fx - fy, mask, strength));
      write(my * outWidth + mx, specularIntensity(-fx - fy, mask, strength));
    }
  }

  ctx.putImageData(image, 0, 0);
}
