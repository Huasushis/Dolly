import type { Rect } from "../block-content.js";

/**
 * The narrow trusted-host port that the delivered-Media read capability is
 * allowed to call.
 *
 * `media.md` section 4 and `extension-process-protocol.md` section 6 both
 * forbid handing an Extension a generic Media-store method, a storage locator,
 * or an object-store credential. The capability therefore never receives a
 * `MediaStore`; it receives this port, whose whole surface is "describe one
 * already-authorized Media item", "copy a bounded byte range of it", and
 * "ask the host to sign a short-lived read URL". Authorization is decided by
 * the capability before any of these are called, so an implementation of this
 * port is not itself an authorization boundary and MUST NOT be exposed to
 * Extension code.
 */

/**
 * Inspected metadata for one Media item, copied from the immutable Media
 * record. It deliberately omits digest, provenance, storage records, and
 * anything that names a storage location.
 */
export interface MediaReadDescription {
  readonly mediaId: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
  readonly frameCount?: number;
  readonly channels?: number;
}

export interface MediaByteRangeRequest {
  readonly mediaId: string;
  /** Zero-based offset into the original bytes. */
  readonly offset: number;
  /** Number of bytes to copy. The caller has already bounded this. */
  readonly length: number;
  readonly signal: AbortSignal;
}

export interface MediaSignedUrlRequest {
  readonly mediaId: string;
  /**
   * Present only when the capability authorized a crop. The host adapter must
   * refuse unless its storage adapter declares exact signed-crop support, per
   * `media.md` section 5.
   */
  readonly crop?: Rect;
  readonly expiresInSeconds: number;
  /** Host-chosen recipient for the provider access record. */
  readonly recipientId: string;
  /** Host-assigned identifier for this one access request. */
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export interface MediaSignedUrl {
  /** MUST be an `https:` URL. The capability rejects anything else. */
  readonly url: string;
  /** ISO-8601 instant at which the URL stops accepting new requests. */
  readonly expiresAt: string;
}

/**
 * A host implementation of the Media read port.
 *
 * `signReadUrl` is optional on purpose. The owner's requirement is that a URL
 * representation exists only when a remote object store is configured, and
 * that its absence is reported rather than silently downgraded to inline
 * bytes. An implementation without a signing storage adapter therefore omits
 * the method, and the capability denies the `signed-url` representation with a
 * specific reason instead of returning Base64.
 */
export interface MediaReadSource {
  describe(
    mediaId: string,
  ): Promise<MediaReadDescription | null> | MediaReadDescription | null;
  readByteRange(request: MediaByteRangeRequest): Promise<Uint8Array>;
  signReadUrl?(request: MediaSignedUrlRequest): Promise<MediaSignedUrl>;
}
