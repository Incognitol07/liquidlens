import {
  BLUR_FRAGMENT_GLSL,
  BLUR_VERTEX_GLSL,
  LENS_FRAGMENT_GLSL,
  LENS_VERTEX_GLSL,
  MAX_TEXEL_SIGMA,
} from "./shaders";
import type { GpuEngine, GpuLens, GpuMedia } from "./types";

/**
 * The WebGL2 backend. One context per document renders every lens: the
 * browser caps live WebGL contexts at a handful, so per-lens contexts can't
 * scale. Each lens is drawn into the shared drawing buffer and copied into
 * its own canvas. Each media source has its own texture (mipmapped) and
 * Gaussian-blurred copies per blur radius.
 */

interface BlurredCopy {
  result: WebGLTexture;
  horizontal: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
  sigma: number;
  stale: boolean;
}

interface Source {
  media: GpuMedia;
  texture: WebGLTexture;
  size: { width: number; height: number };
  blurred: Map<string, BlurredCopy>;
  lenses: Set<GpuLens>;
  loaded: boolean;
  ready: Promise<void>;
}

interface Context {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  sources: Map<GpuMedia, Source>;
  lost: boolean;
  lostListeners: Set<() => void>;
  engineFor(media: GpuMedia): GpuEngine;
}

const contexts = new WeakMap<Document, Context>();

/** Whether this document can create a WebGL2 context at all. */
export function webglAvailable(doc: Document): boolean {
  if (contexts.has(doc)) return true;
  return !!doc.createElement("canvas").getContext("webgl2");
}

/** The WebGL engine for `media` in `doc`, shared by every lens over it. */
export function webglEngine(doc: Document, media: GpuMedia): GpuEngine {
  let context = contexts.get(doc);
  if (!context || context.lost) {
    context = createContext(doc);
    contexts.set(doc, context);
  }
  return context.engineFor(media);
}

function createContext(doc: Document): Context {
  const canvas = doc.createElement("canvas");
  const created = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false });
  if (!created) throw new Error("WebGL2 is unavailable");
  const gl: WebGL2RenderingContext = created;

  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
    }
    return shader;
  };
  const link = (vertex: string, fragment: string): WebGLProgram => {
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? "program link failed");
    }
    return program;
  };
  const lensProgram = link(LENS_VERTEX_GLSL, LENS_FRAGMENT_GLSL);
  const blurProgram = link(BLUR_VERTEX_GLSL, BLUR_FRAGMENT_GLSL);

  // A unit quad, bound once per program through its own vertex array.
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const quadFor = (program: WebGLProgram): WebGLVertexArrayObject => {
    const array = gl.createVertexArray()!;
    gl.bindVertexArray(array);
    const corner = gl.getAttribLocation(program, "aCorner");
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    return array;
  };
  const blurVao = quadFor(blurProgram);
  const lensVao = quadFor(lensProgram);
  gl.useProgram(lensProgram);

  const uniform = (program: WebGLProgram, name: string): WebGLUniformLocation =>
    gl.getUniformLocation(program, name)!;
  const at = {
    lensSize: uniform(lensProgram, "uLensSize"),
    lensOrigin: uniform(lensProgram, "uLensOrigin"),
    imageOrigin: uniform(lensProgram, "uImageOrigin"),
    imageSize: uniform(lensProgram, "uImageSize"),
    shape: uniform(lensProgram, "uShape"),
    radius: uniform(lensProgram, "uRadius"),
    exponent: uniform(lensProgram, "uExponent"),
    depth: uniform(lensProgram, "uDepth"),
    curvature: uniform(lensProgram, "uCurvature"),
    splay: uniform(lensProgram, "uSplay"),
    aberration: uniform(lensProgram, "uAberration"),
    saturation: uniform(lensProgram, "uSaturation"),
    tint: uniform(lensProgram, "uTint"),
    specularColor: uniform(lensProgram, "uSpecularColor"),
    specular: uniform(lensProgram, "uSpecular"),
    sharpness: uniform(lensProgram, "uSharpness"),
    light: uniform(lensProgram, "uLight"),
    blurStep: uniform(blurProgram, "uStep"),
    blurSigma: uniform(blurProgram, "uSigma"),
  };

  const sources = new Map<GpuMedia, Source>();
  const dirty = new Map<GpuLens, Source>();
  const lostListeners = new Set<() => void>();
  let queued = false;

  const context: Context = { gl, canvas, sources, lost: false, lostListeners, engineFor };

  canvas.addEventListener("webglcontextlost", () => {
    context.lost = true;
    if (contexts.get(doc) === context) contexts.delete(doc);
    for (const listener of [...lostListeners]) listener();
  });

  const schedule = (): void => {
    if (queued || context.lost) return;
    queued = true;
    doc.defaultView?.requestAnimationFrame(flush);
  };

  function newTexture(width?: number, height?: number): WebGLTexture {
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (width && height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  /** Uploads the media's current pixels; blurred copies go stale. */
  function upload(source: Source, pixels: TexImageSource): void {
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    for (const copy of source.blurred.values()) copy.stale = true;
  }

  const redraw = (source: Source): void => {
    for (const lens of source.lenses) dirty.set(lens, source);
    schedule();
  };

  /**
   * A Gaussian-blurred copy of a source for a sigma in source px: two
   * separable passes at a resolution where the sigma is at most
   * MAX_TEXEL_SIGMA texels, then mipmapped. Re-blurred when the source
   * uploads a new frame.
   */
  function blurredTexture(source: Source, sigmaSource: number): WebGLTexture {
    const key = sigmaSource.toFixed(1);
    let copy = source.blurred.get(key);
    if (!copy) {
      const scale = Math.min(1, MAX_TEXEL_SIGMA / sigmaSource);
      const width = Math.max(1, Math.round(source.size.width * scale));
      const height = Math.max(1, Math.round(source.size.height * scale));
      copy = {
        result: newTexture(width, height),
        horizontal: newTexture(width, height),
        fbo: gl.createFramebuffer()!,
        width,
        height,
        sigma: sigmaSource * scale,
        stale: true,
      };
      source.blurred.set(key, copy);
    }
    if (copy.stale) {
      gl.useProgram(blurProgram);
      gl.bindVertexArray(blurVao);
      gl.bindFramebuffer(gl.FRAMEBUFFER, copy.fbo);
      gl.viewport(0, 0, copy.width, copy.height);
      gl.uniform1f(at.blurSigma, copy.sigma);

      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, copy.horizontal, 0);
      gl.bindTexture(gl.TEXTURE_2D, source.texture);
      gl.uniform2f(at.blurStep, 1 / copy.width, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, copy.result, 0);
      gl.bindTexture(gl.TEXTURE_2D, copy.horizontal);
      gl.uniform2f(at.blurStep, 0, 1 / copy.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, copy.result);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.useProgram(lensProgram);
      gl.bindVertexArray(lensVao);
      copy.stale = false;
    }
    return copy.result;
  }

  function render(lens: GpuLens, source: Source): void {
    const target = lens.canvas.getContext("2d");
    if (!target) return;
    const dpr = Math.min(doc.defaultView?.devicePixelRatio ?? 1, 2);
    const pw = Math.max(1, Math.round(lens.width * dpr));
    const ph = Math.max(1, Math.round(lens.height * dpr));
    if (lens.canvas.width !== pw || lens.canvas.height !== ph) {
      lens.canvas.width = pw;
      lens.canvas.height = ph;
    }
    if (canvas.width < pw || canvas.height < ph) {
      canvas.width = Math.max(canvas.width, pw);
      canvas.height = Math.max(canvas.height, ph);
    }

    const look = lens.look;
    const rect = lens.imageRect;
    // Blur is in CSS px; the blurred copy is made in source px.
    const sigmaSource = look.blur * (source.size.width / rect.width);
    const texture = look.blur >= 0.3 ? blurredTexture(source, sigmaSource) : source.texture;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);

    gl.viewport(0, 0, pw, ph);
    gl.uniform2f(at.lensSize, lens.width, lens.height);
    gl.uniform2f(at.lensOrigin, lens.offsetX, lens.offsetY);
    gl.uniform2f(at.imageOrigin, rect.x, rect.y);
    gl.uniform2f(at.imageSize, rect.width, rect.height);
    gl.uniform1i(at.shape, look.shape);
    gl.uniform1f(at.radius, look.radius);
    gl.uniform1f(at.exponent, look.exponent);
    gl.uniform1f(at.depth, look.depth * lens.intensity);
    gl.uniform1f(at.curvature, look.curvature);
    gl.uniform1f(at.splay, look.splay);
    gl.uniform1f(at.aberration, look.aberration);
    gl.uniform1f(at.saturation, look.saturation);
    gl.uniform4fv(at.tint, look.tint);
    gl.uniform3fv(at.specularColor, look.specularColor);
    gl.uniform1f(at.specular, look.specular);
    gl.uniform1f(at.sharpness, look.sharpness);
    gl.uniform2fv(at.light, look.light);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // The viewport sits at the drawing buffer's bottom-left, which is the
    // canvas's bottom rows.
    target.globalCompositeOperation = "copy";
    target.drawImage(canvas, 0, canvas.height - ph, pw, ph, 0, 0, pw, ph);
  }

  function flush(): void {
    queued = false;
    if (context.lost) return;
    for (const [lens, source] of dirty) {
      if (source.loaded && lens.visible) render(lens, source);
    }
    dirty.clear();
  }

  function load(source: Source): Promise<void> {
    const { media } = source;
    const view = doc.defaultView;

    if (typeof media === "string" || media instanceof HTMLImageElement) {
      return new Promise<void>((resolve, reject) => {
        const img =
          typeof media === "string"
            ? Object.assign(new Image(), { crossOrigin: "anonymous", src: media })
            : media;
        const done = (): void => {
          source.size = { width: img.naturalWidth, height: img.naturalHeight };
          // A tainted image (cross-origin without CORS) throws here.
          try {
            upload(source, img);
          } catch (error) {
            reject(error);
            return;
          }
          resolve();
        };
        if (img.complete && img.naturalWidth > 0) done();
        else {
          img.addEventListener("load", done, { once: true });
          img.addEventListener("error", () => reject(new Error("image failed to load")), { once: true });
        }
      });
    }

    if (media instanceof HTMLVideoElement) {
      return new Promise<void>((resolve, reject) => {
        // Each presented frame is uploaded once and every lens over it
        // redraws; with no lenses the source only keeps listening.
        const onFrame = (): void => {
          if (context.lost) return;
          if (source.lenses.size > 0) {
            upload(source, media);
            redraw(source);
          }
          media.requestVideoFrameCallback(onFrame);
        };
        const begin = (): void => {
          source.size = { width: media.videoWidth, height: media.videoHeight };
          try {
            upload(source, media);
          } catch (error) {
            reject(error);
            return;
          }
          resolve();
          media.requestVideoFrameCallback(onFrame);
        };
        if (media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) begin();
        else media.addEventListener("loadeddata", begin, { once: true });
      });
    }

    // A canvas changes without telling anyone, so it is uploaded every frame
    // while lenses sample it.
    return new Promise<void>((resolve, reject) => {
      source.size = { width: media.width, height: media.height };
      try {
        upload(source, media);
      } catch (error) {
        reject(error);
        return;
      }
      resolve();
      const tick = (): void => {
        if (context.lost) return;
        if (source.lenses.size > 0) {
          source.size = { width: media.width, height: media.height };
          upload(source, media);
          redraw(source);
        }
        view?.requestAnimationFrame(tick);
      };
      view?.requestAnimationFrame(tick);
    });
  }

  function engineFor(media: GpuMedia): GpuEngine {
    let source = sources.get(media);
    if (!source) {
      const created: Source = {
        media,
        texture: newTexture(),
        size: { width: 0, height: 0 },
        blurred: new Map(),
        lenses: new Set(),
        loaded: false,
        ready: Promise.resolve(),
      };
      created.ready = load(created).then(() => {
        created.loaded = true;
        redraw(created);
      });
      sources.set(media, created);
      source = created;
    }
    const s = source;
    return {
      kind: "webgl",
      ready: s.ready,
      get sourceSize() {
        return s.size;
      },
      attach(lens) {
        s.lenses.add(lens);
        // A video source idles without lenses; catch up to the current frame.
        if (s.loaded && s.lenses.size === 1 && s.media instanceof HTMLVideoElement) {
          upload(s, s.media);
        }
        dirty.set(lens, s);
        schedule();
      },
      detach(lens) {
        s.lenses.delete(lens);
        dirty.delete(lens);
      },
      invalidate(lens) {
        dirty.set(lens, s);
        schedule();
      },
      onLost(listener) {
        lostListeners.add(listener);
        return () => lostListeners.delete(listener);
      },
    };
  }

  return context;
}
