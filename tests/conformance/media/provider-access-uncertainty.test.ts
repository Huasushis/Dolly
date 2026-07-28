import { describe, expect, it, vi } from "vitest";
import { BlockStore } from "../../../src/core/block-store.js";
import { ReferenceGraph } from "../../../src/core/reference-graph.js";
import {
  InMemoryMediaByteStore,
  MediaStore,
  type MediaInspector,
  type StorageAdapter,
} from "../../../src/core/media-store.js";

interface StoreFixture {
  readonly media: MediaStore;
  readonly blocks: BlockStore;
  readonly bytes: InMemoryMediaByteStore;
  readonly referenceGraph: ReferenceGraph;
  readonly adapter: StorageAdapter;
  readonly inspector: MediaInspector;
  readonly now: () => string;
  readonly allowPublicProviderUrls: boolean;
  readonly setNow: (value: string) => void;
  readonly deleteObject: ReturnType<typeof vi.fn>;
  readonly getPublicUrl: ReturnType<typeof vi.fn>;
}

function createStore(options: {
  readonly signedGet?: boolean;
  readonly publicUrl?: boolean;
  readonly allowPublicProviderUrls?: boolean;
} = {}): StoreFixture {
  let id = 0;
  let now = "2026-07-24T00:00:00.000Z";
  const deleteObject = vi.fn(async () => "deleted" as const);
  const getPublicUrl = vi.fn(
    (locator: string) => `https://public.example/${locator}`,
  );
  const adapter: StorageAdapter = {
    descriptor: {
      adapterId: "fixture-storage",
      durability: "volatile",
      signedGet: options.signedGet ?? false,
      publicUrl: options.publicUrl ?? false,
      supportsSignedCrop: false,
    },
    putOriginal: async ({ mediaId }) => ({
      locator: `objects/${mediaId}.png`,
      objectVersion: "object-version-1",
    }),
    deleteObject,
    ...(options.signedGet
      ? {
          signGet: async ({ locator }: { readonly locator: string }) =>
            `https://private.example/${locator}?Signature=redacted`,
        }
      : {}),
    ...(options.publicUrl ? { getPublicUrl } : {}),
  } as StorageAdapter;
  const inspector: MediaInspector = {
    inspect: async () => ({ mimeType: "image/png", width: 1, height: 1 }),
  };
  const referenceGraph = new ReferenceGraph();
  const bytes = new InMemoryMediaByteStore();
  const currentTime = () => now;
  const allowPublicProviderUrls = options.allowPublicProviderUrls ?? false;
  const media = new MediaStore({
    durability: "volatile",
    referenceGraph,
    bytes,
    inspector,
    adapters: [adapter],
    maxMediaBytes: 1024,
    allowPublicProviderUrls,
    idNamespace: "provider-access",
    now: currentTime,
  });
  const blocks = new BlockStore({
    referenceGraph,
    media,
    nextBlockId: () => `block-${++id}`,
    now: currentTime,
  });
  return {
    media,
    blocks,
    bytes,
    referenceGraph,
    adapter,
    inspector,
    now: currentTime,
    allowPublicProviderUrls,
    setNow: (value) => {
      now = value;
    },
    deleteObject,
    getPublicUrl,
  };
}

function restoreStore(fixture: StoreFixture): MediaStore {
  return new MediaStore({
    durability: "volatile",
    referenceGraph: new ReferenceGraph({ snapshot: fixture.referenceGraph.snapshot() }),
    bytes: fixture.bytes,
    inspector: fixture.inspector,
    adapters: [fixture.adapter],
    maxMediaBytes: 1024,
    allowPublicProviderUrls: fixture.allowPublicProviderUrls,
    idNamespace: "provider-access",
    now: fixture.now,
    snapshot: fixture.media.snapshot(),
  });
}

async function register(fixture: StoreFixture) {
  const registrationId = "registration-provider-access";
  const commitEffectId = "commit-provider-access";
  const registeredMedia = await fixture.media.registerMedia({
    registrationId,
    bytes: Uint8Array.of(1, 2, 3),
    declaredMimeType: "image/png",
    provenance: { sourceClass: "streamed-upload" },
  });
  fixture.blocks.commitOnce(commitEffectId, {
    payload: {
      schema: "dolly.content/1",
      value: { items: [{ type: "media-reference", mediaId: registeredMedia.mediaId }] },
    },
  }, { kind: "module", id: "module-provider-access" });
  return { registeredMedia, registrationId, commitEffectId };
}

function releaseRegistrationOwnership(
  fixture: StoreFixture,
  registrationId: string,
  commitEffectId: string,
): void {
  fixture.media.releaseRegistration(registrationId);
  fixture.blocks.releaseCommitEffect(commitEffectId);
  fixture.blocks.collectUnreachable();
}

describe("provider media access lifetime", () => {
  it("retains an unknown private signed fetch through URL expiry and restore", async () => {
    const fixture = createStore({ signedGet: true });
    const { media: store, setNow, deleteObject } = fixture;
    const { registeredMedia, registrationId, commitEffectId } = await register(fixture);
    await store.storeOriginal(registeredMedia.mediaId, "fixture-storage", "private");
    const grant = await store.resolveProviderAccess({
      mediaId: registeredMedia.mediaId,
      requestId: "signed-request",
      recipientId: "embedding-endpoint",
      acceptedAccessModes: ["private-signed"],
      signedUrlExpiresInSeconds: 60,
    });
    if (grant.accessMode !== "private-signed") throw new Error("Expected a private signed URL");
    releaseRegistrationOwnership(fixture, registrationId, commitEffectId);

    expect(store.recordProviderAccessOutcome({
      leaseId: grant.leaseId,
      requestId: "signed-request",
      recipientId: "embedding-endpoint",
      outcome: "fetch-status-unknown",
    })).toBe("retained");
    expect(store.listProviderAccessRecords()).toEqual([
      expect.objectContaining({
        leaseId: grant.leaseId,
        accessMode: "private-signed",
        signedUrlExpiresAt: "2026-07-24T00:01:00.000Z",
        requestStatus: "result-unknown",
      }),
    ]);
    expect(JSON.stringify(store.listProviderAccessRecords())).not.toContain("Signature");

    setNow("2026-07-24T00:01:00.000Z");
    await expect(store.collectUnreachable()).resolves.toEqual({ media: [] });

    const restored = restoreStore(fixture);
    expect(restored.listProviderAccessRecords()).toEqual([
      expect.objectContaining({
        leaseId: grant.leaseId,
        requestStatus: "result-unknown",
      }),
    ]);
    await expect(restored.collectUnreachable()).resolves.toEqual({ media: [] });

    expect(restored.recordProviderAccessOutcome({
      leaseId: grant.leaseId,
      requestId: "signed-request",
      recipientId: "embedding-endpoint",
      outcome: "finished",
    })).toBe("released");
    await expect(restored.collectUnreachable()).resolves.toEqual({
      media: [registeredMedia.mediaId],
    });
    expect(deleteObject).toHaveBeenCalledOnce();
  });

  it("requires the matching request and recipient before closing URL access", async () => {
    const fixture = createStore({ signedGet: true });
    const { media: store } = fixture;
    const { registeredMedia } = await register(fixture);
    await store.storeOriginal(registeredMedia.mediaId, "fixture-storage", "private");
    const grant = await store.resolveProviderAccess({
      mediaId: registeredMedia.mediaId,
      requestId: "matching-request",
      recipientId: "matching-recipient",
      acceptedAccessModes: ["private-signed"],
      signedUrlExpiresInSeconds: 60,
    });
    if (grant.accessMode !== "private-signed") throw new Error("Expected a private signed URL");

    expect(() => store.recordProviderAccessOutcome({
      leaseId: grant.leaseId,
      requestId: "other-request",
      recipientId: "matching-recipient",
      outcome: "finished",
    })).toThrowError(expect.objectContaining({ code: "MEDIA_ACCESS_DENIED" }));
    expect(() => store.recordProviderAccessOutcome({
      leaseId: grant.leaseId,
      requestId: "matching-request",
      recipientId: "other-recipient",
      outcome: "finished",
    })).toThrowError(expect.objectContaining({ code: "MEDIA_ACCESS_DENIED" }));
    expect(store.listProviderAccessRecords()).toHaveLength(1);

    expect(store.recordProviderAccessOutcome({
      leaseId: grant.leaseId,
      requestId: "matching-request",
      recipientId: "matching-recipient",
      outcome: "not-sent",
    })).toBe("released");
    expect(store.listProviderAccessRecords()).toEqual([]);
  });

  it("marks an unreported URL request unknown after restore without releasing it", async () => {
    const fixture = createStore({ signedGet: true });
    const { media: store } = fixture;
    const { registeredMedia, registrationId, commitEffectId } = await register(fixture);
    await store.storeOriginal(registeredMedia.mediaId, "fixture-storage", "private");
    const grant = await store.resolveProviderAccess({
      mediaId: registeredMedia.mediaId,
      requestId: "restart-request",
      recipientId: "embedding-endpoint",
      acceptedAccessModes: ["private-signed"],
      signedUrlExpiresInSeconds: 60,
    });
    if (grant.accessMode !== "private-signed") throw new Error("Expected a private signed URL");
    releaseRegistrationOwnership(fixture, registrationId, commitEffectId);

    const restored = restoreStore(fixture);
    expect(restored.listProviderAccessRecords()).toEqual([
      expect.objectContaining({ requestStatus: "awaiting-result" }),
    ]);
    expect(restored.markProviderAccessUnknownAfterRestart()).toEqual([grant.leaseId]);
    expect(restored.markProviderAccessUnknownAfterRestart()).toEqual([]);
    expect(restored.listProviderAccessRecords()).toEqual([
      expect.objectContaining({
        leaseId: grant.leaseId,
        requestStatus: "result-unknown",
      }),
    ]);
    await expect(restored.collectUnreachable()).resolves.toEqual({ media: [] });

    expect(restored.recordProviderAccessOutcome({
      leaseId: grant.leaseId,
      requestId: "restart-request",
      recipientId: "embedding-endpoint",
      outcome: "finished",
    })).toBe("released");
    await expect(restored.collectUnreachable()).resolves.toEqual({
      media: [registeredMedia.mediaId],
    });
  });

  it("rejects public URLs by default and retains an enabled public URL until finished", async () => {
    const disabled = createStore({ publicUrl: true });
    const disabledRegistration = await register(disabled);
    await disabled.media.storeOriginal(
      disabledRegistration.registeredMedia.mediaId,
      "fixture-storage",
      "public",
    );
    await expect(disabled.media.resolveProviderAccess({
      mediaId: disabledRegistration.registeredMedia.mediaId,
      requestId: "disabled-public-request",
      recipientId: "embedding-endpoint",
      acceptedAccessModes: ["public-url"],
    })).rejects.toMatchObject({ code: "MEDIA_ACCESS_UNSUPPORTED" });
    expect(disabled.getPublicUrl).not.toHaveBeenCalled();

    const fixture = createStore({ publicUrl: true, allowPublicProviderUrls: true });
    const { media: store, setNow, getPublicUrl } = fixture;
    const { registeredMedia, registrationId, commitEffectId } = await register(fixture);
    await store.storeOriginal(registeredMedia.mediaId, "fixture-storage", "public");
    const grant = await store.resolveProviderAccess({
      mediaId: registeredMedia.mediaId,
      requestId: "enabled-public-request",
      recipientId: "embedding-endpoint",
      acceptedAccessModes: ["public-url"],
    });
    if (grant.accessMode !== "public-url") throw new Error("Expected a public URL");
    expect(grant.schemaVersion).toBe("dolly.media-access-grant/5");
    expect("expiresAt" in grant).toBe(false);
    expect(getPublicUrl).toHaveBeenCalledWith(
      `objects/${registeredMedia.mediaId}.png`,
      "object-version-1",
    );
    releaseRegistrationOwnership(fixture, registrationId, commitEffectId);

    expect(store.recordProviderAccessOutcome({
      leaseId: grant.leaseId,
      requestId: "enabled-public-request",
      recipientId: "embedding-endpoint",
      outcome: "fetch-status-unknown",
    })).toBe("retained");
    setNow("2027-07-24T00:00:00.000Z");
    await expect(store.collectUnreachable()).resolves.toEqual({ media: [] });

    expect(store.recordProviderAccessOutcome({
      leaseId: grant.leaseId,
      requestId: "enabled-public-request",
      recipientId: "embedding-endpoint",
      outcome: "finished",
    })).toBe("released");
    await expect(store.collectUnreachable()).resolves.toEqual({
      media: [registeredMedia.mediaId],
    });
  });
});
