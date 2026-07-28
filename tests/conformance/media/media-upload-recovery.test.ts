import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJsonDigest,
  type JsonValue,
} from "../../../src/core/canonical-json.js";
import {
  MediaStore,
  type Media,
  type MediaByteStore,
  type MediaInspector,
  type MediaStoreSnapshot,
  type PersistentStorageAdapter,
  type StorageAdapter,
  type StorageHeadInput,
  type StorageHeadResult,
  type StoragePutIfAbsentInput,
  type StoragePutResult,
} from "../../../src/core/media-store.js";
import {
  ReferenceGraph,
  type ReferenceGraphSnapshot,
} from "../../../src/core/reference-graph.js";

const NOW = "2026-07-25T00:00:00.000Z";
const RETRY_AT = "2026-07-25T00:00:01.000Z";
const MEDIA_BYTES = Uint8Array.of(1, 2, 3, 4);
const STORAGE_NAMESPACE = {
  provider: "fixture",
  endpoint: "storage.example",
  account: "account-a",
  container: "media-a",
  prefix: "originals",
  addressingMode: "path",
} as const satisfies Readonly<Record<string, JsonValue>>;

const inspector: MediaInspector = {
  inspect: async () => ({ mimeType: "image/png", width: 2, height: 2 }),
};

class SharedPersistentByteStore implements MediaByteStore {
  readonly durability = "persistent" as const;
  readonly #values = new Map<string, Uint8Array>();

  async put(mediaId: string, bytes: Uint8Array): Promise<void> {
    if (this.#values.has(mediaId)) throw new Error(`Bytes for ${mediaId} already exist`);
    this.#values.set(mediaId, Uint8Array.from(bytes));
  }

  async get(mediaId: string): Promise<Uint8Array> {
    const bytes = this.#values.get(mediaId);
    if (!bytes) throw new Error(`Bytes for ${mediaId} do not exist`);
    return Uint8Array.from(bytes);
  }

  async delete(mediaId: string): Promise<void> {
    this.#values.delete(mediaId);
  }

  async has(mediaId: string): Promise<boolean> {
    return this.#values.has(mediaId);
  }

  overwriteForTest(mediaId: string, bytes: Uint8Array): void {
    if (!this.#values.has(mediaId)) throw new Error(`Bytes for ${mediaId} do not exist`);
    this.#values.set(mediaId, Uint8Array.from(bytes));
  }
}

type FoundObject = Extract<StorageHeadResult, { readonly status: "found" }>;

interface RemoteAdapterOptions {
  readonly adapterId?: string;
  readonly storageNamespace?: Readonly<Record<string, JsonValue>>;
  readonly objectVersioning?: "disabled" | "enabled";
  readonly objects?: Map<string, FoundObject>;
  readonly losePutResponse?: boolean;
  readonly head?: (input: StorageHeadInput) => Promise<StorageHeadResult>;
}

function remoteAdapter(options: RemoteAdapterOptions = {}) {
  const adapterId = options.adapterId ?? "remote-storage";
  const storageNamespace = options.storageNamespace ?? STORAGE_NAMESPACE;
  const objectVersioning = options.objectVersioning ?? "enabled";
  const objects = options.objects ?? new Map<string, FoundObject>();
  const planOriginal = vi.fn<PersistentStorageAdapter["planOriginal"]>(
    ({ storageRecordId }) => ({ locator: `objects/${storageRecordId}.bin` }),
  );
  const putOriginalIfAbsent = vi.fn<
    PersistentStorageAdapter["putOriginalIfAbsent"]
  >(async (input: StoragePutIfAbsentInput): Promise<StoragePutResult> => {
    if (objects.has(input.locator)) {
      throw Object.assign(new Error("Object already exists"), { status: 412 });
    }
    const number = objects.size + 1;
    const stored: FoundObject = {
      status: "found",
      storageRecordId: input.storageRecordId,
      digest: input.digest,
      byteLength: input.bytes.byteLength,
      mimeType: input.mimeType,
      storageNamespaceDigest: input.storageNamespaceDigest,
      ...(objectVersioning === "enabled"
        ? { objectVersion: `version-${number}` }
        : {}),
      entityTag: `etag-${number}`,
    };
    objects.set(input.locator, stored);
    if (options.losePutResponse) {
      throw Object.assign(new Error("simulated lost PUT response"), {
        code: "ECONNRESET",
      });
    }
    return {
      locator: input.locator,
      ...(stored.objectVersion === undefined
        ? {}
        : { objectVersion: stored.objectVersion }),
      ...(stored.entityTag === undefined ? {} : { entityTag: stored.entityTag }),
    };
  });
  const headOriginal = vi.fn<PersistentStorageAdapter["headOriginal"]>(
    options.head ?? (async ({ locator }) => objects.get(locator) ?? { status: "not-found" }),
  );
  const deleteObject = vi.fn<PersistentStorageAdapter["deleteObject"]>(async ({ locator }) =>
    objects.delete(locator) ? "deleted" : "not-found",
  );
  const adapter: PersistentStorageAdapter = {
    descriptor: {
      adapterId,
      durability: "persistent",
      signedGet: false,
      publicUrl: false,
      supportsSignedCrop: false,
      storageNamespace,
      objectVersioning,
    },
    planOriginal,
    putOriginalIfAbsent,
    headOriginal,
    deleteObject,
  };
  return {
    adapter,
    objects,
    planOriginal,
    putOriginalIfAbsent,
    headOriginal,
    deleteObject,
  };
}

interface DurableState {
  media?: MediaStoreSnapshot;
  graph?: ReferenceGraphSnapshot;
}

interface OpenStoreOptions {
  readonly bytes: MediaByteStore;
  readonly adapters?: readonly StorageAdapter[];
  readonly snapshot?: MediaStoreSnapshot;
  readonly graphSnapshot?: ReferenceGraphSnapshot;
  readonly storageRequestTimeoutMs?: number;
  readonly uploadRetryDelayMs?: (attempt: number) => number;
  readonly persist?: (
    media: MediaStoreSnapshot,
    graph: ReferenceGraphSnapshot,
  ) => void;
}

function openStore(options: OpenStoreOptions): {
  readonly store: MediaStore;
  readonly graph: ReferenceGraph;
} {
  const graph = options.graphSnapshot === undefined
    ? new ReferenceGraph()
    : new ReferenceGraph({ snapshot: options.graphSnapshot });
  let store!: MediaStore;
  store = new MediaStore({
    durability: "persistent",
    referenceGraph: graph,
    bytes: options.bytes,
    inspector,
    adapters: options.adapters ?? [],
    maxMediaBytes: 1024,
    idNamespace: "upload-recovery",
    now: () => NOW,
    ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
    ...(options.storageRequestTimeoutMs === undefined
      ? {}
      : { storageRequestTimeoutMs: options.storageRequestTimeoutMs }),
    ...(options.uploadRetryDelayMs === undefined
      ? {}
      : { uploadRetryDelayMs: options.uploadRetryDelayMs }),
    onMutation: () => options.persist?.(store.snapshot(), graph.snapshot()),
  });
  return { store, graph };
}

function saveState(
  state: DurableState,
  media: MediaStoreSnapshot,
  graph: ReferenceGraphSnapshot,
): void {
  state.media = media;
  state.graph = graph;
}

function requireState(state: DurableState): {
  readonly media: MediaStoreSnapshot;
  readonly graph: ReferenceGraphSnapshot;
} {
  if (!state.media || !state.graph) throw new Error("Durable state was not captured");
  return { media: state.media, graph: state.graph };
}

async function registerMedia(store: MediaStore, registrationId: string): Promise<Media> {
  return store.registerMedia({
    registrationId,
    bytes: MEDIA_BYTES,
    declaredMimeType: "image/png",
    provenance: { sourceClass: "streamed-upload" },
  });
}

async function createUploadingState(
  objectVersioning: "disabled" | "enabled" = "enabled",
) {
  const bytes = new SharedPersistentByteStore();
  const initialAdapter = remoteAdapter({ objectVersioning });
  const durable: DurableState = {};
  let interrupt = false;
  const { store } = openStore({
    bytes,
    adapters: [initialAdapter.adapter],
    persist: (media, graph) => {
      saveState(durable, media, graph);
      if (
        interrupt &&
        media.storageRecords.some(
          (record) => record.state === "uploading" && record.uploadAttempts === 0,
        )
      ) {
        throw new Error("simulated process exit after upload intent persistence");
      }
    },
  });
  const media = await registerMedia(store, "registration-interrupted-upload");
  interrupt = true;
  await expect(
    store.storeOriginal(media.mediaId, initialAdapter.adapter.descriptor.adapterId),
  ).rejects.toMatchObject({ code: "MEDIA_PERSISTENCE_FAILED" });

  const state = requireState(durable);
  const record = state.media.storageRecords[0];
  if (!record) throw new Error("Uploading storage record was not persisted");
  expect(record).toMatchObject({
    state: "uploading",
    uploadAttempts: 0,
    objectVersioning,
  });
  expect(state.graph.leases).toEqual([
    expect.objectContaining({
      leaseId: record.uploadLeaseId,
      kind: "storage-operation",
      targetKind: "media",
      targetId: media.mediaId,
    }),
  ]);
  expect(initialAdapter.headOriginal).not.toHaveBeenCalled();
  expect(initialAdapter.putOriginalIfAbsent).not.toHaveBeenCalled();
  return { bytes, media, record, state };
}

function matchingObject(
  state: MediaStoreSnapshot,
  record: MediaStoreSnapshot["storageRecords"][number],
  includeObjectVersion: boolean,
): FoundObject {
  const media = state.media.find((candidate) => candidate.mediaId === record.mediaId);
  if (!media || !record.storageNamespace) {
    throw new Error("Uploading snapshot is missing Media or storage namespace");
  }
  return {
    status: "found",
    storageRecordId: record.storageRecordId,
    digest: media.digest,
    byteLength: media.byteLength,
    mimeType: media.mimeType,
    storageNamespaceDigest: canonicalJsonDigest(record.storageNamespace),
    ...(includeObjectVersion ? { objectVersion: "version-existing" } : {}),
    entityTag: "etag-existing",
  };
}

describe("remote Media upload recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts an exact HEAD match after the PUT response is lost", async () => {
    const bytes = new SharedPersistentByteStore();
    const remote = remoteAdapter({ losePutResponse: true });
    const durable: DurableState = {};
    const { store, graph } = openStore({
      bytes,
      adapters: [remote.adapter],
      persist: (media, referenceGraph) => saveState(durable, media, referenceGraph),
    });
    const media = await registerMedia(store, "registration-lost-put-response");

    await expect(
      store.storeOriginal(media.mediaId, remote.adapter.descriptor.adapterId),
    ).resolves.toMatchObject({
      mediaId: media.mediaId,
      state: "available",
      uploadAttempts: 1,
    });

    expect(remote.putOriginalIfAbsent).toHaveBeenCalledOnce();
    expect(remote.headOriginal).toHaveBeenCalledTimes(2);
    expect(remote.objects).toHaveLength(1);
    expect(graph.snapshot().leases).toEqual([]);
    expect(requireState(durable).media.storageRecords).toEqual([
      expect.objectContaining({
        state: "available",
        uploadAttempts: 1,
        objectVersion: "version-1",
      }),
    ]);
  });

  it("rejects same-length byte tampering before conditional PUT", async () => {
    const bytes = new SharedPersistentByteStore();
    const remote = remoteAdapter();
    const { store } = openStore({ bytes, adapters: [remote.adapter] });
    const media = await registerMedia(store, "registration-tampered-bytes");
    bytes.overwriteForTest(media.mediaId, Uint8Array.of(4, 3, 2, 1));

    await expect(
      store.storeOriginal(media.mediaId, remote.adapter.descriptor.adapterId),
    ).rejects.toMatchObject({ code: "MEDIA_UPLOAD_FAILED" });

    expect(remote.headOriginal).toHaveBeenCalledOnce();
    expect(remote.putOriginalIfAbsent).not.toHaveBeenCalled();
    expect(remote.objects).toHaveLength(0);
    expect(store.listStorageRecords(media.mediaId)).toEqual([
      expect.objectContaining({
        state: "upload-failed",
        uploadAttempts: 0,
        uploadRetryable: false,
        lastUploadErrorCode: "MEDIA_BYTES_INVALID",
      }),
    ]);
  });

  it("recovers an uploading snapshot with HEAD only after the final state write fails", async () => {
    const bytes = new SharedPersistentByteStore();
    const firstRemote = remoteAdapter();
    const durable: DurableState = {};
    let failAvailablePersistence = false;
    const first = openStore({
      bytes,
      adapters: [firstRemote.adapter],
      persist: (media, graph) => {
        if (
          failAvailablePersistence &&
          media.storageRecords.some((record) => record.state === "available")
        ) {
          throw new Error("simulated final upload state write failure");
        }
        saveState(durable, media, graph);
      },
    });
    const media = await registerMedia(first.store, "registration-final-upload-write");
    failAvailablePersistence = true;

    await expect(
      first.store.storeOriginal(media.mediaId, firstRemote.adapter.descriptor.adapterId),
    ).rejects.toMatchObject({ code: "MEDIA_PERSISTENCE_FAILED" });
    expect(firstRemote.putOriginalIfAbsent).toHaveBeenCalledOnce();

    const state = requireState(durable);
    const pending = state.media.storageRecords[0];
    expect(pending).toMatchObject({ state: "uploading", uploadAttempts: 1 });
    expect(state.graph.leases).toEqual([
      expect.objectContaining({
        leaseId: pending?.uploadLeaseId,
        kind: "storage-operation",
        targetId: media.mediaId,
      }),
    ]);

    const recoveryRemote = remoteAdapter({ objects: firstRemote.objects });
    const restored = openStore({
      bytes,
      adapters: [recoveryRemote.adapter],
      snapshot: state.media,
      graphSnapshot: state.graph,
    });
    await expect(restored.store.recoverUploads()).resolves.toEqual({
      stored: [pending!.storageRecordId],
      canceled: [],
      failed: [],
    });
    expect(recoveryRemote.headOriginal).toHaveBeenCalledOnce();
    expect(recoveryRemote.putOriginalIfAbsent).not.toHaveBeenCalled();
    expect(restored.store.listStorageRecords(media.mediaId)).toEqual([
      expect.objectContaining({
        state: "available",
        uploadAttempts: 1,
      }),
    ]);
    expect(restored.store.snapshot().storageRecords).toEqual([
      expect.objectContaining({
        state: "available",
        uploadAttempts: 1,
        objectVersion: "version-1",
      }),
    ]);
    expect(restored.graph.snapshot().leases).toEqual([]);
  });

  it.each([
    {
      name: "changed storage namespace",
      adapters: (fixture: ReturnType<typeof remoteAdapter>) => [
        fixture.adapter,
      ],
      fixture: () => remoteAdapter({
        storageNamespace: { ...STORAGE_NAMESPACE, container: "media-b" },
      }),
      errorCode: "STORAGE_NAMESPACE_MISMATCH",
    },
    {
      name: "missing adapter",
      adapters: (_fixture: ReturnType<typeof remoteAdapter>) => [],
      fixture: () => remoteAdapter(),
      errorCode: "ADAPTER_UNAVAILABLE",
    },
  ])("retains the upload without remote I/O for $name", async ({
    adapters,
    fixture,
    errorCode,
  }) => {
    const interrupted = await createUploadingState();
    const recoveryRemote = fixture();
    const restored = openStore({
      bytes: interrupted.bytes,
      adapters: adapters(recoveryRemote),
      snapshot: interrupted.state.media,
      graphSnapshot: interrupted.state.graph,
    });

    await expect(restored.store.recoverUploads()).resolves.toEqual({
      stored: [],
      canceled: [],
      failed: [interrupted.record.storageRecordId],
    });
    expect(recoveryRemote.planOriginal).not.toHaveBeenCalled();
    expect(recoveryRemote.headOriginal).not.toHaveBeenCalled();
    expect(recoveryRemote.putOriginalIfAbsent).not.toHaveBeenCalled();
    expect(recoveryRemote.deleteObject).not.toHaveBeenCalled();
    expect(restored.store.listStorageRecords(interrupted.media.mediaId)).toEqual([
      expect.objectContaining({
        storageRecordId: interrupted.record.storageRecordId,
        state: "upload-failed",
        uploadAttempts: 0,
        uploadRetryable: false,
        lastUploadErrorCode: errorCode,
      }),
    ]);
    expect(restored.graph.snapshot().leases).toEqual([
      expect.objectContaining({
        leaseId: interrupted.record.uploadLeaseId,
        kind: "storage-operation",
      }),
    ]);
  });

  it("permanently fails when versioned storage omits the exact object version", async () => {
    const interrupted = await createUploadingState("enabled");
    const objects = new Map<string, FoundObject>([[
      interrupted.record.locator,
      matchingObject(interrupted.state.media, interrupted.record, false),
    ]]);
    const remote = remoteAdapter({ objects, objectVersioning: "enabled" });
    const restored = openStore({
      bytes: interrupted.bytes,
      adapters: [remote.adapter],
      snapshot: interrupted.state.media,
      graphSnapshot: interrupted.state.graph,
    });

    await expect(restored.store.recoverUploads()).resolves.toEqual({
      stored: [],
      canceled: [],
      failed: [interrupted.record.storageRecordId],
    });
    expect(remote.headOriginal).toHaveBeenCalledOnce();
    expect(remote.putOriginalIfAbsent).not.toHaveBeenCalled();
    expect(restored.store.listStorageRecords(interrupted.media.mediaId)).toEqual([
      expect.objectContaining({
        state: "upload-failed",
        uploadRetryable: false,
        lastUploadErrorCode: "OBJECT_METADATA_MISMATCH",
      }),
    ]);
  });

  it("does not overwrite or delete an object whose metadata does not match", async () => {
    const interrupted = await createUploadingState("enabled");
    const externalObject: FoundObject = {
      ...matchingObject(interrupted.state.media, interrupted.record, true),
      digest: `sha256:${"0".repeat(64)}`,
    };
    const objects = new Map<string, FoundObject>([[
      interrupted.record.locator,
      externalObject,
    ]]);
    const remote = remoteAdapter({ objects });
    const restored = openStore({
      bytes: interrupted.bytes,
      adapters: [remote.adapter],
      snapshot: interrupted.state.media,
      graphSnapshot: interrupted.state.graph,
    });

    await expect(restored.store.recoverUploads()).resolves.toEqual({
      stored: [],
      canceled: [],
      failed: [interrupted.record.storageRecordId],
    });
    expect(remote.headOriginal).toHaveBeenCalledOnce();
    expect(remote.putOriginalIfAbsent).not.toHaveBeenCalled();
    expect(remote.deleteObject).not.toHaveBeenCalled();
    expect(objects.get(interrupted.record.locator)).toBe(externalObject);
    expect(restored.store.listStorageRecords(interrupted.media.mediaId)).toEqual([
      expect.objectContaining({
        state: "upload-failed",
        uploadRetryable: false,
        lastUploadErrorCode: "OBJECT_METADATA_MISMATCH",
      }),
    ]);
  });

  it("cancels a never-dispatched upload without requiring its adapter", async () => {
    const interrupted = await createUploadingState("disabled");
    const restored = openStore({
      bytes: interrupted.bytes,
      adapters: [],
      snapshot: interrupted.state.media,
      graphSnapshot: interrupted.state.graph,
    });

    await expect(
      restored.store.cancelUpload(interrupted.record.storageRecordId),
    ).resolves.toBe("canceled");
    expect(restored.store.listStorageRecords(interrupted.media.mediaId)).toEqual([]);
    expect(restored.graph.snapshot().leases).toEqual([]);
  });

  it("cancels a dispatched upload only after HEAD matches and exact deletion succeeds", async () => {
    const interrupted = await createUploadingState("enabled");
    const pending = {
      ...interrupted.record,
      uploadAttempts: 1,
    };
    const snapshot = {
      ...interrupted.state.media,
      storageRecords: [pending],
    } as MediaStoreSnapshot;
    const objects = new Map<string, FoundObject>([[
      pending.locator,
      matchingObject(snapshot, pending, true),
    ]]);
    const remote = remoteAdapter({ objects, objectVersioning: "enabled" });
    const restored = openStore({
      bytes: interrupted.bytes,
      adapters: [remote.adapter],
      snapshot,
      graphSnapshot: interrupted.state.graph,
    });

    await expect(restored.store.cancelUpload(pending.storageRecordId)).resolves.toBe(
      "canceled",
    );
    expect(remote.headOriginal).toHaveBeenCalledOnce();
    expect(remote.deleteObject).toHaveBeenCalledWith(
      expect.objectContaining({
        locator: pending.locator,
        objectVersion: "version-existing",
        timeoutMs: 30_000,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(remote.deleteObject.mock.lastCall?.[0]).not.toHaveProperty("expectedEntityTag");
    expect(remote.putOriginalIfAbsent).not.toHaveBeenCalled();
    expect(objects).toHaveLength(0);
    expect(restored.store.listStorageRecords(interrupted.media.mediaId)).toEqual([]);
    expect(restored.graph.snapshot().leases).toEqual([]);
  });

  it("aborts a timed-out HEAD request and records a retryable failure", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const remote = remoteAdapter({
      head: async ({ signal }) => new Promise<StorageHeadResult>((_resolve, reject) => {
        observedSignal = signal;
        const rejectWithAbort = () => reject(signal.reason);
        if (signal.aborted) rejectWithAbort();
        else signal.addEventListener("abort", rejectWithAbort, { once: true });
      }),
    });
    const bytes = new SharedPersistentByteStore();
    const { store } = openStore({
      bytes,
      adapters: [remote.adapter],
      storageRequestTimeoutMs: 25,
      uploadRetryDelayMs: () => 1_000,
    });
    const media = await registerMedia(store, "registration-request-timeout");
    const operation = store.storeOriginal(media.mediaId, remote.adapter.descriptor.adapterId);
    const rejection = expect(operation).rejects.toMatchObject({
      code: "MEDIA_UPLOAD_FAILED",
    });
    for (let index = 0; index < 10 && remote.headOriginal.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(remote.headOriginal).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    expect(observedSignal?.aborted).toBe(true);
    expect((observedSignal?.reason as { readonly code?: string }).code).toBe(
      "STORAGE_REQUEST_TIMEOUT",
    );
    expect(remote.putOriginalIfAbsent).not.toHaveBeenCalled();
    expect(store.listStorageRecords(media.mediaId)).toEqual([
      expect.objectContaining({
        state: "upload-failed",
        uploadAttempts: 0,
        uploadRetryable: true,
        nextUploadAttemptAt: RETRY_AT,
        lastUploadErrorCode: "TRANSIENT_NETWORK",
      }),
    ]);
  });
});
