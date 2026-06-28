import { accessibleEffect, CONTRAST_RING, type AccessibilityFlags } from "./a11y";
import { createAdaptiveLayer, type AdaptiveLayer, type AdaptiveOptions } from "./adaptive";
import { createGlassFilter } from "./filter";
import { presets } from "./presets";
import { resolveShape, type LensShape, type LensShapeName } from "./shape";
import { performanceTier } from "./tier";

const LENS_MARKER = "data-liquidlens";

export interface LiquidLensOptions {
  /** Maximum displacement at the rim, in px (default 24) */
  depth?: number;
  /** 0..1: width of the curved rim relative to the lens size (default 0.4) */
  curvature?: number;
  /** 0..1: blends displacement from edge-normal to radial (default 0.59) */
  splay?: number;
  /** 0..1: chromatic aberration strength (default 0.05) */
  aberration?: number;
  /** Blur in px applied to the refracted content (default 0.2) */
  blur?: number;
  /** Saturation multiplier for the refracted content (default 1.15) */
  saturation?: number;
  /** Light direction in degrees: 0 lights the top edge, 90 the right edge (default 0) */
  lightAngle?: number;
  /** 0..1: strength of the specular rim highlight (default 1) */
  specular?: number;
  /** CSS color of the specular highlight (default white) */
  specularColor?: string;
  /**
   * Tightness of the specular hot spot (default 10). Higher gives a smaller,
   * glossier highlight; lower a softer, broader sheen.
   */
  specularSharpness?: number;
  /**
   * CSS color overlaid on the refracted content to tint the glass, like
   * smoked or colored glass. Unset means no tint. Pair it with a matching
   * frame `background` if you want the tint visible before the glass is ready.
   */
  tint?: string;
  /** 0..1: strength of the tint overlay (default 0.2) */
  tintOpacity?: number;
  /** Corner radius in px; defaults to the frame's computed border-radius */
  borderRadius?: number;
  /**
   * The lens silhouette, followed by both the refraction and the specular
   * rim. Either a built-in name (`"rect"`, a rounded rectangle, the default,
   * using `borderRadius`; `"pill"` for fully rounded ends; `"ellipse"`; or
   * `"squircle"`) or a custom {@link LensShape} signed-distance sampler for
   * any silhouette you can describe. `borderRadius` is ignored unless the
   * shape is a rounded rectangle.
   */
  shape?: LensShapeName | LensShape;
  /**
   * When true (the default), honors the OS "prefers reduced motion"
   * setting by pinning `setIntensity` at 1, so press-swell and similar
   * per-frame feedback goes still for users who asked for less motion.
   * The static refraction itself is unaffected; it is not motion.
   */
  respectReducedMotion?: boolean;
  /**
   * The frosted treatment for the OS "reduced transparency" setting: the glass
   * blurs more and drops chromatic aberration so it obscures more of the
   * content behind it. `"auto"` (the default) follows the OS preference; `true`
   * forces it on (e.g. an in-app accessibility toggle), `false` ignores it.
   */
  reducedTransparency?: boolean | "auto";
  /**
   * The high-contrast treatment for the OS "increased contrast" setting: the
   * refraction flattens, the specular shimmer drops, and a contrasting border
   * is drawn around the frame so the element reads as a crisp high-contrast
   * chip. `"auto"` (the default) follows the OS preference; `true` forces it
   * on, `false` ignores it.
   */
  increasedContrast?: boolean | "auto";
  /**
   * When true (the default), the lens listens for scrolls anywhere in the
   * document and keeps the refraction aligned by itself: the backdrop
   * scrolling under a fixed lens, scrollable containers inside the
   * backdrop, and page scrolls that move the frame relative to the
   * backdrop. Set false to drive alignment manually through `sync()`.
   */
  trackScroll?: boolean;
  /**
   * When true (the default), watches the backdrop for DOM changes and
   * rebuilds the refracted copy when they happen, coalesced to at most one
   * rebuild per frame. A rebuild costs about as much as creating the lens,
   * so for a very large backdrop that mutates constantly, set false and
   * recreate the lens at moments you choose.
   */
  trackContent?: boolean;
  /**
   * Called once, after the first refraction has been generated and the
   * browser has had a frame to paint it. Useful for revealing the frame
   * only when the glass is ready, or for chaining an entrance animation.
   */
  onReady?: () => void;
  /**
   * Makes the glass read the backdrop under it and adapt to stay legible, the
   * way Liquid Glass "continuously adapts based on what's behind it": a
   * backdrop-aware grounding shadow, light/dark ink flipping for text and
   * glyphs, and tone-matched tinting. `true` enables all three with defaults;
   * an {@link AdaptiveOptions} object tunes or disables individual behaviours.
   * Off by default — it samples backdrop pixels on movement, so it is opt-in.
   * Runtime-toggleable through {@link LiquidLens.update}.
   *
   * Sampling needs readable backdrop pixels (an image/canvas/video element, a
   * CSS `background-image`, or a `background-color`); over an un-sampleable
   * backdrop the glass keeps a neutral grounding shadow. Pass
   * `adaptive: { luminance }` to supply the brightness yourself.
   */
  adaptive?: boolean | AdaptiveOptions;
}

export interface LiquidLens {
  /**
   * Merges in new options and regenerates the displacement and specular
   * maps. Every call pays the full map cost regardless of which option
   * changed, so it is for real changes, not per-frame tweening; per-frame
   * paths have cheap dedicated calls (`syncTo` for movement, `setIntensity`
   * for strength). `resolution` (samples per CSS px) overrides the
   * devicePixelRatio default; pass ~0.5 when updating every frame of a
   * size morph.
   */
  update(options?: LiquidLensOptions, resolution?: number): void;
  /**
   * Re-aligns the backdrop copy with the real backdrop: measures both
   * elements and mirrors the backdrop's scroll position into the copy.
   * Scrolling is handled automatically while `trackScroll` is on, so this
   * is for movement the lens cannot see, such as a layout change that
   * shifted the frame. Forces a layout pass; on per-frame paths where the
   * position is already known, prefer `syncTo`.
   */
  sync(): void;
  /**
   * Like `sync`, but takes the frame's offset from the backdrop's top-left
   * corner instead of measuring it, so it never reads layout, making it safe
   * to call on every frame of a drag. Decorative rotate/scale transforms on the
   * frame should be excluded from the offset.
   */
  syncTo(offsetX: number, offsetY: number): void;
  /**
   * Scales the refraction strength relative to the configured depth without
   * regenerating the map. Cheap; intended for per-frame interaction
   * feedback such as swelling on press. Ignored while the user prefers
   * reduced motion (unless `respectReducedMotion` is false).
   */
  setIntensity(factor: number): void;
  /**
   * Hides the refraction and suspends its upkeep (scroll mirroring,
   * content rebuilds) without tearing anything down. Use for a lens that
   * scrolled off-screen; `resume()` catches up on everything missed.
   */
  pause(): void;
  /** Reverses `pause()` and re-syncs position, scroll, and content. */
  resume(): void;
  /**
   * Suspends only the backdrop-content rebuild (the expensive `cloneNode`),
   * while the lens keeps rendering and stays scroll-aligned. Intended to wrap
   * a heavy interaction such as a drag: with a backdrop that mutates every
   * frame, `trackContent` would otherwise rebuild the whole clone each frame.
   * The refraction shows the backdrop as of the freeze until `unfreeze`.
   * Cheap and idempotent; unrelated to `pause`.
   */
  freeze(): void;
  /** Reverses `freeze()`, rebuilding the clone once if the backdrop changed meanwhile. */
  unfreeze(): void;
  /** The lens's current options, including defaults, as a read-only snapshot. */
  readonly options: Readonly<LiquidLensOptions>;
  /**
   * Removes everything the lens added to the document and restores the
   * `position`/`overflow` inline styles the frame had before the lens
   * changed them.
   */
  destroy(): void;
}

type ResolvedOptions = Required<
  Omit<
    LiquidLensOptions,
    | "adaptive"
    | "borderRadius"
    | "onReady"
    | "shape"
    | "specularColor"
    | "specularSharpness"
    | "tint"
    | "tintOpacity"
  >
>;

/**
 * Defaults adapt to the device: the full preset where there is CPU headroom
 * for it, the lean preset on devices that rasterize the filter pipeline too
 * slowly for the full look (see `performanceTier`). Explicit options always
 * win, so callers who want one look everywhere pass a preset themselves.
 */
function defaultsFor(win: (Window & typeof globalThis) | null): ResolvedOptions {
  return {
    ...presets[performanceTier(win) === "low" ? "lean" : "full"],
    respectReducedMotion: true,
    reducedTransparency: "auto",
    increasedContrast: "auto",
    trackScroll: true,
    trackContent: true,
  };
}

function assertElement(value: unknown, name: string): asserts value is HTMLElement {
  if (!value || (value as Node).nodeType !== 1) {
    const got = value === null ? "null" : value === undefined ? "undefined" : typeof value;
    throw new TypeError(
      `liquidlens: ${name} must be an HTMLElement, got ${got}. ` +
        `If you queried for it, check that the selector matched.`,
    );
  }
}

/** Options expected in 0..1; values outside look broken, not stronger. */
const UNIT_RANGE_OPTIONS = ["curvature", "splay", "aberration", "specular"] as const;
const NON_NEGATIVE_OPTIONS = ["depth", "blur", "saturation", "borderRadius"] as const;

function warnOnSuspectOptions(options: LiquidLensOptions): void {
  for (const key of UNIT_RANGE_OPTIONS) {
    const value = options[key];
    if (value !== undefined && (value < 0 || value > 1)) {
      console.warn(`liquidlens: ${key} is expected in 0..1, got ${value}; the effect may look broken.`);
    }
  }
  for (const key of NON_NEGATIVE_OPTIONS) {
    const value = options[key];
    if (value !== undefined && value < 0) {
      console.warn(`liquidlens: ${key} must not be negative, got ${value}.`);
    }
  }
}

/**
 * Picks a backdrop for a frame when the caller did not name one: the
 * nearest ancestor that paints its own background (a color or an image),
 * because that is the element a viewer would say the glass sits on.
 * Falls back to the body.
 */
function findBackdrop(frame: HTMLElement): HTMLElement {
  const doc = frame.ownerDocument;
  for (let el = frame.parentElement; el && el !== doc.body; el = el.parentElement) {
    const style = getComputedStyle(el);
    const paintsColor =
      style.backgroundColor !== "transparent" &&
      style.backgroundColor !== "rgba(0, 0, 0, 0)";
    if (paintsColor || style.backgroundImage !== "none") {
      return el;
    }
  }
  if (!doc.body) {
    throw new Error(
      "liquidlens: no backdrop given and the document has no body to fall back to.",
    );
  }
  return doc.body;
}

/**
 * Turns `frame` into a liquid-glass lens floating over `backdrop`. When
 * `backdrop` is omitted, the nearest ancestor that paints a background is
 * used (falling back to the body); pass it explicitly when the glass
 * should bend something other than what it visually sits on.
 *
 * The lens cannot sample the page behind it, so it clones `backdrop` into
 * itself and keeps the clone pixel-aligned with the original; the SVG filter
 * then bends, fringes, and saturates that copy and blends a specular rim
 * light over it for the glossy edge. The frame must be visually on top of
 * the backdrop. The lens gives the frame `position: relative` (only if it
 * was static) and `overflow: hidden` for the duration of its life;
 * `destroy()` restores what was there before.
 *
 * Scrolling (the backdrop under the lens, scrollable containers inside
 * it, and page scrolls that move the frame) is mirrored into the copy
 * automatically (see `trackScroll`), and DOM changes in the backdrop
 * rebuild the copy once per frame (see `trackContent`). With both turned
 * off the clone is a static snapshot.
 *
 * @example
 * // Auto-detected backdrop: glass on whatever the dock sits on.
 * const lens = createLiquidLens(document.querySelector<HTMLElement>(".dock")!);
 *
 * @example
 * // Explicit backdrop, preset base, one overridden knob.
 * const lens = createLiquidLens(dock, hero, { ...presets.lean, depth: 30 });
 * dock.addEventListener("pointerdown", () => lens.setIntensity(1.5));
 */
export function createLiquidLens(
  frame: HTMLElement,
  backdrop: HTMLElement,
  options?: LiquidLensOptions,
): LiquidLens;
export function createLiquidLens(frame: HTMLElement, options?: LiquidLensOptions): LiquidLens;
export function createLiquidLens(
  frame: HTMLElement,
  backdropOrOptions?: HTMLElement | LiquidLensOptions,
  maybeOptions?: LiquidLensOptions,
): LiquidLens {
  assertElement(frame, "frame");

  const backdropGiven =
    !!backdropOrOptions && (backdropOrOptions as Node).nodeType === 1;
  const options = backdropGiven
    ? (maybeOptions ?? {})
    : ((backdropOrOptions as LiquidLensOptions | undefined) ?? {});
  if (backdropGiven) {
    assertElement(backdropOrOptions, "backdrop");
  }
  const backdrop = backdropGiven
    ? (backdropOrOptions as HTMLElement)
    : findBackdrop(frame);

  if (frame === backdrop) {
    throw new TypeError(
      "liquidlens: frame and backdrop must be different elements: the lens bends what is behind it, and an element cannot be behind itself.",
    );
  }
  if (!frame.isConnected) {
    console.warn(
      "liquidlens: frame is not in the document; the lens cannot measure or render until it is. Create the lens after mounting the element.",
    );
  }
  warnOnSuspectOptions(options);

  const doc = frame.ownerDocument;
  let settings: LiquidLensOptions & ResolvedOptions = {
    ...defaultsFor(doc.defaultView),
    ...options,
  };

  // Mark the frame so clones of the backdrop can exclude it (the frame is
  // usually a descendant of the backdrop; cloning it back into itself
  // would nest lenses indefinitely).
  frame.setAttribute(LENS_MARKER, "");

  // The frame needs to position the refraction layer and clip it to its
  // rounded shape. Remember the inline values so destroy() can put back
  // exactly what the consumer had.
  const priorInlinePosition = frame.style.position;
  const priorInlineOverflow = frame.style.overflow;
  if (getComputedStyle(frame).position === "static") {
    frame.style.position = "relative";
  }
  frame.style.overflow = "hidden";

  const glassFilter = createGlassFilter(doc);

  // Reduced-motion handling: while active, intensity stays pinned at 1 so
  // press-swell feedback goes still. The listener also resets a lens that
  // was mid-swell when the OS setting flipped.
  const reducedMotion = doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)");
  const motionSuppressed = (): boolean =>
    settings.respectReducedMotion && reducedMotion?.matches === true;

  function setIntensity(factor: number): void {
    glassFilter.setIntensity(motionSuppressed() ? 1 : factor);
  }

  const onMotionPreferenceChange = (): void => setIntensity(1);
  reducedMotion?.addEventListener?.("change", onMotionPreferenceChange);

  // The other two accessibility treatments (reduced transparency, increased
  // contrast). Each option is `"auto"` (follow the OS query), `true` (force on),
  // or `false` (ignore). When the OS preference flips, re-apply.
  const mqlReducedTransparency = doc.defaultView?.matchMedia?.(
    "(prefers-reduced-transparency: reduce)",
  );
  const mqlIncreasedContrast = doc.defaultView?.matchMedia?.("(prefers-contrast: more)");
  const resolveA11y = (
    setting: boolean | "auto",
    mql: MediaQueryList | undefined,
  ): boolean => (setting === "auto" ? mql?.matches === true : setting === true);
  const accessibilityFlags = (): AccessibilityFlags => ({
    reducedTransparency: resolveA11y(settings.reducedTransparency, mqlReducedTransparency),
    increasedContrast: resolveA11y(settings.increasedContrast, mqlIncreasedContrast),
  });
  const onA11yPreferenceChange = (): void => update();
  mqlReducedTransparency?.addEventListener?.("change", onA11yPreferenceChange);
  mqlIncreasedContrast?.addEventListener?.("change", onA11yPreferenceChange);

  // Refraction layer: holds the backdrop clone and applies the filter to it.
  // The shine layer must stay outside this element so the highlight is not
  // displaced along with the backdrop pixels.
  const refraction = doc.createElement("div");
  Object.assign(refraction.style, {
    position: "absolute",
    inset: "0",
    filter: glassFilter.cssFilter,
  });

  function buildClone(): HTMLElement {
    const built = backdrop.cloneNode(true) as HTMLElement;
    built.setAttribute("aria-hidden", "true");
    built.removeAttribute("id");
    built.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
    built.querySelectorAll(`[${LENS_MARKER}]`).forEach((el) => el.remove());
    Object.assign(built.style, {
      position: "absolute",
      top: "0",
      left: "0",
      margin: "0",
      width: `${backdrop.clientWidth}px`,
      height: `${backdrop.clientHeight}px`,
      pointerEvents: "none",
    });
    // The clone is sized to the backdrop's clientWidth, which excludes any
    // scrollbar; rendering its own scrollbar would shrink its content area
    // below the original's and shift every line of text.
    built.style.setProperty("scrollbar-width", "none");
    return built;
  }

  let clone = buildClone();
  refraction.appendChild(clone);
  frame.appendChild(refraction);

  let syncedX = Number.NaN;
  let syncedY = Number.NaN;

  // The adaptive layer (created on demand when `adaptive` is on) and the tint
  // it has derived from the backdrop, which overrides the consumer's base tint
  // in the filter until they set a new one.
  let adaptive: AdaptiveLayer | undefined;
  let adaptedTint: string | undefined;

  function syncTo(offsetX: number, offsetY: number): void {
    if (offsetX === syncedX && offsetY === syncedY) {
      return;
    }
    syncedX = offsetX;
    syncedY = offsetY;
    clone.style.transform = `translate(${-offsetX}px, ${-offsetY}px)`;
    // The frame moved, so the backdrop under it changed: re-read it (cheap
    // live path; tint catches up on the trailing settle).
    adaptive?.refresh(false);
  }

  function sync(): void {
    const frameRect = frame.getBoundingClientRect();
    const backdropRect = backdrop.getBoundingClientRect();
    syncTo(frameRect.left - backdropRect.left, frameRect.top - backdropRect.top);
    mirrorScroll(backdrop);
    // Content can scroll under a stationary frame (syncTo above no-ops then),
    // so re-evaluate here too.
    adaptive?.refresh(false);
  }

  /**
   * Finds the clone's copy of a backdrop descendant by child-index path.
   * Lens frames are removed from the clone, so they are skipped when
   * counting siblings; an element inside a lens frame has no counterpart.
   */
  function findCloneCounterpart(el: Element): Element | null {
    const path: number[] = [];
    for (let node: Element = el; node !== backdrop; ) {
      const parent = node.parentElement;
      if (!parent || node.hasAttribute(LENS_MARKER)) {
        return null;
      }
      let index = 0;
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (!sib.hasAttribute(LENS_MARKER)) {
          index += 1;
        }
      }
      path.push(index);
      node = parent;
    }

    let counterpart: Element | null = clone;
    for (let i = path.length - 1; i >= 0 && counterpart; i--) {
      counterpart = counterpart.children.item(path[i]);
    }
    return counterpart;
  }

  /** Copies a scroller's offsets onto its counterpart in the clone. */
  function mirrorScroll(scroller: Element): void {
    const target = scroller === backdrop ? clone : findCloneCounterpart(scroller);
    if (!target) {
      return;
    }
    // Smooth scrolling on the copy would lag the assignment behind the
    // real scroller by an animation.
    (target as HTMLElement).style?.setProperty("scroll-behavior", "auto");
    if (target.scrollLeft !== scroller.scrollLeft) {
      target.scrollLeft = scroller.scrollLeft;
    }
    if (target.scrollTop !== scroller.scrollTop) {
      target.scrollTop = scroller.scrollTop;
    }
  }

  // Scroll tracking: one capture-phase listener sees every scroll in the
  // document: the backdrop itself, scrollers inside it (mirrored into the
  // clone so the refracted content moves live), and page or ancestor
  // scrolls, which can shift the frame relative to the backdrop and are
  // covered by the re-measure. Unrelated scrolls end in the no-op guards.
  function handleScroll(event: Event): void {
    if (paused) {
      return;
    }
    const target = event.target as Node | null;
    if (target && target.nodeType === 1 && backdrop.contains(target)) {
      mirrorScroll(target as Element);
    }
    sync();
  }

  let scrollTracking = false;

  function setScrollTracking(enabled: boolean): void {
    const win = doc.defaultView;
    if (enabled === scrollTracking || !win) {
      return;
    }
    scrollTracking = enabled;
    if (enabled) {
      win.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    } else {
      win.removeEventListener("scroll", handleScroll, { capture: true });
    }
  }

  // cloneNode does not carry scroll positions, so a freshly built clone of
  // an already-scrolled backdrop tree would refract its scrolled-to-top
  // state; carry the offsets over, then the scroll listener keeps them
  // fresh.
  function mirrorAllScrolls(): void {
    if (backdrop.scrollLeft || backdrop.scrollTop) {
      mirrorScroll(backdrop);
    }
    backdrop.querySelectorAll("*").forEach((el) => {
      if (el.scrollLeft || el.scrollTop) {
        mirrorScroll(el);
      }
    });
  }
  mirrorAllScrolls();

  // Content tracking: the clone is a snapshot, so backdrop mutations would
  // otherwise refract stale pixels until the lens is recreated. Rather than
  // replaying individual mutation records (fragile ordering, moved nodes),
  // any relevant change rebuilds the whole clone, coalesced to once per
  // frame. Mutations inside any lens frame are ignored: the lens's own
  // bookkeeping (clone transforms, scroll mirroring, the rebuild itself)
  // mutates the tree constantly and must not retrigger the observer.
  let destroyed = false;
  let refreshQueued = false;
  let paused = false;
  // Suspends only the (expensive) clone rebuild, while the lens stays visible
  // and scroll-aligned — for the duration of a heavy interaction such as a
  // drag, where a backdrop that mutates each frame would otherwise force a
  // full cloneNode rebuild every frame.
  let contentFrozen = false;
  // Set when content changed while paused or frozen, so resume()/unfreeze()
  // know the clone cannot be trusted and must be rebuilt rather than re-synced.
  let cloneStale = false;

  function refreshClone(): void {
    if (destroyed) {
      return;
    }
    if (paused || contentFrozen) {
      cloneStale = true;
      return;
    }
    cloneStale = false;
    const next = buildClone();
    clone.replaceWith(next);
    clone = next;
    // The new clone carries no transform or scroll state; re-derive both.
    syncedX = Number.NaN;
    syncedY = Number.NaN;
    sync();
    mirrorAllScrolls();
    // The backdrop content changed — and with it possibly the image the probe
    // samples (e.g. a swapped background) — so drop the cached source.
    adaptive?.invalidate();
  }

  function scheduleCloneRefresh(): void {
    if (refreshQueued) {
      return;
    }
    refreshQueued = true;
    const win = doc.defaultView;
    const schedule = win?.requestAnimationFrame?.bind(win) ?? queueMicrotask;
    schedule(() => {
      refreshQueued = false;
      refreshClone();
    });
  }

  let mutationObserver: MutationObserver | undefined;

  function setContentTracking(enabled: boolean): void {
    if (enabled === (mutationObserver !== undefined)) {
      return;
    }
    if (!enabled) {
      mutationObserver?.disconnect();
      mutationObserver = undefined;
      return;
    }
    if (typeof MutationObserver === "undefined") {
      return;
    }
    mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target;
        const el =
          target.nodeType === 1 ? (target as Element) : target.parentElement;
        if (!el || !el.closest(`[${LENS_MARKER}]`)) {
          scheduleCloneRefresh();
          return;
        }
      }
    });
    mutationObserver.observe(backdrop, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  }

  // Size of the frame at the last update, so the ResizeObserver can skip
  // sizes that an explicit update (e.g. a per-frame morph) already handled.
  let lastWidth = -1;
  let lastHeight = -1;

  function update(next: LiquidLensOptions = {}, resolution?: number): void {
    warnOnSuspectOptions(next);
    settings = { ...settings, ...next };

    // A consumer-set tint replaces any tint the adaptive layer had derived, so
    // the next adaptive sample re-derives from the new base instead of the old.
    if (next.tint !== undefined) {
      adaptedTint = undefined;
    }

    // An update may have just turned respectReducedMotion on; re-pin a
    // lens that was left mid-swell (no-op otherwise).
    if (motionSuppressed()) {
      glassFilter.setIntensity(1);
    }

    // All layout reads happen before any style writes, so the whole update
    // costs at most one synchronous reflow instead of one per interleaved
    // read; this runs on every frame of a size morph.
    const borderRadius =
      settings.borderRadius ??
      (Number.parseFloat(getComputedStyle(frame).borderTopLeftRadius) || 0);

    lastWidth = frame.clientWidth;
    lastHeight = frame.clientHeight;
    const backdropWidth = backdrop.clientWidth;
    const backdropHeight = backdrop.clientHeight;
    const frameRect = frame.getBoundingClientRect();
    const backdropRect = backdrop.getBoundingClientRect();
    mirrorScroll(backdrop);

    // Fold in the active accessibility treatments (reduced transparency frosts;
    // increased contrast flattens). A no-op when neither is in force.
    const effect = accessibleEffect(
      {
        depth: settings.depth,
        aberration: settings.aberration,
        blur: settings.blur,
        saturation: settings.saturation,
        specular: settings.specular,
      },
      accessibilityFlags(),
    );

    glassFilter.update(
      {
        width: lastWidth,
        height: lastHeight,
        borderRadius,
        shape: resolveShape(settings.shape, borderRadius),
        depth: effect.depth,
        curvature: settings.curvature,
        splay: settings.splay,
        aberration: effect.aberration,
        blur: effect.blur,
        saturation: effect.saturation,
        lightAngle: settings.lightAngle,
        specular: effect.specular,
        specularColor: settings.specularColor,
        specularSharpness: settings.specularSharpness,
        tint: adaptedTint ?? settings.tint,
        tintOpacity: settings.tintOpacity,
      },
      resolution,
    );
    // The filter id cycles on update (WebKit repaint workaround), so the
    // reference must be re-applied.
    refraction.style.filter = glassFilter.cssFilter;

    clone.style.width = `${backdropWidth}px`;
    clone.style.height = `${backdropHeight}px`;
    setScrollTracking(settings.trackScroll);
    setContentTracking(settings.trackContent);
    syncTo(frameRect.left - backdropRect.left, frameRect.top - backdropRect.top);
    reconcileAdaptive();
    reconcileContrastRing();
  }

  // A contrasting border overlay drawn under increased contrast. It is a
  // separate inset-ring layer (not the frame's box-shadow, which the adaptive
  // layer owns) clipped to the frame's shape by its `overflow: hidden`.
  let contrastRing: HTMLElement | undefined;

  function reconcileContrastRing(): void {
    const want = resolveA11y(settings.increasedContrast, mqlIncreasedContrast);
    if (want && !contrastRing) {
      contrastRing = doc.createElement("div");
      contrastRing.setAttribute("aria-hidden", "true");
      Object.assign(contrastRing.style, {
        position: "absolute",
        inset: "0",
        borderRadius: "inherit",
        pointerEvents: "none",
        boxShadow: CONTRAST_RING,
        zIndex: "2",
      });
      frame.appendChild(contrastRing);
    } else if (!want && contrastRing) {
      contrastRing.remove();
      contrastRing = undefined;
    }
  }

  /**
   * Brings the adaptive layer in line with `settings.adaptive`: creates it when
   * adaptivity is switched on (the layer then drives the frame's shadow, ink,
   * and tint from the backdrop), tears it down when switched off. Idempotent,
   * so it is safe to call at the end of every `update()`.
   */
  function reconcileAdaptive(): void {
    const wanted = settings.adaptive;
    if (wanted && !adaptive) {
      const opts: AdaptiveOptions = wanted === true ? {} : wanted;
      adaptive = createAdaptiveLayer(
        frame,
        backdrop,
        {
          // The adaptive layer reads the consumer's tint and writes back a
          // tone-matched one; an opacity of 0 (or no tint) means "no tint to
          // adapt", so it is reported as absent.
          getTint: () =>
            settings.tint != null && (settings.tintOpacity ?? 0.2) > 0
              ? settings.tint
              : undefined,
          applyTint: (color) => {
            adaptedTint = color;
            update();
          },
        },
        opts,
      );
      // First evaluation now that `adaptive` is assigned, so the re-entrant
      // update() a tint adjustment triggers finds the layer and no-ops here.
      adaptive.refresh(true);
    } else if (!wanted && adaptive) {
      adaptive.destroy();
      adaptive = undefined;
      adaptedTint = undefined;
    }
  }

  // Map geometry depends on the frame's size; regenerate when it changes,
  // unless an explicit update already covered the current size.
  let resizeObserver: ResizeObserver | undefined;
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => {
      if (frame.clientWidth !== lastWidth || frame.clientHeight !== lastHeight) {
        update();
      }
    });
    resizeObserver.observe(frame);
  }

  update();

  if (options.onReady) {
    // Two frames out: the first rAF fires before the initial paint, the
    // second after the refraction is actually on screen.
    const fire = (): void => {
      if (!destroyed) {
        options.onReady?.();
      }
    };
    const win = doc.defaultView;
    if (win) {
      win.requestAnimationFrame(() => win.requestAnimationFrame(fire));
    } else {
      queueMicrotask(fire);
    }
  }

  function pause(): void {
    if (paused || destroyed) {
      return;
    }
    paused = true;
    refraction.style.display = "none";
  }

  function resume(): void {
    if (!paused || destroyed) {
      return;
    }
    paused = false;
    refraction.style.display = "";
    if (cloneStale && !contentFrozen) {
      refreshClone();
    } else {
      sync();
      mirrorAllScrolls();
    }
  }

  function freeze(): void {
    contentFrozen = true;
  }

  function unfreeze(): void {
    if (!contentFrozen || destroyed) {
      return;
    }
    contentFrozen = false;
    // Catch up on any backdrop change that happened while frozen.
    if (cloneStale && !paused) {
      refreshClone();
    }
  }

  return {
    update,
    sync,
    syncTo,
    setIntensity,
    pause,
    resume,
    freeze,
    unfreeze,
    get options(): Readonly<LiquidLensOptions> {
      return { ...settings };
    },
    destroy(): void {
      // Disconnect before removing the marker: pending mutation records
      // would otherwise see an unmarked frame and schedule a rebuild of a
      // lens that no longer exists.
      destroyed = true;
      setContentTracking(false);
      setScrollTracking(false);
      reducedMotion?.removeEventListener?.("change", onMotionPreferenceChange);
      mqlReducedTransparency?.removeEventListener?.("change", onA11yPreferenceChange);
      mqlIncreasedContrast?.removeEventListener?.("change", onA11yPreferenceChange);
      resizeObserver?.disconnect();
      // Restores the frame's box-shadow/color/--ll-ink before the lens
      // restores position/overflow below.
      adaptive?.destroy();
      adaptive = undefined;
      contrastRing?.remove();
      contrastRing = undefined;
      refraction.remove();
      glassFilter.destroy();
      frame.removeAttribute(LENS_MARKER);
      frame.style.position = priorInlinePosition;
      frame.style.overflow = priorInlineOverflow;
    },
  };
}
