https://github.com/user-attachments/assets/87d1479b-1117-4a65-9683-1850960a5403

# caustics

Liquid glass for the web.

Caustics makes a normal HTML element feel like a real piece of glass. Put it
over a hero, toolbar, card, menu, dock, or draggable orb, and the content
underneath bends through it with shine, color, and depth.

It is not just a blurred rectangle with a white border. It looks alive.

## Why It Is Mindblowing

Most glass effects on the web fall apart the moment you leave Chromium. They
usually become a soft blur in Safari or Firefox, which is fine for frosted UI
but not for liquid glass.

Caustics takes a different path: the same effect works in Chromium, Safari,
and Firefox.

| Chromium | Safari | Firefox |
| --- | --- | --- |
| yes | yes | yes |

You still own the element. Style it, resize it, drag it, morph it, animate it.
Caustics handles the glass inside.

## Install

```sh
npm install caustics
```

Not published yet. Until the first release, clone this repo and run:

```sh
pnpm install
pnpm build
```

## Use It

Give Caustics two elements:

- the glass element
- the thing behind it

```ts
import { createLiquidLens } from "caustics";

const glass = document.querySelector<HTMLElement>(".glass")!;
const backdrop = document.querySelector<HTMLElement>(".hero")!;

const lens = createLiquidLens(glass, backdrop);
```

That is enough for a static glass element.

```html
<section class="hero">
  <div class="glass">Menu</div>
</section>
```

```css
.hero {
  position: relative;
  min-height: 400px;
  background: url("/image.jpg") center / cover;
}

.glass {
  position: absolute;
  top: 24px;
  right: 24px;
  width: 180px;
  height: 72px;
  border-radius: 24px;
  overflow: hidden;
}
```

## Move It

If the glass moves, tell Caustics where it is after you move it.

```ts
glass.style.transform = `translate(${x}px, ${y}px)`;
lens.sync();
```

For drag animations where you already know the offset, use the cheaper path:

```ts
lens.syncTo(x, y);
```

## Tune It

Start simple:

```ts
createLiquidLens(glass, backdrop, {
  depth: 30,
  specular: 0.9,
  saturation: 1.2,
});
```

Useful knobs:

| Option | What it feels like |
| --- | --- |
| `depth` | More or less bend |
| `specular` | Stronger or softer shine |
| `saturation` | Richer or calmer color |
| `blur` | Softer or sharper glass |
| `aberration` | More or less color fringe |
| `borderRadius` | Match custom rounded shapes |

Or start from a preset:

```ts
import { createLiquidLens, presets } from "caustics";

createLiquidLens(glass, backdrop, {
  ...presets.lean,
  depth: 28,
});
```

Presets:

- `full`: the prettiest version
- `lean`: still glassy, cheaper to run
- `minimal`: the simplest effect that still bends

## Press, Morph, Animate

Use `setIntensity()` for touch feedback:

```ts
glass.addEventListener("pointerdown", () => lens.setIntensity(1.5));
glass.addEventListener("pointerup", () => lens.setIntensity(1));
```

If the element changes size or radius, update the lens:

```ts
lens.update({
  borderRadius: 32,
});
```

## React

React bindings live in `@caustics/react`.

```tsx
import { LiquidLens } from "@caustics/react";

<LiquidLens backdropRef={heroRef} preset="lean" depth={30}>
  Menu
</LiquidLens>;
```

## A Few Honest Notes

- Caustics works over content you control.
- If the backdrop content changes a lot, recreate the lens.
- Video, canvas, and iframes may not appear live inside the glass.

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm --filter @caustics/debug dev
```

Workspace:

- `packages/core`: the main library
- `packages/react`: React bindings
- `apps/debug`: playground for tuning the effect
