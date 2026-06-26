import { Spring } from "./spring";
import type { SpringConfig } from "./follow";
import type { LiquidLens } from "./lens";

// Slightly stiffer / better-damped than the position follower: a size change
// reads best with a little lead-and-settle, not a long wobble.
const DEFAULT_MORPH_STIFFNESS = 170;
const DEFAULT_MORPH_DAMPING = 16;
// Samples per CSS px while the springs are in motion. The map is regenerated
// every frame during a morph, so halving resolution roughly quarters that
// cost; one crisp full-resolution pass runs once the morph settles.
const DEFAULT_MORPH_RESOLUTION = 0.5;

export interface MorphState {
  width?: number;
  height?: number;
  borderRadius?: number;
}

export interface MorphFrame {
  width: number;
  height: number;
  borderRadius: number;
  /** Combined speed of the size springs (px/s); handy for a morph-speed swell. */
  speed: number;
  /** True on the final, full-resolution frame once the morph has settled. */
  settled: boolean;
}

export interface LensMorphOptions extends SpringConfig {
  /** Starting size/shape; defaults to the frame's measured size and computed radius. */
  initial?: MorphState;
  /** Samples per CSS px while morphing (default 0.5); a crisp full-res pass runs on settle. */
  resolution?: number;
  /**
   * Per-axis spring overrides. Each axis falls back to the top-level
   * `stiffness`/`damping`. Distinct per-axis springs are what give a liquid
   * morph its lead-and-follow — e.g. the width leading the height.
   */
  springs?: {
    width?: SpringConfig;
    height?: SpringConfig;
    borderRadius?: SpringConfig;
  };
  /**
   * Called each animated frame, and once with `settled: true` after the morph
   * comes to rest. Use it to ride content on the morph's progress or swell the
   * refraction with `speed` — work that must stay in lockstep with the size.
   */
  onFrame?: (frame: MorphFrame) => void;
}

/**
 * Spring-driven size/shape morph. Retarget with `to`, jump with `set`, read
 * the live size from `width`/`height`/`borderRadius`, retune with `configure`.
 */
export interface LensMorph {
  /** Spring the given dimensions toward their targets (omitted axes are unchanged). */
  to(state: MorphState): void;
  /** Jump to the given dimensions immediately, with no animation. */
  set(state: MorphState): void;
  readonly width: number;
  readonly height: number;
  readonly borderRadius: number;
  /** Update every axis's spring constants in place, keeping in-flight velocity. */
  configure(config: SpringConfig): void;
  /** Stop the loop. */
  destroy(): void;
}

/**
 * Animates a lens frame's size and corner radius with springs, regenerating
 * the refraction as it goes. Like {@link createLensFollower} is the liquid
 * layer for a lens's position, this is the liquid layer for its size: it
 * springs `width`/`height`/`borderRadius`, writes them to the frame, and calls
 * `lens.update()` each frame — at a reduced resolution while moving, then one
 * crisp full-resolution pass on settle, which is the cheap way to morph a lens
 * smoothly without paying full map-generation cost every frame.
 *
 * It owns the frame's `width`/`height`/`borderRadius`. Pair `onFrame` with the
 * morph to keep content or intensity in lockstep with the size.
 *
 * @example
 * const lens = createLiquidLens(frame, backdrop, { depth: 30 });
 * const morph = createLensMorph(frame, lens, {
 *   springs: { width: { stiffness: 260, damping: 15 }, height: { stiffness: 170, damping: 12 } },
 * });
 * trigger.addEventListener("click", () => morph.to({ width: 172, height: 80 }));
 */
export function createLensMorph(
  frame: HTMLElement,
  lens: Pick<LiquidLens, "update">,
  options: LensMorphOptions = {},
): LensMorph {
  const win = frame.ownerDocument.defaultView;
  const resolution = options.resolution ?? DEFAULT_MORPH_RESOLUTION;
  const onFrame = options.onFrame;

  const stiffnessFor = (axis: keyof NonNullable<LensMorphOptions["springs"]>): number =>
    options.springs?.[axis]?.stiffness ?? options.stiffness ?? DEFAULT_MORPH_STIFFNESS;
  const dampingFor = (axis: keyof NonNullable<LensMorphOptions["springs"]>): number =>
    options.springs?.[axis]?.damping ?? options.damping ?? DEFAULT_MORPH_DAMPING;

  const initialW = options.initial?.width ?? frame.clientWidth;
  const initialH = options.initial?.height ?? frame.clientHeight;
  const initialR =
    options.initial?.borderRadius ??
    (Number.parseFloat(getComputedStyle(frame).borderTopLeftRadius) || 0);

  const springW = new Spring(initialW, stiffnessFor("width"), dampingFor("width"));
  const springH = new Spring(initialH, stiffnessFor("height"), dampingFor("height"));
  const springR = new Spring(initialR, stiffnessFor("borderRadius"), dampingFor("borderRadius"));

  const reducedMotion = win?.matchMedia?.("(prefers-reduced-motion: reduce)");
  let rafId: number | undefined;
  let lastTime = 0;
  let destroyed = false;

  const writeSize = (): void => {
    frame.style.width = `${springW.value}px`;
    frame.style.height = `${springH.value}px`;
    frame.style.borderRadius = `${springR.value}px`;
  };

  // The lens reads the frame's clientWidth/Height for its geometry (set just
  // above) and takes borderRadius explicitly; merging keeps the optical
  // options the lens already had.
  const applyLens = (res: number | undefined): void => {
    lens.update({ borderRadius: springR.value }, res);
  };

  const emit = (settled: boolean): void => {
    onFrame?.({
      width: springW.value,
      height: springH.value,
      borderRadius: springR.value,
      speed: Math.hypot(springW.velocity, springH.velocity),
      settled,
    });
  };

  const tick = (now: number): void => {
    const dt = Math.min((now - lastTime) / 1000, 1 / 30);
    lastTime = now;
    if (reducedMotion?.matches) {
      springW.snap();
      springH.snap();
      springR.snap();
    } else {
      springW.step(dt);
      springH.step(dt);
      springR.step(dt);
    }
    const settled = springW.settled && springH.settled && springR.settled;
    writeSize();
    applyLens(settled ? undefined : resolution);
    emit(settled);
    if (win && !settled) {
      rafId = win.requestAnimationFrame(tick);
    } else {
      rafId = undefined;
    }
  };

  const wake = (): void => {
    if (destroyed || !win || rafId !== undefined) return;
    lastTime = win.performance.now();
    rafId = win.requestAnimationFrame(tick);
  };

  // Match the frame to the initial size right away (crisp).
  writeSize();
  applyLens(undefined);
  emit(true);

  return {
    to(state) {
      if (state.width !== undefined) springW.target = state.width;
      if (state.height !== undefined) springH.target = state.height;
      if (state.borderRadius !== undefined) springR.target = state.borderRadius;
      wake();
    },
    set(state) {
      if (state.width !== undefined) {
        springW.value = state.width;
        springW.target = state.width;
        springW.velocity = 0;
      }
      if (state.height !== undefined) {
        springH.value = state.height;
        springH.target = state.height;
        springH.velocity = 0;
      }
      if (state.borderRadius !== undefined) {
        springR.value = state.borderRadius;
        springR.target = state.borderRadius;
        springR.velocity = 0;
      }
      writeSize();
      applyLens(undefined);
      emit(true);
    },
    get width() {
      return springW.value;
    },
    get height() {
      return springH.value;
    },
    get borderRadius() {
      return springR.value;
    },
    configure(config) {
      for (const spring of [springW, springH, springR]) {
        if (config.stiffness !== undefined) spring.stiffness = config.stiffness;
        if (config.damping !== undefined) spring.damping = config.damping;
      }
    },
    destroy() {
      destroyed = true;
      if (rafId !== undefined && win) {
        win.cancelAnimationFrame(rafId);
        rafId = undefined;
      }
    },
  };
}
