import { createHash } from "node:crypto";
import {
  assertJsonValue,
  canonicalJsonDigest,
  canonicalJsonByteLength,
  cloneJson,
  deepFreeze,
  isJsonObject,
  type JsonValue,
} from "./canonical-json.js";
import {
  parseRect,
  type MediaReferenceItem,
  type Rect,
} from "./block-content.js";
import type {
  MediaReferenceResolver,
  ResolvedMediaReference,
  SourceIdentity,
} from "./block-store.js";
import {
  ReferenceGraph,
  ReferenceGraphError,
  type AccessLease,
} from "./reference-graph.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ID_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const ID_SEQUENCE_PATTERN = /^(0|[1-9][0-9]*)$/;
const ID_SEQUENCE_LIMIT = 1n << 128n;

/**
 * Media durability states whether complete Media state survives a process
 * restart. Volatile state does not; persistent state must persist metadata,
 * reference state, and original bytes together.
 */
export type MediaDurability = "volatile" | "persistent";

export interface MediaInspection {
  readonly mimeType: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
  readonly frameCount?: number;
  readonly channels?: number;
}

export interface MediaInspector {
  inspect(bytes: Uint8Array, declaredMimeType?: string): Promise<MediaInspection>;
}

export interface MediaByteStore {
  readonly durability: MediaDurability;
  put(mediaId: string, bytes: Uint8Array): Promise<void>;
  get(mediaId: string): Promise<Uint8Array>;
  delete(mediaId: string): Promise<void>;
  has(mediaId: string): Promise<boolean>;
}

export class InMemoryMediaByteStore implements MediaByteStore {
  readonly durability = "volatile" as const;
  readonly #bytes = new Map<string, Uint8Array>();

  async put(mediaId: string, bytes: Uint8Array): Promise<void> {
    if (this.#bytes.has(mediaId)) throw new Error(`Bytes for ${mediaId} already exist`);
    this.#bytes.set(mediaId, Uint8Array.from(bytes));
  }

  async get(mediaId: string): Promise<Uint8Array> {
    const bytes = this.#bytes.get(mediaId);
    if (!bytes) throw new Error(`Bytes for ${mediaId} do not exist`);
    return Uint8Array.from(bytes);
  }

  async delete(mediaId: string): Promise<void> {
    this.#bytes.delete(mediaId);
  }

  async has(mediaId: string): Promise<boolean> {
    return this.#bytes.has(mediaId);
  }
}

export interface MediaProvenance {
  /**
   * The class of authorized source that supplied the bytes. `derived` records
   * bytes a host Media derivation produced from another Media item; it is set
   * by trusted host code, never by an untrusted caller, and does not authorize
   * anything. See `docs/spec/media-derivation.md` Section 3.
   */
  readonly sourceClass:
    | "streamed-upload"
    | "extension-bytes"
    | "local-file"
    | "remote-fetch"
    | "provider-output"
    | "derived";
  /** Optional diagnostic text. It does not grant access or establish identity. */
  readonly sourceLabel?: string;
}

/**
 * Media is one immutable user-facing media object. `mediaId` is its only
 * identity in Block content and public interfaces.
 */
export interface Media {
  readonly schemaVersion: "dolly.media/2";
  readonly mediaId: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly declaredMimeType?: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
  readonly frameCount?: number;
  readonly channels?: number;
  readonly provenance: MediaProvenance;
  readonly createdAt: string;
}

/**
 * A Media registration record is the persistent identity and progress of one
 * request to add original media bytes. It makes retries use the same
 * `mediaId` even when the process exits between the metadata and byte writes.
 */
export interface ActiveMediaRegistrationRecord {
  readonly schemaVersion: "dolly.media-registration/4";
  readonly registrationId: string;
  readonly state: "pending" | "available" | "deleting";
  /** True exactly while this record holds its registration strong reference. */
  readonly holdsRegistrationReference: boolean;
  readonly media: Media;
}

/**
 * A deleted registration record retains only the fields needed to recognize a
 * retry until `retainUntil`. After that time the registration ID may be reused.
 */
export interface DeletedMediaRegistrationRecord {
  readonly schemaVersion: "dolly.media-registration/4";
  readonly registrationId: string;
  readonly state: "deleted";
  readonly holdsRegistrationReference: false;
  readonly mediaId: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly declaredMimeType?: string;
  readonly provenance: MediaProvenance;
  readonly retainUntil: string;
}

export type MediaRegistrationRecord =
  | ActiveMediaRegistrationRecord
  | DeletedMediaRegistrationRecord;

/**
 * PixelCrop is the integer pixel rectangle sent to a storage provider. The
 * existing `Rect` type is insufficient because it stores normalized decimals.
 */
export interface PixelCrop {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface StorageAdapterDescriptorBase {
  readonly adapterId: string;
  readonly signedGet: boolean;
  readonly publicUrl: boolean;
  readonly supportsSignedCrop: boolean;
}

/** Describes an adapter whose objects vanish when the process exits. */
export interface VolatileStorageAdapterDescriptor extends StorageAdapterDescriptorBase {
  readonly durability: "volatile";
  readonly storageNamespace?: never;
  readonly objectVersioning?: never;
}

/**
 * Describes an adapter that can resume an interrupted write after restart.
 * Its namespace and versioning mode identify the exact external object space
 * whose metadata MediaStore persists.
 */
export interface PersistentStorageAdapterDescriptor extends StorageAdapterDescriptorBase {
  readonly durability: "persistent";
  /**
   * Non-secret configuration that identifies the provider, endpoint, account,
   * container, object prefix, and addressing mode used by a persistent adapter.
   * Recovery compares this value before it performs external input/output (I/O).
   */
  readonly storageNamespace: Readonly<Record<string, JsonValue>>;
  /** Whether persistent storage creates and addresses object versions. */
  readonly objectVersioning: "disabled" | "enabled";
}

/** The descriptor is discriminated by whether the adapter survives restart. */
export type StorageAdapterDescriptor =
  | VolatileStorageAdapterDescriptor
  | PersistentStorageAdapterDescriptor;

export interface StoragePutInput {
  readonly mediaId: string;
  readonly digest: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface StoragePutPlanInput {
  readonly storageRecordId: string;
  readonly mediaId: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly mimeType: string;
}

export interface StoragePutPlan {
  readonly locator: string;
}

export interface StoragePutIfAbsentInput extends StoragePutInput {
  readonly storageRecordId: string;
  readonly locator: string;
  readonly storageNamespaceDigest: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface StoragePutResult {
  readonly locator: string;
  readonly objectVersion?: string;
  readonly entityTag?: string;
}

/** Result of an HTTP HEAD request or an equivalent metadata-only read. */
export type StorageHeadResult =
  | { readonly status: "not-found" }
  | {
      readonly status: "found";
      readonly storageRecordId: string;
      readonly digest: string;
      readonly byteLength: number;
      readonly mimeType: string;
      readonly storageNamespaceDigest: string;
      readonly objectVersion?: string;
      readonly entityTag?: string;
    };

export interface StorageHeadInput {
  readonly locator: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/**
 * A persistent delete names exactly one stored object. Versioned stores delete
 * the recorded version; unversioned stores must enforce the recorded entity
 * tag. The timeout and abort signal make an interrupted request recoverable.
 */
export type PersistentStorageDeleteInput =
  | {
      readonly locator: string;
      readonly objectVersion: string;
      readonly expectedEntityTag?: never;
      readonly timeoutMs: number;
      readonly signal: AbortSignal;
    }
  | {
      readonly locator: string;
      readonly objectVersion?: never;
      readonly expectedEntityTag: string;
      readonly timeoutMs: number;
      readonly signal: AbortSignal;
    };

export interface StorageSignInput {
  readonly locator: string;
  readonly expiresInSeconds: number;
  readonly objectVersion?: string;
  readonly crop?: PixelCrop;
}

interface StorageAdapterBase {
  readonly descriptor: StorageAdapterDescriptor;
  signGet?(input: StorageSignInput): Promise<string>;
  getPublicUrl?(locator: string, objectVersion?: string): Promise<string> | string;
}

/** An adapter for bytes that are intentionally unavailable after restart. */
export interface VolatileStorageAdapter extends StorageAdapterBase {
  readonly descriptor: VolatileStorageAdapterDescriptor;
  putOriginal(input: StoragePutInput): Promise<StoragePutResult>;
  deleteObject(locator: string, objectVersion?: string): Promise<"deleted" | "not-found">;
  planOriginal?: never;
  putOriginalIfAbsent?: never;
  headOriginal?: never;
}

/**
 * An adapter for bytes that survive restart. It plans a stable locator,
 * creates only an absent object, and reconciles it with metadata before
 * MediaStore publishes the record.
 */
export interface PersistentStorageAdapter extends StorageAdapterBase {
  readonly descriptor: PersistentStorageAdapterDescriptor;
  /** Pure locator planning required before any recoverable persistent write. */
  planOriginal(input: StoragePutPlanInput): StoragePutPlan;
  /** Creates the planned object only when that locator is absent. */
  putOriginalIfAbsent(input: StoragePutIfAbsentInput): Promise<StoragePutResult>;
  /** Reads the metadata needed to reconcile a planned persistent write. */
  headOriginal(input: StorageHeadInput): Promise<StorageHeadResult>;
  deleteObject(input: PersistentStorageDeleteInput): Promise<"deleted" | "not-found">;
  /** Unconditional writes cannot provide persistent recovery semantics. */
  putOriginal?: never;
}

/** A storage adapter is either volatile or restart-recoverable, never both. */
export type StorageAdapter = VolatileStorageAdapter | PersistentStorageAdapter;

function isPersistentStorageAdapter(
  adapter: StorageAdapter,
): adapter is PersistentStorageAdapter {
  return adapter.descriptor.durability === "persistent";
}

export interface MediaStorageRecordSummary {
  readonly storageRecordId: string;
  readonly mediaId: string;
  readonly adapterId: string;
  readonly visibility: "private" | "public";
  readonly state:
    | "uploading"
    | "upload-failed"
    | "available"
    | "deleting"
    | "delete-failed";
  readonly storageNamespace?: Readonly<Record<string, JsonValue>>;
  readonly objectVersioning?: "disabled" | "enabled";
  readonly uploadAttempts: number;
  /** True after an operator asks recovery to remove or confirm absence of the planned object. */
  readonly cancelRequested?: true;
  readonly uploadRetryable?: boolean;
  readonly nextUploadAttemptAt?: string;
  readonly lastUploadErrorCode?: string;
  readonly deleteAttempts: number;
  readonly deleteRetryable?: boolean;
  readonly nextDeleteAttemptAt?: string;
  readonly lastDeleteErrorCode?: string;
}

interface MediaStorageRecord extends MediaStorageRecordSummary {
  readonly locator: string;
  readonly uploadLeaseId?: string;
  readonly objectVersion?: string;
  readonly entityTag?: string;
}

export interface MediaStorageRecordSnapshot extends MediaStorageRecord {
  readonly schemaVersion: "dolly.media-storage-record/4";
}

export interface ProviderAccessRequest {
  readonly mediaId: string;
  readonly crop?: Rect;
  /** Host-assigned identifier for one provider request. */
  readonly requestId: string;
  readonly recipientId: string;
  readonly acceptedAccessModes: readonly ("private-signed" | "public-url" | "inline")[];
  /** Required only when private signed URLs are accepted. */
  readonly signedUrlExpiresInSeconds?: number;
}

/**
 * A Media access grant is the provider-facing result of one Media access
 * request. A persisted ProviderAccessRecord is separate: it retains the
 * original Media while a remote provider may still fetch a URL, and never
 * stores the URL or inline bytes themselves.
 */
interface MediaAccessGrantBase {
  readonly schemaVersion: "dolly.media-access-grant/5";
  readonly mediaId: string;
  readonly crop?: Rect;
  readonly recipientId: string;
}

export type MediaAccessGrant =
  | (MediaAccessGrantBase & {
      readonly accessMode: "private-signed";
      readonly url: string;
      /** Identifies the retained provider access record for this URL. */
      readonly leaseId: string;
      /** The signed URL stops accepting new requests at this time. */
      readonly expiresAt: string;
    })
  | (MediaAccessGrantBase & {
      readonly accessMode: "public-url";
      readonly url: string;
      /** Identifies the retained provider access record for this URL. */
      readonly leaseId: string;
    })
  | (MediaAccessGrantBase & {
      readonly accessMode: "inline";
      readonly inline: {
        readonly encoding: "base64";
        readonly data: string;
        readonly byteLength: number;
        readonly mimeType: string;
      };
    });

type UrlMediaAccessGrant = Exclude<MediaAccessGrant, { readonly accessMode: "inline" }>;

/** The host's observed result for one provider request that received a URL. */
export type ProviderAccessOutcome =
  | "not-sent"
  | "finished"
  | "fetch-status-unknown";

/**
 * This input records an outcome for exactly one URL grant. The host must use
 * the same request and recipient identifiers that it used to create the
 * grant, so a stale result cannot close another provider request.
 */
export interface ProviderAccessOutcomeInput {
  readonly leaseId: string;
  readonly requestId: string;
  readonly recipientId: string;
  readonly outcome: ProviderAccessOutcome;
}

/**
 * One ProviderAccessRecord tracks an issued access grant and the access lease
 * that keeps its Media reachable until use is known to have ended.
 */
export interface ProviderAccessRecord {
  readonly leaseId: string;
  readonly mediaId: string;
  readonly crop?: Rect;
  /** Host-assigned identifier for the provider request that received this URL. */
  readonly requestId: string;
  readonly recipientId: string;
  readonly accessMode: UrlMediaAccessGrant["accessMode"];
  /** Present only for a private signed URL; it never releases this record. */
  readonly signedUrlExpiresAt?: string;
  /**
   * `awaiting-result` means the host has not reported the provider request's
   * result. `result-unknown` means the provider may still be fetching the URL.
   * Neither signed-URL expiry nor public URL configuration releases the record;
   * only a trusted finished result or explicit operator verification may do so.
   */
  readonly requestStatus: "awaiting-result" | "result-unknown";
}

export interface MediaStoreSnapshot {
  readonly schemaVersion: "dolly.media-store/9";
  readonly durability: MediaDurability;
  readonly idNamespace: string;
  readonly nextIdSequence: string;
  readonly registrations: readonly MediaRegistrationRecord[];
  readonly media: readonly Media[];
  readonly storageRecords: readonly MediaStorageRecordSnapshot[];
  readonly providerAccess: readonly ProviderAccessRecord[];
}

export type MediaStoreErrorCode =
  | "MEDIA_ID_INVALID"
  | "MEDIA_ID_CONFLICT"
  | "MEDIA_ID_EXHAUSTED"
  | "MEDIA_REGISTRATION_CONFLICT"
  | "MEDIA_REGISTRATION_MISSING"
  | "MEDIA_REGISTRATION_PENDING"
  | "MEDIA_REGISTRATION_DELETED"
  | "MEDIA_REGISTRATION_RELEASE_UNSAFE"
  | "MEDIA_LIMIT_EXCEEDED"
  | "MEDIA_INSPECTION_INVALID"
  | "MEDIA_MISSING"
  | "MEDIA_DELETION_IN_PROGRESS"
  | "MEDIA_CROP_INVALID"
  | "MEDIA_ADAPTER_MISSING"
  | "MEDIA_DURABILITY_UNAVAILABLE"
  | "MEDIA_STORAGE_RECOVERY_UNAVAILABLE"
  | "MEDIA_UPLOAD_FAILED"
  | "MEDIA_STORAGE_CONFLICT"
  | "MEDIA_STORAGE_INVALID"
  | "MEDIA_ACCESS_UNSUPPORTED"
  | "MEDIA_ACCESS_DENIED"
  | "MEDIA_BYTES_INVALID"
  | "MEDIA_SNAPSHOT_INVALID"
  | "MEDIA_PERSISTENCE_FAILED";

export class MediaStoreError extends Error {
  constructor(
    readonly code: MediaStoreErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "MediaStoreError";
  }
}

export interface MediaStoreOptions {
  readonly durability: MediaDurability;
  readonly referenceGraph: ReferenceGraph;
  readonly bytes: MediaByteStore;
  readonly inspector: MediaInspector;
  readonly adapters?: readonly StorageAdapter[];
  readonly maxMediaBytes: number;
  readonly maxTotalMediaBytes?: number;
  readonly maxRegistrationRecords?: number;
  readonly maxStorageRecords?: number;
  readonly maxProviderAccessRecords?: number;
  /** Public provider URLs are disabled unless the host explicitly enables them. */
  readonly allowPublicProviderUrls?: boolean;
  readonly deletedRegistrationRetentionMs?: number;
  /** Stable instance identity used as the namespace for generated Media IDs. */
  readonly idNamespace: string;
  readonly now: () => string;
  /** Retry delay in milliseconds for each failed delete attempt. */
  readonly deleteRetryDelayMs?: (attempt: number) => number;
  /** Retry delay in milliseconds for each failed upload attempt. */
  readonly uploadRetryDelayMs?: (attempt: number) => number;
  /** Maximum duration in milliseconds for one persistent storage request. */
  readonly storageRequestTimeoutMs?: number;
  readonly snapshot?: MediaStoreSnapshot;
  readonly onMutation?: () => void;
}

export interface MediaRegistrationRequest {
  readonly registrationId: string;
  readonly bytes: Uint8Array;
  readonly declaredMimeType?: string;
  readonly provenance: MediaProvenance;
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new MediaStoreError("MEDIA_ID_INVALID", `${label} is not a valid identifier`);
  }
}

function canonicalTime(now: () => string): string {
  const timestamp = Date.parse(now());
  if (!Number.isFinite(timestamp)) {
    throw new MediaStoreError("MEDIA_INSPECTION_INVALID", "Runtime clock returned invalid time");
  }
  return new Date(timestamp).toISOString();
}

interface ClassifiedDeleteError {
  readonly code: string;
  readonly retryable: boolean;
}

interface ClassifiedUploadError {
  readonly code: string;
  readonly retryable: boolean;
}

function classifyDeleteError(error: unknown): ClassifiedDeleteError {
  const candidate = error as {
    readonly code?: unknown;
    readonly status?: unknown;
    readonly statusCode?: unknown;
  };
  const status =
    typeof candidate.status === "number"
      ? candidate.status
      : typeof candidate.statusCode === "number"
        ? candidate.statusCode
        : undefined;
  const providerCode = typeof candidate.code === "string" ? candidate.code : "";
  if (providerCode === "DELETE_RESULT_INVALID") {
    return { code: "DELETE_RESULT_INVALID", retryable: false };
  }
  if (status === 401) return { code: "AUTHENTICATION_FAILED", retryable: false };
  if (status === 403 || providerCode === "AccessDenied") {
    return { code: "ACCESS_DENIED", retryable: false };
  }
  if (status === 429) return { code: "RATE_LIMITED", retryable: true };
  if (status !== undefined && status >= 500) {
    return { code: "PROVIDER_UNAVAILABLE", retryable: true };
  }
  if (
    [
      "ETIMEDOUT",
      "ECONNRESET",
      "EAI_AGAIN",
      "RequestTimeout",
      "STORAGE_REQUEST_TIMEOUT",
    ].includes(providerCode)
  ) {
    return { code: "TRANSIENT_NETWORK", retryable: true };
  }
  return { code: "DELETE_FAILED", retryable: false };
}

function defaultDeleteRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * (2 ** Math.min(Math.max(attempt - 1, 0), 6)), 60_000);
}

function defaultUploadRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * (2 ** Math.min(Math.max(attempt - 1, 0), 6)), 60_000);
}

function classifyUploadError(error: unknown): ClassifiedUploadError {
  const candidate = error as {
    readonly code?: unknown;
    readonly status?: unknown;
    readonly statusCode?: unknown;
  };
  const status =
    typeof candidate.status === "number"
      ? candidate.status
      : typeof candidate.statusCode === "number"
        ? candidate.statusCode
        : undefined;
  const providerCode = typeof candidate.code === "string" ? candidate.code : "";
  if (status === 401) return { code: "AUTHENTICATION_FAILED", retryable: false };
  if (status === 403 || providerCode === "AccessDenied") {
    return { code: "ACCESS_DENIED", retryable: false };
  }
  if (status === 409 || status === 412) {
    return { code: "OBJECT_ALREADY_EXISTS", retryable: false };
  }
  if (status === 429) return { code: "RATE_LIMITED", retryable: true };
  if (status !== undefined && status >= 500) {
    return { code: "PROVIDER_UNAVAILABLE", retryable: true };
  }
  if (
    [
      "ETIMEDOUT",
      "ECONNRESET",
      "EAI_AGAIN",
      "RequestTimeout",
      "STORAGE_REQUEST_TIMEOUT",
    ].includes(providerCode)
  ) {
    return { code: "TRANSIENT_NETWORK", retryable: true };
  }
  return { code: "UPLOAD_FAILED", retryable: false };
}

function normalizeStorageNamespace(
  value: unknown,
): Readonly<Record<string, JsonValue>> {
  try {
    assertJsonValue(value);
  } catch {
    throw new MediaStoreError(
      "MEDIA_STORAGE_INVALID",
      "Storage namespace must contain only canonical JSON values",
    );
  }
  if (!isJsonObject(value) || Object.keys(value).length === 0) {
    throw new MediaStoreError(
      "MEDIA_STORAGE_INVALID",
      "Storage namespace must be a non-empty object",
    );
  }
  if (canonicalJsonByteLength(value) > 16 * 1024) {
    throw new MediaStoreError(
      "MEDIA_STORAGE_INVALID",
      "Storage namespace exceeds 16384 UTF-8 bytes",
    );
  }
  return deepFreeze(cloneJson(value));
}

function validateOptionalPositiveInteger(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new MediaStoreError(
      "MEDIA_INSPECTION_INVALID",
      `${label} must be a positive safe integer when present`,
    );
  }
}

function registrationReference(registrationId: string, mediaId: string) {
  return {
    ownerKind: "media-registration" as const,
    ownerId: registrationId,
    targetKind: "media" as const,
    targetId: mediaId,
  };
}

function rectToPixelCrop(
  rect: Rect,
  imageWidth: number,
  imageHeight: number,
): PixelCrop | null {
  const left = Math.round(rect.topLeft.x * imageWidth);
  const top = Math.round(rect.topLeft.y * imageHeight);
  const right = Math.round(rect.bottomRight.x * imageWidth);
  const bottom = Math.round(rect.bottomRight.y * imageHeight);
  if (
    left < 0 ||
    top < 0 ||
    right > imageWidth ||
    bottom > imageHeight ||
    right - left < 1 ||
    bottom - top < 1
  ) {
    return null;
  }
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

function assertSnapshotObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MediaStoreError("MEDIA_SNAPSHOT_INVALID", `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MediaStoreError("MEDIA_SNAPSHOT_INVALID", `${label} must be a plain object`);
  }
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new MediaStoreError("MEDIA_SNAPSHOT_INVALID", `${label} contains unknown fields`);
  }
}

function assertCanonicalTimestamp(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new MediaStoreError(
      "MEDIA_SNAPSHOT_INVALID",
      `${label} is not a canonical timestamp`,
    );
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new MediaStoreError("MEDIA_SNAPSHOT_INVALID", `${label} is not a valid digest`);
  }
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function normalizeProvenance(value: MediaProvenance): MediaProvenance {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MediaStoreError(
      "MEDIA_INSPECTION_INVALID",
      "Media provenance must be a plain object",
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MediaStoreError(
      "MEDIA_INSPECTION_INVALID",
      "Media provenance must be a plain object",
    );
  }
  if (Object.keys(value).some((key) => key !== "sourceClass" && key !== "sourceLabel")) {
    throw new MediaStoreError(
      "MEDIA_INSPECTION_INVALID",
      "Media provenance contains unknown fields",
    );
  }
  if (
    value.sourceClass !== "streamed-upload" &&
    value.sourceClass !== "extension-bytes" &&
    value.sourceClass !== "local-file" &&
    value.sourceClass !== "remote-fetch" &&
    value.sourceClass !== "provider-output" &&
    value.sourceClass !== "derived"
  ) {
    throw new MediaStoreError(
      "MEDIA_INSPECTION_INVALID",
      "Media provenance sourceClass is invalid",
    );
  }
  if (
    value.sourceLabel !== undefined &&
    (typeof value.sourceLabel !== "string" ||
      value.sourceLabel.length === 0 ||
      value.sourceLabel.length > 512)
  ) {
    throw new MediaStoreError(
      "MEDIA_INSPECTION_INVALID",
      "Media provenance sourceLabel is invalid",
    );
  }
  return deepFreeze({
    sourceClass: value.sourceClass,
    ...(value.sourceLabel === undefined ? {} : { sourceLabel: value.sourceLabel }),
  });
}

function sameProvenance(left: MediaProvenance, right: MediaProvenance): boolean {
  return left.sourceClass === right.sourceClass && left.sourceLabel === right.sourceLabel;
}

function restoreMediaRecord(candidate: Media, maxMediaBytes: number, label: string): Media {
  assertSnapshotObject(
    candidate,
    [
      "schemaVersion",
      "mediaId",
      "digest",
      "byteLength",
      "mimeType",
      "declaredMimeType",
      "width",
      "height",
      "durationMs",
      "frameCount",
      "channels",
      "provenance",
      "createdAt",
    ],
    label,
  );
  if (
    candidate.schemaVersion !== "dolly.media/2" ||
    typeof candidate.mediaId !== "string" ||
    !ID_PATTERN.test(candidate.mediaId) ||
    !Number.isSafeInteger(candidate.byteLength) ||
    candidate.byteLength <= 0 ||
    candidate.byteLength > maxMediaBytes ||
    typeof candidate.mimeType !== "string" ||
    !MIME_PATTERN.test(candidate.mimeType) ||
    (candidate.declaredMimeType !== undefined &&
      (typeof candidate.declaredMimeType !== "string" ||
        !MIME_PATTERN.test(candidate.declaredMimeType)))
  ) {
    throw new MediaStoreError("MEDIA_SNAPSHOT_INVALID", `${label} is invalid`);
  }
  assertDigest(candidate.digest, `${label}.digest`);
  validateOptionalPositiveInteger(candidate.width, "width");
  validateOptionalPositiveInteger(candidate.height, "height");
  validateOptionalPositiveInteger(candidate.durationMs, "durationMs");
  validateOptionalPositiveInteger(candidate.frameCount, "frameCount");
  validateOptionalPositiveInteger(candidate.channels, "channels");
  if ((candidate.width === undefined) !== (candidate.height === undefined)) {
    throw new MediaStoreError(
      "MEDIA_SNAPSHOT_INVALID",
      `${label} image dimensions are incomplete`,
    );
  }
  assertSnapshotObject(candidate.provenance, ["sourceClass", "sourceLabel"], `${label} provenance`);
  if (
    candidate.provenance.sourceClass !== "streamed-upload" &&
    candidate.provenance.sourceClass !== "extension-bytes" &&
    candidate.provenance.sourceClass !== "local-file" &&
    candidate.provenance.sourceClass !== "remote-fetch" &&
    candidate.provenance.sourceClass !== "provider-output" &&
    candidate.provenance.sourceClass !== "derived"
  ) {
    throw new MediaStoreError(
      "MEDIA_SNAPSHOT_INVALID",
      `${label} provenance class is invalid`,
    );
  }
  if (
    candidate.provenance.sourceLabel !== undefined &&
    (typeof candidate.provenance.sourceLabel !== "string" ||
      candidate.provenance.sourceLabel.length === 0 ||
      candidate.provenance.sourceLabel.length > 512)
  ) {
    throw new MediaStoreError(
      "MEDIA_SNAPSHOT_INVALID",
      `${label} provenance label is invalid`,
    );
  }
  assertCanonicalTimestamp(candidate.createdAt, `${label}.createdAt`);
  return deepFreeze({
    schemaVersion: "dolly.media/2" as const,
    mediaId: candidate.mediaId,
    digest: candidate.digest,
    byteLength: candidate.byteLength,
    mimeType: candidate.mimeType,
    ...(candidate.declaredMimeType === undefined
      ? {}
      : { declaredMimeType: candidate.declaredMimeType }),
    ...(candidate.width === undefined ? {} : { width: candidate.width }),
    ...(candidate.height === undefined ? {} : { height: candidate.height }),
    ...(candidate.durationMs === undefined ? {} : { durationMs: candidate.durationMs }),
    ...(candidate.frameCount === undefined ? {} : { frameCount: candidate.frameCount }),
    ...(candidate.channels === undefined ? {} : { channels: candidate.channels }),
    provenance: {
      sourceClass: candidate.provenance.sourceClass,
      ...(candidate.provenance.sourceLabel === undefined
        ? {}
        : { sourceLabel: candidate.provenance.sourceLabel }),
    },
    createdAt: candidate.createdAt,
  });
}

export class MediaStore implements MediaReferenceResolver {
  readonly #durability: MediaDurability;
  readonly #bytes: MediaByteStore;
  readonly #inspector: MediaInspector;
  readonly #maxMediaBytes: number;
  readonly #maxTotalMediaBytes: number;
  readonly #maxRegistrationRecords: number;
  readonly #maxStorageRecords: number;
  readonly #maxProviderAccessRecords: number;
  readonly #allowPublicProviderUrls: boolean;
  readonly #deletedRegistrationRetentionMs: number;
  readonly #idNamespace: string;
  #nextIdSequence = 0n;
  readonly #now: () => string;
  readonly #deleteRetryDelayMs: (attempt: number) => number;
  readonly #uploadRetryDelayMs: (attempt: number) => number;
  readonly #storageRequestTimeoutMs: number;
  readonly #registrations = new Map<string, MediaRegistrationRecord>();
  readonly #media = new Map<string, Media>();
  readonly #adapters = new Map<string, StorageAdapter>();
  readonly #storageRecords = new Map<string, MediaStorageRecord>();
  readonly #storageOperationTails = new Map<string, Promise<void>>();
  /**
   * A persistent delete call can outlive Dolly's timeout when its adapter
   * ignores AbortSignal. Keep that storage record here until the adapter
   * promise settles so deletion recovery cannot start an overlapping call.
   */
  readonly #activeStorageDeleteRequests = new Set<string>();
  readonly #registrationOperationTails = new Map<string, Promise<void>>();
  readonly #deletingMediaIds = new Set<string>();
  readonly #providerAccess = new Map<string, ProviderAccessRecord>();
  #registrationRecordReservations = 0;
  #mediaByteReservations = 0;
  #storageRecordReservations = 0;
  #providerAccessReservations = 0;
  readonly referenceGraph: ReferenceGraph;
  #onMutation: (() => void) | undefined;
  #persistenceDirty = false;
  #notifyingMutation = false;

  constructor(options: MediaStoreOptions) {
    if (!Number.isSafeInteger(options.maxMediaBytes) || options.maxMediaBytes <= 0) {
      throw new TypeError("maxMediaBytes must be a positive safe integer");
    }
    if (
      (options.durability !== "volatile" && options.durability !== "persistent") ||
      options.bytes.durability !== options.durability ||
      (options.durability === "persistent" && options.onMutation === undefined)
    ) {
      throw new MediaStoreError(
        "MEDIA_DURABILITY_UNAVAILABLE",
        "Media durability requires matching metadata, reference, and byte storage",
        {
          durability: options.durability,
          byteStoreDurability: options.bytes.durability,
        },
      );
    }
    this.#durability = options.durability;
    this.referenceGraph = options.referenceGraph;
    this.#bytes = options.bytes;
    this.#inspector = options.inspector;
    this.#maxMediaBytes = options.maxMediaBytes;
    const defaultTotalMediaBytes = options.maxMediaBytes > Number.MAX_SAFE_INTEGER / 1_000
      ? Number.MAX_SAFE_INTEGER
      : options.maxMediaBytes * 1_000;
    this.#maxTotalMediaBytes = options.maxTotalMediaBytes ?? defaultTotalMediaBytes;
    this.#maxRegistrationRecords = options.maxRegistrationRecords ?? 10_000;
    this.#maxStorageRecords = options.maxStorageRecords ?? 10_000;
    this.#maxProviderAccessRecords = options.maxProviderAccessRecords ?? 10_000;
    if (
      options.allowPublicProviderUrls !== undefined &&
      typeof options.allowPublicProviderUrls !== "boolean"
    ) {
      throw new TypeError("allowPublicProviderUrls must be a boolean");
    }
    this.#allowPublicProviderUrls = options.allowPublicProviderUrls ?? false;
    this.#deletedRegistrationRetentionMs =
      options.deletedRegistrationRetentionMs ?? 24 * 60 * 60 * 1_000;
    for (const [label, value, allowZero] of [
      ["maxTotalMediaBytes", this.#maxTotalMediaBytes, false],
      ["maxRegistrationRecords", this.#maxRegistrationRecords, false],
      ["maxStorageRecords", this.#maxStorageRecords, false],
      ["maxProviderAccessRecords", this.#maxProviderAccessRecords, false],
      ["deletedRegistrationRetentionMs", this.#deletedRegistrationRetentionMs, true],
    ] as const) {
      if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
        throw new TypeError(`${label} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
      }
    }
    if (this.#maxTotalMediaBytes < this.#maxMediaBytes) {
      throw new TypeError("maxTotalMediaBytes cannot be smaller than maxMediaBytes");
    }
    if (!ID_NAMESPACE_PATTERN.test(options.idNamespace)) {
      throw new TypeError(
        "idNamespace must contain 1 to 64 ASCII letters, digits, dots, underscores, or hyphens",
      );
    }
    this.#idNamespace = options.idNamespace;
    this.#now = options.now;
    if (
      options.deleteRetryDelayMs !== undefined &&
      typeof options.deleteRetryDelayMs !== "function"
    ) {
      throw new TypeError("deleteRetryDelayMs must be a function");
    }
    this.#deleteRetryDelayMs = options.deleteRetryDelayMs ?? defaultDeleteRetryDelayMs;
    if (
      options.uploadRetryDelayMs !== undefined &&
      typeof options.uploadRetryDelayMs !== "function"
    ) {
      throw new TypeError("uploadRetryDelayMs must be a function");
    }
    this.#uploadRetryDelayMs = options.uploadRetryDelayMs ?? defaultUploadRetryDelayMs;
    this.#storageRequestTimeoutMs = options.storageRequestTimeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.#storageRequestTimeoutMs) ||
      this.#storageRequestTimeoutMs <= 0
    ) {
      throw new TypeError("storageRequestTimeoutMs must be a positive safe integer");
    }
    this.#onMutation = options.onMutation;
    for (const adapter of options.adapters ?? []) {
      if (
        adapter === null ||
        typeof adapter !== "object" ||
        adapter.descriptor === null ||
        typeof adapter.descriptor !== "object" ||
        Array.isArray(adapter.descriptor) ||
        typeof adapter.descriptor.adapterId !== "string"
      ) {
        throw new MediaStoreError(
          "MEDIA_STORAGE_INVALID",
          "A storage adapter must expose a descriptor with an adapter identifier",
        );
      }
      assertId(adapter.descriptor.adapterId, "adapterId");
      if (
        (adapter.descriptor.durability !== "volatile" &&
          adapter.descriptor.durability !== "persistent") ||
        adapter.descriptor.durability !== this.#durability
      ) {
        throw new MediaStoreError(
          "MEDIA_DURABILITY_UNAVAILABLE",
          "A storage adapter must have the same durability as its MediaStore",
          {
            adapterId: adapter.descriptor.adapterId,
            mediaDurability: this.#durability,
            adapterDurability: adapter.descriptor.durability,
          },
        );
      }
      if (
        typeof adapter.descriptor.signedGet !== "boolean" ||
        typeof adapter.descriptor.publicUrl !== "boolean" ||
        typeof adapter.descriptor.supportsSignedCrop !== "boolean" ||
        (adapter.descriptor.signedGet && typeof adapter.signGet !== "function") ||
        (!adapter.descriptor.signedGet && adapter.signGet !== undefined) ||
        (adapter.descriptor.publicUrl && typeof adapter.getPublicUrl !== "function") ||
        (!adapter.descriptor.publicUrl && adapter.getPublicUrl !== undefined)
      ) {
        throw new MediaStoreError(
          "MEDIA_STORAGE_INVALID",
          "Storage adapter capabilities must match its descriptor and expose the declared methods",
          { adapterId: adapter.descriptor.adapterId },
        );
      }
      if (isPersistentStorageAdapter(adapter)) {
        try {
          normalizeStorageNamespace(adapter.descriptor.storageNamespace);
        } catch {
          throw new MediaStoreError(
            "MEDIA_STORAGE_INVALID",
            "Persistent storage adapters require a valid storage namespace",
            { adapterId: adapter.descriptor.adapterId },
          );
        }
        if (
          (adapter.descriptor.objectVersioning !== "disabled" &&
            adapter.descriptor.objectVersioning !== "enabled") ||
          typeof adapter.planOriginal !== "function" ||
          typeof adapter.putOriginalIfAbsent !== "function" ||
          typeof adapter.headOriginal !== "function" ||
          typeof adapter.deleteObject !== "function" ||
          (adapter as { readonly putOriginal?: unknown }).putOriginal !== undefined
        ) {
          throw new MediaStoreError(
            "MEDIA_STORAGE_RECOVERY_UNAVAILABLE",
            "Persistent Media storage requires locator planning, conditional create, metadata reconciliation, exact deletion, and an explicit object-versioning mode",
            { adapterId: adapter.descriptor.adapterId },
          );
        }
      } else if (
        adapter.descriptor.storageNamespace !== undefined ||
        adapter.descriptor.objectVersioning !== undefined ||
        adapter.planOriginal !== undefined ||
        adapter.putOriginalIfAbsent !== undefined ||
        adapter.headOriginal !== undefined ||
        typeof adapter.putOriginal !== "function" ||
        typeof adapter.deleteObject !== "function"
      ) {
        throw new MediaStoreError(
          "MEDIA_STORAGE_INVALID",
          "Volatile storage adapters cannot declare persistent recovery operations",
          { adapterId: adapter.descriptor.adapterId },
        );
      }
      if (
        adapter.descriptor.supportsSignedCrop &&
        (!adapter.descriptor.signedGet || adapter.signGet === undefined)
      ) {
        throw new MediaStoreError(
          "MEDIA_STORAGE_INVALID",
          `Storage adapter ${adapter.descriptor.adapterId} cannot sign cropped access`,
        );
      }
      if (this.#adapters.has(adapter.descriptor.adapterId)) {
        throw new MediaStoreError(
          "MEDIA_ID_CONFLICT",
          `Storage adapter ${adapter.descriptor.adapterId} is duplicated`,
        );
      }
      this.#adapters.set(adapter.descriptor.adapterId, adapter);
    }
    if (options.snapshot) this.#restore(options.snapshot);
  }

  setMutationObserver(observer: (() => void) | undefined): void {
    if (observer !== undefined && typeof observer !== "function") {
      throw new TypeError("MediaStore mutation observer must be a function");
    }
    if (this.#durability === "persistent" && observer === undefined) {
      throw new MediaStoreError(
        "MEDIA_DURABILITY_UNAVAILABLE",
        "A persistent MediaStore cannot remove its metadata persistence observer",
      );
    }
    this.#onMutation = observer;
  }

  flushPersistence(): void {
    if (!this.#persistenceDirty || !this.#onMutation) return;
    this.#notifyMutationObserver();
  }

  snapshot(): MediaStoreSnapshot {
    const registrations = [...this.#registrations.values()].sort((left, right) =>
      left.registrationId.localeCompare(right.registrationId),
    );
    const media = [...this.#media.values()].sort((left, right) =>
      left.mediaId.localeCompare(right.mediaId),
    );
    const storageRecords = [...this.#storageRecords.values()]
      .map((storageRecord) => ({
        schemaVersion: "dolly.media-storage-record/4" as const,
        ...storageRecord,
      }))
      .sort((left, right) => left.storageRecordId.localeCompare(right.storageRecordId));
    const providerAccess = [...this.#providerAccess.values()].sort((left, right) =>
      left.leaseId.localeCompare(right.leaseId),
    );
    return deepFreeze({
      schemaVersion: "dolly.media-store/9" as const,
      durability: this.#durability,
      idNamespace: this.#idNamespace,
      nextIdSequence: this.#nextIdSequence.toString(10),
      registrations,
      media,
      storageRecords,
      providerAccess,
    });
  }

  async registerMedia(input: MediaRegistrationRequest): Promise<Media> {
    if (arguments.length !== 1) {
      throw new MediaStoreError(
        "MEDIA_INSPECTION_INVALID",
        "Media registration accepts one request object and no additional arguments",
      );
    }
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null) ||
      Object.keys(input).some((key) =>
        key !== "registrationId" &&
        key !== "bytes" &&
        key !== "declaredMimeType" &&
        key !== "provenance",
      )
    ) {
      throw new MediaStoreError(
        "MEDIA_INSPECTION_INVALID",
        "Media registration must be a plain object with only supported fields",
      );
    }
    assertId(input.registrationId, "registrationId");
    if (!(input.bytes instanceof Uint8Array)) {
      throw new MediaStoreError("MEDIA_INSPECTION_INVALID", "Media bytes must be Uint8Array");
    }
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > this.#maxMediaBytes) {
      throw new MediaStoreError(
        "MEDIA_LIMIT_EXCEEDED",
        `Media byte length must be between 1 and ${this.#maxMediaBytes}`,
      );
    }
    if (input.declaredMimeType !== undefined && !MIME_PATTERN.test(input.declaredMimeType)) {
      throw new MediaStoreError(
        "MEDIA_INSPECTION_INVALID",
        "declaredMimeType is not a valid MIME type",
      );
    }
    const bytes = Uint8Array.from(input.bytes);
    const digest = digestBytes(bytes);
    const provenance = normalizeProvenance(input.provenance);

    return this.#runRegistrationOperation(input.registrationId, async () => {
      this.flushPersistence();
      this.#removeExpiredDeletedRegistrations();
      const existing = this.#registrations.get(input.registrationId);
      if (existing) {
        this.#assertSameRegistrationInput(
          existing,
          digest,
          bytes.byteLength,
          input.declaredMimeType,
          provenance,
        );
        if (existing.state === "deleted") {
          throw new MediaStoreError(
            "MEDIA_REGISTRATION_DELETED",
            `Media registration ${input.registrationId} refers to deleted Media`,
            { registrationId: input.registrationId, mediaId: existing.mediaId },
          );
        }
        if (existing.state === "deleting") {
          throw new MediaStoreError(
            "MEDIA_DELETION_IN_PROGRESS",
            `Media ${existing.media.mediaId} is being deleted`,
            { mediaId: existing.media.mediaId },
          );
        }
        if (existing.state === "available") {
          if (this.#deletingMediaIds.has(existing.media.mediaId)) {
            throw new MediaStoreError(
              "MEDIA_DELETION_IN_PROGRESS",
              `Media ${existing.media.mediaId} is being deleted`,
              { mediaId: existing.media.mediaId },
            );
          }
          const media = this.#media.get(existing.media.mediaId);
          if (!media || canonicalJsonDigest(media) !== canonicalJsonDigest(existing.media)) {
            throw new MediaStoreError(
              "MEDIA_SNAPSHOT_INVALID",
              "Available Media registration does not match Media state",
            );
          }
          return media;
        }
        await this.#ensureRegistrationBytes(existing, bytes);
        return this.#completeRegistration(existing);
      }

      this.#assertLimit(
        "maxRegistrationRecords",
        this.#maxRegistrationRecords,
        this.#registrations.size + this.#registrationRecordReservations,
        1,
      );
      this.#assertLimit(
        "maxTotalMediaBytes",
        this.#maxTotalMediaBytes,
        this.#totalStoredMediaBytes() + this.#mediaByteReservations,
        bytes.byteLength,
      );
      this.#registrationRecordReservations += 1;
      this.#mediaByteReservations += bytes.byteLength;
      let capacityReserved = true;

      try {
        const inspection = await this.#inspector.inspect(bytes, input.declaredMimeType);
        if (!MIME_PATTERN.test(inspection.mimeType)) {
          throw new MediaStoreError(
            "MEDIA_INSPECTION_INVALID",
            "Inspector returned an invalid detected MIME type",
          );
        }
        validateOptionalPositiveInteger(inspection.width, "width");
        validateOptionalPositiveInteger(inspection.height, "height");
        validateOptionalPositiveInteger(inspection.durationMs, "durationMs");
        validateOptionalPositiveInteger(inspection.frameCount, "frameCount");
        validateOptionalPositiveInteger(inspection.channels, "channels");
        if ((inspection.width === undefined) !== (inspection.height === undefined)) {
          throw new MediaStoreError(
            "MEDIA_INSPECTION_INVALID",
            "Image dimensions must contain both width and height",
          );
        }

        const mediaId = this.#allocate("media");
        const media: Media = deepFreeze({
          schemaVersion: "dolly.media/2" as const,
          mediaId,
          digest,
          byteLength: bytes.byteLength,
          mimeType: inspection.mimeType,
          ...(input.declaredMimeType === undefined
            ? {}
            : { declaredMimeType: input.declaredMimeType }),
          ...(inspection.width === undefined ? {} : { width: inspection.width }),
          ...(inspection.height === undefined ? {} : { height: inspection.height }),
          ...(inspection.durationMs === undefined
            ? {}
            : { durationMs: inspection.durationMs }),
          ...(inspection.frameCount === undefined ? {} : { frameCount: inspection.frameCount }),
          ...(inspection.channels === undefined ? {} : { channels: inspection.channels }),
          provenance,
          createdAt: canonicalTime(this.#now),
        });
        const registration: MediaRegistrationRecord = deepFreeze({
          schemaVersion: "dolly.media-registration/4" as const,
          registrationId: input.registrationId,
          state: "pending" as const,
          holdsRegistrationReference: false,
          media,
        });
        this.#registrations.set(registration.registrationId, registration);
        this.#registrationRecordReservations -= 1;
        this.#mediaByteReservations -= bytes.byteLength;
        capacityReserved = false;
        this.#persistMutation();
        await this.#ensureRegistrationBytes(registration, bytes);
        return this.#completeRegistration(registration);
      } finally {
        if (capacityReserved) {
          this.#registrationRecordReservations -= 1;
          this.#mediaByteReservations -= bytes.byteLength;
        }
      }
    });
  }

  listRegistrations(): readonly MediaRegistrationRecord[] {
    this.flushPersistence();
    return deepFreeze([...this.#registrations.values()].sort((left, right) =>
      left.registrationId.localeCompare(right.registrationId),
    ));
  }

  removeExpiredDeletedRegistrations(): readonly string[] {
    this.flushPersistence();
    return this.#removeExpiredDeletedRegistrations();
  }

  async recoverRegistrations(): Promise<{
    readonly completed: readonly string[];
    readonly pending: readonly string[];
  }> {
    this.flushPersistence();
    const completed: string[] = [];
    const pending: string[] = [];
    for (const registration of [...this.#registrations.values()].sort((left, right) =>
      left.registrationId.localeCompare(right.registrationId),
    )) {
      if (registration.state !== "pending") continue;
      await this.#runRegistrationOperation(registration.registrationId, async () => {
        const current = this.#registrations.get(registration.registrationId);
        if (!current || current.state !== "pending") return;
        const hasBytes = await this.#hasRegistrationBytes(current);
        if (!hasBytes) {
          pending.push(current.registrationId);
          return;
        }
        await this.#validateStoredRegistrationBytes(current);
        this.#completeRegistration(current);
        completed.push(current.registrationId);
      });
    }
    return deepFreeze({ completed, pending });
  }

  releaseRegistration(
    registrationId: string,
  ): "released" | "already-released" {
    this.flushPersistence();
    assertId(registrationId, "registrationId");
    const registration = this.#registrations.get(registrationId);
    if (!registration) {
      throw new MediaStoreError(
        "MEDIA_REGISTRATION_MISSING",
        `Media registration ${registrationId} does not exist`,
        { registrationId },
      );
    }
    if (registration.state === "pending") {
      throw new MediaStoreError(
        "MEDIA_REGISTRATION_PENDING",
        `Media registration ${registrationId} has not completed`,
        { registrationId, mediaId: registration.media.mediaId },
      );
    }
    if (registration.state === "deleting") {
      throw new MediaStoreError(
        "MEDIA_DELETION_IN_PROGRESS",
        `Media ${registration.media.mediaId} is being deleted`,
        { mediaId: registration.media.mediaId },
      );
    }
    if (registration.state === "deleted") {
      throw new MediaStoreError(
        "MEDIA_REGISTRATION_DELETED",
        `Media registration ${registrationId} refers to deleted Media`,
        { registrationId, mediaId: registration.mediaId },
      );
    }
    if (!registration.holdsRegistrationReference) return "already-released";

    const reference = registrationReference(registrationId, registration.media.mediaId);
    if (this.referenceGraph.removeStrongReference(reference) !== "removed") {
      throw new MediaStoreError(
        "MEDIA_SNAPSHOT_INVALID",
        "Media registration is missing its strong reference",
      );
    }
    if (!this.referenceGraph.isReachableFromStrongReference({
      kind: "media",
      id: registration.media.mediaId,
    })) {
      this.referenceGraph.addStrongReference(reference);
      throw new MediaStoreError(
        "MEDIA_REGISTRATION_RELEASE_UNSAFE",
        "Media registration cannot release the only persistent strong-reference path",
        { registrationId, mediaId: registration.media.mediaId },
      );
    }
    this.#registrations.set(registrationId, deepFreeze({
      ...registration,
      holdsRegistrationReference: false,
    }));
    this.#persistMutation();
    return "released";
  }

  getMedia(mediaId: string): Media | null {
    this.flushPersistence();
    return this.#media.get(mediaId) ?? null;
  }

  async verifyStoredBytes(): Promise<void> {
    this.flushPersistence();
    for (const media of this.#media.values()) {
      if (this.#registrationForMedia(media.mediaId)?.state === "deleting") continue;
      await this.#readVerifiedMediaBytes(media);
    }
  }

  async #readVerifiedMediaBytes(media: Media): Promise<Uint8Array> {
    let bytes: Uint8Array;
    try {
      bytes = await this.#bytes.get(media.mediaId);
    } catch {
      throw new MediaStoreError(
        "MEDIA_BYTES_INVALID",
        `Stored bytes for Media ${media.mediaId} are unavailable`,
        { mediaId: media.mediaId },
      );
    }
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength !== media.byteLength ||
      digestBytes(bytes) !== media.digest
    ) {
      throw new MediaStoreError(
        "MEDIA_BYTES_INVALID",
        `Stored bytes for Media ${media.mediaId} do not match immutable metadata`,
        { mediaId: media.mediaId },
      );
    }
    return bytes;
  }

  /**
   * Resolves a Media reference while trusted Core code validates a Block commit.
   * Media IDs are shared within one Dolly instance, so the source does not
   * choose an owner here. This is not an Extension byte-read API: an isolated
   * Extension must receive a separate capability scoped to its delivered Block.
   */
  resolve(reference: MediaReferenceItem, _source: SourceIdentity): ResolvedMediaReference | null {
    this.flushPersistence();
    if (
      this.#deletingMediaIds.has(reference.mediaId) ||
      this.#registrationForMedia(reference.mediaId)?.state === "deleting"
    ) return null;
    const media = this.#media.get(reference.mediaId);
    if (!media) return null;
    if (reference.crop !== undefined) {
      if (
        !media.mimeType.startsWith("image/") ||
        media.width === undefined ||
        media.height === undefined
      ) {
        return null;
      }
      if (rectToPixelCrop(reference.crop, media.width, media.height) === null) return null;
    }
    return { mediaId: media.mediaId };
  }

  async storeOriginal(
    mediaId: string,
    adapterId: string,
    visibility: "private" | "public" = "private",
  ): Promise<MediaStorageRecordSummary> {
    this.flushPersistence();
    const media = this.#requireMedia(mediaId);
    const adapter = this.#adapters.get(adapterId);
    if (!adapter) {
      throw new MediaStoreError("MEDIA_ADAPTER_MISSING", `Adapter ${adapterId} is unavailable`);
    }
    if (visibility === "public" && !adapter.descriptor.publicUrl) {
      throw new MediaStoreError(
        "MEDIA_STORAGE_INVALID",
        `Adapter ${adapterId} cannot provide an explicit public URL`,
      );
    }
    if (
      [...this.#storageRecords.values()].some(
        (storageRecord) =>
          storageRecord.mediaId === mediaId && storageRecord.adapterId === adapterId,
      )
    ) {
      throw new MediaStoreError(
        "MEDIA_STORAGE_CONFLICT",
        `Media ${mediaId} already has an original storage record for ${adapterId}`,
      );
    }
    this.#assertLimit(
      "maxStorageRecords",
      this.#maxStorageRecords,
      this.#storageRecords.size + this.#storageRecordReservations,
      1,
    );
    this.#storageRecordReservations += 1;
    let storageRecordReserved = true;
    let leaseId: string | undefined;
    let storageRecordId: string | undefined;
    try {
      leaseId = this.#allocate("lease");
      this.referenceGraph.acquireLease({
        leaseId,
        ownerKind: "storage-operation",
        ownerId: leaseId,
        targetKind: "media",
        targetId: mediaId,
        kind: "storage-operation",
      });
      this.#persistMutation();
      return await this.#runStorageOperation(JSON.stringify([mediaId, adapterId]), async () => {
        const duplicate = [...this.#storageRecords.values()].find(
          (storageRecord) =>
            storageRecord.mediaId === mediaId && storageRecord.adapterId === adapterId,
        );
        if (duplicate) {
          throw new MediaStoreError(
            "MEDIA_STORAGE_CONFLICT",
            `Media ${mediaId} already has an original storage record for ${adapterId}`,
          );
        }

        storageRecordId = this.#allocate("storage-record");
        if (isPersistentStorageAdapter(adapter)) {
          const storageNamespace = normalizeStorageNamespace(
            adapter.descriptor.storageNamespace,
          );
          const plan = adapter.planOriginal({
            storageRecordId,
            mediaId,
            digest: media.digest,
            byteLength: media.byteLength,
            mimeType: media.mimeType,
          });
          this.#assertLocator(plan?.locator);
          const storageRecord: MediaStorageRecord = deepFreeze({
            storageRecordId,
            mediaId,
            adapterId,
            visibility,
            state: "uploading" as const,
            storageNamespace,
            objectVersioning: adapter.descriptor.objectVersioning,
            uploadAttempts: 0,
            deleteAttempts: 0,
            locator: plan.locator,
            uploadLeaseId: leaseId,
          });
          this.#storageRecords.set(storageRecordId, storageRecord);
          this.#storageRecordReservations -= 1;
          storageRecordReserved = false;
          this.#persistMutation();
          const completed = await this.#continuePersistentUpload(storageRecord, true);
          if (completed.state !== "available") {
            throw new MediaStoreError(
              "MEDIA_UPLOAD_FAILED",
              `Persistent storage upload ${storageRecordId} did not complete`,
              {
                mediaId,
                storageRecordId,
                adapterId,
                ...(completed.lastUploadErrorCode === undefined
                  ? {}
                  : { errorCode: completed.lastUploadErrorCode }),
              },
            );
          }
          return this.#storageRecordSummary(completed);
        }

        const bytes = await this.#readVerifiedMediaBytes(media);
        const result = await adapter.putOriginal({
          mediaId,
          digest: media.digest,
          mimeType: media.mimeType,
          bytes,
        });
        this.#assertStoragePutResult(result);
        const storageRecord = deepFreeze({
          storageRecordId,
          mediaId,
          adapterId,
          visibility,
          state: "available" as const,
          uploadAttempts: 0,
          deleteAttempts: 0,
          locator: result.locator,
          ...(result.objectVersion === undefined
            ? {}
            : { objectVersion: result.objectVersion }),
          ...(result.entityTag === undefined ? {} : { entityTag: result.entityTag }),
        });
        this.#storageRecords.set(storageRecordId, storageRecord);
        this.#storageRecordReservations -= 1;
        storageRecordReserved = false;
        return this.#storageRecordSummary(storageRecord);
      });
    } finally {
      if (storageRecordReserved) this.#storageRecordReservations -= 1;
      const record = storageRecordId === undefined
        ? undefined
        : this.#storageRecords.get(storageRecordId);
      const uploadStillPending =
        record !== undefined &&
        (record.state === "uploading" || record.state === "upload-failed") &&
        record.uploadLeaseId === leaseId;
      if (
        leaseId !== undefined &&
        !uploadStillPending &&
        this.referenceGraph.releaseLease(leaseId) === "released"
      ) {
        this.#persistMutation();
      }
    }
  }

  storageRecordCount(mediaId: string): number {
    this.flushPersistence();
    return [...this.#storageRecords.values()].filter((storageRecord) => storageRecord.mediaId === mediaId).length;
  }

  listStorageRecords(mediaId: string): readonly MediaStorageRecordSummary[] {
    this.flushPersistence();
    return [...this.#storageRecords.values()]
      .filter((storageRecord) => storageRecord.mediaId === mediaId)
      .map((storageRecord) => this.#storageRecordSummary(storageRecord));
  }

  async recoverUploads(): Promise<{
    readonly stored: readonly string[];
    readonly canceled: readonly string[];
    readonly failed: readonly string[];
  }> {
    this.flushPersistence();
    const stored: string[] = [];
    const canceled: string[] = [];
    const failed: string[] = [];
    for (const record of [...this.#storageRecords.values()].sort((left, right) =>
      left.storageRecordId.localeCompare(right.storageRecordId),
    )) {
      if (record.state !== "uploading" && record.state !== "upload-failed") continue;
      const completed = await this.#runStorageOperation(
        JSON.stringify([record.mediaId, record.adapterId]),
        async () => {
          const current = this.#storageRecords.get(record.storageRecordId);
          if (!current || current.state === "available") return current;
          if (current.state !== "uploading" && current.state !== "upload-failed") {
            return current;
          }
          if (!this.#uploadRetryIsDue(current, false)) return current;
          if (current.cancelRequested) {
            return this.#continueUploadCancellation(current);
          }
          return this.#continuePersistentUpload(current, false);
        },
      );
      if (completed === undefined) canceled.push(record.storageRecordId);
      else if (completed.state === "available") stored.push(record.storageRecordId);
      else failed.push(record.storageRecordId);
    }
    return deepFreeze({ stored, canceled, failed });
  }

  async retryUpload(storageRecordId: string): Promise<MediaStorageRecordSummary> {
    this.flushPersistence();
    assertId(storageRecordId, "storageRecordId");
    const initial = this.#storageRecords.get(storageRecordId);
    if (!initial) {
      throw new MediaStoreError(
        "MEDIA_STORAGE_INVALID",
        `Media storage record ${storageRecordId} does not exist`,
        { storageRecordId },
      );
    }
    return this.#runStorageOperation(
      JSON.stringify([initial.mediaId, initial.adapterId]),
      async () => {
      const record = this.#storageRecords.get(storageRecordId);
      if (!record) {
        throw new MediaStoreError(
          "MEDIA_STORAGE_INVALID",
          `Media storage record ${storageRecordId} does not exist`,
          { storageRecordId },
        );
      }
      if (record.state === "available") return this.#storageRecordSummary(record);
      if (record.state !== "uploading" && record.state !== "upload-failed") {
        throw new MediaStoreError(
          "MEDIA_STORAGE_INVALID",
          `Media storage record ${storageRecordId} is not awaiting upload`,
          { storageRecordId },
        );
      }
      if (record.cancelRequested) {
        throw new MediaStoreError(
          "MEDIA_UPLOAD_FAILED",
          `Persistent storage upload ${storageRecordId} has a pending cancellation request`,
          { storageRecordId, errorCode: record.lastUploadErrorCode ?? "CANCEL_REQUESTED" },
        );
      }
      const completed = await this.#continuePersistentUpload(record, true);
      if (completed.state !== "available") {
        throw new MediaStoreError(
          "MEDIA_UPLOAD_FAILED",
          `Persistent storage upload ${storageRecordId} did not complete`,
          {
            storageRecordId,
            ...(completed.lastUploadErrorCode === undefined
              ? {}
              : { errorCode: completed.lastUploadErrorCode }),
          },
        );
      }
      return this.#storageRecordSummary(completed);
      },
    );
  }

  async cancelUpload(
    storageRecordId: string,
  ): Promise<"canceled" | "absent"> {
    this.flushPersistence();
    assertId(storageRecordId, "storageRecordId");
    const initial = this.#storageRecords.get(storageRecordId);
    if (!initial) return "absent";
    return this.#runStorageOperation(
      JSON.stringify([initial.mediaId, initial.adapterId]),
      async () => {
        let record = this.#storageRecords.get(storageRecordId);
        if (!record) return "absent" as const;
        if (record.state !== "uploading" && record.state !== "upload-failed") {
          throw new MediaStoreError(
            "MEDIA_STORAGE_INVALID",
            `Media storage record ${storageRecordId} is not awaiting upload`,
            { storageRecordId },
          );
        }
        if (!record.cancelRequested) {
          const {
            uploadRetryable: _uploadRetryable,
            nextUploadAttemptAt: _nextUploadAttemptAt,
            lastUploadErrorCode: _lastUploadErrorCode,
            ...cancelBase
          } = record;
          record = deepFreeze({
            ...cancelBase,
            state: "upload-failed" as const,
            cancelRequested: true as const,
            uploadRetryable: true,
            nextUploadAttemptAt: canonicalTime(this.#now),
            lastUploadErrorCode: "CANCEL_REQUESTED",
          });
          this.#storageRecords.set(storageRecordId, record);
          this.#persistMutation();
        }
        const remaining = await this.#continueUploadCancellation(record);
        if (remaining !== undefined) {
          throw new MediaStoreError(
            "MEDIA_UPLOAD_FAILED",
            `Persistent storage upload ${storageRecordId} could not be canceled`,
            {
              storageRecordId,
              ...(remaining.lastUploadErrorCode === undefined
                ? {}
                : { errorCode: remaining.lastUploadErrorCode }),
            },
          );
        }
        return "canceled" as const;
      },
    );
  }

  async resolveProviderAccess(request: ProviderAccessRequest): Promise<MediaAccessGrant> {
    this.flushPersistence();
    const media = this.#requireMedia(request.mediaId);
    assertId(request.requestId, "requestId");
    assertId(request.recipientId, "recipientId");
    if (
      !Array.isArray(request.acceptedAccessModes) ||
      request.acceptedAccessModes.length === 0
    ) {
      throw new MediaStoreError(
        "MEDIA_ACCESS_UNSUPPORTED",
        "Provider request accepts no media access mode",
      );
    }
    const acceptedAccessModes = [...request.acceptedAccessModes];
    const acceptedAccessModeSet = new Set(acceptedAccessModes);
    if (
      acceptedAccessModes.length > 3 ||
      acceptedAccessModeSet.size !== acceptedAccessModes.length ||
      acceptedAccessModes.some(
        (mode) => mode !== "private-signed" && mode !== "public-url" && mode !== "inline",
      )
    ) {
      throw new MediaStoreError(
        "MEDIA_ACCESS_UNSUPPORTED",
        "Provider access modes must be a unique ordered subset of the supported modes",
      );
    }
    const acceptsPrivateSigned = acceptedAccessModeSet.has("private-signed");
    if (
      acceptsPrivateSigned &&
      (!Number.isSafeInteger(request.signedUrlExpiresInSeconds) ||
        request.signedUrlExpiresInSeconds === undefined ||
        request.signedUrlExpiresInSeconds <= 0 ||
        request.signedUrlExpiresInSeconds > 3600)
    ) {
      throw new MediaStoreError(
        "MEDIA_LIMIT_EXCEEDED",
        "Private signed URL expiry must be between 1 and 3600 seconds",
      );
    }
    if (!acceptsPrivateSigned && request.signedUrlExpiresInSeconds !== undefined) {
      throw new MediaStoreError(
        "MEDIA_ACCESS_UNSUPPORTED",
        "A signed URL expiry is allowed only when private signed URLs are accepted",
      );
    }
    let crop: Rect | undefined;
    let pixelCrop: PixelCrop | undefined;
    if (request.crop !== undefined) {
      try {
        crop = parseRect(request.crop, "providerAccess.crop");
      } catch {
        throw new MediaStoreError(
          "MEDIA_CROP_INVALID",
          "Provider crop is invalid",
        );
      }
      if (
        !media.mimeType.startsWith("image/") ||
        media.width === undefined ||
        media.height === undefined
      ) {
        throw new MediaStoreError(
          "MEDIA_CROP_INVALID",
          "Provider crop requires inspected image dimensions",
        );
      }
      pixelCrop = rectToPixelCrop(crop, media.width, media.height) ?? undefined;
      if (pixelCrop === undefined) {
        throw new MediaStoreError(
          "MEDIA_CROP_INVALID",
          "Provider crop must cover at least one pixel",
        );
      }
    }
    const normalizedRequest: ProviderAccessRequest = deepFreeze({
      mediaId: media.mediaId,
      ...(crop === undefined ? {} : { crop }),
      requestId: request.requestId,
      recipientId: request.recipientId,
      acceptedAccessModes,
      ...(request.signedUrlExpiresInSeconds === undefined
        ? {}
        : { signedUrlExpiresInSeconds: request.signedUrlExpiresInSeconds }),
    });
    const signedUrlExpiresAt = normalizedRequest.signedUrlExpiresInSeconds === undefined
      ? undefined
      : new Date(
        Date.parse(canonicalTime(this.#now)) +
          normalizedRequest.signedUrlExpiresInSeconds * 1000,
      ).toISOString();
    for (const mode of normalizedRequest.acceptedAccessModes) {
      if (mode === "private-signed") {
        const signed = await this.#createTrackedProviderAccess(
          media,
          normalizedRequest,
          signedUrlExpiresAt,
          (leaseId) => this.#trySignedGrant(
            media,
            pixelCrop,
            normalizedRequest,
            leaseId,
            signedUrlExpiresAt!,
          ),
        );
        if (signed) return signed;
      } else if (mode === "public-url" && this.#allowPublicProviderUrls) {
        const publicGrant = await this.#createTrackedProviderAccess(
          media,
          normalizedRequest,
          undefined,
          (leaseId) => this.#tryPublicGrant(
            media,
            normalizedRequest,
            leaseId,
          ),
        );
        if (publicGrant) return publicGrant;
      } else if (mode === "inline" && normalizedRequest.crop === undefined) {
        const leaseId = this.#allocate("lease");
        this.referenceGraph.acquireLease({
          leaseId,
          ownerKind: "media-read",
          ownerId: leaseId,
          targetKind: "media",
          targetId: media.mediaId,
          kind: "media-read",
        });
        try {
          this.#persistMutation();
          const bytes = await this.#readVerifiedMediaBytes(media);
          return deepFreeze({
            schemaVersion: "dolly.media-access-grant/5" as const,
            accessMode: "inline" as const,
            mediaId: media.mediaId,
            recipientId: normalizedRequest.recipientId,
            inline: {
              encoding: "base64" as const,
              data: Buffer.from(bytes).toString("base64"),
              byteLength: bytes.byteLength,
              mimeType: media.mimeType,
            },
          });
        } finally {
          if (this.referenceGraph.releaseLease(leaseId) !== "released") {
            throw new MediaStoreError(
              "MEDIA_SNAPSHOT_INVALID",
              "Media read lease disappeared before inline bytes were copied",
            );
          }
          this.#persistMutation();
        }
      }
    }
    throw new MediaStoreError(
      "MEDIA_ACCESS_UNSUPPORTED",
      this.#allowPublicProviderUrls
        ? "No accepted provider media access mode is available"
        : "No accepted provider media access mode is available; public provider URLs are disabled",
    );
  }

  recordProviderAccessOutcome(
    input: ProviderAccessOutcomeInput,
  ): "released" | "retained" | "absent" {
    this.flushPersistence();
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null)
    ) {
      throw new MediaStoreError(
        "MEDIA_ACCESS_DENIED",
        "Provider access outcome must be one plain object",
      );
    }
    assertId(input.leaseId, "leaseId");
    assertId(input.requestId, "requestId");
    assertId(input.recipientId, "recipientId");
    if (
      input.outcome !== "not-sent" &&
      input.outcome !== "finished" &&
      input.outcome !== "fetch-status-unknown"
    ) {
      throw new MediaStoreError(
        "MEDIA_ACCESS_UNSUPPORTED",
        "Provider access outcome is unsupported",
      );
    }
    const record = this.#providerAccess.get(input.leaseId);
    if (!record) {
      this.flushPersistence();
      return "absent";
    }
    if (record.requestId !== input.requestId || record.recipientId !== input.recipientId) {
      throw new MediaStoreError(
        "MEDIA_ACCESS_DENIED",
        "Provider access outcome does not match the request that received this URL",
      );
    }
    if (input.outcome === "fetch-status-unknown") {
      this.#providerAccess.set(
        record.leaseId,
        deepFreeze({ ...record, requestStatus: "result-unknown" as const }),
      );
      this.#persistMutation();
      return "retained";
    }
    this.#providerAccess.delete(record.leaseId);
    if (this.referenceGraph.releaseLease(record.leaseId) !== "released") {
      throw new MediaStoreError(
        "MEDIA_SNAPSHOT_INVALID",
        "Provider access record is missing its access lease",
      );
    }
    this.#persistMutation();
    return "released";
  }

  /**
   * A restarted host no longer has trustworthy evidence about an in-flight
   * provider request. Preserve each URL access lease and mark that result as
   * unknown until a trusted operator or provider-specific verifier closes it.
   */
  markProviderAccessUnknownAfterRestart(): readonly string[] {
    this.flushPersistence();
    const marked: string[] = [];
    for (const record of this.#providerAccess.values()) {
      if (record.requestStatus !== "awaiting-result") continue;
      this.#providerAccess.set(
        record.leaseId,
        deepFreeze({ ...record, requestStatus: "result-unknown" as const }),
      );
      marked.push(record.leaseId);
    }
    if (marked.length > 0) this.#persistMutation();
    return deepFreeze(marked);
  }

  listProviderAccessRecords(): readonly ProviderAccessRecord[] {
    this.flushPersistence();
    return deepFreeze([...this.#providerAccess.values()]
      .sort((left, right) =>
        left.leaseId < right.leaseId ? -1 : left.leaseId > right.leaseId ? 1 : 0,
      )
      .map((record) => deepFreeze({ ...record })));
  }

  async collectUnreachable(): Promise<{ readonly media: readonly string[] }> {
    this.flushPersistence();
    const mediaIds: string[] = [];
    const mediaTargets = this.referenceGraph
      .unreachable("media")
      .filter((target) => this.#media.has(target.id));
    for (const target of mediaTargets) {
      if (this.#deletingMediaIds.has(target.id)) continue;
      const registration = this.#registrationForMedia(target.id);
      if (!registration) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Unreachable Media does not have a registration record",
        );
      }
      const deleted = await this.#runRegistrationOperation(
        registration.registrationId,
        async () => {
          let current = this.#registrations.get(registration.registrationId);
          if (!current || current.state === "deleted") return false;
          if (
            (current.state !== "available" && current.state !== "deleting") ||
            current.holdsRegistrationReference
          ) {
            throw new MediaStoreError(
              "MEDIA_SNAPSHOT_INVALID",
              "Unreachable Media does not have a released registration record",
            );
          }
          if (current.state === "available") current = this.#prepareDeletion(current);
          if (!this.#retryFailedStorageDeletes(current, true)) {
            return false;
          }
          await this.#finishDeletion(current);
          return true;
        },
      );
      if (deleted) mediaIds.push(target.id);
    }

    if (mediaIds.length === 0) this.flushPersistence();
    return { media: mediaIds };
  }

  async recoverDeletions(): Promise<{
    readonly deleted: readonly string[];
    readonly failed: readonly string[];
  }> {
    this.flushPersistence();
    const deleted: string[] = [];
    const failed: string[] = [];
    for (const registration of [...this.#registrations.values()].sort((left, right) =>
      left.registrationId.localeCompare(right.registrationId),
    )) {
      if (registration.state !== "deleting") continue;
      try {
        const recovered = await this.#runRegistrationOperation(
          registration.registrationId,
          async () => {
            const current = this.#registrations.get(registration.registrationId);
            if (!current || current.state === "deleted") return true;
            if (current.state !== "deleting") return false;
            if (!this.#retryFailedStorageDeletes(current, true)) return false;
            await this.#finishDeletion(current);
            return true;
          },
        );
        if (recovered) deleted.push(registration.media.mediaId);
        else failed.push(registration.media.mediaId);
      } catch (error) {
        if (
          error instanceof ReferenceGraphError ||
          (error instanceof MediaStoreError &&
            (error.code === "MEDIA_PERSISTENCE_FAILED" ||
              error.code === "MEDIA_SNAPSHOT_INVALID" ||
              error.code === "MEDIA_STORAGE_INVALID"))
        ) {
          throw error;
        }
        failed.push(registration.media.mediaId);
      }
    }
    return deepFreeze({ deleted, failed });
  }

  async retryDeletion(registrationId: string): Promise<"deleted"> {
    assertId(registrationId, "registrationId");
    return this.#runRegistrationOperation(registrationId, async () => {
      this.flushPersistence();
      const registration = this.#registrations.get(registrationId);
      if (!registration) {
        throw new MediaStoreError(
          "MEDIA_REGISTRATION_MISSING",
          `Media registration ${registrationId} does not exist`,
          { registrationId },
        );
      }
      if (registration.state === "deleted") return "deleted" as const;
      if (registration.state !== "deleting") {
        throw new MediaStoreError(
          "MEDIA_DELETION_IN_PROGRESS",
          "Media deletion has not been prepared for this registration",
          { registrationId, mediaId: registration.media.mediaId },
        );
      }
      this.#retryFailedStorageDeletes(registration, false);
      await this.#finishDeletion(registration);
      return "deleted" as const;
    });
  }

  #storageRecordsFor(mediaId: string): MediaStorageRecord[] {
    return [...this.#storageRecords.values()].filter(
      (record) => record.mediaId === mediaId,
    );
  }

  #storageRecordForDeleteAttempt(record: MediaStorageRecord): MediaStorageRecord {
    if (!Number.isSafeInteger(record.deleteAttempts + 1)) {
      throw new MediaStoreError(
        "MEDIA_STORAGE_INVALID",
        "Media storage delete attempt count exceeds the supported limit",
        { storageRecordId: record.storageRecordId },
      );
    }
    const {
      deleteRetryable: _deleteRetryable,
      nextDeleteAttemptAt: _nextDeleteAttemptAt,
      lastDeleteErrorCode: _lastDeleteErrorCode,
      ...unchanged
    } = record;
    return deepFreeze({
      ...unchanged,
      state: "deleting" as const,
      deleteAttempts: record.deleteAttempts + 1,
    });
  }

  #retryFailedStorageDeletes(
    registration: ActiveMediaRegistrationRecord,
    requireDueTime: boolean,
  ): boolean {
    const failedRecords = this.#storageRecordsFor(registration.media.mediaId).filter(
      (record) => record.state === "delete-failed",
    );
    if (failedRecords.length === 0) return true;
    if (failedRecords.some(
      (record) => this.#activeStorageDeleteRequests.has(record.storageRecordId),
    )) {
      return false;
    }
    if (requireDueTime) {
      const now = Date.parse(canonicalTime(this.#now));
      if (failedRecords.some(
        (record) =>
          record.deleteRetryable !== true ||
          record.nextDeleteAttemptAt === undefined ||
          Date.parse(record.nextDeleteAttemptAt) > now,
      )) {
        return false;
      }
    }
    for (const record of failedRecords) {
      this.#storageRecords.set(
        record.storageRecordId,
        this.#storageRecordForDeleteAttempt(record),
      );
    }
    this.#persistMutation();
    return true;
  }

  #prepareDeletion(
    registration: ActiveMediaRegistrationRecord,
  ): ActiveMediaRegistrationRecord {
    const target = { kind: "media" as const, id: registration.media.mediaId };
    if (this.referenceGraph.isReachable(target)) {
      throw new MediaStoreError(
        "MEDIA_DELETION_IN_PROGRESS",
        "Reachable Media cannot enter deletion",
        { mediaId: registration.media.mediaId },
      );
    }
    this.referenceGraph.beginRemoval([target]);
    this.referenceGraph.cancelRemoval([target]);
    this.#deletingMediaIds.add(registration.media.mediaId);
    try {
      const deletingRegistration: MediaRegistrationRecord = deepFreeze({
        ...registration,
        state: "deleting" as const,
        holdsRegistrationReference: false,
      });
      for (const record of this.#storageRecordsFor(registration.media.mediaId)) {
        if (record.state !== "available") {
          throw new MediaStoreError(
            "MEDIA_SNAPSHOT_INVALID",
            "Available Media has a storage record already in deletion",
          );
        }
        this.#storageRecords.set(
          record.storageRecordId,
          this.#storageRecordForDeleteAttempt(record),
        );
      }
      this.#registrations.set(registration.registrationId, deletingRegistration);
      this.#persistMutation();
      return deletingRegistration;
    } finally {
      this.#deletingMediaIds.delete(registration.media.mediaId);
    }
  }

  async #finishDeletion(registration: ActiveMediaRegistrationRecord): Promise<void> {
    const current = this.#registrations.get(registration.registrationId);
    if (!current || current.state !== "deleting") {
      throw new MediaStoreError(
        "MEDIA_SNAPSHOT_INVALID",
        "Media deletion lost its persistent registration record",
      );
    }
    let retainUntil: string;
    try {
      retainUntil = new Date(
        Date.parse(canonicalTime(this.#now)) + this.#deletedRegistrationRetentionMs,
      ).toISOString();
    } catch {
      throw new MediaStoreError(
        "MEDIA_STORAGE_INVALID",
        "Deleted registration retention time exceeds the supported timestamp range",
      );
    }
    const target = { kind: "media" as const, id: current.media.mediaId };
    this.#deletingMediaIds.add(current.media.mediaId);
    let removalStarted = false;
    try {
      this.referenceGraph.beginRemoval([target]);
      removalStarted = true;
      for (const record of this.#storageRecordsFor(current.media.mediaId)) {
        if (record.state === "delete-failed") {
          throw new MediaStoreError(
            "MEDIA_DELETION_IN_PROGRESS",
            "Media deletion has a storage failure that requires retry",
            { mediaId: current.media.mediaId, storageRecordId: record.storageRecordId },
          );
        }
        if (record.state !== "deleting") {
          throw new MediaStoreError(
            "MEDIA_SNAPSHOT_INVALID",
            "Deleting Media has an available storage record",
          );
        }
        const adapter = this.#adapters.get(record.adapterId);
        if (!adapter) {
          this.referenceGraph.cancelRemoval([target]);
          removalStarted = false;
          this.#recordStorageDeleteFailure(record, {
            code: "ADAPTER_UNAVAILABLE",
            retryable: false,
          });
          this.#persistMutation();
          throw new MediaStoreError(
            "MEDIA_ADAPTER_MISSING",
            `Adapter ${record.adapterId} is unavailable during deletion`,
            { adapterId: record.adapterId, storageRecordId: record.storageRecordId },
          );
        }
        if (!this.#adapterMatchesStorageRecord(adapter, record)) {
          this.referenceGraph.cancelRemoval([target]);
          removalStarted = false;
          this.#recordStorageDeleteFailure(record, {
            code: "STORAGE_NAMESPACE_MISMATCH",
            retryable: false,
          });
          this.#persistMutation();
          throw new MediaStoreError(
            "MEDIA_STORAGE_CONFLICT",
            `Adapter ${record.adapterId} no longer identifies the stored object location`,
            { adapterId: record.adapterId, storageRecordId: record.storageRecordId },
          );
        }
        let result: "deleted" | "not-found";
        try {
          if (isPersistentStorageAdapter(adapter)) {
            result = await this.#callPersistentStorageDelete(record, adapter);
          } else {
            result = await adapter.deleteObject(record.locator, record.objectVersion);
          }
          if (result !== "deleted" && result !== "not-found") {
            throw Object.assign(new Error("Storage adapter returned an invalid delete result"), {
              code: "DELETE_RESULT_INVALID",
            });
          }
        } catch (error) {
          this.referenceGraph.cancelRemoval([target]);
          removalStarted = false;
          this.#recordStorageDeleteFailure(record, classifyDeleteError(error));
          this.#persistMutation();
          throw error;
        }
        this.#storageRecords.delete(record.storageRecordId);
        this.#persistMutation();
      }
      await this.#bytes.delete(current.media.mediaId);
      this.referenceGraph.completeRemoval([target]);
      removalStarted = false;
      this.#media.delete(current.media.mediaId);
      this.#registrations.set(current.registrationId, deepFreeze({
        schemaVersion: "dolly.media-registration/4" as const,
        registrationId: current.registrationId,
        state: "deleted" as const,
        holdsRegistrationReference: false,
        mediaId: current.media.mediaId,
        digest: current.media.digest,
        byteLength: current.media.byteLength,
        ...(current.media.declaredMimeType === undefined
          ? {}
          : { declaredMimeType: current.media.declaredMimeType }),
        provenance: current.media.provenance,
        retainUntil,
      }));
      this.#persistMutation();
    } finally {
      if (removalStarted) this.referenceGraph.cancelRemoval([target]);
      this.#deletingMediaIds.delete(current.media.mediaId);
    }
  }

  #recordStorageDeleteFailure(
    record: MediaStorageRecord,
    failure: ClassifiedDeleteError,
  ): void {
    let nextDeleteAttemptAt: string | undefined;
    if (failure.retryable) {
      const delay = this.#deleteRetryDelayMs(record.deleteAttempts);
      if (!Number.isSafeInteger(delay) || delay < 0) {
        throw new MediaStoreError(
          "MEDIA_STORAGE_INVALID",
          "deleteRetryDelayMs must return a non-negative safe integer",
        );
      }
      nextDeleteAttemptAt = new Date(
        Date.parse(canonicalTime(this.#now)) + delay,
      ).toISOString();
    }
    const {
      deleteRetryable: _deleteRetryable,
      nextDeleteAttemptAt: _nextDeleteAttemptAt,
      lastDeleteErrorCode: _lastDeleteErrorCode,
      ...unchanged
    } = record;
    this.#storageRecords.set(record.storageRecordId, deepFreeze({
      ...unchanged,
      state: "delete-failed" as const,
      deleteRetryable: failure.retryable,
      ...(nextDeleteAttemptAt === undefined ? {} : { nextDeleteAttemptAt }),
      lastDeleteErrorCode: failure.code,
    }));
  }

  #restore(snapshot: MediaStoreSnapshot): void {
    try {
      this.#restoreValidated(snapshot);
    } catch (error) {
      if (error instanceof MediaStoreError && error.code === "MEDIA_SNAPSHOT_INVALID") {
        throw error;
      }
      throw new MediaStoreError("MEDIA_SNAPSHOT_INVALID", "MediaStore snapshot is invalid");
    }
  }

  #restoreValidated(snapshot: MediaStoreSnapshot): void {
    assertSnapshotObject(
      snapshot,
      [
        "schemaVersion",
        "durability",
        "idNamespace",
        "nextIdSequence",
        "registrations",
        "media",
        "storageRecords",
        "providerAccess",
      ],
      "MediaStore snapshot",
    );
    if (
      snapshot.schemaVersion !== "dolly.media-store/9" ||
      snapshot.durability !== this.#durability ||
      snapshot.idNamespace !== this.#idNamespace ||
      typeof snapshot.nextIdSequence !== "string" ||
      !ID_SEQUENCE_PATTERN.test(snapshot.nextIdSequence) ||
      !Array.isArray(snapshot.registrations) ||
      !Array.isArray(snapshot.media) ||
      !Array.isArray(snapshot.storageRecords) ||
      !Array.isArray(snapshot.providerAccess)
    ) {
      throw new MediaStoreError(
        "MEDIA_SNAPSHOT_INVALID",
        "MediaStore snapshot schema, durability, or limits do not match",
      );
    }
    this.#nextIdSequence = BigInt(snapshot.nextIdSequence);
    if (this.#nextIdSequence > ID_SEQUENCE_LIMIT) {
      throw new MediaStoreError(
        "MEDIA_SNAPSHOT_INVALID",
        "MediaStore next ID sequence exceeds the 128-bit allocation range",
      );
    }

    const registrationMediaIds = new Set<string>();
    for (const candidate of snapshot.registrations) {
      if (
        candidate.schemaVersion !== "dolly.media-registration/4" ||
        typeof candidate.registrationId !== "string" ||
        !ID_PATTERN.test(candidate.registrationId) ||
        this.#registrations.has(candidate.registrationId)
      ) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Media registration record is invalid",
        );
      }
      if (candidate.state === "deleted") {
        assertSnapshotObject(
          candidate,
          [
            "schemaVersion",
            "registrationId",
            "state",
            "holdsRegistrationReference",
            "mediaId",
            "digest",
            "byteLength",
            "declaredMimeType",
            "provenance",
            "retainUntil",
          ],
          "Deleted Media registration record",
        );
        if (
          candidate.holdsRegistrationReference !== false ||
          typeof candidate.mediaId !== "string" ||
          !ID_PATTERN.test(candidate.mediaId) ||
          registrationMediaIds.has(candidate.mediaId) ||
          !this.#isAllocatedId(candidate.mediaId, "media") ||
          !Number.isSafeInteger(candidate.byteLength) ||
          candidate.byteLength <= 0 ||
          (candidate.declaredMimeType !== undefined &&
            (typeof candidate.declaredMimeType !== "string" ||
              !MIME_PATTERN.test(candidate.declaredMimeType)))
        ) {
          throw new MediaStoreError(
            "MEDIA_SNAPSHOT_INVALID",
            "Deleted Media registration record is invalid",
          );
        }
        assertDigest(candidate.digest, "Deleted Media registration digest");
        assertCanonicalTimestamp(
          candidate.retainUntil,
          "Deleted Media registration retainUntil",
        );
        const provenance = normalizeProvenance(candidate.provenance);
        registrationMediaIds.add(candidate.mediaId);
        this.#registrations.set(candidate.registrationId, deepFreeze({
          schemaVersion: "dolly.media-registration/4" as const,
          registrationId: candidate.registrationId,
          state: "deleted" as const,
          holdsRegistrationReference: false as const,
          mediaId: candidate.mediaId,
          digest: candidate.digest,
          byteLength: candidate.byteLength,
          ...(candidate.declaredMimeType === undefined
            ? {}
            : { declaredMimeType: candidate.declaredMimeType }),
          provenance,
          retainUntil: candidate.retainUntil,
        }));
        continue;
      }
      assertSnapshotObject(
        candidate,
        [
          "schemaVersion",
          "registrationId",
          "state",
          "holdsRegistrationReference",
          "media",
        ],
        "Active Media registration record",
      );
      if (
        (candidate.state !== "pending" &&
          candidate.state !== "available" &&
          candidate.state !== "deleting") ||
        typeof candidate.holdsRegistrationReference !== "boolean" ||
        (candidate.state !== "available" && candidate.holdsRegistrationReference)
      ) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Active Media registration record is invalid",
        );
      }
      const media = restoreMediaRecord(
        candidate.media,
        Number.MAX_SAFE_INTEGER,
        "Media registration record media",
      );
      if (
        registrationMediaIds.has(media.mediaId) ||
        !this.#isAllocatedId(media.mediaId, "media")
      ) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Media registration record has an invalid allocated mediaId",
        );
      }
      registrationMediaIds.add(media.mediaId);
      this.#registrations.set(candidate.registrationId, deepFreeze({
        schemaVersion: "dolly.media-registration/4" as const,
        registrationId: candidate.registrationId,
        state: candidate.state,
        holdsRegistrationReference: candidate.holdsRegistrationReference,
        media,
      }));
    }

    for (const candidate of snapshot.media) {
      assertSnapshotObject(
        candidate,
        [
          "schemaVersion",
          "mediaId",
          "digest",
          "byteLength",
          "mimeType",
          "declaredMimeType",
          "width",
          "height",
          "durationMs",
          "frameCount",
          "channels",
          "provenance",
          "createdAt",
        ],
        "Media snapshot",
      );
      if (
        candidate.schemaVersion !== "dolly.media/2" ||
        typeof candidate.mediaId !== "string" ||
        !ID_PATTERN.test(candidate.mediaId) ||
        this.#media.has(candidate.mediaId) ||
        !Number.isSafeInteger(candidate.byteLength) ||
        candidate.byteLength <= 0 ||
        typeof candidate.mimeType !== "string" ||
        !MIME_PATTERN.test(candidate.mimeType) ||
        (candidate.declaredMimeType !== undefined &&
          (typeof candidate.declaredMimeType !== "string" ||
            !MIME_PATTERN.test(candidate.declaredMimeType)))
      ) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Media snapshot envelope is invalid",
        );
      }
      assertDigest(candidate.digest, "Media.digest");
      validateOptionalPositiveInteger(candidate.width, "width");
      validateOptionalPositiveInteger(candidate.height, "height");
      validateOptionalPositiveInteger(candidate.durationMs, "durationMs");
      validateOptionalPositiveInteger(candidate.frameCount, "frameCount");
      validateOptionalPositiveInteger(candidate.channels, "channels");
      if ((candidate.width === undefined) !== (candidate.height === undefined)) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Media image dimensions are incomplete",
        );
      }
      assertSnapshotObject(
        candidate.provenance,
        ["sourceClass", "sourceLabel"],
        "Media provenance",
      );
      if (
        candidate.provenance.sourceClass !== "streamed-upload" &&
        candidate.provenance.sourceClass !== "extension-bytes" &&
        candidate.provenance.sourceClass !== "local-file" &&
        candidate.provenance.sourceClass !== "remote-fetch" &&
        candidate.provenance.sourceClass !== "provider-output" &&
        candidate.provenance.sourceClass !== "derived"
      ) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Media provenance class is invalid",
        );
      }
      if (
        candidate.provenance.sourceLabel !== undefined &&
        (typeof candidate.provenance.sourceLabel !== "string" ||
          candidate.provenance.sourceLabel.length === 0 ||
          candidate.provenance.sourceLabel.length > 512)
      ) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Media provenance label is invalid",
        );
      }
      assertCanonicalTimestamp(candidate.createdAt, "Media.createdAt");
      const media: Media = deepFreeze({
        schemaVersion: "dolly.media/2",
        mediaId: candidate.mediaId,
        digest: candidate.digest,
        byteLength: candidate.byteLength,
        mimeType: candidate.mimeType,
        ...(candidate.declaredMimeType === undefined
          ? {}
          : { declaredMimeType: candidate.declaredMimeType }),
        ...(candidate.width === undefined ? {} : { width: candidate.width }),
        ...(candidate.height === undefined ? {} : { height: candidate.height }),
        ...(candidate.durationMs === undefined
          ? {}
          : { durationMs: candidate.durationMs }),
        ...(candidate.frameCount === undefined
          ? {}
          : { frameCount: candidate.frameCount }),
        ...(candidate.channels === undefined ? {} : { channels: candidate.channels }),
        provenance: {
          sourceClass: candidate.provenance.sourceClass,
          ...(candidate.provenance.sourceLabel === undefined
            ? {}
            : { sourceLabel: candidate.provenance.sourceLabel }),
        },
        createdAt: candidate.createdAt,
      });
      const target = { kind: "media" as const, id: media.mediaId };
      if (!this.referenceGraph.hasNode(target)) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          `Reference graph snapshot omits Media ${media.mediaId}`,
        );
      }
      this.referenceGraph.registerNode(target);
      this.#media.set(media.mediaId, media);
    }

    const registrationMediaStateIds = new Set<string>();
    for (const registration of this.#registrations.values()) {
      if (registration.state === "deleted") continue;
      const media = this.#media.get(registration.media.mediaId);
      if (registration.state === "available" || registration.state === "deleting") {
        registrationMediaStateIds.add(registration.media.mediaId);
        if (
          !media ||
          canonicalJsonDigest(media) !== canonicalJsonDigest(registration.media)
        ) {
          throw new MediaStoreError(
            "MEDIA_SNAPSHOT_INVALID",
            "Media registration does not match Media state",
          );
        }
      } else if (media) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Pending or deleted Media registration cannot have available Media state",
        );
      }
    }
    if (!this.#sameStringSet(registrationMediaStateIds, new Set(this.#media.keys()))) {
      throw new MediaStoreError(
        "MEDIA_SNAPSHOT_INVALID",
        "Every Media item must have exactly one available or deleting registration record",
      );
    }

    const storageRecordTargets = new Set<string>();
    for (const candidate of snapshot.storageRecords) {
      assertSnapshotObject(
        candidate,
        [
          "schemaVersion",
          "storageRecordId",
          "mediaId",
          "adapterId",
          "visibility",
          "state",
          "storageNamespace",
          "objectVersioning",
          "uploadAttempts",
          "cancelRequested",
          "uploadRetryable",
          "nextUploadAttemptAt",
          "lastUploadErrorCode",
          "uploadLeaseId",
          "locator",
          "objectVersion",
          "entityTag",
          "deleteAttempts",
          "deleteRetryable",
          "nextDeleteAttemptAt",
          "lastDeleteErrorCode",
        ],
        "Media storage record snapshot",
      );
      if (
        candidate.schemaVersion !== "dolly.media-storage-record/4" ||
        typeof candidate.storageRecordId !== "string" ||
        !ID_PATTERN.test(candidate.storageRecordId) ||
        !this.#isAllocatedId(candidate.storageRecordId, "storage-record") ||
        this.#storageRecords.has(candidate.storageRecordId) ||
        typeof candidate.mediaId !== "string" ||
        !ID_PATTERN.test(candidate.mediaId) ||
        !this.#media.has(candidate.mediaId) ||
        typeof candidate.adapterId !== "string" ||
        !ID_PATTERN.test(candidate.adapterId) ||
        (candidate.visibility !== "private" && candidate.visibility !== "public") ||
        (candidate.state !== "uploading" &&
          candidate.state !== "upload-failed" &&
          candidate.state !== "available" &&
          candidate.state !== "deleting" &&
          candidate.state !== "delete-failed") ||
        !Number.isSafeInteger(candidate.uploadAttempts) ||
        candidate.uploadAttempts < 0 ||
        !Number.isSafeInteger(candidate.deleteAttempts) ||
        candidate.deleteAttempts < 0 ||
        typeof candidate.locator !== "string" ||
        candidate.locator.length === 0 ||
        candidate.locator.length > 1024 ||
        /[\u0000-\u001f]/.test(candidate.locator) ||
        candidate.locator.includes("://") ||
        candidate.locator.includes("?") ||
        (candidate.objectVersion !== undefined &&
          (typeof candidate.objectVersion !== "string" ||
            candidate.objectVersion.length === 0 ||
            candidate.objectVersion.length > 1024 ||
            /[\u0000-\u001f]/.test(candidate.objectVersion))) ||
        (candidate.entityTag !== undefined &&
          (typeof candidate.entityTag !== "string" ||
            candidate.entityTag.length === 0 ||
            candidate.entityTag.length > 1024 ||
            /[\u0000-\u001f]/.test(candidate.entityTag))) ||
        (candidate.objectVersioning !== undefined &&
          candidate.objectVersioning !== "disabled" &&
          candidate.objectVersioning !== "enabled") ||
        (candidate.uploadLeaseId !== undefined &&
          (typeof candidate.uploadLeaseId !== "string" ||
            !ID_PATTERN.test(candidate.uploadLeaseId))) ||
        (candidate.cancelRequested !== undefined && candidate.cancelRequested !== true) ||
        (candidate.uploadRetryable !== undefined &&
          typeof candidate.uploadRetryable !== "boolean") ||
        (candidate.lastUploadErrorCode !== undefined &&
          (typeof candidate.lastUploadErrorCode !== "string" ||
            !ID_PATTERN.test(candidate.lastUploadErrorCode))) ||
        (candidate.deleteRetryable !== undefined &&
          typeof candidate.deleteRetryable !== "boolean") ||
        (candidate.lastDeleteErrorCode !== undefined &&
          (typeof candidate.lastDeleteErrorCode !== "string" ||
            !ID_PATTERN.test(candidate.lastDeleteErrorCode)))
      ) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Media storage record snapshot is invalid",
        );
      }
      let storageNamespace: Readonly<Record<string, JsonValue>> | undefined;
      if (candidate.storageNamespace !== undefined) {
        try {
          storageNamespace = normalizeStorageNamespace(candidate.storageNamespace);
        } catch {
          throw new MediaStoreError(
            "MEDIA_SNAPSHOT_INVALID",
            "Media storage record contains an invalid storage namespace",
          );
        }
      }
      const persistentRecord = storageNamespace !== undefined;
      if (persistentRecord !== (candidate.objectVersioning !== undefined)) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Storage namespace and object versioning must be stored together",
        );
      }
      if (candidate.nextUploadAttemptAt !== undefined) {
        assertCanonicalTimestamp(
          candidate.nextUploadAttemptAt,
          "Media storage record nextUploadAttemptAt",
        );
      }
      if (candidate.nextDeleteAttemptAt !== undefined) {
        assertCanonicalTimestamp(
          candidate.nextDeleteAttemptAt,
          "Media storage record nextDeleteAttemptAt",
        );
      }
      if (
        ((candidate.state === "uploading" || candidate.state === "upload-failed") &&
          (!persistentRecord ||
            candidate.uploadLeaseId === undefined ||
            candidate.objectVersion !== undefined ||
            candidate.entityTag !== undefined ||
            candidate.deleteAttempts !== 0 ||
            candidate.deleteRetryable !== undefined ||
            candidate.nextDeleteAttemptAt !== undefined ||
            candidate.lastDeleteErrorCode !== undefined)) ||
        (candidate.state === "uploading" &&
          (candidate.cancelRequested !== undefined ||
            candidate.uploadRetryable !== undefined ||
            candidate.nextUploadAttemptAt !== undefined ||
            candidate.lastUploadErrorCode !== undefined)) ||
        (candidate.state === "upload-failed" &&
          (candidate.uploadRetryable === undefined ||
            candidate.lastUploadErrorCode === undefined ||
            (candidate.uploadRetryable && candidate.nextUploadAttemptAt === undefined) ||
            (!candidate.uploadRetryable && candidate.nextUploadAttemptAt !== undefined))) ||
        ((candidate.state === "available" ||
          candidate.state === "deleting" ||
          candidate.state === "delete-failed") &&
          (candidate.uploadLeaseId !== undefined ||
            candidate.cancelRequested !== undefined ||
            candidate.uploadRetryable !== undefined ||
            candidate.nextUploadAttemptAt !== undefined ||
            candidate.lastUploadErrorCode !== undefined)) ||
        (!persistentRecord && candidate.uploadAttempts !== 0) ||
        (candidate.state === "available" &&
          (candidate.deleteAttempts !== 0 ||
            candidate.deleteRetryable !== undefined ||
            candidate.nextDeleteAttemptAt !== undefined ||
            candidate.lastDeleteErrorCode !== undefined)) ||
        (candidate.state === "deleting" &&
          (candidate.deleteAttempts < 1 ||
            candidate.deleteRetryable !== undefined ||
            candidate.nextDeleteAttemptAt !== undefined ||
            candidate.lastDeleteErrorCode !== undefined)) ||
        (candidate.state === "delete-failed" &&
          (candidate.deleteAttempts < 1 ||
            candidate.deleteRetryable === undefined ||
            candidate.lastDeleteErrorCode === undefined ||
            (candidate.deleteRetryable && candidate.nextDeleteAttemptAt === undefined) ||
            (!candidate.deleteRetryable && candidate.nextDeleteAttemptAt !== undefined)))
      ) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Media storage operation fields conflict with its state",
        );
      }
      if (
        persistentRecord &&
        (candidate.state === "available" ||
          candidate.state === "deleting" ||
          candidate.state === "delete-failed") &&
        ((candidate.objectVersioning === "enabled" &&
          candidate.objectVersion === undefined) ||
          (candidate.objectVersioning === "disabled" &&
            (candidate.objectVersion !== undefined || candidate.entityTag === undefined)))
      ) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Persistent storage requires an exact object version or entity tag after upload",
        );
      }
      const uniquenessKey = JSON.stringify([candidate.mediaId, candidate.adapterId]);
      if (storageRecordTargets.has(uniquenessKey)) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Media has more than one original storage record for one adapter",
        );
      }
      storageRecordTargets.add(uniquenessKey);
      const storageRecord: MediaStorageRecord = deepFreeze({
        storageRecordId: candidate.storageRecordId,
        mediaId: candidate.mediaId,
        adapterId: candidate.adapterId,
        visibility: candidate.visibility,
        state: candidate.state,
        ...(storageNamespace === undefined ? {} : { storageNamespace }),
        ...(candidate.objectVersioning === undefined
          ? {}
          : { objectVersioning: candidate.objectVersioning }),
        uploadAttempts: candidate.uploadAttempts,
        ...(candidate.cancelRequested === undefined
          ? {}
          : { cancelRequested: true as const }),
        ...(candidate.uploadRetryable === undefined
          ? {}
          : { uploadRetryable: candidate.uploadRetryable }),
        ...(candidate.nextUploadAttemptAt === undefined
          ? {}
          : { nextUploadAttemptAt: candidate.nextUploadAttemptAt }),
        ...(candidate.lastUploadErrorCode === undefined
          ? {}
          : { lastUploadErrorCode: candidate.lastUploadErrorCode }),
        deleteAttempts: candidate.deleteAttempts,
        ...(candidate.deleteRetryable === undefined
          ? {}
          : { deleteRetryable: candidate.deleteRetryable }),
        ...(candidate.nextDeleteAttemptAt === undefined
          ? {}
          : { nextDeleteAttemptAt: candidate.nextDeleteAttemptAt }),
        ...(candidate.lastDeleteErrorCode === undefined
          ? {}
          : { lastDeleteErrorCode: candidate.lastDeleteErrorCode }),
        locator: candidate.locator,
        ...(candidate.uploadLeaseId === undefined
          ? {}
          : { uploadLeaseId: candidate.uploadLeaseId }),
        ...(candidate.objectVersion === undefined
          ? {}
          : { objectVersion: candidate.objectVersion }),
        ...(candidate.entityTag === undefined
          ? {}
          : { entityTag: candidate.entityTag }),
      });
      this.#storageRecords.set(storageRecord.storageRecordId, storageRecord);
    }

    for (const registration of this.#registrations.values()) {
      if (registration.state === "deleted") continue;
      const records = this.#storageRecordsFor(registration.media.mediaId);
      if (
        registration.state === "available" &&
        records.some(
          (record) =>
            record.state !== "uploading" &&
            record.state !== "upload-failed" &&
            record.state !== "available",
        )
      ) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Available Media has a storage record in deletion",
        );
      }
      if (
        registration.state === "deleting" &&
        records.some(
          (record) => record.state !== "deleting" && record.state !== "delete-failed",
        )
      ) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Deleting Media has an available storage record",
        );
      }
    }

    const expectedProviderLeases = new Set<string>();
    for (const candidate of snapshot.providerAccess) {
      assertSnapshotObject(
        candidate,
        [
          "leaseId",
          "mediaId",
          "crop",
          "requestId",
          "recipientId",
          "accessMode",
          "signedUrlExpiresAt",
          "requestStatus",
        ],
        "Provider access snapshot",
      );
      if (
        typeof candidate.leaseId !== "string" ||
        !ID_PATTERN.test(candidate.leaseId) ||
        !this.#isAllocatedId(candidate.leaseId, "lease") ||
        this.#providerAccess.has(candidate.leaseId) ||
        typeof candidate.mediaId !== "string" ||
        !ID_PATTERN.test(candidate.mediaId) ||
        !this.#media.has(candidate.mediaId) ||
        this.#registrationForMedia(candidate.mediaId)?.state === "deleting" ||
        typeof candidate.requestId !== "string" ||
        !ID_PATTERN.test(candidate.requestId) ||
        typeof candidate.recipientId !== "string" ||
        !ID_PATTERN.test(candidate.recipientId) ||
        (candidate.accessMode !== "private-signed" &&
          candidate.accessMode !== "public-url") ||
        (candidate.requestStatus !== "awaiting-result" &&
          candidate.requestStatus !== "result-unknown")
      ) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Provider access snapshot is invalid",
        );
      }
      let crop: Rect | undefined;
      if (candidate.crop !== undefined) {
        try {
          crop = parseRect(candidate.crop, "providerAccess.crop");
        } catch {
          throw new MediaStoreError(
            "MEDIA_SNAPSHOT_INVALID",
            "Provider access snapshot crop is invalid",
          );
        }
        const media = this.#media.get(candidate.mediaId)!;
        if (
          candidate.accessMode !== "private-signed" ||
          !media.mimeType.startsWith("image/") ||
          media.width === undefined ||
          media.height === undefined ||
          rectToPixelCrop(crop, media.width, media.height) === null
        ) {
          throw new MediaStoreError(
            "MEDIA_SNAPSHOT_INVALID",
            "Provider access snapshot crop cannot be served by its access mode",
          );
        }
      }
      if (
        (candidate.accessMode === "private-signed" &&
          candidate.signedUrlExpiresAt === undefined) ||
        (candidate.accessMode === "public-url" &&
          candidate.signedUrlExpiresAt !== undefined)
      ) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Provider access record conflicts with its access mode",
        );
      }
      if (candidate.signedUrlExpiresAt !== undefined) {
        assertCanonicalTimestamp(
          candidate.signedUrlExpiresAt,
          "ProviderAccess.signedUrlExpiresAt",
        );
      }
      const lease = this.referenceGraph.getLease(candidate.leaseId);
      if (
        !lease ||
        lease.ownerKind !== "provider-access" ||
        lease.ownerId !== candidate.requestId ||
        lease.kind !== "provider-access" ||
        lease.targetKind !== "media" ||
        lease.targetId !== candidate.mediaId ||
        lease.expiresAt !== candidate.signedUrlExpiresAt
      ) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Provider access record is missing its exact access lease",
        );
      }
      expectedProviderLeases.add(candidate.leaseId);
      const record: ProviderAccessRecord = deepFreeze({
        leaseId: candidate.leaseId,
        mediaId: candidate.mediaId,
        ...(crop === undefined ? {} : { crop }),
        requestId: candidate.requestId,
        recipientId: candidate.recipientId,
        accessMode: candidate.accessMode,
        ...(candidate.signedUrlExpiresAt === undefined
          ? {}
          : { signedUrlExpiresAt: candidate.signedUrlExpiresAt }),
        requestStatus: candidate.requestStatus,
      });
      this.#providerAccess.set(record.leaseId, record);
    }

    const referenceGraph = this.referenceGraph.snapshot();
    for (const registration of this.#registrations.values()) {
      if (registration.state !== "deleting") continue;
      const target = { kind: "media" as const, id: registration.media.mediaId };
      let removalStarted = false;
      try {
        this.referenceGraph.beginRemoval([target]);
        removalStarted = true;
      } catch {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Deleting Media must be unreachable and have no remaining dependents",
        );
      } finally {
        if (removalStarted) this.referenceGraph.cancelRemoval([target]);
      }
    }
    const actualMediaIds = new Set(
      referenceGraph.nodes
        .filter((node) => node.target.kind === "media")
        .map((node) => node.target.id),
    );
    const actualProviderLeases = new Set(
      referenceGraph.leases
        .filter((lease) => lease.kind === "provider-access")
        .map((lease) => lease.leaseId),
    );
    const actualRegistrationReferences = new Set(
      referenceGraph.strongReferences
        .filter((reference) => reference.ownerKind === "media-registration")
        .map((reference) => JSON.stringify([
          reference.ownerId,
          reference.targetKind,
          reference.targetId,
        ])),
    );
    const expectedRegistrationReferences = new Set(
      [...this.#registrations.values()]
        .flatMap((registration) =>
          registration.state === "available" && registration.holdsRegistrationReference
            ? [JSON.stringify([
                registration.registrationId,
                "media",
                registration.media.mediaId,
              ])]
            : [],
        ),
    );
    const expectedUploadLeases = new Map<string, MediaStorageRecord>();
    for (const record of this.#storageRecords.values()) {
      if (record.state !== "uploading" && record.state !== "upload-failed") continue;
      if (
        record.uploadLeaseId === undefined ||
        expectedUploadLeases.has(record.uploadLeaseId)
      ) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Pending persistent uploads must have distinct storage-operation leases",
        );
      }
      expectedUploadLeases.set(record.uploadLeaseId, record);
    }
    const interruptedMediaReadLeaseIds: string[] = [];
    for (const lease of referenceGraph.leases.filter(
      (candidate) => candidate.kind === "media-read",
    )) {
      if (
        lease.ownerKind !== "media-read" ||
        lease.ownerId !== lease.leaseId ||
        lease.targetKind !== "media" ||
        !this.#media.has(lease.targetId) ||
        !this.#isAllocatedId(lease.leaseId, "lease") ||
        lease.moduleGenerationId !== undefined ||
        lease.moduleJobId !== undefined ||
        lease.runId !== undefined ||
        lease.expiresAt !== undefined
      ) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Interrupted Media read lease is invalid",
        );
      }
      interruptedMediaReadLeaseIds.push(lease.leaseId);
    }
    const observedUploadLeaseIds = new Set<string>();
    const interruptedStorageLeaseIds: string[] = [];
    for (const lease of referenceGraph.leases.filter(
      (candidate) => candidate.kind === "storage-operation",
    )) {
      if (
        lease.ownerKind !== "storage-operation" ||
        lease.ownerId !== lease.leaseId ||
        lease.targetKind !== "media" ||
        !this.#media.has(lease.targetId) ||
        !this.#isAllocatedId(lease.leaseId, "lease") ||
        lease.moduleGenerationId !== undefined ||
        lease.moduleJobId !== undefined ||
        lease.runId !== undefined ||
        lease.expiresAt !== undefined
      ) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Interrupted Media storage operation lease is invalid",
        );
      }
      const upload = expectedUploadLeases.get(lease.leaseId);
      if (upload) {
        if (upload.mediaId !== lease.targetId) {
          throw new MediaStoreError(
            "MEDIA_SNAPSHOT_INVALID",
            "Persistent upload storage record and access lease target different Media",
          );
        }
        observedUploadLeaseIds.add(lease.leaseId);
      } else {
        interruptedStorageLeaseIds.push(lease.leaseId);
      }
    }
    if (
      !this.#sameStringSet(actualMediaIds, new Set(this.#media.keys())) ||
      !this.#sameStringSet(actualProviderLeases, expectedProviderLeases) ||
      !this.#sameStringSet(
        observedUploadLeaseIds,
        new Set(expectedUploadLeases.keys()),
      ) ||
      !this.#sameStringSet(
        actualRegistrationReferences,
        expectedRegistrationReferences,
      )
    ) {
      throw new MediaStoreError(
        "MEDIA_SNAPSHOT_INVALID",
        "MediaStore snapshot and reference graph contain different media state",
      );
    }

    // A storage-operation lease without a storage record was persisted before
    // any locator or external write. It has no operation to recover.
    for (const leaseId of interruptedStorageLeaseIds) {
      this.referenceGraph.releaseLease(leaseId);
    }
    // No in-process byte copy survives a restart, so an interrupted media-read
    // lease has no remaining work or external access to protect.
    for (const leaseId of interruptedMediaReadLeaseIds) {
      this.referenceGraph.releaseLease(leaseId);
    }
    if (
      interruptedStorageLeaseIds.length > 0 ||
      interruptedMediaReadLeaseIds.length > 0
    ) {
      this.#persistenceDirty = true;
    }
  }

  #assertSameRegistrationInput(
    registration: MediaRegistrationRecord,
    digest: string,
    byteLength: number,
    declaredMimeType: string | undefined,
    provenance: MediaProvenance,
  ): void {
    const existing = registration.state === "deleted"
      ? registration
      : {
          digest: registration.media.digest,
          byteLength: registration.media.byteLength,
          declaredMimeType: registration.media.declaredMimeType,
          provenance: registration.media.provenance,
          mediaId: registration.media.mediaId,
        };
    if (
      existing.digest !== digest ||
      existing.byteLength !== byteLength ||
      existing.declaredMimeType !== declaredMimeType ||
      !sameProvenance(existing.provenance, provenance)
    ) {
      throw new MediaStoreError(
        "MEDIA_REGISTRATION_CONFLICT",
        `Media registration ${registration.registrationId} was already used for different input`,
        {
          registrationId: registration.registrationId,
          mediaId: existing.mediaId,
        },
      );
    }
  }

  async #hasRegistrationBytes(
    registration: ActiveMediaRegistrationRecord,
  ): Promise<boolean> {
    try {
      return await this.#bytes.has(registration.media.mediaId);
    } catch {
      throw new MediaStoreError(
        "MEDIA_BYTES_INVALID",
        `Stored bytes for Media ${registration.media.mediaId} cannot be inspected`,
        { mediaId: registration.media.mediaId },
      );
    }
  }

  async #validateStoredRegistrationBytes(
    registration: ActiveMediaRegistrationRecord,
  ): Promise<void> {
    let stored: Uint8Array;
    try {
      stored = await this.#bytes.get(registration.media.mediaId);
    } catch {
      throw new MediaStoreError(
        "MEDIA_BYTES_INVALID",
        `Stored bytes for Media ${registration.media.mediaId} are unavailable`,
        { mediaId: registration.media.mediaId },
      );
    }
    if (
      stored.byteLength !== registration.media.byteLength ||
      digestBytes(stored) !== registration.media.digest
    ) {
      throw new MediaStoreError(
        "MEDIA_BYTES_INVALID",
        `Stored bytes for Media ${registration.media.mediaId} do not match its registration`,
        { mediaId: registration.media.mediaId },
      );
    }
  }

  async #ensureRegistrationBytes(
    registration: ActiveMediaRegistrationRecord,
    bytes: Uint8Array,
  ): Promise<void> {
    if (await this.#hasRegistrationBytes(registration)) {
      await this.#validateStoredRegistrationBytes(registration);
      return;
    }
    await this.#bytes.put(registration.media.mediaId, bytes);
  }

  #completeRegistration(registration: ActiveMediaRegistrationRecord): Media {
    const current = this.#registrations.get(registration.registrationId);
    if (!current) {
      throw new MediaStoreError(
        "MEDIA_REGISTRATION_CONFLICT",
        "Media registration changed while it was being completed",
        { registrationId: registration.registrationId },
      );
    }
    if (current.state === "deleted") {
      throw new MediaStoreError(
        "MEDIA_REGISTRATION_DELETED",
        `Media registration ${current.registrationId} refers to deleted Media`,
        { registrationId: current.registrationId, mediaId: current.mediaId },
      );
    }
    if (current.media.mediaId !== registration.media.mediaId) {
      throw new MediaStoreError(
        "MEDIA_REGISTRATION_CONFLICT",
        "Media registration changed while it was being completed",
        { registrationId: registration.registrationId },
      );
    }
    if (current.state === "available") return current.media;
    if (current.state !== "pending") {
      throw new MediaStoreError(
        "MEDIA_DELETION_IN_PROGRESS",
        `Media ${current.media.mediaId} is being deleted`,
        { mediaId: current.media.mediaId },
      );
    }

    const target = { kind: "media" as const, id: current.media.mediaId };
    this.referenceGraph.registerNode(target);
    this.referenceGraph.addStrongReference(
      registrationReference(current.registrationId, current.media.mediaId),
    );
    const existingMedia = this.#media.get(current.media.mediaId);
    if (
      existingMedia &&
      canonicalJsonDigest(existingMedia) !== canonicalJsonDigest(current.media)
    ) {
      throw new MediaStoreError(
        "MEDIA_REGISTRATION_CONFLICT",
        "Media registration conflicts with existing Media metadata",
        { registrationId: current.registrationId, mediaId: current.media.mediaId },
      );
    }
    this.#media.set(current.media.mediaId, current.media);
    this.#registrations.set(current.registrationId, deepFreeze({
      ...current,
      state: "available" as const,
      holdsRegistrationReference: true,
    }));
    this.#persistMutation();
    return current.media;
  }

  async #runRegistrationOperation<T>(
    registrationId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#registrationOperationTails.get(registrationId) ?? Promise.resolve();
    let finish!: () => void;
    const current = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.#registrationOperationTails.set(registrationId, current);
    await previous;
    try {
      return await operation();
    } finally {
      finish();
      if (this.#registrationOperationTails.get(registrationId) === current) {
        this.#registrationOperationTails.delete(registrationId);
      }
    }
  }

  #removeExpiredDeletedRegistrations(): readonly string[] {
    const now = Date.parse(canonicalTime(this.#now));
    const removed: string[] = [];
    for (const registration of this.#registrations.values()) {
      if (
        registration.state !== "deleted" ||
        Date.parse(registration.retainUntil) > now
      ) {
        continue;
      }
      this.#registrations.delete(registration.registrationId);
      removed.push(registration.registrationId);
    }
    if (removed.length > 0) this.#persistMutation();
    return deepFreeze(removed.sort());
  }

  #totalStoredMediaBytes(): number {
    let total = 0;
    for (const registration of this.#registrations.values()) {
      if (registration.state === "deleted") continue;
      if (registration.media.byteLength > Number.MAX_SAFE_INTEGER - total) {
        return Number.MAX_SAFE_INTEGER;
      }
      total += registration.media.byteLength;
    }
    return total;
  }

  #assertLimit(
    limitName:
      | "maxRegistrationRecords"
      | "maxTotalMediaBytes"
      | "maxStorageRecords"
      | "maxProviderAccessRecords",
    limit: number,
    current: number,
    requested: number,
  ): void {
    if (current <= limit && requested <= limit - current) return;
    throw new MediaStoreError(
      "MEDIA_LIMIT_EXCEEDED",
      `${limitName} does not allow another Media resource`,
      { limitName, limit, current, requested },
    );
  }

  #sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
    return left.size === right.size && [...left].every((value) => right.has(value));
  }

  #requireMedia(mediaId: string): Media {
    assertId(mediaId, "mediaId");
    const media = this.#media.get(mediaId);
    if (!media) {
      throw new MediaStoreError("MEDIA_MISSING", `Media ${mediaId} does not exist`);
    }
    if (
      this.#deletingMediaIds.has(mediaId) ||
      this.#registrationForMedia(mediaId)?.state === "deleting"
    ) {
      throw new MediaStoreError(
        "MEDIA_DELETION_IN_PROGRESS",
        `Media ${mediaId} is being deleted`,
      );
    }
    return media;
  }

  #registrationForMedia(mediaId: string): ActiveMediaRegistrationRecord | null {
    for (const registration of this.#registrations.values()) {
      if (registration.state !== "deleted" && registration.media.mediaId === mediaId) {
        return registration;
      }
    }
    return null;
  }

  #allocate(kind: "media" | "storage-record" | "lease"): string {
    if (this.#nextIdSequence >= ID_SEQUENCE_LIMIT) {
      throw new MediaStoreError(
        "MEDIA_ID_EXHAUSTED",
        "The 128-bit Media identifier sequence is exhausted",
      );
    }
    const id = `${kind}:${this.#idNamespace}:${this.#nextIdSequence.toString(10)}`;
    this.#nextIdSequence += 1n;
    if (!ID_PATTERN.test(id)) {
      throw new MediaStoreError(
        "MEDIA_ID_INVALID",
        `Generated ${kind} ID exceeds the supported identifier syntax`,
      );
    }
    return id;
  }

  #isAllocatedId(
    value: string,
    kind: "media" | "storage-record" | "lease",
  ): boolean {
    const prefix = `${kind}:${this.#idNamespace}:`;
    if (!value.startsWith(prefix)) return false;
    const sequence = value.slice(prefix.length);
    if (!ID_SEQUENCE_PATTERN.test(sequence)) return false;
    return BigInt(sequence) < this.#nextIdSequence;
  }

  #storageRecordSummary(storageRecord: MediaStorageRecord): MediaStorageRecordSummary {
    return deepFreeze({
      storageRecordId: storageRecord.storageRecordId,
      mediaId: storageRecord.mediaId,
      adapterId: storageRecord.adapterId,
      visibility: storageRecord.visibility,
      state: storageRecord.state,
      ...(storageRecord.storageNamespace === undefined
        ? {}
        : { storageNamespace: storageRecord.storageNamespace }),
      ...(storageRecord.objectVersioning === undefined
        ? {}
        : { objectVersioning: storageRecord.objectVersioning }),
      uploadAttempts: storageRecord.uploadAttempts,
      ...(storageRecord.cancelRequested === undefined
        ? {}
        : { cancelRequested: true as const }),
      ...(storageRecord.uploadRetryable === undefined
        ? {}
        : { uploadRetryable: storageRecord.uploadRetryable }),
      ...(storageRecord.nextUploadAttemptAt === undefined
        ? {}
        : { nextUploadAttemptAt: storageRecord.nextUploadAttemptAt }),
      ...(storageRecord.lastUploadErrorCode === undefined
        ? {}
        : { lastUploadErrorCode: storageRecord.lastUploadErrorCode }),
      deleteAttempts: storageRecord.deleteAttempts,
      ...(storageRecord.deleteRetryable === undefined
        ? {}
        : { deleteRetryable: storageRecord.deleteRetryable }),
      ...(storageRecord.nextDeleteAttemptAt === undefined
        ? {}
        : { nextDeleteAttemptAt: storageRecord.nextDeleteAttemptAt }),
      ...(storageRecord.lastDeleteErrorCode === undefined
        ? {}
        : { lastDeleteErrorCode: storageRecord.lastDeleteErrorCode }),
    });
  }

  #assertLocator(value: unknown): asserts value is string {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 1024 ||
      /[\u0000-\u001f]/.test(value) ||
      value.includes("://") ||
      value.includes("?")
    ) {
      throw new MediaStoreError(
        "MEDIA_STORAGE_INVALID",
        "Storage adapter returned an invalid opaque locator",
      );
    }
  }

  #assertOpaqueStorageValue(value: unknown, label: string): asserts value is string {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 1024 ||
      /[\u0000-\u001f]/.test(value)
    ) {
      throw new MediaStoreError(
        "MEDIA_STORAGE_INVALID",
        `Storage adapter returned an invalid ${label}`,
      );
    }
  }

  #assertStoragePutResult(value: unknown): asserts value is StoragePutResult {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new MediaStoreError(
        "MEDIA_STORAGE_INVALID",
        "Storage adapter returned an invalid put result",
      );
    }
    const result = value as Partial<StoragePutResult>;
    this.#assertLocator(result.locator);
    if (result.objectVersion !== undefined) {
      this.#assertOpaqueStorageValue(result.objectVersion, "objectVersion");
    }
    if (result.entityTag !== undefined) {
      this.#assertOpaqueStorageValue(result.entityTag, "entityTag");
    }
  }

  #persistentDeleteInput(
    locator: string,
    objectVersioning: "disabled" | "enabled" | undefined,
    objectVersion: string | undefined,
    entityTag: string | undefined,
    signal: AbortSignal,
  ): PersistentStorageDeleteInput {
    if (objectVersioning === "enabled") {
      if (objectVersion === undefined) {
        throw new MediaStoreError(
          "MEDIA_SNAPSHOT_INVALID",
          "Versioned persistent storage is missing the object version required for deletion",
        );
      }
      return {
        locator,
        objectVersion,
        timeoutMs: this.#storageRequestTimeoutMs,
        signal,
      };
    }
    if (objectVersioning === "disabled" && entityTag !== undefined) {
      return {
        locator,
        expectedEntityTag: entityTag,
        timeoutMs: this.#storageRequestTimeoutMs,
        signal,
      };
    }
    throw new MediaStoreError(
      "MEDIA_SNAPSHOT_INVALID",
      "Persistent storage is missing the exact version or entity tag required for deletion",
    );
  }

  #adapterMatchesStorageRecord(
    adapter: StorageAdapter,
    record: MediaStorageRecord,
  ): boolean {
    if (record.storageNamespace === undefined) {
      return adapter.descriptor.durability === "volatile";
    }
    if (
      !isPersistentStorageAdapter(adapter) ||
      adapter.descriptor.storageNamespace === undefined ||
      adapter.descriptor.objectVersioning !== record.objectVersioning
    ) {
      return false;
    }
    try {
      return canonicalJsonDigest(normalizeStorageNamespace(
        adapter.descriptor.storageNamespace,
      )) === canonicalJsonDigest(record.storageNamespace);
    } catch {
      return false;
    }
  }

  async #continuePersistentUpload(
    input: MediaStorageRecord,
    explicit: boolean,
  ): Promise<MediaStorageRecord> {
    let record = this.#storageRecords.get(input.storageRecordId);
    if (!record || (record.state !== "uploading" && record.state !== "upload-failed")) {
      if (record) return record;
      throw new MediaStoreError(
        "MEDIA_SNAPSHOT_INVALID",
        "Persistent upload lost its storage record",
      );
    }
    if (record.cancelRequested) return record;
    if (!this.#uploadRetryIsDue(record, explicit)) return record;

    const adapter = this.#adapters.get(record.adapterId);
    if (
      !adapter ||
      !isPersistentStorageAdapter(adapter) ||
      typeof adapter.putOriginalIfAbsent !== "function" ||
      typeof adapter.headOriginal !== "function" ||
      adapter.descriptor.storageNamespace === undefined ||
      adapter.descriptor.objectVersioning === undefined
    ) {
      this.#recordUploadFailure(record, {
        code: "ADAPTER_UNAVAILABLE",
        retryable: false,
      });
      this.#persistMutation();
      return this.#storageRecords.get(record.storageRecordId)!;
    }

    let currentNamespace: Readonly<Record<string, JsonValue>>;
    try {
      currentNamespace = normalizeStorageNamespace(adapter.descriptor.storageNamespace);
    } catch {
      this.#recordUploadFailure(record, {
        code: "STORAGE_NAMESPACE_INVALID",
        retryable: false,
      });
      this.#persistMutation();
      return this.#storageRecords.get(record.storageRecordId)!;
    }
    if (
      record.storageNamespace === undefined ||
      record.objectVersioning !== adapter.descriptor.objectVersioning ||
      canonicalJsonDigest(record.storageNamespace) !== canonicalJsonDigest(currentNamespace)
    ) {
      this.#recordUploadFailure(record, {
        code: "STORAGE_NAMESPACE_MISMATCH",
        retryable: false,
      });
      this.#persistMutation();
      return this.#storageRecords.get(record.storageRecordId)!;
    }

    const firstHead = await this.#headStoredObject(adapter, record);
    if (firstHead.kind === "match") {
      return this.#completePersistentUpload(record, firstHead.result);
    }
    if (firstHead.kind === "failed") {
      this.#recordUploadFailure(record, firstHead.failure);
      this.#persistMutation();
      return this.#storageRecords.get(record.storageRecordId)!;
    }

    if (record.uploadAttempts >= Number.MAX_SAFE_INTEGER) {
      throw new MediaStoreError(
        "MEDIA_STORAGE_INVALID",
        "Persistent upload attempt count exceeds the safe integer range",
      );
    }
    const media = this.#requireMedia(record.mediaId);
    let bytes: Uint8Array;
    try {
      bytes = await this.#readVerifiedMediaBytes(media);
    } catch {
      this.#recordUploadFailure(record, {
        code: "MEDIA_BYTES_INVALID",
        retryable: false,
      });
      this.#persistMutation();
      return this.#storageRecords.get(record.storageRecordId)!;
    }
    const {
      uploadRetryable: _uploadRetryable,
      nextUploadAttemptAt: _nextUploadAttemptAt,
      lastUploadErrorCode: _lastUploadErrorCode,
      ...uploadBase
    } = record;
    record = deepFreeze({
      ...uploadBase,
      state: "uploading" as const,
      uploadAttempts: record.uploadAttempts + 1,
    });
    this.#storageRecords.set(record.storageRecordId, record);
    this.#persistMutation();

    let putResult: StoragePutResult | undefined;
    let putFailure: ClassifiedUploadError | undefined;
    try {
      putResult = await this.#callStorageAdapter((signal) =>
        adapter.putOriginalIfAbsent({
          storageRecordId: record.storageRecordId,
          mediaId: record.mediaId,
          digest: media.digest,
          mimeType: media.mimeType,
          bytes,
          locator: record.locator,
          storageNamespaceDigest: canonicalJsonDigest(record.storageNamespace!),
          timeoutMs: this.#storageRequestTimeoutMs,
          signal,
        }),
      );
      this.#assertStoragePutResult(putResult);
      if (putResult.locator !== record.locator) {
        putFailure = { code: "PUT_LOCATOR_MISMATCH", retryable: false };
      }
    } catch (error) {
      putFailure = error instanceof MediaStoreError
        ? { code: "PUT_RESULT_INVALID", retryable: false }
        : classifyUploadError(error);
    }

    const finalHead = await this.#headStoredObject(adapter, record);
    if (finalHead.kind === "match") {
      if (
        putResult?.objectVersion !== undefined &&
        finalHead.result.objectVersion !== putResult.objectVersion
      ) {
        this.#recordUploadFailure(record, {
          code: "OBJECT_VERSION_MISMATCH",
          retryable: false,
        });
        this.#persistMutation();
        return this.#storageRecords.get(record.storageRecordId)!;
      }
      if (putFailure?.code === "PUT_LOCATOR_MISMATCH") {
        this.#recordUploadFailure(record, putFailure);
        this.#persistMutation();
        return this.#storageRecords.get(record.storageRecordId)!;
      }
      return this.#completePersistentUpload(record, finalHead.result);
    }
    const failure = finalHead.kind === "failed"
      ? finalHead.failure
      : putFailure ?? { code: "OBJECT_NOT_VISIBLE", retryable: true };
    this.#recordUploadFailure(record, failure);
    this.#persistMutation();
    return this.#storageRecords.get(record.storageRecordId)!;
  }

  async #continueUploadCancellation(
    input: MediaStorageRecord,
  ): Promise<MediaStorageRecord | undefined> {
    const record = this.#storageRecords.get(input.storageRecordId);
    if (
      !record ||
      record.state !== "upload-failed" ||
      !record.cancelRequested ||
      record.uploadLeaseId === undefined
    ) {
      throw new MediaStoreError(
        "MEDIA_SNAPSHOT_INVALID",
        "Persistent upload cancellation lost its storage record or access lease",
      );
    }
    if (record.uploadAttempts === 0) {
      this.#removePendingUpload(record);
      return undefined;
    }
    const adapter = this.#adapters.get(record.adapterId);
    if (!adapter || !isPersistentStorageAdapter(adapter)) {
      this.#recordUploadFailure(record, {
        code: "ADAPTER_UNAVAILABLE",
        retryable: false,
      });
      this.#persistMutation();
      return this.#storageRecords.get(record.storageRecordId)!;
    }
    if (!this.#adapterMatchesStorageRecord(adapter, record)) {
      this.#recordUploadFailure(record, {
        code: "STORAGE_NAMESPACE_MISMATCH",
        retryable: false,
      });
      this.#persistMutation();
      return this.#storageRecords.get(record.storageRecordId)!;
    }
    const head = await this.#headStoredObject(adapter, record);
    if (head.kind === "absent") {
      this.#removePendingUpload(record);
      return undefined;
    }
    if (head.kind === "failed") {
      this.#recordUploadFailure(record, head.failure);
      this.#persistMutation();
      return this.#storageRecords.get(record.storageRecordId)!;
    }
    try {
      const result = await this.#callStorageAdapter((signal) =>
        adapter.deleteObject(this.#persistentDeleteInput(
          record.locator,
          record.objectVersioning,
          head.result.objectVersion,
          head.result.entityTag,
          signal,
        )),
      );
      if (result !== "deleted" && result !== "not-found") {
        throw Object.assign(
          new Error("Storage adapter returned an invalid delete result"),
          { code: "DELETE_RESULT_INVALID" },
        );
      }
    } catch (error) {
      this.#recordUploadFailure(record, classifyDeleteError(error));
      this.#persistMutation();
      return this.#storageRecords.get(record.storageRecordId)!;
    }
    this.#removePendingUpload(record);
    return undefined;
  }

  #removePendingUpload(record: MediaStorageRecord): void {
    if (record.uploadLeaseId === undefined) {
      throw new MediaStoreError(
        "MEDIA_SNAPSHOT_INVALID",
        "Pending persistent upload is missing its access lease identifier",
      );
    }
    this.#storageRecords.delete(record.storageRecordId);
    if (this.referenceGraph.releaseLease(record.uploadLeaseId) !== "released") {
      throw new MediaStoreError(
        "MEDIA_SNAPSHOT_INVALID",
        "Pending persistent upload access lease disappeared during cancellation",
      );
    }
    this.#persistMutation();
  }

  async #headStoredObject(
    adapter: PersistentStorageAdapter,
    record: MediaStorageRecord,
  ): Promise<
    | { readonly kind: "absent" }
    | { readonly kind: "match"; readonly result: Extract<StorageHeadResult, { status: "found" }> }
    | { readonly kind: "failed"; readonly failure: ClassifiedUploadError }
  > {
    let result: StorageHeadResult;
    try {
      result = await this.#callStorageAdapter((signal) =>
        adapter.headOriginal({
          locator: record.locator,
          timeoutMs: this.#storageRequestTimeoutMs,
          signal,
        }),
      );
    } catch (error) {
      return { kind: "failed", failure: classifyUploadError(error) };
    }
    if (result?.status === "not-found") return { kind: "absent" };
    if (result?.status !== "found") {
      return {
        kind: "failed",
        failure: { code: "HEAD_RESULT_INVALID", retryable: false },
      };
    }
    try {
      assertId(result.storageRecordId, "head.storageRecordId");
      this.#assertOpaqueStorageValue(result.digest, "head digest");
      this.#assertOpaqueStorageValue(result.mimeType, "head MIME type");
      this.#assertOpaqueStorageValue(
        result.storageNamespaceDigest,
        "head storage namespace digest",
      );
      if (!Number.isSafeInteger(result.byteLength) || result.byteLength <= 0) {
        throw new MediaStoreError(
          "MEDIA_STORAGE_INVALID",
          "Storage HEAD returned an invalid byteLength",
        );
      }
      if (result.objectVersion !== undefined) {
        this.#assertOpaqueStorageValue(result.objectVersion, "head objectVersion");
      }
      if (result.entityTag !== undefined) {
        this.#assertOpaqueStorageValue(result.entityTag, "head entityTag");
      }
    } catch {
      return {
        kind: "failed",
        failure: { code: "HEAD_RESULT_INVALID", retryable: false },
      };
    }
    const media = this.#media.get(record.mediaId);
    if (
      !media ||
      result.storageRecordId !== record.storageRecordId ||
      result.digest !== media.digest ||
      result.byteLength !== media.byteLength ||
      result.mimeType !== media.mimeType ||
      record.storageNamespace === undefined ||
      result.storageNamespaceDigest !== canonicalJsonDigest(record.storageNamespace) ||
      (record.objectVersioning === "enabled" && result.objectVersion === undefined) ||
      (record.objectVersioning === "disabled" &&
        (result.objectVersion !== undefined || result.entityTag === undefined))
    ) {
      return {
        kind: "failed",
        failure: { code: "OBJECT_METADATA_MISMATCH", retryable: false },
      };
    }
    return { kind: "match", result };
  }

  #completePersistentUpload(
    record: MediaStorageRecord,
    result: Extract<StorageHeadResult, { status: "found" }>,
  ): MediaStorageRecord {
    const {
      uploadLeaseId,
      cancelRequested: _cancelRequested,
      uploadRetryable: _uploadRetryable,
      nextUploadAttemptAt: _nextUploadAttemptAt,
      lastUploadErrorCode: _lastUploadErrorCode,
      ...availableBase
    } = record;
    if (uploadLeaseId === undefined) {
      throw new MediaStoreError(
        "MEDIA_SNAPSHOT_INVALID",
        "Persistent upload is missing its access lease identifier",
      );
    }
    const available: MediaStorageRecord = deepFreeze({
      ...availableBase,
      state: "available" as const,
      ...(result.objectVersion === undefined
        ? {}
        : { objectVersion: result.objectVersion }),
      ...(result.entityTag === undefined ? {} : { entityTag: result.entityTag }),
    });
    this.#storageRecords.set(available.storageRecordId, available);
    if (this.referenceGraph.releaseLease(uploadLeaseId) !== "released") {
      throw new MediaStoreError(
        "MEDIA_SNAPSHOT_INVALID",
        "Persistent upload access lease disappeared before completion",
      );
    }
    this.#persistMutation();
    return available;
  }

  #recordUploadFailure(
    record: MediaStorageRecord,
    failure: ClassifiedUploadError,
  ): void {
    let nextUploadAttemptAt: string | undefined;
    if (failure.retryable) {
      const delay = this.#uploadRetryDelayMs(record.uploadAttempts);
      if (!Number.isSafeInteger(delay) || delay < 0) {
        throw new MediaStoreError(
          "MEDIA_STORAGE_INVALID",
          "uploadRetryDelayMs must return a non-negative safe integer",
        );
      }
      const next = Date.parse(canonicalTime(this.#now)) + delay;
      if (!Number.isFinite(next)) {
        throw new MediaStoreError(
          "MEDIA_STORAGE_INVALID",
          "Persistent upload retry time exceeds the supported timestamp range",
        );
      }
      nextUploadAttemptAt = new Date(next).toISOString();
    }
    const {
      uploadRetryable: _uploadRetryable,
      nextUploadAttemptAt: _nextUploadAttemptAt,
      lastUploadErrorCode: _lastUploadErrorCode,
      ...failedBase
    } = record;
    const failed: MediaStorageRecord = deepFreeze({
      ...failedBase,
      state: "upload-failed" as const,
      uploadRetryable: failure.retryable,
      ...(nextUploadAttemptAt === undefined ? {} : { nextUploadAttemptAt }),
      lastUploadErrorCode: failure.code,
    });
    this.#storageRecords.set(failed.storageRecordId, failed);
  }

  #uploadRetryIsDue(record: MediaStorageRecord, explicit: boolean): boolean {
    if (record.state === "uploading" || explicit) return true;
    if (record.state !== "upload-failed" || !record.uploadRetryable) return false;
    if (record.nextUploadAttemptAt === undefined) return false;
    return Date.parse(canonicalTime(this.#now)) >= Date.parse(record.nextUploadAttemptAt);
  }

  async #callStorageAdapter<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = Object.assign(
      new Error("Storage request exceeded its configured timeout"),
      { code: "STORAGE_REQUEST_TIMEOUT" },
    );
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(timeoutError);
        reject(timeoutError);
      }, this.#storageRequestTimeoutMs);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #callPersistentStorageDelete(
    record: MediaStorageRecord,
    adapter: PersistentStorageAdapter,
  ): Promise<"deleted" | "not-found"> {
    if (this.#activeStorageDeleteRequests.has(record.storageRecordId)) {
      throw Object.assign(
        new Error("The previous storage delete request has not settled"),
        { code: "STORAGE_REQUEST_TIMEOUT" },
      );
    }
    this.#activeStorageDeleteRequests.add(record.storageRecordId);
    return this.#callStorageAdapter(async (signal) => {
      try {
        return await adapter.deleteObject(this.#persistentDeleteInput(
          record.locator,
          record.objectVersioning,
          record.objectVersion,
          record.entityTag,
          signal,
        ));
      } finally {
        this.#activeStorageDeleteRequests.delete(record.storageRecordId);
      }
    });
  }

  async #runStorageOperation<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#storageOperationTails.get(key) ?? Promise.resolve();
    let finish!: () => void;
    const current = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.#storageOperationTails.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      finish();
      if (this.#storageOperationTails.get(key) === current) {
        this.#storageOperationTails.delete(key);
      }
    }
  }

  async #createTrackedProviderAccess(
    media: Media,
    request: ProviderAccessRequest,
    signedUrlExpiresAt: string | undefined,
    createGrant: (leaseId: string) => Promise<UrlMediaAccessGrant | null>,
  ): Promise<UrlMediaAccessGrant | null> {
    this.#assertLimit(
      "maxProviderAccessRecords",
      this.#maxProviderAccessRecords,
      this.#providerAccess.size + this.#providerAccessReservations,
      1,
    );
    this.#providerAccessReservations += 1;
    try {
      const leaseId = this.#allocate("lease");
      const lease: AccessLease = {
        leaseId,
        ownerKind: "provider-access",
        ownerId: request.requestId,
        targetKind: "media",
        targetId: media.mediaId,
        kind: "provider-access",
        ...(signedUrlExpiresAt === undefined ? {} : { expiresAt: signedUrlExpiresAt }),
      };
      this.referenceGraph.acquireLease(lease);
      try {
        const grant = await createGrant(leaseId);
        if (grant === null) {
          this.referenceGraph.releaseLease(leaseId);
          return null;
        }
        return this.#storeProviderAccessRecord(grant, request.requestId);
      } catch (error) {
        if (error instanceof MediaStoreError && error.code === "MEDIA_PERSISTENCE_FAILED") {
          throw error;
        }
        this.referenceGraph.releaseLease(leaseId);
        throw error;
      }
    } finally {
      this.#providerAccessReservations -= 1;
    }
  }

  #storeProviderAccessRecord(
    grant: UrlMediaAccessGrant,
    requestId: string,
  ): UrlMediaAccessGrant {
    const record: ProviderAccessRecord = deepFreeze({
      leaseId: grant.leaseId,
      mediaId: grant.mediaId,
      ...(grant.crop === undefined ? {} : { crop: grant.crop }),
      requestId,
      recipientId: grant.recipientId,
      accessMode: grant.accessMode,
      ...(grant.accessMode === "private-signed"
        ? { signedUrlExpiresAt: grant.expiresAt }
        : {}),
      requestStatus: "awaiting-result" as const,
    });
    if (this.#providerAccess.has(record.leaseId)) {
      this.referenceGraph.releaseLease(record.leaseId);
      throw new MediaStoreError(
        "MEDIA_ID_CONFLICT",
        "Provider access lease was already tracked",
      );
    }
    this.#providerAccess.set(record.leaseId, record);
    this.#persistMutation();
    return grant;
  }

  async #trySignedGrant(
    media: Media,
    crop: PixelCrop | undefined,
    request: ProviderAccessRequest,
    leaseId: string,
    expiresAt: string,
  ): Promise<UrlMediaAccessGrant | null> {
    for (const storageRecord of this.#availableStorageRecords(media.mediaId)) {
      const adapter = this.#adapters.get(storageRecord.adapterId);
      if (!adapter || !this.#adapterMatchesStorageRecord(adapter, storageRecord)) continue;
      if (!adapter.descriptor.signedGet || !adapter.signGet) continue;
      if (crop !== undefined && !adapter.descriptor.supportsSignedCrop) continue;
      const url = await adapter.signGet({
        locator: storageRecord.locator,
        expiresInSeconds: request.signedUrlExpiresInSeconds!,
        ...(storageRecord.objectVersion === undefined
          ? {}
          : { objectVersion: storageRecord.objectVersion }),
        ...(crop === undefined ? {} : { crop }),
      });
      this.#assertAccessUrl(url);
      return deepFreeze({
        schemaVersion: "dolly.media-access-grant/5" as const,
        accessMode: "private-signed" as const,
        mediaId: media.mediaId,
        ...(request.crop === undefined ? {} : { crop: request.crop }),
        recipientId: request.recipientId,
        leaseId,
        expiresAt,
        url,
      });
    }
    return null;
  }

  async #tryPublicGrant(
    media: Media,
    request: ProviderAccessRequest,
    leaseId: string,
  ): Promise<UrlMediaAccessGrant | null> {
    if (request.crop !== undefined) return null;
    for (const storageRecord of this.#availableStorageRecords(media.mediaId)) {
      const adapter = this.#adapters.get(storageRecord.adapterId);
      if (!adapter || !this.#adapterMatchesStorageRecord(adapter, storageRecord)) continue;
      if (
        storageRecord.visibility !== "public" ||
        !adapter.descriptor.publicUrl ||
        !adapter.getPublicUrl
      ) {
        continue;
      }
      const url = await adapter.getPublicUrl(
        storageRecord.locator,
        storageRecord.objectVersion,
      );
      this.#assertAccessUrl(url);
      return deepFreeze({
        schemaVersion: "dolly.media-access-grant/5" as const,
        accessMode: "public-url" as const,
        mediaId: media.mediaId,
        recipientId: request.recipientId,
        leaseId,
        url,
      });
    }
    return null;
  }

  #availableStorageRecords(mediaId: string): MediaStorageRecord[] {
    return [...this.#storageRecords.values()].filter(
      (storageRecord) =>
        storageRecord.mediaId === mediaId && storageRecord.state === "available",
    );
  }

  #assertAccessUrl(value: string): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new MediaStoreError("MEDIA_STORAGE_INVALID", "Adapter returned an invalid URL");
    }
    if (url.protocol !== "https:") {
      throw new MediaStoreError(
        "MEDIA_STORAGE_INVALID",
        "Provider media URLs must use HTTPS",
      );
    }
  }

  #persistMutation(): void {
    if (!this.#onMutation) return;
    this.#persistenceDirty = true;
    this.#notifyMutationObserver();
  }

  #notifyMutationObserver(): void {
    if (!this.#onMutation) return;
    if (this.#notifyingMutation) {
      throw new MediaStoreError(
        "MEDIA_PERSISTENCE_FAILED",
        "MediaStore mutation observer re-entered the store",
      );
    }
    this.#notifyingMutation = true;
    try {
      const result = (this.#onMutation as () => unknown)();
      if (result !== undefined) {
        throw new TypeError("MediaStore mutation observers must complete synchronously");
      }
      this.#persistenceDirty = false;
    } catch {
      throw new MediaStoreError(
        "MEDIA_PERSISTENCE_FAILED",
        "MediaStore state could not be persisted",
      );
    } finally {
      this.#notifyingMutation = false;
    }
  }
}
