import { createGlassFilter } from "./filter";

const LENS_MARKER = "data-caustics-lens";

export interface LiquidLensOptions {
  /** Maximum displacement at the rim, in px (default 24) */
  depth?: number;
  /** 0..1: width of the curved rim relative to the lens size (default 0.4) */
  curvature?: number;
  /** 0..1: blends displacement from edge-normal to radial (default 0.59) */
  splay?: number;
  /** 0..1: chromatic aberration strength (default 0.05) */
  aberration?: number;
  /** Blur in px applied to the refracted content (default 0.2) */
  blur?: number;
  /** Saturation multiplier for the refracted content (default 1.15) */
  saturation?: number;
  /** Light direction in degrees: 0 lights the top edge, 90 the right edge (default 0) */
  lightAngle?: number;
  /** 0..1: strength of the specular rim highlight (default 1) */
  specular?: number;
  /** Corner radius in px; defaults to the frame's computed border-radius */
  borderRadius?: number;
}

export interface LiquidLens {
  /**
   * Merges in new options and regenerates the displacement map.
   * `resolution` (samples per CSS px) overrides the devicePixelRatio
   * default; pass ~0.5 when updating every frame of a size morph.
   */
  update(options?: LiquidLensOptions, resolution?: number): void;
  /**
   * Re-aligns the backdrop copy with the real backdrop by measuring both
   * elements. Call after the frame moved for a reason you cannot quantify
   * (e.g. the backdrop scrolled). Forces a layout pass; on per-frame paths
   * where the position is already known, prefer `syncTo`.
   */
  sync(): void;
  /**
   * Like `sync`, but takes the frame's offset from the backdrop's top-left
   * corner instead of measuring it, so it never reads layout — safe to call
   * on every frame of a drag. Decorative rotate/scale transforms on the
   * frame should be excluded from the offset.
   */
  syncTo(offsetX: number, offsetY: number): void;
  /**
   * Scales the refraction strength relative to the configured depth without
   * regenerating the map. Cheap; intended for per-frame interaction
   * feedback such as swelling on press.
   */
  setIntensity(factor: number): void;
  /** Removes everything the lens added to the document. */
  destroy(): void;
}

const DEFAULTS: Required<Omit<LiquidLensOptions, "borderRadius">> = {
  depth: 24,
  curvature: 0.4,
  splay: 0.59,
  aberration: 0.05,
  blur: 0.2,
  saturation: 1.15,
  lightAngle: 0,
  specular: 1,
};

/**
 * Turns `frame` into a liquid-glass lens floating over `backdrop`.
 *
 * The lens cannot sample the page behind it, so it clones `backdrop` into
 * itself and keeps the clone pixel-aligned with the original; the SVG filter
 * then bends, fringes, and saturates that copy and blends a specular rim
 * light over it for the glossy edge. The frame must be visually on top of
 * the backdrop and inside it in layout terms (any positioned descendant
 * works).
 *
 * Note: the clone is a snapshot; if the backdrop's content changes, call
 * `destroy()` and create the lens again.
 */
export function createLiquidLens(
  frame: HTMLElement,
  backdrop: HTMLElement,
  options: LiquidLensOptions = {},
): LiquidLens {
  const doc = frame.ownerDocument;
  let settings: LiquidLensOptions & typeof DEFAULTS = { ...DEFAULTS, ...options };

  // Mark the frame so clones of the backdrop can exclude it (the frame is
  // usually a descendant of the backdrop; cloning it back into itself
  // would nest lenses indefinitely).
  frame.setAttribute(LENS_MARKER, "");

  if (getComputedStyle(frame).position === "static") {
    frame.style.position = "relative";
  }
  frame.style.overflow = "hidden";

  const glassFilter = createGlassFilter(doc);

  // Refraction layer: holds the backdrop clone and applies the filter to it.
  // The shine layer must stay outside this element so the highlight is not
  // displaced along with the backdrop pixels.
  const refraction = doc.createElement("div");
  Object.assign(refraction.style, {
    position: "absolute",
    inset: "0",
    filter: glassFilter.cssFilter,
  });

  const clone = backdrop.cloneNode(true) as HTMLElement;
  clone.setAttribute("aria-hidden", "true");
  clone.removeAttribute("id");
  clone.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  clone.querySelectorAll(`[${LENS_MARKER}]`).forEach((el) => el.remove());
  Object.assign(clone.style, {
    position: "absolute",
    top: "0",
    left: "0",
    margin: "0",
    width: `${backdrop.clientWidth}px`,
    height: `${backdrop.clientHeight}px`,
    pointerEvents: "none",
  });

  refraction.appendChild(clone);
  frame.appendChild(refraction);

  let syncedX = Number.NaN;
  let syncedY = Number.NaN;

  function syncTo(offsetX: number, offsetY: number): void {
    if (offsetX === syncedX && offsetY === syncedY) {
      return;
    }
    syncedX = offsetX;
    syncedY = offsetY;
    clone.style.transform = `translate(${-offsetX}px, ${-offsetY}px)`;
  }

  function sync(): void {
    const frameRect = frame.getBoundingClientRect();
    const backdropRect = backdrop.getBoundingClientRect();
    syncTo(frameRect.left - backdropRect.left, frameRect.top - backdropRect.top);
  }

  // Size of the frame at the last update, so the ResizeObserver can skip
  // sizes that an explicit update (e.g. a per-frame morph) already handled.
  let lastWidth = -1;
  let lastHeight = -1;

  function update(next: LiquidLensOptions = {}, resolution?: number): void {
    settings = { ...settings, ...next };

    const borderRadius =
      settings.borderRadius ??
      (Number.parseFloat(getComputedStyle(frame).borderTopLeftRadius) || 0);

    lastWidth = frame.clientWidth;
    lastHeight = frame.clientHeight;

    glassFilter.update(
      {
        width: lastWidth,
        height: lastHeight,
        borderRadius,
        depth: settings.depth,
        curvature: settings.curvature,
        splay: settings.splay,
        aberration: settings.aberration,
        blur: settings.blur,
        saturation: settings.saturation,
        lightAngle: settings.lightAngle,
        specular: settings.specular,
      },
      resolution,
    );
    // The filter id cycles on update (WebKit repaint workaround), so the
    // reference must be re-applied.
    refraction.style.filter = glassFilter.cssFilter;

    clone.style.width = `${backdrop.clientWidth}px`;
    clone.style.height = `${backdrop.clientHeight}px`;
    sync();
  }

  // Map geometry depends on the frame's size; regenerate when it changes,
  // unless an explicit update already covered the current size.
  let resizeObserver: ResizeObserver | undefined;
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => {
      if (frame.clientWidth !== lastWidth || frame.clientHeight !== lastHeight) {
        update();
      }
    });
    resizeObserver.observe(frame);
  }

  update();

  return {
    update,
    sync,
    syncTo,
    setIntensity: glassFilter.setIntensity,
    destroy(): void {
      resizeObserver?.disconnect();
      refraction.remove();
      glassFilter.destroy();
      frame.removeAttribute(LENS_MARKER);
    },
  };
}
