import type { JsonValue } from "../canonical-json.js";

/**
 * Deterministic audio segmentation.
 *
 * Splits a raw PCM-like audio byte buffer into consecutive fixed-duration
 * segments, using an explicit encoding to convert bytes to time. The result
 * depends only on the input bytes and the configured format/options, never on
 * wall-clock time or process state, so the same input always yields the same
 * segments (including byte offsets and millisecond timestamps).
 *
 * The input is treated as a sequence of sample frames; a trailing partial
 * frame at the end of the buffer is ignored. Segments are returned as
 * zero-copy views over the input buffer, not copies.
 */

/** How raw audio bytes map to time. */
export interface AudioFormat {
  /** Sample frames per second (Hz). */
  readonly sampleRate: number;
  /** Bytes per sample frame (e.g. 2 for 16-bit pulse-code modulation). */
  readonly bytesPerSample: number;
  /** Interleaved channel count (e.g. 1 for mono). */
  readonly channels: number;
}

export interface AudioSegmentationOptions {
  readonly format: AudioFormat;
  /** Fixed duration of every segment, in milliseconds. */
  readonly segmentDurationMs: number;
  /** Overlap of consecutive segments, in milliseconds. Must be smaller than `segmentDurationMs`. */
  readonly overlapMs: number;
  /** Upper bound on the number of segments; input that needs more is rejected. */
  readonly maxSegments: number;
}

/** One fixed-duration slice of the input buffer. */
export interface AudioSegment {
  /** Zero-based position of this segment in the segmentation order. */
  readonly index: number;
  /** Inclusive byte offset of the segment's first sample frame. */
  readonly startByte: number;
  /** Exclusive byte offset just past the segment's last sample frame. */
  readonly endByte: number;
  /** Segment start time, in milliseconds, derived from its first frame. */
  readonly startMs: number;
  /** Segment end time, in milliseconds, derived from the frame after its last. */
  readonly endMs: number;
  /** Zero-copy view over the input bytes for this segment. */
  readonly data: Uint8Array;
}

export type AudioSegmentationErrorCode =
  | "AUDIO_SEGMENTATION_OPTIONS_INVALID"
  | "AUDIO_SEGMENTATION_BUFFER_EMPTY"
  | "AUDIO_SEGMENTATION_BUFFER_TOO_SHORT"
  | "AUDIO_SEGMENTATION_OVERLAP_INVALID"
  | "AUDIO_SEGMENTATION_SEGMENT_COUNT_EXCEEDED";

export class AudioSegmentationError extends Error {
  constructor(
    readonly code: AudioSegmentationErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "AudioSegmentationError";
  }
}

function requirePositiveSafeInteger(
  value: number,
  label: string,
  message: string,
): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AudioSegmentationError(
      "AUDIO_SEGMENTATION_OPTIONS_INVALID",
      `${label} ${message}`,
      { [label]: value },
    );
  }
  return value;
}

function requireNonNegativeSafeInteger(
  value: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AudioSegmentationError(
      "AUDIO_SEGMENTATION_OPTIONS_INVALID",
      `${label} must be a non-negative safe integer`,
      { [label]: value },
    );
  }
  return value;
}

interface NormalizedSegmentation {
  readonly bytesPerFrame: number;
  /** Sample frames per segment (converted from milliseconds). */
  readonly segmentFrames: number;
  /** Sample frames of overlap between consecutive segments. */
  readonly overlapFrames: number;
  /** Frames advanced per segment; always at least 1. */
  readonly stepFrames: number;
  readonly maxSegments: number;
  readonly sampleRate: number;
}

export class AudioSegmenter {
  readonly #options: NormalizedSegmentation;

  constructor(options: AudioSegmentationOptions) {
    const { format } = options;
    const sampleRate = requirePositiveSafeInteger(
      format?.sampleRate,
      "format.sampleRate",
      "must be a positive safe integer",
    );
    const bytesPerSample = requirePositiveSafeInteger(
      format?.bytesPerSample,
      "format.bytesPerSample",
      "must be a positive safe integer",
    );
    const channels = requirePositiveSafeInteger(
      format?.channels,
      "format.channels",
      "must be a positive safe integer",
    );
    const segmentDurationMs = requirePositiveSafeInteger(
      options.segmentDurationMs,
      "segmentDurationMs",
      "must be a positive safe integer",
    );
    const overlapMs = requireNonNegativeSafeInteger(options.overlapMs, "overlapMs");
    const maxSegments = requirePositiveSafeInteger(
      options.maxSegments,
      "maxSegments",
      "must be a positive safe integer",
    );
    if (overlapMs >= segmentDurationMs) {
      throw new AudioSegmentationError(
        "AUDIO_SEGMENTATION_OVERLAP_INVALID",
        "overlapMs must be smaller than segmentDurationMs",
        { overlapMs, segmentDurationMs },
      );
    }

    const bytesPerFrame = bytesPerSample * channels;
    const segmentFrames = Math.max(
      1,
      Math.round((segmentDurationMs * sampleRate) / 1000),
    );
    const overlapFrames = Math.round((overlapMs * sampleRate) / 1000);
    // Frame-level overlap guard: rounding can collapse distinct millisecond
    // values to the same frame count, so milliseconds alone do not prove a
    // usable step. A step of zero would loop forever.
    if (overlapFrames >= segmentFrames) {
      throw new AudioSegmentationError(
        "AUDIO_SEGMENTATION_OVERLAP_INVALID",
        "overlapMs must be smaller than segmentDurationMs at the frame granularity",
        { overlapMs, segmentDurationMs, overlapFrames, segmentFrames },
      );
    }

    this.#options = Object.freeze({
      bytesPerFrame,
      segmentFrames,
      overlapFrames,
      stepFrames: segmentFrames - overlapFrames,
      maxSegments,
      sampleRate,
    });
  }

  /**
   * Splits `input` into fixed-duration segments.
   *
   * Validation order is fail-closed: an empty buffer (no complete sample
   * frame) is rejected, a buffer shorter than one segment is rejected, and
   * input that would produce more than `maxSegments` segments is rejected
   * before any segment object is allocated.
   */
  segment(input: Uint8Array): readonly AudioSegment[] {
    const { bytesPerFrame, segmentFrames, stepFrames, maxSegments, sampleRate } =
      this.#options;

    const usableFrames = Math.floor(input.byteLength / bytesPerFrame);
    if (usableFrames === 0) {
      throw new AudioSegmentationError(
        "AUDIO_SEGMENTATION_BUFFER_EMPTY",
        "audio buffer contains no complete sample frame",
        { byteLength: input.byteLength, bytesPerFrame },
      );
    }
    if (usableFrames < segmentFrames) {
      throw new AudioSegmentationError(
        "AUDIO_SEGMENTATION_BUFFER_TOO_SHORT",
        "audio buffer is shorter than one segment",
        { usableFrames, segmentFrames },
      );
    }

    const count = Math.ceil(usableFrames / stepFrames);
    if (count > maxSegments) {
      throw new AudioSegmentationError(
        "AUDIO_SEGMENTATION_SEGMENT_COUNT_EXCEEDED",
        "audio buffer would produce more than maxSegments segments",
        { count, maxSegments, usableFrames, stepFrames },
      );
    }

    const segments: AudioSegment[] = new Array(count);
    for (let index = 0; index < count; index++) {
      const startFrame = index * stepFrames;
      // The final segment is clamped to the buffer end and may be shorter
      // than a full segment, matching the fixed-duration split convention.
      const endFrame = Math.min(startFrame + segmentFrames, usableFrames);
      const startByte = startFrame * bytesPerFrame;
      const endByte = endFrame * bytesPerFrame;
      segments[index] = {
        index,
        startByte,
        endByte,
        startMs: Math.round((startFrame * 1000) / sampleRate),
        endMs: Math.round((endFrame * 1000) / sampleRate),
        data: input.subarray(startByte, endByte),
      };
    }
    return segments;
  }
}