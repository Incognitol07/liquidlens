import { clamp } from "./math";
import {
  createBackdropLuminance,
  type BackdropLuminance,
} from "./luminance";

/**
 * The adaptive layer is the part of Liquid Glass that "continuously adapts
 * based on what's behind it": it reads the backdrop brightness under the lens
 * (via the luminance probe) and keeps the glass legible by grounding it with a
 * shadow, flipping its ink (text/glyph colour) between light and dark, and
 * nudging a colour tint toward the tone that reads over the current content.
 *
 * Two of these are cheap enough to run live as the lens moves (shadow and ink
 * are plain style writes); the tint adjustment regenerates the SVG filter, so
 * it is gated to "settle" moments — a trailing debounce after motion stops —
 * and only re-applied when the resulting colour actually changes.
 *
 * The pure mappings below are exported so they can be unit-tested and reused.
 */

/** Ink colour used over dark backdrops (near-white). */
const INK_LIGHT = "#f5f5f7";
/** Ink colour used over light backdrops (near-black). */
const INK_DARK = "#15151a";
/**
 * Hysteresis band around the 0.5 midpoint: the ink only flips to light once
 * the backdrop drops below `FLIP_LOW`, and back to dark once it rises above
 * `FLIP_HIGH`. The gap stops the ink strobing when the lens hovers over a
 * mid-tone region whose luminance jitters around 0.5.
 */
const FLIP_LOW = 0.45;
const FLIP_HIGH = 0.55;

/** Round to 3 decimals so generated CSS strings are stable and compact. */
function r3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The grounding shadow for a given backdrop luminance (0..1). A brighter or
 * busier backdrop needs a denser shadow to separate the glass from it; over
 * dark content the element already stands out, so the shadow eases off. Two
 * layers — a tight contact shadow and a soft cast — read as depth rather than
 * a drop blur.
 */
export function adaptiveShadow(luminance: number): string {
  const l = clamp(luminance, 0, 1);
  const opacity = 0.16 + 0.3 * l; // 0.16 over black → 0.46 over white
  const contact = r3(opacity * 0.55);
  const cast = r3(opacity);
  return `0 1px 3px rgba(0, 0, 0, ${contact}), 0 8px 24px rgba(0, 0, 0, ${cast})`;
}

/**
 * The legible ink (text/glyph) colour over a backdrop of the given luminance:
 * light ink on dark content, dark ink on light content. `previousDark` carries
 * the last decision so the band between {@link FLIP_LOW} and {@link FLIP_HIGH}
 * holds steady instead of flickering. Returns the colour and the decision to
 * thread back in next time.
 */
export function inkColor(
  luminance: number,
  previousDark = luminance >= 0.5,
): { color: string; dark: boolean } {
  let dark = previousDark; // `dark` = use dark ink (backdrop is light)
  if (luminance >= FLIP_HIGH) {
    dark = true;
  } else if (luminance <= FLIP_LOW) {
    dark = false;
  }
  return { color: dark ? INK_DARK : INK_LIGHT, dark };
}

function parseHex(hex: string): [number, number, number] | null {
  const body = hex.trim().replace(/^#/, "");
  if (body.length === 3) {
    const r = Number.parseInt(body[0] + body[0], 16);
    const g = Number.parseInt(body[1] + body[1], 16);
    const b = Number.parseInt(body[2] + body[2], 16);
    return Number.isNaN(r + g + b) ? null : [r, g, b];
  }
  if (body.length === 6) {
    const r = Number.parseInt(body.slice(0, 2), 16);
    const g = Number.parseInt(body.slice(2, 4), 16);
    const b = Number.parseInt(body.slice(4, 6), 16);
    return Number.isNaN(r + g + b) ? null : [r, g, b];
  }
  return null;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) {
    return [0, 0, l];
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) {
    h = (gn - bn) / d + (gn < bn ? 6 : 0);
  } else if (max === gn) {
    h = (bn - rn) / d + 2;
  } else {
    h = (rn - gn) / d + 4;
  }
  return [h / 6, s, l];
}

function hue(p: number, q: number, t: number): number {
  let tn = t;
  if (tn < 0) tn += 1;
  if (tn > 1) tn -= 1;
  if (tn < 1 / 6) return p + (q - p) * 6 * tn;
  if (tn < 1 / 2) return q;
  if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
  return p;
}

function hslToHex(h: number, s: number, l: number): string {
  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h + 1 / 3);
    g = hue(p, q, h);
    b = hue(p, q, h - 1 / 3);
  }
  const to = (v: number): string =>
    Math.round(clamp(v, 0, 1) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/**
 * Adapts a tint colour to the backdrop luminance the way Apple describes
 * coloured glass: the hue and saturation are kept, but the lightness shifts
 * "toward content brightness" so the tint stays legible — lifted over dark
 * content, deepened over bright — without straying far from the intended
 * colour. `strength` (0..1) scales the maximum shift. Non-hex inputs are
 * returned unchanged (only hex can be adjusted without a layout read-back).
 */
export function adaptTint(hex: string, luminance: number, strength = 0.5): string {
  const rgb = parseHex(hex);
  if (!rgb) {
    return hex;
  }
  const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  const shift = (0.5 - clamp(luminance, 0, 1)) * strength;
  const nextL = clamp(l + shift, 0.15, 0.9);
  return hslToHex(h, s, nextL);
}

export interface AdaptiveOptions {
  /** Ground the glass with a backdrop-aware shadow (default true). */
  shadow?: boolean;
  /** Flip text/glyph ink between light and dark for legibility (default true). */
  ink?: boolean;
  /** Adapt a configured colour tint's tone to the backdrop (default true; only acts when a tint is set). */
  tint?: boolean;
  /** Max lightness shift applied by tint adaptation, 0..1 (default 0.5). */
  tintStrength?: number;
  /**
   * Override backdrop luminance instead of sampling pixels: a number, or a
   * function returning 0..1 (or `null` to fall back to sampling). Use for
   * backdrops the probe can't read.
   */
  luminance?: number | (() => number | null);
  /** Probe grid size per axis passed to the luminance sampler (default 8). */
  probe?: number;
}

/** What the lens hands the adaptive layer so it can read and adjust the tint. */
export interface AdaptiveHooks {
  /** The base tint the consumer configured (its colour), or undefined when none/transparent. */
  getTint(): string | undefined;
  /** Apply an adapted tint colour (settle only); the lens regenerates its filter. */
  applyTint(color: string): void;
}

export interface AdaptiveLayer {
  /**
   * Re-sample the backdrop and re-apply. `settle` true permits the expensive
   * tint/filter update; false keeps it to the cheap shadow + ink writes
   * (coalesced to one sample per frame) and arms a trailing settle.
   */
  refresh(settle: boolean): void;
  /** The backdrop content changed; drop the cached pixel source and re-evaluate. */
  invalidate(): void;
  /** Last sampled backdrop luminance (0..1), or null if unreadable. */
  readonly luminance: number | null;
  /** Which ink the glass is currently presenting, or null before the first read. */
  readonly ink: "light" | "dark" | null;
  /** Tear down: restore the frame styles the layer touched and stop the probe. */
  destroy(): void;
}

/** Trailing delay after motion before taking a "settle" sample (tint regen). */
const SETTLE_DELAY_MS = 160;

/**
 * Wires a luminance probe to a frame's presentation. The lens creates one of
 * these when `adaptive` is on and calls `refresh()` from its movement/scroll/
 * content hooks; everything else (which properties to drive, the settle
 * debounce, restoring inline styles) lives here.
 */
export function createAdaptiveLayer(
  frame: HTMLElement,
  backdrop: HTMLElement,
  hooks: AdaptiveHooks,
  options: AdaptiveOptions = {},
): AdaptiveLayer {
  const useShadow = options.shadow ?? true;
  const useInk = options.ink ?? true;
  const useTint = options.tint ?? true;
  const tintStrength = options.tintStrength ?? 0.5;
  const win = frame.ownerDocument.defaultView;

  // Inline styles the layer overwrites, captured so destroy() restores exactly
  // what the consumer had (mirrors how the lens treats position/overflow).
  const priorBoxShadow = frame.style.boxShadow;
  const priorColor = frame.style.color;
  const priorInk = frame.style.getPropertyValue("--ll-ink");

  let luminance: number | null = null;
  let inkDark: boolean | null = null;
  // The last tint colour pushed to the lens, so a stable backdrop doesn't
  // regenerate the filter every settle.
  let appliedTint: string | null = null;

  let frameScheduled = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  const probe: BackdropLuminance = createBackdropLuminance(frame, backdrop, {
    probe: options.probe,
    source: options.luminance,
    // First readable pixels (image finished loading) → take a full sample.
    onSourceReady: () => doSample(true),
  });

  function applyShadow(l: number): void {
    if (useShadow) {
      frame.style.boxShadow = adaptiveShadow(l);
    }
  }

  function applyInk(l: number): void {
    if (!useInk) {
      return;
    }
    const next = inkColor(l, inkDark ?? l >= 0.5);
    if (next.dark !== inkDark) {
      inkDark = next.dark;
      frame.style.color = next.color;
      frame.style.setProperty("--ll-ink", next.color);
    }
  }

  function applyTint(l: number): void {
    if (!useTint) {
      return;
    }
    const base = hooks.getTint();
    if (!base) {
      return;
    }
    const adapted = adaptTint(base, l, tintStrength);
    if (adapted !== appliedTint) {
      appliedTint = adapted;
      hooks.applyTint(adapted);
    }
  }

  function doSample(allowTint: boolean): void {
    if (destroyed) {
      return;
    }
    const l = probe.sample();
    if (l === null) {
      // Unreadable backdrop: present a neutral mid shadow so the glass is still
      // grounded, and leave ink/tint as the consumer set them.
      if (luminance === null) {
        applyShadow(0.5);
      }
      return;
    }
    luminance = l;
    applyShadow(l);
    applyInk(l);
    if (allowTint) {
      applyTint(l);
    }
  }

  function refresh(settle: boolean): void {
    if (destroyed) {
      return;
    }
    if (settle) {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = undefined;
      doSample(true);
      return;
    }
    // Cheap live path: at most one sample per frame for shadow + ink…
    if (!frameScheduled && win) {
      frameScheduled = true;
      win.requestAnimationFrame(() => {
        frameScheduled = false;
        doSample(false);
      });
    } else if (!win) {
      doSample(false);
    }
    // …and a trailing settle so the tint catches up once motion stops.
    if (win) {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        doSample(true);
      }, SETTLE_DELAY_MS);
    }
  }

  // The first evaluation is deliberately not run here: the lens calls
  // `refresh(true)` once it has assigned this layer, so a tint-driven,
  // re-entrant `update()` sees the layer already in place instead of building
  // a second one. (`onSourceReady` likewise fires after assignment.)

  return {
    refresh,
    invalidate(): void {
      probe.invalidate();
      doSample(true);
    },
    get luminance(): number | null {
      return luminance;
    },
    get ink(): "light" | "dark" | null {
      return inkDark === null ? null : inkDark ? "dark" : "light";
    },
    destroy(): void {
      destroyed = true;
      if (settleTimer) clearTimeout(settleTimer);
      probe.destroy();
      frame.style.boxShadow = priorBoxShadow;
      frame.style.color = priorColor;
      if (priorInk) {
        frame.style.setProperty("--ll-ink", priorInk);
      } else {
        frame.style.removeProperty("--ll-ink");
      }
    },
  };
}
