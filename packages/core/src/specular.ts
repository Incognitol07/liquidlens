import { roundedRectShape, type ShapeSample } from "./shape";
import { clamp, smoothstep } from "./math";
import type { LensParams } from "./types";

/** Default tightness of the directional highlight; higher is a narrower hot spot. */
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
  /**
   * CSS color of the highlight (default white). Screen-blended over the
   * refracted content, so it brightens toward this color. A warm white
   * reads as sunlight, a cool tint as a cold rim light.
   */
  color?: string;
  /**
   * Tightness of the directional hot spot (default 10). Higher concentrates
   * the highlight into a smaller, glossier spot; lower spreads it into a
   * softer sheen.
   */
  sharpness?: number;
}

/**
 * Highlight alpha for one rim sample: `facing` is the dot product of the
 * outward surface normal with the light direction, `mask` the rim band
 * weight, `sharpness` the directional exponent. Shared by every code path so
 * the look never drifts.
 */
export function specularIntensity(
  facing: number,
  mask: number,
  strength: number,
  sharpness: number = SPECULAR_EXPONENT,
): number {
  // facing > 0 and facing < 0 are mutually exclusive, so only one of the
  // main and counter highlights is ever nonzero; compute just that one.
  const lit =
    facing >= 0
      ? facing ** sharpness
      : (-facing) ** sharpness * COUNTER_LIGHT;
  return clamp(mask * strength * (AMBIENT_RING + lit), 0, 1);
}

/**
 * Renders the specular rim light for a lens onto a canvas: colored pixels
 * (white by default) whose alpha encodes highlight intensity, meant to be
 * screen-blended over the refracted output.
 *
 * The highlight hugs the inside of the lens edge, derived from the same shape
 * as the refraction: brightest where the outward surface normal faces the
 * light, with a weaker counter-highlight on the opposite edge and a faint
 * ring everywhere. Because it is computed rather than a CSS box-shadow, it
 * follows any shape the SDF describes.
 *
 * `resolution` is samples per CSS pixel, as in `computeDisplacementField`.
 *
 * For a doubly-symmetric shape (every built-in) the mask and normal are
 * computed for the top-left quadrant and reused across the mirrored pixels
 * with the normal's components sign-flipped; a shape that sets
 * `symmetric: false` is sampled in full.
 */
export function renderSpecularToCanvas(
  canvas: HTMLCanvasElement,
  params: LensParams,
  options: SpecularOptions,
  resolution = 1,
): void {
  const { width, height, borderRadius, curvature } = params;
  const { lightAngle, strength, color, sharpness } = options;
  const shape = params.shape ?? roundedRectShape(borderRadius);
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

  // Resolve the highlight color to RGB by letting the canvas parse any CSS
  // color form (named, hex, rgb(), hsl()). The probe pixel is overwritten by
  // putImageData below, so it leaves no trace.
  let cr = 255;
  let cg = 255;
  let cb = 255;
  if (color) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const probe = ctx.getImageData(0, 0, 1, 1).data;
    cr = probe[0];
    cg = probe[1];
    cb = probe[2];
  }

  const image = ctx.createImageData(outWidth, outHeight);
  const data = image.data;

  // Sample at the canvas's own center so mirrored pixels sit at exactly
  // negated coordinates (see computeDisplacementField).
  const centerX = outWidth / 2;
  const centerY = outHeight / 2;

  const sample: ShapeSample = { distance: 0, normalX: 0, normalY: 0 };

  const write = (i: number, alpha: number): void => {
    const o = i * 4;
    data[o] = cr;
    data[o + 1] = cg;
    data[o + 2] = cb;
    data[o + 3] = Math.round(alpha * 255);
  };

  if (shape.symmetric === false) {
    // Asymmetric shape: sample every pixel directly.
    for (let py = 0; py < outHeight; py++) {
      const y = (py + 0.5 - centerY) / resolution;
      for (let px = 0; px < outWidth; px++) {
        const x = (px + 0.5 - centerX) / resolution;
        shape.sample(x, y, halfW, halfH, sample);
        if (sample.distance > 0) {
          continue;
        }
        const t = clamp(-sample.distance / band, 0, 1);
        const mask = 1 - smoothstep(0, 1, t);
        if (mask <= 0) {
          continue;
        }
        const facing = sample.normalX * lightX + sample.normalY * lightY;
        write(py * outWidth + px, specularIntensity(facing, mask, strength, sharpness));
      }
    }
    ctx.putImageData(image, 0, 0);
    return;
  }

  const quadrantW = (outWidth + 1) >> 1;
  const quadrantH = (outHeight + 1) >> 1;

  for (let py = 0; py < quadrantH; py++) {
    const y = (py + 0.5 - centerY) / resolution;
    const my = outHeight - 1 - py;
    for (let px = 0; px < quadrantW; px++) {
      const x = (px + 0.5 - centerX) / resolution;

      shape.sample(x, y, halfW, halfH, sample);
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

      write(py * outWidth + px, specularIntensity(fx + fy, mask, strength, sharpness));
      write(py * outWidth + mx, specularIntensity(-fx + fy, mask, strength, sharpness));
      write(my * outWidth + px, specularIntensity(fx - fy, mask, strength, sharpness));
      write(my * outWidth + mx, specularIntensity(-fx - fy, mask, strength, sharpness));
    }
  }

  ctx.putImageData(image, 0, 0);
}
