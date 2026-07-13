# LiquidLens site: landing page at `/`, playground at `/panel`

**Date:** 2026-07-13
**Status:** Approved

## Goal

Give LiquidLens a public face: a marketing one-pager at `/` where the page itself
is the demo, and the existing debug playground relocated to `/panel`. One Vite
app, one deploy, hosted on Vercel or Netlify.

## Decisions made during brainstorming

- **Landing scope:** marketing one-pager (hero + live demo, install command,
  feature highlights, link to `/panel`, GitHub, npm). No docs sections.
- **Structure:** one app, two pages — a Vite multi-page build. No router, no
  framework.
- **Aesthetic:** monochrome editorial, in the visual language of
  bestdesignsonx.com / collectui.com (fonts and neutral oklch palette were
  extracted from their public CSS; their gallery content is client-rendered
  and was not consumable).
- **Hero concept:** approach A — "the page is the demo". No boxed demo stages;
  real lenses float over the page's real typography.
- **Deployment:** Vercel/Netlify static hosting with clean URLs.

## Architecture

- Rename `apps/debug` → `apps/site` (workspace package stays `private: true`;
  its `package.json` name becomes `site`).
- Vite multi-page app with two HTML entries:
  - `apps/site/index.html` + `src/landing/main.ts` — the landing, served at `/`.
  - `apps/site/panel/index.html` + the existing `src/main.ts` (moved to
    `src/panel/main.ts`) — the playground, served at `/panel`. Panel content is
    unchanged except for the adjusted script path and page title.
- `vite.config.ts` declares both HTML files under
  `build.rollupOptions.input`. Vite's dev server serves `/panel/` from the
  nested `index.html` natively; on Vercel, `cleanUrls: true` maps `/panel` to
  `panel/index.html` (Netlify's pretty URLs do the same).
- The landing imports **only `@liquidlens/core`** (framework-agnostic), same as
  the panel. `@liquidlens/react` remains a thin wrapper and is not used by the
  site.

## Landing composition (one scroll)

Voice per the README philosophy: demo first, reader-verb headings, short
sentences, feel over spec, honest about limits.

1. **Glass nav** — the morphing liquid menu (createLensMorph, per-axis springs,
   the same pattern the panel ships) promoted to real navigation, top-right:
   Panel · GitHub · npm. Collapsed: a small glass pebble. Expanded: the
   Apple-style row menu.
2. **Hero** — `liquidlens` wordmark; Instrument Serif italic headline (working
   copy: *"Glass that actually bends the light."*); a **draggable liquid lens**
   (createLiquidLens + createLensFollower) floating over the headline,
   refracting the type. Below: `pnpm add @liquidlens/core` in a mono chip,
   click-to-copy with the panel's copied-state pattern.
3. **Feel it** — three editorial rows, each with one small inline glass element
   demonstrating exactly that row's claim:
   - *Refraction & light* — depth, curvature, specular on a static lens over
     the row's own text.
   - *Liquid motion* — a lens that spring-follows the cursor across the row
     (fine pointers only), showing squash-and-stretch.
   - *Adaptive legibility* — a lens straddling a light/dark boundary in the
     row, its ink flipping via the adaptive layer.
4. **Tune it** — one sentence plus a prominent link into `/panel`, framed as
   "every knob lives here; copy a ready React snippet when it feels right."
5. **A few honest notes** — browser caveats (WebKit quirks, performance tiers),
   in the README's candid tone.
6. **Footer** — GitHub, npm, MIT license note.

## Visual system

- **Palette:** monochrome oklch neutrals. Light: background `oklch(98.5% 0 0)`,
  ink `oklch(14.5% 0 0)`; dark flips them. Hairline borders at 8–10% opacity.
  No accent color anywhere — the refracted glass is the only spectacle.
- **Theme:** shares the panel's `data-theme` attribute; the localStorage key is
  renamed to `liquidlens-theme` in both pages (reading the old
  `liquidlens-debug-theme` value once as a migration fallback) so the choice
  persists across `/` and `/panel`. Same pre-paint inline script to avoid
  theme flash.
- **Type:** Instrument Serif italic for display headlines only; Geist for body
  and UI; the panel's existing mono stack for code. Loaded from Google Fonts
  with `display=swap` and system fallbacks.
- **Layout:** editorial column ~720px, generous whitespace, content-led.

## Behavior, performance, accessibility

- **Progressive enhancement:** the landing is fully readable as static HTML;
  all lenses are JS enhancements layered on top.
- **Performance:** reuse the panel's tiering — on `performanceTier() === "low"`,
  drop aberration/blur during drag and restore on settle; morphs regenerate
  maps at reduced resolution until springs settle.
- **Pointers:** hero lens uses pointer capture drag (panel orb pattern),
  `touch-action: none` on the lens only. Cursor-follow flourishes gate on
  `(pointer: fine)`; on coarse pointers they degrade to tap-to-nudge.
- **Reduced motion / transparency / contrast:** pass through the library's
  `respectReducedMotion`, `reducedTransparency: "auto"`,
  `increasedContrast: "auto"`.
- **Meta:** landing gets title, description, and OG tags; `/panel` keeps its
  own title ("liquidlens — panel" or similar).
- **Error handling:** font failures fall back to system stacks; clipboard
  failures fall back to selecting the text (existing panel pattern).

## Testing & verification

- `pnpm build` and `tsc --noEmit` must pass (CI as today).
- Manual verification in the dev server: hero drag, nav morph, copy affordance,
  theme persistence across `/` ↔ `/panel`, `/panel` unchanged functionally,
  mobile layout (coarse-pointer fallbacks), reduced-motion behavior.
- No unit tests in the site app; the packages carry the test suites.

## Out of scope

- API documentation pages.
- Consuming gallery content from bestdesignsonx.com / collectui.com (their
  feeds are client-rendered; only their public design tokens informed the
  aesthetic).
- npm org registration, custom domain, analytics.
