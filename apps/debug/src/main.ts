import {
  computeDisplacementField,
  createLiquidLens,
  performanceTier,
  presets,
  renderDisplacementMapToCanvas,
  renderSpecularToCanvas,
  Spring,
  type LensPresetName,
  type LiquidLens,
  type LiquidLensOptions,
} from "@caustics/core";


// On devices without the CPU headroom for the full pipeline, interactions
// temporarily drop the passes that dominate filter cost (the per-channel
// aberration split and the Gaussian blur) and restore them on settle.
const lowTier = performanceTier() === "low";

// ---------------------------------------------------------------------------
// Mobile panel toggle
//
// On narrow viewports the controls panel becomes a slide-up bottom sheet.
// A fixed toggle button shows/hides it and a scrim overlay behind it
// dismisses on tap.

const panelToggle = document.getElementById("panel-toggle") as HTMLButtonElement;
const panelScrim = document.getElementById("panel-scrim") as HTMLElement;

function togglePanel(): void {
  document.body.classList.toggle("panel-open");
  const isOpen = document.body.classList.contains("panel-open");
  panelToggle.setAttribute("aria-expanded", String(isOpen));
}

panelToggle.addEventListener("click", togglePanel);
panelScrim.addEventListener("click", () => {
  document.body.classList.remove("panel-open");
  panelToggle.setAttribute("aria-expanded", "false");
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("panel-open")) {
    document.body.classList.remove("panel-open");
    panelToggle.setAttribute("aria-expanded", "false");
  }
});

// ---------------------------------------------------------------------------
// Controls

const ids = [
  "width",
  "height",
  "borderRadius",
  "depth",
  "curvature",
  "splay",
  "aberration",
  "blur",
  "saturation",
  "lightAngle",
  "specular",
  "stiffness",
  "damping",
] as const;
type ControlId = (typeof ids)[number];

const GEOMETRY_IDS: readonly ControlId[] = ["width", "height", "borderRadius"];

const inputs = Object.fromEntries(
  ids.map((id) => [id, document.getElementById(id) as HTMLInputElement]),
) as Record<ControlId, HTMLInputElement>;

const valueLabels = Object.fromEntries(
  ids.map((id) => [id, document.getElementById(`${id}-value`) as HTMLElement]),
) as Record<ControlId, HTMLElement>;

function num(id: ControlId): number {
  return Number(inputs[id].value);
}

function formatValue(id: ControlId, value: number): string {
  switch (id) {
    case "width":
    case "height":
    case "borderRadius":
    case "depth":
      return `${Math.round(value)}px`;
    case "blur":
      return `${value.toFixed(1)}px`;
    case "lightAngle":
      return `${Math.round(value)}°`;
    case "saturation":
      return `${value.toFixed(2)}×`;
    case "stiffness":
    case "damping":
      return `${Math.round(value)}`;
    default:
      return value.toFixed(2);
  }
}

/** Updates each control's value readout and its track-fill percentage. */
function refreshLabels(): void {
  for (const id of ids) {
    const input = inputs[id];
    const value = Number(input.value);
    valueLabels[id].textContent = formatValue(id, value);

    const min = Number(input.min);
    const max = Number(input.max);
    const fraction = max > min ? (value - min) / (max - min) : 0;
    input.style.setProperty("--p", `${fraction * 100}%`);
  }
  refreshPresetHighlight();
}

// ---------------------------------------------------------------------------
// Theme: data-theme on <html> drives the palette; the toggle's data-state
// drives the icon swap (a = moon/dark, b = sun/light). The choice persists
// across reloads and defaults to the OS preference.

type Theme = "dark" | "light";
const THEME_KEY = "caustics-debug-theme";
const themeToggle = document.getElementById("theme-toggle") as HTMLButtonElement;

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  themeToggle.dataset.state = theme === "dark" ? "a" : "b";
  themeToggle.setAttribute(
    "aria-label",
    theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
  );
}

const storedTheme = localStorage.getItem(THEME_KEY);
applyTheme(
  storedTheme === "light" || storedTheme === "dark"
    ? storedTheme
    : matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark",
);

themeToggle.addEventListener("click", () => {
  const next: Theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

// ---------------------------------------------------------------------------
// Presets: each button loads a named option set from the library; the active
// state is derived from the sliders, so it lights up whenever the current
// values happen to equal a preset and clears as soon as one is hand-tuned.

const presetButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".preset-btn"),
);

function matchesPreset(name: LensPresetName): boolean {
  return Object.entries(presets[name]).every(
    ([id, value]) => Math.abs(num(id as ControlId) - value) < 1e-6,
  );
}

function refreshPresetHighlight(): void {
  for (const button of presetButtons) {
    const name = button.dataset.preset as LensPresetName;
    button.classList.toggle("is-active", matchesPreset(name));
  }
}

for (const button of presetButtons) {
  button.addEventListener("click", () => {
    const preset = presets[button.dataset.preset as LensPresetName];
    for (const [id, value] of Object.entries(preset)) {
      const input = inputs[id as ControlId];
      input.value = String(value);
      input.dispatchEvent(new Event("input"));
    }
  });
}

// ---------------------------------------------------------------------------
// Elements

const mapCanvas = document.getElementById("map-preview") as HTMLCanvasElement;
const specularCanvas = document.getElementById("specular-preview") as HTMLCanvasElement;
const background = document.getElementById("background") as HTMLElement;
const lensEl = document.getElementById("lens") as HTMLElement;

let lens: LiquidLens | undefined;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Cached backdrop size so the animation loop and pointermove handlers never
// read layout (clientWidth after a style write forces a synchronous reflow).
let backgroundW = background.clientWidth;
let backgroundH = background.clientHeight;
new ResizeObserver(() => {
  backgroundW = background.clientWidth;
  backgroundH = background.clientHeight;
}).observe(background);

// ---------------------------------------------------------------------------
// Liquid motion
//
// Position, press, and geometry all run through springs. Moving the lens is
// transform-only (no map work), but a geometry morph is a real shape change,
// so the displacement and specular maps regenerate every frame at reduced
// resolution while the size springs are in motion, with one crisp full-
// resolution pass once everything settles.

const target = { x: 0, y: 0 }; // drag offset from center, set by the pointer
const springX = new Spring(0, num("stiffness"), num("damping"));
const springY = new Spring(0, num("stiffness"), num("damping"));
const press = new Spring(0, 550, 20);

const geomW = new Spring(num("width"), 170, 16);
const geomH = new Spring(num("height"), 170, 16);
const geomR = new Spring(num("borderRadius"), 170, 16);

let dragging = false;
let rafId: number | undefined;
let lastTime = 0;
let needsFinalPass = false;
const appliedGeom = { w: geomW.value, h: geomH.value, r: geomR.value };

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

// Surface the OS preference in the panel header; the lens library pins its
// intensity on its own, this just makes the state visible while debugging.
const reducedMotionTag = document.getElementById("reduced-motion-tag") as HTMLElement;
function refreshReducedMotionTag(): void {
  reducedMotionTag.hidden = !reducedMotion.matches;
}
reducedMotion.addEventListener("change", () => {
  refreshReducedMotionTag();
  wake();
});
refreshReducedMotionTag();

// Menu springs: the width leads and the height blooms a beat behind it,
// so the shape distorts liquidly en route instead of scaling between two
// rectangles in lockstep. The radius is near-critically damped because a
// radius overshoot reads as the corners sharpening, not as bounce.
const MENU_COLLAPSED = { w: 40, h: 36, r: 18 };
const MENU_EXPANDED = { w: 172, h: 80, r: 16 };
const menuW = new Spring(MENU_COLLAPSED.w, 260, 15);
const menuH = new Spring(MENU_COLLAPSED.h, 170, 12);
const menuR = new Spring(MENU_COLLAPSED.r, 220, 29);
// Press feedback: squishes the glass and swells its refraction while the
// pointer is down, so the release winds up into the morph.
const menuPress = new Spring(0, 550, 14);
let menuExpanded = false;
let menuLens: LiquidLens | undefined;
const menuApplied = { w: menuW.value, h: menuH.value, r: menuR.value };
let menuNeedsFinalPass = false;

const menuEl = document.getElementById("liquid-menu") as HTMLElement;
const menuTrigger = document.getElementById("liquid-menu-trigger") as HTMLButtonElement;
const menuExpandedContent = menuEl.querySelector(
  ".menu-expanded-content",
) as HTMLElement;
// The menu lives inside the same backdrop as the draggable orb. Mark it
// before either lens snapshots the backdrop so each clone can omit the other
// glass frame instead of recursively refracting a lens inside a lens.
menuEl.setAttribute("data-caustics-lens", "");

/** Capsule clamp: the pill must not grow corners while the height is small. */
function menuRadius(): number {
  return Math.min(menuR.value, menuH.value / 2);
}

const MENU_OPTIONS = {
  depth: 24,
  curvature: 0.40,
  splay: 0.59,
  aberration: 0,
  blur: 4.0,
  saturation: 1.15,
  lightAngle: 0,
  specular: 1.00,
};

/** Lens options at this instant; borderRadius follows the animated spring. */
function currentOptions(): Required<Omit<LiquidLensOptions, "onReady">> {
  return {
    respectReducedMotion: true,
    trackScroll: true,
    trackContent: true,
    borderRadius: geomR.value,
    depth: num("depth"),
    curvature: num("curvature"),
    splay: num("splay"),
    aberration: num("aberration"),
    blur: num("blur"),
    saturation: num("saturation"),
    lightAngle: num("lightAngle"),
    specular: num("specular"),
  };
}

function applyTransform(): void {
  const left = (backgroundW - geomW.value) / 2 + springX.value;
  const top = (backgroundH - geomH.value) / 2 + springY.value;

  // Squash-and-stretch along the direction of travel.
  const speed = Math.hypot(springX.velocity, springY.velocity);
  const stretch = Math.min(speed * 0.00035, 0.12);
  const angle = speed > 1 ? Math.atan2(springY.velocity, springX.velocity) : 0;

  // Pressing squishes the frame slightly while the refraction swells.
  const squish = 1 - 0.05 * press.value;
  const scaleX = (1 + stretch) * squish;
  const scaleY = (1 - stretch) * squish;

  lensEl.style.transform =
    `translate(${left}px, ${top}px) ` +
    `rotate(${angle}rad) scale(${scaleX}, ${scaleY}) rotate(${-angle}rad)`;
  // The lens sits at the backdrop's origin and moves by transform only, so
  // its offset is exactly (left, top); syncTo avoids measuring layout.
  lens?.syncTo(left, top);
}

function tick(now: number): void {
  const dt = Math.min((now - lastTime) / 1000, 1 / 30);
  lastTime = now;

  springX.target = target.x;
  springY.target = target.y;
  geomW.target = num("width");
  geomH.target = num("height");
  geomR.target = num("borderRadius");

  const menuTarget = menuExpanded ? MENU_EXPANDED : MENU_COLLAPSED;
  menuW.target = menuTarget.w;
  menuH.target = menuTarget.h;
  menuR.target = menuTarget.r;

  const springs = [
    springX,
    springY,
    press,
    geomW,
    geomH,
    geomR,
    menuW,
    menuH,
    menuR,
    menuPress,
  ];
  if (reducedMotion.matches) {
    // No wobble, stretch, swell, or morph tween for users who asked for
    // less motion; everything jumps straight to its target.
    for (const spring of springs) spring.snap();
  } else {
    for (const spring of springs) spring.step(dt);
  }

  // Geometry morph: resize the frame and regenerate the maps cheaply.
  const geometryChanged =
    Math.abs(geomW.value - appliedGeom.w) > 0.1 ||
    Math.abs(geomH.value - appliedGeom.h) > 0.1 ||
    Math.abs(geomR.value - appliedGeom.r) > 0.1;

  if (geometryChanged) {
    appliedGeom.w = geomW.value;
    appliedGeom.h = geomH.value;
    appliedGeom.r = geomR.value;
    lensEl.style.width = `${geomW.value}px`;
    lensEl.style.height = `${geomH.value}px`;
    lensEl.style.borderRadius = `${geomR.value}px`;
    lens?.update(
      { ...currentOptions(), ...(lowTier ? { aberration: 0, blur: 0 } : null) },
      0.5,
    );
    refreshPreviews(0.5);
    needsFinalPass = true;
  }

  // Menu morph: resize the menu frame and regenerate maps cheaply.
  const menuChanged =
    Math.abs(menuW.value - menuApplied.w) > 0.1 ||
    Math.abs(menuH.value - menuApplied.h) > 0.1 ||
    Math.abs(menuR.value - menuApplied.r) > 0.1;

  if (menuChanged) {
    menuApplied.w = menuW.value;
    menuApplied.h = menuH.value;
    menuApplied.r = menuR.value;
    menuEl.style.width = `${menuW.value}px`;
    menuEl.style.height = `${menuH.value}px`;
    menuEl.style.borderRadius = `${menuRadius()}px`;
    menuLens?.update(
      { borderRadius: menuRadius(), ...(lowTier ? { blur: 0 } : null) },
      0.5,
    );
    menuNeedsFinalPass = true;

    // Content rides the morph instead of cross-fading on its own clock:
    // the label is gone in the first third of the height bloom, the
    // options arrive over the rest, still moving while the frame settles.
    const t = clamp(
      (menuH.value - MENU_COLLAPSED.h) / (MENU_EXPANDED.h - MENU_COLLAPSED.h),
      0,
      1,
    );
    const labelOut = clamp(t / 0.35, 0, 1);
    menuTrigger.style.opacity = String(1 - labelOut);
    menuTrigger.style.transform = `scale(${1 - 0.08 * labelOut})`;
    const optionsIn = clamp((t - 0.35) / 0.65, 0, 1);
    menuExpandedContent.style.opacity = String(optionsIn);
    menuExpandedContent.style.transform = `translateY(${-6 * (1 - optionsIn)}px)`;
  }

  applyTransform();
  lens?.setIntensity(1 + 0.9 * press.value);

  // The glass squishes under the pointer and gulps while its shape is in
  // flux: refraction swells with press and morph speed, relaxing to rest as
  // the springs settle. setIntensity is a no-op on repeats and pinned by
  // the lens under reduced motion. The press scale is decorative, so it is
  // deliberately not fed into the lens's backdrop offset.
  menuEl.style.transform = `scale(${1 - 0.045 * menuPress.value})`;
  menuLens?.setIntensity(
    1 +
      0.5 * menuPress.value +
      Math.min(Math.hypot(menuW.velocity, menuH.velocity) * 0.0006, 0.8),
  );

  if (dragging || springs.some((s) => !s.settled)) {
    rafId = requestAnimationFrame(tick);
  } else {
    if (needsFinalPass) {
      // One crisp full-resolution pass now that the morph has settled.
      needsFinalPass = false;
      lens?.update(currentOptions());
      refreshPreviews();
    }
    if (menuNeedsFinalPass) {
      menuNeedsFinalPass = false;
      menuLens?.update({ borderRadius: menuRadius(), blur: MENU_OPTIONS.blur });
    }
    rafId = undefined;
  }
}

/** Starts the animation loop if it is not already running. */
function wake(): void {
  if (rafId === undefined) {
    lastTime = performance.now();
    rafId = requestAnimationFrame(tick);
  }
}

// ---------------------------------------------------------------------------
// Map previews

const mobileLayout = matchMedia("(max-width: 768px)");

function refreshPreviews(resolution = 1): void {
  const options = currentOptions();
  const shape = {
    width: Math.round(geomW.value),
    height: Math.round(geomH.value),
    borderRadius: options.borderRadius,
    depth: options.depth,
    curvature: options.curvature,
    splay: options.splay,
  };

  const field = computeDisplacementField(shape, resolution);
  renderDisplacementMapToCanvas(mapCanvas, field, { scale: Math.max(options.depth, 1) });
  mapCanvas.style.width = `${shape.width}px`;
  mapCanvas.style.height = `${shape.height}px`;

  renderSpecularToCanvas(specularCanvas, shape, {
    lightAngle: options.lightAngle,
    strength: options.specular,
  }, resolution);
  specularCanvas.style.width = `${shape.width}px`;
  specularCanvas.style.height = `${shape.height}px`;
}

// ---------------------------------------------------------------------------
// Drag interaction

lensEl.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  lensEl.setPointerCapture(event.pointerId);
  lensEl.style.cursor = "grabbing";
  dragging = true;
  press.target = 1;
  if (lowTier) {
    // Every frame of the drag re-rasters the whole filter, so shed the
    // expensive passes for its duration; aberration is invisible on a
    // moving lens anyway. The settle pass restores the sliders' look.
    lens?.update({ aberration: 0, blur: 0 });
    needsFinalPass = true;
  }
  wake();

  const grabX = event.clientX - target.x;
  const grabY = event.clientY - target.y;

  const onMove = (moveEvent: PointerEvent) => {
    const maxX = (backgroundW - geomW.value) / 2;
    const maxY = (backgroundH - geomH.value) / 2;
    target.x = clamp(moveEvent.clientX - grabX, -maxX, maxX);
    target.y = clamp(moveEvent.clientY - grabY, -maxY, maxY);
  };

  const onUp = (upEvent: PointerEvent) => {
    lensEl.releasePointerCapture(upEvent.pointerId);
    lensEl.style.cursor = "grab";
    dragging = false;
    press.target = 0;
    wake();
    lensEl.removeEventListener("pointermove", onMove);
    lensEl.removeEventListener("pointerup", onUp);
    lensEl.removeEventListener("pointercancel", onUp);
  };

  lensEl.addEventListener("pointermove", onMove);
  lensEl.addEventListener("pointerup", onUp);
  lensEl.addEventListener("pointercancel", onUp);
});

// ---------------------------------------------------------------------------
// Backdrop controls
//
// The page backdrop and the clone inside the lens both read these custom
// properties through the .backdrop class, so changing them restyles the
// refracted copy too, even though the clone is a DOM snapshot.

const BACKDROP_IMAGES: Record<string, string> = {
  mountains: 'url("https://picsum.photos/id/1018/960/640")',
  stripes:
    "repeating-linear-gradient(45deg, #ff5f6d 0 20px, #ffc371 20px 40px), " +
    "repeating-linear-gradient(-45deg, transparent 0 10px, rgba(0, 0, 0, 0.15) 10px 20px)",
  river: 'url("https://picsum.photos/id/1015/960/640")',
  canyon: 'url("https://picsum.photos/id/1016/960/640")',
  pug: 'url("https://picsum.photos/id/1025/960/640")',
};

const swatches = Array.from(document.querySelectorAll<HTMLButtonElement>(".swatch"));
const backdropTextInput = document.getElementById("backdrop-text") as HTMLInputElement;

for (const swatch of swatches) {
  swatch.addEventListener("click", () => {
    for (const other of swatches) {
      other.classList.toggle("is-active", other === swatch);
    }
    document.documentElement.style.setProperty(
      "--backdrop-image",
      BACKDROP_IMAGES[swatch.dataset.image!],
    );
  });
}

backdropTextInput.addEventListener("input", () => {
  // JSON.stringify produces a valid quoted CSS string for `content`.
  document.documentElement.style.setProperty(
    "--backdrop-text",
    JSON.stringify(backdropTextInput.value),
  );
});

// ---------------------------------------------------------------------------
// Slider wiring: geometry sliders animate through the springs; everything
// else applies immediately.

for (const id of ids) {
  inputs[id].addEventListener("input", () => {
    refreshLabels();
    if (GEOMETRY_IDS.includes(id)) {
      wake();
    } else if (id === "stiffness" || id === "damping") {
      const val = num(id);
      if (id === "stiffness") {
        springX.stiffness = val;
        springY.stiffness = val;
      } else {
        springX.damping = val;
        springY.damping = val;
      }
    } else {
      lens?.update(currentOptions());
      refreshPreviews();
    }
  });
}

// ---------------------------------------------------------------------------
// Init: size the frame before creating the lens so the first generated map
// is correct, then hand the visual layers over to caustics.

refreshLabels();
lensEl.style.width = `${geomW.value}px`;
lensEl.style.height = `${geomH.value}px`;
lensEl.style.borderRadius = `${geomR.value}px`;
applyTransform();
lens = createLiquidLens(lensEl, background, currentOptions());
refreshPreviews();

// ---------------------------------------------------------------------------
// Menu Init & Interaction

const optReset = document.getElementById("opt-reset")!;
const optRandomize = document.getElementById("opt-randomize")!;

menuEl.style.width = `${menuW.value}px`;
menuEl.style.height = `${menuH.value}px`;
menuEl.style.borderRadius = `${menuRadius()}px`;
menuLens = createLiquidLens(menuEl, background, {
  ...MENU_OPTIONS,
  borderRadius: menuRadius(),
});

// Press feedback on tap: squishes the glass when the menu is collapsed
// (tapping the trigger icon), then springs back into the expand morph.
// When expanded, option buttons have their own :active feedback, so the
// whole-card squish is suppressed to avoid the entire frame bouncing.
menuEl.addEventListener("pointerdown", (event) => {
  if (menuExpanded && (event.target as HTMLElement).closest(".menu-opt-btn")) {
    return;
  }
  menuPress.target = 1;
  wake();
});
const releaseMenuPress = (): void => {
  menuPress.target = 0;
  wake();
};
menuEl.addEventListener("pointerup", releaseMenuPress);
menuEl.addEventListener("pointercancel", releaseMenuPress);
menuEl.addEventListener("pointerleave", releaseMenuPress);

// Toggle menu on click (excluding option clicks)
menuEl.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest(".menu-opt-btn")) {
    return;
  }
  if (menuExpanded) {
    collapseMenu();
  } else {
    expandMenu();
  }
});

function expandMenu(): void {
  if (menuExpanded) return;
  menuExpanded = true;
  menuEl.classList.add("is-expanded");
  menuTrigger.setAttribute("aria-expanded", "true");
  wake();
}

function collapseMenu({ restoreFocus = false } = {}): void {
  if (!menuExpanded) return;
  menuExpanded = false;
  menuEl.classList.remove("is-expanded");
  menuTrigger.setAttribute("aria-expanded", "false");
  if (restoreFocus) {
    menuTrigger.focus();
  }
  wake();
}

menuEl.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menuExpanded) {
    event.preventDefault();
    collapseMenu({ restoreFocus: true });
  }
});

// Click outside to close
document.addEventListener("click", (event) => {
  if (menuExpanded && !menuEl.contains(event.target as Node)) {
    collapseMenu();
  }
});

// Menu Action Options
const DEFAULT_VALUES = {
  width: 123,
  height: 118,
  borderRadius: 60,
  stiffness: 320,
  damping: 17,
  ...presets.full,
} as const;

optReset.addEventListener("click", (event) => {
  event.stopPropagation();
  for (const [id, value] of Object.entries(DEFAULT_VALUES)) {
    const input = inputs[id as ControlId];
    if (input) {
      input.value = String(value);
      input.dispatchEvent(new Event("input"));
    }
  }
});

optRandomize.addEventListener("click", (event) => {
  event.stopPropagation();
  for (const id of ids) {
    const input = inputs[id];
    if (!input) continue;
    const min = Number(input.min);
    const max = Number(input.max);
    const step = Number(input.step) || 1;
    const range = max - min;
    const stepsCount = Math.floor(range / step);
    const randomStep = Math.floor(Math.random() * (stepsCount + 1));
    const randomValue = min + randomStep * step;
    input.value = String(randomValue);
    input.dispatchEvent(new Event("input"));
  }
});
