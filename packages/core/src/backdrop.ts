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
 * Makes the clone's videos live. A cloned video doesn't share the source's
 * playback (it shows nothing until it loads and plays its own copy), so each
 * is replaced by a canvas that draws the source's frames as they are
 * presented. Drawing works in every engine, cross-origin video included (it
 * only taints the canvas, which nothing reads back). The canvas takes the
 * video's computed style inline, `object-fit` included, so it frames the
 * picture the same way. `copies` are the clone's videos, collected before
 * mirrorCanvases adds stream videos of its own.
 */
function mirrorVideos(backdrop: HTMLElement, copies: HTMLVideoElement[]): void {
  if (copies.length === 0) {
    return;
  }
  const sources = [...backdrop.querySelectorAll("video")].filter(
    (video) => !insideLensFrame(video, backdrop),
  );
  const doc = backdrop.ownerDocument;
  copies.forEach((copy, i) => {
    const source = sources[i];
    if (!source) {
      return;
    }
    const canvas = doc.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    inlineComputedStyle(source, canvas);
    const draw = (): void => {
      if (source.videoWidth === 0) {
        return;
      }
      if (canvas.width !== source.videoWidth || canvas.height !== source.videoHeight) {
        canvas.width = source.videoWidth;
        canvas.height = source.videoHeight;
      }
      ctx.drawImage(source, 0, 0);
    };
    // A clone is inserted as soon as it is built, so a canvas that is out of
    // the document when a frame arrives belongs to a discarded clone (rebuilt,
    // or its lens destroyed) and its loop ends. A paused source delivers no
    // frames, so this check runs on the first frame after it resumes.
    const onFrame = (): void => {
      if (!canvas.isConnected) {
        return;
      }
      draw();
      source.requestVideoFrameCallback(onFrame);
    };
    draw();
    source.requestVideoFrameCallback(onFrame);
    copy.replaceWith(canvas);
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
 * with its canvases and videos made live (see mirrorCanvases, mirrorVideos).
 * Each copy gets its own mirrors: a stream or frame loop attached to a
 * template would not survive cloneNode.
 */
export function cloneBackdrop(backdrop: HTMLElement): HTMLElement {
  let copy: HTMLElement;
  if (passTemplate?.backdrop !== backdrop) {
    copy = buildBackdropClone(backdrop);
  } else {
    passTemplate.clone ??= buildBackdropClone(backdrop);
    copy = passTemplate.clone.cloneNode(true) as HTMLElement;
  }
  const videos = [...copy.querySelectorAll("video")];
  mirrorCanvases(backdrop, copy);
  mirrorVideos(backdrop, videos);
  return copy;
}

interface BackdropWatch {
  observer: MutationObserver;
  ancestorObserver: MutationObserver;
  scheme?: MediaQueryList;
  onScheme: () => void;
  listeners: Set<() => void>;
  queued: boolean;
}

const watches = new WeakMap<HTMLElement, BackdropWatch>();

/**
 * Calls `onChange` (coalesced to once per frame) whenever what the backdrop
 * paints may have changed: its content changed outside any lens frame, an
 * ancestor's `style` or `class` changed (a CSS variable or a theme class set
 * higher up, which the backdrop's computed style follows), or the color
 * scheme flipped. All lenses on one backdrop share these observers and a
 * single per-frame pass, during which `cloneBackdrop` builds the copy once.
 * Returns the unsubscribe function.
 */
export function watchBackdrop(backdrop: HTMLElement, onChange: () => void): () => void {
  if (typeof MutationObserver === "undefined") {
    return () => {};
  }
  let watch = watches.get(backdrop);
  if (!watch) {
    const win = backdrop.ownerDocument.defaultView;
    const created: BackdropWatch = {
      listeners: new Set(),
      queued: false,
      ancestorObserver: new MutationObserver(() => schedule(backdrop, created)),
      scheme: win?.matchMedia?.("(prefers-color-scheme: dark)"),
      onScheme: () => schedule(backdrop, created),
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
    for (let el = backdrop.parentElement; el; el = el.parentElement) {
      created.ancestorObserver.observe(el, { attributes: true, attributeFilter: ["style", "class"] });
    }
    created.scheme?.addEventListener?.("change", created.onScheme);
    watches.set(backdrop, created);
    watch = created;
  }
  const active = watch;
  active.listeners.add(onChange);
  return () => {
    active.listeners.delete(onChange);
    if (active.listeners.size === 0) {
      active.observer.disconnect();
      active.ancestorObserver.disconnect();
      active.scheme?.removeEventListener?.("change", active.onScheme);
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
