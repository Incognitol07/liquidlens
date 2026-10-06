import { watchBackdrop } from "./backdrop";
import { cssColorToRgb } from "./gpu/color";
import { SHAPE_ROUNDED_RECT, SHAPE_SUPERELLIPSE } from "./gpu/shaders";
import type { GpuEngine, GpuLens, ShaderLook } from "./gpu/types";
import type { LensLayout, Renderer, RendererHost, ResolvedLook } from "./renderer";
import type { LensShape } from "./shape";
import { placeMedia, type AxisOffset, type MediaFit, type Rect } from "./source";

const DEFAULT_SPECULAR_SHARPNESS = 10;

/** How the media sits in its box (object-/background- fit and position). */
export interface MediaPlacement {
  fit: MediaFit;
  position: [AxisOffset, AxisOffset];
  /** The media's box relative to the backdrop; the backdrop's own box when absent. */
  box?: () => Rect;
}

/**
 * The shader's shape for a lens shape, or null for a custom sampler the
 * shader can't evaluate (those render with SVG). Built-in shapes are
 * identified by their cache key: `rrect:<radius>` and `superellipse:<n>`.
 */
export function shaderShape(shape: LensShape): { shape: number; radius: number; exponent: number } | null {
  const [kind, value] = shape.key.split(":");
  const n = Number(value);
  if (kind === "rrect") return { shape: SHAPE_ROUNDED_RECT, radius: n, exponent: 2 };
  if (kind === "superellipse") return { shape: SHAPE_SUPERELLIPSE, radius: 0, exponent: n };
  return null;
}

/**
 * Draws a lens with a GPU engine: one canvas inside the frame, filled by a
 * shader that samples the backdrop's media directly. Nothing is cloned;
 * moving the lens or the media playing only changes uniforms and textures.
 * `fallback` is called if the engine can't serve this lens (the media is
 * tainted, the backend is lost); the lens then switches renderer.
 */
export function createGpuRenderer(
  host: RendererHost,
  engine: GpuEngine,
  placement: MediaPlacement,
  fallback: (reason: string) => void,
): Renderer {
  const { frame, backdrop } = host;
  const doc = frame.ownerDocument;

  const canvas = doc.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    pointerEvents: "none",
  });
  frame.prepend(canvas);

  const lens: GpuLens = {
    canvas,
    look: {
      shape: SHAPE_ROUNDED_RECT,
      radius: 0,
      exponent: 2,
      depth: 0,
      curvature: 0,
      splay: 0,
      aberration: 0,
      blur: 0,
      saturation: 1,
      light: [0, -1],
      specular: 0,
      sharpness: DEFAULT_SPECULAR_SHARPNESS,
      specularColor: [1, 1, 1],
      tint: [0, 0, 0, 0],
    },
    intensity: 1,
    width: 0,
    height: 0,
    offsetX: 0,
    offsetY: 0,
    imageRect: { x: 0, y: 0, width: 1, height: 1 },
    visible: true,
  };

  let destroyed = false;
  let backdropWidth = 0;
  let backdropHeight = 0;

  /** Where the media is drawn in the backdrop, once its size is known. */
  const place = (): void => {
    const { width, height } = engine.sourceSize;
    const box = placement.box?.() ?? { x: 0, y: 0, width: backdropWidth, height: backdropHeight };
    if (width > 0 && height > 0 && box.width > 0 && box.height > 0) {
      const rect = placeMedia(box.width, box.height, width, height, placement.fit, placement.position);
      lens.imageRect = { ...rect, x: rect.x + box.x, y: rect.y + box.y };
    }
  };

  engine.attach(lens);
  engine.ready.then(
    () => {
      if (destroyed) return;
      place();
      engine.invalidate(lens);
    },
    (error: unknown) => {
      if (!destroyed) fallback(error instanceof Error ? error.message : String(error));
    },
  );
  const unsubscribeLost = engine.onLost(() => {
    if (!destroyed) fallback("the GPU context was lost");
  });

  function syncTo(offsetX: number, offsetY: number): void {
    if (offsetX === lens.offsetX && offsetY === lens.offsetY) {
      return;
    }
    lens.offsetX = offsetX;
    lens.offsetY = offsetY;
    engine.invalidate(lens);
    host.viewChanged();
  }

  function sync(): void {
    const frameRect = frame.getBoundingClientRect();
    const backdropRect = backdrop.getBoundingClientRect();
    syncTo(frameRect.left - backdropRect.left, frameRect.top - backdropRect.top);
    host.viewChanged();
  }

  // Page and ancestor scrolls can move the frame relative to the backdrop.
  const onScroll = (): void => {
    if (lens.visible) sync();
  };
  let scrollTracking = false;
  let unwatchContent: (() => void) | undefined;

  return {
    render(look: ResolvedLook, layout: LensLayout) {
      const shape = shaderShape(look.shape) ?? { shape: SHAPE_ROUNDED_RECT, radius: look.borderRadius, exponent: 2 };
      const radians = (look.lightAngle * Math.PI) / 180;
      const next: ShaderLook = {
        ...shape,
        depth: look.depth,
        curvature: look.curvature,
        splay: look.splay,
        aberration: look.aberration,
        blur: look.blur,
        saturation: look.saturation,
        light: [Math.sin(radians), -Math.cos(radians)],
        specular: look.specular,
        sharpness: look.specularSharpness ?? DEFAULT_SPECULAR_SHARPNESS,
        specularColor: look.specularColor ? cssColorToRgb(look.specularColor, doc) : [1, 1, 1],
        tint:
          look.tint != null && look.tintOpacity > 0
            ? [...cssColorToRgb(look.tint, doc), look.tintOpacity]
            : [0, 0, 0, 0],
      };
      lens.look = next;
      lens.width = look.width;
      lens.height = look.height;
      lens.offsetX = layout.offsetX;
      lens.offsetY = layout.offsetY;
      backdropWidth = layout.backdropWidth;
      backdropHeight = layout.backdropHeight;
      place();
      engine.invalidate(lens);
    },

    setIntensity(factor) {
      if (factor === lens.intensity) return;
      lens.intensity = factor;
      engine.invalidate(lens);
    },

    sync,
    syncTo,

    setTracking(scroll, content) {
      const win = doc.defaultView;
      if (win && scroll !== scrollTracking) {
        scrollTracking = scroll;
        if (scroll) win.addEventListener("scroll", onScroll, { capture: true, passive: true });
        else win.removeEventListener("scroll", onScroll, { capture: true });
      }
      // The media is sampled live; a DOM change can still move or swap it.
      if (content && !unwatchContent) {
        unwatchContent = watchBackdrop(backdrop, () => {
          sync();
          host.contentChanged();
        });
      } else if (!content && unwatchContent) {
        unwatchContent();
        unwatchContent = undefined;
      }
    },

    pause() {
      lens.visible = false;
      canvas.style.display = "none";
    },

    resume() {
      if (lens.visible) return;
      lens.visible = true;
      canvas.style.display = "";
      sync();
      engine.invalidate(lens);
    },

    // Nothing is rebuilt on content change, so there is nothing to suspend.
    freeze() {},
    unfreeze() {},

    destroy() {
      destroyed = true;
      engine.detach(lens);
      unsubscribeLost();
      doc.defaultView?.removeEventListener("scroll", onScroll, { capture: true });
      unwatchContent?.();
      canvas.remove();
    },
  };
}
