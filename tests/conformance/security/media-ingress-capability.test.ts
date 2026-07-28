import { describe, expect, it, vi } from "vitest";
import { BlockStore } from "../../../src/core/block-store.js";
import { ReferenceGraph } from "../../../src/core/reference-graph.js";
import {
  MediaIngressAuthority,
  MediaIngressService,
  type SecureLocalFileReader,
} from "../../../src/core/media-ingress.js";
import {
  InMemoryMediaByteStore,
  MediaStore,
  type MediaInspector,
} from "../../../src/core/media-store.js";
import type { SecureRemoteFetchPolicy } from "../../../src/core/secure-remote-fetch.js";

const NOW = "2026-07-24T00:00:00.000Z";
const EXPIRES_AT = "2026-07-24T00:01:00.000Z";

const remotePolicy: SecureRemoteFetchPolicy = {
  allowedHosts: ["images.example"],
  maxUrlBytes: 4096,
  maxRedirects: 3,
  maxBytes: 16,
  connectTimeoutMs: 100,
  headerTimeoutMs: 200,
  totalTimeoutMs: 500,
};

function createHarness(limits: {
  readonly maxActiveCapabilities?: number;
  readonly maxConcurrentOperations?: number;
  readonly maxCapabilityLifetimeMs?: number;
} = {}) {
  let token = 0;
  let now = NOW;
  const inspect = vi.fn(async () => ({
    mimeType: "image/png",
    width: 2,
    height: 2,
  }));
  const inspector: MediaInspector = { inspect };
  const media = new MediaStore({
    durability: "volatile",
    referenceGraph: new ReferenceGraph(),
    bytes: new InMemoryMediaByteStore(),
    inspector,
    maxMediaBytes: 16,
    idNamespace: "media-ingress",
    now: () => now,
  });
  const authority = new MediaIngressAuthority({
    nextToken: () => `capability-${++token}`,
    now: () => now,
    maxActiveCapabilities: limits.maxActiveCapabilities ?? 32,
    maxConcurrentOperations: limits.maxConcurrentOperations ?? 8,
    maxCapabilityLifetimeMs: limits.maxCapabilityLifetimeMs ?? 60_000,
  });
  return {
    media,
    authority,
    inspect,
    setNow(value: string) {
      now = value;
    },
  };
}

describe("SEC-001 explicit media ingress capabilities", () => {
  it("uses distinct cryptographically random tokens by default", () => {
    const authority = new MediaIngressAuthority({
      now: () => NOW,
      maxActiveCapabilities: 8,
      maxConcurrentOperations: 2,
      maxCapabilityLifetimeMs: 60_000,
    });
    const first = authority.issue({
      subjectId: "extension-a",
      mode: "extension-bytes",
      registrationId: "registration-random-token-a",
      maxBytes: 16,
      expiresAt: EXPIRES_AT,
    });
    const second = authority.issue({
      subjectId: "extension-b",
      mode: "extension-bytes",
      registrationId: "registration-random-token-b",
      maxBytes: 16,
      expiresAt: EXPIRES_AT,
    });

    expect(first.token).toMatch(/^capability-[A-Za-z0-9_-]{43}$/);
    expect(second.token).toMatch(/^capability-[A-Za-z0-9_-]{43}$/);
    expect(first.token).not.toBe(second.token);
    expect(first.token).not.toBe("capability-1");
    expect(second.token).not.toBe("capability-2");
  });

  it("treats payload keys named url, file, and base64 as inert data", () => {
    const harness = createHarness();
    const blocks = new BlockStore({
      referenceGraph: harness.media.referenceGraph,
      media: harness.media,
      nextBlockId: () => "block-1",
      now: () => NOW,
    });

    const block = blocks.commit(
      {
        payload: {
          schema: "example.untrusted/1",
          value: {
            url: "https://169.254.169.254/latest/meta-data",
            file: "C:\\Users\\owner\\secret.txt",
            base64: "A".repeat(1024),
          },
        },
      },
      { kind: "module", id: "untrusted-model" },
    );

    expect(block.payload.value).toMatchObject({
      url: "https://169.254.169.254/latest/meta-data",
    });
    expect(harness.inspect).not.toHaveBeenCalled();
  });

  it("binds a capability to both subject and ingress mode before any I/O", async () => {
    const harness = createHarness();
    const localRead = vi.fn();
    const remoteFetch = vi.fn();
    const ingress = new MediaIngressService({
      authority: harness.authority,
      media: harness.media,
      maxIngressBytes: 16,
      localFiles: { read: localRead },
      remote: { fetch: remoteFetch },
    });
    const capability = harness.authority.issue({
      subjectId: "extension-a",
      mode: "extension-bytes",
      registrationId: "registration-denied-extension-bytes",
      maxBytes: 16,
      expiresAt: EXPIRES_AT,
    });

    await expect(
      ingress.ingestLocalFile({
        capability,
        registrationId: "registration-denied-extension-bytes",
        candidatePath: "C:\\safe\\image.png",
      }),
    ).rejects.toMatchObject({ code: "MEDIA_CAPABILITY_DENIED" });
    await expect(
      ingress.ingestRemoteFetch({
        capability,
        registrationId: "registration-denied-extension-bytes",
        url: "https://images.example/image.png",
      }),
    ).rejects.toMatchObject({ code: "MEDIA_CAPABILITY_DENIED" });
    await expect(
      ingress.ingestExtensionBytes({
        capability: { ...capability, subjectId: "extension-b" },
        registrationId: "registration-denied-extension-bytes",
        bytes: Uint8Array.of(1),
      }),
    ).rejects.toMatchObject({ code: "MEDIA_CAPABILITY_DENIED" });
    await expect(
      ingress.ingestExtensionBytes({
        capability,
        registrationId: "registration-not-authorized",
        bytes: Uint8Array.of(1),
      }),
    ).rejects.toMatchObject({ code: "MEDIA_CAPABILITY_DENIED" });
    expect(localRead).not.toHaveBeenCalled();
    expect(remoteFetch).not.toHaveBeenCalled();
    expect(harness.inspect).not.toHaveBeenCalled();
  });

  it("scopes registration retries to the authorized subject and rejects invalid identifiers", async () => {
    const harness = createHarness();
    const ingress = new MediaIngressService({
      authority: harness.authority,
      media: harness.media,
      maxIngressBytes: 16,
    });
    const firstSubject = harness.authority.issue({
      subjectId: "extension-a",
      mode: "extension-bytes",
      registrationId: "caller-registration-1",
      maxBytes: 16,
      expiresAt: EXPIRES_AT,
    });
    const secondSubject = harness.authority.issue({
      subjectId: "extension-b",
      mode: "extension-bytes",
      registrationId: "caller-registration-1",
      maxBytes: 16,
      expiresAt: EXPIRES_AT,
    });
    const request = {
      registrationId: "caller-registration-1",
      bytes: Uint8Array.of(1, 2, 3),
    } as const;

    const first = await ingress.ingestExtensionBytes({
      capability: firstSubject,
      ...request,
    });
    await expect(ingress.ingestExtensionBytes({
      capability: firstSubject,
      ...request,
    })).resolves.toEqual(first);
    const blocks = new BlockStore({
      referenceGraph: harness.media.referenceGraph,
      media: harness.media,
      nextBlockId: () => "block-ingress-release",
      now: () => NOW,
    });
    blocks.commitOnce("commit-ingress-release", {
      payload: {
        schema: "dolly.content/1",
        value: { items: [{ type: "media-reference", mediaId: first.mediaId }] },
      },
    }, { kind: "module", id: "module-ingress-release" });
    expect(() => ingress.releaseRegistration({
      capability: secondSubject,
      registrationId: request.registrationId,
    })).toThrowError(expect.objectContaining({ code: "MEDIA_REGISTRATION_MISSING" }));

    const second = await ingress.ingestExtensionBytes({
      capability: secondSubject,
      ...request,
    });

    expect(second.mediaId).not.toBe(first.mediaId);
    const registrations = harness.media.listRegistrations();
    expect(registrations).toHaveLength(2);
    expect(registrations[0]?.registrationId).not.toBe(registrations[1]?.registrationId);
    const registrationReferences = harness.media.referenceGraph.snapshot().strongReferences
      .filter((reference) => reference.ownerKind === "media-registration");
    expect(registrationReferences).toHaveLength(2);
    expect(new Set(registrationReferences.map((reference) => reference.ownerId)).size).toBe(2);
    expect(harness.inspect).toHaveBeenCalledTimes(2);

    expect(ingress.releaseRegistration({
      capability: firstSubject,
      registrationId: request.registrationId,
    })).toBe("released");
    expect(blocks.releaseCommitEffect("commit-ingress-release")).toBe("released");
    expect(blocks.collectUnreachable()).toHaveLength(1);

    await expect(ingress.ingestExtensionBytes({
      capability: firstSubject,
      registrationId: "not a valid id",
      bytes: Uint8Array.of(1),
    })).rejects.toMatchObject({ code: "MEDIA_INGRESS_ID_INVALID" });
  });

  it("passes only a lexically contained Windows path to the final-identity reader", async () => {
    const harness = createHarness();
    const localRead = vi.fn(async () => Uint8Array.of(1, 2));
    const reader: SecureLocalFileReader = { read: localRead };
    const ingress = new MediaIngressService({
      authority: harness.authority,
      media: harness.media,
      maxIngressBytes: 16,
      localFiles: reader,
    });
    const capability = harness.authority.issue({
      subjectId: "file-extension",
      mode: "local-file",
      registrationId: "registration-local-file",
      maxBytes: 16,
      expiresAt: EXPIRES_AT,
      localRoots: ["C:\\safe\\media"],
    });

    await expect(
      ingress.ingestLocalFile({
        capability,
        registrationId: "registration-local-file",
        candidatePath: "C:\\safe\\media\\nested\\image.png",
        declaredMimeType: "image/png",
      }),
    ).resolves.toMatchObject({
      provenance: { sourceClass: "local-file" },
    });
    expect(localRead).toHaveBeenCalledWith({
      candidatePath: "C:\\safe\\media\\nested\\image.png",
      approvedRoot: "C:\\safe\\media",
      maxBytes: 16,
    });

    const denied = [
      "C:\\safe\\media2\\image.png",
      "C:\\safe\\media\\..\\secret.png",
      "\\\\server\\share\\image.png",
      "\\\\?\\C:\\safe\\media\\image.png",
      "C:\\safe\\media\\NUL.txt",
      "C:\\safe\\media\\image.png:secret",
      "relative\\image.png",
    ];
    for (const [index, candidatePath] of denied.entries()) {
      await expect(
        ingress.ingestLocalFile({
          capability,
          registrationId: "registration-local-file",
          candidatePath,
        }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^MEDIA_LOCAL_PATH_(?:DENIED|INVALID)$/),
      });
    }
    expect(localRead).toHaveBeenCalledTimes(1);
  });

  it("uses the capability's remote policy and labels provenance without the source URL", async () => {
    const harness = createHarness();
    const remoteFetch = vi.fn(async () => ({
      bytes: Uint8Array.of(1, 2, 3),
      contentType: "image/png",
      finalOrigin: "https://images.example",
      redirects: 1,
    }));
    const ingress = new MediaIngressService({
      authority: harness.authority,
      media: harness.media,
      maxIngressBytes: 8,
      remote: { fetch: remoteFetch },
    });
    const capability = harness.authority.issue({
      subjectId: "remote-extension",
      mode: "remote-fetch",
      registrationId: "registration-remote-fetch",
      maxBytes: 16,
      expiresAt: EXPIRES_AT,
      remotePolicy,
    });

    const registeredMedia = await ingress.ingestRemoteFetch({
      capability,
      registrationId: "registration-remote-fetch",
      url: "https://images.example/private.png?credential=secret",
      owner: { ownerKind: "pin", ownerId: "forged-owner" },
    } as never);
    expect(registeredMedia).toMatchObject({
      declaredMimeType: "image/png",
      provenance: {
        sourceClass: "remote-fetch",
        sourceLabel: "https://images.example",
      },
    });
    expect(remoteFetch).toHaveBeenCalledWith(
      "https://images.example/private.png?credential=secret",
      expect.objectContaining({
        allowedHosts: ["images.example"],
        maxBytes: 8,
      }),
    );
    expect(harness.media.referenceGraph.snapshot().strongReferences).toEqual([
      {
        ownerKind: "media-registration",
        ownerId: expect.not.stringMatching(/forged-owner/),
        targetKind: "media",
        targetId: registeredMedia.mediaId,
      },
    ]);
  });

  it("checks byte limits before inspection and honors revocation and expiry", async () => {
    const harness = createHarness();
    const ingress = new MediaIngressService({
      authority: harness.authority,
      media: harness.media,
      maxIngressBytes: 4,
    });
    const bytesCapability = harness.authority.issue({
      subjectId: "uploader",
      mode: "streamed-upload",
      registrationId: "registration-over-limit",
      maxBytes: 4,
      expiresAt: EXPIRES_AT,
    });

    await expect(
      ingress.ingestStreamedUpload({
        capability: bytesCapability,
        registrationId: "registration-over-limit",
        chunks: (async function* () {
          yield Uint8Array.of(1, 2, 3, 4, 5);
        })(),
      }),
    ).rejects.toMatchObject({ code: "MEDIA_INGRESS_LIMIT" });
    expect(harness.inspect).not.toHaveBeenCalled();

    expect(harness.authority.revoke(bytesCapability.token)).toBe("revoked");
    await expect(
      ingress.ingestStreamedUpload({
        capability: bytesCapability,
        registrationId: "registration-over-limit",
        chunks: (async function* () {
          yield Uint8Array.of(1);
        })(),
      }),
    ).rejects.toMatchObject({ code: "MEDIA_CAPABILITY_DENIED" });

    const expiring = harness.authority.issue({
      subjectId: "expiring-uploader",
      mode: "streamed-upload",
      registrationId: "registration-expired",
      maxBytes: 4,
      expiresAt: "2026-07-24T00:00:01.000Z",
    });
    harness.setNow("2026-07-24T00:00:01.000Z");
    await expect(
      ingress.ingestStreamedUpload({
        capability: expiring,
        registrationId: "registration-expired",
        chunks: (async function* () {
          yield Uint8Array.of(1);
        })(),
      }),
    ).rejects.toMatchObject({ code: "MEDIA_CAPABILITY_EXPIRED" });
  });

  it("requires positive safe integer authority limits", () => {
    const create = (limits: {
      readonly maxActiveCapabilities: number;
      readonly maxConcurrentOperations: number;
      readonly maxCapabilityLifetimeMs: number;
    }) => new MediaIngressAuthority({
      nextToken: () => "capability",
      now: () => NOW,
      ...limits,
    });

    expect(() => create({
      maxActiveCapabilities: 0,
      maxConcurrentOperations: 1,
      maxCapabilityLifetimeMs: 1,
    })).toThrow(TypeError);
    expect(() => create({
      maxActiveCapabilities: 1,
      maxConcurrentOperations: Number.POSITIVE_INFINITY,
      maxCapabilityLifetimeMs: 1,
    })).toThrow(TypeError);
    expect(() => create({
      maxActiveCapabilities: 1,
      maxConcurrentOperations: 1,
      maxCapabilityLifetimeMs: 1.5,
    })).toThrow(TypeError);
  });

  it("bounds active capabilities and removes expired idle capabilities before allocating a token", () => {
    const harness = createHarness({
      maxActiveCapabilities: 1,
      maxCapabilityLifetimeMs: 1_000,
    });
    const first = harness.authority.issue({
      subjectId: "extension-a",
      mode: "extension-bytes",
      registrationId: "registration-first",
      maxBytes: 4,
      expiresAt: "2026-07-24T00:00:00.500Z",
    });
    expect(first.token).toBe("capability-1");

    expect(() => harness.authority.issue({
      subjectId: "extension-b",
      mode: "extension-bytes",
      registrationId: "registration-second",
      maxBytes: 4,
      expiresAt: "2026-07-24T00:00:00.500Z",
    })).toThrowError(expect.objectContaining({ code: "MEDIA_INGRESS_LIMIT" }));
    expect(() => harness.authority.issue({
      subjectId: "extension-b",
      mode: "extension-bytes",
      registrationId: "registration-second",
      maxBytes: 4,
      expiresAt: "2026-07-24T00:00:02.000Z",
    })).toThrowError(expect.objectContaining({ code: "MEDIA_CAPABILITY_INVALID" }));
    expect(() => harness.authority.issue({
      subjectId: "extension-b",
      mode: "extension-bytes",
      registrationId: "registration-second",
      maxBytes: 0,
      expiresAt: "2026-07-24T00:00:00.500Z",
    })).toThrowError(expect.objectContaining({ code: "MEDIA_CAPABILITY_INVALID" }));

    harness.setNow("2026-07-24T00:00:00.500Z");
    const second = harness.authority.issue({
      subjectId: "extension-b",
      mode: "extension-bytes",
      registrationId: "registration-second",
      maxBytes: 4,
      expiresAt: "2026-07-24T00:00:01.000Z",
    });
    expect(second.token).toBe("capability-2");
  });

  it("rejects concurrent use of one capability before consuming another stream and allows a sequential retry", async () => {
    const harness = createHarness({ maxConcurrentOperations: 2 });
    const ingress = new MediaIngressService({
      authority: harness.authority,
      media: harness.media,
      maxIngressBytes: 16,
    });
    const capability = harness.authority.issue({
      subjectId: "stream-uploader",
      mode: "streamed-upload",
      registrationId: "registration-stream-concurrency",
      maxBytes: 4,
      expiresAt: EXPIRES_AT,
    });
    let firstNextCalls = 0;
    let provideFirstChunk!: (result: IteratorResult<Uint8Array>) => void;
    const firstChunk = new Promise<IteratorResult<Uint8Array>>((resolve) => {
      provideFirstChunk = resolve;
    });
    const firstChunks: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<Uint8Array>> {
            firstNextCalls += 1;
            if (firstNextCalls === 1) return firstChunk;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
    const first = ingress.ingestStreamedUpload({
      capability,
      registrationId: "registration-stream-concurrency",
      chunks: firstChunks,
    });
    await vi.waitFor(() => expect(firstNextCalls).toBe(1));

    let secondStreamChunks = 0;
    const second = ingress.ingestStreamedUpload({
      capability,
      registrationId: "registration-stream-concurrency",
      chunks: (async function* () {
        secondStreamChunks += 1;
        yield Uint8Array.of(1, 2);
      })(),
    });
    await expect(second).rejects.toMatchObject({ code: "MEDIA_INGRESS_LIMIT" });
    expect(secondStreamChunks).toBe(0);

    provideFirstChunk({ done: false, value: Uint8Array.of(1, 2) });
    const registered = await first;
    await expect(ingress.ingestStreamedUpload({
      capability,
      registrationId: "registration-stream-concurrency",
      chunks: (async function* () {
        yield Uint8Array.of(1, 2);
      })(),
    })).resolves.toEqual(registered);
    expect(harness.inspect).toHaveBeenCalledOnce();
  });

  it("enforces global concurrency before starting another backend", async () => {
    const harness = createHarness({ maxConcurrentOperations: 1 });
    let finishLocalRead!: (bytes: Uint8Array) => void;
    const localRead = vi.fn(() => new Promise<Uint8Array>((resolve) => {
      finishLocalRead = resolve;
    }));
    const remoteFetch = vi.fn(async () => ({
      bytes: Uint8Array.of(2),
      contentType: "image/png",
      finalOrigin: "https://images.example",
      redirects: 0,
    }));
    const ingress = new MediaIngressService({
      authority: harness.authority,
      media: harness.media,
      maxIngressBytes: 16,
      localFiles: { read: localRead },
      remote: { fetch: remoteFetch },
    });
    const localCapability = harness.authority.issue({
      subjectId: "local-extension",
      mode: "local-file",
      registrationId: "registration-global-local",
      maxBytes: 16,
      expiresAt: EXPIRES_AT,
      localRoots: ["C:\\safe\\media"],
    });
    const remoteCapability = harness.authority.issue({
      subjectId: "remote-extension",
      mode: "remote-fetch",
      registrationId: "registration-global-remote",
      maxBytes: 16,
      expiresAt: EXPIRES_AT,
      remotePolicy,
    });
    const local = ingress.ingestLocalFile({
      capability: localCapability,
      registrationId: "registration-global-local",
      candidatePath: "C:\\safe\\media\\image.png",
    });
    await vi.waitFor(() => expect(localRead).toHaveBeenCalledOnce());

    await expect(ingress.ingestRemoteFetch({
      capability: remoteCapability,
      registrationId: "registration-global-remote",
      url: "https://images.example/image.png",
    })).rejects.toMatchObject({ code: "MEDIA_INGRESS_LIMIT" });
    expect(remoteFetch).not.toHaveBeenCalled();

    finishLocalRead(Uint8Array.of(1));
    await local;
    await expect(ingress.ingestRemoteFetch({
      capability: remoteCapability,
      registrationId: "registration-global-remote",
      url: "https://images.example/image.png",
    })).resolves.toMatchObject({ provenance: { sourceClass: "remote-fetch" } });
    expect(remoteFetch).toHaveBeenCalledOnce();
  });

  it.each(["expiry", "revoke"] as const)(
    "keeps a capability tracked during an operation after %s and releases its slots in finally",
    async (testCase) => {
      const harness = createHarness({
        maxActiveCapabilities: 1,
        maxConcurrentOperations: 1,
        maxCapabilityLifetimeMs: 1_000,
      });
      let finishRead!: (bytes: Uint8Array) => void;
      const localRead = vi.fn(() => new Promise<Uint8Array>((resolve) => {
        finishRead = resolve;
      }));
      const ingress = new MediaIngressService({
        authority: harness.authority,
        media: harness.media,
        maxIngressBytes: 16,
        localFiles: { read: localRead },
      });
      const capability = harness.authority.issue({
        subjectId: "local-extension",
        mode: "local-file",
        registrationId: `registration-${testCase}-running`,
        maxBytes: 16,
        expiresAt: "2026-07-24T00:00:00.500Z",
        localRoots: ["C:\\safe\\media"],
      });
      const running = ingress.ingestLocalFile({
        capability,
        registrationId: `registration-${testCase}-running`,
        candidatePath: "C:\\safe\\media\\image.png",
      });
      await vi.waitFor(() => expect(localRead).toHaveBeenCalledOnce());
      if (testCase === "expiry") {
        harness.setNow("2026-07-24T00:00:00.500Z");
      } else {
        expect(harness.authority.revoke(capability.token)).toBe("revoked");
      }

      expect(() => harness.authority.issue({
        subjectId: "replacement-extension",
        mode: "extension-bytes",
        registrationId: `registration-${testCase}-replacement`,
        maxBytes: 16,
        expiresAt: "2026-07-24T00:00:01.000Z",
      })).toThrowError(expect.objectContaining({ code: "MEDIA_INGRESS_LIMIT" }));

      finishRead(Uint8Array.of(1));
      await running;
      const replacement = harness.authority.issue({
        subjectId: "replacement-extension",
        mode: "extension-bytes",
        registrationId: `registration-${testCase}-replacement`,
        maxBytes: 16,
        expiresAt: "2026-07-24T00:00:01.000Z",
      });
      await expect(ingress.ingestExtensionBytes({
        capability: replacement,
        registrationId: `registration-${testCase}-replacement`,
        bytes: Uint8Array.of(2),
      })).resolves.toMatchObject({ provenance: { sourceClass: "extension-bytes" } });
    },
  );

  it("stops a streamed upload as soon as accumulated bytes exceed the effective limit", async () => {
    const harness = createHarness();
    const ingress = new MediaIngressService({
      authority: harness.authority,
      media: harness.media,
      maxIngressBytes: 16,
    });
    const capability = harness.authority.issue({
      subjectId: "stream-uploader",
      mode: "streamed-upload",
      registrationId: "registration-stream-limit",
      maxBytes: 4,
      expiresAt: EXPIRES_AT,
    });
    let yielded = 0;
    let closed = false;
    const chunks = (async function* () {
      try {
        yielded += 1;
        yield Uint8Array.of(1, 2);
        yielded += 1;
        yield Uint8Array.of(3, 4, 5);
        yielded += 1;
        yield Uint8Array.of(6);
      } finally {
        closed = true;
      }
    })();

    await expect(ingress.ingestStreamedUpload({
      capability,
      registrationId: "registration-stream-limit",
      chunks,
    })).rejects.toMatchObject({ code: "MEDIA_INGRESS_LIMIT" });
    expect(yielded).toBe(2);
    expect(closed).toBe(true);
    expect(harness.inspect).not.toHaveBeenCalled();
  });

  it("uses the minimum service, capability, and backend byte limit", async () => {
    const harness = createHarness();
    const localRead = vi.fn()
      .mockResolvedValueOnce(Uint8Array.of(1, 2, 3, 4))
      .mockResolvedValueOnce(Uint8Array.of(1, 2, 3));
    const remoteFetch = vi.fn()
      .mockResolvedValueOnce({
        bytes: Uint8Array.of(1, 2, 3),
        contentType: "image/png",
        finalOrigin: "https://images.example",
        redirects: 0,
      })
      .mockResolvedValueOnce({
        bytes: Uint8Array.of(1, 2),
        contentType: "image/png",
        finalOrigin: "https://images.example",
        redirects: 0,
      });
    const ingress = new MediaIngressService({
      authority: harness.authority,
      media: harness.media,
      maxIngressBytes: 8,
      localFiles: { read: localRead },
      remote: { fetch: remoteFetch },
    });
    const extensionCapability = harness.authority.issue({
      subjectId: "extension-bytes",
      mode: "extension-bytes",
      registrationId: "registration-extension-limit",
      maxBytes: 3,
      expiresAt: EXPIRES_AT,
    });
    await expect(ingress.ingestExtensionBytes({
      capability: extensionCapability,
      registrationId: "registration-extension-limit",
      bytes: Uint8Array.of(1, 2, 3, 4),
    })).rejects.toMatchObject({ code: "MEDIA_INGRESS_LIMIT" });
    await expect(ingress.ingestExtensionBytes({
      capability: extensionCapability,
      registrationId: "registration-extension-limit",
      bytes: Uint8Array.of(1, 2, 3),
    })).resolves.toMatchObject({ byteLength: 3 });

    const localCapability = harness.authority.issue({
      subjectId: "local-file",
      mode: "local-file",
      registrationId: "registration-local-limit",
      maxBytes: 3,
      expiresAt: EXPIRES_AT,
      localRoots: ["C:\\safe\\media"],
    });
    await expect(ingress.ingestLocalFile({
      capability: localCapability,
      registrationId: "registration-local-limit",
      candidatePath: "C:\\safe\\media\\image.png",
    })).rejects.toMatchObject({ code: "MEDIA_INGRESS_LIMIT" });
    expect(localRead).toHaveBeenNthCalledWith(1, expect.objectContaining({ maxBytes: 3 }));
    await expect(ingress.ingestLocalFile({
      capability: localCapability,
      registrationId: "registration-local-limit",
      candidatePath: "C:\\safe\\media\\image.png",
    })).resolves.toMatchObject({ byteLength: 3 });

    const remoteCapability = harness.authority.issue({
      subjectId: "remote-fetch",
      mode: "remote-fetch",
      registrationId: "registration-remote-limit",
      maxBytes: 3,
      expiresAt: EXPIRES_AT,
      remotePolicy: { ...remotePolicy, maxBytes: 2 },
    });
    await expect(ingress.ingestRemoteFetch({
      capability: remoteCapability,
      registrationId: "registration-remote-limit",
      url: "https://images.example/image.png",
    })).rejects.toMatchObject({ code: "MEDIA_INGRESS_LIMIT" });
    expect(remoteFetch).toHaveBeenNthCalledWith(
      1,
      "https://images.example/image.png",
      expect.objectContaining({ maxBytes: 2 }),
    );
    await expect(ingress.ingestRemoteFetch({
      capability: remoteCapability,
      registrationId: "registration-remote-limit",
      url: "https://images.example/image.png",
    })).resolves.toMatchObject({ byteLength: 2 });
  });
});
