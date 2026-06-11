import { computeDisplacementField } from "./displacement";
import { renderDisplacementMapToCanvas } from "./map";
import type { LensParams } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/** Matrices that isolate a single color channel (alpha preserved). */
const CHANNEL_MATRICES = {
  red: "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0",
  green: "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0",
  blue: "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0",
} as const;

export interface GlassFilterOptions extends LensParams {
  /** 0..1 — relative extra displacement of red vs blue (chromatic aberration) */
  aberration: number;
  /** Gaussian blur stdDeviation in px applied to the refracted content */
  blur: number;
  /** Color saturation multiplier; 1 leaves colors unchanged */
  saturation: number;
}

export interface GlassFilter {
  /**
   * Value for the CSS `filter` property, e.g. `url(#glasskit-1-0)`.
   * Re-read and re-apply this after every `update()`: the filter id cycles
   * on update to force a repaint in WebKit, which otherwise ignores changes
   * to the primitives of an already-referenced filter.
   */
  readonly cssFilter: string;
  /** Regenerates the displacement map and re-tunes the filter primitives. */
  update(options: GlassFilterOptions): void;
  /**
   * Multiplies the displacement magnitude on top of the last `update`
   * without regenerating the map. Cheap enough to call every animation
   * frame; intended for interaction feedback such as swelling on press.
   */
  setIntensity(factor: number): void;
  /** Removes the filter's SVG element from the document. */
  destroy(): void;
}

let nextFilterId = 1;

/**
 * Builds the liquid-glass SVG filter and injects it into the document.
 *
 * Pipeline: the element's content is displaced through a generated map once
 * per color channel — red and blue slightly more/less than green, fringing
 * the rim like real dispersion — then the channels are recombined, softened
 * with a slight blur, and saturated. Apply the returned `cssFilter` to the
 * element whose pixels should bend (typically a copy of the page backdrop;
 * the filter cannot sample what is behind the element).
 *
 * The filter region keeps SVG's default 10% margin so rim pixels can sample
 * content just outside the element's bounds.
 */
export function createGlassFilter(doc: Document = document): GlassFilter {
  const idBase = `glasskit-${nextFilterId++}`;
  let generation = 0;
  let id = `${idBase}-${generation}`;

  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute";

  const filter = doc.createElementNS(SVG_NS, "filter");
  filter.setAttribute("id", id);
  filter.setAttribute("color-interpolation-filters", "sRGB");
  svg.appendChild(filter);

  const fe = (name: string, attrs: Record<string, string>): SVGElement => {
    const el = doc.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs)) {
      el.setAttribute(key, value);
    }
    filter.appendChild(el);
    return el;
  };

  const mapImage = fe("feImage", {
    x: "0",
    y: "0",
    preserveAspectRatio: "none",
    result: "map",
  });

  const displaceChannel = (channel: keyof typeof CHANNEL_MATRICES): SVGElement => {
    const displaced = fe("feDisplacementMap", {
      in: "SourceGraphic",
      in2: "map",
      xChannelSelector: "R",
      yChannelSelector: "G",
      result: `${channel}-displaced`,
    });
    fe("feColorMatrix", {
      in: `${channel}-displaced`,
      type: "matrix",
      values: CHANNEL_MATRICES[channel],
      result: channel,
    });
    return displaced;
  };

  const displaceRed = displaceChannel("red");
  const displaceGreen = displaceChannel("green");
  const displaceBlue = displaceChannel("blue");

  fe("feComposite", {
    in: "red",
    in2: "green",
    operator: "arithmetic",
    k1: "0",
    k2: "1",
    k3: "1",
    k4: "0",
    result: "red-green",
  });
  fe("feComposite", {
    in: "red-green",
    in2: "blue",
    operator: "arithmetic",
    k1: "0",
    k2: "1",
    k3: "1",
    k4: "0",
    result: "refracted",
  });

  const blur = fe("feGaussianBlur", {
    in: "refracted",
    stdDeviation: "0",
    result: "softened",
  });
  const saturate = fe("feColorMatrix", {
    in: "softened",
    type: "saturate",
    values: "1",
  });

  doc.body.appendChild(svg);

  const mapCanvas = doc.createElement("canvas");

  // Scale state lives outside update() so per-frame intensity changes can
  // re-tune displacement magnitude without regenerating the map.
  let baseScale = 0;
  let aberration = 0;
  let intensity = 1;

  const applyScales = (): void => {
    const scale = baseScale * intensity;
    displaceRed.setAttribute("scale", String(scale * (1 + aberration)));
    displaceGreen.setAttribute("scale", String(scale));
    displaceBlue.setAttribute("scale", String(scale * (1 - aberration)));
  };

  return {
    get cssFilter() {
      return `url(#${id})`;
    },

    update(options: GlassFilterOptions): void {
      // Cycle the filter id so WebKit notices the change; it does not
      // reliably repaint when an already-referenced filter's primitives
      // are mutated in place.
      generation += 1;
      id = `${idBase}-${generation}`;
      filter.setAttribute("id", id);

      // Encode the field so `depth` px spans the full channel range, giving
      // the 8-bit map maximum precision. Generate at device resolution
      // (capped to bound canvas cost) so the map stays sharp on high-DPI
      // displays; feImage scales it back down to CSS pixels.
      const depth = Math.max(options.depth, 1);
      const resolution = Math.min(doc.defaultView?.devicePixelRatio ?? 1, 2);
      const field = computeDisplacementField(options, resolution);
      renderDisplacementMapToCanvas(mapCanvas, field, { scale: depth });

      // Both href forms are needed: Safari/Firefox honor xlink:href,
      // Chromium honors href.
      const mapDataUrl = mapCanvas.toDataURL("image/png");
      mapImage.setAttribute("href", mapDataUrl);
      mapImage.setAttributeNS(XLINK_NS, "href", mapDataUrl);
      mapImage.setAttribute("width", String(options.width));
      mapImage.setAttribute("height", String(options.height));

      // feDisplacementMap shifts by scale * (channel - 0.5), so scale =
      // 2 * depth recovers the encoded pixel displacement.
      baseScale = 2 * depth;
      aberration = options.aberration;
      applyScales();

      blur.setAttribute("stdDeviation", String(options.blur));
      saturate.setAttribute("values", String(options.saturation));
    },

    setIntensity(factor: number): void {
      intensity = factor;
      applyScales();
    },

    destroy(): void {
      svg.remove();
    },
  };
}
