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
   * 0..1: strength of the specular rim highlight.
   * 0 removes the highlight image and blend pass from the filter entirely.
   */
  specular: number;
}

export interface GlassFilterOptions extends LensParams, GlassEffectOptions {}

export interface GlassFilter {
  /**
   * Value for the CSS `filter` property, e.g. `url(#caustics-1-0)`.
   * Re-read and re-apply this after every `update()`: the filter id cycles
   * on update to force a repaint in WebKit, which otherwise ignores changes
   * to the primitives of an already-referenced filter.
   */
  readonly cssFilter: string;
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
  const idBase = `caustics-${nextFilterId++}`;
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
  specular: boolean;
}

function sameConfig(a: PipelineConfig, b: PipelineConfig): boolean {
  return (
    a.split === b.split &&
    a.blur === b.blur &&
    a.saturate === b.saturate &&
    a.specular === b.specular
  );
}

interface PipelineHandles {
  config: PipelineConfig;
  mapImage: SVGElement;
  specularImage?: SVGElement;
  /** [red, green, blue] when split, otherwise a single element */
  displacements: SVGElement[];
  blur?: SVGElement;
  saturate?: SVGElement;
}

/**
 * Builds the refraction pipeline into `filter`, replacing any previous
 * primitives: displacement (per-channel when aberration is on) -> optional
 * blur -> optional saturate -> screen-blend the specular rim light. Every
 * pass an option turns off is a real per-frame raster cost avoided, so the
 * pipeline only ever contains what the current settings use.
 */
function buildPipeline(
  doc: Document,
  filter: SVGElement,
  config: PipelineConfig,
): PipelineHandles {
  filter.replaceChildren();

  const fe = (name: string, attrs: Record<string, string>): SVGElement => {
    const el = doc.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs)) {
      el.setAttribute(key, value);
    }
    filter.appendChild(el);
    return el;
  };

  const image = (result: string): SVGElement =>
    fe("feImage", { x: "0", y: "0", preserveAspectRatio: "none", result });

  const mapImage = image("map");
  const specularImage = config.specular ? image("specular") : undefined;

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

  // The specular rim light, screen-blended so it brightens like a real
  // highlight instead of hazing like an overlay. When omitted, the last
  // primitive above is the filter's output.
  if (config.specular) {
    fe("feBlend", { in: current, in2: "specular", mode: "screen" });
  }

  return { config, mapImage, specularImage, displacements, blur, saturate };
}

/** Points an feImage at a canvas's current content, stretched to width x height px. */
function applyImage(
  image: SVGElement,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): void {
  // Both href forms are needed: Safari/Firefox honor xlink:href,
  // Chromium honors href.
  const url = canvas.toDataURL("image/png");
  image.setAttribute("href", url);
  image.setAttributeNS(XLINK_NS, "href", url);
  image.setAttribute("width", String(width));
  image.setAttribute("height", String(height));
}

/**
 * Builds the liquid-glass SVG filter for a single lens and injects it into
 * the document. Apply the returned `cssFilter` to the element whose pixels
 * should bend (typically a copy of the page backdrop; the filter cannot
 * sample what is behind the element).
 *
 * The filter region keeps SVG's default 10% margin so rim pixels can sample
 * content just outside the element's bounds.
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
    specular: true,
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
      // We use absolute coordinates (userSpaceOnUse) to optimize CPU raster
      // limits on large elements while preventing clipping on small elements.
      const margin = Math.ceil(options.depth + 3 * options.blur + 2);
      shell.filter.setAttribute("filterUnits", "userSpaceOnUse");
      shell.filter.setAttribute("x", String(-margin));
      shell.filter.setAttribute("y", String(-margin));
      shell.filter.setAttribute("width", String(options.width + 2 * margin));
      shell.filter.setAttribute("height", String(options.height + 2 * margin));

      const config: PipelineConfig = {
        split: options.aberration > ABERRATION_EPSILON,
        blur: options.blur > 0,
        saturate: Math.abs(options.saturation - 1) > SATURATION_EPSILON,
        specular: options.specular > 0,
      };
      if (!sameConfig(config, pipeline.config)) {
        pipeline = buildPipeline(doc, shell.filter, config);
        // The rebuild created fresh feImage elements with no href.
        mapKey = "";
        specularKey = "";
      }

      // Encode the field so `depth` px spans the full channel range, giving
      // the 8-bit map maximum precision. Generate at device resolution
      // (capped to bound canvas cost) so the map stays sharp on high-DPI
      // displays; feImage scales it back down to CSS pixels.
      const depth = Math.max(options.depth, 1);
      const resolution =
        resolutionOverride ?? Math.min(doc.defaultView?.devicePixelRatio ?? 1, 2);

      const geometry =
        `${options.width}|${options.height}|${options.borderRadius}|` +
        `${options.curvature}|${resolution}`;

      // The encoding divides the field by this same depth, so for depth >= 1
      // the pixels are depth-independent (magnitude lives entirely in the
      // displacement scale); only sub-pixel depths change the image.
      const nextMapKey = `${geometry}|${options.splay}|${Math.min(options.depth, 1)}`;
      if (nextMapKey !== mapKey) {
        mapKey = nextMapKey;
        const field = computeDisplacementField(options, resolution);
        renderDisplacementMapToCanvas(mapCanvas, field, { scale: depth });
        applyImage(pipeline.mapImage, mapCanvas, options.width, options.height);
      }

      if (pipeline.specularImage) {
        const nextSpecularKey =
          `${geometry}|${options.lightAngle}|${options.specular}`;
        if (nextSpecularKey !== specularKey) {
          specularKey = nextSpecularKey;
          renderSpecularToCanvas(
            specularCanvas,
            options,
            { lightAngle: options.lightAngle, strength: options.specular },
            resolution,
          );
          applyImage(pipeline.specularImage, specularCanvas, options.width, options.height);
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
