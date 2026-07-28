/**
 * Enumeration and evidence for every instance registered on this machine.
 *
 * `security-operations.md` Section 9 keeps the registry, locks, and process
 * records under one stable per-user state directory, and Section 13 requires
 * recovery to distinguish a proven live child, a proven dead child, an
 * unverifiable identifier that must not be signalled, and a stale record. This
 * module produces exactly those distinctions as evidence; deciding what to do
 * with them belongs to the manager.
 *
 * Nothing here signals a process. Every function is an observation.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { deepFreeze } from "../core/canonical-json.js";
import {
  InstanceControllerLock,
  InstanceControllerLockError,
} from "../core/instance-controller-lock.js";
import { parseStrictJsonBytes } from "../core/strict-json.js";
import type { InstanceProcessRecord } from "./instance-process-record-store.js";
import type { ProcessIdentityProbe } from "./process-identity.js";

const INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MAX_REGISTRY_RECORD_BYTES = 64 * 1024;

/** One record written by `InstanceConfigStore` under `instances/`. */
export interface RegisteredInstance {
  readonly instanceId: string;
  readonly configPath: string;
  readonly stateDirectory: string;
  readonly desiredConfigRevision: string;
  readonly updatedAt: string;
}

export type InstanceRegistryErrorCode =
  | "INSTANCE_REGISTRY_PATH_INVALID"
  | "INSTANCE_REGISTRY_RECORD_INVALID"
  | "INSTANCE_REGISTRY_IO_FAILED";

export class InstanceRegistryError extends Error {
  constructor(
    readonly code: InstanceRegistryErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "InstanceRegistryError";
  }
}

function parseRegisteredInstance(value: unknown, instanceId: string): RegisteredInstance {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InstanceRegistryError(
      "INSTANCE_REGISTRY_RECORD_INVALID",
      "An instance registry record must be an object",
    );
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "dolly.instance-registry/1") {
    throw new InstanceRegistryError(
      "INSTANCE_REGISTRY_RECORD_INVALID",
      "Instance registry schema is unsupported",
    );
  }
  if (typeof record.instanceId !== "string" || record.instanceId !== instanceId) {
    throw new InstanceRegistryError(
      "INSTANCE_REGISTRY_RECORD_INVALID",
      "Instance registry record does not match its file name",
    );
  }
  if (
    typeof record.configPath !== "string" ||
    !isAbsolute(record.configPath) ||
    typeof record.stateDirectory !== "string" ||
    !isAbsolute(record.stateDirectory) ||
    typeof record.desiredConfigRevision !== "string" ||
    !REVISION_PATTERN.test(record.desiredConfigRevision) ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.updatedAt))
  ) {
    throw new InstanceRegistryError(
      "INSTANCE_REGISTRY_RECORD_INVALID",
      "Instance registry record fields are invalid",
    );
  }
  return deepFreeze({
    instanceId,
    configPath: record.configPath,
    stateDirectory: record.stateDirectory,
    desiredConfigRevision: record.desiredConfigRevision,
    updatedAt: record.updatedAt,
  }) as RegisteredInstance;
}

export function instanceRecordsDirectory(registryDirectory: string): string {
  if (
    typeof registryDirectory !== "string" ||
    registryDirectory.length === 0 ||
    registryDirectory.includes("\u0000")
  ) {
    throw new InstanceRegistryError(
      "INSTANCE_REGISTRY_PATH_INVALID",
      "Instance registry directory is invalid",
    );
  }
  return join(resolve(registryDirectory), "instances");
}

/** Lists every instance registered on this machine, sorted by identifier. */
export function readInstanceRegistry(registryDirectory: string): readonly RegisteredInstance[] {
  const directory = instanceRecordsDirectory(registryDirectory);
  if (!existsSync(directory)) return [];
  let entries: readonly string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    throw new InstanceRegistryError(
      "INSTANCE_REGISTRY_IO_FAILED",
      "Could not list the instance registry",
      { cause: error },
    );
  }
  const instances: RegisteredInstance[] = [];
  for (const entry of [...entries].sort()) {
    if (!entry.endsWith(".json")) continue;
    const instanceId = entry.slice(0, -".json".length);
    if (!INSTANCE_ID_PATTERN.test(instanceId)) continue;
    const path = join(directory, entry);
    let bytes: Buffer;
    try {
      if (statSync(path).size > MAX_REGISTRY_RECORD_BYTES) {
        throw new InstanceRegistryError(
          "INSTANCE_REGISTRY_RECORD_INVALID",
          "Instance registry record exceeds its byte limit",
        );
      }
      bytes = readFileSync(path);
    } catch (error) {
      if (error instanceof InstanceRegistryError) throw error;
      throw new InstanceRegistryError(
        "INSTANCE_REGISTRY_IO_FAILED",
        "Could not read an instance registry record",
        { cause: error },
      );
    }
    instances.push(
      parseRegisteredInstance(
        parseStrictJsonBytes(bytes, { maxBytes: MAX_REGISTRY_RECORD_BYTES, maxDepth: 8 }),
        instanceId,
      ),
    );
  }
  return deepFreeze(instances) as readonly RegisteredInstance[];
}

export type ControllerLockObservation =
  | "held-by-this-daemon"
  | "held-elsewhere"
  | "unheld"
  | "probe-unsupported";

/**
 * Observes whether some controller currently owns an instance.
 *
 * The lock is an operating-system object with no read-only interrogation, so
 * the probe attempts an acquisition and releases it immediately. A refused
 * acquisition is the positive evidence; a successful one proves no controller
 * held the instance at that moment. The momentary ownership can make a
 * concurrent controller's own acquisition fail, which is a fail-closed
 * outcome: that controller reports a busy instance rather than starting a
 * duplicate.
 */
export async function probeInstanceControllerLock(
  registryDirectory: string,
  instanceId: string,
): Promise<ControllerLockObservation> {
  let lock: InstanceControllerLock;
  try {
    lock = await InstanceControllerLock.acquire({ directory: registryDirectory, instanceId });
  } catch (error) {
    if (error instanceof InstanceControllerLockError) {
      if (error.code === "CONTROLLER_LOCK_HELD") return "held-elsewhere";
      if (error.code === "CONTROLLER_LOCK_PLATFORM_UNSUPPORTED") return "probe-unsupported";
    }
    throw error;
  }
  await lock.release();
  return "unheld";
}

export type ProcessRecordEvidence =
  | { readonly kind: "none" }
  | {
      readonly kind: "live-identity-proven";
      readonly record: InstanceProcessRecord;
      readonly identityToken: string;
    }
  | { readonly kind: "proven-exited-absent"; readonly record: InstanceProcessRecord }
  | {
      readonly kind: "proven-exited-pid-reused";
      readonly record: InstanceProcessRecord;
      readonly observedIdentityToken: string;
    }
  | {
      readonly kind: "identity-unprovable";
      readonly record: InstanceProcessRecord;
      readonly reason: string;
    };

/**
 * Classifies a durable process record against the live system without
 * signalling anything. A record with no recorded operating-system identity can
 * only ever be proven dead or left unprovable; it can never authorize a
 * signal, because nothing distinguishes the original child from a process that
 * later inherited its identifier.
 */
export async function evaluateProcessRecord(
  record: InstanceProcessRecord | null,
  probe: ProcessIdentityProbe,
): Promise<ProcessRecordEvidence> {
  if (record === null) return { kind: "none" };
  const observation = await probe.observe(record.pid);
  if (observation.kind === "absent") return { kind: "proven-exited-absent", record };
  if (record.osIdentityToken === undefined) {
    return {
      kind: "identity-unprovable",
      record,
      reason: "no-operating-system-identity-was-recorded-for-this-generation",
    };
  }
  if (observation.kind === "unprovable") {
    return { kind: "identity-unprovable", record, reason: observation.reason };
  }
  if (observation.identityToken !== record.osIdentityToken) {
    return {
      kind: "proven-exited-pid-reused",
      record,
      observedIdentityToken: observation.identityToken,
    };
  }
  return { kind: "live-identity-proven", record, identityToken: observation.identityToken };
}

/** True when the evidence proves the recorded child is no longer running. */
export function provesRecordedProcessExited(evidence: ProcessRecordEvidence): boolean {
  return (
    evidence.kind === "none" ||
    evidence.kind === "proven-exited-absent" ||
    evidence.kind === "proven-exited-pid-reused"
  );
}
