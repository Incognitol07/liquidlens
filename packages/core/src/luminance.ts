import { clamp } from "./math";
import {
  backgroundFit,
  backgroundImageUrl,
  boxRectToSource,
  mediaElementSource,
  parsePosition,
  placeMedia,
  type MediaSource,
} from "./source";

/**
 * The adaptive layer needs one number to decide how the glass should present
 * itself: how bright is the backdrop *directly under the lens*. This module
 * produces that number by reading actual pixels of the backdrop's image and
 * averaging their relative luminance over the rectangle the frame covers, so
 * the value tracks live as the lens is dragged across light and dark regions.
 *
 * The honest limit of the web: there is no general API to read the rendered
 * pixels of arbitrary DOM. So the probe resolves a concrete pixel source it
 * *can* read — an `<img>`/`<canvas>`/`<video>`, the backdrop's
 * `background-image` URL, or failing those its `background-color` — and gives
 * up gracefully (returns `null`) when none is readable or a cross-origin image
 * taints the canvas. Callers fall back to a neutral presentation, or pass an
 * explicit `source` to bypass sampling entirely.
 */

/** sRGB 8-bit channel → linear-light 0..1 (the WCAG transfer function). */
function channelToLinear(c8: number): number {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * WCAG relative luminance of an sRGB colour, 0 (black) to 1 (white). Used
 * rather than a gamma-space luma so the light/dark decision matches perceived
 * brightness, the same basis as contrast ratios.
 */
export function relativeLuminance(r: number, g: number, b: number): number {
  return (
    0.2126 * channelToLinear(r) +
    0.7152 * channelToLinear(g) +
    0.0722 * channelToLinear(b)
  );
}

/** Average relative luminance over an RGBA pixel buffer (alpha ignored). */
function averageLuminance(data: Uint8ClampedArray): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += relativeLuminance(data[i], data[i + 1], data[i + 2]);
    count += 1;
  }
  return count > 0 ? sum / count : 0.5;
}

/**
 * Relative luminance of an opaque `rgb()`/`rgba()` colour (what
 * `getComputedStyle().backgroundColor` returns), or null when it is
 * transparent or unparseable. Lets a flat-colour backdrop adapt without any
 * pixel sampling.
 */
function solidColorLuminance(value: string): number | null {
  const match = /rgba?\(([^)]+)\)/.exec(value);
  if (!match) {
    return null;
  }
  const parts = match[1].split(",").map((p) => Number.parseFloat(p));
  const [r, g, b, a = 1] = parts;
  if (a < 1 || Number.isNaN(r + g + b)) {
    return null;
  }
  return relativeLuminance(r, g, b);
}

export interface BackdropLuminanceOptions {
  /**
   * Probe grid size per axis; the region under the lens is downsampled to a
   * `probe × probe` canvas and averaged (default 8 → 64 samples). Small on
   * purpose: an average only needs a coarse read, and the `getImageData`
   * read-back is the cost.
   */
  probe?: number;
  /**
   * Bypass pixel sampling entirely. A number is used as the luminance
   * directly; a function is called on each sample (return `null` to defer to
   * pixel sampling). Use when the backdrop is un-sampleable (arbitrary DOM, a
   * cross-origin image) but you know its brightness.
   */
  source?: number | (() => number | null);
  /**
   * Called once the pixel source becomes readable (e.g. a background image
   * finished loading), so the first real sample can be taken after creation.
   */
  onSourceReady?: () => void;
}

export interface BackdropLuminance {
  /**
   * Average relative luminance (0..1) of the backdrop under the frame right
   * now, or `null` when no pixels are readable yet (image still loading, a
   * tainted cross-origin source, or an unsupported backdrop).
   */
  sample(): number | null;
  /** Drop the cached pixel source; the next sample re-resolves it. Call when the backdrop content changes. */
  invalidate(): void;
  destroy(): void;
}

/**
 * Creates a luminance probe for `frame` over `backdrop`. The probe resolves a
 * readable pixel source lazily and caches it; `sample()` reads the region of
 * that source under the frame's current position. Loading an image source is
 * asynchronous, so `sample()` returns `null` until it is ready and
 * `onSourceReady` fires when it becomes available.
 */
export function createBackdropLuminance(
  frame: HTMLElement,
  backdrop: HTMLElement,
  options: BackdropLuminanceOptions = {},
): BackdropLuminance {
  const probe = Math.max(1, Math.round(options.probe ?? 8));
  const override = options.source;
  const doc = frame.ownerDocument;
  const win = doc.defaultView;

  const canvas = doc.createElement("canvas");
  canvas.width = probe;
  canvas.height = probe;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  let source: MediaSource | null = null;
  // Set when the backdrop is a flat colour: sampling collapses to this one
  // value (no region, no drawable, no read-back).
  let solidLuminance: number | null = null;
  let resolved = false;
  // Set once a source taints the canvas or fails to load, so the probe stops
  // retrying a read it can never complete and reports `null` from then on.
  let unreadable = false;
  let destroyed = false;
  let pendingImage: HTMLImageElement | null = null;

  function resolveSource(): MediaSource | null {
    if (resolved) {
      return source;
    }
    resolved = true;

    if (
      backdrop instanceof HTMLImageElement ||
      backdrop instanceof HTMLVideoElement ||
      backdrop instanceof HTMLCanvasElement
    ) {
      source = mediaElementSource(backdrop);
      return source;
    }

    // Otherwise look for a CSS background image and load it. Cross-origin
    // images must opt into CORS or they taint the canvas; we request it and
    // fall back to `unreadable` if the read still throws.
    const style = getComputedStyle(backdrop);
    const url = backgroundImageUrl(style.backgroundImage);
    if (!url || !win) {
      // No image to sample — fall back to a flat background colour if there
      // is an opaque one.
      solidLuminance = solidColorLuminance(style.backgroundColor);
      return null;
    }
    const fit = backgroundFit(style.backgroundSize);
    const position = parsePosition(style.backgroundPosition);
    const img = new win.Image();
    img.crossOrigin = "anonymous";
    pendingImage = img;
    img.onload = () => {
      pendingImage = null;
      if (destroyed || img.naturalWidth === 0) {
        return;
      }
      source = { drawable: img, width: img.naturalWidth, height: img.naturalHeight, fit, position };
      options.onSourceReady?.();
    };
    img.onerror = () => {
      pendingImage = null;
      unreadable = true;
    };
    img.src = url;
    return null;
  }

  function samplePixels(): number | null {
    if (unreadable || !ctx) {
      return null;
    }
    const src = resolveSource();
    if (!src) {
      // resolveSource may have found a flat colour instead of a drawable.
      return solidLuminance;
    }

    const frameRect = frame.getBoundingClientRect();
    const backdropRect = backdrop.getBoundingClientRect();
    const boxW = backdrop.clientWidth || backdropRect.width;
    const boxH = backdrop.clientHeight || backdropRect.height;
    if (boxW <= 0 || boxH <= 0) {
      return null;
    }

    // The frame's box relative to the backdrop, clipped to the backdrop so an
    // overhanging or partly-scrolled lens still samples the overlap.
    const fx = clamp(frameRect.left - backdropRect.left, 0, boxW);
    const fy = clamp(frameRect.top - backdropRect.top, 0, boxH);
    const fw = clamp(frameRect.width, 1, boxW - fx);
    const fh = clamp(frameRect.height, 1, boxH - fy);

    const placement = placeMedia(boxW, boxH, src.width, src.height, src.fit, src.position);
    const { sx, sy, sw, sh } = boxRectToSource(placement, src.width, src.height, {
      x: fx,
      y: fy,
      width: fw,
      height: fh,
    });

    try {
      ctx.clearRect(0, 0, probe, probe);
      ctx.drawImage(src.drawable, sx, sy, sw, sh, 0, 0, probe, probe);
      const { data } = ctx.getImageData(0, 0, probe, probe);
      return averageLuminance(data);
    } catch {
      // A tainted (cross-origin) source throws on getImageData; remember so we
      // don't keep paying the failed draw + read every frame.
      unreadable = true;
      return null;
    }
  }

  return {
    sample(): number | null {
      if (typeof override === "number") {
        return clamp(override, 0, 1);
      }
      if (typeof override === "function") {
        const value = override();
        if (value !== null && value !== undefined) {
          return clamp(value, 0, 1);
        }
      }
      return samplePixels();
    },
    invalidate(): void {
      resolved = false;
      source = null;
      solidLuminance = null;
      unreadable = false;
    },
    destroy(): void {
      destroyed = true;
      if (pendingImage) {
        pendingImage.onload = null;
        pendingImage.onerror = null;
        pendingImage = null;
      }
    },
  };
}
