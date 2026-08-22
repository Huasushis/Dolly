/**
 * Runtime-authority identity producers.
 *
 * The Runtime authority database persists exactly one identity tuple
 * (`{ daemonInstallationId, instanceId }`, `security-operations.md` Section 13
 * and the frozen `runtime-authority` storage contract). This module is the
 * single sanctioned source of both halves:
 *
 * - `daemonInstallationId` (and the controller-lock `controllerGenerationId`)
 *   are strict RFC 9562 lowercase UUIDv7: a 48-bit unix-ms timestamp followed
 *   by version 7 and variant 10 bits with 74 random bits, always lowercase.
 *   Timestamp and random bits come from injected sources so deterministic
 *   tests can pin the exact layout.
 * - the Runtime `instanceId` is a deterministic StableId projection of the
 *   state-manifest/registry UUIDv4: `instance-` + the 32 lowercase hex of the
 *   UUIDv4 with hyphens removed. It is a projection, not a hash and not an
 *   integer conversion, so two runs over the same UUIDv4 always agree and the
 *   registry UUIDv4 remains the durable source of truth.
 */

const UUIDV7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUIDV4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID_HEX_PATTERN = /^[0-9a-f]{32}$/u;

/** StableId prefix every Runtime instance identifier starts with. */
export const RUNTIME_INSTANCE_STABLE_ID_PREFIX = "instance-";

/** One `instance-` + 32 lowercase hex identifier for a registered instance. */
export const RUNTIME_INSTANCE_STABLE_ID_PATTERN =
  /^instance-[0-9a-f]{32}$/u;

export class RuntimeAuthorityIdentityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RuntimeAuthorityIdentityError";
  }
}

function assertUint48(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff_ffff) {
    throw new RuntimeAuthorityIdentityError(
      `${label} out of addressable range for a UUIDv7 timestamp`,
    );
  }
}

function randomBytesOf(size: number, source: (size: number) => Uint8Array): Uint8Array {
  const bytes = source(size);
  if (!(bytes instanceof Uint8Array) || bytes.length !== size) {
    throw new RuntimeAuthorityIdentityError(
      "random bytes supplier must yield a buffer of the requested size",
      { cause: undefined },
    );
  }
  return bytes;
}

/**
 * Mints a strict RFC 9562 lowercase UUIDv7: the injected `now()` becomes the
 * 48-bit unix-ms timestamp, the injected `randomBytes(16)` supplies the 74
 * random bits, and the version 7 / variant 10 nibbles are forced over it.
 * The result is always lowercase.
 */
export function generateRuntimeUuidV7(options: {
  readonly now: () => number;
  readonly randomBytes: (size: number) => Uint8Array;
}): string {
  const timestamp = options.now();
  assertUint48(timestamp, "clock instant");
  const octets = randomBytesOf(16, options.randomBytes);
  octets[6] = (octets[6] & 0x0f) | 0x70;
  octets[8] = (octets[8] & 0x3f) | 0x80;
  let time = BigInt.asUintN(48, BigInt(timestamp));
  for (let index = 5; index >= 0; index -= 1) {
    octets[index] = Number(time & 0xffn);
    time >>= 8n;
  }
  const hex = Buffer.from(octets).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** True exactly for a strict lowercase RFC 9562 UUIDv7 string. */
export function isLowercaseUuidV7(value: unknown): value is string {
  return typeof value === "string" && UUIDV7_PATTERN.test(value);
}

/** True exactly for a strict lowercase (and already validated) UUIDv4 string. */
function assertLowercaseUuidV4(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUIDV4_PATTERN.test(value)) {
    throw new RuntimeAuthorityIdentityError(
      "Runtime instance projection requires a lowercase UUIDv4 " +
        "(the state-manifest/registry source identifier)",
    );
  }
}

/**
 * Deterministic StableId projection of a registered instance's UUIDv4: the
 * hyphens are removed and the `instance-` prefix applied. No hashing, no
 * integer conversion, so the same UUIDv4 always projects the same StableId.
 */
export function projectRuntimeInstanceStableId(instanceUuidV4: string): string {
  assertLowercaseUuidV4(instanceUuidV4);
  return RUNTIME_INSTANCE_STABLE_ID_PREFIX + instanceUuidV4.replaceAll("-", "");
}

/** True exactly for a `instance-` + 32 lowercase hex StableId. */
export function isRuntimeInstanceStableId(value: unknown): value is string {
  return typeof value === "string" && RUNTIME_INSTANCE_STABLE_ID_PATTERN.test(value);
}

/** The 32 lowercase hex between the prefix and the end of a StableId. */
export function runtimeInstanceStableIdHex(value: string): string {
  if (!isRuntimeInstanceStableId(value)) {
    throw new RuntimeAuthorityIdentityError(
      "runtime instance StableId must be instance- + 32 lowercase hex",
    );
  }
  return value.slice(RUNTIME_INSTANCE_STABLE_ID_PREFIX.length);
}

/**
 * Canonicalizes any supported instance identifier (a lowercase UUIDv4 from
 * the state manifest/registry, or an already projected StableId) to its
 * deterministic `instance-` StableId; the controller namespace and Runtime
 * DB projection always see the canonical form, never the raw source UUID.
 */
export function canonicalRuntimeInstanceId(value: unknown): string {
  if (typeof value === "string" && isRuntimeInstanceStableId(value)) return value;
  assertLowercaseUuidV4(value);
  return projectRuntimeInstanceStableId(value);
}

/** Validates a complete Runtime identity tuple before it reaches storage. */
export function assertRuntimeAuthorityIdentityTuple(tuple: {
  readonly daemonInstallationId: unknown;
  readonly instanceId: unknown;
}): { readonly daemonInstallationId: string; readonly instanceId: string } {
  if (!isLowercaseUuidV7(tuple.daemonInstallationId)) {
    throw new RuntimeAuthorityIdentityError(
      "daemonInstallationId must be a strict lowercase RFC9562 UUIDv7",
    );
  }
  const instanceId = canonicalRuntimeInstanceId(tuple.instanceId);
  if (!isRuntimeInstanceStableId(instanceId)) {
    throw new RuntimeAuthorityIdentityError(
      "instanceId must be a deterministic Runtime StableId",
    );
  }
  return { daemonInstallationId: tuple.daemonInstallationId, instanceId };
}
