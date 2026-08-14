import { Buffer } from "node:buffer";
import type {
  ExtractedFrame,
  FrameExtractor,
} from "../../../src/core/video-frame-extraction.js";

export interface FakeFrameExtractorOptions {
  /** Video length in seconds; requests at or past this position report no frame. */
  readonly durationSeconds: number;
  /** MIME type reported for every produced frame. Defaults to "image/jpeg". */
  readonly mimeType?: string;
  /**
   * Deterministic bytes for a frame at a given position. Defaults to a fixed
   * 8-byte big-endian double encoding of the position, which makes emitted
   * frames byte-verifiable and stable across runs.
   */
  readonly frameBytes?: (positionSeconds: number) => Uint8Array;
}

/**
 * Deterministic in-memory `FrameExtractor` for tests. It models a video of a
 * fixed duration and produces one frame per requested position strictly before
 * the duration; the first position at or past the duration reports end of
 * stream, so every frame is available exactly once and in position order.
 */
export class FakeFrameExtractor implements FrameExtractor {
  readonly #durationSeconds: number;
  readonly #mimeType: string;
  readonly #frameBytes: (positionSeconds: number) => Uint8Array;
  #extractCalls = 0;

  constructor(options: FakeFrameExtractorOptions) {
    if (
      !Number.isFinite(options.durationSeconds) ||
      options.durationSeconds <= 0
    ) {
      throw new TypeError(
        "durationSeconds must be a finite number greater than zero",
      );
    }
    this.#durationSeconds = options.durationSeconds;
    this.#mimeType = options.mimeType ?? "image/jpeg";
    this.#frameBytes =
      options.frameBytes ??
      ((positionSeconds: number) => {
        const payload = Buffer.alloc(8);
        payload.writeDoubleBE(positionSeconds, 0);
        return payload;
      });
  }

  /** How many times the module pulled this extractor. Asserts stream bounds. */
  get extractCalls(): number {
    return this.#extractCalls;
  }

  async extract(
    _bytes: Uint8Array,
    positionSeconds: number,
  ): Promise<ExtractedFrame | undefined> {
    this.#extractCalls += 1;
    if (positionSeconds >= this.#durationSeconds) return undefined;
    return {
      mimeType: this.#mimeType,
      bytes: this.#frameBytes(positionSeconds),
    };
  }
}