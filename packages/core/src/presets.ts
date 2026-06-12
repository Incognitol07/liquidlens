import type { LiquidLensOptions } from "./lens";

/**
 * A complete set of effect options. Presets carry only the optical knobs;
 * geometry (`borderRadius`) and behavior (`trackScroll`, `onReady`, ...)
 * are never part of a preset.
 */
export type LensPreset = Readonly<
  Required<
    Pick<
      LiquidLensOptions,
      | "depth"
      | "curvature"
      | "splay"
      | "aberration"
      | "blur"
      | "saturation"
      | "lightAngle"
      | "specular"
    >
  >
>;

export type LensPresetName = keyof typeof presets;

/**
 * Named starting points on the quality/cost curve. Each is a plain options
 * object, so individual knobs can still be overridden by spreading:
 *
 *     createLiquidLens(frame, backdrop, { ...presets.lean, depth: 30 });
 *
 * The cost differences are real, not cosmetic: every effect a preset turns
 * off removes its passes from the SVG filter entirely, which is what makes
 * the cheaper presets viable on devices that rasterize filters on the CPU.
 */
export const presets = {
  /** The full look: chromatic aberration, blur, saturation, specular rim. */
  full: {
    depth: 24,
    curvature: 0.4,
    splay: 0.59,
    aberration: 0.05,
    blur: 0.2,
    saturation: 1.15,
    lightAngle: 0,
    specular: 1,
  },
  /**
   * Drops the two passes that dominate filter cost, the per-channel
   * aberration split and the Gaussian blur, keeping the refraction,
   * saturation, and specular rim. The first preset to try when the full
   * look stutters.
   */
  lean: {
    depth: 24,
    curvature: 0.4,
    splay: 0.59,
    aberration: 0,
    blur: 0,
    saturation: 1.15,
    lightAngle: 0,
    specular: 1,
  },
  /**
   * Refraction only: the filter reduces to a single displacement pass,
   * the cheapest configuration that still reads as glass.
   */
  minimal: {
    depth: 24,
    curvature: 0.4,
    splay: 0.59,
    aberration: 0,
    blur: 0,
    saturation: 1,
    lightAngle: 0,
    specular: 0,
  },
} as const satisfies Record<string, LensPreset>;
