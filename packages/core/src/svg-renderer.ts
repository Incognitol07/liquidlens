import { cloneBackdrop, LENS_MARKER, watchBackdrop } from "./backdrop";
import { createGlassFilter } from "./filter";
import type { LensLayout, Renderer, RendererHost, ResolvedLook } from "./renderer";

/**
 * The SVG renderer: a clone of the backdrop inside the frame, bent by an SVG
 * filter, with the tint and specular rim as layers on top. The clone is kept
 * pixel-aligned with the backdrop, mirrors its scroll positions and
 * animations, and is rebuilt when the backdrop's content changes.
 */
export function createSvgRenderer(host: RendererHost): Renderer {
  const { frame, backdrop } = host;
  const doc = frame.ownerDocument;
  const glassFilter = createGlassFilter(doc);

  // Refraction layer: holds the backdrop clone and applies the filter to it.
  // The shine layer must stay outside this element so the highlight is not
  // displaced along with the backdrop pixels.
  const refraction = doc.createElement("div");
  Object.assign(refraction.style, {
    position: "absolute",
    inset: "0",
    filter: glassFilter.cssFilter,
  });

  let clone = cloneBackdrop(backdrop);
  refraction.appendChild(clone);
  frame.appendChild(refraction);

  // Tint and specular rim, as plain layers over the refraction: the tint,
  // then the rim screen-blended on top so it brightens like a real highlight.
  // Blending the rim inside the filter graph is one of its most expensive
  // passes per frame; as layers, rim and tint cost almost nothing. Like the
  // refraction, they sit beneath the consumer's positioned content.
  const overlayLayer = (): HTMLElement => {
    const el = doc.createElement("div");
    Object.assign(el.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
      display: "none",
    });
    return el;
  };
  const tintLayer = overlayLayer();
  const shineLayer = overlayLayer();
  Object.assign(shineLayer.style, { backgroundSize: "100% 100%", mixBlendMode: "screen" });
  refraction.after(tintLayer, shineLayer);
  let shownSpecular = "";
  let look: ResolvedLook | undefined;

  let syncedX = Number.NaN;
  let syncedY = Number.NaN;

  let destroyed = false;
  let paused = false;
  // Suspends only the (expensive) clone rebuild, while the lens stays visible
  // and scroll-aligned — for the duration of a heavy interaction such as a
  // drag, where a backdrop that mutates each frame would otherwise force a
  // full cloneNode rebuild every frame.
  let contentFrozen = false;
  // Set when content changed while paused or frozen, so resume()/unfreeze()
  // know the clone cannot be trusted and must be rebuilt rather than re-synced.
  let cloneStale = false;

  function syncTo(offsetX: number, offsetY: number): void {
    if (offsetX === syncedX && offsetY === syncedY) {
      return;
    }
    syncedX = offsetX;
    syncedY = offsetY;
    clone.style.transform = `translate(${-offsetX}px, ${-offsetY}px)`;
    host.viewChanged();
  }

  function sync(): void {
    const frameRect = frame.getBoundingClientRect();
    const backdropRect = backdrop.getBoundingClientRect();
    syncTo(frameRect.left - backdropRect.left, frameRect.top - backdropRect.top);
    mirrorScroll(backdrop);
    // Content can scroll under a stationary frame (syncTo above no-ops then).
    host.viewChanged();
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

  // Script animations re-created on the current clone, cancelled with it.
  let mirroredAnimations: Animation[] = [];

  /**
   * Locks the clone's animations to the backdrop's. A cloned element's CSS
   * animations start from their first keyframe when the clone is inserted,
   * and script (Web Animations) animations are not cloned at all, so either
   * would run out of step with the content the lens sits over. Each
   * counterpart (re-created for script animations) takes its source's start
   * time on the same timeline, which keeps the two in step from then on.
   * In-flight CSS transitions are left alone: the clone shows their end state.
   */
  function syncCloneAnimations(): void {
    for (const mirrored of mirroredAnimations) {
      mirrored.cancel();
    }
    mirroredAnimations = [];
    for (const source of backdrop.getAnimations({ subtree: true })) {
      const effect = source.effect;
      if (!(effect instanceof KeyframeEffect) || !effect.target || source instanceof CSSTransition) {
        continue;
      }
      const target = findCloneCounterpart(effect.target);
      if (!target) {
        continue;
      }

      let counterpart: Animation | undefined;
      if (source instanceof CSSAnimation) {
        counterpart = target.getAnimations({ subtree: true }).find(
          (a) =>
            a instanceof CSSAnimation &&
            a.animationName === source.animationName &&
            a.effect instanceof KeyframeEffect &&
            a.effect.target === target &&
            a.effect.pseudoElement === effect.pseudoElement,
        );
      } else if (source.timeline) {
        counterpart = new Animation(
          new KeyframeEffect(target, effect.getKeyframes(), {
            ...effect.getTiming(),
            composite: effect.composite,
            pseudoElement: effect.pseudoElement,
          }),
          source.timeline,
        );
        mirroredAnimations.push(counterpart);
      }
      if (!counterpart) {
        continue;
      }

      counterpart.playbackRate = source.playbackRate;
      if (source.startTime !== null) {
        counterpart.startTime = source.startTime;
      } else {
        // Paused (or idle): hold the same frame.
        counterpart.currentTime = source.currentTime;
        counterpart.pause();
      }
    }
  }
  syncCloneAnimations();

  // Content tracking: the clone is a snapshot, so backdrop mutations would
  // otherwise refract stale pixels until the lens is recreated. Rather than
  // replaying individual mutation records (fragile ordering, moved nodes),
  // any relevant change rebuilds the whole clone, coalesced to once per
  // frame. Mutations inside any lens frame are ignored (see watchBackdrop).
  function refreshClone(): void {
    if (destroyed) {
      return;
    }
    if (paused || contentFrozen) {
      cloneStale = true;
      return;
    }
    cloneStale = false;
    const next = cloneBackdrop(backdrop);
    clone.replaceWith(next);
    clone = next;
    // The new clone carries no transform, scroll or animation state;
    // re-derive all three.
    syncedX = Number.NaN;
    syncedY = Number.NaN;
    sync();
    mirrorAllScrolls();
    syncCloneAnimations();
    host.contentChanged();
  }

  // One observer and one per-frame rebuild pass per backdrop, shared by
  // every lens on it (see watchBackdrop), so N lenses build the copy once.
  let unwatchContent: (() => void) | undefined;

  function setContentTracking(enabled: boolean): void {
    if (enabled === (unwatchContent !== undefined)) {
      return;
    }
    if (enabled) {
      unwatchContent = watchBackdrop(backdrop, refreshClone);
    } else {
      unwatchContent?.();
      unwatchContent = undefined;
    }
  }

  /** Brings the tint and shine layers in line with the look and filter. */
  function renderOverlays(): void {
    const tint = look?.tint;
    const tintOpacity = look?.tintOpacity ?? 0;
    const showTint = !paused && tint != null && tintOpacity > 0;
    if (showTint) {
      tintLayer.style.background = tint;
      tintLayer.style.opacity = String(tintOpacity);
    }
    tintLayer.style.display = showTint ? "" : "none";

    // The image only changes when the rim is regenerated; re-assigning a
    // ~100 KB data URL on every update would re-decode it for nothing.
    const specular = glassFilter.specularImage;
    if (specular !== shownSpecular) {
      shineLayer.style.backgroundImage = specular ? `url("${specular}")` : "";
      shownSpecular = specular;
    }
    shineLayer.style.display = !paused && specular ? "" : "none";
  }

  return {
    render(next, layout: LensLayout, resolution) {
      look = next;
      mirrorScroll(backdrop);
      glassFilter.update(
        {
          width: next.width,
          height: next.height,
          borderRadius: next.borderRadius,
          shape: next.shape,
          depth: next.depth,
          curvature: next.curvature,
          splay: next.splay,
          aberration: next.aberration,
          blur: next.blur,
          saturation: next.saturation,
          lightAngle: next.lightAngle,
          specular: next.specular,
          specularColor: next.specularColor,
          specularSharpness: next.specularSharpness,
        },
        resolution,
      );
      // The filter id cycles on update (WebKit repaint workaround), so the
      // reference must be re-applied.
      refraction.style.filter = glassFilter.cssFilter;
      renderOverlays();
      clone.style.width = `${layout.backdropWidth}px`;
      clone.style.height = `${layout.backdropHeight}px`;
      syncTo(layout.offsetX, layout.offsetY);
    },

    setIntensity(factor) {
      glassFilter.setIntensity(factor);
    },

    sync,
    syncTo,

    setTracking(scroll, content) {
      setScrollTracking(scroll);
      setContentTracking(content);
    },

    pause() {
      if (paused || destroyed) {
        return;
      }
      paused = true;
      refraction.style.display = "none";
      renderOverlays();
    },

    resume() {
      if (!paused || destroyed) {
        return;
      }
      paused = false;
      refraction.style.display = "";
      renderOverlays();
      if (cloneStale && !contentFrozen) {
        refreshClone();
      } else {
        sync();
        mirrorAllScrolls();
      }
    },

    freeze() {
      contentFrozen = true;
    },

    unfreeze() {
      if (!contentFrozen || destroyed) {
        return;
      }
      contentFrozen = false;
      // Catch up on any backdrop change that happened while frozen.
      if (cloneStale && !paused) {
        refreshClone();
      }
    },

    destroy() {
      destroyed = true;
      setContentTracking(false);
      setScrollTracking(false);
      mirroredAnimations.forEach((animation) => animation.cancel());
      mirroredAnimations = [];
      refraction.remove();
      tintLayer.remove();
      shineLayer.remove();
      glassFilter.destroy();
    },
  };
}
