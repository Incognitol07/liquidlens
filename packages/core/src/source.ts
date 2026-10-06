import { clamp } from "./math";

/**
 * How media pixels sit inside an element's box, per CSS: `object-fit` and
 * `object-position` for replaced elements (img, video, canvas), or
 * `background-size` and `background-position` for a background image. Both
 * the luminance probe (which box pixels are under the lens) and the GPU
 * engines (where the image is drawn behind the lens) work from this one
 * placement.
 */

/** `object-fit`, which `background-size` keywords also map onto. */
export type MediaFit = "fill" | "contain" | "cover" | "none" | "scale-down";

/** One axis of a position: a fraction of the free space plus a px offset. */
export interface AxisOffset {
  fraction: number;
  px: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const KEYWORD_FRACTION: Record<string, number> = {
  left: 0,
  top: 0,
  center: 0.5,
  right: 1,
  bottom: 1,
};

function parseAxis(token: string | undefined): AxisOffset {
  if (!token) return { fraction: 0.5, px: 0 };
  if (token in KEYWORD_FRACTION) return { fraction: KEYWORD_FRACTION[token], px: 0 };
  if (token.endsWith("%")) return { fraction: Number.parseFloat(token) / 100, px: 0 };
  return { fraction: 0, px: Number.parseFloat(token) || 0 };
}

/**
 * Parses a computed `object-position` / `background-position` value
 * ("50% 50%", "10px 0px", "center"). Computed values are percentages or
 * lengths per axis; keywords are accepted for robustness.
 */
export function parsePosition(value: string): [AxisOffset, AxisOffset] {
  const [first, second] = value.trim().split(/\s+/);
  return [parseAxis(first), parseAxis(second ?? (first === "center" ? "center" : undefined))];
}

/**
 * The `object-fit` equivalent of a computed `background-size`: `cover` and
 * `contain` map directly, `auto` draws the image at its natural size, and
 * `100% 100%` stretches it. Other explicit sizes are treated as `cover`.
 */
export function backgroundFit(backgroundSize: string): MediaFit {
  const size = backgroundSize.trim();
  if (size === "contain" || size === "cover") return size;
  if (size === "auto" || size === "auto auto") return "none";
  if (size === "100% 100%") return "fill";
  return "cover";
}

/** Where media of `srcW` x `srcH` is drawn inside a `boxW` x `boxH` box. */
export function placeMedia(
  boxW: number,
  boxH: number,
  srcW: number,
  srcH: number,
  fit: MediaFit,
  position: [AxisOffset, AxisOffset] = [
    { fraction: 0.5, px: 0 },
    { fraction: 0.5, px: 0 },
  ],
): Rect {
  let width: number;
  let height: number;
  if (fit === "fill" || srcW <= 0 || srcH <= 0) {
    width = boxW;
    height = boxH;
  } else {
    const contain = Math.min(boxW / srcW, boxH / srcH);
    const scale =
      fit === "cover"
        ? Math.max(boxW / srcW, boxH / srcH)
        : fit === "contain"
          ? contain
          : fit === "none"
            ? 1
            : Math.min(1, contain);
    width = srcW * scale;
    height = srcH * scale;
  }
  const [px, py] = position;
  return {
    x: (boxW - width) * px.fraction + px.px,
    y: (boxH - height) * py.fraction + py.px,
    width,
    height,
  };
}

/**
 * The source-pixel rectangle under a box rectangle, given where the media is
 * placed in the box. Clamped into the source so a rectangle overhanging the
 * media still maps to valid pixels.
 */
export function boxRectToSource(
  placement: Rect,
  srcW: number,
  srcH: number,
  rect: Rect,
): { sx: number; sy: number; sw: number; sh: number } {
  const toX = srcW / placement.width;
  const toY = srcH / placement.height;
  const sx = clamp((rect.x - placement.x) * toX, 0, srcW);
  const sy = clamp((rect.y - placement.y) * toY, 0, srcH);
  return {
    sx,
    sy,
    sw: clamp(rect.width * toX, 1, srcW - sx),
    sh: clamp(rect.height * toY, 1, srcH - sy),
  };
}

/** Pulls the first `url(...)` out of a `background-image` value, or null. */
export function backgroundImageUrl(value: string): string | null {
  const match = /url\((['"]?)([^'")]+)\1\)/.exec(value);
  return match ? match[2] : null;
}

/** A drawable with intrinsic pixel dimensions and how it sits in its box. */
export interface MediaSource {
  drawable: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;
  width: number;
  height: number;
  fit: MediaFit;
  position: [AxisOffset, AxisOffset];
}

/**
 * The media an `<img>`, `<video>` or `<canvas>` element shows, or null for
 * any other element and for media without pixels yet (an image still
 * loading, a video before its first frame).
 */
export function mediaElementSource(el: Element): MediaSource | null {
  const style = getComputedStyle(el);
  const fit = (style.objectFit || "fill") as MediaFit;
  const position = parsePosition(style.objectPosition || "50% 50%");
  if (el instanceof HTMLImageElement) {
    return el.complete && el.naturalWidth > 0
      ? { drawable: el, width: el.naturalWidth, height: el.naturalHeight, fit, position }
      : null;
  }
  if (el instanceof HTMLVideoElement) {
    return el.videoWidth > 0
      ? { drawable: el, width: el.videoWidth, height: el.videoHeight, fit, position }
      : null;
  }
  if (el instanceof HTMLCanvasElement) {
    return { drawable: el, width: el.width, height: el.height, fit, position };
  }
  return null;
}
