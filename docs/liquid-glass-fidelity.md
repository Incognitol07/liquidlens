# Liquid Glass fidelity checklist

A living scorecard of LiquidLens against Apple's *Liquid Glass* launch
session (the design talk by Chan / Shubham / Bruno). It tracks how close the
library is to the described material, what's intentionally out of scope on the
web, and what's being built next.

Status legend: `[x]` done · `[~]` in progress · `[ ]` planned · `[—]` not
feasible on the web today (with a note).

Last reviewed: 2026-06-26.

---

## 1. Lensing & optics — the visual identity

> "The primary way Liquid Glass visually defines itself is through Lensing… it
> dynamically bends, shapes, and concentrates light in real time."

- [x] Real-time refraction (per-pixel light bending), not a blur — `feDisplacementMap` over a live backdrop clone
- [x] Curved-rim lens model (curvature + splay) — `computeDisplacementField`
- [x] Chromatic aberration / colour fringe — per-channel displacement split
- [x] Specular highlights layer (directional hot spot + counter-highlight + ambient fresnel ring), shape-aware
- [x] Saturation / vibrancy pass
- [x] Custom silhouettes (rect, pill, ellipse, squircle, arbitrary SDF)
- [x] Cross-browser (Chromium, Safari, Firefox)
- [ ] Materialize in/out by **modulating the lensing** instead of fading (entrance/exit)
- [—] Device-motion-aware highlights (gyroscope parallax) — possible via `DeviceOrientation` but unreliable/permissioned on web; deferred

## 2. Liquid motion — behaves like a lightweight liquid

> "The visuals AND motion of Liquid Glass were designed as one."

- [x] Spring-driven position follow with lag + wobble — `createLensFollower`
- [x] Velocity squash-and-stretch along heading
- [x] Press / grab energise — refraction swells on touch (`setIntensity`, `grabIntensity`)
- [x] Gel-like size morph between control states, per-axis lead-and-follow — `createLensMorph`
- [x] Menu "bubble pops open" in place — morph + content riding `onFrame`
- [ ] **Thicker-material-on-morph**: larger glass auto-gains deeper shadow, more lensing, softer scatter
- [ ] Inner glow that spreads from the fingertip and onto **nearby** glass elements (needs a `LensGroup` coordinator)

## 3. Adaptivity — reads what's behind it and stays legible

> "Each layer continuously adapts based on what's behind it… buttons remain
> legible, while letting as much of the content through as possible."

This is the biggest gap from the original audit, and the focus of the current
build. **Keystone:** a backdrop **luminance probe** — almost every adaptive
behaviour needs the same one input (the brightness under the lens).

- [x] **Luminance probe** — sample backdrop brightness under the frame (img/canvas/video, `background-image` cover/contain, `background-color`; CORS-graceful; live as you drag/scroll) — `core/luminance.ts`
- [x] **Adaptive shadow** — shadow strengthens over bright/busy content, softens over dark (Apple: shadow opacity rises over text, drops over solid light)
- [x] **Light/dark auto-flip** — material + glyphs flip to the legible tone (`--ll-ink` + frame colour) by backdrop luminance, with hysteresis
- [x] **Adaptive tint** — tint tone tracks content brightness like real coloured glass; filter regen gated to settle (not per-frame)
- [ ] Scroll edge effects — dissolve/dim content into the background at the glass edge (prototyped as a separate `backdrop-filter` overlay, then dropped: it read as a generic blur strip rather than part of the material; revisit only if it can be made to feel native)
- [ ] Ambient colour spill onto large surfaces (sidebars) from nearby content
- [—] Per-pixel luminance over **arbitrary DOM** backdrops — no general DOM→pixels API on the web; covered cases are image/canvas/video/background-image/background-colour, with an explicit `luminance` override escape hatch

## 4. Variants & usage discipline

> "Two variants: Regular and Clear. They should never be mixed."

- [x] Regular-style adaptive material (once §3 lands)
- [ ] Clear variant — permanently transparent + a dimming layer for legibility
- [x] Tinting as a first-class, material-respecting overlay (not a flat fill)
- [ ] Localized dimming for small Clear elements

## 5. Accessibility modifiers

> "Available automatically whenever you use the new material."

- [x] Reduced Motion — springs snap, press-swell pinned
- [x] Reduced Transparency — frostier, obscures more (more blur + opaque fill)
- [ ] Increased Contrast — predominantly black/white + contrasting border

## 6. Dynamic Island (stretch target)

- [x] Springy pill that morphs compact ↔ expanded with lead-and-follow
- [x] Content cross-fade driven off the morph (`onFrame`)
- [ ] **Gooey / metaball merge** of two separate elements (the signature "two islands fuse")
- [ ] Graceful degradation over a flat dark status bar (glass needs visible content to lens)

---

## Build order

The adaptive cluster in §3 — **shipped** (2026-06-26):

1. [x] Luminance probe (`core/luminance.ts`)
2. [x] Adaptive layer (`core/adaptive.ts`) — shadow · ink flip · tint
3. [x] `adaptive` option wired into `createLiquidLens` (runtime-toggleable via `update`)
4. [x] Unit tests for the pure mappings (`luminance.test.ts`, `adaptive.test.ts`)
5. [x] Exported from `core/index.ts`
6. [x] Wired into the debug app (Adaptive group + live luminance/ink readout + orb ink label)
7. [x] `pnpm build` + `pnpm test` green (58 tests)

> API surface: `createLiquidLens(frame, backdrop, { adaptive: true })`, or
> `{ adaptive: { shadow, ink, tint, tintStrength, luminance, probe } }` to tune.
> Also exported standalone: `createBackdropLuminance`, `relativeLuminance`,
> `createAdaptiveLayer`, and the pure mappings `adaptiveShadow` / `inkColor` /
> `adaptTint`. Content placed in the frame can read `var(--ll-ink)` to flip with
> the glass.

### Deferred to later passes

- Thicker-material-on-morph; materialize-in/out (`reveal`)
- Accessibility modifiers on the lens itself (reduced transparency, increased contrast)
- Inner-glow propagation (`LensGroup`)
- Gooey merge for Dynamic Island

> Scroll edge effects were prototyped and dropped — a separate `backdrop-filter`
> overlay read as a generic blur strip, not part of the material. The lesson
> carried forward: new behaviours should live **on the glass element as layers**
> (as the adaptive shadow/ink do), not as bolted-on siblings.
