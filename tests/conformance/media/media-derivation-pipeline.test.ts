import { describe, expect, it } from "vitest";
import {
  createFfmpegDerivationToolchain,
  createUnavailableDerivationToolchain,
  MediaDerivationPipeline,
  type DerivedPartRegistration,
  type MediaDerivationLimits,
  type MediaDerivationParameters,
  type MediaDerivationRegistrar,
  type MediaDerivationSource,
  type MediaDerivationSourceDescription,
  type MediaDerivationToolchain,
  type MediaDerivationToolchainRunInput,
  type PlannedMediaPart,
  type ProducedMediaPart,
} from "../../../src/core/media-capability/media-derivation.js";

const AUDIO_SOURCE: MediaDerivationSourceDescription = {
  mediaId: "media-audio",
  mimeType: "audio/mpeg",
  byteLength: 100_000,
  durationMs: 10_000,
};

const VIDEO_SOURCE: MediaDerivationSourceDescription = {
  mediaId: "media-video",
  mimeType: "video/mp4",
  byteLength: 900_000,
  durationMs: 10_000,
};

/** Audio Media whose bounded inspector could not determine a duration. */
const UNINSPECTED_SOURCE: MediaDerivationSourceDescription = {
  mediaId: "media-unknown-duration",
  mimeType: "audio/mpeg",
  byteLength: 100_000,
};

function createSource(
  ...descriptions: readonly MediaDerivationSourceDescription[]
): MediaDerivationSource {
  const items = new Map(descriptions.map((item) => [item.mediaId, item]));
  return { describe: (mediaId) => items.get(mediaId) ?? null };
}

interface FakeRegistrar extends MediaDerivationRegistrar {
  readonly registered: string[];
  readonly released: string[];
}

function createRegistrar(
  options: { readonly failAtIndex?: number; readonly failRelease?: boolean } = {},
): FakeRegistrar {
  const registered: string[] = [];
  const released: string[] = [];
  return {
    registered,
    released,
    async registerDerivedPart(input: DerivedPartRegistration): Promise<string> {
      if (options.failAtIndex === input.index) {
        throw new Error("derived part registration failed");
      }
      const mediaId = `media-derived-${input.derivationId}-${input.index}`;
      registered.push(mediaId);
      return mediaId;
    },
    async releaseDerivedPart(mediaId: string): Promise<void> {
      if (options.failRelease === true) throw new Error("release failed");
      released.push(mediaId);
    },
  };
}

interface FakeToolchain extends MediaDerivationToolchain {
  readonly probeCalls: number[];
  readonly runCalls: MediaDerivationToolchainRunInput[];
}

function partFor(planned: PlannedMediaPart, bytes: Uint8Array, mimeType: string): ProducedMediaPart {
  return {
    index: planned.index,
    bytes,
    mimeType,
    ...(planned.kind === "audio-segment"
      ? { startMs: planned.startMs, endMs: planned.endMs }
      : { timestampMs: planned.timestampMs }),
  };
}

/** A toolchain double that produces exactly what the plan asked for. */
function createToolchain(
  options: {
    readonly bytesFor?: (planned: PlannedMediaPart) => Uint8Array;
    readonly mimeTypeFor?: (planned: PlannedMediaPart, planned2: string) => string;
    readonly transform?: (
      parts: readonly ProducedMediaPart[],
    ) => readonly ProducedMediaPart[];
  } = {},
): FakeToolchain {
  const probeCalls: number[] = [];
  const runCalls: MediaDerivationToolchainRunInput[] = [];
  return {
    probeCalls,
    runCalls,
    async probe() {
      probeCalls.push(probeCalls.length);
      return { available: true, toolchainId: "fake-ffmpeg", version: "0.0.0-test" };
    },
    async run(input: MediaDerivationToolchainRunInput) {
      runCalls.push(input);
      const parts = input.plan.parts.map((planned) =>
        partFor(
          planned,
          options.bytesFor?.(planned) ?? new Uint8Array(64).fill(planned.index + 1),
          options.mimeTypeFor?.(planned, input.plan.outputMimeType) ??
            input.plan.outputMimeType,
        ),
      );
      return options.transform ? options.transform(parts) : parts;
    },
  };
}

const AUDIO_SPLIT: MediaDerivationParameters = {
  operation: "audio.split",
  outputMimeType: "audio/wav",
  segmentDurationMs: 4_000,
};

const FRAME_EXTRACT: MediaDerivationParameters = {
  operation: "video.extractFrames",
  outputMimeType: "image/png",
  intervalMs: 2_500,
};

function createPipeline(
  options: {
    readonly toolchain?: MediaDerivationToolchain;
    readonly registrar?: FakeRegistrar;
    readonly limits?: Partial<MediaDerivationLimits>;
    readonly source?: MediaDerivationSource;
  } = {},
): { pipeline: MediaDerivationPipeline; registrar: FakeRegistrar } {
  const registrar = options.registrar ?? createRegistrar();
  const pipeline = new MediaDerivationPipeline({
    source: options.source ?? createSource(AUDIO_SOURCE, VIDEO_SOURCE, UNINSPECTED_SOURCE),
    registrar,
    ...(options.toolchain === undefined ? {} : { toolchain: options.toolchain }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  return { pipeline, registrar };
}

describe("Media derivation planning", () => {
  it("plans consecutive audio segments without calling the toolchain", async () => {
    const toolchain = createToolchain();
    const { pipeline } = createPipeline({ toolchain });

    const plan = await pipeline.plan({
      derivationId: "derivation-1",
      sourceMediaId: "media-audio",
      parameters: AUDIO_SPLIT,
    });
    expect(plan.parts).toEqual([
      { kind: "audio-segment", index: 0, startMs: 0, endMs: 4_000 },
      { kind: "audio-segment", index: 1, startMs: 4_000, endMs: 8_000 },
      { kind: "audio-segment", index: 2, startMs: 8_000, endMs: 10_000 },
    ]);
    expect(toolchain.probeCalls).toEqual([]);
    expect(toolchain.runCalls).toEqual([]);
  });

  it("plans video frames at a fixed interval", async () => {
    const { pipeline } = createPipeline({ toolchain: createToolchain() });

    const plan = await pipeline.plan({
      derivationId: "derivation-2",
      sourceMediaId: "media-video",
      parameters: FRAME_EXTRACT,
    });
    expect(plan.parts.map((part) => (part.kind === "video-frame" ? part.timestampMs : -1))).toEqual(
      [0, 2_500, 5_000, 7_500],
    );
  });

  it("rejects an unknown operation before any toolchain call", async () => {
    const toolchain = createToolchain();
    const { pipeline, registrar } = createPipeline({ toolchain });

    await expect(
      pipeline.derive({
        derivationId: "derivation-3",
        sourceMediaId: "media-audio",
        parameters: { operation: "audio.transcode" } as unknown as MediaDerivationParameters,
      }),
    ).rejects.toMatchObject({
      name: "MediaDerivationError",
      code: "MEDIA_DERIVATION_OPERATION_UNSUPPORTED",
    });
    expect(toolchain.probeCalls).toEqual([]);
    expect(registrar.registered).toEqual([]);
  });

  it("rejects a missing source and a source with no inspected duration", async () => {
    const toolchain = createToolchain();
    const { pipeline } = createPipeline({ toolchain });

    await expect(
      pipeline.derive({
        derivationId: "derivation-4",
        sourceMediaId: "media-absent",
        parameters: AUDIO_SPLIT,
      }),
    ).rejects.toMatchObject({ code: "MEDIA_DERIVATION_SOURCE_MISSING" });
    await expect(
      pipeline.derive({
        derivationId: "derivation-5",
        sourceMediaId: "media-unknown-duration",
        parameters: AUDIO_SPLIT,
      }),
    ).rejects.toMatchObject({ code: "MEDIA_DERIVATION_SOURCE_NOT_INSPECTED" });
    expect(toolchain.probeCalls).toEqual([]);
  });

  const invalidRequests: readonly {
    readonly name: string;
    readonly sourceMediaId: string;
    readonly parameters: MediaDerivationParameters;
  }[] = [
    {
      name: "an audio operation on video Media",
      sourceMediaId: "media-video",
      parameters: AUDIO_SPLIT,
    },
    {
      name: "an unsupported audio output type",
      sourceMediaId: "media-audio",
      parameters: {
        operation: "audio.split",
        outputMimeType: "audio/x-invented",
        segmentDurationMs: 4_000,
      },
    },
    {
      name: "neither segmentDurationMs nor ranges",
      sourceMediaId: "media-audio",
      parameters: { operation: "audio.split", outputMimeType: "audio/wav" },
    },
    {
      name: "both segmentDurationMs and ranges",
      sourceMediaId: "media-audio",
      parameters: {
        operation: "audio.split",
        outputMimeType: "audio/wav",
        segmentDurationMs: 1_000,
        ranges: [{ startMs: 0, endMs: 1_000 }],
      },
    },
    {
      name: "an overlap that is not smaller than the segment",
      sourceMediaId: "media-audio",
      parameters: {
        operation: "audio.split",
        outputMimeType: "audio/wav",
        segmentDurationMs: 1_000,
        overlapMs: 1_000,
      },
    },
    {
      name: "an inverted explicit range",
      sourceMediaId: "media-audio",
      parameters: {
        operation: "audio.split",
        outputMimeType: "audio/wav",
        ranges: [{ startMs: 5_000, endMs: 4_000 }],
      },
    },
    {
      name: "an explicit range past the inspected duration",
      sourceMediaId: "media-audio",
      parameters: {
        operation: "audio.split",
        outputMimeType: "audio/wav",
        ranges: [{ startMs: 0, endMs: 12_000 }],
      },
    },
    {
      name: "overlapping explicit ranges",
      sourceMediaId: "media-audio",
      parameters: {
        operation: "audio.split",
        outputMimeType: "audio/wav",
        ranges: [
          { startMs: 0, endMs: 4_000 },
          { startMs: 3_000, endMs: 6_000 },
        ],
      },
    },
    {
      name: "an unsupported frame output type",
      sourceMediaId: "media-video",
      parameters: {
        operation: "video.extractFrames",
        outputMimeType: "video/mp4",
        intervalMs: 1_000,
      },
    },
    {
      name: "timestamps that do not strictly increase",
      sourceMediaId: "media-video",
      parameters: {
        operation: "video.extractFrames",
        outputMimeType: "image/png",
        timestampsMs: [1_000, 1_000],
      },
    },
    {
      name: "a timestamp at the inspected duration",
      sourceMediaId: "media-video",
      parameters: {
        operation: "video.extractFrames",
        outputMimeType: "image/png",
        timestampsMs: [10_000],
      },
    },
  ];

  for (const invalid of invalidRequests) {
    it(`rejects ${invalid.name}`, async () => {
      const toolchain = createToolchain();
      const { pipeline, registrar } = createPipeline({ toolchain });

      await expect(
        pipeline.derive({
          derivationId: "derivation-invalid",
          sourceMediaId: invalid.sourceMediaId,
          parameters: invalid.parameters,
        }),
      ).rejects.toMatchObject({ code: "MEDIA_DERIVATION_REQUEST_INVALID" });
      expect(toolchain.probeCalls).toEqual([]);
      expect(registrar.registered).toEqual([]);
    });
  }

  it("rejects a plan that exceeds a limit before the toolchain runs", async () => {
    const cases = [
      { limits: { maxSourceDurationMs: 5_000 }, limit: "maxSourceDurationMs", allowed: 5_000 },
      { limits: { maxParts: 2 }, limit: "maxParts", allowed: 2 },
      { limits: { maxPartDurationMs: 3_000 }, limit: "maxPartDurationMs", allowed: 3_000 },
    ] as const;

    for (const testCase of cases) {
      const toolchain = createToolchain();
      const { pipeline, registrar } = createPipeline({
        toolchain,
        limits: testCase.limits,
      });
      await expect(
        pipeline.derive({
          derivationId: "derivation-limit",
          sourceMediaId: "media-audio",
          parameters: AUDIO_SPLIT,
        }),
      ).rejects.toMatchObject({
        code: "MEDIA_DERIVATION_LIMIT_EXCEEDED",
        details: { limit: testCase.limit, allowed: testCase.allowed },
      });
      expect(toolchain.probeCalls).toEqual([]);
      expect(registrar.registered).toEqual([]);
    }
  });
});

describe("Media derivation fails closed without a toolchain", () => {
  it("refuses every derivation when no toolchain is configured", async () => {
    const { pipeline, registrar } = createPipeline();

    await expect(
      pipeline.derive({
        derivationId: "derivation-6",
        sourceMediaId: "media-audio",
        parameters: AUDIO_SPLIT,
      }),
    ).rejects.toMatchObject({
      code: "MEDIA_DERIVATION_TOOL_UNAVAILABLE",
      details: { reason: "No media derivation toolchain is configured" },
    });
    // No fallback to the source and no partial product.
    expect(registrar.registered).toEqual([]);
    expect(registrar.released).toEqual([]);
  });

  it("reports the FFmpeg toolchain as not implemented rather than pretending to work", async () => {
    const { pipeline } = createPipeline({ toolchain: createFfmpegDerivationToolchain() });

    await expect(
      pipeline.derive({
        derivationId: "derivation-7",
        sourceMediaId: "media-audio",
        parameters: AUDIO_SPLIT,
      }),
    ).rejects.toMatchObject({
      code: "MEDIA_DERIVATION_TOOL_UNAVAILABLE",
      details: { reason: "FFmpeg media derivation is not implemented yet" },
    });
  });

  it("refuses a derivation when the probe reports the tool unhealthy", async () => {
    const toolchain: MediaDerivationToolchain = {
      ...createUnavailableDerivationToolchain("ffmpeg exited with status 127"),
      run: async () => {
        throw new Error("run must not be reached");
      },
    };
    const { pipeline, registrar } = createPipeline({ toolchain });

    await expect(
      pipeline.derive({
        derivationId: "derivation-8",
        sourceMediaId: "media-video",
        parameters: FRAME_EXTRACT,
      }),
    ).rejects.toMatchObject({
      code: "MEDIA_DERIVATION_TOOL_UNAVAILABLE",
      details: { reason: "ffmpeg exited with status 127" },
    });
    expect(registrar.registered).toEqual([]);
  });
});

describe("Media derivation all-or-nothing sequencing", () => {
  it("registers every planned part as a new Media identity", async () => {
    const toolchain = createToolchain();
    const { pipeline, registrar } = createPipeline({ toolchain });

    const result = await pipeline.derive({
      derivationId: "derivation-ok",
      sourceMediaId: "media-audio",
      parameters: AUDIO_SPLIT,
    });
    expect(result).toMatchObject({
      schemaVersion: "dolly.media-derivation-result/1",
      sourceMediaId: "media-audio",
      operation: "audio.split",
      outputMimeType: "audio/wav",
      toolchainId: "fake-ffmpeg",
      toolchainVersion: "0.0.0-test",
    });
    expect(result.parts).toEqual([
      { index: 0, mediaId: "media-derived-derivation-ok-0", byteLength: 64, startMs: 0, endMs: 4_000 },
      { index: 1, mediaId: "media-derived-derivation-ok-1", byteLength: 64, startMs: 4_000, endMs: 8_000 },
      { index: 2, mediaId: "media-derived-derivation-ok-2", byteLength: 64, startMs: 8_000, endMs: 10_000 },
    ]);
    // Each part is a distinct identity, and none of them is the source.
    const ids = result.parts.map((part) => part.mediaId);
    expect(new Set(ids).size).toBe(3);
    expect(ids).not.toContain("media-audio");
    expect(registrar.released).toEqual([]);
  });

  it("extracts video frames with their planned timestamps", async () => {
    const { pipeline } = createPipeline({ toolchain: createToolchain() });

    const result = await pipeline.derive({
      derivationId: "derivation-frames",
      sourceMediaId: "media-video",
      parameters: {
        operation: "video.extractFrames",
        outputMimeType: "image/jpeg",
        timestampsMs: [0, 5_000],
      },
    });
    expect(result.parts).toEqual([
      { index: 0, mediaId: "media-derived-derivation-frames-0", byteLength: 64, timestampMs: 0 },
      { index: 1, mediaId: "media-derived-derivation-frames-1", byteLength: 64, timestampMs: 5_000 },
    ]);
  });

  const badOutputs: readonly {
    readonly name: string;
    readonly transform: (parts: readonly ProducedMediaPart[]) => readonly ProducedMediaPart[];
  }[] = [
    { name: "fewer parts than planned", transform: (parts) => parts.slice(0, 2) },
    { name: "more parts than planned", transform: (parts) => [...parts, parts[0]!] },
    {
      name: "a duplicate part index",
      transform: (parts) => [parts[0]!, parts[0]!, parts[2]!],
    },
    {
      name: "an empty part",
      transform: (parts) => parts.map((part, index) =>
        index === 1 ? { ...part, bytes: new Uint8Array(0) } : part,
      ),
    },
    {
      name: "audio timing that disagrees with the plan",
      transform: (parts) => parts.map((part, index) =>
        index === 2 ? { ...part, endMs: (part.endMs ?? 0) + 1 } : part,
      ),
    },
  ];

  for (const badOutput of badOutputs) {
    it(`fails the whole derivation on ${badOutput.name}`, async () => {
      const toolchain = createToolchain({ transform: badOutput.transform });
      const { pipeline, registrar } = createPipeline({ toolchain });

      await expect(
        pipeline.derive({
          derivationId: "derivation-bad",
          sourceMediaId: "media-audio",
          parameters: AUDIO_SPLIT,
        }),
      ).rejects.toMatchObject({ code: "MEDIA_DERIVATION_OUTPUT_INVALID" });
      // Whatever was registered before the failure is released again.
      expect(registrar.released).toEqual(registrar.registered);
    });
  }

  it("fails the whole derivation when a part has the wrong MIME media type", async () => {
    const toolchain = createToolchain({ mimeTypeFor: () => "audio/x-wrong" });
    const { pipeline, registrar } = createPipeline({ toolchain });

    await expect(
      pipeline.derive({
        derivationId: "derivation-mime",
        sourceMediaId: "media-audio",
        parameters: AUDIO_SPLIT,
      }),
    ).rejects.toMatchObject({
      code: "MEDIA_DERIVATION_OUTPUT_INVALID",
      details: { index: 0, expected: "audio/wav", observed: "audio/x-wrong" },
    });
    expect(registrar.registered).toEqual([]);
  });

  it("releases already registered parts when a later part exceeds maxPartBytes", async () => {
    const toolchain = createToolchain({
      bytesFor: (planned) => new Uint8Array(planned.index === 2 ? 5_000 : 100),
    });
    const { pipeline, registrar } = createPipeline({
      toolchain,
      limits: { maxPartBytes: 1_000 },
    });

    await expect(
      pipeline.derive({
        derivationId: "derivation-big",
        sourceMediaId: "media-audio",
        parameters: AUDIO_SPLIT,
      }),
    ).rejects.toMatchObject({
      code: "MEDIA_DERIVATION_LIMIT_EXCEEDED",
      details: { limit: "maxPartBytes", allowed: 1_000, observed: 5_000 },
    });
    expect(registrar.registered).toEqual([
      "media-derived-derivation-big-0",
      "media-derived-derivation-big-1",
    ]);
    expect(registrar.released).toEqual(registrar.registered);
  });

  it("releases already registered parts when the total output budget is spent", async () => {
    const toolchain = createToolchain({ bytesFor: () => new Uint8Array(1_000) });
    const { pipeline, registrar } = createPipeline({
      toolchain,
      limits: { maxTotalOutputBytes: 1_500 },
    });

    await expect(
      pipeline.derive({
        derivationId: "derivation-total",
        sourceMediaId: "media-audio",
        parameters: AUDIO_SPLIT,
      }),
    ).rejects.toMatchObject({
      code: "MEDIA_DERIVATION_LIMIT_EXCEEDED",
      details: { limit: "maxTotalOutputBytes", allowed: 1_500, observed: 2_000 },
    });
    expect(registrar.registered).toEqual(["media-derived-derivation-total-0"]);
    expect(registrar.released).toEqual(["media-derived-derivation-total-0"]);
  });

  it("releases earlier parts when registration of a later part fails", async () => {
    const registrar = createRegistrar({ failAtIndex: 2 });
    const { pipeline } = createPipeline({ toolchain: createToolchain(), registrar });

    await expect(
      pipeline.derive({
        derivationId: "derivation-reg",
        sourceMediaId: "media-audio",
        parameters: AUDIO_SPLIT,
      }),
    ).rejects.toMatchObject({
      code: "MEDIA_DERIVATION_REGISTRATION_FAILED",
      details: { index: 2 },
    });
    expect(registrar.registered).toEqual([
      "media-derived-derivation-reg-0",
      "media-derived-derivation-reg-1",
    ]);
    expect(registrar.released).toEqual(registrar.registered);
  });

  it("keeps a failed cleanup visible alongside the original failure", async () => {
    const registrar = createRegistrar({ failAtIndex: 2, failRelease: true });
    const { pipeline } = createPipeline({ toolchain: createToolchain(), registrar });

    await expect(
      pipeline.derive({
        derivationId: "derivation-cleanup",
        sourceMediaId: "media-audio",
        parameters: AUDIO_SPLIT,
      }),
    ).rejects.toMatchObject({
      code: "MEDIA_DERIVATION_REGISTRATION_FAILED",
      details: {
        index: 2,
        releaseFailures: [
          "media-derived-derivation-cleanup-0",
          "media-derived-derivation-cleanup-1",
        ],
      },
    });
    expect(registrar.released).toEqual([]);
  });

  it("reports a toolchain error as a definite failure", async () => {
    const toolchain: MediaDerivationToolchain = {
      probe: async () => ({ available: true, toolchainId: "fake-ffmpeg", version: "0" }),
      run: async () => {
        throw new Error("ffmpeg wrote a truncated container");
      },
    };
    const { pipeline, registrar } = createPipeline({ toolchain });

    await expect(
      pipeline.derive({
        derivationId: "derivation-toolfail",
        sourceMediaId: "media-audio",
        parameters: AUDIO_SPLIT,
      }),
    ).rejects.toMatchObject({ code: "MEDIA_DERIVATION_TOOL_FAILED" });
    expect(registrar.registered).toEqual([]);
  });
});

describe("Media derivation bounds and cancellation", () => {
  function hangingToolchain(): {
    readonly toolchain: MediaDerivationToolchain;
    readonly started: Promise<void>;
  } {
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const toolchain: MediaDerivationToolchain = {
      probe: async () => ({ available: true, toolchainId: "fake-ffmpeg", version: "0" }),
      run: () => {
        signalStarted();
        // A toolchain that ignores its signal must still be bounded.
        return new Promise<never>(() => undefined);
      },
    };
    return { toolchain, started };
  }

  it("times out a toolchain run that never finishes", async () => {
    const { toolchain } = hangingToolchain();
    const { pipeline, registrar } = createPipeline({
      toolchain,
      limits: { maxWallClockMs: 25 },
    });

    await expect(
      pipeline.derive({
        derivationId: "derivation-timeout",
        sourceMediaId: "media-audio",
        parameters: AUDIO_SPLIT,
      }),
    ).rejects.toMatchObject({
      code: "MEDIA_DERIVATION_TIMEOUT",
      details: { maxWallClockMs: 25 },
    });
    expect(registrar.registered).toEqual([]);
  });

  it("treats cancellation as a failure rather than a partial success", async () => {
    const { toolchain, started } = hangingToolchain();
    const { pipeline, registrar } = createPipeline({ toolchain });
    const controller = new AbortController();

    const derivation = pipeline.derive({
      derivationId: "derivation-cancel",
      sourceMediaId: "media-audio",
      parameters: AUDIO_SPLIT,
      signal: controller.signal,
    });
    await started;
    controller.abort();

    await expect(derivation).rejects.toMatchObject({
      code: "MEDIA_DERIVATION_CANCELLED",
    });
    expect(registrar.registered).toEqual([]);
  });

  it("rejects a derivation that would exceed the concurrency limit", async () => {
    const { toolchain, started } = hangingToolchain();
    const { pipeline } = createPipeline({
      toolchain,
      limits: { maxConcurrentDerivations: 1, maxWallClockMs: 50 },
    });

    const first = pipeline.derive({
      derivationId: "derivation-slot-1",
      sourceMediaId: "media-audio",
      parameters: AUDIO_SPLIT,
    });
    await started;

    await expect(
      pipeline.derive({
        derivationId: "derivation-slot-2",
        sourceMediaId: "media-audio",
        parameters: AUDIO_SPLIT,
      }),
    ).rejects.toMatchObject({
      code: "MEDIA_DERIVATION_CONCURRENCY_EXCEEDED",
      details: { allowed: 1 },
    });

    await expect(first).rejects.toMatchObject({ code: "MEDIA_DERIVATION_TIMEOUT" });
    // The slot is returned once the first derivation finishes failing.
    await expect(
      pipeline.derive({
        derivationId: "derivation-slot-3",
        sourceMediaId: "media-audio",
        parameters: AUDIO_SPLIT,
      }),
    ).rejects.toMatchObject({ code: "MEDIA_DERIVATION_TIMEOUT" });
  });
});
