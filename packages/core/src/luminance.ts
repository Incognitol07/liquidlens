import { clamp } from "./math";

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

/** Pulls the first `url(...)` out of a `background-image` value, or null. */
function backgroundImageUrl(value: string): string | null {
  const match = /url\((['"]?)([^'")]+)\1\)/.exec(value);
  return match ? match[2] : null;
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

type ObjectFit = "fill" | "contain" | "cover";

/** A drawable with intrinsic pixel dimensions and how it maps into its box. */
interface PixelSource {
  drawable: CanvasImageSource;
  width: number;
  height: number;
  fit: ObjectFit;
}

/**
 * Maps a rectangle in the backdrop's box coordinates to the corresponding
 * rectangle in the source image's pixels, honouring `object-fit`/`background-
 * size` (cover/contain are centred; fill stretches each axis). The result is
 * clamped into the image bounds so a frame overhanging the backdrop still
 * samples valid pixels.
 */
function mapBoxRectToSource(
  source: PixelSource,
  boxW: number,
  boxH: number,
  fx: number,
  fy: number,
  fw: number,
  fh: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const { width: sw, height: sh, fit } = source;

  let toSx: number;
  let toSy: number;
  let toSw: number;
  let toSh: number;

  if (fit === "fill") {
    const scaleX = sw / boxW;
    const scaleY = sh / boxH;
    toSx = fx * scaleX;
    toSy = fy * scaleY;
    toSw = fw * scaleX;
    toSh = fh * scaleY;
  } else {
    const scale =
      fit === "contain"
        ? Math.min(boxW / sw, boxH / sh)
        : Math.max(boxW / sw, boxH / sh);
    const dispW = sw * scale;
    const dispH = sh * scale;
    const originX = (boxW - dispW) / 2;
    const originY = (boxH - dispH) / 2;
    toSx = (fx - originX) / scale;
    toSy = (fy - originY) / scale;
    toSw = fw / scale;
    toSh = fh / scale;
  }

  const cx = clamp(toSx, 0, sw);
  const cy = clamp(toSy, 0, sh);
  return {
    sx: cx,
    sy: cy,
    sw: clamp(toSw, 1, sw - cx),
    sh: clamp(toSh, 1, sh - cy),
  };
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

  let source: PixelSource | null = null;
  // Set when the backdrop is a flat colour: sampling collapses to this one
  // value (no region, no drawable, no read-back).
  let solidLuminance: number | null = null;
  let resolved = false;
  // Set once a source taints the canvas or fails to load, so the probe stops
  // retrying a read it can never complete and reports `null` from then on.
  let unreadable = false;
  let destroyed = false;
  let pendingImage: HTMLImageElement | null = null;

  function resolveSource(): PixelSource | null {
    if (resolved) {
      return source;
    }
    resolved = true;

    const tag = backdrop.tagName;
    if (tag === "IMG") {
      const img = backdrop as HTMLImageElement;
      if (img.complete && img.naturalWidth > 0) {
        const fit = (getComputedStyle(img).objectFit as ObjectFit) || "fill";
        source = { drawable: img, width: img.naturalWidth, height: img.naturalHeight, fit };
      }
      return source;
    }
    if (tag === "CANVAS") {
      const c = backdrop as HTMLCanvasElement;
      source = { drawable: c, width: c.width, height: c.height, fit: "fill" };
      return source;
    }
    if (tag === "VIDEO") {
      const v = backdrop as HTMLVideoElement;
      if (v.videoWidth > 0) {
        source = { drawable: v, width: v.videoWidth, height: v.videoHeight, fit: "fill" };
      }
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
    const sizeWord = style.backgroundSize;
    const fit: ObjectFit = sizeWord === "contain" ? "contain" : "cover";
    const img = new win.Image();
    img.crossOrigin = "anonymous";
    pendingImage = img;
    img.onload = () => {
      pendingImage = null;
      if (destroyed || img.naturalWidth === 0) {
        return;
      }
      source = { drawable: img, width: img.naturalWidth, height: img.naturalHeight, fit };
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

    const { sx, sy, sw, sh } = mapBoxRectToSource(src, boxW, boxH, fx, fy, fw, fh);

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
