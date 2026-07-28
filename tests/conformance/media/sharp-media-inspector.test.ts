import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  SharpMediaInspectionError,
  SharpMediaInspector,
} from "../../../src/adapters/sharp-media-inspector.js";

async function raster(
  format: "jpeg" | "png" | "webp" | "gif",
  width = 4,
  height = 3,
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 12, g: 34, b: 56, alpha: 0.5 },
    },
  })
    [format]()
    .toBuffer();
}

async function animatedGif(): Promise<Buffer> {
  const red = await sharp({
    create: { width: 3, height: 2, channels: 4, background: "red" },
  })
    .png()
    .toBuffer();
  const blue = await sharp({
    create: { width: 3, height: 2, channels: 4, background: "blue" },
  })
    .png()
    .toBuffer();
  return sharp([red, blue], { join: { animated: true } })
    .gif({ delay: [50, 50] })
    .toBuffer();
}

describe("SharpMediaInspector", () => {
  it.each([
    ["jpeg", "image/jpeg"],
    ["png", "image/png"],
    ["webp", "image/webp"],
    ["gif", "image/gif"],
  ] as const)("sniffs and fully decodes %s bytes", async (format, mimeType) => {
    const inspector = new SharpMediaInspector({ maxInputPixels: 100 });

    await expect(inspector.inspect(await raster(format), mimeType)).resolves.toEqual({
      mimeType,
      width: 4,
      height: 3,
      frameCount: 1,
      channels: format === "jpeg" ? 3 : 4,
    });
  });

  it("returns per-frame dimensions and counts every animated frame", async () => {
    const inspector = new SharpMediaInspector({ maxInputPixels: 12 });

    await expect(inspector.inspect(await animatedGif(), "image/gif")).resolves.toEqual({
      mimeType: "image/gif",
      width: 3,
      height: 2,
      frameCount: 2,
      channels: 4,
    });
  });

  it("rejects a declaration that does not equal the byte-detected MIME type", async () => {
    const inspector = new SharpMediaInspector({ maxInputPixels: 100 });

    await expect(inspector.inspect(await raster("png"), "image/jpeg")).rejects.toMatchObject({
      name: "SharpMediaInspectionError",
      code: "MIME_MISMATCH",
      message: "Declared MIME type does not match the detected image format",
    });
  });

  it.each([
    [
      "SVG",
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"></svg>',
      ),
    ],
    ["PDF", Buffer.from("%PDF-1.4\n%%EOF")],
    ["unknown bytes", Buffer.from("TOP_SECRET_NOT_AN_IMAGE")],
  ])("rejects %s without exposing decoder input", async (_label, bytes) => {
    const inspector = new SharpMediaInspector({ maxInputPixels: 100 });
    const error = await inspector.inspect(bytes).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SharpMediaInspectionError);
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain("TOP_SECRET_NOT_AN_IMAGE");
  });

  it("enforces the aggregate decoded-pixel limit for animation", async () => {
    const inspector = new SharpMediaInspector({ maxInputPixels: 11 });

    await expect(inspector.inspect(await animatedGif())).rejects.toMatchObject({
      name: "SharpMediaInspectionError",
      code: "PIXEL_LIMIT_EXCEEDED",
      message: "Image exceeds the configured decoded-pixel limit",
    });
  });

  it("rejects invalid finite-limit configuration", () => {
    for (const maxInputPixels of [0, -1, Number.POSITIVE_INFINITY, 1.5]) {
      expect(
        () => new SharpMediaInspector({ maxInputPixels }),
      ).toThrowError(SharpMediaInspectionError);
    }
  });
});
