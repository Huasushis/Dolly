import { describe, expect, it } from "vitest";
import type { Rect } from "../../../src/core/block-content.js";
import type { Block } from "../../../src/core/block-store.js";
import type { JsonValue } from "../../../src/core/canonical-json.js";
import {
  ExtensionCapabilityAuthority,
  type ExtensionCapabilityHandle,
  type ExtensionCapabilitySession,
  type ExtensionSessionIdentity,
} from "../../../src/core/extension-capability.js";
import {
  createDeliveredMediaReadCapability,
  type DeliveredMediaReadLimits,
  type DeliveredMediaReadOperation,
  type MediaReadRepresentation,
} from "../../../src/core/media-capability/delivered-media-read-capability.js";
import type {
  MediaByteRangeRequest,
  MediaReadDescription,
  MediaReadSource,
  MediaSignedUrl,
  MediaSignedUrlRequest,
} from "../../../src/core/media-capability/media-read-source.js";

const IDENTITY: ExtensionSessionIdentity = {
  extensionId: "com.example.media",
  instanceId: "instance-a",
  processGenerationId: "process-generation-a",
  sessionId: "session-a",
  moduleId: "module-a",
  moduleGenerationId: "module-generation-a",
};

function rect(x1: number, y1: number, x2: number, y2: number): Rect {
  return { kind: "image_rect_v1", x0: x1, y0: y1, x1: x2, y1: y2 };
}

/** The same rectangle as Block payload JSON. */
function cropJson(value: Rect): JsonValue {
  return {
    kind: value.kind,
    x0: value.x0,
    y0: value.y0,
    x1: value.x1,
    y1: value.y1,
  };
}

/** Two disjoint crops delivered on the same Media item. */
const DELIVERED_CROP_A = rect(0, 0, 400_000, 400_000);
const DELIVERED_CROP_B = rect(500_000, 500_000, 900_000, 900_000);

function block(id: string, sequence: string, value: JsonValue): Block {
  return {
    schemaVersion: "dolly.block/2",
    id,
    sequence,
    source: { kind: "module", id: "module-upstream" },
    createdAt: "2026-07-26T00:00:00.000Z",
    payload: { schema: "dolly.content/1", value },
  };
}

/**
 * A delivered Block that also mentions two other Media identifiers in ways
 * `media.md` section 4 says never create a Media reference: one inside plain
 * text and one inside an ordinary JSON data item.
 */
const BLOCK_UNCROPPED = block("block-1", "000000000000000000001", {
  items: [
    { type: "media-reference", mediaId: "media-photo" },
    { type: "media-reference", mediaId: "media-audio" },
    { type: "text", text: "see media-mentioned-in-text for details" },
    { type: "data", schema: "dolly.example/1", value: { mediaId: "media-config" } },
  ],
});

const BLOCK_CROPPED = block("block-2", "000000000000000000002", {
  items: [
    { type: "media-reference", mediaId: "media-tile", crop: cropJson(DELIVERED_CROP_A) },
    { type: "media-reference", mediaId: "media-tile", crop: cropJson(DELIVERED_CROP_B) },
  ],
});

/** A tiny image whose normalized crops can round down to zero pixels. */
const BLOCK_THUMB = block("block-3", "000000000000000000003", {
  items: [{ type: "media-reference", mediaId: "media-thumb" }],
});

/** Committed and valid, but never delivered to the default Module job. */
const BLOCK_OTHER_JOB = block("block-9", "000000000000000000009", {
  items: [{ type: "media-reference", mediaId: "media-undelivered" }],
});

interface FakeMediaItem {
  readonly description: MediaReadDescription;
  readonly bytes: Uint8Array;
}

function fill(byteLength: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = (index * 7 + seed) % 251;
  }
  return bytes;
}

function imageItem(
  mediaId: string,
  width: number,
  height: number,
  byteLength: number,
  seed: number,
): FakeMediaItem {
  return {
    description: { mediaId, mimeType: "image/png", byteLength, width, height },
    bytes: fill(byteLength, seed),
  };
}

function defaultItems(): Map<string, FakeMediaItem> {
  return new Map<string, FakeMediaItem>([
    ["media-photo", imageItem("media-photo", 800, 600, 3_000, 1)],
    ["media-tile", imageItem("media-tile", 1_000, 1_000, 4_000, 2)],
    ["media-thumb", imageItem("media-thumb", 4, 4, 64, 3)],
    ["media-undelivered", imageItem("media-undelivered", 100, 100, 500, 4)],
    ["media-mentioned-in-text", imageItem("media-mentioned-in-text", 10, 10, 80, 5)],
    ["media-config", imageItem("media-config", 10, 10, 80, 6)],
    [
      "media-audio",
      {
        description: {
          mediaId: "media-audio",
          mimeType: "audio/mpeg",
          byteLength: 5_000,
          durationMs: 60_000,
        },
        bytes: fill(5_000, 7),
      },
    ],
  ]);
}

interface FakeMediaReadSource extends MediaReadSource {
  readonly describeCalls: string[];
  readonly readCalls: MediaByteRangeRequest[];
  readonly signCalls: MediaSignedUrlRequest[];
  /** Forces the port to return a different range than it was asked for. */
  rangeOverride?: number;
}

/**
 * A host-side Media read port backed by an in-memory map. It performs no
 * authorization of its own, so anything it is asked for is something the
 * capability decided to allow.
 */
function createFakeSource(
  items: Map<string, FakeMediaItem>,
  signer?: (request: MediaSignedUrlRequest) => MediaSignedUrl | Promise<MediaSignedUrl>,
): FakeMediaReadSource {
  const describeCalls: string[] = [];
  const readCalls: MediaByteRangeRequest[] = [];
  const signCalls: MediaSignedUrlRequest[] = [];
  const source: FakeMediaReadSource = {
    describeCalls,
    readCalls,
    signCalls,
    describe(mediaId: string): MediaReadDescription | null {
      describeCalls.push(mediaId);
      return items.get(mediaId)?.description ?? null;
    },
    async readByteRange(request: MediaByteRangeRequest): Promise<Uint8Array> {
      readCalls.push(request);
      const item = items.get(request.mediaId);
      if (!item) throw new Error(`unknown media ${request.mediaId}`);
      const length = source.rangeOverride ?? request.length;
      return item.bytes.subarray(request.offset, request.offset + length);
    },
    ...(signer === undefined
      ? {}
      : {
          async signReadUrl(request: MediaSignedUrlRequest): Promise<MediaSignedUrl> {
            signCalls.push(request);
            return signer(request);
          },
        }),
  };
  return source;
}

function httpsSigner(request: MediaSignedUrlRequest): MediaSignedUrl {
  const crop = request.crop
    ? `&crop=${request.crop.x0},${request.crop.y0}` +
      `,${request.crop.x1},${request.crop.y1}`
    : "";
  return {
    url: `https://storage.example/${request.mediaId}?sig=abc&req=${request.requestId}${crop}`,
    expiresAt: "2026-07-26T00:05:00.000Z",
  };
}

interface Harness {
  readonly authority: ExtensionCapabilityAuthority;
  readonly session: ExtensionCapabilitySession;
  readonly handle: ExtensionCapabilityHandle;
  readonly source: FakeMediaReadSource;
  readonly clock: { wall: string };
  readonly scope: JsonValue;
  invoke(
    operation: string,
    argumentsValue: unknown,
    overrides?: Record<string, unknown>,
  ): Promise<unknown>;
}

interface HarnessOptions {
  readonly blocks?: readonly { block: Block; deliveryIds: readonly string[] }[];
  readonly limits?: Partial<DeliveredMediaReadLimits>;
  readonly operations?: readonly DeliveredMediaReadOperation[];
  readonly representations?: readonly MediaReadRepresentation[];
  readonly items?: Map<string, FakeMediaItem>;
  readonly signer?: (
    request: MediaSignedUrlRequest,
  ) => MediaSignedUrl | Promise<MediaSignedUrl>;
  readonly identity?: ExtensionSessionIdentity;
  readonly boundSession?: ExtensionSessionIdentity;
  readonly moduleJobId?: string;
  readonly runId?: string;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const clock = { wall: "2026-07-26T00:00:00.000Z" };
  const moduleJobId = options.moduleJobId ?? "module-job-a";
  const runId = options.runId ?? "run-a";
  let handleSeed = 0;
  const authority = new ExtensionCapabilityAuthority({
    now: () => clock.wall,
    nextHandle: () => Buffer.alloc(32, ++handleSeed).toString("base64url"),
  });
  const session = authority.openSession(options.identity ?? IDENTITY);
  const source = createFakeSource(options.items ?? defaultItems(), options.signer);
  let requestSequence = 0;
  const definition = createDeliveredMediaReadCapability({
    claim: {
      moduleJobId,
      runId,
      blockGroups: options.blocks ?? [
        { block: BLOCK_UNCROPPED, deliveryIds: ["delivery-1"] },
        { block: BLOCK_CROPPED, deliveryIds: ["delivery-2"] },
        { block: BLOCK_THUMB, deliveryIds: ["delivery-3"] },
      ],
    },
    session: options.boundSession ?? options.identity ?? IDENTITY,
    source,
    expiresAt: "2026-07-27T00:00:00.000Z",
    signedUrl: { recipientId: "module-a", expiresInSeconds: 300 },
    nextRequestId: () => `request-${(requestSequence += 1)}`,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.operations === undefined ? {} : { operations: options.operations }),
    ...(options.representations === undefined
      ? {}
      : { representations: options.representations }),
  });
  const handle = session.issue(definition.grant, definition.handler);
  return {
    authority,
    session,
    handle,
    source,
    clock,
    scope: definition.grant.resourceScope,
    invoke(operation, argumentsValue, overrides = {}) {
      return session.invoke({
        handle,
        operation,
        arguments: argumentsValue as never,
        moduleJobId,
        runId,
        ...overrides,
      });
    },
  };
}

describe("Extension delivered-Media read scope", () => {
  it("derives its scope only from validated media-reference items", () => {
    const harness = createHarness();
    const scope = harness.scope as {
      media: { mediaId: string }[];
      instanceId: string;
      sessionId: string;
      moduleId: string;
      moduleJobId: string;
    };

    expect(scope.media.map((entry) => entry.mediaId)).toEqual([
      "media-audio",
      "media-photo",
      "media-thumb",
      "media-tile",
    ]);
    expect(scope).toMatchObject({
      instanceId: "instance-a",
      sessionId: "session-a",
      moduleId: "module-a",
      moduleJobId: "module-job-a",
    });
    // Text and ordinary JSON fields never become a Media reference.
    expect(JSON.stringify(scope)).not.toContain("media-mentioned-in-text");
    expect(JSON.stringify(scope)).not.toContain("media-config");
  });

  it("lists the delivered Media with the crops that were actually delivered", async () => {
    const harness = createHarness();

    const listing = (await harness.invoke("list", {})) as {
      media: { mediaId: string; allowsFullMedia: boolean; crops: Rect[] }[];
      truncated: boolean;
    };
    expect(listing.truncated).toBe(false);
    const tile = listing.media.find((entry) => entry.mediaId === "media-tile")!;
    expect(tile.allowsFullMedia).toBe(false);
    expect(tile.crops).toEqual([DELIVERED_CROP_A, DELIVERED_CROP_B]);
    const photo = listing.media.find((entry) => entry.mediaId === "media-photo")!;
    expect(photo.allowsFullMedia).toBe(true);
    expect(photo.crops).toEqual([]);
  });

  it("paginates the listing explicitly", async () => {
    const harness = createHarness({ limits: { maxListResults: 2 } });

    await expect(harness.invoke("list", {})).resolves.toMatchObject({
      truncated: true,
      nextAfter: "media-photo",
    });
    const rest = (await harness.invoke("list", { after: "media-photo" })) as {
      media: { mediaId: string }[];
      truncated: boolean;
    };
    expect(rest.media.map((entry) => entry.mediaId)).toEqual(["media-thumb", "media-tile"]);
    expect(rest.truncated).toBe(false);
  });

  it("describes a delivered Media item with its inspected metadata", async () => {
    const harness = createHarness();

    await expect(harness.invoke("describe", { mediaId: "media-audio" })).resolves.toMatchObject({
      schemaVersion: "dolly.delivered-media-description/1",
      mediaId: "media-audio",
      mimeType: "audio/mpeg",
      byteLength: 5_000,
      durationMs: 60_000,
      allowsFullMedia: true,
      blockIds: ["block-1"],
      deliveryIds: ["delivery-1"],
    });
  });
});

describe("Extension delivered-Media read negative paths", () => {
  it("denies a guessed identifier without touching the Media source", async () => {
    const harness = createHarness();

    await expect(harness.invoke("read", { mediaId: "media-guessed" })).rejects.toMatchObject({
      name: "ExtensionCapabilityError",
      code: "CAPABILITY_DENIED",
      details: { reason: "media-not-delivered" },
    });
    expect(harness.source.describeCalls).toEqual([]);
    expect(harness.source.readCalls).toEqual([]);
  });

  it("denies an identifier that only appeared in text or an ordinary JSON field", async () => {
    const harness = createHarness();

    // Both identifiers really are inside the delivered Block payload.
    const payload = JSON.stringify(BLOCK_UNCROPPED.payload.value);
    expect(payload).toContain("media-mentioned-in-text");
    expect(payload).toContain("media-config");

    for (const mediaId of ["media-mentioned-in-text", "media-config"]) {
      await expect(harness.invoke("read", { mediaId })).rejects.toMatchObject({
        code: "CAPABILITY_DENIED",
        details: { reason: "media-not-delivered" },
      });
    }
  });

  it("denies a Media identifier that another Module job received", async () => {
    const other = createHarness({
      moduleJobId: "module-job-b",
      runId: "run-b",
      blocks: [{ block: BLOCK_OTHER_JOB, deliveryIds: ["delivery-7"] }],
    });
    const mine = createHarness();

    // The identifier is real, the Media exists, and another job can read it.
    await expect(
      other.invoke("read", { mediaId: "media-undelivered", representation: "base64" }),
    ).resolves.toMatchObject({ mediaId: "media-undelivered", byteLength: 500 });

    await expect(
      mine.invoke("read", { mediaId: "media-undelivered" }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
      details: { reason: "media-not-delivered" },
    });
    expect(mine.source.describeCalls).toEqual([]);
  });

  it("denies a cross-session handle, a revoked grant, an expired grant, and a closed session", async () => {
    const harness = createHarness();
    await harness.invoke("describe", { mediaId: "media-photo" });

    const foreign = harness.authority.openSession({
      ...IDENTITY,
      sessionId: "session-foreign",
      processGenerationId: "process-generation-foreign",
    });
    await expect(
      foreign.invoke({
        handle: harness.handle,
        operation: "describe",
        arguments: { mediaId: "media-photo" },
        moduleJobId: "module-job-a",
        runId: "run-a",
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });

    harness.clock.wall = "2026-07-28T00:00:00.000Z";
    await expect(harness.invoke("describe", { mediaId: "media-photo" })).rejects.toMatchObject({
      code: "CAPABILITY_EXPIRED",
    });

    harness.clock.wall = "2026-07-26T00:00:00.000Z";
    expect(harness.session.revoke(harness.handle)).toBe("revoked");
    await expect(harness.invoke("describe", { mediaId: "media-photo" })).rejects.toMatchObject({
      code: "CAPABILITY_REVOKED",
    });

    await harness.session.close();
    await expect(harness.invoke("describe", { mediaId: "media-photo" })).rejects.toMatchObject({
      code: "CAPABILITY_SESSION_CLOSED",
    });
  });

  it("rejects a grant issued into a different instance, session, or Module", async () => {
    for (const drift of [
      { instanceId: "instance-b" },
      { sessionId: "session-b" },
      { moduleId: "module-b" },
    ]) {
      const harness = createHarness({
        identity: { ...IDENTITY, ...drift },
        boundSession: IDENTITY,
      });
      await expect(harness.invoke("describe", { mediaId: "media-photo" })).rejects.toMatchObject({
        code: "CAPABILITY_SCOPE_MISMATCH",
      });
      expect(harness.source.describeCalls).toEqual([]);
    }
  });

  it("binds the capability to the Claim's Module job and Run", async () => {
    const harness = createHarness();

    await expect(
      harness.invoke("describe", { mediaId: "media-photo" }, { moduleJobId: "module-job-b" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_SCOPE_MISMATCH" });
    await expect(
      harness.invoke("describe", { mediaId: "media-photo" }, { runId: "run-b" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_SCOPE_MISMATCH" });
  });

  it("keeps read and sign-url as separate grants", async () => {
    const harness = createHarness({ operations: ["describe", "read"], signer: httpsSigner });

    await expect(harness.invoke("sign-url", { mediaId: "media-photo" })).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
    });
    expect(harness.source.signCalls).toEqual([]);
    await expect(
      harness.invoke("read", { mediaId: "media-photo", representation: "base64" }),
    ).resolves.toMatchObject({ mediaId: "media-photo" });
  });

  it("rejects unknown argument fields, a non-string identifier, and an unknown representation", async () => {
    const harness = createHarness();

    await expect(
      harness.invoke("read", { mediaId: "media-photo", quality: "high" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
    await expect(harness.invoke("read", { mediaId: 7 })).rejects.toMatchObject({
      code: "CAPABILITY_ARGUMENT_INVALID",
    });
    await expect(
      harness.invoke("read", { mediaId: "media-photo", representation: "raw" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
  });

  it("reports an unavailable Media instead of returning an empty result", async () => {
    const items = defaultItems();
    items.delete("media-photo");
    const harness = createHarness({ items });

    await expect(
      harness.invoke("read", { mediaId: "media-photo", representation: "base64" }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DEPENDENCY_FAILED",
      details: { reason: "media-unavailable" },
    });
    expect(harness.source.readCalls).toEqual([]);
  });

  it("rejects a byte range that the Media source did not honour", async () => {
    const harness = createHarness();
    harness.source.rangeOverride = 10;

    await expect(
      harness.invoke("read", { mediaId: "media-photo", length: 100 }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DEPENDENCY_FAILED",
      details: { reason: "media-range-mismatch" },
    });
  });

  it("stops once the invocation budget is spent", async () => {
    const harness = createHarness({ limits: { maxInvocations: 2 } });

    await harness.invoke("describe", { mediaId: "media-photo" });
    await harness.invoke("describe", { mediaId: "media-photo" });
    await expect(harness.invoke("describe", { mediaId: "media-photo" })).rejects.toMatchObject({
      code: "CAPABILITY_QUOTA_EXCEEDED",
    });
  });
});

describe("Extension delivered-Media crop containment", () => {
  const cases: readonly {
    readonly name: string;
    readonly crop: Rect | undefined;
    readonly allowed: boolean;
  }[] = [
    { name: "exactly the delivered crop", crop: DELIVERED_CROP_A, allowed: true },
    { name: "strictly inside a delivered crop", crop: rect(100_000, 100_000, 300_000, 300_000), allowed: true },
    { name: "sharing one edge with a delivered crop", crop: rect(0, 0, 400_000, 200_000), allowed: true },
    {
      name: "partially overlapping a delivered crop",
      crop: rect(300_000, 300_000, 600_000, 600_000),
      allowed: false,
    },
    {
      name: "completely disjoint from both delivered crops",
      crop: rect(420_000, 420_000, 480_000, 480_000),
      allowed: false,
    },
    { name: "the union of both delivered crops", crop: rect(0, 0, 900_000, 900_000), allowed: false },
    { name: "an enlarged delivered crop", crop: rect(0, 0, 500_000, 500_000), allowed: false },
    { name: "the whole image", crop: undefined, allowed: false },
  ];

  for (const testCase of cases) {
    it(`${testCase.allowed ? "allows" : "denies"} ${testCase.name}`, async () => {
      const harness = createHarness({ signer: httpsSigner });
      const request =
        testCase.crop === undefined
          ? { mediaId: "media-tile" }
          : { mediaId: "media-tile", crop: testCase.crop };

      if (testCase.allowed) {
        const grant = (await harness.invoke("sign-url", request)) as { url: string };
        expect(grant.url.startsWith("https://storage.example/media-tile?")).toBe(true);
        expect(harness.source.signCalls).toHaveLength(1);
        expect(harness.source.signCalls[0]!.crop).toEqual(testCase.crop);
        return;
      }
      await expect(harness.invoke("sign-url", request)).rejects.toMatchObject({
        code: "CAPABILITY_DENIED",
        details: {
          reason:
            testCase.crop === undefined ? "full-media-not-delivered" : "crop-not-delivered",
          mediaId: "media-tile",
        },
      });
      expect(harness.source.signCalls).toEqual([]);
    });
  }

  it("allows the full Media and any valid crop when an uncropped reference was delivered", async () => {
    const harness = createHarness({ signer: httpsSigner });

    await expect(
      harness.invoke("read", { mediaId: "media-photo", representation: "base64" }),
    ).resolves.toMatchObject({ mediaId: "media-photo", byteLength: 3_000 });
    await expect(
      harness.invoke("sign-url", { mediaId: "media-photo", crop: rect(600_000, 600_000, 700_000, 700_000) }),
    ).resolves.toMatchObject({ mediaId: "media-photo" });
  });

  it("checks the delivered crop scope before the representation is considered", async () => {
    const harness = createHarness({ representations: ["base64"] });

    // `bytes` is not granted and the crop is out of scope. The scope denial
    // wins, so an Extension cannot use representation support as a probe for
    // a crop it was never delivered.
    await expect(
      harness.invoke("read", {
        mediaId: "media-tile",
        crop: rect(0, 0, 900_000, 900_000),
        representation: "bytes",
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
      details: { reason: "crop-not-delivered" },
    });
  });

  it("rejects an inverted crop, a crop on non-image Media, and an out-of-range crop", async () => {
    const harness = createHarness({ signer: httpsSigner });

    // An inverted fixed-point rectangle (x1 < x0) is not a valid crop. A valid
    // crop always covers at least one pixel on a positive display, so the only
    // rejections available here are premise errors, never a rounded-to-zero
    // rectangle.
    await expect(
      harness.invoke("sign-url", { mediaId: "media-thumb", crop: rect(100_000, 100_000, 50_000, 50_000) }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
    await expect(
      harness.invoke("sign-url", { mediaId: "media-audio", crop: rect(0, 0, 500_000, 500_000) }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
    await expect(
      harness.invoke("sign-url", { mediaId: "media-thumb", crop: rect(0, 0, 1_500_000, 1_000_000) }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
    expect(harness.source.signCalls).toEqual([]);

    // The same tiny image accepts a crop that does cover at least one pixel.
    await expect(
      harness.invoke("sign-url", { mediaId: "media-thumb", crop: rect(0, 0, 500_000, 500_000) }),
    ).resolves.toMatchObject({ mediaId: "media-thumb" });
  });

  it("refuses a cropped inline read instead of returning the full original", async () => {
    const harness = createHarness({ signer: httpsSigner });

    for (const representation of ["bytes", "base64"]) {
      await expect(
        harness.invoke("read", {
          mediaId: "media-photo",
          crop: rect(100_000, 100_000, 200_000, 200_000),
          representation,
        }),
      ).rejects.toMatchObject({
        code: "CAPABILITY_DENIED",
        details: { reason: "cropped-inline-unsupported" },
      });
    }
    expect(harness.source.readCalls).toEqual([]);
  });
});

describe("Extension delivered-Media representations", () => {
  it("returns one whole inline copy for the base64 representation", async () => {
    const harness = createHarness();

    const copy = (await harness.invoke("read", {
      mediaId: "media-photo",
      representation: "base64",
    })) as { data: string; byteLength: number; encoding: string; mimeType: string };
    expect(copy.encoding).toBe("base64");
    expect(copy.mimeType).toBe("image/png");
    expect(copy.byteLength).toBe(3_000);
    expect(Buffer.from(copy.data, "base64")).toEqual(Buffer.from(fill(3_000, 1)));
  });

  it("pages through the byte-stream representation", async () => {
    const harness = createHarness({ limits: { maxReadBytes: 1_024 } });

    await expect(
      harness.invoke("read", {
        mediaId: "media-photo",
        representation: "bytes",
        length: 1_000,
      }),
    ).resolves.toMatchObject({
      schemaVersion: "dolly.delivered-media-chunk/1",
      offset: 0,
      length: 1_000,
      totalByteLength: 3_000,
      hasMore: true,
    });

    const last = (await harness.invoke("read", {
      mediaId: "media-photo",
      representation: "bytes",
      offset: 2_500,
      length: 1_000,
    })) as { length: number; hasMore: boolean; data: string };
    // The range is clamped to the end of the Media and reports the truth.
    expect(last.length).toBe(500);
    expect(last.hasMore).toBe(false);
    expect(Buffer.from(last.data, "base64")).toEqual(
      Buffer.from(fill(3_000, 1).subarray(2_500)),
    );
  });

  it("rejects an offset past the end and an offset on the whole-copy representation", async () => {
    const harness = createHarness();

    await expect(
      harness.invoke("read", { mediaId: "media-photo", offset: 3_000 }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
    await expect(
      harness.invoke("read", { mediaId: "media-photo", offset: -1 }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
    await expect(
      harness.invoke("read", { mediaId: "media-photo", representation: "base64", offset: 0 }),
    ).rejects.toMatchObject({ code: "CAPABILITY_ARGUMENT_INVALID" });
  });

  it("enforces the per-read and cumulative byte budgets", async () => {
    const harness = createHarness({
      limits: { maxReadBytes: 1_000, maxTotalReadBytes: 2_000 },
    });

    await expect(
      harness.invoke("read", { mediaId: "media-photo", representation: "base64" }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_QUOTA_EXCEEDED",
      details: { limit: "maxReadBytes", allowed: 1_000 },
    });
    await expect(
      harness.invoke("read", { mediaId: "media-photo", length: 1_001 }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_QUOTA_EXCEEDED",
      details: { limit: "length", allowed: 1_000 },
    });

    await harness.invoke("read", { mediaId: "media-photo", length: 1_000 });
    await harness.invoke("read", { mediaId: "media-photo", offset: 1_000, length: 1_000 });
    await expect(
      harness.invoke("read", { mediaId: "media-photo", offset: 2_000, length: 1_000 }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_QUOTA_EXCEEDED",
      details: { limit: "maxTotalReadBytes", allowed: 2_000 },
    });
    expect(harness.source.readCalls).toHaveLength(2);
  });

  it("denies a representation the host did not grant", async () => {
    const harness = createHarness({ representations: ["base64"] });

    await expect(
      harness.invoke("read", { mediaId: "media-photo", representation: "bytes" }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
      details: { reason: "representation-not-granted", representation: "bytes" },
    });
    await expect(
      harness.invoke("read", { mediaId: "media-photo", representation: "base64" }),
    ).resolves.toMatchObject({ representation: "base64" });
  });
});

describe("Extension delivered-Media signed URL representation", () => {
  it("reports that no URL is available instead of silently returning Base64", async () => {
    const harness = createHarness();
    expect(harness.source.signReadUrl).toBeUndefined();

    await expect(harness.invoke("sign-url", { mediaId: "media-photo" })).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
      details: { reason: "signed-url-unavailable" },
    });
  });

  it("issues a short-lived HTTPS URL bound to the host-chosen recipient", async () => {
    const harness = createHarness({ signer: httpsSigner });

    await expect(harness.invoke("sign-url", { mediaId: "media-photo" })).resolves.toMatchObject({
      schemaVersion: "dolly.delivered-media-url/1",
      url: "https://storage.example/media-photo?sig=abc&req=request-1",
      expiresAt: "2026-07-26T00:05:00.000Z",
      mimeType: "image/png",
    });
    expect(harness.source.signCalls[0]).toMatchObject({
      recipientId: "module-a",
      expiresInSeconds: 300,
      requestId: "request-1",
    });
  });

  it("rejects a non-HTTPS or unparsable signed URL from the storage adapter", async () => {
    const insecure = createHarness({
      signer: () => ({
        url: "http://storage.example/media-photo?sig=abc",
        expiresAt: "2026-07-26T00:05:00.000Z",
      }),
    });
    await expect(insecure.invoke("sign-url", { mediaId: "media-photo" })).rejects.toMatchObject({
      code: "CAPABILITY_DEPENDENCY_FAILED",
      details: { reason: "signed-url-insecure" },
    });

    const unparsable = createHarness({
      signer: () => ({ url: "/media-photo", expiresAt: "2026-07-26T00:05:00.000Z" }),
    });
    await expect(
      unparsable.invoke("sign-url", { mediaId: "media-photo" }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DEPENDENCY_FAILED",
      details: { reason: "signed-url-invalid" },
    });
  });

  it("fails visibly when the adapter refuses to sign an exact crop", async () => {
    const harness = createHarness({
      signer: (request) => {
        if (request.crop) throw new Error("adapter does not support signed crops");
        return httpsSigner(request);
      },
    });

    await expect(
      harness.invoke("sign-url", { mediaId: "media-tile", crop: DELIVERED_CROP_A }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DEPENDENCY_FAILED",
      details: { reason: "signed-url-failed" },
    });
    // No fallback to the full original.
    expect(harness.source.readCalls).toEqual([]);
  });

  it("bounds the number of signed URLs separately from byte reads", async () => {
    const harness = createHarness({ signer: httpsSigner, limits: { maxSignedUrls: 2 } });

    await harness.invoke("sign-url", { mediaId: "media-photo" });
    await harness.invoke("sign-url", { mediaId: "media-photo" });
    await expect(harness.invoke("sign-url", { mediaId: "media-photo" })).rejects.toMatchObject({
      code: "CAPABILITY_QUOTA_EXCEEDED",
      details: { limit: "maxSignedUrls", allowed: 2 },
    });
    await expect(
      harness.invoke("read", { mediaId: "media-photo", representation: "base64" }),
    ).resolves.toMatchObject({ mediaId: "media-photo" });
  });

  it("requires a host-chosen recipient before sign-url can be granted", () => {
    let error: unknown;
    try {
      createDeliveredMediaReadCapability({
        claim: {
          moduleJobId: "module-job-a",
          runId: "run-a",
          blockGroups: [{ block: BLOCK_UNCROPPED, deliveryIds: ["delivery-1"] }],
        },
        session: IDENTITY,
        source: createFakeSource(defaultItems(), httpsSigner),
        expiresAt: "2026-07-27T00:00:00.000Z",
        operations: ["sign-url"],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      name: "ExtensionCapabilityError",
      code: "CAPABILITY_CONFIG_INVALID",
    });
  });
});
