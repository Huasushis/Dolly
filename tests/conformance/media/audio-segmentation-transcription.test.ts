import { describe, expect, it } from "vitest";
import {
  AudioSegmentationError,
  AudioSegmenter,
  AudioTranscriptionPipeline,
  DeterministicTranscriber,
  type AudioSegmentationOptions,
} from "../../../src/core/media-audio/index.js";

// Monophonic 16-bit PCM at 1 kHz: 2 bytes per frame, 1000 frames per second,
// so 2000 bytes are exactly one second and every millisecond is one frame.
const FORMAT = { sampleRate: 1000, bytesPerSample: 2, channels: 1 } as const;

function options(overrides: Partial<AudioSegmentationOptions> = {}): AudioSegmentationOptions {
  return {
    format: FORMAT,
    segmentDurationMs: 1000,
    overlapMs: 0,
    maxSegments: 16,
    ...overrides,
  };
}

function makePcm(frameCount: number, seed = 7): Uint8Array {
  const input = new Uint8Array(frameCount * 2);
  for (let i = 0; i < input.length; i++) {
    input[i] = (i * seed + 3) & 0xff;
  }
  return input;
}

function expectSegmentationError(fn: () => unknown, code: string): void {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error, `expected error code ${code}`).toBeInstanceOf(AudioSegmentationError);
  expect((error as AudioSegmentationError).code).toBe(code);
}

describe("AudioSegmenter segmentation", () => {
  it("is deterministic given the same input and options", () => {
    const input = makePcm(5000);
    const first = new AudioSegmenter(options()).segment(input);
    const second = new AudioSegmenter(options()).segment(input);

    expect(first).toEqual(second);
    // Byte content is preserved per segment and shares the input buffer (no copy).
    for (const segment of first) {
      expect(segment.data.buffer).toBe(input.buffer);
      expect(segment.data).toEqual(input.subarray(segment.startByte, segment.endByte));
    }
  });

  it("produces different segments for different input", () => {
    const a = new AudioSegmenter(options()).segment(makePcm(5000, 7));
    const b = new AudioSegmenter(options()).segment(makePcm(5000, 11));
    // Byte offsets are identical (same length); the audio content differs.
    expect(a.map((s) => Array.from(s.data))).not.toEqual(b.map((s) => Array.from(s.data)));
  });

  it("rejects an empty buffer", () => {
    const segmenter = new AudioSegmenter(options());
    expectSegmentationError(
      () => segmenter.segment(new Uint8Array(0)),
      "AUDIO_SEGMENTATION_BUFFER_EMPTY",
    );
    // A single trailing byte is not a complete 2-byte sample frame.
    expectSegmentationError(
      () => segmenter.segment(new Uint8Array(1)),
      "AUDIO_SEGMENTATION_BUFFER_EMPTY",
    );
  });

  it("rejects a buffer shorter than one segment", () => {
    const segmenter = new AudioSegmenter(options());
    // 500 frames are complete but fewer than the 1000-frame segment.
    expectSegmentationError(
      () => segmenter.segment(makePcm(500)),
      "AUDIO_SEGMENTATION_BUFFER_TOO_SHORT",
    );
  });

  it("splits an exactly-fitting buffer into one full segment", () => {
    const input = makePcm(1000); // exactly one segment
    const segments = new AudioSegmenter(options()).segment(input);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      index: 0,
      startByte: 0,
      endByte: 2000,
      startMs: 0,
      endMs: 1000,
    });
    expect(segments[0]!.data).toEqual(input);
  });

  it("enforces the max segment count: allowed at the boundary, rejected above it", () => {
    const input = makePcm(5000); // 5 non-overlapping one-second segments
    expect(new AudioSegmenter(options({ maxSegments: 5 })).segment(input)).toHaveLength(5);
    expectSegmentationError(
      () => new AudioSegmenter(options({ maxSegments: 4 })).segment(input),
      "AUDIO_SEGMENTATION_SEGMENT_COUNT_EXCEEDED",
    );
  });

  it("rejects input that would overflow the max segment count before allocating", () => {
    const segmenter = new AudioSegmenter(options({ maxSegments: 2 }));
    // Without an explicit count assertion, this must fail, not silently truncate.
    expectSegmentationError(
      () => segmenter.segment(makePcm(5000)),
      "AUDIO_SEGMENTATION_SEGMENT_COUNT_EXCEEDED",
    );
  });

  it("applies the overlap guard in milliseconds and at frame granularity", () => {
    expectSegmentationError(
      () => new AudioSegmenter(options({ overlapMs: 1000 })),
      "AUDIO_SEGMENTATION_OVERLAP_INVALID",
    );
    // A 100 ms segment at 50 Hz is 5 frames; a 90 ms overlap also rounds to 5
    // frames. Though 90 < 100 in milliseconds, the step would be zero.
    expectSegmentationError(
      () =>
        new AudioSegmenter(
          options({
            format: { sampleRate: 50, bytesPerSample: 2, channels: 1 },
            segmentDurationMs: 100,
            overlapMs: 90,
          }),
        ),
      "AUDIO_SEGMENTATION_OVERLAP_INVALID",
    );
  });

  it("produces overlapping fixed-duration segments at the configured step", () => {
    const input = makePcm(5000); // 5 seconds
    const segments = new AudioSegmenter(options({ overlapMs: 200 })).segment(input);

    // segmentDurationMs 1000 minus overlapMs 200 = 800-frame step; 5000 frames
    // yield starts at 0..4800: ceil(5000 / 800) = 7 segments.
    expect(segments).toHaveLength(7);
    expect(segments[0]).toMatchObject({ index: 0, startByte: 0, endByte: 2000, startMs: 0, endMs: 1000 });
    expect(segments[1]).toMatchObject({ index: 1, startByte: 1600, endByte: 3600, startMs: 800, endMs: 1800 });
    // Consecutive full segments overlap by overlapMs and advance by the step.
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.startByte - segments[i - 1]!.startByte).toBe(1600);
      expect(segments[i]!.startByte).toBeLessThan(segments[i - 1]!.endByte);
    }
    // The final segment clamps to the buffer end and may be shorter.
    expect(segments[6]).toMatchObject({ index: 6, startByte: 9600, endByte: 10_000 });
  });

  it("ignores a trailing partial sample frame", () => {
    const whole = new AudioSegmenter(options()).segment(makePcm(5000));
    const withPartial = new AudioSegmenter(options()).segment(makePcm(5000).slice(0, 10_001));
    expect(withPartial).toEqual(whole);
  });

  it("rejects invalid options at construction", () => {
    expectSegmentationError(
      () => new AudioSegmenter(options({ format: { ...FORMAT, sampleRate: 0 } })),
      "AUDIO_SEGMENTATION_OPTIONS_INVALID",
    );
    expectSegmentationError(
      () => new AudioSegmenter(options({ segmentDurationMs: 0 })),
      "AUDIO_SEGMENTATION_OPTIONS_INVALID",
    );
    expectSegmentationError(
      () => new AudioSegmenter(options({ overlapMs: -1 })),
      "AUDIO_SEGMENTATION_OPTIONS_INVALID",
    );
    expectSegmentationError(
      () => new AudioSegmenter(options({ maxSegments: 0 })),
      "AUDIO_SEGMENTATION_OPTIONS_INVALID",
    );
  });
});

describe("DeterministicTranscriber", () => {
  it("returns one deterministic transcription per segment in order", async () => {
    const input = makePcm(5000);
    const segments = new AudioSegmenter(options()).segment(input);
    const transcriber = new DeterministicTranscriber();

    const first = await transcriber.transcribe(segments);
    const second = await transcriber.transcribe(segments);

    expect(first).toHaveLength(segments.length);
    expect(first).toEqual(second);
    for (const [index, result] of first.entries()) {
      expect(result.index).toBe(index);
      expect(result.startMs).toBe(segments[index]!.startMs);
      expect(result.endMs).toBe(segments[index]!.endMs);
      expect(result.text).toMatch(/^segment \d+: [0-9a-f]{8}$/);
    }
  });

  it("derives different text from different audio", async () => {
    const transcriber = new DeterministicTranscriber();
    const segmenter = new AudioSegmenter(options());
    const a = await transcriber.transcribe(segmenter.segment(makePcm(5000, 7)));
    const b = await transcriber.transcribe(segmenter.segment(makePcm(5000, 11)));
    expect(a.map((r) => r.text)).not.toEqual(b.map((r) => r.text));
  });
});

describe("AudioTranscriptionPipeline", () => {
  it("wires segmentation into transcription end to end, deterministically", async () => {
    const input = makePcm(5000);
    const pipeline = new AudioTranscriptionPipeline({
      segmentation: options({ overlapMs: 200 }),
      transcriber: new DeterministicTranscriber(),
    });

    const first = await pipeline.transcribe(input);
    const second = await pipeline.transcribe(input);

    expect(first).toEqual(second);
    expect(first.segments).toHaveLength(7);
    expect(first.transcriptions).toHaveLength(first.segments.length);
    // The last segment in the overlapping split is shorter; its text still maps
    // to the same byte range on both runs.
    expect(first.transcriptions[6]).toMatchObject({
      index: 6,
      startMs: first.segments[6]!.startMs,
      endMs: first.segments[6]!.endMs,
    });
  });
});