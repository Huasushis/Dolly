import { canonicalJsonDigest } from "./canonical-json.js";
import {
  CGROUP_V2_MOUNT_POINT,
  isDerivedModuleCgroupPath,
  moduleCgroupDirectoryName,
} from "./linux-identifier-formats.js";

export interface LinuxModuleCgroupIdentity {
  readonly instanceId: string;
  readonly moduleId: string;
  readonly processGenerationId: string;
}

/** Exact directory name bound to all three durable Module identities. */
export function identityBoundModuleCgroupDirectoryName(
  identity: LinuxModuleCgroupIdentity,
): string {
  const digest = canonicalJsonDigest([
    identity.instanceId,
    identity.moduleId,
    identity.processGenerationId,
  ]).slice("sha256:".length);
  return moduleCgroupDirectoryName(identity.processGenerationId, digest);
}

/**
 * Stronger than the generic path-shape predicate: the final directory digest
 * must be the one Core derives from this exact instance, Module, and process
 * generation. The delegated-root binding remains a separate activation proof.
 */
export function isIdentityBoundModuleCgroupPath(
  value: unknown,
  identity: LinuxModuleCgroupIdentity,
  cgroupMountPoint: string = CGROUP_V2_MOUNT_POINT,
): value is string {
  return isDerivedModuleCgroupPath(
    value,
    identity.processGenerationId,
    cgroupMountPoint,
  ) && value.slice(value.lastIndexOf("/") + 1) ===
    identityBoundModuleCgroupDirectoryName(identity);
}
