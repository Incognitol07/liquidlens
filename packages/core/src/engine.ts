import { LENS_MARKER } from "./backdrop";
import type { MediaPlacement } from "./gpu-renderer";
import type { GpuMedia } from "./gpu/types";
import {
  backgroundFit,
  backgroundImageUrl,
  mediaElementSource,
  parsePosition,
  type Rect,
} from "./source";

/** The engine a lens renders with. */
export type LensEngine = "webgpu" | "webgl" | "svg";

/** What a GPU lens samples, and where that media sits relative to the backdrop. */
export interface GpuChoice {
  media: GpuMedia;
  placement: MediaPlacement;
}

const isMedia = (el: Element): el is HTMLImageElement | HTMLVideoElement | HTMLCanvasElement =>
  el instanceof HTMLImageElement || el instanceof HTMLVideoElement || el instanceof HTMLCanvasElement;

/**
 * Whether the backdrop paints nothing but its own background: no visible
 * child elements other than lens frames, and no text of its own.
 */
function paintsOnlyBackground(backdrop: HTMLElement): boolean {
  for (const node of backdrop.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) return false;
    if (node instanceof Element && !node.hasAttribute(LENS_MARKER)) {
      const style = getComputedStyle(node);
      if (style.display !== "none" && style.visibility !== "hidden") return false;
    }
  }
  return true;
}

/**
 * The media a GPU lens can sample while still showing exactly what the
 * backdrop paints, or null when only the SVG engine can: the backdrop is an
 * image, video or canvas; or it paints only a CSS background image; or the
 * caller named a `source` to refract.
 */
export function gpuMediaFor(backdrop: HTMLElement, source?: Element): GpuChoice | null {
  const mediaEl = source ?? (isMedia(backdrop) ? backdrop : undefined);
  if (mediaEl && isMedia(mediaEl)) {
    const style = getComputedStyle(mediaEl);
    const box =
      mediaEl === backdrop
        ? undefined
        : (): Rect => {
            const r = mediaEl.getBoundingClientRect();
            const b = backdrop.getBoundingClientRect();
            return { x: r.left - b.left, y: r.top - b.top, width: r.width, height: r.height };
          };
    const resolved = mediaElementSource(mediaEl);
    return {
      media: mediaEl,
      placement: {
        fit: resolved?.fit ?? ((style.objectFit || "fill") as MediaPlacement["fit"]),
        position: resolved?.position ?? parsePosition(style.objectPosition || "50% 50%"),
        box,
      },
    };
  }
  if (source) return null;

  const style = getComputedStyle(backdrop);
  const url = backgroundImageUrl(style.backgroundImage);
  if (!url || !paintsOnlyBackground(backdrop)) return null;
  return {
    media: url,
    placement: {
      fit: backgroundFit(style.backgroundSize),
      position: parsePosition(style.backgroundPosition),
    },
  };
}
