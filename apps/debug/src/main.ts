import {
  computeDisplacementField,
  createLiquidLens,
  renderDisplacementMapToCanvas,
  renderSpecularToCanvas,
  type LiquidLens,
  type LiquidLensOptions,
} from "caustics";
import { Spring } from "./spring";

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
const springX = new Spring(0, 320, 17);
const springY = new Spring(0, 320, 17);
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

// Menu springs and variables — snappier stiffness for UI-scale morphs
const menuW = new Spring(120, 220, 18);
const menuH = new Spring(36, 220, 18);
const menuR = new Spring(18, 220, 18);
let menuExpanded = false;
let menuLens: LiquidLens | undefined;
const menuApplied = { w: menuW.value, h: menuH.value, r: menuR.value };
let menuNeedsFinalPass = false;

const MENU_OPTIONS = {
  depth: 10,
  curvature: 0.3,
  splay: 0.5,
  aberration: 0.015,
  blur: 0.4,
  saturation: 1.15,
  lightAngle: 0,
  specular: 0.7,
};

/** Lens options at this instant; borderRadius follows the animated spring. */
function currentOptions(): Required<LiquidLensOptions> {
  return {
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

  menuW.target = menuExpanded ? 240 : 120;
  menuH.target = menuExpanded ? 88 : 36;
  menuR.target = menuExpanded ? 12 : 18;

  const springs = [springX, springY, press, geomW, geomH, geomR, menuW, menuH, menuR];
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
    lens?.update(currentOptions(), 0.5);
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
    const menuEl = document.getElementById("liquid-menu")!;
    menuEl.style.width = `${menuW.value}px`;
    menuEl.style.height = `${menuH.value}px`;
    menuEl.style.borderRadius = `${menuR.value}px`;
    menuLens?.update({ borderRadius: menuR.value }, 0.5);
    menuNeedsFinalPass = true;
  }

  applyTransform();
  lens?.setIntensity(1 + 0.9 * press.value);

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
      menuLens?.update({ borderRadius: menuR.value });
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

function refreshPreviews(): void {
  const options = currentOptions();
  const shape = {
    width: Math.round(geomW.value),
    height: Math.round(geomH.value),
    borderRadius: options.borderRadius,
    depth: options.depth,
    curvature: options.curvature,
    splay: options.splay,
  };

  const field = computeDisplacementField(shape);
  renderDisplacementMapToCanvas(mapCanvas, field, { scale: Math.max(options.depth, 1) });
  mapCanvas.style.width = `${field.width}px`;
  mapCanvas.style.height = `${field.height}px`;

  renderSpecularToCanvas(specularCanvas, shape, {
    lightAngle: options.lightAngle,
    strength: options.specular,
  });
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
  stripes:
    "repeating-linear-gradient(45deg, #ff5f6d 0 20px, #ffc371 20px 40px), " +
    "repeating-linear-gradient(-45deg, transparent 0 10px, rgba(0, 0, 0, 0.15) 10px 20px)",
  river: 'url("https://picsum.photos/id/1015/960/640")',
  canyon: 'url("https://picsum.photos/id/1016/960/640")',
  mountains: 'url("https://picsum.photos/id/1018/960/640")',
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

const menuEl = document.getElementById("liquid-menu")!;
const controlsEl = document.getElementById("controls")!;
const optReset = document.getElementById("opt-reset")!;
const optRandomize = document.getElementById("opt-randomize")!;

menuEl.style.width = `${menuW.value}px`;
menuEl.style.height = `${menuH.value}px`;
menuEl.style.borderRadius = `${menuR.value}px`;
menuLens = createLiquidLens(menuEl, controlsEl, {
  ...MENU_OPTIONS,
  borderRadius: menuR.value,
});

// Sync refraction on scroll
controlsEl.addEventListener("scroll", () => {
  menuLens?.sync();
});

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
  wake();
}

function collapseMenu(): void {
  if (!menuExpanded) return;
  menuExpanded = false;
  menuEl.classList.remove("is-expanded");
  wake();
}

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
  depth: 24,
  curvature: 0.4,
  splay: 0.59,
  aberration: 0.05,
  blur: 0.2,
  saturation: 1.15,
  lightAngle: 0,
  specular: 1,
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
