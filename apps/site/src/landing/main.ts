import {
  createLensFollower,
  createLiquidLens,
  performanceTier,
  type LensFollower,
  type LiquidLens,
  type LiquidLensOptions,
} from "@liquidlens/core";

// Glass frames fall back to a plain frost until the lenses exist, so a no-JS
// visit still reads; the flag flips them to transparent for the real thing.
document.documentElement.classList.add("js");

const lowTier = performanceTier() === "low";
const finePointer = matchMedia("(pointer: fine)");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const desktop = document.getElementById("desktop") as HTMLElement;
const windowEl = document.getElementById("window") as HTMLElement;
const titlebar = document.getElementById("titlebar") as HTMLElement;
const dock = document.getElementById("dock") as HTMLElement;
const popup = document.getElementById("menu-popup") as HTMLElement;
const popupRows = document.getElementById("menu-rows") as HTMLElement;

// The wallpaper never scrolls or mutates (every moving part is a marked lens
// frame the clones omit), so content/scroll tracking would be wasted work.
const BASE: LiquidLensOptions = {
  respectReducedMotion: true,
  trackScroll: false,
  trackContent: false,
  reducedTransparency: "auto",
  increasedContrast: "auto",
};

let popupLens: LiquidLens | undefined;

// Tahoe windows are frostier than they look: the tint has to carry text
// legibility over the darkest parts of the wallpaper.
const GLASS_TINT: Pick<LiquidLensOptions, "tint" | "tintOpacity"> = {
  tint: "#ffffff",
  tintOpacity: 0.45,
};

// ---------------------------------------------------------------------------
// Menu bar clock: "Sun Jul 13  9:41 AM".

const clock = document.getElementById("clock") as HTMLElement;

function tickClock(): void {
  const now = new Date();
  const date = now
    .toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    })
    .replace(",", "");
  const time = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  clock.textContent = `${date}  ${time}`;
}

tickClock();
setInterval(tickClock, 30_000);

// ---------------------------------------------------------------------------
// The glass surfaces. The menu bar is transparent (as on a real Mac), so the
// lenses are the window, the dock, and the shared dropdown panel.

// Lighter frost than the dock: the adaptive layer samples the wallpaper
// under the window and flips the prose ink, and that only reads as honest
// when the backdrop still dominates the surface.
const WINDOW_OPTICS: LiquidLensOptions = {
  ...BASE,
  borderRadius: 19,
  depth: 24,
  curvature: 0.45,
  splay: 0.55,
  aberration: 0.06,
  blur: 4,
  saturation: 1.4,
  specular: 1,
  specularSharpness: 9,
  adaptive: true,
  tint: "#ffffff",
  tintOpacity: 0.3,
};

const windowLens = createLiquidLens(windowEl, desktop, WINDOW_OPTICS);

// The slab is sized to the resting row before its lens is created, then
// stretched (scaleX) to follow the row as magnification widens it — a few
// percent of stretch on blurred glass is invisible, and it avoids paying a
// full refraction-map regeneration on every frame of the hover.
const dockBg = document.getElementById("dock-bg") as HTMLElement;
const dockRestWidth = dock.offsetWidth;
dockBg.style.width = `${dockRestWidth}px`;
dockBg.style.height = `${dock.offsetHeight}px`;
const dockLens = createLiquidLens(dockBg, desktop, {
  ...BASE,
  ...GLASS_TINT,
  borderRadius: 25,
  depth: 18,
  curvature: 0.6,
  splay: 0.5,
  aberration: 0.04,
  blur: 3,
  saturation: 1.4,
  specular: 0.9,
});

// ---------------------------------------------------------------------------
// Window: dragged by its title bar through a spring follower.

function windowHome(): { x: number; y: number } {
  return {
    x: (desktop.clientWidth - windowEl.offsetWidth) / 2,
    y: Math.max((desktop.clientHeight - windowEl.offsetHeight) * 0.34, 48),
  };
}

/** Keeps the whole window on the desktop, below the menu bar. */
function clampWindow(p: { x: number; y: number }): { x: number; y: number } {
  return {
    x: clamp(p.x, 8, Math.max(8, desktop.clientWidth - windowEl.offsetWidth - 8)),
    y: clamp(p.y, 40, Math.max(40, desktop.clientHeight - windowEl.offsetHeight - 8)),
  };
}

// No physics on the window: real macOS windows track the pointer rigidly.
// The follower stays only for the programmatic moves (fly from the dock,
// re-center), which use its spring via .to(); the drag itself jumps with
// .set(), and squash/press are off.
const windowFollow: LensFollower = createLensFollower(windowEl, windowLens, {
  stiffness: 380,
  damping: 28,
  initial: windowHome(),
});

let windowMoved = false;
let dragging = false;

titlebar.addEventListener("pointerdown", (event) => {
  // The traffic lights live in the title bar but are buttons, not a handle.
  if ((event.target as HTMLElement).closest(".light")) return;
  event.preventDefault();
  closeMenu();
  titlebar.setPointerCapture(event.pointerId);
  dragging = true;
  windowMoved = true;
  windowLens?.setIntensity(1.3);
  if (lowTier) {
    // A drag re-rasters the filter every frame; shed the costly passes.
    windowLens?.update({ aberration: 0, blur: 0 });
  }

  const grabX = event.clientX - windowFollow.x;
  const grabY = event.clientY - windowFollow.y;

  const onMove = (moveEvent: PointerEvent): void => {
    const target = clampWindow({
      x: moveEvent.clientX - grabX,
      y: moveEvent.clientY - grabY,
    });
    // Rigid 1:1 tracking; .set() jumps and keeps the refraction aligned.
    windowFollow.set(target.x, target.y);
  };

  const onUp = (upEvent: PointerEvent): void => {
    titlebar.releasePointerCapture(upEvent.pointerId);
    dragging = false;
    windowLens?.setIntensity(1);
    if (lowTier) {
      windowLens?.update(WINDOW_OPTICS);
    }
    titlebar.removeEventListener("pointermove", onMove);
    titlebar.removeEventListener("pointerup", onUp);
    titlebar.removeEventListener("pointercancel", onUp);
  };

  titlebar.addEventListener("pointermove", onMove);
  titlebar.addEventListener("pointerup", onUp);
  titlebar.addEventListener("pointercancel", onUp);
});

function centerWindow(): void {
  windowMoved = false;
  const home = windowHome();
  windowFollow.to(home.x, home.y);
}

// Double-click on the title bar zooms (recenters), like macOS.
titlebar.addEventListener("dblclick", (event) => {
  if ((event.target as HTMLElement).closest(".light")) return;
  centerWindow();
});

new ResizeObserver(() => {
  if (dragging) return;
  const target = windowMoved
    ? clampWindow({ x: windowFollow.x, y: windowFollow.y })
    : windowHome();
  windowFollow.to(target.x, target.y);
}).observe(desktop);

// ---------------------------------------------------------------------------
// Traffic lights and the dock's running app. Close and minimize send the
// window to the dock; the app tile bounces it back.

const dockApp = document.getElementById("dock-app") as HTMLButtonElement;
let windowHidden = false;

function hideWindow(): void {
  if (windowHidden) return;
  windowHidden = true;
  windowEl.classList.add("hidden");
  windowEl.setAttribute("aria-hidden", "true");
  dockApp.classList.remove("running");
}

function showWindow(): void {
  if (windowHidden) {
    windowHidden = false;
    windowEl.classList.remove("hidden");
    windowEl.removeAttribute("aria-hidden");
    dockApp.classList.add("running");
    // Fly back up from the dock rather than popping into place.
    const home = windowHome();
    if (!reducedMotion.matches) {
      windowFollow.set(home.x, desktop.clientHeight - windowEl.offsetHeight / 2);
    }
    windowMoved = false;
    windowFollow.to(home.x, home.y);
  } else {
    centerWindow();
  }
}

document.getElementById("light-close")!.addEventListener("click", hideWindow);
document.getElementById("light-min")!.addEventListener("click", hideWindow);
document.getElementById("light-zoom")!.addEventListener("click", centerWindow);

dockApp.addEventListener("click", () => {
  dockApp.classList.remove("bounce");
  // Restart the bounce even on rapid clicks.
  void dockApp.offsetWidth;
  dockApp.classList.add("bounce");
  showWindow();
});

// ---------------------------------------------------------------------------
// Install command: copied from the chip or the Edit menu.

const install = document.getElementById("install") as HTMLButtonElement;
const installSwap = document.getElementById("install-swap") as HTMLElement;
let installTimer: number | undefined;

async function copyInstall(): Promise<void> {
  try {
    await navigator.clipboard.writeText("pnpm add @liquidlens/core");
  } catch {
    return;
  }
  installSwap.dataset.state = "b";
  clearTimeout(installTimer);
  installTimer = window.setTimeout(() => {
    installSwap.dataset.state = "a";
  }, 1400);
}

install.addEventListener("click", copyInstall);

// ---------------------------------------------------------------------------
// Menus: real macOS drop-downs. One shared glass panel is repositioned and
// repopulated per menu; while a menu is open, hovering another title switches.

const GITHUB = "https://github.com/Incognitol07/liquidlens";
const NPM = "https://www.npmjs.com/package/@liquidlens/core";

type MenuItem = { label: string | (() => string); hint?: string; action: () => void } | "sep";

function go(url: string): void {
  if (url.startsWith("http")) {
    window.open(url, "_blank", "noopener");
  } else {
    location.href = url;
  }
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    void document.exitFullscreen();
  } else {
    void document.documentElement.requestFullscreen?.();
  }
}

const MENUS: Record<string, MenuItem[]> = {
  logo: [
    { label: "About liquidlens", action: showWindow },
    "sep",
    { label: "Open the Panel", hint: "⌘P", action: () => go("/panel/") },
    "sep",
    { label: "GitHub", action: () => go(GITHUB) },
    { label: "npm", action: () => go(NPM) },
  ],
  app: [
    { label: "About liquidlens", action: showWindow },
    { label: "Settings…", hint: "⌘,", action: () => go("/panel/") },
    "sep",
    { label: "Hide liquidlens", hint: "⌘H", action: hideWindow },
  ],
  file: [
    { label: "New Window", hint: "⌘N", action: showWindow },
    "sep",
    { label: "Close Window", hint: "⌘W", action: hideWindow },
  ],
  edit: [
    { label: "Copy Install Command", hint: "⌘C", action: () => void copyInstall() },
  ],
  view: [
    { label: "Enter Full Screen", hint: "⌃⌘F", action: toggleFullscreen },
  ],
  window: [
    { label: "Minimize", hint: "⌘M", action: hideWindow },
    { label: "Zoom", action: centerWindow },
    "sep",
    { label: "Center Window", action: centerWindow },
  ],
  help: [
    { label: "liquidlens Help", action: () => go(`${GITHUB}#readme`) },
    { label: "Report an Issue", action: () => go(`${GITHUB}/issues`) },
  ],
};

const menuButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".mb-item[data-menu]"),
);
let openMenuId: string | null = null;

function populate(id: string): void {
  popupRows.replaceChildren();
  for (const item of MENUS[id]) {
    if (item === "sep") {
      const sep = document.createElement("div");
      sep.className = "menu-sep";
      popupRows.append(sep);
      continue;
    }
    const row = document.createElement("button");
    row.type = "button";
    row.className = "menu-row";
    row.setAttribute("role", "menuitem");
    const label = document.createElement("span");
    label.textContent = typeof item.label === "function" ? item.label() : item.label;
    row.append(label);
    if (item.hint) {
      const hint = document.createElement("span");
      hint.className = "menu-hint";
      hint.textContent = item.hint;
      row.append(hint);
    }
    row.addEventListener("click", () => {
      closeMenu();
      item.action();
    });
    popupRows.append(row);
  }
}

function openMenu(id: string): void {
  const button = menuButtons.find((b) => b.dataset.menu === id);
  if (!button) return;
  for (const other of menuButtons) {
    other.classList.toggle("is-open", other === button);
    other.setAttribute("aria-expanded", String(other === button));
  }
  openMenuId = id;
  populate(id);
  popup.hidden = false;

  const desktopRect = desktop.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();
  const left = clamp(
    buttonRect.left - desktopRect.left,
    8,
    Math.max(8, desktop.clientWidth - popup.offsetWidth - 8),
  );
  popup.style.left = `${left}px`;

  // First open creates the lens (it needs the panel visible to measure);
  // later opens re-measure for the new row count and re-align the refraction.
  if (!popupLens) {
    popupLens = createLiquidLens(popup, desktop, {
      ...BASE,
      ...GLASS_TINT,
      borderRadius: 13,
      depth: 10,
      curvature: 0.35,
      splay: 0.5,
      aberration: 0,
      blur: 3,
      saturation: 1.4,
      specular: 0.7,
    });
  } else {
    popupLens.update();
    popupLens.sync();
  }
}

function closeMenu(): void {
  if (openMenuId === null) return;
  openMenuId = null;
  popup.hidden = true;
  for (const button of menuButtons) {
    button.classList.remove("is-open");
    button.setAttribute("aria-expanded", "false");
  }
}

for (const button of menuButtons) {
  const id = button.dataset.menu!;
  button.addEventListener("click", () => {
    if (openMenuId === id) {
      closeMenu();
    } else {
      openMenu(id);
    }
  });
  // With a menu open, gliding along the bar switches menus, macOS style.
  button.addEventListener("pointerenter", () => {
    if (openMenuId !== null && openMenuId !== id) {
      openMenu(id);
    }
  });
}

document.addEventListener("pointerdown", (event) => {
  const target = event.target as Node;
  if (openMenuId !== null && !popup.contains(target) && !(target as HTMLElement).closest?.(".mb-item")) {
    closeMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMenu();
  }
});

// ---------------------------------------------------------------------------
// Desktop icons: click selects, click again (or double-click) opens. Clicking
// the wallpaper clears the selection, like the Finder.

const deskIcons = Array.from(document.querySelectorAll<HTMLButtonElement>(".desk-icon"));

for (const icon of deskIcons) {
  icon.addEventListener("click", (event) => {
    event.stopPropagation();
    if (icon.classList.contains("is-selected")) {
      go(icon.dataset.href!);
      return;
    }
    for (const other of deskIcons) {
      other.classList.toggle("is-selected", other === icon);
    }
  });
  icon.addEventListener("dblclick", () => go(icon.dataset.href!));
}

desktop.addEventListener("pointerdown", (event) => {
  if (event.target === desktop) {
    for (const icon of deskIcons) {
      icon.classList.remove("is-selected");
    }
  }
});

// ---------------------------------------------------------------------------
// Dock magnification. macOS's feel comes from three things this reproduces:
// the scale follows the cursor continuously (no eased jumps, so no CSS
// transition; a per-frame lerp smooths it instead), neighbors are displaced
// sideways so tiles never overlap, and everything relaxes when the pointer
// leaves. Base geometry is read from layout (transforms don't disturb it).

const MAG_SCALE = 0.42; // extra size on the tile under the cursor
const MAG_REACH = 58; // gaussian falloff radius, px
const MAG_SMOOTH = 18; // lerp rate, 1/s

const dockItems = Array.from(dock.querySelectorAll<HTMLElement>(".dock-item"));
const dockBase = dockItems[0].offsetWidth;
const scales = new Map<HTMLElement, number>(dockItems.map((i) => [i, 1]));

// The cursor is tracked in viewport coordinates and re-projected onto the
// row every frame: the row's left edge shifts as it widens, so a position
// cached at pointermove time would drift between events.
let dockClientX: number | null = null;
let dockRafId: number | undefined;
let dockLastTime = 0;

function stepDock(now: number): void {
  const dt = Math.min((now - dockLastTime) / 1000, 1 / 30);
  dockLastTime = now;
  const blend = Math.min(1, MAG_SMOOTH * dt);
  const dockMouseX =
    dockClientX === null ? null : dockClientX - dock.getBoundingClientRect().left;
  let settled = true;

  // Distance is measured against each tile's live center, so the field
  // stays attached to the tiles as the row reflows under the cursor.
  for (const item of dockItems) {
    const center = item.offsetLeft + item.offsetWidth / 2;
    let target = 1;
    if (dockMouseX !== null) {
      const d = dockMouseX - center;
      target = 1 + MAG_SCALE * Math.exp(-(d * d) / (2 * MAG_REACH * MAG_REACH));
    }
    const current = scales.get(item)!;
    const next = current + (target - current) * blend;
    scales.set(item, next);
    if (Math.abs(next - target) > 0.002) settled = false;
  }

  for (const item of dockItems) {
    const size = dockBase * scales.get(item)!;
    item.style.width = `${size}px`;
    item.style.height = `${size}px`;
  }

  // The wrapper keeps the widened row centered; the glass slab stretches to
  // match it.
  dockBg.style.transform = `translateX(-50%) scaleX(${dock.offsetWidth / dockRestWidth})`;

  if (dockMouseX !== null || !settled) {
    dockRafId = requestAnimationFrame(stepDock);
  } else {
    for (const item of dockItems) {
      item.style.width = "";
      item.style.height = "";
    }
    dockBg.style.transform = "translateX(-50%)";
    dockRafId = undefined;
  }
}

function wakeDock(): void {
  if (dockRafId === undefined) {
    dockLastTime = performance.now();
    dockRafId = requestAnimationFrame(stepDock);
  }
}

dock.addEventListener("pointermove", (event) => {
  if (!finePointer.matches || reducedMotion.matches) return;
  dockClientX = event.clientX;
  wakeDock();
});

dock.addEventListener("pointerleave", () => {
  dockClientX = null;
  wakeDock();
});

const trash = document.getElementById("dock-trash") as HTMLButtonElement;
trash.addEventListener("click", () => {
  trash.classList.remove("shake");
  void trash.offsetWidth;
  trash.classList.add("shake");
});
