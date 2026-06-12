https://github.com/user-attachments/assets/87d1479b-1117-4a65-9683-1850960a5403


# caustics

Liquid glass for the web: real refraction from displacement maps, not a blur and a white border. Caustics are the patterns light forms after bending through water or glass, which is what this library computes.

## Works in your browser

| Chromium | Safari | Firefox |
| --- | --- | --- |
| yes | yes | yes |

One rendering path everywhere: SVG filters applied with plain CSS `filter`, which all three engines agree on. The common alternative, `backdrop-filter` with filter functions, silently degrades to a flat blur outside Chromium. That difference is the reason this library exists.

<!-- side-by-side image goes here: a backdrop-filter library in Safari vs caustics in Safari -->

## Use

```sh
npm install caustics
```

> Not on npm yet. Until the first release, clone this repo and `pnpm build`.

```ts
import { createLiquidLens } from "caustics";

// A glass dock floating over the page hero. The lens clones the hero's
// content and bends it, so it works in any browser that can draw SVG.
const lens = createLiquidLens(
  document.querySelector<HTMLElement>(".dock")!,
  document.querySelector<HTMLElement>(".hero")!,
);

// Moving the dock? One cheap call per frame keeps the refraction aligned.
dock.addEventListener("pointermove", () => lens.sync());
```

Scrolling needs no calls at all: the lens watches scroll events itself, so content scrolling under the glass — the backdrop, a feed inside it, or the page — bends live, the way it does in the system version.

That's the whole integration. Sizing, styling, and positioning of the lens element stay yours; the library only manages what's inside it. `lens.update({ depth: 32 })` changes the optics, `lens.setIntensity(1.5)` swells the glass for press feedback, `lens.destroy()` removes every trace. On devices where the full effect is heavy, start from a named preset instead of tuning blind: `presets.lean` drops the two passes that dominate filter cost, `presets.minimal` reduces the filter to a single displacement pass.

## How it works

A signed distance field of the lens shape is rendered to a canvas as a displacement map: red encodes horizontal shift, green vertical, strongest at the rim and zero in the flat center. That map drives an SVG `feDisplacementMap` filter applied to a pixel-aligned copy of the backdrop inside the lens, because a filter can only bend an element's own pixels, never what's behind it. The same distance field's surface normals generate the specular rim light and the chromatic aberration, so the refraction, the fringe, and the highlight always describe the same physical surface; that agreement is what makes it read as glass instead of decoration. The map only regenerates when the shape changes, so moving the lens is just a transform update, cheap enough for every frame of a drag.

## API

`createLiquidLens(frame, backdrop, options?)` returns `{ update, sync, syncTo, setIntensity, destroy }` — `syncTo(offsetX, offsetY)` is the layout-read-free variant of `sync()` for per-frame paths where the frame's position is already known. Options, all optional:

| Option | Default | Meaning |
| --- | --- | --- |
| `depth` | `24` | Maximum displacement at the rim, in px |
| `curvature` | `0.4` | Width of the curved rim relative to the lens size, 0 to 1 |
| `splay` | `0.59` | Blends displacement direction from edge-normal (0) to radial (1) |
| `aberration` | `0.05` | Chromatic aberration strength, 0 to 1 |
| `blur` | `0.2` | Blur in px applied to the refracted content |
| `saturation` | `1.15` | Saturation multiplier for the refracted content |
| `lightAngle` | `0` | Light direction in degrees: 0 lights the top edge, 90 the right edge |
| `specular` | `1` | Strength of the specular rim highlight, 0 to 1 |
| `borderRadius` | computed style | Corner radius in px, read from the frame if omitted |
| `respectReducedMotion` | `true` | Stills press-swell feedback while the OS asks for reduced motion |
| `trackScroll` | `true` | Keeps the refraction aligned with backdrop, inner, and page scrolling |

Setting `aberration`, `blur`, or `specular` to `0` (or `saturation` to `1`) removes that pass from the SVG filter entirely rather than running it at zero strength — the named `presets` are just these knobs bundled into `full`, `lean`, and `minimal` tiers.

For full control there is also `createGlassFilter()` (builds and manages just the SVG filter; you supply the DOM structure) and the raw math: `roundedRectSDF`, `computeDisplacementField`, `displacementFieldToPixels`, `renderDisplacementMapToCanvas`, `renderSpecularToCanvas`. React bindings live in `@caustics/react` (`useLiquidLens` hook and a `<LiquidLens>` component).

## Limitations

- The lens refracts a clone of the backdrop, not the live pixels behind it, so it only works over content you control. Scrolling is mirrored into the clone automatically, but the content itself is a snapshot; recreate the lens if the backdrop's content changes.
- Content that does not survive `cloneNode` (playing `<video>`, `<canvas>` state, iframes) appears frozen or blank inside the lens.

## Development

```sh
pnpm install
pnpm build                          # build all packages
pnpm test                           # run unit tests
pnpm --filter @caustics/debug dev   # interactive playground at localhost:5173
```

pnpm workspace: `packages/core` is the zero-dependency library (`caustics`), `packages/react` the React bindings, `apps/debug` a playground with a slider for every parameter and live views of the generated displacement and specular maps.
