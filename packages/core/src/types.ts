import type { LensShape } from "./shape";

export interface LensParams {
  /** Lens width in pixels */
  width: number;
  /** Lens height in pixels */
  height: number;
  /** Corner radius in pixels (used only when `shape` is absent) */
  borderRadius: number;
  /** Maximum displacement magnitude in pixels */
  depth: number;
  /** 0..1:width of the curved rim as a fraction of the lens's shorter half-extent */
  curvature: number;
  /** 0..1:blends displacement direction from edge-normal (0) to radial-from-center (1) */
  splay: number;
  /**
   * The lens silhouette. When omitted, a rounded rectangle of `borderRadius`
   * is used, so existing callers that pass only `borderRadius` are unchanged.
   */
  shape?: LensShape;
}

export interface DisplacementField {
  width: number;
  height: number;
  /** Horizontal displacement in pixels, one entry per pixel, row-major */
  dx: Float32Array;
  /** Vertical displacement in pixels, one entry per pixel, row-major */
  dy: Float32Array;
}

export interface DisplacementMapOptions {
  /** Displacement magnitude (px) that maps to the full channel range; larger values are clamped */
  scale: number;
}
