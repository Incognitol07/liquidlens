/**
 * Accessibility modifiers for Liquid Glass. Apple ships these "automatically
 * whenever you use the new material": when the OS asks for less transparency or
 * more contrast, the glass adjusts so it stays legible without losing its
 * identity. The lens already honours reduced motion (it pins `setIntensity`);
 * this module covers the other two:
 *
 *   - Reduced Transparency → frostier, obscuring more of the content behind it.
 *   - Increased Contrast   → flattened glass with a contrasting border, so the
 *                            element reads as a crisp high-contrast chip.
 *
 * The optical adjustment is a pure function of the configured effect, so it is
 * unit-tested and applied on every `update()`; the contrasting border is a thin
 * overlay the lens manages (see `CONTRAST_RING`).
 */

/** Which OS accessibility treatments are currently in force. */
export interface AccessibilityFlags {
  reducedTransparency: boolean;
  increasedContrast: boolean;
}

/** The subset of optical knobs the modifiers adjust. */
export interface AccessibleEffect {
  depth: number;
  aberration: number;
  blur: number;
  saturation: number;
  specular: number;
}

/** Gaussian blur (stdDeviation, px) the frost floors at under reduced transparency. */
export const FROST_BLUR = 3;
/** How far refraction is flattened under increased contrast (multiplier on depth). */
export const CONTRAST_DEPTH_SCALE = 0.3;

/**
 * A double inset ring (light over dark) the lens overlays on the frame under
 * increased contrast. The pair reads as a clear boundary on any backdrop —
 * light or dark — without needing to sample it.
 */
export const CONTRAST_RING =
  "inset 0 0 0 1.5px rgba(255, 255, 255, 0.92), inset 0 0 0 3px rgba(0, 0, 0, 0.92)";

/**
 * Adjusts the optical knobs for the active accessibility treatments and returns
 * a new effect (the input is not mutated). With no treatment active the values
 * pass through unchanged.
 *
 * - Reduced transparency floors the blur to {@link FROST_BLUR} (frost over the
 *   content) and drops chromatic aberration, which reads as noise once frosted.
 * - Increased contrast flattens the refraction ({@link CONTRAST_DEPTH_SCALE}),
 *   removes the specular shimmer, neutralises the saturation shift, and drops
 *   aberration, leaving a calm surface for the contrasting border to define.
 */
export function accessibleEffect(
  effect: AccessibleEffect,
  flags: AccessibilityFlags,
): AccessibleEffect {
  let { depth, aberration, blur, saturation, specular } = effect;

  if (flags.reducedTransparency) {
    blur = Math.max(blur, FROST_BLUR);
    aberration = 0;
  }

  if (flags.increasedContrast) {
    depth = depth * CONTRAST_DEPTH_SCALE;
    aberration = 0;
    specular = 0;
    saturation = 1;
  }

  return { depth, aberration, blur, saturation, specular };
}
