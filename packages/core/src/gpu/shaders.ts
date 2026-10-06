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
