/**
 * The glass as a fragment shader. One pass per lens computes the shape's
 * signed distance and normal (the rounded rect of `sdf.ts`, the superellipse
 * of `shape.ts`), the rim displacement of `displacement.ts`, three samples
 * for the aberration split, saturate, tint, and the screen-blended specular
 * rim of `specular.ts`. Blur comes from sampling a Gaussian-blurred copy of
 * the source. The same math is written once per shading language; keep the
 * two in step.
 */

/** Shape kinds, as the `uShape` uniform. */
export const SHAPE_ROUNDED_RECT = 0;
export const SHAPE_SUPERELLIPSE = 1;

export const LENS_VERTEX_GLSL = `#version 300 es
in vec2 aCorner;
uniform vec2 uLensSize;
out vec2 vPos;
void main() {
  vPos = aCorner * uLensSize;
  gl_Position = vec4(aCorner.x * 2.0 - 1.0, 1.0 - aCorner.y * 2.0, 0.0, 1.0);
}`;

export const LENS_FRAGMENT_GLSL = `#version 300 es
precision highp float;
in vec2 vPos;
uniform sampler2D uImage;
uniform vec2 uLensSize;
uniform vec2 uLensOrigin;
uniform vec2 uImageOrigin;
uniform vec2 uImageSize;
uniform int uShape;
uniform float uRadius;
uniform float uExponent;
uniform float uDepth;
uniform float uCurvature;
uniform float uSplay;
uniform float uAberration;
uniform float uSaturation;
uniform vec4 uTint;
uniform vec3 uSpecularColor;
uniform float uSpecular;
uniform float uSharpness;
uniform vec2 uLight;
out vec4 outColor;

// Signed distance (negative inside) and outward normal.
float shapeSample(vec2 p, vec2 halfSize, out vec2 normal) {
  if (uShape == ${SHAPE_SUPERELLIPSE}) {
    vec2 ab = max(halfSize, vec2(1e-6));
    vec2 u = abs(p) / ab;
    float n = uExponent;
    float g = pow(u.x, n) + pow(u.y, n);
    vec2 grad = vec2(
      u.x > 0.0 ? n * pow(u.x, n - 1.0) * sign(p.x) / ab.x : 0.0,
      u.y > 0.0 ? n * pow(u.y, n - 1.0) * sign(p.y) / ab.y : 0.0
    );
    float glen = length(grad);
    normal = glen > 0.0 ? grad / glen : vec2(0.0);
    return g <= 1e-9 ? -min(ab.x, ab.y) : length(p) * (1.0 - pow(g, -1.0 / n));
  }
  float r = min(uRadius, min(halfSize.x, halfSize.y));
  vec2 q = abs(p) - (halfSize - r);
  if (q.x > 0.0 && q.y > 0.0) {
    float len = max(length(q), 1e-6);
    normal = sign(p) * q / len;
    return len - r;
  }
  if (q.x > q.y) {
    normal = vec2(sign(p.x), 0.0);
    return q.x - r;
  }
  normal = vec2(0.0, sign(p.y));
  return q.y - r;
}

vec3 image(vec2 backdropPx) {
  return texture(uImage, (backdropPx - uImageOrigin) / uImageSize).rgb;
}

void main() {
  vec2 halfSize = uLensSize * 0.5;
  vec2 p = vPos - halfSize;
  vec2 normal;
  float d = shapeSample(p, halfSize, normal);

  float rim = max(1.0, uCurvature * min(halfSize.x, halfSize.y));
  float weight = d <= 0.0
    ? 1.0 - smoothstep(0.0, 1.0, clamp(-d / rim, 0.0, 1.0))
    : clamp(1.0 - d / max(1.0, rim * 0.5), 0.0, 1.0);

  float pLen = length(p);
  vec2 radial = pLen > 0.0 ? p / pLen : vec2(0.0);
  vec2 dir = -normal * (1.0 - uSplay) + radial * uSplay;
  float dirLen = length(dir);
  dir = dirLen > 0.0 ? dir / dirLen : vec2(0.0);
  vec2 displacement = dir * uDepth * weight;

  vec2 at = uLensOrigin + vPos;
  vec3 color = vec3(
    image(at + displacement * (1.0 + uAberration)).r,
    image(at + displacement).g,
    image(at + displacement * (1.0 - uAberration)).b
  );

  float luma = dot(color, vec3(0.213, 0.715, 0.072));
  color = mix(vec3(luma), color, uSaturation);
  color = mix(color, uTint.rgb, uTint.a);

  float band = max(1.5, rim * 0.3);
  float mask = d <= 0.0 ? 1.0 - smoothstep(0.0, 1.0, clamp(-d / band, 0.0, 1.0)) : 0.0;
  float facing = dot(normal, uLight);
  float lit = facing >= 0.0 ? pow(facing, uSharpness) : pow(-facing, uSharpness) * 0.5;
  float highlight = clamp(mask * uSpecular * (0.22 + lit), 0.0, 1.0);
  color = 1.0 - (1.0 - color) * (1.0 - uSpecularColor * highlight);

  float coverage = clamp(0.5 - d, 0.0, 1.0);
  outColor = vec4(color * coverage, coverage);
}`;

// One direction of a separable Gaussian into a texture; uSigma is in target
// texels (the copy is stored at a resolution that keeps it small).
export const BLUR_VERTEX_GLSL = `#version 300 es
in vec2 aCorner;
out vec2 vUv;
void main() {
  vUv = aCorner;
  gl_Position = vec4(aCorner * 2.0 - 1.0, 0.0, 1.0);
}`;

export const BLUR_FRAGMENT_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSource;
uniform vec2 uStep;
uniform float uSigma;
out vec4 outColor;
void main() {
  int radius = int(ceil(uSigma * 3.0));
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int i = -16; i <= 16; i++) {
    if (i < -radius || i > radius) continue;
    float w = exp(-0.5 * float(i * i) / (uSigma * uSigma));
    sum += texture(uSource, vUv + uStep * float(i)) * w;
    total += w;
  }
  outColor = sum / total;
}`;

/** Largest blur sigma, in texels of the blurred copy, before it is stored smaller. */
export const MAX_TEXEL_SIGMA = 3;

/** Bytes in the WGSL `Lens` uniform struct below. */
export const LENS_UNIFORM_BYTES = 128;

export const LENS_WGSL = /* wgsl */ `
struct Lens {
  lensSize: vec2f,
  lensOrigin: vec2f,
  imageOrigin: vec2f,
  imageSize: vec2f,
  light: vec2f,
  pad0: vec2f,
  radius: f32,
  depth: f32,
  curvature: f32,
  splay: f32,
  aberration: f32,
  saturation: f32,
  specular: f32,
  sharpness: f32,
  shape: f32,
  exponent: f32,
  pad1: vec2f,
  tint: vec4f,
  specularColor: vec4f,
};

@group(0) @binding(0) var<uniform> u: Lens;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var img: texture_2d<f32>;

struct VOut {
  @builtin(position) position: vec4f,
  @location(0) pos: vec2f,
};

@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let corner = vec2f(f32(i & 1u), f32(i >> 1u));
  var out: VOut;
  out.pos = corner * u.lensSize;
  out.position = vec4f(corner.x * 2.0 - 1.0, 1.0 - corner.y * 2.0, 0.0, 1.0);
  return out;
}

// Signed distance (negative inside) and outward normal as (d, nx, ny).
fn shapeSample(p: vec2f, halfSize: vec2f) -> vec3f {
  if (u.shape > 0.5) {
    let ab = max(halfSize, vec2f(1e-6));
    let q = abs(p) / ab;
    let n = u.exponent;
    let g = pow(q.x, n) + pow(q.y, n);
    let grad = vec2f(
      select(0.0, n * pow(q.x, n - 1.0) * sign(p.x) / ab.x, q.x > 0.0),
      select(0.0, n * pow(q.y, n - 1.0) * sign(p.y) / ab.y, q.y > 0.0)
    );
    let glen = length(grad);
    let normal = select(vec2f(0.0), grad / max(glen, 1e-6), glen > 0.0);
    let d = select(length(p) * (1.0 - pow(max(g, 1e-9), -1.0 / n)), -min(ab.x, ab.y), g <= 1e-9);
    return vec3f(d, normal);
  }
  let r = min(u.radius, min(halfSize.x, halfSize.y));
  let q = abs(p) - (halfSize - r);
  if (q.x > 0.0 && q.y > 0.0) {
    let len = max(length(q), 1e-6);
    return vec3f(len - r, sign(p) * q / len);
  }
  if (q.x > q.y) {
    return vec3f(q.x - r, sign(p.x), 0.0);
  }
  return vec3f(q.y - r, 0.0, sign(p.y));
}

fn image(backdropPx: vec2f) -> vec3f {
  return textureSample(img, samp, (backdropPx - u.imageOrigin) / u.imageSize).rgb;
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let halfSize = u.lensSize * 0.5;
  let p = in.pos - halfSize;
  let sdf = shapeSample(p, halfSize);
  let d = sdf.x;
  let normal = sdf.yz;

  let rim = max(1.0, u.curvature * min(halfSize.x, halfSize.y));
  let inside = 1.0 - smoothstep(0.0, 1.0, clamp(-d / rim, 0.0, 1.0));
  let outside = clamp(1.0 - d / max(1.0, rim * 0.5), 0.0, 1.0);
  let weight = select(outside, inside, d <= 0.0);

  let pLen = length(p);
  let radial = select(vec2f(0.0), p / max(pLen, 1e-6), pLen > 0.0);
  var dir = -normal * (1.0 - u.splay) + radial * u.splay;
  let dirLen = length(dir);
  dir = select(vec2f(0.0), dir / max(dirLen, 1e-6), dirLen > 0.0);
  let displacement = dir * u.depth * weight;

  let at = u.lensOrigin + in.pos;
  var color = vec3f(
    image(at + displacement * (1.0 + u.aberration)).r,
    image(at + displacement).g,
    image(at + displacement * (1.0 - u.aberration)).b
  );

  let luma = dot(color, vec3f(0.213, 0.715, 0.072));
  color = mix(vec3f(luma), color, u.saturation);
  color = mix(color, u.tint.rgb, u.tint.a);

  let band = max(1.5, rim * 0.3);
  let mask = select(0.0, 1.0 - smoothstep(0.0, 1.0, clamp(-d / band, 0.0, 1.0)), d <= 0.0);
  let facing = dot(normal, u.light);
  let lit = select(pow(max(-facing, 0.0), u.sharpness) * 0.5, pow(max(facing, 0.0), u.sharpness), facing >= 0.0);
  let highlight = clamp(mask * u.specular * (0.22 + lit), 0.0, 1.0);
  color = 1.0 - (1.0 - color) * (1.0 - u.specularColor.rgb * highlight);

  let coverage = clamp(0.5 - d, 0.0, 1.0);
  return vec4f(color * coverage, coverage);
}
`;

// A fullscreen pass: one direction of a separable Gaussian (sigma > 0), or a
// plain copy for mip generation (sigma 0).
export const PASS_WGSL = /* wgsl */ `
struct Pass { step: vec2f, sigma: f32, pad: f32 };
@group(0) @binding(0) var<uniform> b: Pass;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;

struct VOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let corner = vec2f(f32(i & 1u), f32(i >> 1u));
  var out: VOut;
  out.uv = corner;
  out.position = vec4f(corner.x * 2.0 - 1.0, 1.0 - corner.y * 2.0, 0.0, 1.0);
  return out;
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  if (b.sigma <= 0.0) {
    return textureSample(src, samp, in.uv);
  }
  let radius = i32(ceil(b.sigma * 3.0));
  var sum = vec4f(0.0);
  var total = 0.0;
  for (var i = -16; i <= 16; i++) {
    if (i < -radius || i > radius) { continue; }
    let w = exp(-0.5 * f32(i * i) / (b.sigma * b.sigma));
    sum += textureSample(src, samp, in.uv + b.step * f32(i)) * w;
    total += w;
  }
  return sum / total;
}
`;
