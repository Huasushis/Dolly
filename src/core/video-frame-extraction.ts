/**
 * Video frame extraction: pure input validation, interval math, and a
 * stream-returned, stably ordered sequence of frames produced by an injectable
 * decoder.
 *
 * This module never decodes video itself. Validation (non-video signature
 * rejection, interval sanity, max-frame clamp) and the presentation-time
 * schedule live here, while decoding is delegated to a `FrameExtractor`
 * supplied by the caller so unit tests run without any real decoder.
 */

/**
 * Upper bound on the number of frames one extraction run may emit when the
 * request does not specify `maxFrames`.
 */
export const DEFAULT_MAX_VIDEO_FRAMES = 1000;

/**
 * Largest interval (in seconds) between consecutive frames that a request may
 * use. Rejects absurd intervals that no real video could satisfy.
 */
export const MAX_VIDEO_INTERVAL_SECONDS = 86_400;

export type VideoFrameExtractionErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_INPUT"
  | "UNSUPPORTED_FORMAT";

export class VideoFrameExtractionError extends Error {
  readonly code: VideoFrameExtractionErrorCode;

  constructor(code: VideoFrameExtractionErrorCode, message: string) {
    super(message);
    this.name = "VideoFrameExtractionError";
    this.code = code;
  }
}

/** Containers recognized by their byte signature before decoding. */
export type VideoContainer =
  | "mp4"
  | "webm"
  | "avi"
  | "mpeg-ps"
  | "mpeg-ts"
  | "flv";

/** One decoded frame image produced by a `FrameExtractor`. */
export interface ExtractedFrame {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

/**
 * Decoder the extraction module drives. Given the original video bytes and a
 * presentation time in seconds, it returns the frame that starts at that time,
 * or `undefined` when the video has no frame there (end of stream).
 */
export interface FrameExtractor {
  extract(
    bytes: Uint8Array,
    positionSeconds: number,
  ): Promise<ExtractedFrame | undefined>;
}

/** One frame of the extraction stream, in presentation order. */
export interface VideoFrame extends ExtractedFrame {
  /** Zero-based position of the frame in the extraction stream. */
  readonly index: number;
  /** Presentation time offset in seconds from the start of the video. */
  readonly timeSeconds: number;
}

export interface VideoFrameRequest {
  /** Container bytes of the video to extract frames from. */
  readonly bytes: Uint8Array;
  /** Seconds between consecutive requested frame positions. Must be finite and greater than zero. */
  readonly intervalSeconds: number;
  /** Upper bound on how many frames the stream may emit. Defaults to `DEFAULT_MAX_VIDEO_FRAMES`. */
  readonly maxFrames?: number;
}

/**
 * Detects the container of a byte buffer from its leading signature bytes.
 * Returns `undefined` when the buffer is too short or matches no known
 * container. Never reads beyond the first twelve bytes.
 */
export function detectVideoContainer(bytes: Uint8Array): VideoContainer | undefined {
  if (bytes.byteLength < 12) return undefined;

  // ISO Base Media File Format (MP4/MOV and brand variants): a 4-byte size
  // followed by the "ftyp" box type.
  if (
    bytes[4] === 0x66 && bytes[5] === 0x74 &&
    bytes[6] === 0x79 && bytes[7] === 0x70
  ) {
    return "mp4";
  }
  // EBML header, shared by WebM and Matroska.
  if (
    bytes[0] === 0x1a && bytes[1] === 0x45 &&
    bytes[2] === 0xdf && bytes[3] === 0xa3
  ) {
    return "webm";
  }
  // RIFF container with an "AVI " form type.
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 &&
    bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x41 && bytes[9] === 0x56 &&
    bytes[10] === 0x49 && bytes[11] === 0x20
  ) {
    return "avi";
  }
  // MPEG program stream pack header.
  if (
    bytes[0] === 0x00 && bytes[1] === 0x00 &&
    bytes[2] === 0x01 && bytes[3] === 0xba
  ) {
    return "mpeg-ps";
  }
  // MPEG transport stream sync byte.
  if (bytes[0] === 0x47) {
    return "mpeg-ts";
  }
  // FLV: "FLV" followed by version byte 1.
  if (
    bytes[0] === 0x46 && bytes[1] === 0x4c &&
    bytes[2] === 0x56 && bytes[3] === 0x01
  ) {
    return "flv";
  }
  return undefined;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Validates a frame-extraction request synchronously, rejecting inputs that
 * cannot produce a well-defined stream: non-video bytes, a nonsensical
 * interval, or an invalid `maxFrames`. Throws `VideoFrameExtractionError`.
 */
export function validateVideoFrameRequest(request: VideoFrameRequest): void {
  if (
    request === null ||
    typeof request !== "object" ||
    !(request.bytes instanceof Uint8Array) ||
    request.bytes.byteLength === 0
  ) {
    throw new VideoFrameExtractionError(
      "INVALID_INPUT",
      "Video bytes must be a non-empty Uint8Array",
    );
  }
  if (detectVideoContainer(request.bytes) === undefined) {
    throw new VideoFrameExtractionError(
      "UNSUPPORTED_FORMAT",
      "Bytes do not match a recognized video container signature " +
        "(MP4, WebM/Matroska, AVI, MPEG program stream, MPEG transport stream, or FLV)",
    );
  }
  const { intervalSeconds } = request;
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new VideoFrameExtractionError(
      "INVALID_INPUT",
      "intervalSeconds must be a finite number greater than zero",
    );
  }
  if (intervalSeconds > MAX_VIDEO_INTERVAL_SECONDS) {
    throw new VideoFrameExtractionError(
      "INVALID_INPUT",
      `intervalSeconds must not exceed ${MAX_VIDEO_INTERVAL_SECONDS} seconds`,
    );
  }
  if (
    request.maxFrames !== undefined &&
    !isPositiveSafeInteger(request.maxFrames)
  ) {
    throw new VideoFrameExtractionError(
      "INVALID_INPUT",
      "maxFrames must be a positive safe integer when provided",
    );
  }
}

/**
 * Streams frames of the requested video in stable presentation order (index 0,
 * interval, 2 * interval, ...). Validation runs synchronously when the stream
 * is created; the extractor is pulled once per requested position and the
 * stream ends when the extractor reports no frame, either because the video
 * ended or because `maxFrames` frames were already emitted. Each yielded frame
 * is an independent snapshot the caller may mutate without affecting later
 * frames.
 */
export function extractVideoFrames(
  request: VideoFrameRequest,
  extractor: FrameExtractor,
): AsyncGenerator<VideoFrame> {
  validateVideoFrameRequest(request);
  if (
    extractor === null ||
    typeof extractor !== "object" ||
    typeof extractor.extract !== "function"
  ) {
    throw new VideoFrameExtractionError(
      "INVALID_CONFIGURATION",
      "A frame extractor implementing FrameExtractor is required",
    );
  }

  const { bytes, intervalSeconds } = request;
  const maxFrames = request.maxFrames ?? DEFAULT_MAX_VIDEO_FRAMES;

  return (async function* () {
    let emitted = 0;
    for (let index = 0; index < maxFrames; index++) {
      const timeSeconds = index * intervalSeconds;
      const frame = await extractor.extract(bytes, timeSeconds);
      if (frame === undefined) break;
      // Snapshot so the caller cannot mutate a frame while the stream is open.
      const snapshot = Buffer.from(frame.bytes);
      yield Object.freeze({
        index,
        timeSeconds,
        mimeType: frame.mimeType,
        bytes: snapshot,
      });
      emitted += 1;
    }
  })();
}