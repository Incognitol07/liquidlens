/**
 * CSS colors as 0..1 RGB for shader uniforms. Hex is parsed directly; any
 * other form is resolved once by a 1x1 canvas and cached.
 */

const cache = new Map<string, [number, number, number]>();
let probe: CanvasRenderingContext2D | null | undefined;

export function cssColorToRgb(color: string, doc: Document): [number, number, number] {
  const cached = cache.get(color);
  if (cached) return cached;

  let rgb: [number, number, number] = [1, 1, 1];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const body = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    const n = Number.parseInt(body, 16);
    rgb = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  } else {
    probe ??= doc.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (probe) {
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = color;
      probe.fillRect(0, 0, 1, 1);
      const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
      rgb = [r / 255, g / 255, b / 255];
    }
  }
  cache.set(color, rgb);
  return rgb;
}
