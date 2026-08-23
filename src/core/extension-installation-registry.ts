/**
 * Installs Node.js Extension package directories without executing them.
 * Manifests use JavaScript Object Notation (JSON), entrypoints use Portable
 * Operating System Interface (POSIX) path syntax, text uses 8-bit Unicode
 * Transformation Format (UTF-8), and content digests use Secure Hash Algorithm
 * 256-bit (SHA-256).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  posix,
  relative,
  resolve,
  win32,
} from "node:path";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  canonicalJsonDigest,
  canonicalizeJson,
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import { parseContentSchemaName } from "./block-content.js";
import {
  createExtensionPackageSnapshot,
  type ExtensionPackageSnapshot,
  type ExtensionPackageSnapshotSourceFile,
} from "./extension-package-snapshot.js";
import { compileJsonSchema } from "./json-schema.js";
import { parseStrictJsonBytes } from "./strict-json.js";
import type { ExtensionTrust } from "./extension-process-host.js";
import {
  SynchronousCrossProcessLockError,
  withSynchronousCrossProcessLock,
} from "./synchronous-cross-process-lock.js";

const PACKAGE_MANIFEST_FILE = "dolly-extension.json";
const PACKAGE_SCHEMA_VERSION_V1 = "dolly.extension-package/1";
const PACKAGE_SCHEMA_VERSION_V2 = "dolly.extension-package/2";
const PACKAGE_SCHEMA_VERSION_V3 = "dolly.extension-package/3";
const PACKAGE_SCHEMA_VERSION_V4 = "dolly.extension-package/4";
const PACKAGE_SCHEMA_VERSION_V10 = "dolly.extension-package/10";
const INSTALLATION_RECORD_SCHEMA_VERSION = "dolly.extension-installation/1";
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DEFAULT_MAX_MANIFEST_BYTES = 256 * 1024;
const DEFAULT_MAX_MANIFEST_DEPTH = 64;
const DEFAULT_MAX_FILE_COUNT = 2_048;
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAX_RELATIVE_PATH_BYTES = 4_096;

export type { ExtensionTrust } from "./extension-process-host.js";

interface ExtensionPackageModuleCommon extends Readonly<Record<string, JsonValue>> {
  readonly moduleKind: string;
  readonly configVersion: number;
  readonly configurationSchema: JsonValue;
}

/** One exact policy-definition reference selected by a reserved version-10 package. */
export interface ExtensionPackagePermissionPolicyReferenceV10
  extends Readonly<Record<string, JsonValue>> {
  readonly policyId: string;
  /** Canonical digest of the exact policy definition revision. */
  readonly revision: string;
}

export type ExtensionPackageCapabilityTypeV10 =
  | "model-operation"
  | "tool-invocation"
  | "module-private-storage";

/** One closed, policy-bound capability request in a reserved version-10 package. */
export interface ExtensionPackageCapabilityRequestV10
  extends Readonly<Record<string, JsonValue>> {
  readonly moduleKind: string;
  readonly capabilityType: ExtensionPackageCapabilityTypeV10;
  readonly capabilityVersion: "v2" | "v3";
  readonly policyId: string;
  readonly policyRevision: string;
}

/** One Extension-owned structured-data producer declaration. */
export interface ExtensionContentSchemaProducer extends Readonly<Record<string, JsonValue>> {
  readonly schema: string;
  readonly validator: JsonValue;
  readonly validatorDigest: string;
  readonly maxValueBytes: number;
  readonly containsCoreReferences: false;
}

export interface ExtensionPackageModuleV1 extends ExtensionPackageModuleCommon {
  readonly activation: "reactive";
}

export interface ExtensionPackageModuleV2 extends ExtensionPackageModuleCommon {
  readonly activation: "reactive";
  readonly producedContentSchemas: readonly ExtensionContentSchemaProducer[];
}

export interface ExtensionPackageModuleV3 extends ExtensionPackageModuleCommon {
  /** Version 3 adds only the already-durable source activation contract. */
  readonly activation: "reactive" | "source";
  readonly producedContentSchemas: readonly ExtensionContentSchemaProducer[];
}

export interface ExtensionPackageModuleV4 extends ExtensionPackageModuleCommon {
  /** Version 4 also permits the Scheduler's non-empty periodic activation. */
  readonly activation: "reactive" | "periodic" | "source";
  readonly producedContentSchemas: readonly ExtensionContentSchemaProducer[];
}

export interface ExtensionPackageModuleV10 extends ExtensionPackageModuleCommon {
  readonly activation: "reactive" | "periodic" | "source";
  readonly producedContentSchemas: readonly ExtensionContentSchemaProducer[];
  readonly permissionPolicyReferences: readonly ExtensionPackagePermissionPolicyReferenceV10[];
}

export type ExtensionPackageModule =
  | ExtensionPackageModuleV1
  | ExtensionPackageModuleV2
  | ExtensionPackageModuleV3
  | ExtensionPackageModuleV4
  | ExtensionPackageModuleV10;

/**
 * The closed Extension package manifest is read before any Extension code
 * runs. It relates a Node.js package to Dolly's Extension process protocol and
 * Module configuration; `package.json` has no standard fields for those
 * Dolly-specific declarations.
 */
interface ExtensionPackageManifestCommon extends Readonly<Record<string, JsonValue>> {
  readonly extensionId: string;
  readonly packageVersion: string;
  readonly displayName: string;
  readonly description: string;
  readonly supportedProtocolVersions: readonly string[];
  readonly entrypoint: string;
}

export interface ExtensionPackageManifestV1 extends ExtensionPackageManifestCommon {
  readonly schemaVersion: "dolly.extension-package/1";
  readonly modules: readonly ExtensionPackageModuleV1[];
  readonly requestedCapabilities: readonly [];
}

export interface ExtensionPackageManifestV2 extends ExtensionPackageManifestCommon {
  readonly schemaVersion: "dolly.extension-package/2";
  readonly modules: readonly ExtensionPackageModuleV2[];
  readonly requestedCapabilities: readonly [];
}

export interface ExtensionPackageManifestV3 extends ExtensionPackageManifestCommon {
  readonly schemaVersion: "dolly.extension-package/3";
  readonly modules: readonly ExtensionPackageModuleV3[];
  readonly requestedCapabilities: readonly [];
}

export interface ExtensionPackageManifestV4 extends ExtensionPackageManifestCommon {
  readonly schemaVersion: "dolly.extension-package/4";
  readonly modules: readonly ExtensionPackageModuleV4[];
  readonly requestedCapabilities: readonly [];
}

export interface ExtensionPackageManifestV10 extends ExtensionPackageManifestCommon {
  readonly schemaVersion: "dolly.extension-package/10";
  readonly modules: readonly ExtensionPackageModuleV10[];
  readonly requestedCapabilities: readonly ExtensionPackageCapabilityRequestV10[];
}

export type ExtensionPackageManifest =
  | ExtensionPackageManifestV1
  | ExtensionPackageManifestV2
  | ExtensionPackageManifestV3
  | ExtensionPackageManifestV4
  | ExtensionPackageManifestV10;

export interface ExtensionModuleCompatibility {
  readonly extensionId: string;
  readonly packageVersion: string;
  readonly moduleKind: string;
  readonly configVersion: number;
  readonly activation: "reactive" | "periodic" | "source";
}

export interface ResolvedExtensionInstallation {
  readonly manifest: Readonly<ExtensionPackageManifest>;
  readonly trust: ExtensionTrust;
  readonly packageDigest: string;
  readonly workingDirectory: string;
  readonly entrypointPath: string;
  /** Exact bytes read in the same scan that produced packageDigest. */
  readonly packageSnapshot: ExtensionPackageSnapshot;
}

export interface ExtensionInstallationRegistryOptions {
  readonly directory: string;
  readonly maxManifestBytes?: number;
  readonly maxManifestDepth?: number;
  /** Limits files and, independently, directories in one package. */
  readonly maxFileCount?: number;
  readonly maxFileBytes?: number;
  readonly maxPackageBytes?: number;
}

export interface InstallNodeExtensionPackageOptions {
  readonly sourceDirectory: string;
  readonly trust: ExtensionTrust;
}

export interface ResolveExtensionInstallationOptions {
  readonly extensionId: string;
  readonly packageVersion: string;
}

/**
 * These stable failure categories let callers reject invalid or changed
 * installations without parsing messages. They separate source-package errors
 * from registry conflicts, missing records, integrity failures, locks, and
 * input/output failures (`IO` in the literal error code).
 */
export type ExtensionInstallationErrorCode =
  | "EXTENSION_PACKAGE_INVALID"
  | "EXTENSION_PACKAGE_PATH_INVALID"
  | "EXTENSION_PACKAGE_LIMIT_EXCEEDED"
  | "EXTENSION_INSTALLATION_CONFLICT"
  | "EXTENSION_INSTALLATION_NOT_FOUND"
  | "EXTENSION_INSTALLATION_TAMPERED"
  | "EXTENSION_INSTALLATION_LOCKED"
  | "EXTENSION_INSTALLATION_IO_FAILED";

export class ExtensionInstallationError extends Error {
  constructor(
    readonly code: ExtensionInstallationErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ExtensionInstallationError";
  }
}

interface InstalledFile extends Readonly<Record<string, JsonValue>> {
  readonly path: string;
  readonly digest: string;
  readonly byteLength: number;
}

/**
 * `dolly.extension-installation/1` maps one Extension identity to immutable
 * managed bytes and its explicit trust value. A separate Dolly record is needed
 * because Node package metadata does not bind trust or a verified file list.
 */
interface ExtensionInstallationRecord extends Readonly<Record<string, JsonValue>> {
  readonly schemaVersion: "dolly.extension-installation/1";
  readonly extensionId: string;
  readonly packageVersion: string;
  readonly trust: ExtensionTrust;
  readonly packageDigest: string;
  readonly files: readonly InstalledFile[];
}

interface ScannedPackage {
  readonly manifest: ExtensionPackageManifest;
  readonly files: readonly InstalledFile[];
  readonly packageDigest: string;
  readonly packageSnapshot: ExtensionPackageSnapshot;
}

interface InstallationLimits {
  readonly maxManifestBytes: number;
  readonly maxManifestDepth: number;
  readonly maxFileCount: number;
  readonly maxFileBytes: number;
  readonly maxPackageBytes: number;
  readonly maxRecordBytes: number;
}

type PackageLocation = "source" | "managed";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ExtensionInstallationError(
      "EXTENSION_PACKAGE_INVALID",
      `${label} must be an object`,
    );
  }
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  const missing = keys.filter((key) => !(key in value));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new ExtensionInstallationError(
      "EXTENSION_PACKAGE_INVALID",
      `${label} does not have the required closed shape`,
    );
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new ExtensionInstallationError(
      "EXTENSION_PACKAGE_INVALID",
      `${label} must be a non-empty restricted ASCII identifier`,
    );
  }
  return value;
}

function boundedText(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new ExtensionInstallationError(
      "EXTENSION_PACKAGE_INVALID",
      `${label} must be non-empty and no larger than ${maxBytes} UTF-8 bytes`,
    );
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ExtensionInstallationError(
      "EXTENSION_PACKAGE_INVALID",
      `${label} must be a positive safe integer`,
    );
  }
  return value as number;
}

function isRelativePosixPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_RELATIVE_PATH_BYTES ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    posix.isAbsolute(value) ||
    win32.isAbsolute(value) ||
    posix.normalize(value) !== value
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) =>
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !/[\u0000-\u001f]/u.test(segment)
  );
}

function entrypoint(value: unknown): string {
  const lastSegment = typeof value === "string" ? value.split("/").at(-1) : undefined;
  if (
    !isRelativePosixPath(value) ||
    !value.endsWith(".mjs") ||
    lastSegment === undefined ||
    lastSegment.length <= ".mjs".length
  ) {
    throw new ExtensionInstallationError(
      "EXTENSION_PACKAGE_PATH_INVALID",
      "entrypoint must be a relative POSIX path naming an .mjs file",
    );
  }
  return value;
}

function normalizedCaseKey(value: string): string {
  return value.normalize("NFKC").toUpperCase().toLowerCase();
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestPathComponent(digest: string): string {
  if (!DIGEST_PATTERN.test(digest)) {
    throw new ExtensionInstallationError(
      "EXTENSION_INSTALLATION_TAMPERED",
      "Installation contains an invalid digest",
    );
  }
  return digest.slice("sha256:".length);
}

function validateLimits(options: ExtensionInstallationRegistryOptions): InstallationLimits {
  const maxManifestBytes = options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES;
  const maxManifestDepth = options.maxManifestDepth ?? DEFAULT_MAX_MANIFEST_DEPTH;
  const maxFileCount = options.maxFileCount ?? DEFAULT_MAX_FILE_COUNT;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxPackageBytes = options.maxPackageBytes ?? DEFAULT_MAX_PACKAGE_BYTES;
  for (const [name, value] of Object.entries({
    maxManifestBytes,
    maxManifestDepth,
    maxFileCount,
    maxFileBytes,
    maxPackageBytes,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  if (maxFileCount > 100_000) throw new TypeError("maxFileCount cannot exceed 100000");
  const maxRecordBytes = Math.max(
    64 * 1024,
    Math.min(
      DEFAULT_MAX_PACKAGE_BYTES,
      maxFileCount * (MAX_RELATIVE_PATH_BYTES * 2 + 512) + 4_096,
    ),
  );
  return {
    maxManifestBytes,
    maxManifestDepth,
    maxFileCount,
    maxFileBytes,
    maxPackageBytes,
    maxRecordBytes,
  };
}

function validateManifest(value: JsonValue): ExtensionPackageManifest {
  exactKeys(
    value,
    [
      "schemaVersion",
      "extensionId",
      "packageVersion",
      "displayName",
      "description",
      "supportedProtocolVersions",
      "entrypoint",
      "modules",
      "requestedCapabilities",
    ],
    "Extension package manifest",
  );
  if (
    value.schemaVersion !== PACKAGE_SCHEMA_VERSION_V1 &&
    value.schemaVersion !== PACKAGE_SCHEMA_VERSION_V2 &&
    value.schemaVersion !== PACKAGE_SCHEMA_VERSION_V3 &&
    value.schemaVersion !== PACKAGE_SCHEMA_VERSION_V4 &&
    value.schemaVersion !== PACKAGE_SCHEMA_VERSION_V10
  ) {
    throw new ExtensionInstallationError(
      "EXTENSION_PACKAGE_INVALID",
      "Extension package schema is unsupported",
    );
  }
  const schemaVersion = value.schemaVersion;
  const isReservedV10 = schemaVersion === PACKAGE_SCHEMA_VERSION_V10;
  const extensionId = identifier(value.extensionId, "extensionId");
  if (
    !Array.isArray(value.supportedProtocolVersions) ||
    value.supportedProtocolVersions.length === 0 ||
    value.supportedProtocolVersions.length > 32
  ) {
    throw new ExtensionInstallationError(
      "EXTENSION_PACKAGE_INVALID",
      "supportedProtocolVersions must contain between 1 and 32 values",
    );
  }
  const supportedProtocolVersions = value.supportedProtocolVersions.map((candidate, index) =>
    identifier(candidate, `supportedProtocolVersions[${index}]`)
  );
  if (new Set(supportedProtocolVersions).size !== supportedProtocolVersions.length) {
    throw new ExtensionInstallationError(
      "EXTENSION_PACKAGE_INVALID",
      "supportedProtocolVersions contains duplicates",
    );
  }
  if (!Array.isArray(value.modules) || value.modules.length === 0 || value.modules.length > 256) {
    throw new ExtensionInstallationError(
      "EXTENSION_PACKAGE_INVALID",
      "modules must contain between 1 and 256 entries",
    );
  }
  const moduleKinds = new Set<string>();
  const modules = value.modules.map((candidate, index): ExtensionPackageModule => {
    const label = `modules[${index}]`;
    exactKeys(
      candidate,
      schemaVersion === PACKAGE_SCHEMA_VERSION_V1
        ? ["moduleKind", "activation", "configVersion", "configurationSchema"]
        : isReservedV10
        ? [
            "moduleKind",
            "activation",
            "configVersion",
            "configurationSchema",
            "producedContentSchemas",
            "permissionPolicyReferences",
          ]
        : [
            "moduleKind",
            "activation",
            "configVersion",
            "configurationSchema",
            "producedContentSchemas",
          ],
      label,
    );
    const moduleKind = identifier(candidate.moduleKind, `${label}.moduleKind`);
    if (moduleKinds.has(moduleKind)) {
      throw new ExtensionInstallationError(
        "EXTENSION_PACKAGE_INVALID",
        "modules contains a duplicate moduleKind",
      );
    }
    moduleKinds.add(moduleKind);
    const activationSupported = candidate.activation === "reactive" ||
      ((schemaVersion === PACKAGE_SCHEMA_VERSION_V3 ||
        schemaVersion === PACKAGE_SCHEMA_VERSION_V4 ||
        isReservedV10) &&
        candidate.activation === "source") ||
      ((schemaVersion === PACKAGE_SCHEMA_VERSION_V4 || isReservedV10) &&
        candidate.activation === "periodic");
    if (!activationSupported) {
      throw new ExtensionInstallationError(
        "EXTENSION_PACKAGE_INVALID",
        `${label}.activation is unsupported by package schema ${schemaVersion}`,
      );
    }
    try {
      compileJsonSchema(candidate.configurationSchema as JsonValue);
    } catch (error) {
      throw new ExtensionInstallationError(
        "EXTENSION_PACKAGE_INVALID",
        `${label}.configurationSchema is not valid Draft 2020-12 JSON Schema`,
        { cause: error },
      );
    }
    const common = {
      moduleKind,
      activation: candidate.activation as "reactive" | "periodic" | "source",
      configVersion: positiveInteger(candidate.configVersion, `${label}.configVersion`),
      configurationSchema: cloneJson(candidate.configurationSchema as JsonValue),
    };
    if (schemaVersion === PACKAGE_SCHEMA_VERSION_V1) {
      return { ...common, activation: "reactive" as const };
    }
    if (
      !Array.isArray(candidate.producedContentSchemas) ||
      candidate.producedContentSchemas.length > 64
    ) {
      throw new ExtensionInstallationError(
        "EXTENSION_PACKAGE_INVALID",
        `${label}.producedContentSchemas must contain at most 64 entries`,
      );
    }
    const names = new Set<string>();
    const producedContentSchemas = candidate.producedContentSchemas.map(
      (raw, registrationIndex): ExtensionContentSchemaProducer => {
        const registrationLabel =
          `${label}.producedContentSchemas[${registrationIndex}]`;
        exactKeys(
          raw,
          [
            "schema",
            "validator",
            "validatorDigest",
            "maxValueBytes",
            "containsCoreReferences",
          ],
          registrationLabel,
        );
        let schema: string;
        try {
          schema = parseContentSchemaName(raw.schema, `${registrationLabel}.schema`);
        } catch (error) {
          throw new ExtensionInstallationError(
            "EXTENSION_PACKAGE_INVALID",
            `${registrationLabel}.schema is not a valid content schema name`,
            { cause: error },
          );
        }
        const unversionedName = schema.slice(0, schema.lastIndexOf("/"));
        if (
          schema.startsWith("dolly.") ||
          !unversionedName.startsWith(`${extensionId}.`)
        ) {
          throw new ExtensionInstallationError(
            "EXTENSION_PACKAGE_INVALID",
            `${registrationLabel}.schema is not owned by this Extension package`,
          );
        }
        if (names.has(schema)) {
          throw new ExtensionInstallationError(
            "EXTENSION_PACKAGE_INVALID",
            `${label}.producedContentSchemas contains a duplicate schema name`,
          );
        }
        names.add(schema);
        const validator = cloneJson(raw.validator as JsonValue);
        try {
          compileJsonSchema(validator);
        } catch (error) {
          throw new ExtensionInstallationError(
            "EXTENSION_PACKAGE_INVALID",
            `${registrationLabel}.validator is not valid Draft 2020-12 JSON Schema`,
            { cause: error },
          );
        }
        const validatorDigest = raw.validatorDigest;
        if (
          typeof validatorDigest !== "string" ||
          !DIGEST_PATTERN.test(validatorDigest) ||
          canonicalJsonDigest(validator) !== validatorDigest
        ) {
          throw new ExtensionInstallationError(
            "EXTENSION_PACKAGE_INVALID",
            `${registrationLabel}.validatorDigest does not match its validator`,
          );
        }
        if (raw.containsCoreReferences !== false) {
          throw new ExtensionInstallationError(
            "EXTENSION_PACKAGE_INVALID",
            `${registrationLabel}.containsCoreReferences must be false until a reference extractor is defined`,
          );
        }
        return {
          schema,
          validator,
          validatorDigest,
          maxValueBytes: positiveInteger(
            raw.maxValueBytes,
            `${registrationLabel}.maxValueBytes`,
          ),
          containsCoreReferences: false,
        };
      },
    );
    if (schemaVersion === PACKAGE_SCHEMA_VERSION_V2) {
      return { ...common, activation: "reactive" as const, producedContentSchemas };
    }
    if (!isReservedV10) {
      return { ...common, producedContentSchemas };
    }
    if (
      !Array.isArray(candidate.permissionPolicyReferences) ||
      candidate.permissionPolicyReferences.length > 64
    ) {
      throw new ExtensionInstallationError(
        "EXTENSION_PACKAGE_INVALID",
        `${label}.permissionPolicyReferences must contain at most 64 entries`,
      );
    }
    const references = candidate.permissionPolicyReferences.map(
      (raw, referenceIndex): ExtensionPackagePermissionPolicyReferenceV10 => {
        const referenceLabel = `${label}.permissionPolicyReferences[${referenceIndex}]`;
        exactKeys(raw, ["policyId", "revision"], referenceLabel);
        return {
          policyId: identifier(raw.policyId, `${referenceLabel}.policyId`),
          revision: (() => {
            if (typeof raw.revision !== "string" || !DIGEST_PATTERN.test(raw.revision)) {
              throw new ExtensionInstallationError(
                "EXTENSION_PACKAGE_INVALID",
                `${referenceLabel}.revision must be a canonical SHA-256 digest`,
              );
            }
            return raw.revision;
          })(),
        };
      },
    );
    for (let index = 1; index < references.length; index += 1) {
      const previous = references[index - 1]!;
      const current = references[index]!;
      const previousKey = `${previous.policyId}\u0000${previous.revision}`;
      const currentKey = `${current.policyId}\u0000${current.revision}`;
      if (previousKey >= currentKey) {
        throw new ExtensionInstallationError(
          "EXTENSION_PACKAGE_INVALID",
          `${label}.permissionPolicyReferences must be unique and canonically sorted`,
        );
      }
    }
    return { ...common, producedContentSchemas, permissionPolicyReferences: references };
  });

  if (!Array.isArray(value.requestedCapabilities)) {
    throw new ExtensionInstallationError(
      "EXTENSION_PACKAGE_INVALID",
      "requestedCapabilities must be an array",
    );
  }
  if (!isReservedV10 && value.requestedCapabilities.length !== 0) {
    throw new ExtensionInstallationError(
      "EXTENSION_PACKAGE_INVALID",
      "requestedCapabilities must be empty in package schema versions 1 through 4",
    );
  }
  if (isReservedV10 && value.requestedCapabilities.length > 256) {
    throw new ExtensionInstallationError(
      "EXTENSION_PACKAGE_INVALID",
      "requestedCapabilities must contain at most 256 entries",
    );
  }
  const requestedCapabilities: readonly ExtensionPackageCapabilityRequestV10[] =
    isReservedV10
      ? value.requestedCapabilities.map((raw, requestIndex) => {
          const label = `requestedCapabilities[${requestIndex}]`;
          exactKeys(
            raw,
            ["moduleKind", "capabilityType", "capabilityVersion", "policyId", "policyRevision"],
            label,
          );
          const capabilityType = raw.capabilityType;
          if (
            capabilityType !== "model-operation" &&
            capabilityType !== "tool-invocation" &&
            capabilityType !== "module-private-storage"
          ) {
            throw new ExtensionInstallationError(
              "EXTENSION_PACKAGE_INVALID",
              `${label}.capabilityType is not in the closed version-10 vocabulary`,
            );
          }
          const capabilityVersion = raw.capabilityVersion;
          const compatibleVersion =
            capabilityType === "model-operation"
              ? capabilityVersion === "v2" || capabilityVersion === "v3"
              : capabilityVersion === "v2";
          if (!compatibleVersion) {
            throw new ExtensionInstallationError(
              "EXTENSION_PACKAGE_INVALID",
              `${label}.capabilityVersion is incompatible with ${capabilityType}`,
            );
          }
          if (typeof raw.policyRevision !== "string" || !DIGEST_PATTERN.test(raw.policyRevision)) {
            throw new ExtensionInstallationError(
              "EXTENSION_PACKAGE_INVALID",
              `${label}.policyRevision must be a canonical SHA-256 digest`,
            );
          }
          return {
            moduleKind: identifier(raw.moduleKind, `${label}.moduleKind`),
            capabilityType,
            capabilityVersion,
            policyId: identifier(raw.policyId, `${label}.policyId`),
            policyRevision: raw.policyRevision,
          };
        })
      : [];
  if (isReservedV10) {
    for (let index = 1; index < requestedCapabilities.length; index += 1) {
      const previous = requestedCapabilities[index - 1]!;
      const current = requestedCapabilities[index]!;
      const previousKey = [
        previous.moduleKind,
        previous.capabilityType,
        previous.capabilityVersion,
        previous.policyId,
        previous.policyRevision,
      ].join("\u0000");
      const currentKey = [
        current.moduleKind,
        current.capabilityType,
        current.capabilityVersion,
        current.policyId,
        current.policyRevision,
      ].join("\u0000");
      if (previousKey >= currentKey) {
        throw new ExtensionInstallationError(
          "EXTENSION_PACKAGE_INVALID",
          "requestedCapabilities must be unique and canonically sorted",
        );
      }
    }
    const versionedModules = modules as readonly ExtensionPackageModuleV10[];
    const moduleByKind = new Map(versionedModules.map((module) => [module.moduleKind, module]));
    for (const capability of requestedCapabilities) {
      const module = moduleByKind.get(capability.moduleKind);
      if (module === undefined) {
        throw new ExtensionInstallationError(
          "EXTENSION_PACKAGE_INVALID",
          `requestedCapabilities references unknown Module ${capability.moduleKind}`,
        );
      }
      if (
        !module.permissionPolicyReferences.some(
          (reference) =>
            reference.policyId === capability.policyId &&
            reference.revision === capability.policyRevision,
        )
      ) {
        throw new ExtensionInstallationError(
          "EXTENSION_PACKAGE_INVALID",
          `requestedCapabilities references a missing policy ${capability.policyId}@${capability.policyRevision}`,
        );
      }
    }
    for (const module of versionedModules) {
      for (const reference of module.permissionPolicyReferences) {
        if (
          !requestedCapabilities.some(
            (capability) =>
              capability.moduleKind === module.moduleKind &&
              capability.policyId === reference.policyId &&
              capability.policyRevision === reference.revision,
          )
        ) {
          throw new ExtensionInstallationError(
            "EXTENSION_PACKAGE_INVALID",
            `Module ${module.moduleKind} contains a policy reference without a capability request`,
          );
        }
      }
    }
  }
  return deepFreeze({
    schemaVersion,
    extensionId,
    packageVersion: identifier(value.packageVersion, "packageVersion"),
    displayName: boundedText(value.displayName, "displayName", 256),
    description: boundedText(value.description, "description", 4_096),
    supportedProtocolVersions,
    entrypoint: entrypoint(value.entrypoint),
    modules,
    requestedCapabilities,
  }) as ExtensionPackageManifest;
}

/**
 * Verifies that one already-validated instance Module matches one static
 * manifest declaration. This is a structural compatibility check: a caller
 * still needs a resolved installation to prove the manifest's provenance and
 * executable bytes. It never executes Extension code or starts a process.
 */
export function assertExtensionModuleCompatibility(
  manifest: ExtensionPackageManifest,
  expected: ExtensionModuleCompatibility,
): void {
  if (
    manifest.extensionId !== expected.extensionId ||
    manifest.packageVersion !== expected.packageVersion
  ) {
    throw new TypeError(
      `Extension package identity does not match Module ${expected.moduleKind}`,
    );
  }
  const module = manifest.modules.find((candidate) =>
    candidate.moduleKind === expected.moduleKind
  );
  if (!module) {
    throw new TypeError(
      `Extension package does not declare Module kind ${expected.moduleKind}`,
    );
  }
  if (module.configVersion !== expected.configVersion) {
    throw new TypeError(
      `Extension Module ${expected.moduleKind} does not support configuration version ${expected.configVersion}`,
    );
  }
  if (module.activation !== expected.activation) {
    throw new TypeError(
      `Extension Module ${expected.moduleKind} does not support ${expected.activation} activation`,
    );
  }
}

function parseManifest(bytes: Uint8Array, limits: InstallationLimits): ExtensionPackageManifest {
  try {
    return validateManifest(parseStrictJsonBytes(bytes, {
      maxBytes: limits.maxManifestBytes,
      maxDepth: limits.maxManifestDepth,
    }));
  } catch (error) {
    if (error instanceof ExtensionInstallationError) throw error;
    throw new ExtensionInstallationError(
      "EXTENSION_PACKAGE_INVALID",
      "Extension package manifest is invalid",
      { cause: error },
    );
  }
}

function packageDigest(manifest: ExtensionPackageManifest, files: readonly InstalledFile[]): string {
  const digestDocument: JsonValue = {
    manifest: cloneJson(manifest),
    files: files.map((file) => ({
      path: file.path,
      digest: file.digest,
    })),
  };
  return canonicalJsonDigest(digestDocument);
}

function identityPathComponent(extensionId: string, packageVersion: string): string {
  return createHash("sha256")
    .update(canonicalizeJson([extensionId, packageVersion]), "utf8")
    .digest("hex");
}

function isWithin(parent: string, candidate: string): boolean {
  const parentValue = process.platform === "win32" ? parent.toLowerCase() : parent;
  const candidateValue = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const difference = relative(parentValue, candidateValue);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

function sameFiles(left: readonly InstalledFile[], right: readonly InstalledFile[]): boolean {
  return canonicalizeJson(left as unknown as JsonValue) ===
    canonicalizeJson(right as unknown as JsonValue);
}

/** Owns copied Extension packages and identity records under one private directory. */
export class ExtensionInstallationRegistry {
  readonly #directory: string;
  readonly #packagesDirectory: string;
  readonly #recordsDirectory: string;
  readonly #locksDirectory: string;
  readonly #limits: InstallationLimits;

  constructor(options: ExtensionInstallationRegistryOptions) {
    if (
      !isPlainObject(options) ||
      typeof options.directory !== "string" ||
      options.directory.length === 0 ||
      options.directory.includes("\0")
    ) {
      throw new TypeError("Extension installation registry directory is invalid");
    }
    this.#limits = validateLimits(options);
    const absolute = resolve(options.directory);
    if (absolute === parse(absolute).root) {
      throw new TypeError("Extension installation registry cannot be a filesystem root");
    }
    try {
      if (pathEntryExists(absolute)) {
        const metadata = lstatSync(absolute);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new ExtensionInstallationError(
            "EXTENSION_INSTALLATION_IO_FAILED",
            "Extension installation registry must be a real directory",
          );
        }
      } else {
        mkdirSync(absolute, { recursive: true, mode: 0o700 });
      }
      this.#directory = realpathSync.native(absolute);
      this.#setDirectoryPermissions(this.#directory);
      this.#packagesDirectory = this.#managedDirectory("packages");
      this.#recordsDirectory = this.#managedDirectory("records");
      this.#locksDirectory = this.#managedDirectory("locks");
    } catch (error) {
      if (error instanceof ExtensionInstallationError) throw error;
      throw new ExtensionInstallationError(
        "EXTENSION_INSTALLATION_IO_FAILED",
        "Could not prepare the Extension installation registry",
        { cause: error },
      );
    }
  }

  installNodePackage(input: InstallNodeExtensionPackageOptions): ResolvedExtensionInstallation {
    if (
      !isPlainObject(input) ||
      Object.keys(input).some((key) => key !== "sourceDirectory" && key !== "trust") ||
      typeof input.sourceDirectory !== "string" ||
      input.sourceDirectory.length === 0 ||
      input.sourceDirectory.includes("\0") ||
      (input.trust !== "trusted" && input.trust !== "untrusted")
    ) {
      throw new ExtensionInstallationError(
        "EXTENSION_PACKAGE_INVALID",
        "Node package installation input is invalid",
      );
    }
    const sourceDirectory = this.#sourceDirectory(input.sourceDirectory);
    let initialManifestBytes: Buffer;
    try {
      initialManifestBytes = this.#readRegularFile(
        join(sourceDirectory, PACKAGE_MANIFEST_FILE),
        sourceDirectory,
        this.#limits.maxManifestBytes,
        "source",
      );
    } catch (error) {
      if (error instanceof ExtensionInstallationError) throw error;
      throw new ExtensionInstallationError(
        "EXTENSION_PACKAGE_PATH_INVALID",
        "Package manifest must be a readable ordinary file at the package root",
        { cause: error },
      );
    }
    const initialManifest = parseManifest(initialManifestBytes, this.#limits);
    return this.#withIdentityLock(
      initialManifest.extensionId,
      initialManifest.packageVersion,
      () => this.#installLocked(sourceDirectory, input.trust, initialManifest),
    );
  }

  resolve(input: ResolveExtensionInstallationOptions): ResolvedExtensionInstallation {
    if (
      !isPlainObject(input) ||
      Object.keys(input).some((key) => key !== "extensionId" && key !== "packageVersion")
    ) {
      throw new ExtensionInstallationError(
        "EXTENSION_PACKAGE_INVALID",
        "Extension resolution input is invalid",
      );
    }
    const extensionId = identifier(input.extensionId, "extensionId");
    const packageVersion = identifier(input.packageVersion, "packageVersion");
    return this.#withIdentityLock(
      extensionId,
      packageVersion,
      () => this.#resolveLocked(extensionId, packageVersion),
    );
  }

  #installLocked(
    sourceDirectory: string,
    trust: ExtensionTrust,
    initialManifest: ExtensionPackageManifest,
  ): ResolvedExtensionInstallation {
    let temporaryDirectory: string | undefined = join(
      this.#packagesDirectory,
      `.install-${randomUUID()}.tmp`,
    );
    try {
      mkdirSync(temporaryDirectory, { mode: 0o700 });
      this.#setDirectoryPermissions(temporaryDirectory);
      const scanned = this.#scanPackage(sourceDirectory, temporaryDirectory, "source");
      if (canonicalizeJson(scanned.manifest) !== canonicalizeJson(initialManifest)) {
        throw new ExtensionInstallationError(
          "EXTENSION_PACKAGE_INVALID",
          "Extension package manifest changed during installation",
        );
      }
      const copied = this.#scanPackage(temporaryDirectory, undefined, "managed");
      if (
        copied.packageDigest !== scanned.packageDigest ||
        !sameFiles(copied.files, scanned.files)
      ) {
        throw new ExtensionInstallationError(
          "EXTENSION_INSTALLATION_TAMPERED",
          "Copied package does not match the verified source bytes",
        );
      }

      const existing = this.#readRecord(
        initialManifest.extensionId,
        initialManifest.packageVersion,
        false,
      );
      if (existing) {
        if (existing.packageDigest !== scanned.packageDigest || existing.trust !== trust) {
          throw new ExtensionInstallationError(
            "EXTENSION_INSTALLATION_CONFLICT",
            "Extension identity is already installed with different content or trust",
          );
        }
        return this.#resolveLocked(initialManifest.extensionId, initialManifest.packageVersion);
      }

      const record: ExtensionInstallationRecord = {
        schemaVersion: INSTALLATION_RECORD_SCHEMA_VERSION,
        extensionId: scanned.manifest.extensionId,
        packageVersion: scanned.manifest.packageVersion,
        trust,
        packageDigest: scanned.packageDigest,
        files: scanned.files.map((file) => ({ ...file })),
      };
      const recordText = this.#serializeRecord(record);

      const targetDirectory = join(
        this.#packagesDirectory,
        digestPathComponent(scanned.packageDigest),
      );
      if (pathEntryExists(targetDirectory)) {
        const installed = this.#scanPackage(targetDirectory, undefined, "managed");
        if (
          installed.packageDigest !== scanned.packageDigest ||
          !sameFiles(installed.files, scanned.files)
        ) {
          throw new ExtensionInstallationError(
            "EXTENSION_INSTALLATION_TAMPERED",
            "Managed package directory does not match its digest",
          );
        }
      } else {
        renameSync(temporaryDirectory, targetDirectory);
        temporaryDirectory = undefined;
        this.#syncDirectory(this.#packagesDirectory);
      }

      this.#writeRecord(record, recordText);
      return this.#resolveLocked(initialManifest.extensionId, initialManifest.packageVersion);
    } catch (error) {
      if (error instanceof ExtensionInstallationError) throw error;
      throw new ExtensionInstallationError(
        "EXTENSION_INSTALLATION_IO_FAILED",
        "Extension package installation failed",
        { cause: error },
      );
    } finally {
      if (temporaryDirectory !== undefined && pathEntryExists(temporaryDirectory)) {
        this.#removeOwnTemporaryDirectory(temporaryDirectory);
      }
    }
  }

  #resolveLocked(extensionId: string, packageVersion: string): ResolvedExtensionInstallation {
    const record = this.#readRecord(extensionId, packageVersion, true)!;
    if (record.extensionId !== extensionId || record.packageVersion !== packageVersion) {
      throw new ExtensionInstallationError(
        "EXTENSION_INSTALLATION_TAMPERED",
        "Installation record identity does not match its lookup identity",
      );
    }
    const packageDirectory = join(
      this.#packagesDirectory,
      digestPathComponent(record.packageDigest),
    );
    const scanned = this.#scanPackage(packageDirectory, undefined, "managed");
    if (
      scanned.packageDigest !== record.packageDigest ||
      scanned.manifest.extensionId !== record.extensionId ||
      scanned.manifest.packageVersion !== record.packageVersion ||
      !sameFiles(scanned.files, record.files)
    ) {
      throw new ExtensionInstallationError(
        "EXTENSION_INSTALLATION_TAMPERED",
        "Managed package does not match its installation record",
      );
    }
    let workingDirectory: string;
    let entrypointPath: string;
    try {
      const packageMetadata = lstatSync(packageDirectory);
      workingDirectory = realpathSync.native(packageDirectory);
      if (
        packageMetadata.isSymbolicLink() ||
        !packageMetadata.isDirectory() ||
        !isWithin(this.#packagesDirectory, workingDirectory) ||
        (process.platform !== "win32" && (packageMetadata.mode & 0o077) !== 0)
      ) {
        throw new Error("Managed package directory is unsafe");
      }
      const configuredEntrypointPath = join(
        workingDirectory,
        ...scanned.manifest.entrypoint.split("/"),
      );
      const entrypointMetadata = lstatSync(configuredEntrypointPath);
      entrypointPath = realpathSync.native(configuredEntrypointPath);
      if (
        entrypointMetadata.isSymbolicLink() ||
        !entrypointMetadata.isFile() ||
        !isWithin(workingDirectory, entrypointPath) ||
        (process.platform !== "win32" && (entrypointMetadata.mode & 0o077) !== 0)
      ) {
        throw new Error("Managed entrypoint is unsafe");
      }
    } catch (error) {
      if (
        error instanceof ExtensionInstallationError &&
        error.code === "EXTENSION_INSTALLATION_TAMPERED"
      ) {
        throw error;
      }
      throw new ExtensionInstallationError(
        "EXTENSION_INSTALLATION_TAMPERED",
        "Managed entrypoint is not an ordinary private file inside its package",
        { cause: error },
      );
    }
    return deepFreeze({
      manifest: cloneJson(scanned.manifest),
      trust: record.trust,
      packageDigest: record.packageDigest,
      workingDirectory,
      entrypointPath,
      packageSnapshot: scanned.packageSnapshot,
    }) as ResolvedExtensionInstallation;
  }

  #sourceDirectory(input: string): string {
    const absolute = resolve(input);
    try {
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new ExtensionInstallationError(
          "EXTENSION_PACKAGE_PATH_INVALID",
          "Extension package source must be a real directory",
        );
      }
      const canonical = realpathSync.native(absolute);
      if (isWithin(this.#directory, canonical) || isWithin(canonical, this.#directory)) {
        throw new ExtensionInstallationError(
          "EXTENSION_PACKAGE_PATH_INVALID",
          "Extension package source and installation registry must not overlap",
        );
      }
      return canonical;
    } catch (error) {
      if (error instanceof ExtensionInstallationError) throw error;
      throw new ExtensionInstallationError(
        "EXTENSION_PACKAGE_PATH_INVALID",
        "Could not resolve the Extension package source directory",
        { cause: error },
      );
    }
  }

  #scanPackage(
    rootDirectory: string,
    destinationDirectory: string | undefined,
    location: PackageLocation,
  ): ScannedPackage {
    try {
      const rootMetadata = lstatSync(rootDirectory);
      if (
        rootMetadata.isSymbolicLink() ||
        !rootMetadata.isDirectory() ||
        (location === "managed" &&
          process.platform !== "win32" &&
          (rootMetadata.mode & 0o077) !== 0)
      ) {
        return this.#invalidPackageLocation(location, "Package root is not a real directory");
      }
      const canonicalRoot = realpathSync.native(rootDirectory);
      if (location === "managed" && !isWithin(this.#packagesDirectory, canonicalRoot)) {
        return this.#invalidPackageLocation(
          location,
          "Managed package resolves outside the installation registry",
        );
      }
      const files: InstalledFile[] = [];
      const snapshotFiles: ExtensionPackageSnapshotSourceFile[] = [];
      const casePaths = new Map<string, string>();
      const pending: Array<{
        readonly source: string;
        readonly destination: string | undefined;
        readonly prefix: string;
      }> = [{
        source: canonicalRoot,
        destination: destinationDirectory,
        prefix: "",
      }];
      let directoryCount = 0;
      let totalBytes = 0;
      let manifestBytes: Buffer | undefined;

      while (pending.length > 0) {
        const current = pending.pop()!;
        const entries = readdirSync(current.source, { withFileTypes: true })
          .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
        for (const entry of entries) {
          const relativePath = current.prefix === ""
            ? entry.name
            : `${current.prefix}/${entry.name}`;
          if (!isRelativePosixPath(relativePath)) {
            return this.#invalidPackageLocation(location, "Package contains an invalid path");
          }
          const caseKey = normalizedCaseKey(relativePath);
          const previous = casePaths.get(caseKey);
          if (previous !== undefined && previous !== relativePath) {
            return this.#invalidPackageLocation(
              location,
              "Package contains paths that collide after case folding",
            );
          }
          casePaths.set(caseKey, relativePath);

          const sourcePath = join(current.source, entry.name);
          const metadata = lstatSync(sourcePath);
          if (metadata.isSymbolicLink()) {
            return this.#invalidPackageLocation(
              location,
              "Package symbolic links and reparse points are forbidden",
            );
          }
          const canonicalPath = realpathSync.native(sourcePath);
          if (!isWithin(canonicalRoot, canonicalPath)) {
            return this.#invalidPackageLocation(location, "Package path escapes its root");
          }
          const destinationPath = current.destination === undefined
            ? undefined
            : join(current.destination, entry.name);

          if (metadata.isDirectory()) {
            if (
              location === "managed" &&
              process.platform !== "win32" &&
              (metadata.mode & 0o077) !== 0
            ) {
              return this.#invalidPackageLocation(
                location,
                "Managed package directory permissions are not owner-only",
              );
            }
            directoryCount += 1;
            if (directoryCount > this.#limits.maxFileCount) {
              return this.#packageLimit(location, "Package has too many directories");
            }
            if (destinationPath !== undefined) {
              mkdirSync(destinationPath, { mode: 0o700 });
              this.#setDirectoryPermissions(destinationPath);
            }
            pending.push({
              source: canonicalPath,
              destination: destinationPath,
              prefix: relativePath,
            });
            continue;
          }
          if (!metadata.isFile()) {
            return this.#invalidPackageLocation(
              location,
              "Package may contain only ordinary files and directories",
            );
          }
          if (files.length >= this.#limits.maxFileCount) {
            return this.#packageLimit(location, "Package has too many files");
          }
          const bytes = this.#readRegularFile(
            canonicalPath,
            canonicalRoot,
            this.#limits.maxFileBytes,
            location,
          );
          totalBytes += bytes.byteLength;
          if (!Number.isSafeInteger(totalBytes) || totalBytes > this.#limits.maxPackageBytes) {
            return this.#packageLimit(location, "Package exceeds its total byte limit");
          }
          if (destinationPath !== undefined) this.#writeCopiedFile(destinationPath, bytes);
          const file: InstalledFile = {
            path: relativePath,
            digest: digestBytes(bytes),
            byteLength: bytes.byteLength,
          };
          files.push(file);
          snapshotFiles.push({ path: relativePath, bytes: Buffer.from(bytes) });
          if (relativePath === PACKAGE_MANIFEST_FILE) manifestBytes = bytes;
        }
      }

      if (manifestBytes === undefined) {
        return this.#invalidPackageLocation(location, "Package manifest is missing");
      }
      files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
      let manifest: ExtensionPackageManifest;
      try {
        manifest = parseManifest(manifestBytes, this.#limits);
      } catch (error) {
        if (location === "managed") {
          throw new ExtensionInstallationError(
            "EXTENSION_INSTALLATION_TAMPERED",
            "Managed package manifest is invalid",
            { cause: error },
          );
        }
        throw error;
      }
      if (!files.some((file) => file.path === manifest.entrypoint)) {
        return this.#invalidPackageLocation(
          location,
          "Package entrypoint is not an ordinary copied file",
        );
      }
      return {
        manifest,
        files: deepFreeze(files.map((file) => ({ ...file }))) as readonly InstalledFile[],
        packageDigest: packageDigest(manifest, files),
        packageSnapshot: createExtensionPackageSnapshot(snapshotFiles),
      };
    } catch (error) {
      if (error instanceof ExtensionInstallationError) throw error;
      if (location === "managed") {
        throw new ExtensionInstallationError(
          "EXTENSION_INSTALLATION_TAMPERED",
          "Could not verify the managed Extension package",
          { cause: error },
        );
      }
      throw new ExtensionInstallationError(
        "EXTENSION_INSTALLATION_IO_FAILED",
        "Could not read the Extension package source",
        { cause: error },
      );
    }
  }

  #readRegularFile(
    path: string,
    rootDirectory: string,
    maxBytes: number,
    location: PackageLocation,
  ): Buffer {
    let descriptor: number | undefined;
    try {
      const noFollow = (constants as Readonly<Record<string, number>>).O_NOFOLLOW ?? 0;
      descriptor = openSync(path, constants.O_RDONLY | noFollow);
      const before = fstatSync(descriptor);
      if (!before.isFile()) {
        return this.#invalidPackageLocation(location, "Package file is not an ordinary file");
      }
      if (before.size > maxBytes) return this.#packageLimit(location, "Package file is too large");
      const chunks: Buffer[] = [];
      let byteLength = 0;
      while (true) {
        const remaining = maxBytes - byteLength;
        if (remaining < 0) return this.#packageLimit(location, "Package file is too large");
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining + 1));
        const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) break;
        byteLength += bytesRead;
        if (byteLength > maxBytes) {
          return this.#packageLimit(location, "Package file is too large");
        }
        chunks.push(buffer.subarray(0, bytesRead));
      }
      const bytes = Buffer.concat(chunks, byteLength);
      const after = fstatSync(descriptor);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        bytes.byteLength !== after.size
      ) {
        return this.#invalidPackageLocation(location, "Package file changed while being read");
      }
      const pathMetadata = lstatSync(path);
      const canonicalPath = realpathSync.native(path);
      if (
        pathMetadata.isSymbolicLink() ||
        !pathMetadata.isFile() ||
        before.dev !== pathMetadata.dev ||
        before.ino !== pathMetadata.ino ||
        before.size !== pathMetadata.size ||
        (location === "managed" &&
          process.platform !== "win32" &&
          (pathMetadata.mode & 0o077) !== 0) ||
        !isWithin(rootDirectory, canonicalPath)
      ) {
        return this.#invalidPackageLocation(location, "Package file path is unsafe");
      }
      return bytes;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  #writeCopiedFile(path: string, bytes: Uint8Array): void {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, "wx", 0o600);
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      this.#setFilePermissions(path);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  #readRecord(
    extensionId: string,
    packageVersion: string,
    required: boolean,
  ): ExtensionInstallationRecord | null {
    const path = this.#recordPath(extensionId, packageVersion);
    if (!pathEntryExists(path)) {
      if (!required) return null;
      throw new ExtensionInstallationError(
        "EXTENSION_INSTALLATION_NOT_FOUND",
        "Extension package is not installed",
      );
    }
    try {
      const recordBytes = this.#readRegularFile(
        path,
        this.#recordsDirectory,
        this.#limits.maxRecordBytes,
        "managed",
      );
      const value = parseStrictJsonBytes(recordBytes, {
        maxBytes: this.#limits.maxRecordBytes,
        maxDepth: 16,
      });
      exactKeys(
        value,
        ["schemaVersion", "extensionId", "packageVersion", "trust", "packageDigest", "files"],
        "Extension installation record",
      );
      if (
        value.schemaVersion !== INSTALLATION_RECORD_SCHEMA_VERSION ||
        (value.trust !== "trusted" && value.trust !== "untrusted") ||
        typeof value.packageDigest !== "string" ||
        !DIGEST_PATTERN.test(value.packageDigest) ||
        !Array.isArray(value.files) ||
        value.files.length === 0 ||
        value.files.length > this.#limits.maxFileCount
      ) {
        throw new Error("Installation record has invalid fields");
      }
      const files: InstalledFile[] = [];
      const casePaths = new Map<string, string>();
      let previousPath: string | undefined;
      for (const [index, candidate] of value.files.entries()) {
        exactKeys(candidate, ["path", "digest", "byteLength"], `files[${index}]`);
        if (
          !isRelativePosixPath(candidate.path) ||
          typeof candidate.digest !== "string" ||
          !DIGEST_PATTERN.test(candidate.digest) ||
          !Number.isSafeInteger(candidate.byteLength) ||
          (candidate.byteLength as number) < 0 ||
          (candidate.byteLength as number) > this.#limits.maxFileBytes ||
          (previousPath !== undefined && previousPath >= candidate.path)
        ) {
          throw new Error("Installation file record is invalid");
        }
        const caseKey = normalizedCaseKey(candidate.path);
        if (casePaths.has(caseKey)) throw new Error("Installation paths collide by case");
        casePaths.set(caseKey, candidate.path);
        previousPath = candidate.path;
        files.push({
          path: candidate.path,
          digest: candidate.digest,
          byteLength: candidate.byteLength as number,
        });
      }
      const recordExtensionId = identifier(value.extensionId, "record.extensionId");
      const recordPackageVersion = identifier(value.packageVersion, "record.packageVersion");
      if (recordExtensionId !== extensionId || recordPackageVersion !== packageVersion) {
        throw new Error("Installation record identity does not match its lookup identity");
      }
      return deepFreeze({
        schemaVersion: INSTALLATION_RECORD_SCHEMA_VERSION,
        extensionId: recordExtensionId,
        packageVersion: recordPackageVersion,
        trust: value.trust,
        packageDigest: value.packageDigest,
        files,
      }) as ExtensionInstallationRecord;
    } catch (error) {
      if (
        error instanceof ExtensionInstallationError &&
        error.code === "EXTENSION_INSTALLATION_NOT_FOUND"
      ) {
        throw error;
      }
      throw new ExtensionInstallationError(
        "EXTENSION_INSTALLATION_TAMPERED",
        "Extension installation record is invalid",
        { cause: error },
      );
    }
  }

  #serializeRecord(record: ExtensionInstallationRecord): string {
    const text = `${JSON.stringify(record, null, 2)}\n`;
    if (Buffer.byteLength(text, "utf8") > this.#limits.maxRecordBytes) {
      throw new ExtensionInstallationError(
        "EXTENSION_PACKAGE_LIMIT_EXCEEDED",
        "Extension package file metadata exceeds its installation record limit",
      );
    }
    return text;
  }

  #writeRecord(record: ExtensionInstallationRecord, recordText: string): void {
    const path = this.#recordPath(record.extensionId, record.packageVersion);
    if (pathEntryExists(path)) {
      throw new ExtensionInstallationError(
        "EXTENSION_INSTALLATION_CONFLICT",
        "Extension installation record already exists",
      );
    }
    const temporaryPath = join(
      this.#recordsDirectory,
      `.${identityPathComponent(record.extensionId, record.packageVersion)}.${randomUUID()}.tmp`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, recordText, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      this.#setFilePermissions(temporaryPath);
      if (pathEntryExists(path)) {
        throw new ExtensionInstallationError(
          "EXTENSION_INSTALLATION_CONFLICT",
          "Extension installation record appeared during installation",
        );
      }
      renameSync(temporaryPath, path);
      this.#syncDirectory(this.#recordsDirectory);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (pathEntryExists(temporaryPath)) unlinkSync(temporaryPath);
    }
  }

  #recordPath(extensionId: string, packageVersion: string): string {
    return join(
      this.#recordsDirectory,
      `${identityPathComponent(extensionId, packageVersion)}.json`,
    );
  }

  #withIdentityLock<Result>(
    extensionId: string,
    packageVersion: string,
    operation: () => Result,
  ): Result {
    const identityDigest = identityPathComponent(extensionId, packageVersion);
    try {
      return withSynchronousCrossProcessLock(
        { resourceId: join(this.#locksDirectory, `${identityDigest}.lock`) },
        operation,
      );
    } catch (error) {
      if (!(error instanceof SynchronousCrossProcessLockError)) throw error;
      if (error.code === "CROSS_PROCESS_LOCK_HELD") {
        throw new ExtensionInstallationError(
          "EXTENSION_INSTALLATION_LOCKED",
          "Another process is changing this Extension installation",
        );
      }
      throw new ExtensionInstallationError(
        "EXTENSION_INSTALLATION_IO_FAILED",
        "Could not acquire the Extension installation lock",
        { cause: error },
      );
    }
  }

  #managedDirectory(name: "packages" | "records" | "locks"): string {
    const path = join(this.#directory, name);
    if (pathEntryExists(path)) {
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new ExtensionInstallationError(
          "EXTENSION_INSTALLATION_IO_FAILED",
          `Managed ${name} path is not a real directory`,
        );
      }
    } else {
      mkdirSync(path, { mode: 0o700 });
    }
    const canonical = realpathSync.native(path);
    if (!isWithin(this.#directory, canonical)) {
      throw new ExtensionInstallationError(
        "EXTENSION_INSTALLATION_IO_FAILED",
        `Managed ${name} path escapes the installation registry`,
      );
    }
    this.#setDirectoryPermissions(canonical);
    return canonical;
  }

  #setDirectoryPermissions(path: string): void {
    chmodSync(path, 0o700);
  }

  #setFilePermissions(path: string): void {
    chmodSync(path, 0o600);
  }

  #syncDirectory(path: string): void {
    if (process.platform === "win32") return;
    const descriptor = openSync(path, constants.O_RDONLY);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  #removeOwnTemporaryDirectory(path: string): void {
    const name = basename(path);
    if (
      dirname(path) !== this.#packagesDirectory ||
      !/^\.install-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u
        .test(name)
    ) {
      throw new ExtensionInstallationError(
        "EXTENSION_INSTALLATION_IO_FAILED",
        "Refused to clean an unrecognized temporary directory",
      );
    }
    rmSync(path, { recursive: true, force: true });
  }

  #invalidPackageLocation(location: PackageLocation, message: string): never {
    throw new ExtensionInstallationError(
      location === "managed"
        ? "EXTENSION_INSTALLATION_TAMPERED"
        : "EXTENSION_PACKAGE_PATH_INVALID",
      message,
    );
  }

  #packageLimit(location: PackageLocation, message: string): never {
    throw new ExtensionInstallationError(
      location === "managed"
        ? "EXTENSION_INSTALLATION_TAMPERED"
        : "EXTENSION_PACKAGE_LIMIT_EXCEEDED",
      message,
    );
  }
}
