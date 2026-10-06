import { computeDisplacementField } from "./displacement";
import { renderDisplacementMapToCanvas } from "./map";
import { renderSpecularToCanvas } from "./specular";
import type { LensParams } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/** Matrices that isolate a single color channel (alpha preserved). */
const CHANNEL_MATRICES = {
  red: "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0",
  green: "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0",
  blue: "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0",
} as const;

/** Below this, the per-channel split is invisible and not worth its cost. */
const ABERRATION_EPSILON = 0.0005;
/** Below this distance from 1, the saturate pass changes nothing visible. */
const SATURATION_EPSILON = 0.001;

/** The optical (non-geometry) knobs of the glass effect. */
export interface GlassEffectOptions {
  /**
   * 0..1: relative extra displacement of red vs blue (chromatic aberration).
   * 0 collapses the three per-channel displacement passes into one, which
   * is markedly cheaper on devices that rasterize SVG filters on the CPU.
   */
  aberration: number;
  /**
   * Gaussian blur stdDeviation in px applied to the refracted content.
   * 0 removes the blur pass from the filter entirely.
   */
  blur: number;
  /** Color saturation multiplier; 1 leaves colors unchanged (pass skipped) */
  saturation: number;
  /** Light direction in degrees: 0 lights the top edge, 90 the right edge */
  lightAngle: number;
  /**
   * 0..1: strength of the specular rim highlight, rendered into
   * `specularImage` (not into the filter). 0 skips generating it.
   */
  specular: number;
  /** CSS color of the specular highlight (default white). */
  specularColor?: string;
  /** Directional exponent of the highlight; higher is a tighter hot spot. */
  specularSharpness?: number;
}

export interface GlassFilterOptions extends LensParams, GlassEffectOptions {}

export interface GlassFilter {
  /**
   * Value for the CSS `filter` property, e.g. `url(#liquidlens-1-0)`.
   * Re-read and re-apply this after every `update()`: the filter id cycles
   * on update to force a repaint in WebKit, which otherwise ignores changes
   * to the primitives of an already-referenced filter.
   */
  readonly cssFilter: string;
  /**
   * Data URL of the specular rim image from the last `update()`, sized to
   * the lens (stretch it over the element), or `""` when `specular` is 0.
   * The filter does not include the rim: draw this as a layer above the
   * filtered element with `mix-blend-mode: screen`.
   */
  readonly specularImage: string;
  /**
   * Regenerates the displacement and specular maps and re-tunes the filter.
   * `resolution` (samples per CSS px) overrides the devicePixelRatio
   * default; pass ~0.5 when updating every frame of a shape animation.
   */
  update(options: GlassFilterOptions, resolution?: number): void;
  /**
   * Multiplies the displacement magnitude on top of the last `update`
   * without regenerating the map. Cheap enough to call every animation
   * frame; intended for interaction feedback such as swelling on press.
   * A repeated factor is a no-op, so callers may invoke it unconditionally.
   */
  setIntensity(factor: number): void;
  /** Removes the filter's SVG element from the document. */
  destroy(): void;
}

let nextFilterId = 1;

/** Hidden `<svg><filter>` host plus the WebKit id-cycling machinery. */
interface FilterShell {
  svg: SVGSVGElement;
  filter: SVGElement;
  readonly id: string;
  /** Assigns a fresh id; call at the start of every map update. */
  cycle(): void;
}

function createFilterShell(doc: Document): FilterShell {
  const idBase = `liquidlens-${nextFilterId++}`;
  let generation = 0;
  let id = `${idBase}-0`;

  const svg = doc.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute";

  const filter = doc.createElementNS(SVG_NS, "filter");
  filter.setAttribute("id", id);
  filter.setAttribute("color-interpolation-filters", "sRGB");
  svg.appendChild(filter);

  return {
    svg,
    filter,
    get id() {
      return id;
    },
    cycle() {
      generation += 1;
      id = `${idBase}-${generation}`;
      filter.setAttribute("id", id);
    },
  };
}

/** Which optional passes the pipeline contains. */
interface PipelineConfig {
  /** Three per-channel displacements (chromatic aberration) vs one */
  split: boolean;
  blur: boolean;
  saturate: boolean;
}

function sameConfig(a: PipelineConfig, b: PipelineConfig): boolean {
  return (
    a.split === b.split &&
    a.blur === b.blur &&
    a.saturate === b.saturate
  );
}

interface PipelineHandles {
  config: PipelineConfig;
  mapImage: SVGElement;
  /** [red, green, blue] when split, otherwise a single element */
  displacements: SVGElement[];
  blur?: SVGElement;
  saturate?: SVGElement;
}

/**
 * Builds the refraction pipeline into `filter`, replacing any previous
 * primitives: displacement (per-channel when aberration is on) -> optional
 * blur -> optional saturate. Every pass an option turns off is a real
 * per-frame raster cost avoided, so the pipeline only ever contains what the
 * current settings use.
 *
 * The specular rim and the tint are not part of the graph: the caller draws
 * them as layers over the element, where they cost almost nothing per frame,
 * while blending the rim in the graph is one of its most expensive passes.
 */
function buildPipeline(
  doc: Document,
  filter: SVGElement,
  config: PipelineConfig,
): PipelineHandles {
  const primitives = Array.from(filter.children);
  let mapImage = primitives.find(el => el.tagName === "feImage" && el.getAttribute("result") === "map") as SVGElement | undefined;

  // Remove everything except the map feImage, which keeps its href so a
  // rebuild needn't re-decode the map.
  for (const child of primitives) {
    if (child !== mapImage) {
      child.remove();
    }
  }

  if (!mapImage) {
    mapImage = doc.createElementNS(SVG_NS, "feImage");
    mapImage.setAttribute("x", "0");
    mapImage.setAttribute("y", "0");
    mapImage.setAttribute("preserveAspectRatio", "none");
    mapImage.setAttribute("result", "map");
    filter.appendChild(mapImage);
  }

  const fe = (name: string, attrs: Record<string, string>): SVGElement => {
    const el = doc.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs)) {
      el.setAttribute(key, value);
    }
    filter.appendChild(el);
    return el;
  };

  const displace = (result: string): SVGElement =>
    fe("feDisplacementMap", {
      in: "SourceGraphic",
      in2: "map",
      xChannelSelector: "R",
      yChannelSelector: "G",
      result,
    });

  let displacements: SVGElement[];
  let current: string;

  if (config.split) {
    const displaceChannel = (channel: keyof typeof CHANNEL_MATRICES): SVGElement => {
      const displaced = displace(`${channel}-displaced`);
      fe("feColorMatrix", {
        in: `${channel}-displaced`,
        type: "matrix",
        values: CHANNEL_MATRICES[channel],
        result: channel,
      });
      return displaced;
    };

    displacements = [
      displaceChannel("red"),
      displaceChannel("green"),
      displaceChannel("blue"),
    ];

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
  } else {
    displacements = [displace("refracted")];
  }
  current = "refracted";

  let blur: SVGElement | undefined;
  if (config.blur) {
    blur = fe("feGaussianBlur", {
      in: current,
      stdDeviation: "0",
      result: "softened",
    });
    current = "softened";
  }

  let saturate: SVGElement | undefined;
  if (config.saturate) {
    saturate = fe("feColorMatrix", {
      in: current,
      type: "saturate",
      values: "1",
      result: "glass",
    });
    current = "glass";
  }

  return {
    config,
    mapImage,
    displacements,
    blur,
    saturate,
  };
}

/** Points an feImage at a canvas's current content, stretched to width x height px. */
function applyImage(
  image: SVGElement,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  urlOverride?: string,
): string {
  // Both href forms are needed: Safari/Firefox honor xlink:href,
  // Chromium honors href.
  const url = urlOverride ?? canvas.toDataURL("image/png");
  image.setAttribute("href", url);
  image.setAttributeNS(XLINK_NS, "href", url);
  image.setAttribute("width", String(width));
  image.setAttribute("height", String(height));
  return url;
}

/**
 * Builds the liquid-glass SVG filter for a single lens and injects it into
 * the document. Apply the returned `cssFilter` to the element whose pixels
 * should bend (typically a copy of the page backdrop; the filter cannot
 * sample what is behind the element).
 *
 * The filter region is padded by the displacement depth and blur spread so
 * rim pixels can sample content just outside the element's bounds.
 *
 * The specular rim is not part of the filter: it is rendered to
 * `specularImage` for the caller to draw above the element (screen blend).
 */
export function createGlassFilter(doc: Document = document): GlassFilter {
  const shell = createFilterShell(doc);
  // Only WebKit needs the id-cycling repaint workaround; everywhere else a
  // stable id lets the engine keep its cached filter reference instead of
  // re-resolving it on every update.
  const isWebKit = /apple/i.test(doc.defaultView?.navigator?.vendor ?? "");
  let pipeline = buildPipeline(doc, shell.filter, {
    split: true,
    blur: true,
    saturate: true,
  });
  doc.body.appendChild(shell.svg);

  const mapCanvas = doc.createElement("canvas");
  const specularCanvas = doc.createElement("canvas");

  // Fingerprints of the inputs behind each generated image, so updates that
  // do not change them (a saturation tweak, a depth change handled by the
  // displacement scale) skip the field computation and, above all, the
  // synchronous PNG encode/decode of toDataURL + href.
  let mapKey = "";
  let specularKey = "";
  let mapDataUrl = "";
  let specularDataUrl = "";
  let specularOn = false;

  // Scale state lives outside update() so per-frame intensity changes can
  // re-tune displacement magnitude without regenerating the map.
  let baseScale = 0;
  let aberration = 0;
  let intensity = 1;

  const applyScales = (): void => {
    const scale = baseScale * intensity;
    const [red, green, blue] = pipeline.displacements;
    if (pipeline.config.split) {
      red.setAttribute("scale", String(scale * (1 + aberration)));
      green.setAttribute("scale", String(scale));
      blue.setAttribute("scale", String(scale * (1 - aberration)));
    } else {
      red.setAttribute("scale", String(scale));
    }
  };

  return {
    get cssFilter() {
      return `url(#${shell.id})`;
    },

    get specularImage() {
      return specularOn ? specularDataUrl : "";
    },

    update(options: GlassFilterOptions, resolutionOverride?: number): void {
      // Cycle the filter id so WebKit notices the change; it does not
      // reliably repaint when an already-referenced filter's primitives
      // are mutated in place.
      if (isWebKit) {
        shell.cycle();
      }

      // Configure absolute bounding box margins from first principles:
      // The filter needs enough room to accommodate the maximum refraction
      // displacement (depth) plus the spread of the blur (3 * stdDeviation).
      //
      // We convert this absolute pixel padding to percentages of the current element size.
      // Using filterUnits="objectBoundingBox" avoids browser engine bugs with feImage alignment,
      // while dynamically adjusting the percentages guarantees a constant absolute pixel padding.
      const paddingPx = Math.ceil(options.depth + 3 * options.blur + 2);
      const pctX = (paddingPx / options.width) * 100;
      const pctY = (paddingPx / options.height) * 100;
      shell.filter.setAttribute("filterUnits", "objectBoundingBox");
      shell.filter.setAttribute("x", `${-pctX}%`);
      shell.filter.setAttribute("y", `${-pctY}%`);
      shell.filter.setAttribute("width", `${100 + 2 * pctX}%`);
      shell.filter.setAttribute("height", `${100 + 2 * pctY}%`);

      const config: PipelineConfig = {
        split: options.aberration > ABERRATION_EPSILON,
        blur: options.blur > 0,
        saturate: Math.abs(options.saturation - 1) > SATURATION_EPSILON,
      };
      if (!sameConfig(config, pipeline.config)) {
        // The map feImage survives the rebuild, so mapKey stays valid.
        pipeline = buildPipeline(doc, shell.filter, config);
      }

      // Encode the field so `depth` px spans the full channel range, giving
      // the 8-bit map maximum precision. Generate at device resolution
      // (capped to bound canvas cost) so the map stays sharp on high-DPI
      // displays; feImage scales it back down to CSS pixels.
      const depth = Math.max(options.depth, 1);
      const resolution =
        resolutionOverride ?? Math.min(doc.defaultView?.devicePixelRatio ?? 1, 2);

      // The shape's key stands in for borderRadius: it already encodes the
      // radius for a rounded rect (`rrect:<r>`) and uniquely identifies any
      // other silhouette, so a shape change invalidates the cached maps.
      const shapeKey = options.shape
        ? options.shape.key
        : `rrect:${options.borderRadius}`;
      const geometry =
        `${options.width}|${options.height}|${shapeKey}|` +
        `${options.curvature}|${resolution}`;

      // The encoding divides the field by this same depth, so for depth >= 1
      // the pixels are depth-independent (magnitude lives entirely in the
      // displacement scale); only sub-pixel depths change the image.
      const nextMapKey = `${geometry}|${options.splay}|${Math.min(options.depth, 1)}`;
      if (nextMapKey !== mapKey) {
        mapKey = nextMapKey;
        const field = computeDisplacementField(options, resolution);
        renderDisplacementMapToCanvas(mapCanvas, field, { scale: depth });
        mapDataUrl = applyImage(pipeline.mapImage, mapCanvas, options.width, options.height);
      } else if (!pipeline.mapImage.getAttribute("href") && mapDataUrl) {
        applyImage(pipeline.mapImage, mapCanvas, options.width, options.height, mapDataUrl);
      }

      // The rim is drawn by the caller as a layer (see specularImage).
      specularOn = options.specular > 0;
      if (specularOn) {
        const nextSpecularKey =
          `${geometry}|${options.lightAngle}|${options.specular}|` +
          `${options.specularColor ?? ""}|${options.specularSharpness ?? ""}`;
        if (nextSpecularKey !== specularKey) {
          specularKey = nextSpecularKey;
          renderSpecularToCanvas(
            specularCanvas,
            options,
            {
              lightAngle: options.lightAngle,
              strength: options.specular,
              color: options.specularColor,
              sharpness: options.specularSharpness,
            },
            resolution,
          );
          specularDataUrl = specularCanvas.toDataURL("image/png");
        }
      }

      // feDisplacementMap shifts by scale * (channel - 0.5), so scale =
      // 2 * depth recovers the encoded pixel displacement.
      baseScale = 2 * depth;
      aberration = options.aberration;
      applyScales();

      pipeline.blur?.setAttribute("stdDeviation", String(options.blur));
      pipeline.saturate?.setAttribute("values", String(options.saturation));
    },

    setIntensity(factor: number): void {
      // Skipping repeats matters: a same-value attribute write still
      // invalidates the filter and forces a re-raster of the lens.
      if (factor === intensity) {
        return;
      }
      intensity = factor;
      applyScales();
    },

    destroy(): void {
      shell.svg.remove();
    },
  };
}
