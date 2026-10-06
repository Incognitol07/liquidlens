import type { LensShape } from "./shape";

/**
 * The glass a renderer draws, after the lens has applied defaults, the
 * active accessibility treatment and any adaptive tint. Sizes are the frame's
 * CSS px.
 */
export interface ResolvedLook {
  width: number;
  height: number;
  borderRadius: number;
  shape: LensShape;
  depth: number;
  curvature: number;
  splay: number;
  aberration: number;
  blur: number;
  saturation: number;
  lightAngle: number;
  specular: number;
  specularColor?: string;
  specularSharpness?: number;
  tint?: string;
  tintOpacity: number;
}

/**
 * Layout the lens reads once per update, before any renderer writes, so an
 * update costs at most one reflow.
 */
export interface LensLayout {
  /** The frame's offset from the backdrop's top-left corner. */
  offsetX: number;
  offsetY: number;
  backdropWidth: number;
  backdropHeight: number;
}

/** What a renderer reports back to its lens. */
export interface RendererHost {
  frame: HTMLElement;
  backdrop: HTMLElement;
  /** The view under the lens may have changed (it moved, or content scrolled). */
  viewChanged(): void;
  /** The backdrop's content changed. */
  contentChanged(): void;
}

/** One way of drawing a lens. The lens owns options; a renderer owns pixels. */
export interface Renderer {
  render(look: ResolvedLook, layout: LensLayout, resolution?: number): void;
  setIntensity(factor: number): void;
  /** Re-measures and re-aligns with the backdrop. */
  sync(): void;
  /** Re-aligns to a known offset without reading layout. */
  syncTo(offsetX: number, offsetY: number): void;
  setTracking(scroll: boolean, content: boolean): void;
  pause(): void;
  resume(): void;
  freeze(): void;
  unfreeze(): void;
  destroy(): void;
}
