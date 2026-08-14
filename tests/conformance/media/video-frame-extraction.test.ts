import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_VIDEO_FRAMES,
  MAX_VIDEO_INTERVAL_SECONDS,
  VideoFrameExtractionError,
  detectVideoContainer,
  extractVideoFrames,
  validateVideoFrameRequest,
  type VideoContainer,
  type VideoFrameExtractionErrorCode,
  type VideoFrameRequest,
} from "../../../src/core/video-frame-extraction.js";
import { FakeFrameExtractor } from "./video-frame-extraction-fixtures.js";

/** Container payloads padded past the twelve-byte signature window. */
const CONTAINER_BYTES: Record<VideoContainer, [number, ...number[]]> = {
  mp4: [
    0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, // size 16, "ftyp"
    0x69, 0x73, 0x6f, 0x6d, // "isom"
    0, 0, 0, 0,
  ],
  webm: [0x1a, 0x45, 0xdf, 0xa3, 1, 0, 0, 0, 0, 0, 0, 0],
  avi: [
    0x52, 0x49, 0x46, 0x46, // "RIFF"
    0, 0, 0, 0,
    0x41, 0x56, 0x49, 0x20, 0x20, // "AVI ",
    0, 0,
  ],
  "mpeg-ps": [0, 0, 1, 0xba, 0, 0, 0, 0, 0, 0, 0, 0],
  "mpeg-ts": [0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  flv: [0x46, 0x4c, 0x56, 0x01, 0, 0, 0, 0, 0, 0, 0, 0],
};

function containerBytes(container: VideoContainer): Uint8Array {
  return Uint8Array.from(CONTAINER_BYTES[container]);
}

function positionPayload(positionSeconds: number): Uint8Array {
  const payload = Buffer.alloc(8);
  payload.writeDoubleBE(positionSeconds, 0);
  return payload;
}

function request(
  overrides: Partial<VideoFrameRequest> = {},
): VideoFrameRequest {
  return {
    bytes: containerBytes("mp4"),
    intervalSeconds: 1,
    ...overrides,
  };
}

describe("video frame extraction", () => {
  it("emits frames at interval multiples in stable presentation order", async () => {
    const extractor = new FakeFrameExtractor({ durationSeconds: 2 });
    const stream = extractVideoFrames(
      request({ intervalSeconds: 0.5 }),
      extractor,
    );
    const frames: { index: number; timeSeconds: number; mimeType: string; bytes: Uint8Array }[] = [];
    for await (const frame of stream) frames.push(frame);

    expect(frames.map((f) => f.index)).toEqual([0, 1, 2, 3]);
    expect(frames.map((f) => f.timeSeconds)).toEqual([0, 0.5, 1, 1.5]);
    for (const frame of frames) {
      expect(frame.mimeType).toBe("image/jpeg");
      expect([...frame.bytes]).toEqual([...positionPayload(frame.timeSeconds)]);
    }
    // Four frames, plus one final pull that discovers the video end.
    expect(extractor.extractCalls).toBe(5);
  });

  it("clamps the stream to maxFrames without over-pulling the extractor", async () => {
    const extractor = new FakeFrameExtractor({ durationSeconds: 10 });
    const times: number[] = [];
    for await (const frame of extractVideoFrames(
      request({ maxFrames: 3 }),
      extractor,
    )) {
      times.push(frame.timeSeconds);
    }

    expect(times).toEqual([0, 1, 2]);
    // The clamp must also stop pulling: a third pull happened, no fourth.
    expect(extractor.extractCalls).toBe(3);
  });

  it("bounds an unset maxFrames to DEFAULT_MAX_VIDEO_FRAMES", async () => {
    const extractor = new FakeFrameExtractor({
      durationSeconds: DEFAULT_MAX_VIDEO_FRAMES + 1,
    });
    const times: number[] = [];
    for await (const frame of extractVideoFrames(request(), extractor)) {
      times.push(frame.timeSeconds);
    }

    expect(times.length).toBe(DEFAULT_MAX_VIDEO_FRAMES);
    expect(times.at(-1)).toBe(DEFAULT_MAX_VIDEO_FRAMES - 1);
    expect(extractor.extractCalls).toBe(DEFAULT_MAX_VIDEO_FRAMES);
  });

  it.each(Object.keys(CONTAINER_BYTES) as VideoContainer[])(
    "accepts a %s container signature",
    async (container) => {
      const extractor = new FakeFrameExtractor({ durationSeconds: 0.25 });
      const times: number[] = [];
      for await (const frame of extractVideoFrames(
        request({ bytes: containerBytes(container) }),
        extractor,
      )) {
        times.push(frame.timeSeconds);
      }
      // Only position 0 lies inside a 0.25 s video for a 1 s interval.
      expect(times).toEqual([0]);
    },
  );

  it.each<[string, Partial<VideoFrameRequest>, VideoFrameExtractionErrorCode]>([
    ["empty bytes", { bytes: new Uint8Array() }, "INVALID_INPUT"],
    ["string bytes", { bytes: "not bytes" as never }, "INVALID_INPUT"],
    [
      "non-video signature",
      {
        bytes: Uint8Array.from([
          0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0,
        ]),
      },
      "UNSUPPORTED_FORMAT",
    ],
    ["zero interval", { intervalSeconds: 0 }, "INVALID_INPUT"],
    ["negative interval", { intervalSeconds: -1 }, "INVALID_INPUT"],
    ["NaN interval", { intervalSeconds: Number.NaN }, "INVALID_INPUT"],
    [
      "infinite interval",
      { intervalSeconds: Number.POSITIVE_INFINITY },
      "INVALID_INPUT",
    ],
    [
      "interval beyond sane bound",
      { intervalSeconds: MAX_VIDEO_INTERVAL_SECONDS + 1 },
      "INVALID_INPUT",
    ],
    ["zero maxFrames", { maxFrames: 0 }, "INVALID_INPUT"],
    ["negative maxFrames", { maxFrames: -2 }, "INVALID_INPUT"],
    ["fractional maxFrames", { maxFrames: 1.5 }, "INVALID_INPUT"],
  ])("rejects %s synchronously with %s", (label, overrides, code) => {
    void label;
    expect(() => validateVideoFrameRequest(request(overrides))).toThrow(
      expect.objectContaining({ code }),
    );
    expect(() =>
      extractVideoFrames(
        request(overrides),
        new FakeFrameExtractor({ durationSeconds: 1 }),
      ),
    ).toThrow(expect.objectContaining({ code }));
  });

  it("rejects a missing extractor with INVALID_CONFIGURATION", () => {
    expect(() =>
      extractVideoFrames(request(), null as never),
    ).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
  });

  it("validates without pulling the extractor", () => {
    expect(() => validateVideoFrameRequest({ bytes: new Uint8Array(), intervalSeconds: 1 }))
      .toThrow(VideoFrameExtractionError);
  });

  it("snapshots each frame so caller mutation cannot affect later frames", async () => {
    const extractor = new FakeFrameExtractor({ durationSeconds: 2 });
    const frames: Buffer[] = [];
    for await (const frame of extractVideoFrames(
      request({ intervalSeconds: 0.5 }),
      extractor,
    )) {
      frames.push(Buffer.from(frame.bytes));
    }
    frames[0].fill(0xff);
    expect([...frames[1]]).toEqual([...positionPayload(0.5)]);
    expect([...frames[3]]).toEqual([...positionPayload(1.5)]);
  });

  it("detects the container separately from stream extraction", () => {
    for (const container of Object.keys(CONTAINER_BYTES) as VideoContainer[]) {
      expect(detectVideoContainer(containerBytes(container))).toBe(container);
    }
    expect(
      detectVideoContainer(
        Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
      ),
    ).toBeUndefined();
  });
});