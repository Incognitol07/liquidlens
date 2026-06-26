import {
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { Spring, type LiquidLens as LiquidLensHandle } from "@liquidlens/core";

// Underdamped by default (damping < 2*sqrt(stiffness) ≈ 23.7), so the lens
// trails the cursor and wobbles to a stop instead of snapping.
const DEFAULT_STIFFNESS = 140;
const DEFAULT_DAMPING = 14;

// useLayoutEffect warns during SSR; fall back to useEffect on the server.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export interface SpringConfig {
  /** Spring constant; higher snaps to the target faster (default 140). */
  stiffness?: number;
  /**
   * Damping. Below `2 * sqrt(stiffness)` the motion overshoots and wobbles;
   * above it, it settles without bounce (default 14, i.e. wobbly).
   */
  damping?: number;
}

export interface LensFollowConfig extends SpringConfig {
  /** Where the frame starts, applied before first paint (default 0, 0). */
  initial?: { x: number; y: number };
}

/**
 * Imperative handle returned by {@link useLensFollow}: retarget with `to`,
 * jump with `set`, read the live animated position from `x`/`y`. The
 * functions are stable across renders, so they are safe in effect deps.
 */
export interface LensFollowController {
  /** Spring the frame toward (x, y) over the coming frames. */
  to(x: number, y: number): void;
  /** Jump to (x, y) immediately, with no animation. */
  set(x: number, y: number): void;
  readonly x: number;
  readonly y: number;
}

/**
 * Springs a lens frame toward a moving target. The lens does not own its own
 * position — the element is positioned by a CSS transform, and `syncTo`
 * realigns the refraction to wherever it lands — so this hook is what turns
 * that instant alignment into liquid lag-and-wobble: it drives two springs in
 * a `requestAnimationFrame` loop, writing the frame's `transform` and calling
 * `syncTo` each frame, and stops once both springs settle.
 *
 * Position is applied imperatively (no per-frame React re-render). The hook
 * owns the frame's `transform`, so set size/shape via other CSS, not a
 * transform of your own. Honors `prefers-reduced-motion` by jumping straight
 * to the target.
 *
 * @example
 * const frameRef = useRef<HTMLDivElement>(null);
 * const lens = useLiquidLens(frameRef, backdropRef, { preset: "lean" });
 * const follow = useLensFollow(frameRef, lens, { stiffness: 180, damping: 18 });
 * // follow.to(x, y) from anywhere — a click, a layout change, a snap point
 */
export function useLensFollow(
  frameRef: RefObject<HTMLElement | null>,
  lensRef: RefObject<LiquidLensHandle | null>,
  config: LensFollowConfig = {},
): LensFollowController {
  const stiffness = config.stiffness ?? DEFAULT_STIFFNESS;
  const damping = config.damping ?? DEFAULT_DAMPING;

  const springX = useRef<Spring | null>(null);
  const springY = useRef<Spring | null>(null);
  if (!springX.current) springX.current = new Spring(0, stiffness, damping);
  if (!springY.current) springY.current = new Spring(0, stiffness, damping);

  // Update the live springs in place when the config changes; recreating them
  // would drop their in-flight velocity mid-motion.
  useEffect(() => {
    const sx = springX.current!;
    const sy = springY.current!;
    sx.stiffness = stiffness;
    sx.damping = damping;
    sy.stiffness = stiffness;
    sy.damping = damping;
  }, [stiffness, damping]);

  const rafId = useRef<number | undefined>(undefined);
  const lastTime = useRef(0);
  const reduced = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduced.current = query.matches;
    const onChange = (): void => {
      reduced.current = query.matches;
    };
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);

  // Build the controller once; everything it touches is a ref or a global, so
  // the first render's closures stay correct for the component's whole life.
  const controller = useRef<LensFollowController | null>(null);
  if (!controller.current) {
    const write = (x: number, y: number): void => {
      const frame = frameRef.current;
      if (frame) {
        frame.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      }
      lensRef.current?.syncTo(x, y);
    };

    function tick(now: number): void {
      const sx = springX.current!;
      const sy = springY.current!;
      const dt = Math.min((now - lastTime.current) / 1000, 1 / 30);
      lastTime.current = now;
      if (reduced.current) {
        sx.snap();
        sy.snap();
      } else {
        sx.step(dt);
        sy.step(dt);
      }
      write(sx.value, sy.value);
      if (!sx.settled || !sy.settled) {
        rafId.current = requestAnimationFrame(tick);
      } else {
        rafId.current = undefined;
      }
    }

    const wake = (): void => {
      if (rafId.current === undefined && typeof requestAnimationFrame !== "undefined") {
        lastTime.current = performance.now();
        rafId.current = requestAnimationFrame(tick);
      }
    };

    controller.current = {
      to(x, y) {
        springX.current!.target = x;
        springY.current!.target = y;
        wake();
      },
      set(x, y) {
        const sx = springX.current!;
        const sy = springY.current!;
        sx.value = x;
        sx.target = x;
        sx.velocity = 0;
        sy.value = y;
        sy.target = y;
        sy.velocity = 0;
        write(x, y);
      },
      get x() {
        return springX.current!.value;
      },
      get y() {
        return springY.current!.value;
      },
    };
  }

  // Place the frame at its initial position before the first paint.
  const initialX = config.initial?.x ?? 0;
  const initialY = config.initial?.y ?? 0;
  useIsoLayoutEffect(() => {
    controller.current!.set(initialX, initialY);
    // Run once: subsequent positions arrive through `to`/`set`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stop the loop when the component unmounts.
  useEffect(
    () => () => {
      if (rafId.current !== undefined && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(rafId.current);
      }
    },
    [],
  );

  return controller.current;
}

export interface DraggableLensConfig extends LensFollowConfig {
  /**
   * Refraction multiplier applied on grab and released on drop (default 1.4),
   * so the glass swells while held. Set 1 to disable the press feedback.
   */
  grabIntensity?: number;
  /**
   * Clamp the target on each move, e.g. to keep the lens inside a container.
   * Receives and returns a position in the same coordinate space as the
   * frame's transform.
   */
  clamp?: (position: { x: number; y: number }) => { x: number; y: number };
}

export interface DraggableLensHandlers {
  onPointerDown(event: ReactPointerEvent): void;
  onPointerMove(event: ReactPointerEvent): void;
  onPointerUp(event: ReactPointerEvent): void;
  onPointerCancel(event: ReactPointerEvent): void;
}

export interface DraggableLens {
  /** Spread onto the frame element to make it drag with a spring follow. */
  handlers: DraggableLensHandlers;
  /** Imperatively spring the lens to a position (e.g. reset to center). */
  to(x: number, y: number): void;
}

/**
 * Makes a lens frame draggable with a spring follow: the pointer sets the
 * spring target and the frame trails and wobbles to it (see
 * {@link useLensFollow}), swelling its refraction while held. This is the
 * "interactive liquid glass" hero case as a one-liner; `stiffness`/`damping`
 * are the feel knobs.
 *
 * Give the frame `touch-action: none` so touch drags don't scroll the page.
 *
 * @example
 * const frameRef = useRef<HTMLDivElement>(null);
 * const lens = useLiquidLens(frameRef, backdropRef, { depth: 60 });
 * const { handlers } = useDraggableLens(frameRef, lens, {
 *   stiffness: 140,
 *   damping: 14,
 *   initial: { x: 120, y: 80 },
 * });
 * return <div ref={frameRef} className="drop" style={{ touchAction: "none" }} {...handlers} />;
 */
export function useDraggableLens(
  frameRef: RefObject<HTMLElement | null>,
  lensRef: RefObject<LiquidLensHandle | null>,
  config: DraggableLensConfig = {},
): DraggableLens {
  const follow = useLensFollow(frameRef, lensRef, config);
  const grabIntensity = config.grabIntensity ?? 1.4;
  const clamp = config.clamp;

  // Drag bookkeeping in a ref so moves never trigger a React re-render.
  const drag = useRef({ active: false, dx: 0, dy: 0 });

  const endDrag = (event: ReactPointerEvent): void => {
    if (!drag.current.active) return;
    drag.current.active = false;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    lensRef.current?.setIntensity(1);
  };

  const handlers: DraggableLensHandlers = {
    onPointerDown(event) {
      // Grab offset against the live animated position, so picking the lens
      // up mid-wobble doesn't make it jump.
      drag.current = {
        active: true,
        dx: event.clientX - follow.x,
        dy: event.clientY - follow.y,
      };
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      if (grabIntensity !== 1) {
        lensRef.current?.setIntensity(grabIntensity);
      }
    },
    onPointerMove(event) {
      if (!drag.current.active) return;
      let next = {
        x: event.clientX - drag.current.dx,
        y: event.clientY - drag.current.dy,
      };
      if (clamp) next = clamp(next);
      follow.to(next.x, next.y);
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  };

  return { handlers, to: follow.to };
}
