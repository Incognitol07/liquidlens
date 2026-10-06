/** Attribute marking a lens frame; frames are excluded from backdrop clones. */
export const LENS_MARKER = "data-liquidlens";

/**
 * Copies an element's full computed style onto its clone as inline style.
 * Id-scoped CSS (`#backdrop { background: … }`) stops matching once the
 * clone's ids are stripped, which would silently drop styling — a
 * backdrop's wallpaper, an id-positioned child — from the refraction, so
 * every id-bearing element gets its resolved style baked in first. Runs
 * only for those elements, and pseudo-element styles are not carried over.
 */
function inlineComputedStyle(source: Element, target: HTMLElement): void {
  const win = source.ownerDocument.defaultView;
  if (!win) {
    return;
  }
  const computed = win.getComputedStyle(source);
  for (let i = 0; i < computed.length; i++) {
    const property = computed.item(i);
    target.style.setProperty(property, computed.getPropertyValue(property));
  }
}

/**
 * Whether `el` is inside a lens frame that is itself inside `backdrop` (and
 * so absent from clones). The nearest marked ancestor decides: one outside
 * the backdrop means the backdrop sits in a lens, and `el` is kept.
 */
function insideLensFrame(el: Element, backdrop: HTMLElement): boolean {
  const frame = el.closest(`[${LENS_MARKER}]`);
  return frame !== null && backdrop.contains(frame);
}

/** One capture stream per source canvas, shared by every clone showing it. */
const canvasStreams = new WeakMap<HTMLCanvasElement, MediaStream | null>();

function canvasStream(canvas: HTMLCanvasElement): MediaStream | null {
  let stream = canvasStreams.get(canvas);
  if (stream === undefined) {
    try {
      stream = canvas.captureStream();
    } catch {
      // A cross-origin-tainted canvas refuses capture.
      stream = null;
    }
    canvasStreams.set(canvas, stream);
  }
  return stream;
}

/**
 * Makes the clone's canvases live. A cloned canvas is blank (its bitmap is
 * not part of the DOM), so each is replaced by a video playing a capture
 * stream of the source canvas: GPU-backed, and updated as the source draws.
 * The video takes the source canvas's computed style inline (rules written
 * for `canvas` don't match it) and stretches its frames over the box the way
 * a canvas stretches its bitmap.
 */
function mirrorCanvases(backdrop: HTMLElement, clone: HTMLElement): void {
  const copies = clone.querySelectorAll("canvas");
  if (copies.length === 0) {
    return;
  }
  const sources = [...backdrop.querySelectorAll("canvas")].filter(
    (canvas) => !insideLensFrame(canvas, backdrop),
  );
  const doc = backdrop.ownerDocument;
  copies.forEach((copy, i) => {
    const source = sources[i];
    const stream = source && canvasStream(source);
    if (!stream) {
      return;
    }
    const video = doc.createElement("video");
    inlineComputedStyle(source, video);
    video.style.objectFit = "fill";
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = stream;
    copy.replaceWith(video);
  });
}

/**
 * Builds a static copy of `backdrop` for a lens to refract: id-dependent
 * styling baked in, ids stripped, lens frames removed, sized and positioned
 * to overlay the original from the lens's top-left corner.
 */
function buildBackdropClone(backdrop: HTMLElement): HTMLElement {
  const built = backdrop.cloneNode(true) as HTMLElement;
  built.setAttribute("aria-hidden", "true");
  // Bake id-dependent styling in while the two trees are still identical
  // (parallel [id] queries walk them in the same document order); the
  // marker-removal below would desynchronise the lists.
  if (backdrop.id) {
    inlineComputedStyle(backdrop, built);
  }
  // Lens frames are removed from the clone below, so styling anything
  // inside one is wasted work, and with ~500 computed properties per
  // element it dominates the build.
  const sourceIdElements = backdrop.querySelectorAll("[id]");
  built.querySelectorAll("[id]").forEach((el, i) => {
    const source = sourceIdElements[i];
    if (!insideLensFrame(source, backdrop)) {
      inlineComputedStyle(source, el as HTMLElement);
    }
  });
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

/**
 * The clone built during the current change notification, shared by every
 * lens on that backdrop: the first lens pays for the build, the rest copy
 * the result. It lives only for the duration of one notification pass, in
 * which no outside code runs, so every lens still gets the DOM as it is at
 * that moment; outside a pass each call builds fresh.
 */
let passTemplate: { backdrop: HTMLElement; clone?: HTMLElement } | undefined;

/**
 * A fresh copy of `backdrop` for a lens to refract (see buildBackdropClone),
 * with its canvases made live (see mirrorCanvases). Each copy gets its own
 * videos: a stream attached to a template would not survive cloneNode.
 */
export function cloneBackdrop(backdrop: HTMLElement): HTMLElement {
  let copy: HTMLElement;
  if (passTemplate?.backdrop !== backdrop) {
    copy = buildBackdropClone(backdrop);
  } else {
    passTemplate.clone ??= buildBackdropClone(backdrop);
    copy = passTemplate.clone.cloneNode(true) as HTMLElement;
  }
  mirrorCanvases(backdrop, copy);
  return copy;
}

interface BackdropWatch {
  observer: MutationObserver;
  listeners: Set<() => void>;
  queued: boolean;
}

const watches = new WeakMap<HTMLElement, BackdropWatch>();

/**
 * Calls `onChange` (coalesced to once per frame) whenever the backdrop's
 * content changes outside any lens frame. All lenses on one backdrop share a
 * single observer and a single per-frame pass, during which `cloneBackdrop`
 * builds the copy once. Returns the unsubscribe function.
 */
export function watchBackdrop(backdrop: HTMLElement, onChange: () => void): () => void {
  if (typeof MutationObserver === "undefined") {
    return () => {};
  }
  let watch = watches.get(backdrop);
  if (!watch) {
    const created: BackdropWatch = {
      listeners: new Set(),
      queued: false,
      // Mutations inside any lens frame are ignored: the lenses' own
      // bookkeeping (clone transforms, scroll mirroring, the rebuild itself)
      // mutates the tree constantly and must not retrigger the observer.
      observer: new MutationObserver((records) => {
        for (const record of records) {
          const target = record.target;
          const el = target.nodeType === 1 ? (target as Element) : target.parentElement;
          if (!el || !el.closest(`[${LENS_MARKER}]`)) {
            schedule(backdrop, created);
            return;
          }
        }
      }),
    };
    created.observer.observe(backdrop, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    watches.set(backdrop, created);
    watch = created;
  }
  const active = watch;
  active.listeners.add(onChange);
  return () => {
    active.listeners.delete(onChange);
    if (active.listeners.size === 0) {
      active.observer.disconnect();
      if (watches.get(backdrop) === active) {
        watches.delete(backdrop);
      }
    }
  };
}

function schedule(backdrop: HTMLElement, watch: BackdropWatch): void {
  if (watch.queued) {
    return;
  }
  watch.queued = true;
  const win = backdrop.ownerDocument.defaultView;
  const run = (): void => {
    watch.queued = false;
    passTemplate = { backdrop };
    try {
      // Copy the set: a listener may unsubscribe (destroy) mid-pass.
      for (const listener of [...watch.listeners]) {
        listener();
      }
    } finally {
      passTemplate = undefined;
    }
  };
  if (win?.requestAnimationFrame) {
    win.requestAnimationFrame(run);
  } else {
    queueMicrotask(run);
  }
}
