import sharp, { type Metadata } from "sharp";
import type {
  MediaInspection,
  MediaInspector,
} from "../core/media-store.js";

export const DEFAULT_SHARP_MAX_INPUT_PIXELS = 40_000_000;

const SUPPORTED_FORMATS = Object.freeze({
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
} as const);

type SupportedSharpFormat = keyof typeof SUPPORTED_FORMATS;

export type SharpMediaInspectionErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_INPUT"
  | "UNSUPPORTED_FORMAT"
  | "MIME_MISMATCH"
  | "PIXEL_LIMIT_EXCEEDED"
  | "DECODE_FAILED";

export class SharpMediaInspectionError extends Error {
  readonly code: SharpMediaInspectionErrorCode;

  constructor(code: SharpMediaInspectionErrorCode, message: string) {
    super(message);
    this.name = "SharpMediaInspectionError";
    this.code = code;
  }
}

export interface SharpMediaInspectorOptions {
  /** Maximum decoded pixels across all frames/pages in one input image. */
  readonly maxInputPixels?: number;
}

function isSupportedFormat(format: Metadata["format"]): format is SupportedSharpFormat {
  return Object.hasOwn(SUPPORTED_FORMATS, format);
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isSharpPixelLimitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes("exceeds pixel limit")
  );
}

function inspectionErrorFor(error: unknown): SharpMediaInspectionError {
  if (error instanceof SharpMediaInspectionError) return error;
  if (isSharpPixelLimitError(error)) {
    return new SharpMediaInspectionError(
      "PIXEL_LIMIT_EXCEEDED",
      "Image exceeds the configured decoded-pixel limit",
    );
  }
  return new SharpMediaInspectionError(
    "DECODE_FAILED",
    "Image bytes could not be decoded safely",
  );
}

function assertDecodedPixelLimit(
  metadata: Metadata,
  frameHeight: number,
  frameCount: number,
  maxInputPixels: number,
): void {
  const logicalPixels =
    BigInt(metadata.width) * BigInt(frameHeight) * BigInt(frameCount);
  const decoderPixels = BigInt(metadata.width) * BigInt(metadata.height);
  if (
    logicalPixels > BigInt(maxInputPixels) ||
    decoderPixels > BigInt(maxInputPixels)
  ) {
    throw new SharpMediaInspectionError(
      "PIXEL_LIMIT_EXCEEDED",
      "Image exceeds the configured decoded-pixel limit",
    );
  }
}

/**
 * Bounded raster-image inspection for Dolly's default JPEG/PNG/WebP/GIF
 * allowlist. Sharp determines the format from bytes; caller declarations are
 * only checked after detection and never select a decoder.
 */
export class SharpMediaInspector implements MediaInspector {
  readonly #maxInputPixels: number;

  constructor(options: SharpMediaInspectorOptions = {}) {
    const maxInputPixels =
      options.maxInputPixels ?? DEFAULT_SHARP_MAX_INPUT_PIXELS;
    if (!isPositiveSafeInteger(maxInputPixels)) {
      throw new SharpMediaInspectionError(
        "INVALID_CONFIGURATION",
        "maxInputPixels must be a positive safe integer",
      );
    }
    this.#maxInputPixels = maxInputPixels;
  }

  async inspect(
    bytes: Uint8Array,
    declaredMimeType?: string,
  ): Promise<MediaInspection> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new SharpMediaInspectionError(
        "INVALID_INPUT",
        "Image bytes must be a non-empty Uint8Array",
      );
    }

    // Snapshot the input so callers cannot mutate it while native decoding runs.
    try {
      const input = Buffer.from(bytes);
      const image = sharp(input, {
        animated: true,
        failOn: "warning",
        limitInputChannels: 4,
        limitInputPixels: this.#maxInputPixels,
        sequentialRead: true,
        unlimited: false,
      });
      const metadata = await image.metadata();
      if (!isSupportedFormat(metadata.format)) {
        throw new SharpMediaInspectionError(
          "UNSUPPORTED_FORMAT",
          "Image format is not in the JPEG, PNG, WebP, and GIF allowlist",
        );
      }

      const mimeType = SUPPORTED_FORMATS[metadata.format];
      if (declaredMimeType !== undefined && declaredMimeType !== mimeType) {
        throw new SharpMediaInspectionError(
          "MIME_MISMATCH",
          "Declared MIME type does not match the detected image format",
        );
      }

      const frameCount = metadata.pages ?? 1;
      const frameHeight = metadata.pageHeight ?? metadata.height;
      if (
        !isPositiveSafeInteger(metadata.width) ||
        !isPositiveSafeInteger(metadata.height) ||
        !isPositiveSafeInteger(frameHeight) ||
        !isPositiveSafeInteger(frameCount) ||
        !isPositiveSafeInteger(metadata.channels)
      ) {
        throw new SharpMediaInspectionError(
          "DECODE_FAILED",
          "Image metadata is invalid",
        );
      }
      assertDecodedPixelLimit(
        metadata,
        frameHeight,
        frameCount,
        this.#maxInputPixels,
      );

      // metadata() reads headers. stats() forces bounded pixel decoding so a
      // valid-looking header with a corrupt body is not registered as an Asset.
      await image.stats();

      return Object.freeze({
        mimeType,
        width: metadata.width,
        height: frameHeight,
        frameCount,
        channels: metadata.channels,
      });
    } catch (error) {
      throw inspectionErrorFor(error);
    }
  }
}
