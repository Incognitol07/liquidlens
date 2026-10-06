import type { Rect } from "../source";

export type GpuKind = "webgl" | "webgpu";

/** What a GPU lens samples: a media element, or an image URL (a CSS background). */
export type GpuMedia = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | string;

/** The look as shader uniforms. */
export interface ShaderLook {
  shape: number;
  radius: number;
  exponent: number;
  depth: number;
  curvature: number;
  splay: number;
  aberration: number;
  blur: number;
  saturation: number;
  light: [number, number];
  specular: number;
  sharpness: number;
  specularColor: [number, number, number];
  tint: [number, number, number, number];
}

/** One lens as an engine sees it; the renderer owns and mutates it. */
export interface GpuLens {
  /** The canvas inside the frame that shows this lens. */
  canvas: HTMLCanvasElement;
  look: ShaderLook;
  /** Displacement multiplier (setIntensity). */
  intensity: number;
  /** The frame's size in CSS px. */
  width: number;
  height: number;
  /** The frame's offset from the backdrop's top-left, in CSS px. */
  offsetX: number;
  offsetY: number;
  /** Where the media is drawn in the backdrop, in CSS px. */
  imageRect: Rect;
  visible: boolean;
}

/** A source shared by every lens over the same media, on one backend. */
export interface GpuEngine {
  readonly kind: GpuKind;
  /** Resolves once the media is uploaded; rejects if it can't be (e.g. tainted). */
  readonly ready: Promise<void>;
  /** The media's pixel size; zero until `ready`. */
  readonly sourceSize: { width: number; height: number };
  attach(lens: GpuLens): void;
  detach(lens: GpuLens): void;
  /** Redraws the lens on the next frame. */
  invalidate(lens: GpuLens): void;
  /** Called if the backend is lost for good; returns the unsubscribe. */
  onLost(listener: () => void): () => void;
}
