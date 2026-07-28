/**
 * The exact text formats of the Linux values a Module process record persists:
 * the Core-allocated process-generation identifier, the systemd invocation
 * identifier, the Linux boot identifier, and the Core-derived Module
 * control-group (cgroup) path built from the first of those.
 *
 * These formats are checked in three places that must agree: the durable
 * record validator in `module-process-records.ts`, the control-group
 * derivation and stop-proof rules in `linux-module-cgroup.ts`, and the service
 * binding proof in `linux-core-service-binding.ts`. Each rule is defined once
 * here so a value a durable record accepts is exactly a value those two
 * producers can create. See `docs/spec/core-runtime.md` Section 7.7 and
 * Architecture Decision Record 0009.
 *
 * This module deliberately has no imports: it sits below every Core module
 * that needs it, so reuse cannot create an import cycle.
 */

/** Mount point of the control-group version 2 filesystem on Linux. */
export const CGROUP_V2_MOUNT_POINT = "/sys/fs/cgroup";

/** Directory-name prefix that makes a Module cgroup recognisable in `systemd-cgls`. */
export const MODULE_CGROUP_NAME_PREFIX = "dolly-module-";

/**
 * The process-generation identifier appears literally in the Module cgroup
 * path, so it must also be a usable single directory name. Core allocates this
 * identifier itself from at least 128 random bits, so restricting it to
 * unreserved characters costs nothing and keeps the derived path free of
 * separators, relative segments, and shell-significant text.
 */
const PROCESS_GENERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** systemd reports `InvocationID` as 16 bytes, that is 32 hexadecimal digits. */
const SERVICE_INVOCATION_ID_PATTERN = /^[0-9a-f]{32}$/;

/** `/proc/sys/kernel/random/boot_id` is a lower-case universally unique identifier. */
const LINUX_BOOT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The hexadecimal form of the SHA-256 identity digest inside a Module cgroup name. */
const IDENTITY_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export function isProcessGenerationId(value: unknown): value is string {
  return typeof value === "string" && PROCESS_GENERATION_ID_PATTERN.test(value);
}

/** The plain-language rule `isProcessGenerationId` applies, for failure messages. */
export const PROCESS_GENERATION_ID_RULE =
  'it must be 1 to 128 characters of letters, digits, "-", or "_" and start with a letter or digit';

export function isServiceInvocationId(value: unknown): value is string {
  return typeof value === "string" && SERVICE_INVOCATION_ID_PATTERN.test(value);
}

export function isLinuxBootId(value: unknown): value is string {
  return typeof value === "string" && LINUX_BOOT_ID_PATTERN.test(value);
}

/**
 * Accepts an absolute control-group path with no empty, `.`, or `..` segment
 * and no trailing separator. A relative segment would let a wrong value address
 * a group outside the delegated subtree.
 */
export function isAbsoluteCgroupPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return false;
  if (!value.startsWith("/")) return false;
  if (value.length > 1 && value.endsWith("/")) return false;
  for (const segment of value.slice(1).split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") return false;
  }
  return true;
}

/**
 * Builds the single directory name of one Module cgroup. It carries the
 * non-reused process-generation identifier literally so a later Core
 * invocation can tell from the path alone which process generation the group
 * belonged to, and the SHA-256 digest of the Core identities that produced it.
 */
export function moduleCgroupDirectoryName(
  processGenerationId: string,
  identityDigestHex: string,
): string {
  return `${MODULE_CGROUP_NAME_PREFIX}${processGenerationId}-${identityDigestHex}`;
}

/** Whether one directory name is the name `moduleCgroupDirectoryName` builds. */
export function isModuleCgroupDirectoryName(
  value: unknown,
  processGenerationId: string,
): value is string {
  if (typeof value !== "string" || !isProcessGenerationId(processGenerationId)) return false;
  const prefix = `${MODULE_CGROUP_NAME_PREFIX}${processGenerationId}-`;
  return (
    value.startsWith(prefix) && IDENTITY_DIGEST_PATTERN.test(value.slice(prefix.length))
  );
}

/**
 * Whether a stored path has the shape Core derives: a strict descendant of the
 * control-group mount point whose last segment is the Module cgroup directory
 * name for the record's non-reused process-generation identifier.
 *
 * Startup recovery checks this before it treats a missing path as proof, and
 * the durable record validator checks it before a path is stored at all, so a
 * corrupted record can neither be written nor make an unrelated missing
 * directory look like evidence.
 */
export function isDerivedModuleCgroupPath(
  value: unknown,
  processGenerationId: string,
  cgroupMountPoint: string = CGROUP_V2_MOUNT_POINT,
): value is string {
  if (!isAbsoluteCgroupPath(value)) return false;
  if (!value.startsWith(`${cgroupMountPoint}/`)) return false;
  return isModuleCgroupDirectoryName(
    value.slice(value.lastIndexOf("/") + 1),
    processGenerationId,
  );
}
