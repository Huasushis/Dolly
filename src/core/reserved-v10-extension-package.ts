import {
  canonicalJsonDigest,
  canonicalizeJson,
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import {
  assertInstalledComponentOrigin,
  InstalledComponentOriginRegistry,
  type VerifiedInstalledComponentOrigin,
} from "./installed-component-origin.js";
import {
  ExtensionInstallationError,
  ExtensionInstallationRegistry,
  type ExtensionPackageManifestV10,
  type ExtensionPackagePermissionPolicyReferenceV10,
} from "./extension-installation-registry.js";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PACKAGE_SCHEMA_VERSION = "dolly.extension-package/10" as const;
const INSTALLED_MANIFEST_SCHEMA_VERSION = "dolly.installed-extension-package/10" as const;
const POLICY_PREMISE_SCHEMA_VERSION = "dolly.extension-package-policy-premise/1" as const;

type PackagePolicyDefinition = Readonly<{
  policyId: string;
  revision: string;
  definition: JsonValue;
}>;

/** Exact policy-definition bytes selected for one package revision. */
export interface ReservedV10ExtensionPackagePolicyDefinition extends PackagePolicyDefinition {}

/** Versioned, canonical policy premise consumed by later package consumers. */
export interface ReservedV10ExtensionPackagePolicyPremise
  extends Readonly<Record<string, JsonValue>> {
  readonly schemaVersion: typeof POLICY_PREMISE_SCHEMA_VERSION;
  readonly packageDigest: string;
  readonly packageBytesDigest: string;
  readonly definitions: readonly ReservedV10ExtensionPackagePolicyDefinition[];
}

/**
 * Host-produced package provenance. The source manifest is nested under the
 * verified package identity; policy definitions are a separate versioned
 * premise so a runtime verifier cannot mint or replace either authority.
 */
export interface ReservedV10InstalledExtensionPackageManifest
  extends Readonly<Record<string, JsonValue>> {
  readonly schemaVersion: typeof INSTALLED_MANIFEST_SCHEMA_VERSION;
  readonly extensionId: string;
  readonly packageVersion: string;
  readonly packageDigest: string;
  readonly packageBytesDigest: string;
  readonly origin: VerifiedInstalledComponentOrigin;
  readonly packageManifest: ExtensionPackageManifestV10;
  readonly packageManifestDigest: string;
  readonly policyPremise: ReservedV10ExtensionPackagePolicyPremise;
  readonly policyPremiseDigest: string;
  readonly provenanceDigest: string;
}

export interface ProduceReservedV10ExtensionPackageManifestOptions {
  readonly installations: ExtensionInstallationRegistry;
  readonly origins: InstalledComponentOriginRegistry;
  readonly extensionId: string;
  readonly packageVersion: string;
  readonly policyDefinitions: readonly ReservedV10ExtensionPackagePolicyDefinition[];
}

export interface VerifyReservedV10ExtensionPackageManifestOptions {
  readonly installations: ExtensionInstallationRegistry;
  readonly origins: InstalledComponentOriginRegistry;
  readonly policyDefinitions: readonly ReservedV10ExtensionPackagePolicyDefinition[];
}

const RESERVED_V10_PACKAGE_MANIFESTS = new WeakSet<object>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(message: string, cause?: unknown): ExtensionInstallationError {
  return new ExtensionInstallationError(
    "EXTENSION_PACKAGE_INVALID",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function tampered(message: string, cause?: unknown): ExtensionInstallationError {
  return new ExtensionInstallationError(
    "EXTENSION_INSTALLATION_TAMPERED",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function assertLinux(): void {
  if (process.platform !== "linux") {
    throw invalid("Reserved version-10 package provenance is unsupported on this platform");
  }
}

function exactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw invalid(`${label} must be a plain object`);
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !expected.has(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw invalid(`${label} has an unknown or missing field`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw invalid(`${label} is not a restricted package identifier`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw invalid(`${label} must be a canonical SHA-256 digest`);
  }
  return value;
}

function referenceKey(reference: Pick<ExtensionPackagePermissionPolicyReferenceV10, "policyId" | "revision">): string {
  return `${reference.policyId}\u0000${reference.revision}`;
}

function validatePolicyDefinitions(
  supplied: readonly ReservedV10ExtensionPackagePolicyDefinition[],
): readonly ReservedV10ExtensionPackagePolicyDefinition[] {
  if (!Array.isArray(supplied) || supplied.length > 256) {
    throw invalid("Reserved version-10 package policy definitions must contain at most 256 entries");
  }
  const definitions = supplied.map((raw, index) => {
    const label = `policyDefinitions[${index}]`;
    exactKeys(raw, ["policyId", "revision", "definition"], label);
    const policyId = identifier(raw.policyId, `${label}.policyId`);
    const revision = digest(raw.revision, `${label}.revision`);
    if (!isPlainObject(raw.definition)) {
      throw invalid(`${label}.definition must be a policy object`);
    }
    const definition = cloneJson(raw.definition as JsonValue);
    if (canonicalJsonDigest(definition) !== revision) {
      throw invalid(`${label}.revision does not match its exact canonical definition`);
    }
    const definitionPolicyId = Reflect.get(definition, "policyId");
    const definitionPolicyIdSnake = Reflect.get(definition, "policy_id");
    if (
      (definitionPolicyId !== undefined && definitionPolicyId !== policyId) ||
      (definitionPolicyIdSnake !== undefined && definitionPolicyIdSnake !== policyId)
    ) {
      throw invalid(`${label}.definition policy identity does not match policyId`);
    }
    return { policyId, revision, definition };
  });
  const seen = new Set<string>();
  let previous: string | undefined;
  for (const definition of definitions) {
    const key = referenceKey(definition);
    if (seen.has(key) || (previous !== undefined && previous >= key)) {
      throw invalid("Reserved version-10 package policy definitions must be unique and canonically sorted");
    }
    seen.add(key);
    previous = key;
  }
  return deepFreeze(definitions) as readonly ReservedV10ExtensionPackagePolicyDefinition[];
}

function expectedPolicyReferences(
  manifest: ExtensionPackageManifestV10,
): readonly ExtensionPackagePermissionPolicyReferenceV10[] {
  const references: ExtensionPackagePermissionPolicyReferenceV10[] = [];
  for (const module of manifest.modules) {
    for (const reference of module.permissionPolicyReferences) references.push(reference);
  }
  return references;
}

function assertPolicyCoverage(
  manifest: ExtensionPackageManifestV10,
  definitions: readonly ReservedV10ExtensionPackagePolicyDefinition[],
): void {
  const references = expectedPolicyReferences(manifest);
  const expectedKeys = new Set(references.map(referenceKey));
  const suppliedKeys = new Set(definitions.map(referenceKey));
  if (expectedKeys.size !== suppliedKeys.size) {
    throw invalid("Reserved version-10 package policy definitions do not exactly cover manifest references");
  }
  for (const key of expectedKeys) {
    if (!suppliedKeys.has(key)) {
      throw invalid("Reserved version-10 package policy definition is missing");
    }
  }
  for (const definition of definitions) {
    if (!expectedKeys.has(referenceKey(definition))) {
      throw invalid("Reserved version-10 package contains an extra policy definition");
    }
  }
}
function assertPolicyCompatibility(
  manifest: ExtensionPackageManifestV10,
  definitions: readonly ReservedV10ExtensionPackagePolicyDefinition[],
): void {
  const byReference = new Map(definitions.map((definition) => [referenceKey(definition), definition]));
  for (const capability of manifest.requestedCapabilities) {
    const definition = byReference.get(`${capability.policyId}\u0000${capability.policyRevision}`);
    if (definition === undefined) {
      throw invalid("Reserved version-10 capability request has no exact policy definition");
    }
    const kind = Reflect.get(definition.definition, "kind");
    const expectedKind =
      capability.capabilityType === "model-operation"
        ? "strict-streaming-chat"
        : capability.capabilityType === "tool-invocation"
          ? "registered-tools"
          : "module-private-storage";
    if (kind !== expectedKind) {
      throw invalid(
        `Reserved version-10 capability ${capability.capabilityType} is incompatible with policy ${capability.policyId}`,
      );
    }
  }
}

function assertManifestIdentity(
  manifest: ReservedV10InstalledExtensionPackageManifest,
): void {
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "extensionId",
      "packageVersion",
      "packageDigest",
      "packageBytesDigest",
      "origin",
      "packageManifest",
      "packageManifestDigest",
      "policyPremise",
      "policyPremiseDigest",
      "provenanceDigest",
    ],
    "Reserved version-10 installed package manifest",
  );
  if (manifest.schemaVersion !== INSTALLED_MANIFEST_SCHEMA_VERSION) {
    throw tampered("Reserved version-10 installed package manifest schema is unsupported");
  }
  identifier(manifest.extensionId, "installed package extensionId");
  identifier(manifest.packageVersion, "installed package packageVersion");
  if (
    manifest.packageManifest.extensionId !== manifest.extensionId ||
    manifest.packageManifest.packageVersion !== manifest.packageVersion
  ) {
    throw tampered("Reserved version-10 package manifest identity does not match its installed identity");
  }
  digest(manifest.packageDigest, "installed package packageDigest");
  digest(manifest.packageBytesDigest, "installed package packageBytesDigest");
  digest(manifest.packageManifestDigest, "installed package packageManifestDigest");
  digest(manifest.policyPremiseDigest, "installed package policyPremiseDigest");
  digest(manifest.provenanceDigest, "installed package provenanceDigest");
  if (manifest.packageManifest.schemaVersion !== PACKAGE_SCHEMA_VERSION) {
    throw tampered("Reserved version-10 installed package contains a non-v10 package manifest");
  }
  exactKeys(
    manifest.policyPremise,
    ["schemaVersion", "packageDigest", "packageBytesDigest", "definitions"],
    "Reserved version-10 package policy premise",
  );
  if (manifest.policyPremise.schemaVersion !== POLICY_PREMISE_SCHEMA_VERSION) {
    throw tampered("Reserved version-10 package policy premise schema is unsupported");
  }
}

function bodyForDigest(manifest: ReservedV10InstalledExtensionPackageManifest): JsonValue {
  return {
    schemaVersion: manifest.schemaVersion,
    extensionId: manifest.extensionId,
    packageVersion: manifest.packageVersion,
    packageDigest: manifest.packageDigest,
    packageBytesDigest: manifest.packageBytesDigest,
    origin: manifest.origin as unknown as JsonValue,
    packageManifest: manifest.packageManifest as unknown as JsonValue,
    packageManifestDigest: manifest.packageManifestDigest,
    policyPremise: manifest.policyPremise as unknown as JsonValue,
    policyPremiseDigest: manifest.policyPremiseDigest,
  };
}

/**
 * The installer/origin registries are the only producer boundary for this
 * artifact. It is intentionally Linux-only because the reserved runtime
 * premise has no compatible non-Linux process backend.
 */
export function produceReservedV10ExtensionPackageManifest(
  options: ProduceReservedV10ExtensionPackageManifestOptions,
): ReservedV10InstalledExtensionPackageManifest {
  exactKeys(
    options,
    ["installations", "origins", "extensionId", "packageVersion", "policyDefinitions"],
    "Reserved version-10 package producer options",
  );
  if (!(options.installations instanceof ExtensionInstallationRegistry)) {
    throw invalid("Reserved version-10 package producer requires the installation registry");
  }
  if (!(options.origins instanceof InstalledComponentOriginRegistry)) {
    throw invalid("Reserved version-10 package producer requires the origin registry");
  }
  assertLinux();
  const extensionId = identifier(options.extensionId, "extensionId");
  const packageVersion = identifier(options.packageVersion, "packageVersion");
  const installation = options.installations.resolve({ extensionId, packageVersion });
  if (installation.manifest.schemaVersion !== PACKAGE_SCHEMA_VERSION) {
    throw invalid("Package schemas 1 through 4 cannot produce non-empty capability or policy references");
  }
  const origin = options.origins.resolve({ extensionId, packageVersion });
  options.origins.assertCurrent(origin);
  if (
    origin.component_id !== extensionId ||
    origin.component_digest !== installation.packageDigest ||
    origin.component_revision < 1
  ) {
    throw tampered("Installed package origin does not match the verified package identity");
  }
  const definitions = validatePolicyDefinitions(options.policyDefinitions);
  assertPolicyCoverage(installation.manifest, definitions);
  assertPolicyCompatibility(installation.manifest, definitions);
  const policyPremise = deepFreeze({
    schemaVersion: POLICY_PREMISE_SCHEMA_VERSION,
    packageDigest: installation.packageDigest,
    packageBytesDigest: installation.packageSnapshot.digest,
    definitions,
  }) as ReservedV10ExtensionPackagePolicyPremise;
  const packageManifestDigest = canonicalJsonDigest(installation.manifest);
  const policyPremiseDigest = canonicalJsonDigest(policyPremise as unknown as JsonValue);
  const body = {
    schemaVersion: INSTALLED_MANIFEST_SCHEMA_VERSION,
    extensionId,
    packageVersion,
    packageDigest: installation.packageDigest,
    packageBytesDigest: installation.packageSnapshot.digest,
    origin,
    packageManifest: installation.manifest,
    packageManifestDigest,
    policyPremise,
    policyPremiseDigest,
  } as const;
  const provenanceDigest = canonicalJsonDigest(body as unknown as JsonValue);
  const produced = deepFreeze({ ...body, provenanceDigest }) as ReservedV10InstalledExtensionPackageManifest;
  RESERVED_V10_PACKAGE_MANIFESTS.add(produced);
  return produced;
}

/**
 * Runtime verification only. This function never constructs a manifest and
 * rejects copied, stale, cross-package, or policy-incompatible artifacts.
 */
export function assertCurrentReservedV10ExtensionPackageManifest(
  manifest: unknown,
  options: VerifyReservedV10ExtensionPackageManifestOptions,
): asserts manifest is ReservedV10InstalledExtensionPackageManifest {
  exactKeys(
    options,
    ["installations", "origins", "policyDefinitions"],
    "Reserved version-10 package verifier options",
  );
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    !RESERVED_V10_PACKAGE_MANIFESTS.has(manifest)
  ) {
    throw tampered("Reserved version-10 installed package manifest was not minted by the installer");
  }
  if (!(options.installations instanceof ExtensionInstallationRegistry)) {
    throw tampered("Reserved version-10 package verifier requires the installation registry");
  }
  if (!(options.origins instanceof InstalledComponentOriginRegistry)) {
    throw tampered("Reserved version-10 package verifier requires the origin registry");
  }
  assertLinux();
  const typed = manifest as ReservedV10InstalledExtensionPackageManifest;
  assertManifestIdentity(typed);
  assertInstalledComponentOrigin(typed.origin);
  const installation = options.installations.resolve({
    extensionId: typed.extensionId,
    packageVersion: typed.packageVersion,
  });
  if (
    installation.manifest.schemaVersion !== PACKAGE_SCHEMA_VERSION ||
    canonicalizeJson(installation.manifest) !== canonicalizeJson(typed.packageManifest) ||
    installation.packageDigest !== typed.packageDigest ||
    installation.packageSnapshot.digest !== typed.packageBytesDigest
  ) {
    throw tampered("Reserved version-10 package manifest does not match the verified package bytes");
  }
  options.origins.assertCurrent(typed.origin);
  if (
    typed.origin.component_id !== typed.extensionId ||
    typed.origin.component_digest !== typed.packageDigest
  ) {
    throw tampered("Reserved version-10 package manifest origin does not match package identity");
  }
  const definitions = validatePolicyDefinitions(options.policyDefinitions);
  assertPolicyCoverage(typed.packageManifest, definitions);
  assertPolicyCompatibility(typed.packageManifest, definitions);
  if (
    typed.policyPremise.packageDigest !== typed.packageDigest ||
    typed.policyPremise.packageBytesDigest !== typed.packageBytesDigest ||
    canonicalizeJson(typed.policyPremise.definitions) !== canonicalizeJson(definitions)
  ) {
    throw tampered("Reserved version-10 package policy premise is stale or mismatched");
  }
  if (canonicalJsonDigest(typed.packageManifest) !== typed.packageManifestDigest) {
    throw tampered("Reserved version-10 package manifest digest is stale");
  }
  if (canonicalJsonDigest(typed.policyPremise as unknown as JsonValue) !== typed.policyPremiseDigest) {
    throw tampered("Reserved version-10 package policy premise digest is stale");
  }
  if (canonicalJsonDigest(bodyForDigest(typed)) !== typed.provenanceDigest) {
    throw tampered("Reserved version-10 installed package provenance digest is stale");
  }
}
