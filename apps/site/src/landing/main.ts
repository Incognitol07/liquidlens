import {
  createLensFollower,
  createLiquidLens,
  type LensFollower,
  type LiquidLens,
  type LiquidLensOptions,
} from "@liquidlens/core";

// Glass frames fall back to a plain frost until the lenses exist, so a no-JS
// visit still reads; the flag flips them to transparent for the real thing.
document.documentElement.classList.add("js");

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

function populate(items: MenuItem[]): void {
  popupRows.replaceChildren();
  for (const item of items) {
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

// First open creates the lens (it needs the panel visible to measure);
// later opens re-measure for the new row count and re-align the refraction.
function refreshPopupLens(): void {
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

function openMenu(id: string): void {
  const button = menuButtons.find((b) => b.dataset.menu === id);
  if (!button) return;
  closeOverlays("menu");
  for (const other of menuButtons) {
    other.classList.toggle("is-open", other === button);
    other.setAttribute("aria-expanded", String(other === button));
  }
  openMenuId = id;
  populate(MENUS[id]);
  popup.hidden = false;
  popup.style.top = "";

  const desktopRect = desktop.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();
  const left = clamp(
    buttonRect.left - desktopRect.left,
    8,
    Math.max(8, desktop.clientWidth - popup.offsetWidth - 8),
  );
  popup.style.left = `${left}px`;
  refreshPopupLens();
}

/** The Finder-style right-click menu, opened at the cursor. */
function openContextMenu(clientX: number, clientY: number): void {
  closeOverlays("menu");
  openMenuId = "context";
  populate(CONTEXT_MENU);
  popup.hidden = false;

  const desktopRect = desktop.getBoundingClientRect();
  popup.style.left = `${clamp(
    clientX - desktopRect.left,
    8,
    Math.max(8, desktop.clientWidth - popup.offsetWidth - 8),
  )}px`;
  popup.style.top = `${clamp(
    clientY - desktopRect.top,
    40,
    Math.max(40, desktop.clientHeight - popup.offsetHeight - 8),
  )}px`;
  refreshPopupLens();
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
  // With a menu open, gliding along the bar switches menus, macOS style. A
  // context menu doesn't arm the bar, so it doesn't participate.
  button.addEventListener("pointerenter", () => {
    if (openMenuId !== null && openMenuId !== "context" && openMenuId !== id) {
      openMenu(id);
    }
  });
}

desktop.addEventListener("contextmenu", (event) => {
  // Only the wallpaper gets the Finder menu; UI keeps the browser's own.
  if (event.target !== desktop) return;
  event.preventDefault();
  openContextMenu(event.clientX, event.clientY);
});

document.addEventListener("pointerdown", (event) => {
  const target = event.target as HTMLElement;
  if (openMenuId !== null && !popup.contains(target) && !target.closest?.(".mb-item")) {
    closeMenu();
  }
  if (!ccEl.hidden && !ccEl.contains(target) && !target.closest?.("#mb-cc")) {
    closeControlCenter();
  }
  if (!spotlightEl.hidden && !spotlightEl.contains(target) && !target.closest?.("#mb-search")) {
    closeSpotlight();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeOverlays();
  }
  // The web's command-palette chord opens Spotlight.
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (spotlightEl.hidden) {
      openSpotlight();
    } else {
      closeSpotlight();
    }
  }
});

/** Closes every transient surface except the one being opened. */
function closeOverlays(except?: "menu" | "cc" | "spotlight"): void {
  if (except !== "menu") closeMenu();
  if (except !== "cc") closeControlCenter();
  if (except !== "spotlight") closeSpotlight();
}

// ---------------------------------------------------------------------------
// Desktop icons: click selects, click again (or double-click) opens. Clicking
// the wallpaper clears the selection, like the Finder.

const deskIconsEl = document.getElementById("desk-icons") as HTMLElement;
const deskIcons = Array.from(document.querySelectorAll<HTMLButtonElement>(".desk-icon"));

function wireDeskIcon(icon: HTMLButtonElement): void {
  icon.addEventListener("click", (event) => {
    event.stopPropagation();
    if (icon.classList.contains("is-selected")) {
      if (icon.dataset.href) go(icon.dataset.href);
      return;
    }
    for (const other of deskIcons) {
      other.classList.toggle("is-selected", other === icon);
    }
  });
  icon.addEventListener("dblclick", () => {
    if (icon.dataset.href) go(icon.dataset.href);
  });
}

deskIcons.forEach(wireDeskIcon);

desktop.addEventListener("pointerdown", (event) => {
  if (event.target === desktop) {
    for (const icon of deskIcons) {
      icon.classList.remove("is-selected");
    }
  }
});

// "New Folder" mints a real desktop icon: selectable like the others, and
// named the way the Finder names them.
const FOLDER_SVG =
  '<svg viewBox="0 0 52 52"><path d="M6 14a4 4 0 0 1 4-4h10.5l4 4.5H42a4 4 0 0 1 4 4V38a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z" fill="#4ba1ec"/><path d="M6 19h40v19a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z" fill="#6db9f8"/></svg>';
let folderCount = 0;

function createFolder(): void {
  folderCount++;
  const name = folderCount === 1 ? "untitled folder" : `untitled folder ${folderCount}`;
  const icon = document.createElement("button");
  icon.type = "button";
  icon.className = "desk-icon";
  icon.innerHTML = `<span class="di-icon di-folder" aria-hidden="true">${FOLDER_SVG}</span><span class="di-label"></span>`;
  (icon.querySelector(".di-label") as HTMLElement).textContent = name;
  deskIconsEl.append(icon);
  deskIcons.push(icon);
  wireDeskIcon(icon);
}

const CONTEXT_MENU: MenuItem[] = [
  { label: "New Folder", action: createFolder },
  "sep",
  { label: "Get Info", hint: "⌘I", action: showWindow },
  "sep",
  { label: "Change Desktop Background…", action: () => go("/panel/") },
  { label: "Open the Panel", hint: "⌘P", action: () => go("/panel/") },
];

// ---------------------------------------------------------------------------
// Control Center: Wi-Fi and Bluetooth chips hold state, the Display slider
// really dims the screen (through the veil), Sound is along for the ride.

const ccEl = document.getElementById("control-center") as HTMLElement;
const ccButton = document.getElementById("mb-cc") as HTMLButtonElement;
const veil = document.getElementById("brightness-veil") as HTMLElement;
let ccLens: LiquidLens | undefined;

function openControlCenter(): void {
  closeOverlays("cc");
  ccEl.hidden = false;
  ccButton.classList.add("is-open");
  ccButton.setAttribute("aria-expanded", "true");
  if (!ccLens) {
    ccLens = createLiquidLens(ccEl, desktop, {
      ...BASE,
      ...GLASS_TINT,
      borderRadius: 16,
      depth: 10,
      curvature: 0.35,
      splay: 0.5,
      aberration: 0,
      blur: 3,
      saturation: 1.4,
      specular: 0.7,
    });
  } else {
    ccLens.sync();
  }
}

function closeControlCenter(): void {
  if (ccEl.hidden) return;
  ccEl.hidden = true;
  ccButton.classList.remove("is-open");
  ccButton.setAttribute("aria-expanded", "false");
}

ccButton.addEventListener("click", () => {
  if (ccEl.hidden) {
    openControlCenter();
  } else {
    closeControlCenter();
  }
});

function wireChip(chipId: string, stateId: string): void {
  const chip = document.getElementById(chipId) as HTMLButtonElement;
  const state = document.getElementById(stateId) as HTMLElement;
  chip.addEventListener("click", () => {
    const on = chip.classList.toggle("is-on");
    state.textContent = on ? "On" : "Off";
  });
}

wireChip("cc-wifi", "cc-wifi-state");
wireChip("cc-bt", "cc-bt-state");

function wireCcSlider(id: string, onInput?: (value: number) => void): void {
  const slider = document.getElementById(id) as HTMLInputElement;
  const refresh = (): void => {
    const min = Number(slider.min);
    const max = Number(slider.max);
    const value = Number(slider.value);
    slider.style.setProperty("--p", `${((value - min) / (max - min)) * 100}%`);
    onInput?.(value);
  };
  slider.addEventListener("input", refresh);
  refresh();
}

wireCcSlider("cc-brightness", (value) => {
  // 100 → clear screen; the floor (30) leaves everything readable.
  veil.style.opacity = String(((100 - value) / 100) * 0.62);
});
wireCcSlider("cc-sound");

// ---------------------------------------------------------------------------
// Spotlight: a command palette over glass. ⌘K / Ctrl+K or the magnifier.

type SpotlightAction = { label: string; sub: string; run: () => void };

const SPOTLIGHT_ACTIONS: SpotlightAction[] = [
  { label: "About liquidlens", sub: "liquidlens", run: showWindow },
  { label: "Open the Panel", sub: "Panel.app", run: () => go("/panel/") },
  { label: "README", sub: "Documentation", run: () => go(`${GITHUB}#readme`) },
  { label: "GitHub", sub: "github.com", run: () => go(GITHUB) },
  { label: "npm", sub: "npmjs.com", run: () => go(NPM) },
  { label: "Report an Issue", sub: "GitHub Issues", run: () => go(`${GITHUB}/issues`) },
  { label: "New Folder", sub: "Desktop", run: createFolder },
];

const spotlightEl = document.getElementById("spotlight") as HTMLElement;
const spotlightInput = document.getElementById("spotlight-input") as HTMLInputElement;
const spotlightResults = document.getElementById("spotlight-results") as HTMLElement;
const searchButton = document.getElementById("mb-search") as HTMLButtonElement;
let spotlightLens: LiquidLens | undefined;
let spotlightMatches: SpotlightAction[] = [];
let spotlightIndex = 0;
let spotlightRowCount = -1;

function runSpotlight(action: SpotlightAction): void {
  closeSpotlight();
  action.run();
}

function renderSpotlight(): void {
  const query = spotlightInput.value.trim().toLowerCase();
  spotlightMatches = SPOTLIGHT_ACTIONS.filter(
    (a) => a.label.toLowerCase().includes(query) || a.sub.toLowerCase().includes(query),
  );
  spotlightIndex = 0;
  spotlightResults.replaceChildren();

  if (spotlightMatches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sp-empty";
    empty.textContent = "No Results";
    spotlightResults.append(empty);
  }

  spotlightMatches.forEach((action, i) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "sp-row";
    row.classList.toggle("is-active", i === spotlightIndex);
    const label = document.createElement("span");
    label.textContent = action.label;
    const sub = document.createElement("small");
    sub.textContent = action.sub;
    row.append(label, sub);
    row.addEventListener("pointerenter", () => {
      spotlightIndex = i;
      highlightSpotlight();
    });
    row.addEventListener("click", () => runSpotlight(action));
    spotlightResults.append(row);
  });

  // The panel's height follows the row count; re-measure the lens only when
  // it actually changed so typing doesn't regenerate maps per keystroke.
  const count = spotlightMatches.length;
  if (count !== spotlightRowCount) {
    spotlightRowCount = count;
    spotlightLens?.update();
    spotlightLens?.sync();
  }
}

function highlightSpotlight(): void {
  const rows = spotlightResults.querySelectorAll<HTMLElement>(".sp-row");
  rows.forEach((row, i) => row.classList.toggle("is-active", i === spotlightIndex));
}

function openSpotlight(): void {
  closeOverlays("spotlight");
  spotlightEl.hidden = false;
  searchButton.classList.add("is-open");
  searchButton.setAttribute("aria-expanded", "true");
  spotlightInput.value = "";
  spotlightRowCount = -1;
  renderSpotlight();
  if (!spotlightLens) {
    spotlightLens = createLiquidLens(spotlightEl, desktop, {
      ...BASE,
      ...GLASS_TINT,
      borderRadius: 16,
      depth: 12,
      curvature: 0.35,
      splay: 0.5,
      aberration: 0,
      blur: 3,
      saturation: 1.4,
      specular: 0.8,
    });
    spotlightRowCount = spotlightMatches.length;
  }
  spotlightInput.focus();
}

function closeSpotlight(): void {
  if (spotlightEl.hidden) return;
  spotlightEl.hidden = true;
  searchButton.classList.remove("is-open");
  searchButton.setAttribute("aria-expanded", "false");
}

searchButton.addEventListener("click", () => {
  if (spotlightEl.hidden) {
    openSpotlight();
  } else {
    closeSpotlight();
  }
});

spotlightInput.addEventListener("input", renderSpotlight);

spotlightInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (spotlightMatches.length === 0) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    spotlightIndex =
      (spotlightIndex + step + spotlightMatches.length) % spotlightMatches.length;
    highlightSpotlight();
  } else if (event.key === "Enter") {
    const action = spotlightMatches[spotlightIndex];
    if (action) runSpotlight(action);
  }
});

