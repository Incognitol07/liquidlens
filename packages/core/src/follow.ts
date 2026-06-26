import { Spring } from "./spring";
import type { LiquidLens } from "./lens";

// Underdamped by default (damping < 2*sqrt(stiffness) ≈ 23.7), so the lens
// trails its target and wobbles to a stop instead of snapping.
const DEFAULT_STIFFNESS = 140;
const DEFAULT_DAMPING = 14;

// Maps spring speed (px/s) to stretch amount before the `squash` cap; tuned so
// a brisk drag reaches the cap and a settled spring is round.
const SQUASH_SPEED_SCALE = 0.00035;
// Below this stretch the distortion is invisible; skip composing it.
const SQUASH_EPSILON = 1e-3;

export interface SpringConfig {
  /** Spring constant; higher snaps to the target faster (default 140). */
  stiffness?: number;
  /**
   * Damping. Below `2 * sqrt(stiffness)` the motion overshoots and wobbles;
   * above it, it settles without bounce (default 14, i.e. wobbly).
   */
  damping?: number;
}

export interface LensFollowOptions extends SpringConfig {
  /** Where the frame starts, applied immediately (default 0, 0). */
  initial?: { x: number; y: number };
  /**
   * Velocity-driven squash-and-stretch (default 0, off). When > 0, the frame
   * stretches along its direction of travel while the spring is in motion and
   * relaxes back to round as it settles — the value is the maximum stretch
   * (≈0.12 is lively). The distortion is applied to the frame's transform
   * only; the refraction stays aligned, since `syncTo` is fed the translation
   * alone. The lens frame needs its own stacking/transform context for this to
   * read (a plain positioned element does).
   */
  squash?: number;
}

/**
 * Drives a lens frame's position with a spring. Retarget with `to`, jump with
 * `set`, read the live animated position from `x`/`y`, retune with `configure`.
 */
export interface LensFollower {
  /** Spring the frame toward (x, y) over the coming frames. */
  to(x: number, y: number): void;
  /** Jump to (x, y) immediately, with no animation. */
  set(x: number, y: number): void;
  readonly x: number;
  readonly y: number;
  /** Update the spring constants in place, keeping in-flight velocity. */
  configure(config: SpringConfig): void;
  /** Stop the loop and release listeners. */
  destroy(): void;
}

/**
 * Springs a lens frame toward a moving target. The lens does not own its own
 * position — the element is positioned by a CSS transform and `syncTo`
 * realigns the refraction to wherever it lands — so this is the opt-in layer
 * that turns that instant alignment into liquid lag-and-wobble: it drives two
 * springs in a `requestAnimationFrame` loop, writing the frame's `transform`
 * and calling `syncTo` each frame, and stops once both springs settle.
 *
 * It owns the frame's `transform`, so set size/shape through other CSS. Honors
 * `prefers-reduced-motion` by jumping straight to the target.
 *
 * @example
 * const lens = createLiquidLens(frame, backdrop, { depth: 60 });
 * const follow = createLensFollower(frame, lens, { stiffness: 180, damping: 18 });
 * // follow.to(x, y) from a click, a layout change, a snap point…
 */
export function createLensFollower(
  frame: HTMLElement,
  lens: Pick<LiquidLens, "syncTo">,
  options: LensFollowOptions = {},
): LensFollower {
  const win = frame.ownerDocument.defaultView;
  const springX = new Spring(options.initial?.x ?? 0, options.stiffness ?? DEFAULT_STIFFNESS, options.damping ?? DEFAULT_DAMPING);
  const springY = new Spring(options.initial?.y ?? 0, options.stiffness ?? DEFAULT_STIFFNESS, options.damping ?? DEFAULT_DAMPING);
  const squash = Math.max(0, options.squash ?? 0);

  const reducedMotion = win?.matchMedia?.("(prefers-reduced-motion: reduce)");
  let rafId: number | undefined;
  let lastTime = 0;
  let destroyed = false;

  const write = (x: number, y: number): void => {
    let transform = `translate3d(${x}px, ${y}px, 0)`;
    if (squash > 0) {
      // Stretch along the heading by the spring's current speed, capped at
      // `squash`; decays to round as the spring settles. The refraction is
      // NOT distorted — only the frame's transform carries the scale, and
      // syncTo below gets the translation alone.
      const vx = springX.velocity;
      const vy = springY.velocity;
      const stretch = Math.min(Math.hypot(vx, vy) * SQUASH_SPEED_SCALE, squash);
      if (stretch > SQUASH_EPSILON) {
        const angle = Math.atan2(vy, vx);
        transform += ` rotate(${angle}rad) scale(${1 + stretch}, ${1 - stretch}) rotate(${-angle}rad)`;
      }
    }
    frame.style.transform = transform;
    lens.syncTo(x, y);
  };

  const tick = (now: number): void => {
    const dt = Math.min((now - lastTime) / 1000, 1 / 30);
    lastTime = now;
    if (reducedMotion?.matches) {
      springX.snap();
      springY.snap();
    } else {
      springX.step(dt);
      springY.step(dt);
    }
    write(springX.value, springY.value);
    if (win && (!springX.settled || !springY.settled)) {
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

  // Place the frame at its initial position right away.
  write(springX.value, springY.value);

  return {
    to(x, y) {
      springX.target = x;
      springY.target = y;
      wake();
    },
    set(x, y) {
      springX.value = x;
      springX.target = x;
      springX.velocity = 0;
      springY.value = y;
      springY.target = y;
      springY.velocity = 0;
      write(x, y);
    },
    get x() {
      return springX.value;
    },
    get y() {
      return springY.value;
    },
    configure(config) {
      if (config.stiffness !== undefined) {
        springX.stiffness = config.stiffness;
        springY.stiffness = config.stiffness;
      }
      if (config.damping !== undefined) {
        springX.damping = config.damping;
        springY.damping = config.damping;
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

export interface DraggableLensOptions extends LensFollowOptions {
  /**
   * Refraction multiplier applied on grab and released on drop (default 1.4),
   * so the glass swells while held. Set 1 to disable the press feedback.
   */
  grabIntensity?: number;
  /**
   * Clamp the target on each move, e.g. to keep the lens inside a container.
   * Receives and returns a position in the frame's transform coordinate space.
   */
  clamp?: (position: { x: number; y: number }) => { x: number; y: number };
  /**
   * Freeze backdrop-content rebuilds for the duration of the drag (default
   * true) — see {@link LiquidLens.freeze}. A no-op for a static backdrop; for
   * a backdrop that mutates each frame it keeps the drag transform-only
   * instead of paying a full clone rebuild per frame. Set false to keep the
   * refraction's content live while dragging.
   */
  freezeContent?: boolean;
}

export interface DraggableLens {
  /** Imperatively spring the lens to a position (e.g. reset to center). */
  to(x: number, y: number): void;
  /** Update the spring constants in place. */
  configure(config: SpringConfig): void;
  /** Detach the pointer listeners, stop the loop, and restore `touch-action`. */
  destroy(): void;
}

/**
 * Makes a lens frame draggable with a spring follow: the pointer sets the
 * spring target and the frame trails and wobbles to it (see
 * {@link createLensFollower}), swelling its refraction while held. This is the
 * "interactive liquid glass" hero case in one call; `stiffness`/`damping` are
 * the feel knobs.
 *
 * Sets `touch-action: none` on the frame for the duration so touch drags don't
 * scroll the page, and restores it on `destroy`.
 *
 * @example
 * const lens = createLiquidLens(frame, backdrop, { depth: 60 });
 * const drag = makeLensDraggable(frame, lens, { stiffness: 140, damping: 14 });
 * // later: drag.destroy();
 */
export function makeLensDraggable(
  frame: HTMLElement,
  lens: Pick<LiquidLens, "syncTo" | "setIntensity" | "freeze" | "unfreeze">,
  options: DraggableLensOptions = {},
): DraggableLens {
  const follower = createLensFollower(frame, lens, options);
  const grabIntensity = options.grabIntensity ?? 1.4;
  const clamp = options.clamp;
  const freezeContent = options.freezeContent ?? true;

  let active = false;
  let grabX = 0;
  let grabY = 0;

  const onPointerDown = (event: PointerEvent): void => {
    active = true;
    // Grab offset against the live animated position, so picking the lens up
    // mid-wobble doesn't make it jump.
    grabX = event.clientX - follower.x;
    grabY = event.clientY - follower.y;
    frame.setPointerCapture?.(event.pointerId);
    if (grabIntensity !== 1) {
      lens.setIntensity(grabIntensity);
    }
    // Hold the backdrop content still for the drag so a mutating backdrop
    // cannot trigger a full clone rebuild on each frame.
    if (freezeContent) {
      lens.freeze();
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!active) return;
    let next = { x: event.clientX - grabX, y: event.clientY - grabY };
    if (clamp) next = clamp(next);
    follower.to(next.x, next.y);
  };

  const onPointerEnd = (event: PointerEvent): void => {
    if (!active) return;
    active = false;
    frame.releasePointerCapture?.(event.pointerId);
    lens.setIntensity(1);
    if (freezeContent) {
      lens.unfreeze();
    }
  };

  frame.addEventListener("pointerdown", onPointerDown);
  frame.addEventListener("pointermove", onPointerMove);
  frame.addEventListener("pointerup", onPointerEnd);
  frame.addEventListener("pointercancel", onPointerEnd);

  const priorTouchAction = frame.style.touchAction;
  frame.style.touchAction = "none";

  return {
    to: follower.to,
    configure: follower.configure,
    destroy() {
      frame.removeEventListener("pointerdown", onPointerDown);
      frame.removeEventListener("pointermove", onPointerMove);
      frame.removeEventListener("pointerup", onPointerEnd);
      frame.removeEventListener("pointercancel", onPointerEnd);
      frame.style.touchAction = priorTouchAction;
      follower.destroy();
    },
  };
}
