import { deepFreeze, type JsonValue } from "../canonical-json.js";

/**
 * Skeleton for the audio segmentation and video frame extraction pipeline
 * defined by `docs/spec/media-derivation.md`.
 *
 * This file implements the contract's interfaces, plan validation, limits, and
 * fail-closed sequencing. It launches no external process. Real FFmpeg
 * integration is **not implemented**: the default toolchain reports itself
 * unavailable, so an unconfigured deployment fails visibly instead of
 * silently returning the source or a shortened result. Section 10 of the
 * specification lists everything else that is still missing, including
 * derivation record persistence, the `derived` provenance value, crash
 * recovery, and any Extension-facing capability.
 */

export type MediaDerivationOperation = "audio.split" | "video.extractFrames";

const SUPPORTED_AUDIO_OUTPUT_MIME_TYPES: readonly string[] = [
  "audio/wav",
  "audio/mpeg",
  "audio/ogg",
  "audio/flac",
];

const SUPPORTED_FRAME_OUTPUT_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
];

export interface MediaDerivationSourceDescription {
  readonly mediaId: string;
  readonly mimeType: string;
  readonly byteLength: number;
  /** Absent when the bounded inspector could not determine a duration. */
  readonly durationMs?: number;
}

/** The trusted-host port that supplies source metadata. */
export interface MediaDerivationSource {
  describe(
    mediaId: string,
  ):
    | Promise<MediaDerivationSourceDescription | null>
    | MediaDerivationSourceDescription
    | null;
}

export interface AudioSplitRange {
  readonly startMs: number;
  readonly endMs: number;
}

export interface AudioSplitParameters {
  readonly operation: "audio.split";
  readonly outputMimeType: string;
  /** Fixed-duration form. Mutually exclusive with `ranges`. */
  readonly segmentDurationMs?: number;
  /** Only sanctioned overlap. Allowed with `segmentDurationMs` only. */
  readonly overlapMs?: number;
  /** Explicit form. Mutually exclusive with `segmentDurationMs`. */
  readonly ranges?: readonly AudioSplitRange[];
}

export interface VideoExtractFramesParameters {
  readonly operation: "video.extractFrames";
  readonly outputMimeType: string;
  /** Explicit form. Mutually exclusive with `intervalMs`. */
  readonly timestampsMs?: readonly number[];
  /** Fixed-interval form. Mutually exclusive with `timestampsMs`. */
  readonly intervalMs?: number;
  readonly maxFrames?: number;
}

export type MediaDerivationParameters =
  | AudioSplitParameters
  | VideoExtractFramesParameters;

export interface MediaDerivationRequest {
  /** Host-derived idempotency identity for one derivation. */
  readonly derivationId: string;
  readonly sourceMediaId: string;
  readonly parameters: MediaDerivationParameters;
  readonly signal?: AbortSignal;
}

export interface PlannedAudioPart {
  readonly kind: "audio-segment";
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
}

export interface PlannedFramePart {
  readonly kind: "video-frame";
  readonly index: number;
  readonly timestampMs: number;
}

export type PlannedMediaPart = PlannedAudioPart | PlannedFramePart;

export interface MediaDerivationPlan {
  readonly derivationId: string;
  readonly sourceMediaId: string;
  readonly operation: MediaDerivationOperation;
  readonly outputMimeType: string;
  readonly parts: readonly PlannedMediaPart[];
}

/** One output the toolchain reports. Its timing must agree with the plan. */
export interface ProducedMediaPart {
  readonly index: number;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly startMs?: number;
  readonly endMs?: number;
  readonly timestampMs?: number;
}

export type MediaDerivationToolchainProbe =
  | {
      readonly available: true;
      readonly toolchainId: string;
      readonly version: string;
    }
  | { readonly available: false; readonly reason: string };

export interface MediaDerivationToolchainRunInput {
  readonly plan: MediaDerivationPlan;
  readonly source: MediaDerivationSourceDescription;
  readonly signal: AbortSignal;
}

/**
 * The injected external-tool boundary. A real implementation launches FFmpeg
 * in a child process, passes every parameter as a separate argument value,
 * and terminates the whole process group on abort. No such implementation
 * exists yet.
 */
export interface MediaDerivationToolchain {
  probe(signal: AbortSignal): Promise<MediaDerivationToolchainProbe>;
  run(input: MediaDerivationToolchainRunInput): Promise<readonly ProducedMediaPart[]>;
}

export interface DerivedPartRegistration {
  readonly derivationId: string;
  readonly sourceMediaId: string;
  readonly index: number;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly signal: AbortSignal;
}

/**
 * The trusted-host port that turns produced bytes into registered Media.
 *
 * A real implementation calls `MediaStore.registerMedia` with a derivation
 * provenance. `media.md` does not define that provenance value yet, which is
 * one reason this pipeline is not wired to a real store.
 */
export interface MediaDerivationRegistrar {
  registerDerivedPart(input: DerivedPartRegistration): Promise<string>;
  releaseDerivedPart(mediaId: string): Promise<void>;
}

export interface MediaDerivationLimits {
  readonly maxSourceDurationMs: number;
  readonly maxParts: number;
  readonly maxPartDurationMs: number;
  readonly maxPartBytes: number;
  readonly maxTotalOutputBytes: number;
  readonly maxWallClockMs: number;
  readonly maxConcurrentDerivations: number;
}

export const DEFAULT_MEDIA_DERIVATION_LIMITS: MediaDerivationLimits = deepFreeze({
  maxSourceDurationMs: 4 * 60 * 60 * 1_000,
  maxParts: 512,
  maxPartDurationMs: 10 * 60 * 1_000,
  maxPartBytes: 32 * 1_048_576,
  maxTotalOutputBytes: 512 * 1_048_576,
  maxWallClockMs: 10 * 60 * 1_000,
  maxConcurrentDerivations: 2,
});

export type MediaDerivationErrorCode =
  | "MEDIA_DERIVATION_OPERATION_UNSUPPORTED"
  | "MEDIA_DERIVATION_REQUEST_INVALID"
  | "MEDIA_DERIVATION_SOURCE_MISSING"
  | "MEDIA_DERIVATION_SOURCE_NOT_INSPECTED"
  | "MEDIA_DERIVATION_LIMIT_EXCEEDED"
  | "MEDIA_DERIVATION_TOOL_UNAVAILABLE"
  | "MEDIA_DERIVATION_TOOL_FAILED"
  | "MEDIA_DERIVATION_OUTPUT_INVALID"
  | "MEDIA_DERIVATION_TIMEOUT"
  | "MEDIA_DERIVATION_CANCELLED"
  | "MEDIA_DERIVATION_REGISTRATION_FAILED"
  | "MEDIA_DERIVATION_CONCURRENCY_EXCEEDED";

export class MediaDerivationError extends Error {
  constructor(
    readonly code: MediaDerivationErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "MediaDerivationError";
  }
}

export interface DerivedMediaPart {
  readonly index: number;
  readonly mediaId: string;
  readonly byteLength: number;
  readonly startMs?: number;
  readonly endMs?: number;
  readonly timestampMs?: number;
}

export interface MediaDerivationResult {
  readonly schemaVersion: "dolly.media-derivation-result/1";
  readonly derivationId: string;
  readonly sourceMediaId: string;
  readonly operation: MediaDerivationOperation;
  readonly outputMimeType: string;
  readonly toolchainId: string;
  readonly toolchainVersion: string;
  readonly parts: readonly DerivedMediaPart[];
}

export interface MediaDerivationPipelineOptions {
  readonly source: MediaDerivationSource;
  readonly registrar: MediaDerivationRegistrar;
  /** Defaults to a toolchain that always reports itself unavailable. */
  readonly toolchain?: MediaDerivationToolchain;
  readonly limits?: Partial<MediaDerivationLimits>;
}

function invalid(message: string, details: Readonly<Record<string, JsonValue>> = {}): MediaDerivationError {
  return new MediaDerivationError("MEDIA_DERIVATION_REQUEST_INVALID", message, details);
}

function limitExceeded(limit: string, allowed: number, observed: number): MediaDerivationError {
  return new MediaDerivationError(
    "MEDIA_DERIVATION_LIMIT_EXCEEDED",
    `Media derivation limit ${limit} exceeded`,
    { limit, allowed, observed },
  );
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw invalid(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function resolveLimits(overrides: Partial<MediaDerivationLimits> | undefined): MediaDerivationLimits {
  const limits = { ...DEFAULT_MEDIA_DERIVATION_LIMITS, ...(overrides ?? {}) };
  for (const [label, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw invalid(`media derivation ${label} must be a positive safe integer`);
    }
  }
  return deepFreeze(limits);
}

/**
 * The default boundary implementation. It is deliberately useless: an
 * unconfigured deployment must fail closed rather than appear to work.
 */
export function createUnavailableDerivationToolchain(
  reason = "No media derivation toolchain is configured",
): MediaDerivationToolchain {
  return {
    probe: async () => ({ available: false, reason }),
    run: async () => {
      throw new MediaDerivationError("MEDIA_DERIVATION_TOOL_UNAVAILABLE", reason);
    },
  };
}

/**
 * The FFmpeg-backed toolchain required by `media-derivation.md` Section 7.
 *
 * It is not implemented. This factory exists so that a caller that reaches for
 * it gets a definite, greppable failure instead of finding no symbol and
 * inventing an unbounded `child_process` call somewhere else.
 */
export function createFfmpegDerivationToolchain(): MediaDerivationToolchain {
  return createUnavailableDerivationToolchain(
    "FFmpeg media derivation is not implemented yet",
  );
}

function planAudioSplit(
  request: MediaDerivationRequest,
  parameters: AudioSplitParameters,
  source: MediaDerivationSourceDescription,
  limits: MediaDerivationLimits,
): MediaDerivationPlan {
  if (!source.mimeType.startsWith("audio/")) {
    throw invalid("audio.split requires audio Media", { mimeType: source.mimeType });
  }
  if (!SUPPORTED_AUDIO_OUTPUT_MIME_TYPES.includes(parameters.outputMimeType)) {
    throw invalid("audio.split requires an explicitly supported output MIME media type", {
      outputMimeType: parameters.outputMimeType,
    });
  }
  const durationMs = source.durationMs;
  if (durationMs === undefined || !Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new MediaDerivationError(
      "MEDIA_DERIVATION_SOURCE_NOT_INSPECTED",
      "audio.split requires an inspected source duration",
      { sourceMediaId: source.mediaId },
    );
  }
  if (durationMs > limits.maxSourceDurationMs) {
    throw limitExceeded("maxSourceDurationMs", limits.maxSourceDurationMs, durationMs);
  }

  const hasFixed = parameters.segmentDurationMs !== undefined;
  const hasRanges = parameters.ranges !== undefined;
  if (hasFixed === hasRanges) {
    throw invalid("audio.split requires exactly one of segmentDurationMs or ranges");
  }

  const ranges: AudioSplitRange[] = [];
  if (hasFixed) {
    const segmentDurationMs = positiveInteger(
      parameters.segmentDurationMs,
      "audio.split.segmentDurationMs",
    );
    const overlapMs =
      parameters.overlapMs === undefined
        ? 0
        : nonNegativeInteger(parameters.overlapMs, "audio.split.overlapMs");
    if (overlapMs >= segmentDurationMs) {
      throw invalid("audio.split.overlapMs must be smaller than segmentDurationMs");
    }
    const step = segmentDurationMs - overlapMs;
    // Count before materializing so an absurd request cannot allocate first.
    const count = Math.ceil(durationMs / step);
    if (count > limits.maxParts) {
      throw limitExceeded("maxParts", limits.maxParts, count);
    }
    for (let start = 0; start < durationMs; start += step) {
      ranges.push({ startMs: start, endMs: Math.min(start + segmentDurationMs, durationMs) });
    }
  } else {
    const explicit = parameters.ranges!;
    if (!Array.isArray(explicit) || explicit.length === 0) {
      throw invalid("audio.split.ranges must be a non-empty array");
    }
    if (parameters.overlapMs !== undefined) {
      throw invalid("audio.split.overlapMs is allowed only with segmentDurationMs");
    }
    if (explicit.length > limits.maxParts) {
      throw limitExceeded("maxParts", limits.maxParts, explicit.length);
    }
    let previousEnd = 0;
    for (const [index, range] of explicit.entries()) {
      const startMs = nonNegativeInteger(range?.startMs, `audio.split.ranges[${index}].startMs`);
      const endMs = positiveInteger(range?.endMs, `audio.split.ranges[${index}].endMs`);
      if (endMs <= startMs) {
        throw invalid(`audio.split.ranges[${index}] must have endMs greater than startMs`);
      }
      if (endMs > durationMs) {
        throw invalid(`audio.split.ranges[${index}] extends past the inspected duration`, {
          durationMs,
        });
      }
      if (index > 0 && startMs < previousEnd) {
        throw invalid(`audio.split.ranges[${index}] overlaps the previous range`);
      }
      previousEnd = endMs;
      ranges.push({ startMs, endMs });
    }
  }

  if (ranges.length > limits.maxParts) {
    throw limitExceeded("maxParts", limits.maxParts, ranges.length);
  }
  for (const range of ranges) {
    const partDurationMs = range.endMs - range.startMs;
    if (partDurationMs > limits.maxPartDurationMs) {
      throw limitExceeded("maxPartDurationMs", limits.maxPartDurationMs, partDurationMs);
    }
  }

  return deepFreeze({
    derivationId: request.derivationId,
    sourceMediaId: source.mediaId,
    operation: "audio.split" as const,
    outputMimeType: parameters.outputMimeType,
    parts: ranges.map((range, index) => ({
      kind: "audio-segment" as const,
      index,
      startMs: range.startMs,
      endMs: range.endMs,
    })),
  });
}

function planFrameExtraction(
  request: MediaDerivationRequest,
  parameters: VideoExtractFramesParameters,
  source: MediaDerivationSourceDescription,
  limits: MediaDerivationLimits,
): MediaDerivationPlan {
  if (!source.mimeType.startsWith("video/")) {
    throw invalid("video.extractFrames requires video Media", { mimeType: source.mimeType });
  }
  if (!SUPPORTED_FRAME_OUTPUT_MIME_TYPES.includes(parameters.outputMimeType)) {
    throw invalid(
      "video.extractFrames requires an explicitly supported still-image output MIME media type",
      { outputMimeType: parameters.outputMimeType },
    );
  }
  const durationMs = source.durationMs;
  if (durationMs === undefined || !Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new MediaDerivationError(
      "MEDIA_DERIVATION_SOURCE_NOT_INSPECTED",
      "video.extractFrames requires an inspected source duration",
      { sourceMediaId: source.mediaId },
    );
  }
  if (durationMs > limits.maxSourceDurationMs) {
    throw limitExceeded("maxSourceDurationMs", limits.maxSourceDurationMs, durationMs);
  }

  const hasTimestamps = parameters.timestampsMs !== undefined;
  const hasInterval = parameters.intervalMs !== undefined;
  if (hasTimestamps === hasInterval) {
    throw invalid("video.extractFrames requires exactly one of timestampsMs or intervalMs");
  }

  const timestamps: number[] = [];
  if (hasTimestamps) {
    const explicit = parameters.timestampsMs!;
    if (!Array.isArray(explicit) || explicit.length === 0) {
      throw invalid("video.extractFrames.timestampsMs must be a non-empty array");
    }
    if (explicit.length > limits.maxParts) {
      throw limitExceeded("maxParts", limits.maxParts, explicit.length);
    }
    let previous = -1;
    for (const [index, value] of explicit.entries()) {
      const timestampMs = nonNegativeInteger(
        value,
        `video.extractFrames.timestampsMs[${index}]`,
      );
      if (timestampMs >= durationMs) {
        throw invalid(
          `video.extractFrames.timestampsMs[${index}] is at or past the inspected duration`,
          { durationMs },
        );
      }
      if (timestampMs <= previous) {
        throw invalid("video.extractFrames.timestampsMs must strictly increase");
      }
      previous = timestampMs;
      timestamps.push(timestampMs);
    }
  } else {
    const intervalMs = positiveInteger(
      parameters.intervalMs,
      "video.extractFrames.intervalMs",
    );
    const requestedMax =
      parameters.maxFrames === undefined
        ? undefined
        : positiveInteger(parameters.maxFrames, "video.extractFrames.maxFrames");
    const count = Math.min(
      Math.ceil(durationMs / intervalMs),
      requestedMax ?? Number.MAX_SAFE_INTEGER,
    );
    if (count > limits.maxParts) {
      throw limitExceeded("maxParts", limits.maxParts, count);
    }
    for (let index = 0; index < count; index += 1) timestamps.push(index * intervalMs);
  }

  return deepFreeze({
    derivationId: request.derivationId,
    sourceMediaId: source.mediaId,
    operation: "video.extractFrames" as const,
    outputMimeType: parameters.outputMimeType,
    parts: timestamps.map((timestampMs, index) => ({
      kind: "video-frame" as const,
      index,
      timestampMs,
    })),
  });
}

/**
 * The all-or-nothing derivation pipeline.
 *
 * Ordering follows `media-derivation.md` Section 6: validate, plan, bound,
 * probe, run, then register in plan order. Any failure after the first
 * registration releases every part that was already registered, so a partial
 * product never becomes a visible result.
 */
export class MediaDerivationPipeline {
  readonly #source: MediaDerivationSource;
  readonly #registrar: MediaDerivationRegistrar;
  readonly #toolchain: MediaDerivationToolchain;
  readonly #limits: MediaDerivationLimits;
  #active = 0;

  constructor(options: MediaDerivationPipelineOptions) {
    this.#source = options.source;
    this.#registrar = options.registrar;
    this.#toolchain = options.toolchain ?? createUnavailableDerivationToolchain();
    this.#limits = resolveLimits(options.limits);
  }

  get limits(): MediaDerivationLimits {
    return this.#limits;
  }

  /** Exposed so a host can reject a plan without holding a concurrency slot. */
  async plan(request: MediaDerivationRequest): Promise<MediaDerivationPlan> {
    const source = await this.#describeSource(request.sourceMediaId);
    return this.#plan(request, source);
  }

  async derive(request: MediaDerivationRequest): Promise<MediaDerivationResult> {
    if (this.#active >= this.#limits.maxConcurrentDerivations) {
      throw new MediaDerivationError(
        "MEDIA_DERIVATION_CONCURRENCY_EXCEEDED",
        "Media derivation concurrency limit reached",
        { allowed: this.#limits.maxConcurrentDerivations },
      );
    }
    this.#active += 1;
    try {
      return await this.#derive(request);
    } finally {
      this.#active -= 1;
    }
  }

  async #describeSource(mediaId: string): Promise<MediaDerivationSourceDescription> {
    if (typeof mediaId !== "string" || mediaId.length === 0) {
      throw invalid("sourceMediaId must be a non-empty string");
    }
    const description = await this.#source.describe(mediaId);
    if (!description || description.mediaId !== mediaId) {
      throw new MediaDerivationError(
        "MEDIA_DERIVATION_SOURCE_MISSING",
        "Derivation source Media is unavailable",
        { sourceMediaId: mediaId },
      );
    }
    return description;
  }

  #plan(
    request: MediaDerivationRequest,
    source: MediaDerivationSourceDescription,
  ): MediaDerivationPlan {
    const parameters = request.parameters;
    if (typeof request.derivationId !== "string" || request.derivationId.length === 0) {
      throw invalid("derivationId must be a non-empty string");
    }
    if (!parameters || typeof parameters !== "object") {
      throw invalid("parameters must be an object");
    }
    if (parameters.operation === "audio.split") {
      return planAudioSplit(request, parameters, source, this.#limits);
    }
    if (parameters.operation === "video.extractFrames") {
      return planFrameExtraction(request, parameters, source, this.#limits);
    }
    throw new MediaDerivationError(
      "MEDIA_DERIVATION_OPERATION_UNSUPPORTED",
      "Unknown media derivation operation",
      { operation: String((parameters as { operation?: unknown }).operation) },
    );
  }

  async #derive(request: MediaDerivationRequest): Promise<MediaDerivationResult> {
    const source = await this.#describeSource(request.sourceMediaId);
    const plan = this.#plan(request, source);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#limits.maxWallClockMs);
    if (typeof timer.unref === "function") timer.unref();
    const onExternalAbort = (): void => controller.abort();
    request.signal?.addEventListener("abort", onExternalAbort, { once: true });

    const registered: string[] = [];
    try {
      if (request.signal?.aborted) throw this.#abortError(false);

      const probe = await this.#raceAbort(
        this.#toolchain.probe(controller.signal),
        controller,
        () => timedOut,
      );
      if (!probe.available) {
        // Fail closed: no registration, no fallback to the source, and no
        // silently shortened result.
        throw new MediaDerivationError(
          "MEDIA_DERIVATION_TOOL_UNAVAILABLE",
          "Media derivation toolchain is unavailable",
          { reason: probe.reason },
        );
      }

      let produced: readonly ProducedMediaPart[];
      try {
        produced = await this.#raceAbort(
          this.#toolchain.run({ plan, source, signal: controller.signal }),
          controller,
          () => timedOut,
        );
      } catch (error) {
        if (error instanceof MediaDerivationError) throw error;
        throw new MediaDerivationError(
          "MEDIA_DERIVATION_TOOL_FAILED",
          "Media derivation toolchain failed",
          { derivationId: plan.derivationId },
        );
      }

      const parts = await this.#registerParts(plan, produced, registered, controller.signal);
      return deepFreeze({
        schemaVersion: "dolly.media-derivation-result/1" as const,
        derivationId: plan.derivationId,
        sourceMediaId: plan.sourceMediaId,
        operation: plan.operation,
        outputMimeType: plan.outputMimeType,
        toolchainId: probe.toolchainId,
        toolchainVersion: probe.version,
        parts,
      });
    } catch (error) {
      const failure =
        error instanceof MediaDerivationError
          ? error
          : new MediaDerivationError(
              "MEDIA_DERIVATION_TOOL_FAILED",
              "Media derivation failed",
              { derivationId: request.derivationId },
            );
      const releaseFailures = await this.#releaseAll(registered);
      if (releaseFailures.length === 0) throw failure;
      // Section 7 requires a failed cleanup to stay visible, so the release
      // failure travels with the original error instead of replacing it.
      throw new MediaDerivationError(failure.code, failure.message, {
        ...failure.details,
        releaseFailures,
      });
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  /**
   * Bounds a toolchain call even when the toolchain ignores its signal. A
   * hung external process must not hold the derivation open forever.
   */
  async #raceAbort<T>(
    operation: Promise<T>,
    controller: AbortController,
    isTimeout: () => boolean,
  ): Promise<T> {
    if (controller.signal.aborted) throw this.#abortError(isTimeout());
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(this.#abortError(isTimeout()));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      // A toolchain that never settles must not surface an unhandled rejection.
      void operation.catch(() => undefined);
    }
  }

  #abortError(timedOut: boolean): MediaDerivationError {
    return timedOut
      ? new MediaDerivationError(
          "MEDIA_DERIVATION_TIMEOUT",
          "Media derivation exceeded its wall-clock bound",
          { maxWallClockMs: this.#limits.maxWallClockMs },
        )
      : new MediaDerivationError(
          "MEDIA_DERIVATION_CANCELLED",
          "Media derivation was cancelled",
        );
  }

  async #registerParts(
    plan: MediaDerivationPlan,
    produced: readonly ProducedMediaPart[],
    registered: string[],
    signal: AbortSignal,
  ): Promise<readonly DerivedMediaPart[]> {
    if (!Array.isArray(produced) || produced.length !== plan.parts.length) {
      throw new MediaDerivationError(
        "MEDIA_DERIVATION_OUTPUT_INVALID",
        "Media derivation toolchain produced a different number of parts than planned",
        {
          planned: plan.parts.length,
          produced: Array.isArray(produced) ? produced.length : -1,
        },
      );
    }
    const byIndex = new Map<number, ProducedMediaPart>();
    for (const part of produced) {
      if (!part || !Number.isSafeInteger(part.index) || byIndex.has(part.index)) {
        throw new MediaDerivationError(
          "MEDIA_DERIVATION_OUTPUT_INVALID",
          "Media derivation toolchain produced a duplicate or unusable part index",
        );
      }
      byIndex.set(part.index, part);
    }

    const results: DerivedMediaPart[] = [];
    let totalBytes = 0;
    for (const planned of plan.parts) {
      const part = byIndex.get(planned.index);
      if (!part) {
        throw new MediaDerivationError(
          "MEDIA_DERIVATION_OUTPUT_INVALID",
          "Media derivation toolchain omitted a planned part",
          { index: planned.index },
        );
      }
      if (part.mimeType !== plan.outputMimeType) {
        throw new MediaDerivationError(
          "MEDIA_DERIVATION_OUTPUT_INVALID",
          "Media derivation part has an unexpected MIME media type",
          { index: planned.index, expected: plan.outputMimeType, observed: String(part.mimeType) },
        );
      }
      if (!(part.bytes instanceof Uint8Array) || part.bytes.byteLength === 0) {
        throw new MediaDerivationError(
          "MEDIA_DERIVATION_OUTPUT_INVALID",
          "Media derivation part is empty",
          { index: planned.index },
        );
      }
      if (planned.kind === "audio-segment") {
        if (part.startMs !== planned.startMs || part.endMs !== planned.endMs) {
          throw new MediaDerivationError(
            "MEDIA_DERIVATION_OUTPUT_INVALID",
            "Media derivation part timing disagrees with the plan",
            { index: planned.index },
          );
        }
      } else if (part.timestampMs !== planned.timestampMs) {
        throw new MediaDerivationError(
          "MEDIA_DERIVATION_OUTPUT_INVALID",
          "Media derivation frame timestamp disagrees with the plan",
          { index: planned.index },
        );
      }
      if (part.bytes.byteLength > this.#limits.maxPartBytes) {
        throw limitExceeded("maxPartBytes", this.#limits.maxPartBytes, part.bytes.byteLength);
      }
      totalBytes += part.bytes.byteLength;
      if (totalBytes > this.#limits.maxTotalOutputBytes) {
        throw limitExceeded("maxTotalOutputBytes", this.#limits.maxTotalOutputBytes, totalBytes);
      }

      let mediaId: string;
      try {
        mediaId = await this.#registrar.registerDerivedPart({
          derivationId: plan.derivationId,
          sourceMediaId: plan.sourceMediaId,
          index: planned.index,
          bytes: part.bytes,
          mimeType: plan.outputMimeType,
          signal,
        });
      } catch {
        throw new MediaDerivationError(
          "MEDIA_DERIVATION_REGISTRATION_FAILED",
          "Media derivation part registration failed",
          { index: planned.index },
        );
      }
      if (typeof mediaId !== "string" || mediaId.length === 0) {
        throw new MediaDerivationError(
          "MEDIA_DERIVATION_REGISTRATION_FAILED",
          "Media derivation part registration returned no Media identifier",
          { index: planned.index },
        );
      }
      registered.push(mediaId);
      results.push({
        index: planned.index,
        mediaId,
        byteLength: part.bytes.byteLength,
        ...(planned.kind === "audio-segment"
          ? { startMs: planned.startMs, endMs: planned.endMs }
          : { timestampMs: planned.timestampMs }),
      });
    }
    return results;
  }

  async #releaseAll(registered: readonly string[]): Promise<string[]> {
    const failures: string[] = [];
    for (const mediaId of registered) {
      try {
        await this.#registrar.releaseDerivedPart(mediaId);
      } catch {
        failures.push(mediaId);
      }
    }
    return failures;
  }
}
