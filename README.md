# glasskit

A liquid glass lens for the web, built on SVG displacement maps. One promise: the same effect renders in Chromium, Safari, and Firefox, because it never touches `backdrop-filter`.

> Status: early development. Not yet published to npm.

## How it works

CSS cannot bend the pixels behind an element, so glasskit takes the approach Aave described in their Liquid Glass write-up:

1. Generate a displacement map on a canvas. The map is derived from a signed distance field of the lens shape, so displacement is strongest at the rim and zero in the center. Red encodes horizontal shift, green encodes vertical shift, 128 means no shift.
2. Feed that map into an SVG `feDisplacementMap` filter, applied with plain `filter` (not `backdrop-filter`, which Safari and Firefox handle inconsistently for SVG filters).
3. Since the filter can only bend the element's own content, place a pixel-aligned copy of the backdrop inside the lens and bend that.

On top of the refraction, the filter displaces the red, green, and blue channels by slightly different amounts (chromatic aberration), then applies a small blur and a saturation boost. A specular rim light is computed from the same distance field (surface normals against a configurable light direction) and screen-blended over the result, so the glossy edge follows the lens shape exactly.

The map is only regenerated when the lens shape changes. Moving the lens is a transform update, so dragging stays cheap.

## Usage

There is no npm package yet. Inside this repo, depend on the workspace package:

```json
{ "dependencies": { "@glasskit/core": "workspace:*" } }
```

### `createLiquidLens(frame, backdrop, options?)`

The high-level API. Give it a positioned element (the lens) and the element behind it (the backdrop). It clones the backdrop into the lens, keeps the clone aligned, and manages the filter and shine layers.

```ts
import { createLiquidLens } from "@glasskit/core";

const lens = createLiquidLens(
  document.getElementById("lens")!,
  document.getElementById("background")!,
  { depth: 24, curvature: 0.4 },
);

// After moving the lens (e.g. on every drag frame). Cheap.
lens.sync();

// Refraction strength multiplier, also cheap enough for every frame.
// Useful for interaction feedback, e.g. swelling the glass on press.
lens.setIntensity(1.5);

// After changing options. Regenerates the displacement map.
lens.update({ depth: 32 });

// Removes everything the lens added to the document.
lens.destroy();
```

Options (all optional):

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

### `createGlassFilter(doc?)`

The low-level primitive, for when you want to manage the DOM yourself. It builds the SVG filter, injects it into the document, and returns a handle:

```ts
import { createGlassFilter } from "@glasskit/core";

const glass = createGlassFilter();

glass.update({
  width: 200,
  height: 120,
  borderRadius: 48,
  depth: 24,
  curvature: 0.4,
  splay: 0,
  aberration: 0.12,
  blur: 0.2,
  saturation: 1.15,
});

myElement.style.filter = glass.cssFilter;
```

You are then responsible for giving `myElement` content to bend, typically a copy of whatever sits behind it.

### Math utilities

The underlying functions are exported for direct use: `roundedRectSDF`, `computeDisplacementField`, `displacementFieldToPixels`, `renderDisplacementMapToCanvas`, and `renderSpecularToCanvas`. They are pure (apart from the canvas renders) and have no DOM dependencies beyond the canvas API.

## Limitations

- The backdrop clone is a snapshot. If the backdrop's content changes, destroy the lens and create it again.
- Content that does not survive `cloneNode` (live `<video>`, `<canvas>` state, iframes) will not appear refracted.
- The lens shows a copy of the backdrop, not the actual pixels behind it, so it only works over content you control.

## Development

```sh
pnpm install
pnpm build        # build all packages
pnpm test         # run unit tests
pnpm --filter @glasskit/debug dev   # interactive playground at localhost:5173
```

The repo is a pnpm workspace: `packages/core` is the zero-dependency library, `apps/debug` is a playground with sliders for every parameter and a live view of the generated displacement map.
