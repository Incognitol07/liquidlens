import { useEffect, useRef, type RefObject } from "react";
import {
  createLensFollower,
  makeLensDraggable,
  type DraggableLens,
  type DraggableLensOptions,
  type LensFollower,
  type LensFollowOptions,
  type LiquidLens as LiquidLensHandle,
} from "@liquidlens/core";

export type {
  SpringConfig,
  LensFollowOptions,
  DraggableLensOptions,
} from "@liquidlens/core";

/** Stable handle returned by {@link useLensFollow}; proxies to the live follower. */
export interface ReactLensFollower {
  to(x: number, y: number): void;
  set(x: number, y: number): void;
  /** Set the press level (0..1) for the `pressScale` squish. */
  press(level: number): void;
  readonly x: number;
  readonly y: number;
}

/**
 * React wrapper around the core {@link createLensFollower}: springs a lens
 * frame toward a moving target, writing its transform and calling `syncTo`
 * each frame, with no per-frame React re-render. Pair it with the frame ref
 * you gave `useLiquidLens` and the lens handle it returns.
 *
 * `stiffness`/`damping` update the live spring; `initial` is applied once.
 *
 * @example
 * const frameRef = useRef<HTMLDivElement>(null);
 * const lens = useLiquidLens(frameRef, backdropRef, { preset: "lean" });
 * const follow = useLensFollow(frameRef, lens, { stiffness: 180, damping: 18 });
 * // follow.to(x, y) from a click, a layout change, a snap point…
 */
export function useLensFollow(
  frameRef: RefObject<HTMLElement | null>,
  lensRef: RefObject<LiquidLensHandle | null>,
  config: LensFollowOptions = {},
): ReactLensFollower {
  const followerRef = useRef<LensFollower | null>(null);

  const facadeRef = useRef<ReactLensFollower | null>(null);
  if (!facadeRef.current) {
    facadeRef.current = {
      to: (x, y) => followerRef.current?.to(x, y),
      set: (x, y) => followerRef.current?.set(x, y),
      press: (level) => followerRef.current?.press(level),
      get x() {
        return followerRef.current?.x ?? 0;
      },
      get y() {
        return followerRef.current?.y ?? 0;
      },
    };
  }

  // Keep `initial`/etc. available to the mount effect without recreating the
  // follower when an inline config object changes identity each render.
  const configRef = useRef(config);
  configRef.current = config;

  // The lens handle exists by the time this effect runs (useLiquidLens is
  // called first, so its mount effect created the lens). Recreate only if the
  // ref objects themselves change.
  useEffect(() => {
    const frame = frameRef.current;
    const lens = lensRef.current;
    if (!frame || !lens) return;
    const follower = createLensFollower(frame, lens, configRef.current);
    followerRef.current = follower;
    return () => {
      follower.destroy();
      followerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameRef, lensRef]);

  // Live-update the spring constants in place.
  useEffect(() => {
    followerRef.current?.configure({
      stiffness: config.stiffness,
      damping: config.damping,
    });
  }, [config.stiffness, config.damping]);

  return facadeRef.current;
}

/** Stable handle returned by {@link useDraggableLens}. */
export interface ReactDraggableLens {
  /** Imperatively spring the lens to a position (e.g. reset to center). */
  to(x: number, y: number): void;
}

/**
 * React wrapper around the core {@link makeLensDraggable}: makes the lens
 * frame drag with a spring follow and a press swell, attaching its pointer
 * listeners to the frame (including `touch-action: none`) for you. The
 * "interactive liquid glass" hero case as a one-liner.
 *
 * @example
 * const frameRef = useRef<HTMLDivElement>(null);
 * const lens = useLiquidLens(frameRef, backdropRef, { depth: 60 });
 * useDraggableLens(frameRef, lens, { stiffness: 140, damping: 14, initial: { x: 120, y: 80 } });
 * return <div ref={frameRef} className="drop" />;
 */
export function useDraggableLens(
  frameRef: RefObject<HTMLElement | null>,
  lensRef: RefObject<LiquidLensHandle | null>,
  config: DraggableLensOptions = {},
): ReactDraggableLens {
  const dragRef = useRef<DraggableLens | null>(null);

  const facadeRef = useRef<ReactDraggableLens | null>(null);
  if (!facadeRef.current) {
    facadeRef.current = { to: (x, y) => dragRef.current?.to(x, y) };
  }

  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    const frame = frameRef.current;
    const lens = lensRef.current;
    if (!frame || !lens) return;
    const draggable = makeLensDraggable(frame, lens, configRef.current);
    dragRef.current = draggable;
    return () => {
      draggable.destroy();
      dragRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameRef, lensRef]);

  useEffect(() => {
    dragRef.current?.configure({
      stiffness: config.stiffness,
      damping: config.damping,
    });
  }, [config.stiffness, config.damping]);

  return facadeRef.current;
}
