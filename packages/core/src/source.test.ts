import { describe, expect, it } from "vitest";
import { backgroundFit, boxRectToSource, parsePosition, placeMedia } from "./source";

const center = parsePosition("50% 50%");

describe("placeMedia", () => {
  it("stretches to the box for fill", () => {
    expect(placeMedia(400, 300, 100, 100, "fill")).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });

  it("covers: scales to the larger ratio and centres the overflow", () => {
    // 200x100 into 100x100: scale 1 (height-bound), 100px overflow split evenly.
    expect(placeMedia(100, 100, 200, 100, "cover", center)).toEqual({ x: -50, y: 0, width: 200, height: 100 });
  });

  it("contains: scales to the smaller ratio and centres the letterbox", () => {
    expect(placeMedia(100, 100, 200, 100, "contain", center)).toEqual({ x: 0, y: 25, width: 100, height: 50 });
  });

  it("draws at natural size for none", () => {
    expect(placeMedia(100, 100, 40, 20, "none", center)).toEqual({ x: 30, y: 40, width: 40, height: 20 });
  });

  it("scale-down never enlarges", () => {
    expect(placeMedia(100, 100, 40, 20, "scale-down", center)).toEqual({ x: 30, y: 40, width: 40, height: 20 });
    expect(placeMedia(100, 100, 400, 200, "scale-down", center)).toEqual({ x: 0, y: 25, width: 100, height: 50 });
  });

  it("honours the position fraction and px offset", () => {
    const topLeft = parsePosition("0% 0%");
    expect(placeMedia(100, 100, 200, 100, "cover", topLeft)).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    const offset = parsePosition("10px 20px");
    expect(placeMedia(100, 100, 40, 20, "none", offset)).toEqual({ x: 10, y: 20, width: 40, height: 20 });
  });
});

describe("boxRectToSource", () => {
  it("maps a box rect through a cover placement into source pixels", () => {
    const placement = placeMedia(100, 100, 200, 100, "cover", center);
    // The box's left half starts 50 source px in.
    expect(boxRectToSource(placement, 200, 100, { x: 0, y: 0, width: 50, height: 100 })).toEqual({
      sx: 50,
      sy: 0,
      sw: 50,
      sh: 100,
    });
  });

  it("clamps a rect that overhangs the media", () => {
    const placement = placeMedia(100, 100, 100, 100, "fill");
    const mapped = boxRectToSource(placement, 100, 100, { x: 90, y: -10, width: 50, height: 50 });
    expect(mapped.sx).toBe(90);
    expect(mapped.sy).toBe(0);
    expect(mapped.sw).toBe(10);
  });
});

describe("parsePosition", () => {
  it("reads percentages, lengths and keywords", () => {
    expect(parsePosition("25% 75%")).toEqual([
      { fraction: 0.25, px: 0 },
      { fraction: 0.75, px: 0 },
    ]);
    expect(parsePosition("12px 0px")).toEqual([
      { fraction: 0, px: 12 },
      { fraction: 0, px: 0 },
    ]);
    expect(parsePosition("center")).toEqual([
      { fraction: 0.5, px: 0 },
      { fraction: 0.5, px: 0 },
    ]);
    expect(parsePosition("right bottom")).toEqual([
      { fraction: 1, px: 0 },
      { fraction: 1, px: 0 },
    ]);
  });
});

describe("backgroundFit", () => {
  it("maps background-size onto object-fit", () => {
    expect(backgroundFit("cover")).toBe("cover");
    expect(backgroundFit("contain")).toBe("contain");
    expect(backgroundFit("auto")).toBe("none");
    expect(backgroundFit("100% 100%")).toBe("fill");
  });
});
