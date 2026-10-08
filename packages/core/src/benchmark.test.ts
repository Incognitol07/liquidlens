/**
 * Effect benchmark — runs on both `main` and `perf/performance-upgrades`.
 *
 * Measures the quality and speed of every pure-computation stage of the
 * liquid-glass pipeline: SDF evaluation, shape sampling, displacement field
 * generation, specular highlights, luminance, adaptive visuals, accessibility
 * treatments, and spring physics. Run on each branch and compare the numbers.
 */
import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";

// ── shared imports (identical paths on both branches) ──────────────────
import { roundedRectSDF, sampleRoundedRect } from "./sdf";
import { roundedRectShape, superellipseShape, resolveShape } from "./shape";
import { computeDisplacementField } from "./displacement";
import { specularIntensity } from "./specular";
import { relativeLuminance } from "./luminance";
import { presets } from "./presets";
import { accessibleEffect, FROST_BLUR } from "./a11y";
import { adaptiveShadow, inkColor, adaptTint } from "./adaptive";
import { Spring } from "./spring";

// ── helpers ────────────────────────────────────────────────────────────

/** Runs `fn` N times and returns { mean, min, max, median } in ms. */
function bench(fn: () => void, iterations = 50): {
  mean: number;
  min: number;
  max: number;
  median: number;
} {
  const times: number[] = [];
  // warm up
  for (let i = 0; i < 3; i++) fn();
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  return {
    mean: sum / times.length,
    min: times[0],
    max: times[times.length - 1],
    median: times[Math.floor(times.length / 2)],
  };
}

/** RMS of a Float32Array. */
function rms(arr: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
  return Math.sqrt(sum / arr.length);
}

/** Max absolute value of a Float32Array. */
function peak(arr: Float32Array): number {
  let m = 0;
  for (let i = 0; i < arr.length; i++) m = Math.max(m, Math.abs(arr[i]));
  return m;
}

/** Horizontal mirror-symmetry error for a 2D field. */
function symmetryError(
  arr: Float32Array,
  w: number,
  h: number,
  flipSign: boolean,
): number {
  let maxErr = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < Math.floor(w / 2); x++) {
      const left = arr[y * w + x];
      const right = arr[y * w + (w - 1 - x)];
      const expected = flipSign ? -right : right;
      maxErr = Math.max(maxErr, Math.abs(left - expected));
    }
  }
  return maxErr;
}

/** Mean absolute gradient step between adjacent pixels. */
function smoothness(arr: Float32Array, w: number, h: number): number {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      sum += Math.abs(arr[y * w + x + 1] - arr[y * w + x]);
      count++;
    }
  }
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w; x++) {
      sum += Math.abs(arr[(y + 1) * w + x] - arr[y * w + x]);
      count++;
    }
  }
  return sum / count;
}

const log = (label: string, value: string | number): void =>
  console.log(`  ⏱  ${label}: ${typeof value === "number" ? value.toFixed(3) : value}`);

// ════════════════════════════════════════════════════════════════════════
//  1. SDF EVALUATION
// ════════════════════════════════════════════════════════════════════════

describe("SDF performance", () => {
  const HW = 120;
  const HH = 80;
  const R = 16;
  const GRID = 200;

  it("roundedRectSDF: evaluates a dense grid quickly", () => {
    const t = bench(() => {
      for (let y = -HH; y <= HH; y += HH * 2 / GRID) {
        for (let x = -HW; x <= HW; x += HW * 2 / GRID) {
          roundedRectSDF(x, y, HW, HH, R);
        }
      }
    });
    log("roundedRectSDF grid (ms)", t.median);
    expect(t.median).toBeLessThan(20);
  });

  it("sampleRoundedRect: evaluates with normals quickly", () => {
    const scratch = { distance: 0, normalX: 0, normalY: 0 };
    const t = bench(() => {
      for (let y = -HH; y <= HH; y += HH * 2 / GRID) {
        for (let x = -HW; x <= HW; x += HW * 2 / GRID) {
          sampleRoundedRect(x, y, HW, HH, R, scratch);
        }
      }
    });
    log("sampleRoundedRect grid (ms)", t.median);
    expect(t.median).toBeLessThan(20);
  });

  it("superellipse shape: evaluates a dense grid quickly", () => {
    const shape = superellipseShape(4);
    const scratch = { distance: 0, normalX: 0, normalY: 0 };
    const t = bench(() => {
      for (let y = -HH; y <= HH; y += HH * 2 / GRID) {
        for (let x = -HW; x <= HW; x += HW * 2 / GRID) {
          shape.sample(x, y, HW, HH, scratch);
        }
      }
    });
    log("superellipse(4) grid (ms)", t.median);
    expect(t.median).toBeLessThan(30);
  });
});

// ════════════════════════════════════════════════════════════════════════
//  2. DISPLACEMENT FIELD — QUALITY
// ════════════════════════════════════════════════════════════════════════

describe("Displacement field quality", () => {
  const params = {
    width: 200,
    height: 120,
    borderRadius: 20,
    depth: 24,
    curvature: 0.4,
    splay: 0,
  };

  const field = computeDisplacementField(params);

  it("field dimensions match input", () => {
    expect(field.width).toBe(params.width);
    expect(field.height).toBe(params.height);
  });

  it("center pixel has near-zero displacement (flat center)", () => {
    const cx = Math.floor(field.width / 2);
    const cy = Math.floor(field.height / 2);
    const i = cy * field.width + cx;
    expect(Math.abs(field.dx[i])).toBeLessThan(0.1);
    expect(Math.abs(field.dy[i])).toBeLessThan(0.1);
  });

  it("peak magnitude stays within depth budget", () => {
    const maxMag = Math.max(peak(field.dx), peak(field.dy));
    expect(maxMag).toBeLessThanOrEqual(params.depth + 0.01);
  });

  it("dx is mirror-antisymmetric across vertical center", () => {
    const err = symmetryError(field.dx, field.width, field.height, true);
    log("dx symmetry error", err);
    expect(err).toBeLessThan(0.001);
  });

  it("dy is mirror-symmetric across vertical center", () => {
    const err = symmetryError(field.dy, field.width, field.height, false);
    log("dy symmetry error", err);
    expect(err).toBeLessThan(0.001);
  });

  it("field is smooth (no harsh pixel jumps)", () => {
    const dxSmooth = smoothness(field.dx, field.width, field.height);
    const dySmooth = smoothness(field.dy, field.width, field.height);
    log("dx mean gradient step", dxSmooth);
    log("dy mean gradient step", dySmooth);
    // A well-curved lens should have sub-pixel gradient steps on average.
    expect(dxSmooth).toBeLessThan(1.0);
    expect(dySmooth).toBeLessThan(1.0);
  });

  it("RMS displacement is a healthy fraction of depth (effect is visible)", () => {
    const dxRms = rms(field.dx);
    const dyRms = rms(field.dy);
    const combined = Math.hypot(dxRms, dyRms);
    log("dx RMS", dxRms);
    log("dy RMS", dyRms);
    log("combined RMS", combined);
    // The effect should move pixels appreciably, not be near-zero everywhere.
    expect(combined).toBeGreaterThan(1);
    expect(combined).toBeLessThan(params.depth);
  });

  it("rim pixels carry meaningful displacement", () => {
    const midY = Math.floor(field.height / 2);
    // Check pixels 2px inside the left edge, vertically centered.
    const leftRim = field.dx[midY * field.width + 2];
    const rightRim = field.dx[midY * field.width + (field.width - 3)];
    expect(leftRim).toBeGreaterThan(1);
    expect(rightRim).toBeLessThan(-1);
  });

  it("higher curvature widens the active rim", () => {
    const narrow = computeDisplacementField({ ...params, curvature: 0.2 });
    const wide = computeDisplacementField({ ...params, curvature: 0.8 });
    // Count nonzero pixels in each field.
    const countActive = (f: { dx: Float32Array }): number => {
      let n = 0;
      for (let i = 0; i < f.dx.length; i++) if (Math.abs(f.dx[i]) > 0.01) n++;
      return n;
    };
    expect(countActive(wide)).toBeGreaterThan(countActive(narrow));
  });

  it("greater depth produces proportionally stronger displacement", () => {
    const shallow = computeDisplacementField({ ...params, depth: 8 });
    const deep = computeDisplacementField({ ...params, depth: 32 });
    expect(peak(deep.dx)).toBeGreaterThan(peak(shallow.dx) * 1.5);
  });

  it("ellipse shape produces a different field from rounded-rect", () => {
    const ellipse = computeDisplacementField({
      ...params,
      shape: superellipseShape(2),
    });
    let diff = 0;
    for (let i = 0; i < field.dx.length; i++) {
      diff += Math.abs(field.dx[i] - ellipse.dx[i]);
    }
    expect(diff / field.dx.length).toBeGreaterThan(0.01);
  });

  it("2× resolution field has 4× the pixels but similar displacement values", () => {
    const field2x = computeDisplacementField(params, 2);
    expect(field2x.width).toBe(params.width * 2);
    expect(field2x.height).toBe(params.height * 2);
    // Same physical location (near left edge, midline).
    const i1 = Math.floor(field.height / 2) * field.width + 3;
    const i2 = field.height * field2x.width + 6; // 2× coords
    const mag1 = Math.hypot(field.dx[i1], field.dy[i1]);
    const mag2 = Math.hypot(field2x.dx[i2], field2x.dy[i2]);
    expect(mag2).toBeCloseTo(mag1, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════
//  3. DISPLACEMENT FIELD — PERFORMANCE
// ════════════════════════════════════════════════════════════════════════

describe("Displacement field performance", () => {
  const sizes = [
    { label: "small  (80×60)", width: 80, height: 60 },
    { label: "medium (200×120)", width: 200, height: 120 },
    { label: "large  (400×300)", width: 400, height: 300 },
    { label: "xl     (600×400)", width: 600, height: 400 },
  ];

  for (const { label, width, height } of sizes) {
    it(`${label} completes in reasonable time`, () => {
      const t = bench(
        () =>
          computeDisplacementField({
            width,
            height,
            borderRadius: 20,
            depth: 24,
            curvature: 0.4,
            splay: 0,
          }),
        20,
      );
      log(`${label} median`, `${t.median.toFixed(2)} ms`);
      log(`${label} min/max`, `${t.min.toFixed(2)} / ${t.max.toFixed(2)} ms`);
      // Generous ceiling: even the XL should finish inside 1 second.
      expect(t.median).toBeLessThan(1000);
    });
  }

  it("2× resolution costs roughly 4× (scales with pixel count)", () => {
    const t1 = bench(
      () =>
        computeDisplacementField(
          { width: 200, height: 120, borderRadius: 20, depth: 24, curvature: 0.4, splay: 0 },
          1,
        ),
      20,
    );
    const t2 = bench(
      () =>
        computeDisplacementField(
          { width: 200, height: 120, borderRadius: 20, depth: 24, curvature: 0.4, splay: 0 },
          2,
        ),
      20,
    );
    log("1× median", `${t1.median.toFixed(2)} ms`);
    log("2× median", `${t2.median.toFixed(2)} ms`);
    log("ratio", (t2.median / t1.median).toFixed(2));
    // Should be roughly 3–5×; anything over 8× suggests a regression.
    expect(t2.median / t1.median).toBeLessThan(8);
  });

  it("symmetric shape is faster than asymmetric (quadrant optimisation)", () => {
    const sym = bench(
      () =>
        computeDisplacementField({
          width: 200,
          height: 120,
          borderRadius: 20,
          depth: 24,
          curvature: 0.4,
          splay: 0,
        }),
      30,
    );
    const asym = bench(
      () =>
        computeDisplacementField({
          width: 200,
          height: 120,
          borderRadius: 20,
          depth: 24,
          curvature: 0.4,
          splay: 0,
          shape: {
            key: "custom-asym",
            symmetric: false,
            sample: (x, y, hw, hh, out) =>
              sampleRoundedRect(x, y, hw, hh, 20, out),
          },
        }),
      30,
    );
    log("symmetric median", `${sym.median.toFixed(2)} ms`);
    log("asymmetric median", `${asym.median.toFixed(2)} ms`);
    log("speedup", `${(asym.median / sym.median).toFixed(2)}×`);
    expect(sym.median).toBeLessThan(asym.median);
  });
});

// ════════════════════════════════════════════════════════════════════════
//  4. SPECULAR HIGHLIGHTS
// ════════════════════════════════════════════════════════════════════════

describe("Specular highlight quality", () => {
  it("dead-on facing gives the brightest value", () => {
    const max = specularIntensity(1, 1, 1);
    for (let f = -1; f < 1; f += 0.1) {
      expect(specularIntensity(f, 1, 1)).toBeLessThanOrEqual(max + 1e-9);
    }
  });

  it("highlight falls off smoothly from peak", () => {
    const vals: number[] = [];
    for (let f = 0; f <= 1; f += 0.05) vals.push(specularIntensity(f, 1, 1));
    // Each step toward f=1 should be >= the previous (monotonic rise).
    for (let i = 1; i < vals.length; i++) {
      expect(vals[i]).toBeGreaterThanOrEqual(vals[i - 1] - 1e-9);
    }
  });

  it("counter-highlight is exactly half the main", () => {
    const ambient = specularIntensity(0, 1, 1);
    const main = specularIntensity(0.95, 1, 1) - ambient;
    const counter = specularIntensity(-0.95, 1, 1) - ambient;
    expect(counter).toBeCloseTo(main * 0.5, 6);
  });

  it("higher sharpness narrows the lobe", () => {
    const soft = specularIntensity(0.5, 1, 1, 4);
    const sharp = specularIntensity(0.5, 1, 1, 30);
    expect(sharp).toBeLessThan(soft);
  });

  it("performance: 100k evaluations", () => {
    const t = bench(() => {
      for (let f = -1; f <= 1; f += 0.00002) {
        specularIntensity(f, 1, 1);
      }
    }, 10);
    log("100k specular evals (ms)", t.median);
    expect(t.median).toBeLessThan(200);
  });
});

// ════════════════════════════════════════════════════════════════════════
//  5. LUMINANCE (WCAG)
// ════════════════════════════════════════════════════════════════════════

describe("Luminance quality", () => {
  it("black → 0, white → 1", () => {
    expect(relativeLuminance(0, 0, 0)).toBeCloseTo(0, 6);
    expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 6);
  });

  it("pure-colour luminance order: green > red > blue", () => {
    expect(relativeLuminance(0, 255, 0)).toBeGreaterThan(relativeLuminance(255, 0, 0));
    expect(relativeLuminance(255, 0, 0)).toBeGreaterThan(relativeLuminance(0, 0, 255));
  });

  it("mid-grey sits in the sRGB gamma range (~0.21)", () => {
    const mid = relativeLuminance(128, 128, 128);
    expect(mid).toBeGreaterThan(0.18);
    expect(mid).toBeLessThan(0.25);
  });

  it("is strictly monotonic across the grey ramp", () => {
    let prev = -1;
    for (let v = 0; v <= 255; v++) {
      const l = relativeLuminance(v, v, v);
      expect(l).toBeGreaterThanOrEqual(prev);
      prev = l;
    }
  });

  it("performance: full 256³ cube subset (32³ = 32k colours)", () => {
    const t = bench(() => {
      for (let r = 0; r < 256; r += 8) {
        for (let g = 0; g < 256; g += 8) {
          for (let b = 0; b < 256; b += 8) {
            relativeLuminance(r, g, b);
          }
        }
      }
    }, 10);
    log("32k luminance evals (ms)", t.median);
    expect(t.median).toBeLessThan(100);
  });
});

// ════════════════════════════════════════════════════════════════════════
//  6. ADAPTIVE VISUALS
// ════════════════════════════════════════════════════════════════════════

describe("Adaptive visual quality", () => {
  it("shadow gets denser over brighter backdrops", () => {
    const alphaOf = (s: string): number =>
      Number(/rgba\(0, 0, 0, ([0-9.]+)\)[^,]*$/.exec(s)?.[1] ?? 0);
    const darkShadow = alphaOf(adaptiveShadow(0));
    const brightShadow = alphaOf(adaptiveShadow(1));
    expect(brightShadow).toBeGreaterThan(darkShadow);
  });

  it("shadow is always a valid two-layer box-shadow", () => {
    for (let l = 0; l <= 1; l += 0.1) {
      expect(adaptiveShadow(l).split("rgba").length - 1).toBe(2);
    }
  });

  it("ink flips light/dark with hysteresis", () => {
    expect(inkColor(0.05).dark).toBe(false); // dark backdrop → light ink
    expect(inkColor(0.95).dark).toBe(true); // bright backdrop → dark ink
    // In the hysteresis band, it sticks to previous.
    expect(inkColor(0.5, true).dark).toBe(true);
    expect(inkColor(0.5, false).dark).toBe(false);
  });

  it("tint adapts to backdrop brightness while keeping hue", () => {
    const base = "#4aa3ff";
    const overDark = adaptTint(base, 0);
    const overBright = adaptTint(base, 1);
    const g = (hex: string): number => Number.parseInt(hex.slice(3, 5), 16);
    // Lightens over dark, darkens over bright.
    expect(g(overDark)).toBeGreaterThan(g(overBright));
    // At mid luminance → unchanged.
    expect(adaptTint(base, 0.5)).toBe(base);
    // Still blue-dominant.
    const adapted = adaptTint(base, 0.1);
    const r = Number.parseInt(adapted.slice(1, 3), 16);
    const b = Number.parseInt(adapted.slice(5, 7), 16);
    expect(b).toBeGreaterThan(r);
  });

  it("performance: 10k shadow+ink+tint evaluations", () => {
    const t = bench(() => {
      for (let l = 0; l < 1; l += 0.0001) {
        adaptiveShadow(l);
        inkColor(l);
        adaptTint("#4aa3ff", l);
      }
    }, 5);
    log("10k adaptive cycle (ms)", t.median);
    expect(t.median).toBeLessThan(500);
  });
});

// ════════════════════════════════════════════════════════════════════════
//  7. ACCESSIBILITY TREATMENTS
// ════════════════════════════════════════════════════════════════════════

describe("Accessibility effect quality", () => {
  const base = { depth: 24, aberration: 0.05, blur: 0.2, saturation: 1.15, specular: 1 };

  it("no flags → passthrough", () => {
    expect(
      accessibleEffect(base, { reducedTransparency: false, increasedContrast: false }),
    ).toEqual(base);
  });

  it("reduced transparency frosts: high blur, no aberration", () => {
    const out = accessibleEffect(base, { reducedTransparency: true, increasedContrast: false });
    expect(out.blur).toBe(FROST_BLUR);
    expect(out.aberration).toBe(0);
    expect(out.depth).toBe(base.depth); // depth untouched
  });

  it("increased contrast flattens: low depth, no specular/aberration", () => {
    const out = accessibleEffect(base, { reducedTransparency: false, increasedContrast: true });
    expect(out.depth).toBeLessThan(base.depth);
    expect(out.specular).toBe(0);
    expect(out.aberration).toBe(0);
    expect(out.saturation).toBe(1);
  });

  it("both treatments compose without conflict", () => {
    const out = accessibleEffect(base, { reducedTransparency: true, increasedContrast: true });
    expect(out.blur).toBe(FROST_BLUR);
    expect(out.specular).toBe(0);
    expect(out.aberration).toBe(0);
    expect(out.depth).toBeLessThan(base.depth);
  });
});

// ════════════════════════════════════════════════════════════════════════
//  8. PRESETS
// ════════════════════════════════════════════════════════════════════════

describe("Preset consistency", () => {
  it("all three presets share the same keys", () => {
    const keys = Object.keys(presets.full).sort();
    expect(Object.keys(presets.lean).sort()).toEqual(keys);
    expect(Object.keys(presets.minimal).sort()).toEqual(keys);
  });

  it("full preset has all effects enabled", () => {
    expect(presets.full.depth).toBeGreaterThan(0);
    expect(presets.full.specular).toBeGreaterThan(0);
    expect(presets.full.aberration).toBeGreaterThan(0);
    expect(presets.full.blur).toBeGreaterThan(0);
    expect(presets.full.saturation).toBeGreaterThan(1);
  });

  it("lean disables expensive passes but keeps the look", () => {
    expect(presets.lean.aberration).toBe(0);
    expect(presets.lean.blur).toBe(0);
    expect(presets.lean.depth).toBe(presets.full.depth);
    expect(presets.lean.specular).toBe(presets.full.specular);
  });

  it("minimal is refraction-only", () => {
    expect(presets.minimal.specular).toBe(0);
    expect(presets.minimal.aberration).toBe(0);
    expect(presets.minimal.blur).toBe(0);
    expect(presets.minimal.saturation).toBe(1);
    expect(presets.minimal.depth).toBe(presets.full.depth);
  });
});

// ════════════════════════════════════════════════════════════════════════
//  9. SPRING PHYSICS
// ════════════════════════════════════════════════════════════════════════

describe("Spring physics quality", () => {
  it("converges to the target", () => {
    const s = new Spring(0, 170, 16);
    s.target = 100;
    for (let i = 0; i < 300; i++) s.step(1 / 60);
    expect(s.value).toBeCloseTo(100, 1);
    expect(s.settled).toBe(true);
  });

  it("overshoots once then settles (underdamped behavior)", () => {
    const s = new Spring(0, 170, 12);
    s.target = 100;
    let maxValue = 0;
    for (let i = 0; i < 600; i++) {
      s.step(1 / 60);
      maxValue = Math.max(maxValue, s.value);
    }
    expect(maxValue).toBeGreaterThan(100); // overshoot
    expect(s.value).toBeCloseTo(100, 1); // settled
  });

  it("snap jumps instantly without animation", () => {
    const s = new Spring(0, 170, 16);
    s.target = 42;
    s.snap();
    expect(s.value).toBe(42);
    expect(s.velocity).toBe(0);
    expect(s.settled).toBe(true);
  });

  it("higher stiffness reaches target faster (higher frequency)", () => {
    const framesToReachTarget = (stiffness: number): number => {
      const s = new Spring(0, stiffness, 16);
      s.target = 100;
      let frames = 0;
      while (s.value < 100 && frames < 1000) {
        s.step(1 / 60);
        frames++;
      }
      return frames;
    };
    expect(framesToReachTarget(300)).toBeLessThan(framesToReachTarget(100));
  });

  it("performance: 10k spring steps", () => {
    const s = new Spring(0, 170, 16);
    s.target = 100;
    const t = bench(() => {
      s.value = 0;
      s.velocity = 0;
      for (let i = 0; i < 10_000; i++) s.step(1 / 60);
    }, 20);
    log("10k spring steps (ms)", t.median);
    expect(t.median).toBeLessThan(50);
  });
});

// ════════════════════════════════════════════════════════════════════════
//  10. SHAPE RESOLUTION
// ════════════════════════════════════════════════════════════════════════

describe("Shape system quality", () => {
  it("resolves all built-in names to distinct shapes", () => {
    const rect = resolveShape("rect", 12);
    const pill = resolveShape("pill", 12);
    const ellipse = resolveShape("ellipse", 12);
    const squircle = resolveShape("squircle", 12);
    const keys = new Set([rect.key, pill.key, ellipse.key, squircle.key]);
    expect(keys.size).toBe(4);
  });

  it("rounded rect and superellipse produce different distance fields", () => {
    const rrect = roundedRectShape(16);
    const sellipse = superellipseShape(4);
    const scratch = { distance: 0, normalX: 0, normalY: 0 };
    // Compare at an off-axis point (x=30, y=15).
    const d1 = rrect.sample(30, 15, 50, 30, { ...scratch }).distance;
    const d2 = sellipse.sample(30, 15, 50, 30, { ...scratch }).distance;
    expect(d1).not.toBeCloseTo(d2, 2);
  });

  it("superellipse normals are always unit length inside the shape", () => {
    const shape = superellipseShape(4);
    const scratch = { distance: 0, normalX: 0, normalY: 0 };
    for (let y = 1; y < 30; y += 3) {
      for (let x = 1; x < 50; x += 3) {
        const s = shape.sample(x, y, 50, 30, scratch);
        if (s.distance < 0) {
          const len = Math.hypot(s.normalX, s.normalY);
          expect(len).toBeCloseTo(1, 4);
        }
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
//  11. FULL PIPELINE (end-to-end quality)
// ════════════════════════════════════════════════════════════════════════

describe("Full effect pipeline", () => {
  const params = {
    width: 160,
    height: 100,
    borderRadius: 16,
    depth: 24,
    curvature: 0.4,
    splay: 0.59,
  };

  it("produces a complete, usable displacement field with splay", () => {
    const field = computeDisplacementField(params);
    expect(field.dx.length).toBe(params.width * params.height);
    expect(field.dy.length).toBe(params.width * params.height);
    // Splay blends edge-normal and radial: the dx/dy fields should both
    // have nonzero RMS.
    expect(rms(field.dx)).toBeGreaterThan(0.5);
    expect(rms(field.dy)).toBeGreaterThan(0.5);
  });

  it("splay changes the displacement direction at corners", () => {
    const noSplay = computeDisplacementField({ ...params, splay: 0 });
    const fullSplay = computeDisplacementField({ ...params, splay: 1 });
    // At a corner pixel, splay rotates from edge-normal toward radial.
    const corner = 5 * params.width + 5;
    const angle0 = Math.atan2(noSplay.dy[corner], noSplay.dx[corner]);
    const angle1 = Math.atan2(fullSplay.dy[corner], fullSplay.dx[corner]);
    expect(Math.abs(angle0 - angle1)).toBeGreaterThan(0.01);
  });

  it("luminance + adaptive + a11y compose into a coherent look", () => {
    // Simulate: sample luminance, adapt ink/shadow/tint, apply a11y.
    const backdropLuminance = relativeLuminance(200, 210, 220); // light-grey
    const shadow = adaptiveShadow(backdropLuminance);
    const ink = inkColor(backdropLuminance);
    const tint = adaptTint("#4488cc", backdropLuminance);

    expect(shadow).toContain("rgba");
    expect(ink.dark).toBe(true); // light backdrop → dark ink
    expect(tint.startsWith("#")).toBe(true);

    const { depth, aberration, blur, saturation, specular } = presets.full;
    const effect = accessibleEffect(
      { depth, aberration, blur, saturation, specular },
      { reducedTransparency: false, increasedContrast: false },
    );
    expect(effect).toEqual({ depth, aberration, blur, saturation, specular });
  });

  it("end-to-end performance: field + specular sweep for a typical lens", () => {
    const t = bench(() => {
      // 1. Compute displacement field.
      const field = computeDisplacementField(params);
      // 2. Evaluate specular intensity at every rim pixel.
      const { width, height, dx, dy } = field;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          const mag = Math.hypot(dx[i], dy[i]);
          if (mag > 0.5) {
            // Facing = normalized displacement dot light direction (top light).
            const facing = -dy[i] / mag;
            specularIntensity(facing, 1, 1);
          }
        }
      }
    }, 15);
    log("full pipeline (field + specular) (ms)", t.median);
    // A typical lens at this size should complete well under 200 ms.
    expect(t.median).toBeLessThan(200);
  });
});
