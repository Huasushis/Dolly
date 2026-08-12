import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  canonicalJsonByteLength,
  canonicalJsonDigest,
  canonicalizeJson,
  cloneJson,
  deepFreeze,
  isJsonObject,
  type JsonValue,
} from "../canonical-json.js";
import {
  ExtensionCapabilityError,
  type ExtensionCapabilityGrant,
  type ExtensionCapabilityInvocationContext,
} from "../extension-capability.js";
import { parseStrictJsonBytes } from "../strict-json.js";
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
  resolveExecutionScope,
  utf8ByteLength,
  type ExtensionCapabilityDefinition,
  type ResolvedExecutionScope,
} from "./capability-support.js";

export const MODULE_PRIVATE_STORAGE_CAPABILITY_TYPE = "module-private-storage";
export const MODULE_PRIVATE_STORAGE_CAPABILITY_VERSION = "v1";
export const MODULE_PRIVATE_STORAGE_CAPABILITY_VERSION_V2 = "v2";

export type ModulePrivateStorageOperation = "get" | "set" | "delete" | "list";

const STORAGE_OPERATIONS: readonly ModulePrivateStorageOperation[] = [
  "get",
  "set",
  "delete",
  "list",
];
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const NAMESPACE_PATTERN = /^[0-9a-f]{64}$/;
const DOCUMENT_SCHEMA_VERSION = "dolly.extension-module-storage/1";
const NAMESPACE_DOMAIN = "dolly.module-private-storage/1";

export interface ModulePrivateStorageEntry {
  readonly key: string;
  readonly value: JsonValue;
  readonly updatedAt: string;
}

interface NamespaceBinding {
  readonly namespace: string;
  readonly instanceId: string;
  readonly moduleId: string;
}

interface NamespaceDocument extends NamespaceBinding {
  readonly revision: number;
  readonly entries: readonly ModulePrivateStorageEntry[];
}

export interface ModulePrivateStorageBackendOptions {
  /** Host-owned directory. No caller-supplied text ever reaches this path. */
  readonly root: string;
  readonly now: () => string;
  readonly maxDocumentBytes?: number;
}

function dependencyFailure(message: string): ExtensionCapabilityError {
  return new ExtensionCapabilityError("CAPABILITY_DEPENDENCY_FAILED", message);
}

function fsyncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function documentDigest(document: NamespaceDocument): string {
  return canonicalJsonDigest({
    namespace: document.namespace,
    instanceId: document.instanceId,
    moduleId: document.moduleId,
    revision: document.revision,
    entries: document.entries.map((entry) => ({
      key: entry.key,
      value: entry.value,
      updatedAt: entry.updatedAt,
    })),
  });
}

/**
 * The Module-private namespace store from `extension-process-protocol.md`
 * section 8.
 *
 * The namespace name is a keyed digest of the instance and the authenticated
 * `moduleId`. Nothing an Extension can send participates in that derivation,
 * and no key, package name, or display name reaches a filesystem path: one
 * namespace is exactly one host-named document, and every entry lives inside
 * it. A capability issued for one Module therefore has no representable way to
 * address another Module's namespace.
 *
 * Writes replace the document atomically. A crash can leave a partial
 * temporary file beside the document, never a partial document, and the store
 * verifies an integrity digest and the stored namespace binding before it
 * trusts what it read.
 */
export class ModulePrivateStorageBackend {
  readonly #root: string;
  readonly #now: () => string;
  readonly #maxDocumentBytes: number;
  readonly #cache = new Map<string, NamespaceDocument>();
  readonly #swept = new Set<string>();

  constructor(options: ModulePrivateStorageBackendOptions) {
    if (
      typeof options.root !== "string" ||
      options.root.length === 0 ||
      options.root.includes("\0")
    ) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_CONFIG_INVALID",
        "Module private storage root is invalid",
      );
    }
    this.#root = resolve(options.root);
    this.#now = options.now;
    this.#maxDocumentBytes = options.maxDocumentBytes ?? 8 * 1_024 * 1_024;
    assertPositiveLimit(this.#maxDocumentBytes, "maxDocumentBytes");
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
  }

  /**
   * Derives the namespace name. The inputs are the instance and the
   * authenticated Module; the digest makes the result opaque and path-safe by
   * construction rather than by escaping caller text.
   */
  namespaceFor(instanceId: string, moduleId: string): string {
    assertHostIdentifier(instanceId, "instanceId");
    assertHostIdentifier(moduleId, "moduleId");
    return createHash("sha256")
      .update(NAMESPACE_DOMAIN, "utf8")
      .update("\0", "utf8")
      .update(instanceId, "utf8")
      .update("\0", "utf8")
      .update(moduleId, "utf8")
      .digest("hex");
  }

  read(binding: NamespaceBinding): NamespaceDocument {
    const cached = this.#cache.get(binding.namespace);
    if (cached) {
      this.#assertBinding(cached, binding);
      return cached;
    }
    const loaded = this.#load(binding);
    this.#cache.set(binding.namespace, loaded);
    return loaded;
  }

  /**
   * Replaces one namespace document. The on-disk revision must still be the
   * revision this backend last observed; a differing revision means another
   * writer replaced the document, so the update fails closed instead of
   * overwriting state this process never read.
   */
  replace(
    binding: NamespaceBinding,
    entries: readonly ModulePrivateStorageEntry[],
  ): NamespaceDocument {
    const current = this.read(binding);
    const onDisk = this.#load(binding);
    if (onDisk.revision !== current.revision) {
      this.#cache.delete(binding.namespace);
      throw dependencyFailure(
        "Module private storage was replaced by another writer",
      );
    }
    if (!Number.isSafeInteger(current.revision) || current.revision >= Number.MAX_SAFE_INTEGER) {
      throw dependencyFailure("Module private storage revision space is exhausted");
    }
    const next: NamespaceDocument = {
      namespace: binding.namespace,
      instanceId: binding.instanceId,
      moduleId: binding.moduleId,
      revision: current.revision + 1,
      entries: [...entries].sort((left, right) => (left.key < right.key ? -1 : 1)),
    };
    this.#write(next);
    const stored = deepFreeze(next);
    this.#cache.set(binding.namespace, stored);
    return stored;
  }

  #documentPath(namespace: string): string {
    if (!NAMESPACE_PATTERN.test(namespace)) {
      throw dependencyFailure("Module private storage namespace is invalid");
    }
    return join(this.#root, `${namespace}.json`);
  }

  #assertBinding(document: NamespaceDocument, binding: NamespaceBinding): void {
    if (
      document.namespace !== binding.namespace ||
      document.instanceId !== binding.instanceId ||
      document.moduleId !== binding.moduleId
    ) {
      throw dependencyFailure(
        "Module private storage document is bound to a different Module",
      );
    }
  }

  #load(binding: NamespaceBinding): NamespaceDocument {
    const path = this.#documentPath(binding.namespace);
    this.#sweepTemporaryFiles(binding.namespace);
    if (!existsSync(path)) {
      return deepFreeze({
        namespace: binding.namespace,
        instanceId: binding.instanceId,
        moduleId: binding.moduleId,
        revision: 0,
        entries: [] as readonly ModulePrivateStorageEntry[],
      });
    }
    let bytes: Buffer;
    try {
      if (lstatSync(path).isSymbolicLink()) {
        throw dependencyFailure("Module private storage document must not be a symbolic link");
      }
      if (statSync(path).size > this.#maxDocumentBytes) {
        throw dependencyFailure("Module private storage document exceeds its byte limit");
      }
      bytes = readFileSync(path);
    } catch (error) {
      if (error instanceof ExtensionCapabilityError) throw error;
      throw dependencyFailure("Module private storage could not be read");
    }
    let value: JsonValue;
    try {
      value = parseStrictJsonBytes(bytes, {
        maxBytes: this.#maxDocumentBytes,
        maxDepth: 64,
      });
    } catch {
      throw dependencyFailure("Module private storage document is not strict JSON data");
    }
    if (!isJsonObject(value) || value.schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
      throw dependencyFailure("Module private storage document schema is invalid");
    }
    const entriesValue = value.entries;
    if (
      typeof value.namespace !== "string" ||
      typeof value.instanceId !== "string" ||
      typeof value.moduleId !== "string" ||
      typeof value.revision !== "number" ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      typeof value.documentDigest !== "string" ||
      !Array.isArray(entriesValue)
    ) {
      throw dependencyFailure("Module private storage document schema is invalid");
    }
    const entries: ModulePrivateStorageEntry[] = [];
    for (const entry of entriesValue) {
      if (
        !isJsonObject(entry) ||
        typeof entry.key !== "string" ||
        typeof entry.updatedAt !== "string" ||
        !Object.prototype.hasOwnProperty.call(entry, "value")
      ) {
        throw dependencyFailure("Module private storage document entry is invalid");
      }
      entries.push({ key: entry.key, value: entry.value, updatedAt: entry.updatedAt });
    }
    const document: NamespaceDocument = {
      namespace: value.namespace,
      instanceId: value.instanceId,
      moduleId: value.moduleId,
      revision: value.revision,
      entries,
    };
    if (documentDigest(document) !== value.documentDigest) {
      throw dependencyFailure("Module private storage document digest does not match");
    }
    this.#assertBinding(document, binding);
    return deepFreeze(document);
  }

  #write(document: NamespaceDocument): void {
    const path = this.#documentPath(document.namespace);
    const payload = `${canonicalizeJson({
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      documentDigest: documentDigest(document),
      namespace: document.namespace,
      instanceId: document.instanceId,
      moduleId: document.moduleId,
      revision: document.revision,
      entries: document.entries.map((entry) => ({
        key: entry.key,
        value: entry.value,
        updatedAt: entry.updatedAt,
      })),
    })}\n`;
    if (Buffer.byteLength(payload, "utf8") > this.#maxDocumentBytes) {
      throw capabilityQuotaError("maxDocumentBytes", this.#maxDocumentBytes);
    }
    const parent = dirname(path);
    const temporaryPath = join(parent, `.${document.namespace}.json.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, payload, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, path);
      fsyncDirectory(parent);
    } catch (error) {
      if (error instanceof ExtensionCapabilityError) throw error;
      throw dependencyFailure("Module private storage write failed");
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the primary write result.
        }
      }
      if (existsSync(temporaryPath)) {
        try {
          unlinkSync(temporaryPath);
        } catch {
          // A same-directory temporary file is never committed state.
        }
      }
    }
  }

  /**
   * Removes temporary files left by an interrupted replacement. The atomic
   * rename is the commit point, so a file that still carries the temporary
   * name was never committed and can never be read as state.
   */
  #sweepTemporaryFiles(namespace: string): void {
    if (this.#swept.has(namespace)) return;
    this.#swept.add(namespace);
    const prefix = `.${namespace}.json.`;
    let names: readonly string[];
    try {
      names = readdirSync(this.#root);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
      try {
        unlinkSync(join(this.#root, name));
      } catch {
        // Another writer may have removed it first.
      }
    }
  }

  /** Host wall clock used to stamp one stored entry. */
  timestamp(): string {
    return this.#now();
  }
}

export interface ModulePrivateStorageLimits {
  readonly maxKeyBytes: number;
  readonly maxValueBytes: number;
  readonly maxEntries: number;
  readonly maxTotalBytes: number;
  readonly maxListResults: number;
  readonly maxArgumentBytes: number;
  readonly maxResultBytes: number;
  readonly maxInvocations: number;
}

export interface ModulePrivateStorageLimitsV2 extends ModulePrivateStorageLimits {
  /** Host-enforced operation ceiling for one exact Module Run. */
  readonly maxInvocationsPerRun: number;
}

export const DEFAULT_MODULE_PRIVATE_STORAGE_LIMITS: ModulePrivateStorageLimits =
  deepFreeze({
    maxKeyBytes: 128,
    maxValueBytes: 16 * 1_024,
    maxEntries: 512,
    maxTotalBytes: 1_024 * 1_024,
    maxListResults: 128,
    maxArgumentBytes: 32 * 1_024,
    maxResultBytes: 32 * 1_024,
    maxInvocations: 4_096,
  });

export const DEFAULT_MODULE_PRIVATE_STORAGE_LIMITS_V2: ModulePrivateStorageLimitsV2 =
  deepFreeze({
    ...DEFAULT_MODULE_PRIVATE_STORAGE_LIMITS,
    maxInvocationsPerRun: 64,
  });

export interface ModulePrivateStorageCapabilityOptions {
  readonly backend: ModulePrivateStorageBackend;
  /** The instance this grant belongs to, chosen by the host. */
  readonly instanceId: string;
  /** The Module this grant belongs to, chosen by the host. */
  readonly moduleId: string;
  /**
   * The operations this grant authorizes. Read, write, and delete are separate
   * operations so a host can grant them separately.
   */
  readonly operations: readonly ModulePrivateStorageOperation[];
  readonly expiresAt: string;
  readonly executionScope?: ResolvedExecutionScope;
  readonly limits?: Partial<ModulePrivateStorageLimits>;
  readonly maxConcurrentInvocations?: number;
  readonly requireIdempotencyKey?: boolean;
}

export interface ModulePrivateStorageCapabilityV2Options extends Omit<
  ModulePrivateStorageCapabilityOptions,
  "executionScope" | "limits"
> {
  /** Explicitly fixed to one Run or reused only through Host-verified active Runs. */
  readonly executionScope: ResolvedExecutionScope | "active-run";
  readonly limits?: Partial<ModulePrivateStorageLimitsV2>;
}

function resolveStorageLimits(
  overrides: Partial<ModulePrivateStorageLimits> | undefined,
): ModulePrivateStorageLimits {
  const limits = { ...DEFAULT_MODULE_PRIVATE_STORAGE_LIMITS, ...(overrides ?? {}) };
  for (const [label, value] of Object.entries(limits)) {
    assertPositiveLimit(value, `module private storage ${label}`);
  }
  return deepFreeze(limits);
}

function resolveStorageLimitsV2(
  overrides: Partial<ModulePrivateStorageLimitsV2> | undefined,
): ModulePrivateStorageLimitsV2 {
  const limits = { ...DEFAULT_MODULE_PRIVATE_STORAGE_LIMITS_V2, ...(overrides ?? {}) };
  for (const [label, value] of Object.entries(limits)) {
    assertPositiveLimit(value, `module private storage ${label}`);
  }
  return deepFreeze(limits);
}

function entryBytes(key: string, value: JsonValue): number {
  return utf8ByteLength(key) + canonicalJsonByteLength(value);
}

export function createModulePrivateStorageCapability(
  options: ModulePrivateStorageCapabilityOptions,
): ExtensionCapabilityDefinition {
  return buildModulePrivateStorageCapability(
    options,
    MODULE_PRIVATE_STORAGE_CAPABILITY_VERSION,
    resolveStorageLimits(options.limits),
  );
}

/** Builds the explicit active-Run-capable, per-Run-bounded storage grant. */
export function createModulePrivateStorageCapabilityV2(
  options: ModulePrivateStorageCapabilityV2Options,
): ExtensionCapabilityDefinition {
  return buildModulePrivateStorageCapability(
    options,
    MODULE_PRIVATE_STORAGE_CAPABILITY_VERSION_V2,
    resolveStorageLimitsV2(options.limits),
  );
}

function buildModulePrivateStorageCapability(
  options: ModulePrivateStorageCapabilityOptions | ModulePrivateStorageCapabilityV2Options,
  capabilityVersion:
    | typeof MODULE_PRIVATE_STORAGE_CAPABILITY_VERSION
    | typeof MODULE_PRIVATE_STORAGE_CAPABILITY_VERSION_V2,
  limits: ModulePrivateStorageLimits | ModulePrivateStorageLimitsV2,
): ExtensionCapabilityDefinition {
  const instanceId = assertHostIdentifier(options.instanceId, "instanceId");
  const moduleId = assertHostIdentifier(options.moduleId, "moduleId");
  if (!Array.isArray(options.operations) || options.operations.length === 0) {
    throw new ExtensionCapabilityError(
      "CAPABILITY_CONFIG_INVALID",
      "Module private storage requires at least one operation",
    );
  }
  const operations = [...new Set(options.operations)];
  for (const operation of operations) {
    if (!STORAGE_OPERATIONS.includes(operation)) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_CONFIG_INVALID",
        `Module private storage does not define the operation ${String(operation)}`,
      );
    }
  }
  const enabled = new Set<ModulePrivateStorageOperation>(operations);
  const namespace = options.backend.namespaceFor(instanceId, moduleId);
  const activeRun = options.executionScope === "active-run";
  if (
    capabilityVersion === MODULE_PRIVATE_STORAGE_CAPABILITY_VERSION_V2 &&
    options.executionScope === undefined
  ) {
    throw new ExtensionCapabilityError(
      "CAPABILITY_CONFIG_INVALID",
      "Module private storage version 2 requires an explicit execution scope",
    );
  }
  const grantScope = options.executionScope !== undefined && !activeRun
    ? {
        moduleJobId: assertHostIdentifier(options.executionScope.moduleJobId, "moduleJobId"),
        runId: assertHostIdentifier(options.executionScope.runId, "runId"),
      }
    : undefined;

  const grant: ExtensionCapabilityGrant = {
    capabilityType: MODULE_PRIVATE_STORAGE_CAPABILITY_TYPE,
    capabilityVersion,
    operations,
    resourceScope: {
      schemaVersion:
        capabilityVersion === MODULE_PRIVATE_STORAGE_CAPABILITY_VERSION_V2
          ? "dolly.capability-scope.module-private-storage/2"
          : "dolly.capability-scope.module-private-storage/1",
      namespace,
      instanceId,
      moduleId,
      limits: { ...limits },
      ...(capabilityVersion === MODULE_PRIVATE_STORAGE_CAPABILITY_VERSION_V2
        ? activeRun
          ? { executionScope: "active-run" }
          : { moduleJobId: grantScope!.moduleJobId }
        : {}),
    },
    expiresAt: options.expiresAt,
    maxInvocations: limits.maxInvocations,
    ...(capabilityVersion === MODULE_PRIVATE_STORAGE_CAPABILITY_VERSION_V2
      ? {
          maxInvocationsPerRun: Math.min(
            limits.maxInvocations,
            (limits as ModulePrivateStorageLimitsV2).maxInvocationsPerRun,
          ),
        }
      : {}),
    maxConcurrentInvocations: options.maxConcurrentInvocations ?? 1,
    maxArgumentBytes: limits.maxArgumentBytes,
    maxResultBytes: limits.maxResultBytes,
    ...(grantScope === undefined ? {} : { executionScope: grantScope }),
    ...(options.requireIdempotencyKey === true ? { requireIdempotencyKey: true } : {}),
  };

  const invocationsByRun = new Map<string, number>();
  const consumeRunSlot = (context: ExtensionCapabilityInvocationContext): void => {
    if (capabilityVersion !== MODULE_PRIVATE_STORAGE_CAPABILITY_VERSION_V2) return;
    const execution = resolveExecutionScope(grantScope, context);
    const key = `${execution.moduleJobId}\u0000${execution.runId}`;
    const used = invocationsByRun.get(key) ?? 0;
    const maximum = (limits as ModulePrivateStorageLimitsV2).maxInvocationsPerRun;
    if (used >= maximum) {
      throw capabilityQuotaError("maxInvocationsPerRun", maximum);
    }
    invocationsByRun.set(key, used + 1);
  };

  const bindingFor = (context: ExtensionCapabilityInvocationContext): NamespaceBinding => {
    // The namespace is derived from the authenticated session identity, then
    // checked against the identity this grant was created for. A handle issued
    // to one Module can never name another Module's namespace, even if it is
    // somehow presented inside another Module's session.
    const identity = context.identity;
    if (identity.instanceId !== instanceId || identity.moduleId !== moduleId) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_SCOPE_MISMATCH",
        "Storage capability does not belong to this Module",
      );
    }
    const derived = options.backend.namespaceFor(identity.instanceId, identity.moduleId);
    if (derived !== namespace) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_SCOPE_MISMATCH",
        "Storage capability namespace does not match its Module",
      );
    }
    return { namespace: derived, instanceId: identity.instanceId, moduleId: identity.moduleId };
  };

  const readKey = (
    argumentsValue: Readonly<Record<string, JsonValue>>,
    label: string,
  ): string => {
    const key = requireString(argumentsValue, "key", label);
    if (utf8ByteLength(key) > limits.maxKeyBytes) {
      throw capabilityQuotaError("maxKeyBytes", limits.maxKeyBytes);
    }
    if (!KEY_PATTERN.test(key)) {
      throw capabilityArgumentError(`${label}.key is not a permitted storage key`);
    }
    return key;
  };

  const handler = (
    argumentsValue: JsonValue,
    context: ExtensionCapabilityInvocationContext,
  ): JsonValue => {
    const operation = context.operation as ModulePrivateStorageOperation;
    if (!enabled.has(operation)) {
      throw new ExtensionCapabilityError(
        "CAPABILITY_DENIED",
        "Module private storage does not authorize this operation",
      );
    }
    const binding = bindingFor(context);

    if (operation === "get") {
      const parsed = assertClosedArguments(argumentsValue, ["key"], "storage.get");
      const key = readKey(parsed, "storage.get");
      consumeRunSlot(context);
      const entry = options.backend
        .read(binding)
        .entries.find((candidate) => candidate.key === key);
      if (!entry) return { schemaVersion: "dolly.storage-get/1", found: false };
      return {
        schemaVersion: "dolly.storage-get/1",
        found: true,
        value: entry.value,
        updatedAt: entry.updatedAt,
      };
    }

    if (operation === "list") {
      const parsed = assertClosedArguments(
        argumentsValue,
        ["prefix", "limit", "after"],
        "storage.list",
      );
      const prefix = optionalString(parsed, "prefix", "storage.list") ?? "";
      if (utf8ByteLength(prefix) > limits.maxKeyBytes) {
        throw capabilityQuotaError("maxKeyBytes", limits.maxKeyBytes);
      }
      const after = optionalString(parsed, "after", "storage.list");
      if (after !== undefined && utf8ByteLength(after) > limits.maxKeyBytes) {
        throw capabilityQuotaError("maxKeyBytes", limits.maxKeyBytes);
      }
      const limit =
        optionalBoundedInteger(parsed, "limit", "storage.list", limits.maxListResults) ??
        limits.maxListResults;
      consumeRunSlot(context);
      const matching = options.backend
        .read(binding)
        .entries.filter(
          (entry) =>
            entry.key.startsWith(prefix) && (after === undefined || entry.key > after),
        );
      const page = matching.slice(0, Math.max(limit, 0));
      const truncated = page.length < matching.length;
      return {
        schemaVersion: "dolly.storage-list/1",
        keys: page.map((entry) => entry.key),
        truncated,
        ...(truncated ? { nextAfter: page[page.length - 1]!.key } : {}),
      };
    }

    if (operation === "set") {
      const parsed = assertClosedArguments(argumentsValue, ["key", "value"], "storage.set");
      const key = readKey(parsed, "storage.set");
      const value = readField(parsed, "value");
      if (value === undefined) {
        throw capabilityArgumentError("storage.set.value is required");
      }
      if (canonicalJsonByteLength(value) > limits.maxValueBytes) {
        throw capabilityQuotaError("maxValueBytes", limits.maxValueBytes);
      }
      consumeRunSlot(context);
      const document = options.backend.read(binding);
      const existing = document.entries.find((entry) => entry.key === key);
      if (!existing && document.entries.length + 1 > limits.maxEntries) {
        throw capabilityQuotaError("maxEntries", limits.maxEntries);
      }
      let total = entryBytes(key, value);
      for (const entry of document.entries) {
        if (entry.key === key) continue;
        total += entryBytes(entry.key, entry.value);
      }
      if (total > limits.maxTotalBytes) {
        throw capabilityQuotaError("maxTotalBytes", limits.maxTotalBytes);
      }
      const updated: ModulePrivateStorageEntry = {
        key,
        value: cloneJson(value),
        updatedAt: options.backend.timestamp(),
      };
      const entries = [
        ...document.entries.filter((entry) => entry.key !== key),
        updated,
      ];
      const stored = options.backend.replace(binding, entries);
      return {
        schemaVersion: "dolly.storage-set/1",
        stored: true,
        revision: stored.revision,
        entryCount: stored.entries.length,
      };
    }

    const parsed = assertClosedArguments(argumentsValue, ["key"], "storage.delete");
    const key = readKey(parsed, "storage.delete");
    consumeRunSlot(context);
    const document = options.backend.read(binding);
    if (!document.entries.some((entry) => entry.key === key)) {
      return {
        schemaVersion: "dolly.storage-delete/1",
        deleted: false,
        revision: document.revision,
      };
    }
    const stored = options.backend.replace(
      binding,
      document.entries.filter((entry) => entry.key !== key),
    );
    return {
      schemaVersion: "dolly.storage-delete/1",
      deleted: true,
      revision: stored.revision,
    };
  };

  return { grant, handler };
}
