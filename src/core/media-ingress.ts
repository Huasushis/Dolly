import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { deepFreeze, type JsonValue } from "./canonical-json.js";
import {
  type Media,
  type MediaStore,
} from "./media-store.js";
import {
  type SecureRemoteFetcher,
  type SecureRemoteFetchPolicy,
} from "./secure-remote-fetch.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const WINDOWS_DEVICE_COMPONENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function defaultCapabilityToken(): string {
  // 32 random bytes provide 256 bits of entropy. The prefix keeps the token
  // within the identifier syntax even when the Base64 URL-safe value starts
  // with a punctuation character.
  return `capability-${randomBytes(32).toString("base64url")}`;
}

export type MediaIngressMode =
  | "streamed-upload"
  | "extension-bytes"
  | "local-file"
  | "remote-fetch";

/**
 * A Media ingress capability handle is a short-lived bearer authorization for
 * one subject to submit bytes through one approved input mode. The
 * MediaIngressAuthority validates it before MediaIngressService calls
 * MediaStore; MediaStore manages already-authorized bytes and does not grant
 * filesystem or network read authority itself. Capability is the standard
 * security term for an unforgeable token that carries limited authority.
 */
export interface MediaIngressCapabilityHandle {
  readonly token: string;
  readonly subjectId: string;
}

export interface MediaIngressCapabilityRequest {
  readonly subjectId: string;
  readonly mode: MediaIngressMode;
  readonly registrationId: string;
  readonly maxBytes: number;
  readonly localRoots?: readonly string[];
  readonly remotePolicy?: SecureRemoteFetchPolicy;
  readonly expiresAt: string;
}

interface MediaIngressCapabilityRecord extends MediaIngressCapabilityHandle {
  readonly mode: MediaIngressMode;
  readonly registrationId: string;
  readonly maxBytes: number;
  readonly localRoots: readonly string[];
  readonly remotePolicy?: SecureRemoteFetchPolicy;
  readonly expiresAt: string;
}

export type MediaIngressErrorCode =
  | "MEDIA_CAPABILITY_INVALID"
  | "MEDIA_CAPABILITY_DENIED"
  | "MEDIA_CAPABILITY_EXPIRED"
  | "MEDIA_INGRESS_ID_INVALID"
  | "MEDIA_INGRESS_LIMIT"
  | "MEDIA_LOCAL_PATH_INVALID"
  | "MEDIA_LOCAL_PATH_DENIED"
  | "MEDIA_LOCAL_BACKEND_UNAVAILABLE"
  | "MEDIA_REMOTE_BACKEND_UNAVAILABLE";

export class MediaIngressError extends Error {
  constructor(
    readonly code: MediaIngressErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "MediaIngressError";
  }
}

function assertId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new MediaIngressError(
      "MEDIA_CAPABILITY_INVALID",
      `${label} is not a valid identifier`,
    );
  }
}

function assertRegistrationId(value: string): void {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new MediaIngressError(
      "MEDIA_INGRESS_ID_INVALID",
      "registrationId is not a valid identifier",
    );
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function registrationIdForSubject(subjectId: string, registrationId: string): string {
  assertRegistrationId(registrationId);
  const digest = createHash("sha256")
    .update(JSON.stringify([subjectId, registrationId]), "utf8")
    .digest("hex");
  return `registration:${digest}`;
}

function canonicalTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new MediaIngressError(
      "MEDIA_CAPABILITY_INVALID",
      "Capability expiry or runtime clock is invalid",
    );
  }
  return new Date(timestamp).toISOString();
}

function isWindowsPath(value: string): boolean {
  return WINDOWS_ABSOLUTE.test(value) || value.startsWith("\\\\");
}

function assertNoWindowsDeviceComponents(value: string): void {
  const withoutDrive = value.replace(/^[A-Za-z]:/, "");
  for (const component of withoutDrive.split(/[\\/]+/)) {
    if (
      component === "" ||
      component === "." ||
      component === ".."
    ) {
      continue;
    }
    if (
      WINDOWS_DEVICE_COMPONENT.test(component) ||
      component.endsWith(".") ||
      component.endsWith(" ") ||
      component.includes(":")
    ) {
      throw new MediaIngressError(
        "MEDIA_LOCAL_PATH_INVALID",
        "Windows device paths, alternate streams, and ambiguous components are denied",
      );
    }
  }
}

function normalizeLocalAbsolute(value: string): { path: string; flavor: "win32" | "posix" } {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new MediaIngressError("MEDIA_LOCAL_PATH_INVALID", "Local path is invalid");
  }
  if (value.startsWith("//")) {
    throw new MediaIngressError(
      "MEDIA_LOCAL_PATH_INVALID",
      "Network-style local paths are denied",
    );
  }
  if (isWindowsPath(value)) {
    if (
      value.startsWith("\\\\") ||
      value.startsWith("//") ||
      /^\\\\[?.]\\/.test(value)
    ) {
      throw new MediaIngressError(
        "MEDIA_LOCAL_PATH_INVALID",
        "UNC, device, and extended Windows paths are denied",
      );
    }
    if (!WINDOWS_ABSOLUTE.test(value)) {
      throw new MediaIngressError("MEDIA_LOCAL_PATH_INVALID", "Local path must be absolute");
    }
    assertNoWindowsDeviceComponents(value);
    return { path: path.win32.normalize(value), flavor: "win32" };
  }
  if (!path.posix.isAbsolute(value)) {
    throw new MediaIngressError("MEDIA_LOCAL_PATH_INVALID", "Local path must be absolute");
  }
  return { path: path.posix.normalize(value), flavor: "posix" };
}

function pathInsideRoot(candidateInput: string, rootInput: string): boolean {
  const candidate = normalizeLocalAbsolute(candidateInput);
  const root = normalizeLocalAbsolute(rootInput);
  if (candidate.flavor !== root.flavor) return false;
  const api = candidate.flavor === "win32" ? path.win32 : path.posix;
  const candidatePath = candidate.flavor === "win32" ? candidate.path.toLowerCase() : candidate.path;
  const rootPath = root.flavor === "win32" ? root.path.toLowerCase() : root.path;
  const relative = api.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !api.isAbsolute(relative));
}

export interface SecureLocalFileReadRequest {
  readonly candidatePath: string;
  readonly approvedRoot: string;
  readonly maxBytes: number;
}

export interface SecureLocalFileReader {
  read(request: SecureLocalFileReadRequest): Promise<Uint8Array>;
}

export class UnavailableLocalFileReader implements SecureLocalFileReader {
  async read(_request: SecureLocalFileReadRequest): Promise<Uint8Array> {
    throw new MediaIngressError(
      "MEDIA_LOCAL_BACKEND_UNAVAILABLE",
      "No backend can verify the final opened file identity on this deployment",
    );
  }
}

/**
 * The Media ingress authority issues and validates Media ingress capability
 * handles. It is separate from MediaStore so the store remains responsible
 * for registered Media lifecycle while this class owns caller authorization
 * before input/output begins.
 */
export class MediaIngressAuthority {
  readonly #capabilities = new Map<string, {
    readonly record: MediaIngressCapabilityRecord;
    running: boolean;
    revoked: boolean;
  }>();
  readonly #nextToken: () => string;
  readonly #now: () => string;
  readonly #maxActiveCapabilities: number;
  readonly #maxConcurrentOperations: number;
  readonly #maxCapabilityLifetimeMs: number;
  #activeOperations = 0;

  constructor(options: {
    /** Test-only override. Production uses the cryptographically random default. */
    readonly nextToken?: () => string;
    readonly now: () => string;
    readonly maxActiveCapabilities: number;
    readonly maxConcurrentOperations: number;
    readonly maxCapabilityLifetimeMs: number;
  }) {
    assertPositiveSafeInteger(
      options.maxActiveCapabilities,
      "maxActiveCapabilities",
    );
    assertPositiveSafeInteger(
      options.maxConcurrentOperations,
      "maxConcurrentOperations",
    );
    assertPositiveSafeInteger(
      options.maxCapabilityLifetimeMs,
      "maxCapabilityLifetimeMs",
    );
    this.#nextToken = options.nextToken ?? defaultCapabilityToken;
    this.#now = options.now;
    this.#maxActiveCapabilities = options.maxActiveCapabilities;
    this.#maxConcurrentOperations = options.maxConcurrentOperations;
    this.#maxCapabilityLifetimeMs = options.maxCapabilityLifetimeMs;
  }

  issue(request: MediaIngressCapabilityRequest): MediaIngressCapabilityHandle {
    const now = Date.parse(canonicalTime(this.#now()));
    this.#removeExpiredCapabilities(now);
    assertId(request.subjectId, "subjectId");
    assertId(request.registrationId, "registrationId");
    const allowedModes: readonly MediaIngressMode[] = [
      "streamed-upload",
      "extension-bytes",
      "local-file",
      "remote-fetch",
    ];
    if (!allowedModes.includes(request.mode)) {
      throw new MediaIngressError(
        "MEDIA_CAPABILITY_INVALID",
        "Capability contains an unsupported ingress mode",
      );
    }
    if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0) {
      throw new MediaIngressError(
        "MEDIA_CAPABILITY_INVALID",
        "Capability maxBytes must be a positive safe integer",
      );
    }
    if (request.localRoots !== undefined && !Array.isArray(request.localRoots)) {
      throw new MediaIngressError(
        "MEDIA_CAPABILITY_INVALID",
        "Capability localRoots must be an array",
      );
    }
    const localRoots = [...new Set((request.localRoots ?? []).map((root) => normalizeLocalAbsolute(root).path))];
    if ((request.mode === "local-file") !== (localRoots.length > 0)) {
      throw new MediaIngressError(
        "MEDIA_CAPABILITY_INVALID",
        "Local-file mode requires roots and roots require local-file mode",
      );
    }
    if ((request.mode === "remote-fetch") !== (request.remotePolicy !== undefined)) {
      throw new MediaIngressError(
        "MEDIA_CAPABILITY_INVALID",
        "Remote-fetch mode requires a policy and a policy requires remote-fetch mode",
      );
    }
    const expiresAt = canonicalTime(request.expiresAt);
    const expiresAtTime = Date.parse(expiresAt);
    if (expiresAtTime <= now) {
      throw new MediaIngressError(
        "MEDIA_CAPABILITY_INVALID",
        "Capability expiry must be in the future",
      );
    }
    if (expiresAtTime - now > this.#maxCapabilityLifetimeMs) {
      throw new MediaIngressError(
        "MEDIA_CAPABILITY_INVALID",
        "Capability lifetime exceeds the configured limit",
      );
    }
    if (this.#capabilities.size >= this.#maxActiveCapabilities) {
      throw new MediaIngressError(
        "MEDIA_INGRESS_LIMIT",
        "Active Media ingress capability limit is reached",
      );
    }
    const token = this.#nextToken();
    assertId(token, "capability token");
    if (this.#capabilities.has(token)) {
      throw new MediaIngressError(
        "MEDIA_CAPABILITY_INVALID",
        "Capability token generator returned a duplicate",
      );
    }
    const remotePolicy =
      request.remotePolicy === undefined
        ? undefined
        : {
            allowedHosts: [...request.remotePolicy.allowedHosts],
            ...(request.remotePolicy.allowAnyPublicHost === undefined
              ? {}
              : { allowAnyPublicHost: request.remotePolicy.allowAnyPublicHost }),
            ...(request.remotePolicy.allowedPorts === undefined
              ? {}
              : { allowedPorts: [...request.remotePolicy.allowedPorts] }),
            maxUrlBytes: request.remotePolicy.maxUrlBytes,
            maxRedirects: request.remotePolicy.maxRedirects,
            maxBytes: request.remotePolicy.maxBytes,
            connectTimeoutMs: request.remotePolicy.connectTimeoutMs,
            headerTimeoutMs: request.remotePolicy.headerTimeoutMs,
            totalTimeoutMs: request.remotePolicy.totalTimeoutMs,
          };
    const record = deepFreeze({
      token,
      subjectId: request.subjectId,
      mode: request.mode,
      registrationId: request.registrationId,
      maxBytes: request.maxBytes,
      localRoots,
      ...(remotePolicy === undefined ? {} : { remotePolicy }),
      expiresAt,
    });
    this.#capabilities.set(token, { record, running: false, revoked: false });
    return deepFreeze({ token, subjectId: request.subjectId });
  }

  revoke(token: string): "revoked" | "absent" {
    const state = this.#capabilities.get(token);
    if (!state) return "absent";
    state.revoked = true;
    if (!state.running) this.#capabilities.delete(token);
    return "revoked";
  }

  async withAuthorization<T>(
    handle: MediaIngressCapabilityHandle,
    mode: MediaIngressMode,
    registrationId: string,
    operation: (record: MediaIngressCapabilityRecord) => Promise<T>,
  ): Promise<T> {
    const record = this.authorize(handle, registrationId);
    if (record.mode !== mode) {
      throw new MediaIngressError(
        "MEDIA_CAPABILITY_DENIED",
        "Media ingress capability does not authorize this operation",
      );
    }
    const state = this.#capabilities.get(record.token);
    if (!state || state.record !== record || state.revoked) {
      throw new MediaIngressError(
        "MEDIA_CAPABILITY_DENIED",
        "Media ingress capability is no longer available",
      );
    }
    if (state.running) {
      throw new MediaIngressError(
        "MEDIA_INGRESS_LIMIT",
        "Media ingress capability already has an operation in progress",
      );
    }
    if (this.#activeOperations >= this.#maxConcurrentOperations) {
      throw new MediaIngressError(
        "MEDIA_INGRESS_LIMIT",
        "Concurrent Media ingress operation limit is reached",
      );
    }
    state.running = true;
    this.#activeOperations += 1;
    try {
      return await operation(record);
    } finally {
      state.running = false;
      this.#activeOperations -= 1;
      const current = this.#capabilities.get(record.token);
      if (current === state && (state.revoked || this.#isExpired(record))) {
        this.#capabilities.delete(record.token);
      }
    }
  }

  authorize(
    handle: MediaIngressCapabilityHandle,
    registrationId: string,
  ): MediaIngressCapabilityRecord {
    assertRegistrationId(registrationId);
    assertId(handle.token, "capability token");
    assertId(handle.subjectId, "subjectId");
    const state = this.#capabilities.get(handle.token);
    const record = state?.record;
    if (!state || !record || state.revoked || record.subjectId !== handle.subjectId) {
      throw new MediaIngressError(
        "MEDIA_CAPABILITY_DENIED",
        "Media ingress capability does not authorize this subject",
      );
    }
    if (this.#isExpired(record, true)) {
      if (!state.running) this.#capabilities.delete(handle.token);
      throw new MediaIngressError(
        "MEDIA_CAPABILITY_EXPIRED",
        "Media ingress capability has expired",
      );
    }
    if (record.registrationId !== registrationId) {
      throw new MediaIngressError(
        "MEDIA_CAPABILITY_DENIED",
        "Media ingress capability does not authorize this registration",
      );
    }
    return record;
  }

  #removeExpiredCapabilities(now: number): void {
    for (const [token, state] of this.#capabilities) {
      if (!state.running && Date.parse(state.record.expiresAt) <= now) {
        this.#capabilities.delete(token);
      }
    }
  }

  #isExpired(record: MediaIngressCapabilityRecord, requireValidClock = false): boolean {
    const nowValue = this.#now();
    const now = Date.parse(nowValue);
    if (!Number.isFinite(now)) {
      if (requireValidClock) canonicalTime(nowValue);
      return false;
    }
    return Date.parse(record.expiresAt) <= now;
  }
}

export interface MediaIngressServiceOptions {
  readonly authority: MediaIngressAuthority;
  readonly media: MediaStore;
  readonly maxIngressBytes: number;
  readonly localFiles?: SecureLocalFileReader;
  readonly remote?: Pick<SecureRemoteFetcher, "fetch">;
}

interface MediaIngressRequest {
  readonly capability: MediaIngressCapabilityHandle;
  readonly registrationId: string;
  readonly declaredMimeType?: string;
}

export class MediaIngressService {
  readonly #authority: MediaIngressAuthority;
  readonly #media: MediaStore;
  readonly #maxIngressBytes: number;
  readonly #localFiles: SecureLocalFileReader;
  readonly #remote?: Pick<SecureRemoteFetcher, "fetch">;

  constructor(options: MediaIngressServiceOptions) {
    if (!Number.isSafeInteger(options.maxIngressBytes) || options.maxIngressBytes <= 0) {
      throw new TypeError("maxIngressBytes must be a positive safe integer");
    }
    this.#authority = options.authority;
    this.#media = options.media;
    this.#maxIngressBytes = options.maxIngressBytes;
    this.#localFiles = options.localFiles ?? new UnavailableLocalFileReader();
    this.#remote = options.remote;
  }

  async ingestStreamedUpload(
    request: MediaIngressRequest & { readonly chunks: AsyncIterable<Uint8Array> },
  ): Promise<Media> {
    return this.#authority.withAuthorization(
      request.capability,
      "streamed-upload",
      request.registrationId,
      async (record) => {
        const maxBytes = this.#effectiveMaxBytes(record);
        const bytes = await this.#readChunks(request.chunks, maxBytes);
        return this.#registerBytes(
          { ...request, bytes },
          "streamed-upload",
          record.subjectId,
          maxBytes,
        );
      },
    );
  }

  async ingestExtensionBytes(
    request: MediaIngressRequest & { readonly bytes: Uint8Array },
  ): Promise<Media> {
    return this.#authority.withAuthorization(
      request.capability,
      "extension-bytes",
      request.registrationId,
      (record) => {
        const maxBytes = this.#effectiveMaxBytes(record);
        return this.#registerBytes(
          request,
          "extension-bytes",
          record.subjectId,
          maxBytes,
        );
      },
    );
  }

  async ingestLocalFile(
    request: MediaIngressRequest & { readonly candidatePath: string },
  ): Promise<Media> {
    return this.#authority.withAuthorization(
      request.capability,
      "local-file",
      request.registrationId,
      async (record) => {
        const candidate = normalizeLocalAbsolute(request.candidatePath).path;
        const approvedRoot = record.localRoots.find((root) => pathInsideRoot(candidate, root));
        if (!approvedRoot) {
          throw new MediaIngressError(
            "MEDIA_LOCAL_PATH_DENIED",
            "Local path is outside the capability roots",
          );
        }
        const maxBytes = this.#effectiveMaxBytes(record);
        const bytes = await this.#localFiles.read({
          candidatePath: candidate,
          approvedRoot,
          maxBytes,
        });
        return this.#registerBytes(
          { ...request, bytes },
          "local-file",
          record.subjectId,
          maxBytes,
        );
      },
    );
  }

  async ingestRemoteFetch(
    request: Omit<MediaIngressRequest, "declaredMimeType"> & { readonly url: string },
  ): Promise<Media> {
    return this.#authority.withAuthorization(
      request.capability,
      "remote-fetch",
      request.registrationId,
      async (record) => {
        if (!this.#remote || !record.remotePolicy) {
          throw new MediaIngressError(
            "MEDIA_REMOTE_BACKEND_UNAVAILABLE",
            "No secure remote fetch backend is configured",
          );
        }
        const maxBytes = Math.min(
          this.#effectiveMaxBytes(record),
          record.remotePolicy.maxBytes,
        );
        const result = await this.#remote.fetch(request.url, {
          ...record.remotePolicy,
          maxBytes,
        });
        this.#assertBytes(result.bytes, maxBytes);
        return this.#media.registerMedia(
          {
            registrationId: registrationIdForSubject(
              record.subjectId,
              request.registrationId,
            ),
            bytes: result.bytes,
            ...(result.contentType === undefined ? {} : { declaredMimeType: result.contentType }),
            provenance: {
              sourceClass: "remote-fetch",
              sourceLabel: result.finalOrigin,
            },
          },
        );
      },
    );
  }

  releaseRegistration(request: {
    readonly capability: MediaIngressCapabilityHandle;
    readonly registrationId: string;
  }): "released" | "already-released" {
    const record = this.#authority.authorize(
      request.capability,
      request.registrationId,
    );
    return this.#media.releaseRegistration(
      registrationIdForSubject(record.subjectId, request.registrationId),
    );
  }

  #registerBytes(
    request: MediaIngressRequest & { readonly bytes: Uint8Array },
    sourceClass: "streamed-upload" | "extension-bytes" | "local-file",
    subjectId: string,
    maxBytes: number,
  ): Promise<Media> {
    this.#assertBytes(request.bytes, maxBytes);
    return this.#media.registerMedia(
      {
        registrationId: registrationIdForSubject(subjectId, request.registrationId),
        bytes: request.bytes,
        ...(request.declaredMimeType === undefined
          ? {}
          : { declaredMimeType: request.declaredMimeType }),
        provenance: {
          sourceClass,
          ...(sourceClass === "extension-bytes"
            ? { sourceLabel: request.capability.subjectId }
            : {}),
        },
      },
    );
  }

  #effectiveMaxBytes(record: MediaIngressCapabilityRecord): number {
    return Math.min(this.#maxIngressBytes, record.maxBytes);
  }

  #assertBytes(bytes: Uint8Array, maxBytes: number): void {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > maxBytes
    ) {
      throw new MediaIngressError(
        "MEDIA_INGRESS_LIMIT",
        `Media bytes must be between 1 and ${maxBytes}`,
      );
    }
  }

  async #readChunks(
    chunks: AsyncIterable<Uint8Array>,
    maxBytes: number,
  ): Promise<Uint8Array> {
    if (
      chunks === null ||
      typeof chunks !== "object" ||
      typeof chunks[Symbol.asyncIterator] !== "function"
    ) {
      throw new MediaIngressError(
        "MEDIA_INGRESS_LIMIT",
        "Streamed Media must provide asynchronous byte chunks",
      );
    }
    const collected: Uint8Array[] = [];
    let byteLength = 0;
    for await (const chunk of chunks) {
      if (!(chunk instanceof Uint8Array)) {
        throw new MediaIngressError(
          "MEDIA_INGRESS_LIMIT",
          "Streamed Media chunks must be Uint8Array values",
        );
      }
      if (chunk.byteLength > maxBytes - byteLength) {
        throw new MediaIngressError(
          "MEDIA_INGRESS_LIMIT",
          `Media bytes must be between 1 and ${maxBytes}`,
        );
      }
      if (chunk.byteLength > 0) {
        collected.push(Uint8Array.from(chunk));
        byteLength += chunk.byteLength;
      }
    }
    if (byteLength === 0) {
      throw new MediaIngressError(
        "MEDIA_INGRESS_LIMIT",
        `Media bytes must be between 1 and ${maxBytes}`,
      );
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of collected) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
}
