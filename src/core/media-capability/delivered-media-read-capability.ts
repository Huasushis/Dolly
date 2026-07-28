import {
  contentReferences,
  parseBlockContent,
  parseRect,
  type MediaReferenceItem,
  type Rect,
} from "../block-content.js";
import type { Block } from "../block-store.js";
import { deepFreeze, type JsonValue } from "../canonical-json.js";
import {
  ExtensionCapabilityError,
  type ExtensionCapabilityGrant,
  type ExtensionCapabilityInvocationContext,
  type ExtensionSessionIdentity,
} from "../extension-capability.js";
import {
  assertClosedArguments,
  assertHostIdentifier,
  assertPositiveLimit,
  capabilityArgumentError,
  capabilityQuotaError,
  optionalBoundedInteger,
  optionalString,
  readField,
  requireString,
  type ExtensionCapabilityDefinition,
} from "../capabilities/capability-support.js";
import type {
  MediaReadDescription,
  MediaReadSource,
  MediaSignedUrl,
} from "./media-read-source.js";

export const DELIVERED_MEDIA_READ_CAPABILITY_TYPE = "delivered-media-read";
export const DELIVERED_MEDIA_READ_CAPABILITY_VERSION = "v1";

/**
 * `list` and `describe` expose only the scope the host already derived.
 * `read` copies bounded original bytes. `sign-url` is separate because a
 * short-lived URL is external communication that a third party can fetch,
 * and `extension-process-protocol.md` section 6 requires read and external
 * communication to be distinct grants.
 */
export type DeliveredMediaReadOperation = "list" | "describe" | "read" | "sign-url";

const READ_OPERATIONS: readonly DeliveredMediaReadOperation[] = [
  "list",
  "describe",
  "read",
  "sign-url",
];

/**
 * How `read` returns the bytes.
 *
 * The capability channel carries JSON, which has no binary value, so both
 * representations are Base64 on the wire and differ in shape: `bytes` is one
 * bounded range of a byte stream that the Extension can page through, and
 * `base64` is one whole inline copy that must fit inside `maxReadBytes`. The
 * third representation the owner asked for, a URL, is the separate `sign-url`
 * operation because it carries different authority.
 */
export type MediaReadRepresentation = "bytes" | "base64";

const REPRESENTATIONS: readonly MediaReadRepresentation[] = ["bytes", "base64"];

/** The part of a Delivery Claim the Media scope is derived from. */
export interface DeliveredMediaClaim {
  readonly moduleJobId: string;
  readonly runId: string;
  readonly blockGroups: readonly {
    readonly block: Block;
    readonly deliveryIds: readonly string[];
  }[];
}

export interface DeliveredMediaReadLimits {
  /** Ceiling on the original bytes one `read` may copy. */
  readonly maxReadBytes: number;
  /** Ceiling on the original bytes this capability may copy in total. */
  readonly maxTotalReadBytes: number;
  readonly maxListResults: number;
  readonly maxArgumentBytes: number;
  readonly maxInvocations: number;
  /** Ceiling on issued signed URLs, counted separately from byte reads. */
  readonly maxSignedUrls: number;
  /** Ceiling the host's configured signed-URL validity window must respect. */
  readonly maxSignedUrlExpiresInSeconds: number;
}

export const DEFAULT_DELIVERED_MEDIA_READ_LIMITS: DeliveredMediaReadLimits = deepFreeze({
  maxReadBytes: 1_048_576,
  maxTotalReadBytes: 8 * 1_048_576,
  maxListResults: 64,
  maxArgumentBytes: 4_096,
  maxInvocations: 256,
  maxSignedUrls: 16,
  maxSignedUrlExpiresInSeconds: 300,
});

export interface DeliveredMediaSignedUrlPolicy {
  /** Host-chosen recipient recorded with the provider access record. */
  readonly recipientId: string;
  readonly expiresInSeconds: number;
}

export interface DeliveredMediaReadCapabilityOptions {
  readonly claim: DeliveredMediaClaim;
  /**
   * The exact Extension session this capability is issued for. Every
   * invocation re-checks it, so a host that issues this definition into a
   * different instance, session, or Module fails closed instead of widening
   * the grant.
   */
  readonly session: ExtensionSessionIdentity;
  readonly source: MediaReadSource;
  readonly expiresAt: string;
  readonly operations?: readonly DeliveredMediaReadOperation[];
  readonly representations?: readonly MediaReadRepresentation[];
  readonly limits?: Partial<DeliveredMediaReadLimits>;
  /** Required when `sign-url` is granted. */
  readonly signedUrl?: DeliveredMediaSignedUrlPolicy;
  readonly nextRequestId?: () => string;
  readonly maxConcurrentInvocations?: number;
  readonly requireIdempotencyKey?: boolean;
}

interface AuthorizedMedia {
  readonly mediaId: string;
  readonly blockIds: readonly string[];
  readonly deliveryIds: readonly string[];
  /** True when at least one delivered reference carried no crop. */
  readonly allowsFullMedia: boolean;
  /** The distinct crops that were actually delivered. Never merged. */
  readonly crops: readonly Rect[];
}

function capabilityDenied(
  message: string,
  reason: string,
  extra: Readonly<Record<string, JsonValue>> = {},
): ExtensionCapabilityError {
  return new ExtensionCapabilityError("CAPABILITY_DENIED", message, { reason, ...extra });
}

function dependencyFailed(
  message: string,
  reason: string,
): ExtensionCapabilityError {
  return new ExtensionCapabilityError("CAPABILITY_DEPENDENCY_FAILED", message, { reason });
}

function configInvalid(message: string): ExtensionCapabilityError {
  return new ExtensionCapabilityError("CAPABILITY_CONFIG_INVALID", message);
}

function resolveLimits(
  overrides: Partial<DeliveredMediaReadLimits> | undefined,
): DeliveredMediaReadLimits {
  const limits = { ...DEFAULT_DELIVERED_MEDIA_READ_LIMITS, ...(overrides ?? {}) };
  for (const [label, value] of Object.entries(limits)) {
    assertPositiveLimit(value, `delivered media read ${label}`);
  }
  if (limits.maxTotalReadBytes < limits.maxReadBytes) {
    throw configInvalid(
      "delivered media read maxTotalReadBytes must be at least maxReadBytes",
    );
  }
  return deepFreeze(limits);
}

function base64ByteLength(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

/** `crop` values are exact normalized doubles, so containment is exact too. */
function cropContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.topLeft.x >= outer.topLeft.x &&
    inner.topLeft.y >= outer.topLeft.y &&
    inner.bottomRight.x <= outer.bottomRight.x &&
    inner.bottomRight.y <= outer.bottomRight.y
  );
}

function sameCrop(left: Rect, right: Rect): boolean {
  return (
    left.topLeft.x === right.topLeft.x &&
    left.topLeft.y === right.topLeft.y &&
    left.bottomRight.x === right.bottomRight.x &&
    left.bottomRight.y === right.bottomRight.y
  );
}

/**
 * The edge conversion required by `media.md` section 5: all four edges round
 * independently, and the result must stay inside the image with positive
 * integer width and height. Rounding width or height directly is not
 * conformant because it can disagree with independently rounded edges.
 */
function rectCoversAPixel(rect: Rect, width: number, height: number): boolean {
  const left = Math.round(rect.topLeft.x * width);
  const top = Math.round(rect.topLeft.y * height);
  const right = Math.round(rect.bottomRight.x * width);
  const bottom = Math.round(rect.bottomRight.y * height);
  return (
    left >= 0 &&
    top >= 0 &&
    right <= width &&
    bottom <= height &&
    right - left >= 1 &&
    bottom - top >= 1
  );
}

function rectJson(rect: Rect): JsonValue {
  return {
    topLeft: { x: rect.topLeft.x, y: rect.topLeft.y },
    bottomRight: { x: rect.bottomRight.x, y: rect.bottomRight.y },
  };
}

/**
 * Reads the validated `media-reference` items out of one delivered Block.
 *
 * `media.md` section 4 says that JSON fields elsewhere in a payload, plain
 * text, filenames, and URLs never create a Media reference. A payload that
 * does not parse as Block content therefore contributes nothing rather than
 * being scanned for identifier-shaped strings.
 */
function deliveredMediaReferences(block: Block): readonly MediaReferenceItem[] {
  try {
    return contentReferences(parseBlockContent(block.payload.value)).media;
  } catch {
    return [];
  }
}

function deriveAuthorizedMedia(
  claim: DeliveredMediaClaim,
): ReadonlyMap<string, AuthorizedMedia> {
  const draft = new Map<
    string,
    {
      blockIds: Set<string>;
      deliveryIds: Set<string>;
      allowsFullMedia: boolean;
      crops: Rect[];
    }
  >();
  for (const group of claim.blockGroups) {
    const block = group.block;
    assertHostIdentifier(block.id, "blockId");
    for (const reference of deliveredMediaReferences(block)) {
      let entry = draft.get(reference.mediaId);
      if (!entry) {
        entry = {
          blockIds: new Set(),
          deliveryIds: new Set(),
          allowsFullMedia: false,
          crops: [],
        };
        draft.set(reference.mediaId, entry);
      }
      entry.blockIds.add(block.id);
      for (const deliveryId of group.deliveryIds) entry.deliveryIds.add(deliveryId);
      if (reference.crop === undefined) {
        entry.allowsFullMedia = true;
        continue;
      }
      const crop = reference.crop;
      if (!entry.crops.some((existing) => sameCrop(existing, crop))) {
        entry.crops.push(crop);
      }
    }
  }
  const authorized = new Map<string, AuthorizedMedia>();
  for (const [mediaId, entry] of draft) {
    authorized.set(mediaId, {
      mediaId,
      blockIds: [...entry.blockIds].sort(),
      deliveryIds: [...entry.deliveryIds].sort(),
      allowsFullMedia: entry.allowsFullMedia,
      crops: entry.crops.map((crop) => ({
        topLeft: { ...crop.topLeft },
        bottomRight: { ...crop.bottomRight },
      })),
    });
  }
  return authorized;
}

/**
 * Builds the delivered-Block-scoped Media read capability.
 *
 * `media.md` section 4, `core-runtime.md` section 6.5, and
 * `security-operations.md` section 10 all state the same rule: a raw `mediaId`
 * is data, not authorization. The only Media this capability can reach are the
 * ones named by a validated `media-reference` inside a Block the host already
 * delivered to this authenticated Module job, and a request may never broaden
 * a delivered crop.
 *
 * The host-side enforcement points are, in order:
 *
 * 1. the capability authority checks handle, session, operation, expiry,
 *    revocation, execution scope, argument bytes, and result bytes;
 * 2. this handler re-checks the instance, Extension session, and Module that
 *    the grant was derived for;
 * 3. the Media identifier must be in the scope derived from delivered Blocks;
 * 4. the requested crop must be contained in one individual delivered crop,
 *    or the delivered set must include an uncropped reference;
 * 5. the crop must still select at least one pixel of the inspected image; and
 * 6. per-invocation and cumulative byte budgets are charged before the copy.
 */
export function createDeliveredMediaReadCapability(
  options: DeliveredMediaReadCapabilityOptions,
): ExtensionCapabilityDefinition {
  const limits = resolveLimits(options.limits);
  const moduleJobId = assertHostIdentifier(options.claim.moduleJobId, "moduleJobId");
  const runId = assertHostIdentifier(options.claim.runId, "runId");
  const instanceId = assertHostIdentifier(options.session.instanceId, "instanceId");
  const sessionId = assertHostIdentifier(options.session.sessionId, "sessionId");
  const moduleId = assertHostIdentifier(options.session.moduleId, "moduleId");

  const operations = [...new Set(options.operations ?? READ_OPERATIONS)];
  if (operations.length === 0) {
    throw configInvalid("Delivered Media read requires at least one operation");
  }
  for (const operation of operations) {
    if (!READ_OPERATIONS.includes(operation)) {
      throw configInvalid(
        `Delivered Media read does not define the operation ${String(operation)}`,
      );
    }
  }
  const enabledOperations = new Set<DeliveredMediaReadOperation>(operations);

  const representations = [...new Set(options.representations ?? REPRESENTATIONS)];
  if (enabledOperations.has("read") && representations.length === 0) {
    throw configInvalid("Delivered Media read requires at least one representation");
  }
  for (const representation of representations) {
    if (!REPRESENTATIONS.includes(representation)) {
      throw configInvalid(
        `Delivered Media read does not define the representation ${String(representation)}`,
      );
    }
  }
  const enabledRepresentations = new Set<MediaReadRepresentation>(representations);

  let signedUrlPolicy: DeliveredMediaSignedUrlPolicy | undefined;
  if (enabledOperations.has("sign-url")) {
    if (!options.signedUrl) {
      throw configInvalid(
        "Delivered Media sign-url requires a host-chosen recipient and expiry",
      );
    }
    assertHostIdentifier(options.signedUrl.recipientId, "signedUrl.recipientId");
    const seconds = options.signedUrl.expiresInSeconds;
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
      throw configInvalid("signedUrl.expiresInSeconds must be a positive safe integer");
    }
    if (seconds > limits.maxSignedUrlExpiresInSeconds) {
      throw configInvalid(
        "signedUrl.expiresInSeconds exceeds maxSignedUrlExpiresInSeconds",
      );
    }
    signedUrlPolicy = {
      recipientId: options.signedUrl.recipientId,
      expiresInSeconds: seconds,
    };
  }

  const source = options.source;
  const authorized = deriveAuthorizedMedia(options.claim);
  const authorizedMediaIds = [...authorized.keys()].sort();
  let requestSequence = 0;
  const nextRequestId =
    options.nextRequestId ??
    (() => `media-read-request-${moduleJobId}-${(requestSequence += 1)}`);

  const scopeEntry = (entry: AuthorizedMedia): JsonValue => ({
    mediaId: entry.mediaId,
    blockIds: [...entry.blockIds],
    deliveryIds: [...entry.deliveryIds],
    allowsFullMedia: entry.allowsFullMedia,
    crops: entry.crops.map(rectJson),
  });

  const grant: ExtensionCapabilityGrant = {
    capabilityType: DELIVERED_MEDIA_READ_CAPABILITY_TYPE,
    capabilityVersion: DELIVERED_MEDIA_READ_CAPABILITY_VERSION,
    operations,
    resourceScope: {
      schemaVersion: "dolly.capability-scope.delivered-media-read/1",
      instanceId,
      sessionId,
      moduleId,
      moduleJobId,
      representations: [...representations],
      media: authorizedMediaIds.map((mediaId) => scopeEntry(authorized.get(mediaId)!)),
      limits: { ...limits },
    },
    expiresAt: options.expiresAt,
    maxInvocations: limits.maxInvocations,
    maxConcurrentInvocations: options.maxConcurrentInvocations ?? 2,
    maxArgumentBytes: limits.maxArgumentBytes,
    maxResultBytes: Math.max(base64ByteLength(limits.maxReadBytes) + 8_192, 65_536),
    executionScope: { moduleJobId, runId },
    ...(options.requireIdempotencyKey === true ? { requireIdempotencyKey: true } : {}),
  };

  let consumedReadBytes = 0;
  let issuedSignedUrls = 0;

  const assertIssuedSession = (context: ExtensionCapabilityInvocationContext): void => {
    if (
      context.identity.instanceId !== instanceId ||
      context.identity.sessionId !== sessionId ||
      context.identity.moduleId !== moduleId
    ) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_SCOPE_MISMATCH",
        "Media capability was derived for a different instance, session, or Module",
      );
    }
  };

  const requireAuthorizedMedia = (mediaId: string): AuthorizedMedia => {
    const entry = authorized.get(mediaId);
    if (!entry) {
      // A guessed identifier, an identifier that only appeared in generated
      // text or configuration, another Module job's identifier, and an
      // identifier from an undelivered Block are indistinguishable here.
      throw capabilityDenied(
        "Media was not delivered to this Module job",
        "media-not-delivered",
      );
    }
    return entry;
  };

  const readOptionalCrop = (
    parsed: Readonly<Record<string, JsonValue>>,
  ): Rect | undefined => {
    const value = readField(parsed, "crop");
    if (value === undefined) return undefined;
    try {
      return parseRect(value, "media.crop");
    } catch (error) {
      throw capabilityArgumentError(
        `media.crop is not a valid normalized rectangle: ${
          error instanceof Error ? error.message : "invalid"
        }`,
      );
    }
  };

  /**
   * The delivered-crop rule. It mirrors the Module result rule in
   * `core-runtime.md` section 9.3: an uncropped delivered reference permits
   * the full Media or any otherwise-valid crop, while an all-cropped
   * delivered set permits only a crop contained in one individual delivered
   * crop. A region assembled from two delivered crops, an enlarged crop, and
   * an implicit full-image request are all refused.
   */
  const authorizeCrop = (entry: AuthorizedMedia, crop: Rect | undefined): void => {
    if (entry.allowsFullMedia) return;
    if (crop === undefined) {
      throw capabilityDenied(
        "Every delivered reference for this Media carries a crop, so the full Media is out of scope",
        "full-media-not-delivered",
        { mediaId: entry.mediaId },
      );
    }
    if (!entry.crops.some((delivered) => cropContains(delivered, crop))) {
      throw capabilityDenied(
        "Requested crop is not contained in any single delivered crop",
        "crop-not-delivered",
        { mediaId: entry.mediaId },
      );
    }
  };

  const describeMedia = async (mediaId: string): Promise<MediaReadDescription> => {
    let description: MediaReadDescription | null;
    try {
      description = await source.describe(mediaId);
    } catch {
      throw dependencyFailed("Media description failed", "media-describe-failed");
    }
    if (
      !description ||
      description.mediaId !== mediaId ||
      typeof description.mimeType !== "string" ||
      description.mimeType.length === 0 ||
      !Number.isSafeInteger(description.byteLength) ||
      description.byteLength <= 0
    ) {
      throw dependencyFailed(
        "Delivered Media is no longer available to read",
        "media-unavailable",
      );
    }
    return description;
  };

  /** A crop is meaningful only on an inspected image, per `media.md` §4/§5. */
  const assertCropFitsImage = (crop: Rect, description: MediaReadDescription): void => {
    if (
      !description.mimeType.startsWith("image/") ||
      description.width === undefined ||
      description.height === undefined
    ) {
      throw capabilityArgumentError(
        "media.crop requires Media with inspected image dimensions",
      );
    }
    if (!rectCoversAPixel(crop, description.width, description.height)) {
      throw capabilityArgumentError("media.crop must select at least one pixel");
    }
  };

  const handleRead = async (
    parsed: Readonly<Record<string, JsonValue>>,
    context: ExtensionCapabilityInvocationContext,
  ): Promise<JsonValue> => {
    const mediaId = requireString(parsed, "mediaId", "media.read");
    const entry = requireAuthorizedMedia(mediaId);
    const crop = readOptionalCrop(parsed);
    authorizeCrop(entry, crop);

    const representation = (optionalString(parsed, "representation", "media.read") ??
      "bytes") as MediaReadRepresentation;
    if (!REPRESENTATIONS.includes(representation)) {
      throw capabilityArgumentError(
        `media.read.representation must be one of ${REPRESENTATIONS.join(", ")}`,
      );
    }
    if (!enabledRepresentations.has(representation)) {
      throw capabilityDenied(
        "Media read does not authorize this representation",
        "representation-not-granted",
        { representation },
      );
    }

    const description = await describeMedia(mediaId);
    if (crop !== undefined) {
      assertCropFitsImage(crop, description);
      // `media.md` section 5 supports a crop only through a short-lived signed
      // request whose storage adapter declares exact crop support. Returning
      // the full original, or locally re-encoding cropped bytes as if they
      // were the same Media, are both forbidden, so this fails visibly.
      throw capabilityDenied(
        "A cropped read is available only through the sign-url operation",
        "cropped-inline-unsupported",
        { mediaId },
      );
    }

    const total = description.byteLength;
    let offset = 0;
    let length: number;
    if (representation === "base64") {
      if (readField(parsed, "offset") !== undefined || readField(parsed, "length") !== undefined) {
        throw capabilityArgumentError(
          "media.read.base64 returns one whole copy and rejects offset or length",
        );
      }
      if (total > limits.maxReadBytes) {
        throw capabilityQuotaError("maxReadBytes", limits.maxReadBytes);
      }
      length = total;
    } else {
      const requestedOffset = readField(parsed, "offset");
      if (requestedOffset !== undefined) {
        if (
          typeof requestedOffset !== "number" ||
          !Number.isSafeInteger(requestedOffset) ||
          requestedOffset < 0
        ) {
          throw capabilityArgumentError(
            "media.read.offset must be a non-negative safe integer when present",
          );
        }
        offset = requestedOffset;
      }
      if (offset >= total) {
        throw capabilityArgumentError("media.read.offset is at or past the end of the Media");
      }
      const requestedLength = optionalBoundedInteger(
        parsed,
        "length",
        "media.read",
        limits.maxReadBytes,
      );
      length = Math.min(requestedLength ?? limits.maxReadBytes, total - offset);
    }

    if (consumedReadBytes + length > limits.maxTotalReadBytes) {
      throw capabilityQuotaError("maxTotalReadBytes", limits.maxTotalReadBytes);
    }

    let bytes: Uint8Array;
    try {
      bytes = await source.readByteRange({
        mediaId,
        offset,
        length,
        signal: context.signal,
      });
    } catch {
      throw dependencyFailed("Media byte read failed", "media-read-failed");
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
      throw dependencyFailed(
        "Media byte read returned a different range than requested",
        "media-range-mismatch",
      );
    }
    consumedReadBytes += length;

    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
      "base64",
    );
    if (representation === "base64") {
      return {
        schemaVersion: "dolly.delivered-media-copy/1",
        mediaId,
        representation,
        encoding: "base64",
        mimeType: description.mimeType,
        byteLength: length,
        data,
      };
    }
    return {
      schemaVersion: "dolly.delivered-media-chunk/1",
      mediaId,
      representation,
      encoding: "base64",
      mimeType: description.mimeType,
      offset,
      length,
      totalByteLength: total,
      hasMore: offset + length < total,
      data,
    };
  };

  const handleSignUrl = async (
    parsed: Readonly<Record<string, JsonValue>>,
    context: ExtensionCapabilityInvocationContext,
  ): Promise<JsonValue> => {
    const policy = signedUrlPolicy!;
    const mediaId = requireString(parsed, "mediaId", "media.sign-url");
    const entry = requireAuthorizedMedia(mediaId);
    const crop = readOptionalCrop(parsed);
    authorizeCrop(entry, crop);

    // The owner's rule: a URL exists only when a remote store is configured.
    // Its absence is reported, never silently downgraded to inline Base64.
    const sign = source.signReadUrl?.bind(source);
    if (!sign) {
      throw capabilityDenied(
        "No configured storage adapter can sign a Media read URL",
        "signed-url-unavailable",
      );
    }
    if (issuedSignedUrls >= limits.maxSignedUrls) {
      throw capabilityQuotaError("maxSignedUrls", limits.maxSignedUrls);
    }

    const description = await describeMedia(mediaId);
    if (crop !== undefined) assertCropFitsImage(crop, description);

    let signed: MediaSignedUrl;
    try {
      signed = await sign({
        mediaId,
        ...(crop === undefined ? {} : { crop }),
        expiresInSeconds: policy.expiresInSeconds,
        recipientId: policy.recipientId,
        requestId: nextRequestId(),
        signal: context.signal,
      });
    } catch {
      // A signing adapter that refuses an exact crop reaches this branch. The
      // capability must not fall back to the full original.
      throw dependencyFailed("Media URL signing failed", "signed-url-failed");
    }
    if (!signed || typeof signed.url !== "string" || signed.url.length > 4_096) {
      throw dependencyFailed("Media URL signing returned no usable URL", "signed-url-invalid");
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(signed.url);
    } catch {
      throw dependencyFailed("Media URL signing returned an unparsable URL", "signed-url-invalid");
    }
    if (parsedUrl.protocol !== "https:") {
      throw dependencyFailed(
        "Media URL signing returned a non-HTTPS URL",
        "signed-url-insecure",
      );
    }
    const expiresAt = Date.parse(signed.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      throw dependencyFailed(
        "Media URL signing returned an invalid expiry",
        "signed-url-invalid",
      );
    }
    issuedSignedUrls += 1;
    // The URL and its query string are credentials. They are returned to the
    // requesting Module and are never written to a log, error, or Block here.
    return {
      schemaVersion: "dolly.delivered-media-url/1",
      mediaId,
      ...(crop === undefined ? {} : { crop: rectJson(crop) }),
      mimeType: description.mimeType,
      url: signed.url,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  };

  const handler = async (
    argumentsValue: JsonValue,
    context: ExtensionCapabilityInvocationContext,
  ): Promise<JsonValue> => {
    assertIssuedSession(context);
    const operation = context.operation as DeliveredMediaReadOperation;
    if (!enabledOperations.has(operation)) {
      throw capabilityDenied(
        "Delivered Media read does not authorize this operation",
        "operation-not-granted",
      );
    }

    if (operation === "list") {
      const parsed = assertClosedArguments(argumentsValue, ["limit", "after"], "media.list");
      const after = optionalString(parsed, "after", "media.list");
      const limit =
        optionalBoundedInteger(parsed, "limit", "media.list", limits.maxListResults) ??
        limits.maxListResults;
      const matching = authorizedMediaIds.filter(
        (mediaId) => after === undefined || mediaId > after,
      );
      const page = matching.slice(0, limit);
      const truncated = page.length < matching.length;
      return {
        schemaVersion: "dolly.delivered-media-list/1",
        moduleJobId,
        media: page.map((mediaId) => scopeEntry(authorized.get(mediaId)!)),
        truncated,
        ...(truncated ? { nextAfter: page[page.length - 1]! } : {}),
      };
    }

    if (operation === "describe") {
      const parsed = assertClosedArguments(argumentsValue, ["mediaId"], "media.describe");
      const mediaId = requireString(parsed, "mediaId", "media.describe");
      const entry = requireAuthorizedMedia(mediaId);
      const description = await describeMedia(mediaId);
      return {
        schemaVersion: "dolly.delivered-media-description/1",
        mediaId,
        mimeType: description.mimeType,
        byteLength: description.byteLength,
        ...(description.width === undefined ? {} : { width: description.width }),
        ...(description.height === undefined ? {} : { height: description.height }),
        ...(description.durationMs === undefined ? {} : { durationMs: description.durationMs }),
        ...(description.frameCount === undefined ? {} : { frameCount: description.frameCount }),
        ...(description.channels === undefined ? {} : { channels: description.channels }),
        blockIds: [...entry.blockIds],
        deliveryIds: [...entry.deliveryIds],
        allowsFullMedia: entry.allowsFullMedia,
        crops: entry.crops.map(rectJson),
      };
    }

    if (operation === "read") {
      const parsed = assertClosedArguments(
        argumentsValue,
        ["mediaId", "crop", "representation", "offset", "length"],
        "media.read",
      );
      return handleRead(parsed, context);
    }

    const parsed = assertClosedArguments(
      argumentsValue,
      ["mediaId", "crop"],
      "media.sign-url",
    );
    return handleSignUrl(parsed, context);
  };

  return { grant, handler };
}
