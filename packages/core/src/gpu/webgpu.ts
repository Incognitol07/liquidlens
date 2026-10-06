import { LENS_UNIFORM_BYTES, LENS_WGSL, MAX_TEXEL_SIGMA, PASS_WGSL } from "./shaders";
import type { GpuEngine, GpuLens, GpuMedia } from "./types";

/**
 * The WebGPU backend. One device per document serves every lens, and each
 * lens canvas gets its own WebGPU context, so lenses render straight into
 * their canvases. Each media source has a mipmapped texture and
 * Gaussian-blurred copies per blur radius; WebGPU has no generateMipmap,
 * so mips and blurs are render passes.
 */

const TEXTURE_FORMAT: GPUTextureFormat = "rgba8unorm";

interface BlurredCopy {
  result: GPUTexture;
  horizontal: GPUTexture;
  /** Pass uniforms for the horizontal and vertical directions (fixed per copy). */
  horizontalStep: GPUBuffer;
  verticalStep: GPUBuffer;
  stale: boolean;
}

interface Source {
  media: GpuMedia;
  texture?: GPUTexture;
  size: { width: number; height: number };
  blurred: Map<string, BlurredCopy>;
  lenses: Set<GpuLens>;
  loaded: boolean;
}

interface LensTarget {
  context: GPUCanvasContext;
  uniforms: GPUBuffer;
  bindGroup?: GPUBindGroup;
  boundTexture?: GPUTexture;
}

interface Device {
  device: GPUDevice;
  lost: boolean;
  lostListeners: Set<() => void>;
  sourceFor(media: GpuMedia): Source & { ready: Promise<void> };
  attach(lens: GpuLens, source: Source): void;
  detach(lens: GpuLens, source: Source): void;
  invalidate(lens: GpuLens, source: Source): void;
}

const devices = new WeakMap<Document, Promise<Device>>();

/** Whether the browser exposes WebGPU (an adapter may still be refused). */
export function webgpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

/**
 * The WebGPU engine for `media` in `doc`. The device is requested
 * asynchronously; `ready` rejects if no adapter is granted or the media
 * can't be uploaded, so the lens can fall back.
 */
export function webgpuEngine(doc: Document, media: GpuMedia): GpuEngine {
  let devicePromise = devices.get(doc);
  if (!devicePromise) {
    devicePromise = createDevice(doc);
    devices.set(doc, devicePromise);
    devicePromise.catch(() => devices.delete(doc));
  }

  const size = { width: 0, height: 0 };
  const pending = new Set<GpuLens>();
  const lostListeners = new Set<() => void>();
  let resolved: { device: Device; source: Source } | undefined;

  const ready = devicePromise.then(async (device) => {
    const source = device.sourceFor(media);
    await source.ready;
    resolved = { device, source };
    device.lostListeners.add(() => lostListeners.forEach((listener) => listener()));
    for (const lens of pending) device.attach(lens, source);
    pending.clear();
  });

  return {
    kind: "webgpu",
    ready,
    get sourceSize() {
      return resolved ? resolved.source.size : size;
    },
    attach(lens) {
      if (resolved) resolved.device.attach(lens, resolved.source);
      else pending.add(lens);
    },
    detach(lens) {
      pending.delete(lens);
      resolved?.device.detach(lens, resolved.source);
    },
    invalidate(lens) {
      resolved?.device.invalidate(lens, resolved.source);
    },
    onLost(listener) {
      lostListeners.add(listener);
      return () => lostListeners.delete(listener);
    },
  };
}

async function createDevice(doc: Document): Promise<Device> {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter");
  const device = await adapter.requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat();
  const view = doc.defaultView;

  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });
  const lensModule = device.createShaderModule({ code: LENS_WGSL });
  const lensPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: lensModule, entryPoint: "vs" },
    fragment: { module: lensModule, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-strip" },
  });
  const passModule = device.createShaderModule({ code: PASS_WGSL });
  const passPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: passModule, entryPoint: "vs" },
    fragment: { module: passModule, entryPoint: "fs", targets: [{ format: TEXTURE_FORMAT }] },
    primitive: { topology: "triangle-strip" },
  });
  const copyUniforms = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(copyUniforms, 0, new Float32Array([0, 0, 0, 0]));

  const sources = new Map<GpuMedia, Source & { ready: Promise<void> }>();
  const targets = new WeakMap<GpuLens, LensTarget>();
  const dirty = new Map<GpuLens, Source>();
  let queued = false;

  const result: Device = {
    device,
    lost: false,
    lostListeners: new Set(),
    sourceFor,
    attach(lens, source) {
      source.lenses.add(lens);
      // A video source idles without lenses; catch up to the current frame.
      if (source.loaded && source.lenses.size === 1 && source.media instanceof HTMLVideoElement) {
        upload(source, source.media);
      }
      dirty.set(lens, source);
      schedule();
    },
    detach(lens, source) {
      source.lenses.delete(lens);
      dirty.delete(lens);
      const target = targets.get(lens);
      target?.context.unconfigure();
      target?.uniforms.destroy();
      targets.delete(lens);
    },
    invalidate(lens, source) {
      dirty.set(lens, source);
      schedule();
    },
  };

  void device.lost.then(() => {
    result.lost = true;
    devices.delete(doc);
    for (const listener of [...result.lostListeners]) listener();
  });

  function schedule(): void {
    if (queued || result.lost) return;
    queued = true;
    view?.requestAnimationFrame(flush);
  }

  /** A fullscreen pass from one view into another (a Gaussian direction, or a copy). */
  function runPass(
    encoder: GPUCommandEncoder,
    from: GPUTextureView,
    to: GPUTextureView,
    uniforms: GPUBuffer,
  ): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: to, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
    });
    pass.setPipeline(passPipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: passPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniforms } },
          { binding: 1, resource: sampler },
          { binding: 2, resource: from },
        ],
      }),
    );
    pass.draw(4);
    pass.end();
  }

  /** Uploads the media's current pixels, rebuilds the mips; blurred copies go stale. */
  function upload(source: Source, pixels: ImageBitmap | HTMLVideoElement | HTMLCanvasElement | HTMLImageElement): void {
    const { width, height } = source.size;
    if (!source.texture || source.texture.width !== width || source.texture.height !== height) {
      source.texture?.destroy();
      source.texture = device.createTexture({
        size: [width, height],
        format: TEXTURE_FORMAT,
        mipLevelCount: Math.floor(Math.log2(Math.max(width, height, 1))) + 1,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      for (const copy of source.blurred.values()) {
        copy.result.destroy();
        copy.horizontal.destroy();
        copy.horizontalStep.destroy();
        copy.verticalStep.destroy();
      }
      source.blurred.clear();
    }
    const texture = source.texture;
    device.queue.copyExternalImageToTexture({ source: pixels }, { texture, mipLevel: 0 }, [width, height]);
    const encoder = device.createCommandEncoder();
    for (let level = 1; level < texture.mipLevelCount; level++) {
      runPass(
        encoder,
        texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }),
        texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
        copyUniforms,
      );
    }
    device.queue.submit([encoder.finish()]);
    for (const copy of source.blurred.values()) copy.stale = true;
  }

  /**
   * A Gaussian-blurred copy of a source for a sigma in source px, at a
   * resolution where the sigma is at most MAX_TEXEL_SIGMA texels. Re-blurred
   * when the source uploads a new frame.
   */
  function blurredTexture(encoder: GPUCommandEncoder, source: Source, sigmaSource: number): GPUTexture {
    const key = sigmaSource.toFixed(1);
    let copy = source.blurred.get(key);
    if (!copy) {
      const scale = Math.min(1, MAX_TEXEL_SIGMA / sigmaSource);
      const texSize: [number, number] = [
        Math.max(1, Math.round(source.size.width * scale)),
        Math.max(1, Math.round(source.size.height * scale)),
      ];
      const target = (): GPUTexture =>
        device.createTexture({
          size: texSize,
          format: TEXTURE_FORMAT,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        });
      const sigma = sigmaSource * scale;
      const step = (x: number, y: number): GPUBuffer => {
        const buffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(buffer, 0, new Float32Array([x, y, sigma, 0]));
        return buffer;
      };
      copy = {
        result: target(),
        horizontal: target(),
        horizontalStep: step(1 / texSize[0], 0),
        verticalStep: step(0, 1 / texSize[1]),
        stale: true,
      };
      source.blurred.set(key, copy);
    }
    if (copy.stale && source.texture) {
      runPass(encoder, source.texture.createView(), copy.horizontal.createView(), copy.horizontalStep);
      runPass(encoder, copy.horizontal.createView(), copy.result.createView(), copy.verticalStep);
      copy.stale = false;
    }
    return copy.result;
  }

  function targetFor(lens: GpuLens): LensTarget {
    let target = targets.get(lens);
    if (!target) {
      const context = lens.canvas.getContext("webgpu")!;
      context.configure({ device, format, alphaMode: "premultiplied" });
      target = {
        context,
        uniforms: device.createBuffer({ size: LENS_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      };
      targets.set(lens, target);
    }
    return target;
  }

  function flush(): void {
    queued = false;
    if (result.lost || dirty.size === 0) return;
    const dpr = Math.min(view?.devicePixelRatio ?? 1, 2);
    const encoder = device.createCommandEncoder();
    let drew = false;
    for (const [lens, source] of dirty) {
      if (!source.loaded || !lens.visible || !source.texture) continue;
      const target = targetFor(lens);
      const pw = Math.max(1, Math.round(lens.width * dpr));
      const ph = Math.max(1, Math.round(lens.height * dpr));
      if (lens.canvas.width !== pw || lens.canvas.height !== ph) {
        lens.canvas.width = pw;
        lens.canvas.height = ph;
      }
      const look = lens.look;
      const rect = lens.imageRect;
      // Blur is in CSS px; the blurred copy is made in source px.
      const sigmaSource = look.blur * (source.size.width / rect.width);
      const texture = look.blur >= 0.3 ? blurredTexture(encoder, source, sigmaSource) : source.texture;
      if (target.boundTexture !== texture) {
        target.bindGroup = device.createBindGroup({
          layout: lensPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: target.uniforms } },
            { binding: 1, resource: sampler },
            { binding: 2, resource: texture.createView() },
          ],
        });
        target.boundTexture = texture;
      }
      device.queue.writeBuffer(
        target.uniforms,
        0,
        new Float32Array([
          lens.width, lens.height, lens.offsetX, lens.offsetY,
          rect.x, rect.y, rect.width, rect.height,
          look.light[0], look.light[1], 0, 0,
          look.radius, look.depth * lens.intensity, look.curvature, look.splay,
          look.aberration, look.saturation, look.specular, look.sharpness,
          look.shape, look.exponent, 0, 0,
          ...look.tint,
          ...look.specularColor, 1,
        ]),
      );
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: target.context.getCurrentTexture().createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: [0, 0, 0, 0],
          },
        ],
      });
      pass.setPipeline(lensPipeline);
      pass.setBindGroup(0, target.bindGroup!);
      pass.draw(4);
      pass.end();
      drew = true;
    }
    dirty.clear();
    if (drew) device.queue.submit([encoder.finish()]);
  }

  const redraw = (source: Source): void => {
    for (const lens of source.lenses) dirty.set(lens, source);
    schedule();
  };

  /**
   * An image as something WebGPU accepts. Chromium refuses SVG images
   * outright, so an image it rejects is drawn into a 2D canvas first, which
   * stays clean whenever the image is.
   */
  async function imagePixels(img: HTMLImageElement): Promise<ImageBitmap | HTMLCanvasElement> {
    try {
      const bitmap = await createImageBitmap(img);
      const probe = device.createTexture({
        size: [1, 1],
        format: TEXTURE_FORMAT,
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      try {
        device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: probe }, [1, 1]);
        return bitmap;
      } finally {
        probe.destroy();
      }
    } catch {
      const canvas = doc.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d")!.drawImage(img, 0, 0);
      return canvas;
    }
  }

  function load(source: Source): Promise<void> {
    const { media } = source;

    if (typeof media === "string" || media instanceof HTMLImageElement) {
      const img =
        typeof media === "string" ? Object.assign(new Image(), { crossOrigin: "anonymous", src: media }) : media;
      return img.decode().then(async () => {
        source.size = { width: img.naturalWidth, height: img.naturalHeight };
        upload(source, await imagePixels(img));
      });
    }

    if (media instanceof HTMLVideoElement) {
      return new Promise<void>((resolve, reject) => {
        // Each presented frame is uploaded once and every lens over it
        // redraws; with no lenses the source only keeps listening.
        const onFrame = (): void => {
          if (result.lost) return;
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
        if (result.lost) return;
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

  function sourceFor(media: GpuMedia): Source & { ready: Promise<void> } {
    let source = sources.get(media);
    if (!source) {
      const created: Source & { ready: Promise<void> } = {
        media,
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
      // A failed load is retried by the next lens rather than cached.
      created.ready.catch(() => sources.delete(media));
      sources.set(media, created);
      source = created;
    }
    return source;
  }

  return result;
}
