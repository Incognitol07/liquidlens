import {
  createLiquidLens,
  presets,
  type LensPresetName,
  type LiquidLens as LiquidLensHandle,
  type LiquidLensOptions,
} from "caustics";
import {
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";

export type { LiquidLensHandle, LiquidLensOptions, LensPresetName };
export { presets };

export interface UseLiquidLensOptions extends LiquidLensOptions {
  /**
   * Named starting point on the quality/cost curve (see `presets` in
   * caustics). Any option set explicitly overrides the preset's value.
   */
  preset?: LensPresetName;
}

function resolveOptions({ preset, ...options }: UseLiquidLensOptions): LiquidLensOptions {
  if (!preset) {
    return options;
  }
  // Explicitly passed options win over the preset, but an absent prop
  // (undefined) must not shadow the preset's value.
  const resolved: LiquidLensOptions = { ...presets[preset] };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      (resolved as Record<string, unknown>)[key] = value;
    }
  }
  return resolved;
}

/**
 * Attaches a liquid glass lens to `frameRef`, refracting the content of
 * `backdropRef`. The lens is created on mount and destroyed on unmount;
 * option changes are applied through the lens's cheap update path.
 *
 * Returns a ref to the lens handle for imperative per-frame calls
 * (`syncTo()` after moving the frame, `setIntensity()` for press feedback).
 */
export function useLiquidLens(
  frameRef: RefObject<HTMLElement | null>,
  backdropRef: RefObject<HTMLElement | null>,
  options: UseLiquidLensOptions = {},
): RefObject<LiquidLensHandle | null> {
  const lensRef = useRef<LiquidLensHandle | null>(null);

  // Keep the latest options available to the mount effect without
  // recreating the lens when they change.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const frame = frameRef.current;
    const backdrop = backdropRef.current;
    if (!frame || !backdrop) {
      return;
    }

    const lens = createLiquidLens(frame, backdrop, resolveOptions(optionsRef.current));
    lensRef.current = lens;

    return () => {
      lens.destroy();
      lensRef.current = null;
    };
  }, [frameRef, backdropRef]);

  useEffect(() => {
    lensRef.current?.update(resolveOptions(optionsRef.current));
  }, [
    options.preset,
    options.depth,
    options.curvature,
    options.splay,
    options.aberration,
    options.blur,
    options.saturation,
    options.lightAngle,
    options.specular,
    options.borderRadius,
    options.respectReducedMotion,
    options.trackScroll,
    options.trackContent,
  ]);

  return lensRef;
}

export interface LiquidLensProps extends UseLiquidLensOptions {
  /** Ref to the element behind the lens whose content gets refracted. */
  backdropRef: RefObject<HTMLElement | null>;
  className?: string;
  style?: CSSProperties;
  /** Rendered above the glass layers (e.g. a button label). */
  children?: ReactNode;
}

/**
 * A div that becomes a liquid glass lens over the element in `backdropRef`.
 * Position and size it like any other element (it must visually overlap the
 * backdrop); pass lens options as props, optionally starting from a preset:
 *
 *     <LiquidLens backdropRef={bg} preset="lean" depth={30} />
 */
export function LiquidLens({
  backdropRef,
  className,
  style,
  children,
  ...options
}: LiquidLensProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  useLiquidLens(frameRef, backdropRef, options);

  return (
    <div ref={frameRef} className={className} style={style}>
      {children != null && (
        <div style={{ position: "relative", zIndex: 1 }}>{children}</div>
      )}
    </div>
  );
}
