import {
  createLiquidLens,
  presets,
  type LensPresetName,
  type LiquidLens as LiquidLensHandle,
  type LiquidLensOptions,
} from "@liquidlens/core";
import {
  forwardRef,
  useEffect,
  useRef,
  type CSSProperties,
  type ElementType,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";

export type { LiquidLensHandle, LiquidLensOptions, LensPresetName };
export { presets };

/**
 * Every key that `<LiquidLens>` consumes as a lens option rather than
 * forwarding to the rendered element. Anything not listed here is treated
 * as a DOM prop and spread onto the frame, so event handlers (`onPointerDown`),
 * `id`, `aria-*`, `data-*`, etc. reach the element as expected.
 */
const LENS_OPTION_KEYS = new Set<string>([
  "preset",
  "depth",
  "curvature",
  "splay",
  "aberration",
  "blur",
  "saturation",
  "lightAngle",
  "specular",
  "borderRadius",
  "respectReducedMotion",
  "trackScroll",
  "trackContent",
  "onReady",
]);

export interface UseLiquidLensOptions extends LiquidLensOptions {
  /**
   * Named starting point on the quality/cost curve (see `presets` in
   * liquidlens). Any option set explicitly overrides the preset's value.
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
 * `backdropRef`, or, when `backdropRef` is omitted, of the nearest
 * ancestor that paints a background. The lens is created on mount and
 * destroyed on unmount; option changes are applied through the lens's
 * cheap update path.
 *
 * Returns a ref to the lens handle for imperative per-frame calls
 * (`syncTo()` after moving the frame, `setIntensity()` for press feedback).
 *
 * @example
 * const frameRef = useRef<HTMLDivElement>(null);
 * const lens = useLiquidLens(frameRef, undefined, { preset: "lean" });
 * // lens.current?.syncTo(x, y) from a drag handler
 */
export function useLiquidLens(
  frameRef: RefObject<HTMLElement | null>,
  backdropRef?: RefObject<HTMLElement | null>,
  options: UseLiquidLensOptions = {},
): RefObject<LiquidLensHandle | null> {
  const lensRef = useRef<LiquidLensHandle | null>(null);

  // Keep the latest options available to the mount effect without
  // recreating the lens when they change.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) {
      return;
    }
    // A backdrop ref that exists but is not attached yet means the consumer
    // intends a specific element; do not fall back to auto-detection.
    const backdrop = backdropRef?.current;
    if (backdropRef && !backdrop) {
      return;
    }

    const lens = backdrop
      ? createLiquidLens(frame, backdrop, resolveOptions(optionsRef.current))
      : createLiquidLens(frame, resolveOptions(optionsRef.current));
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

export interface LiquidLensProps
  extends UseLiquidLensOptions,
    HTMLAttributes<HTMLElement> {
  /**
   * Ref to the element behind the lens whose content gets refracted.
   * Omit it to refract the nearest ancestor that paints a background.
   */
  backdropRef?: RefObject<HTMLElement | null>;
  /** The element type to render as the glass frame (default "div"). */
  as?: ElementType;
  /** Rendered above the glass layers (e.g. a button label). */
  children?: ReactNode;
  /**
   * The element type for the wrapper that lifts `children` above the glass
   * layers (default "div"). Set to `null` to render `children` with no
   * wrapper at all — you then own keeping them stacked above the refraction
   * (e.g. give them `position: relative; z-index: 1`).
   */
  contentAs?: ElementType | null;
  /** Class applied to the content wrapper. */
  contentClassName?: string;
  /**
   * Style merged onto the content wrapper. Defaults to
   * `{ position: "relative", zIndex: 1 }`; anything here overrides those, so
   * you can turn the wrapper into a flex container, add padding, etc.
   */
  contentStyle?: CSSProperties;
}

/**
 * An element that becomes a liquid glass lens. Position and size it like
 * any other element; pass lens options as props, optionally starting from
 * a preset. A `ref` receives the imperative lens handle for per-frame
 * calls.
 *
 * @example
 * <LiquidLens preset="lean" depth={30}>Menu</LiquidLens>
 *
 * @example
 * const lens = useRef<LiquidLensHandle>(null);
 * <LiquidLens as="nav" ref={lens} backdropRef={heroRef}>
 *   <Toolbar />
 * </LiquidLens>
 * // lens.current?.setIntensity(1.5) on press
 */
export const LiquidLens = forwardRef<LiquidLensHandle, LiquidLensProps>(
  function LiquidLens(
    { backdropRef, as, children, contentAs, contentClassName, contentStyle, ...rest },
    ref,
  ) {
    const frameRef = useRef<HTMLElement | null>(null);

    // Split the remaining props: known lens-option keys configure the lens,
    // everything else (className, style, event handlers, id, aria-*, data-*)
    // is forwarded to the rendered element.
    const options: UseLiquidLensOptions = {};
    const domProps: Record<string, unknown> = {};
    for (const key of Object.keys(rest)) {
      const value = (rest as Record<string, unknown>)[key];
      if (LENS_OPTION_KEYS.has(key)) {
        (options as Record<string, unknown>)[key] = value;
      } else {
        domProps[key] = value;
      }
    }

    const lensRef = useLiquidLens(frameRef, backdropRef, options);

    // Hand the lens handle to the consumer's ref. Declared after
    // useLiquidLens so this effect runs once the lens exists.
    useEffect(() => {
      if (!ref) {
        return;
      }
      if (typeof ref === "function") {
        ref(lensRef.current);
        return () => ref(null);
      }
      ref.current = lensRef.current;
      return () => {
        ref.current = null;
      };
    }, [ref, lensRef]);

    const Component = (as ?? "div") as ElementType;

    let content: ReactNode = null;
    if (children != null) {
      if (contentAs === null) {
        // Caller opted out of the wrapper and takes responsibility for
        // stacking the children above the refraction layer.
        content = children;
      } else {
        const ContentComponent = (contentAs ?? "div") as ElementType;
        content = (
          <ContentComponent
            className={contentClassName}
            style={{ position: "relative", zIndex: 1, ...contentStyle }}
          >
            {children}
          </ContentComponent>
        );
      }
    }

    return (
      <Component ref={frameRef} {...domProps}>
        {content}
      </Component>
    );
  },
);
