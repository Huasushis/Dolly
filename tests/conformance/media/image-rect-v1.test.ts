import { describe, expect, it } from "vitest";
import {
  CROP_NORMALIZED_SCALE,
  MAX_SUPPORTED_DIMENSION,
  cropContains,
  cropEquals,
  materializeCropBounds,
  parseRect,
  type MaterializedCropBounds,
  type Rect,
} from "../../../src/core/block-content.js";

/**
 * Conformance for the versioned fixed-point crop rectangle. The authority is
 * `TST-ASSET-001` / `REQ-ASSET-001` in the imported spec: an `image_rect_v1`
 * rectangle has integer `x0`/`y0`/`x1`/`y1` on the `0..=1_000_000` grid of
 * upright display space, right/bottom edges exclusive, and display dimensions
 * `W`/`H` are materialized as exact integers:
 * `left/top = floor(x * W / 1_000_000)`, `right/bottom = ceil(x * W / 1_000_000)`,
 * clamped to `[0,W]`/`[0,H]`. Binary floating point is never used.
 */
const SCALE = CROP_NORMALIZED_SCALE;

function rect(x0: number, y0: number, x1: number, y1: number): Rect {
  return { kind: "image_rect_v1", x0, y0, x1, y1 };
}

function materialized(rectValue: Rect, w: number, h: number): MaterializedCropBounds {
  const materialize = materializeCropBounds(rectValue, w, h);
  expect(materialize).not.toBeNull();
  return materialize!;
}

/** Exactly the reference formula: `(coord * dimension) / 1_000_000`, floored. */
function floorScale(coord: number, dimension: number): number {
  return Math.floor((coord * dimension) / SCALE);
}

function ceilScale(coord: number, dimension: number): number {
  return Math.ceil((coord * dimension) / SCALE);
}

describe("image_rect_v1 fixed-point crop", () => {
  it("RED golden TST-ASSET-001: x1=666667 on W=3 must ceil to right=3 (float 2 is wrong)", () => {
    // 666667 * 3 / 1000000 = 2.000001; ceil => 3, but Math.round gives 2.
    const b = materialized(rect(333_333, 0, 666_667, 1_000_000), 3, 2);
    expect(Math.round((666_667 / SCALE) * 3)).toBe(2);
    expect(b).toEqual({ left: 0, top: 0, right: 3, bottom: 2 });
    expect(b.right).toBe(3);
  });

  it("exposes the spec constants", () => {
    expect(CROP_NORMALIZED_SCALE).toBe(1_000_000);
    expect(MAX_SUPPORTED_DIMENSION).toBe(9_007_199_254_740_991);
  });

  it("clamps display edge values 0, 999999, and 1000000 on a 7x11 display", () => {
    // x0 = 0 -> left = 0; x1 = 1000000 -> right = W (7). y boundaries on H (11).
    const full = materialized(rect(0, 0, SCALE, SCALE), 7, 11);
    expect(full).toEqual({ left: 0, top: 0, right: 7, bottom: 11 });

    // Near-bottom edge: x0 = 999999 covers the last pixel and never overflows.
    const edge = materialized(rect(999_999, 999_999, SCALE, SCALE), 7, 11);
    expect(edge.left).toBe(floorScale(999_999, 7));
    expect(edge.top).toBe(floorScale(999_999, 11));
    expect(edge.right).toBe(7);
    expect(edge.bottom).toBe(11);

    // x1 = 1 on a 7-wide display rounds up to 1 pixel, not to 0.
    expect(materialized(rect(0, 0, 1, 1), 7, 11).right).toBe(1);
  });

  it("materializes the smallest accepted crop to one pixel on a 1x1 display", () => {
    // With W = H = 1, ceil(x1 / scale) >= 1 and floor(x0 / scale) <= 0.
    const b = materialized(rect(0, 0, 1, 1), 1, 1);
    expect(b).toEqual({ left: 0, top: 0, right: 1, bottom: 1 });
    // Even a corner-only crop still covers that single pixel.
    expect(materialized(rect(999_999, 999_999, SCALE, SCALE), 1, 1)).toEqual({
      left: 0,
      top: 0,
      right: 1,
      bottom: 1,
    });
  });

  it("over the full image on odd dimensions always covers W x H", () => {
    const b = materialized(rect(0, 0, SCALE, SCALE), 3, 1);
    expect(b).toEqual({ left: 0, top: 0, right: 3, bottom: 1 });
    const square = materialized(rect(0, 0, SCALE, SCALE), 640, 480);
    expect(square).toEqual({ left: 0, top: 0, right: 640, bottom: 480 });
  });

  it("rejects non-integer, out-of-range, inverted, and unknown-field crop shapes", () => {
    for (const bad of [
      { topLeft: { x: 0.1, y: 0.1 }, bottomRight: { x: 0.9, y: 0.9 } }, // legacy float rect
      { kind: "image_rect_v1", x0: 0, y0: 0, x1: 0.4, y1: 0.4 }, // floats
      { kind: "image_rect_v1", x0: "0", y0: 0, x1: 900000, y1: 1 }, // string
      { kind: "image_rect_v1", x0: NaN, y0: 0, x1: 900000, y1: 1 }, // NaN
      { kind: "image_rect_v1", x0: 0, y0: 0, x1: 1_000_001, y1: 1 }, // above scale
      { kind: "image_rect_v1", x0: 5, y0: 0, x1: 3, y1: 4 }, // inverted x
      { kind: "image_rect_v1", x0: 0, y0: 5, x1: 4, y1: 3 }, // inverted y
      { kind: "image_rect_v1", x0: 0, y0: 0, x1: 0, y1: 1 }, // zero-width
      { kind: "image_rect_v2", x0: 0, y0: 0, x1: 1, y1: 1 }, // wrong version
      { kind: "image_rect_v1", x0: 0, y0: 0, x1: 1, y1: 1, extra: true }, // unknown field
      { kind: "image_rect_v1", x0: 0, y0: 0, x1: 1 }, // missing y1
    ]) {
      expect(() => parseRect(bad)).toThrow();
    }
  });

  it("fails closed in materialize when a display dimension is invalid", () => {
    // A valid crop cannot materialize onto a zero or oversized display.
    expect(materializeCropBounds(rect(0, 0, 1, 1), 0, 1)).toBeNull();
    expect(materializeCropBounds(rect(0, 0, 1, 1), 1, 0)).toBeNull();
    expect(materializeCropBounds(rect(0, 0, 1, 1), MAX_SUPPORTED_DIMENSION + 1, 1)).toBeNull();
    // And malformed crop premises fail closed too.
    expect(materializeCropBounds({ invalid: true } as unknown as Rect, 5, 5)).toBeNull();
    const inverted = rect(5, 0, 3, 4);
    expect(materializeCropBounds(inverted, 5, 5)).toBeNull();
  });

  it("a crop is scoped to one display: the granted crop never leaks across assets", () => {
    // Same fixed-point crop, two very different displays, two exact bounds.
    const crop = rect(200_000, 200_000, 800_000, 800_000);
    const wide = materializeCropBounds(crop, 1_000, 500)!;
    const tall = materializeCropBounds(crop, 500, 1_000)!;
    expect(wide).not.toEqual(tall);
    expect(wide).toEqual({ left: 200, top: 100, right: 800, bottom: 400 });
    expect(tall).toEqual({ left: 100, top: 200, right: 400, bottom: 800 });
    // The crop rectangle's authority lives in the asset descriptor; a
    // different asset carrying the same rectangle gets its own materialization,
    // never a copy of another asset's pixel result.
    expect(cropEquals(crop, rect(200_000, 200_000, 800_000, 800_000))).toBe(true);
    expect(cropEquals(crop, rect(200_000, 200_000, 900_000, 800_000))).toBe(false);
  });

  it("documents floor/ceil boundaries that pins each edge independently", () => {
    // left/top floor, right/bottom ceil, verified against independent formula.
    const b = materialized(rect(333_333, 333_333, 666_667, 666_667), 7, 11);
    expect(b.left).toBe(floorScale(333_333, 7));
    expect(b.top).toBe(floorScale(333_333, 11));
    expect(b.right).toBe(ceilScale(666_667, 7));
    expect(b.bottom).toBe(ceilScale(666_667, 11));
  });

  describe("crop coverage judgments", () => {
    it("detects exact equality, equality after copy, and inequality", () => {
      const a = rect(100_000, 200_000, 300_000, 400_000);
      expect(cropEquals(a, rect(100_000, 200_000, 300_000, 400_000))).toBe(true);
      expect(cropEquals(a, parseRect({ kind: "image_rect_v1", x0: 100_000, y0: 200_000, x1: 300_000, y1: 400_000 }))).toBe(true);
      expect(cropEquals(a, rect(100_000, 200_000, 300_000, 500_000))).toBe(false);
    });

    it("contains sub-crops but never across disjoint or overlapping crops", () => {
      const outer = rect(100_000, 100_000, 900_000, 900_000);
      const inner = rect(200_000, 200_000, 300_000, 300_000);
      expect(cropContains(outer, inner)).toBe(true);
      expect(cropContains(inner, outer)).toBe(false);
      // Sharing an edge is still contained; one-past is not.
      expect(cropContains(outer, rect(100_000, 100_000, 900_000, 900_000))).toBe(true);
      expect(cropContains(outer, rect(100_000, 100_000, 1_000_000, 900_000))).toBe(false);
    });
  });
});
