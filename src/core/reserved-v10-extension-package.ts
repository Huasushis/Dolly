import {
  canonicalJsonDigest,
  canonicalizeJson,
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import {
  InstalledComponentOriginRegistry,
  type VerifiedInstalledComponentOrigin,
} from "./installed-component-origin.js";
import {
  ExtensionInstallationError,
  ExtensionInstallationRegistry,
  type ExtensionPackageManifestV10,
  type ExtensionPackagePermissionPolicyReferenceV10,
} from "./extension-installation-registry.js";
import {
  RuntimeAuthorityDatabase,
  type CurrentAuthoritySnapshot,
  type InstalledComponentOrigin,
  type PermissionPolicyDefinition,
} from "../adapters/storage/runtime-authority-database.js";
import {
  validateDollyInstanceConfigV10Draft,
  type DollyInstanceConfigV10Draft,
  type DollyPermissionPolicyReferenceV10,
} from "./runtime-config-v10.js";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PACKAGE_SCHEMA_VERSION = "dolly.extension-package/10" as const;
const INSTALLED_MANIFEST_SCHEMA_VERSION = "dolly.installed-extension-package/10" as const;
const POLICY_PREMISE_SCHEMA_VERSION = "dolly.extension-package-policy-premise/1" as const;

type JsonObject = { readonly [key: string]: JsonValue };

/** Exact policy-definition revision selected by the durable authority. */
export interface ReservedV10ExtensionPackagePolicyDefinition {
  readonly policyId: string;
  /** Canonical digest of the persisted definition's exact `definition` field. */
  readonly revision: string;
  readonly definition: PermissionPolicyDefinition;
}

/** Versioned, canonical policy premise consumed by later package consumers. */
export interface ReservedV10ExtensionPackagePolicyPremise {
  readonly schemaVersion: typeof POLICY_PREMISE_SCHEMA_VERSION;
  readonly packageDigest: string;
  readonly packageBytesDigest: string;
  readonly definitions: readonly ReservedV10ExtensionPackagePolicyDefinition[];
}

/**
 * Host-produced package provenance. The source manifest is nested under the
 * verified package identity; policy definitions are copied from the durable
 * Runtime authority premise and are rechecked on every consumer read.
 */
export interface ReservedV10InstalledExtensionPackageManifest {
  readonly schemaVersion: typeof INSTALLED_MANIFEST_SCHEMA_VERSION;
  readonly extensionId: string;
  readonly packageVersion: string;
  readonly packageDigest: string;
  readonly packageBytesDigest: string;
  readonly origin: InstalledComponentOrigin;
  readonly packageManifest: ExtensionPackageManifestV10;
  readonly packageManifestDigest: string;
  readonly policyPremise: ReservedV10ExtensionPackagePolicyPremise;
  readonly policyPremiseDigest: string;
  readonly provenanceDigest: string;
}

export interface ProduceReservedV10ExtensionPackageManifestOptions {
  readonly installations: ExtensionInstallationRegistry;
  readonly origins: InstalledComponentOriginRegistry;
  readonly database: RuntimeAuthorityDatabase;
  readonly extensionId: string;
  readonly packageVersion: string;
}

export interface VerifyReservedV10ExtensionPackageManifestOptions {
  readonly installations: ExtensionInstallationRegistry;
  readonly origins: InstalledComponentOriginRegistry;
  readonly database: RuntimeAuthorityDatabase;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is JsonObject {
  return isJsonValue(value) && isPlainObject(value);
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
function expectedPolicyReferences(
  manifest: ExtensionPackageManifestV10,
): readonly ExtensionPackagePermissionPolicyReferenceV10[] {
  const references: ExtensionPackagePermissionPolicyReferenceV10[] = [];
  for (const module of manifest.modules) {
    for (const reference of module.permissionPolicyReferences) references.push(reference);
  }
  return references;
}

interface CurrentAuthority {
  readonly snapshot: CurrentAuthoritySnapshot;
  readonly configuration: DollyInstanceConfigV10Draft;
  readonly selections: readonly DurablePolicySelection[];
}
interface DurablePolicySelection {
  readonly policy_id: string;
  readonly policy_revision: number;
  readonly policy_definition_digest: string;
  readonly binding_id: string;
  readonly binding_revision: number;
  readonly binding_digest: string;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw invalid(`${label} must be a positive safe integer`);
  }
  return value;
}

function policyDefinitionJson(definition: PermissionPolicyDefinition): JsonValue {
  return {
    schema: definition.schema,
    policy_id: definition.policy_id,
    policy_revision: definition.policy_revision,
    definition_schema_uri: definition.definition_schema_uri,
    definition_schema_digest: definition.definition_schema_digest,
    definition: definition.definition,
    origin: {
      schema: definition.origin.schema,
      kind: definition.origin.kind,
      source_id: definition.origin.source_id,
      source_revision: definition.origin.source_revision,
      source_digest: definition.origin.source_digest,
    },
    definition_digest: definition.definition_digest,
  };
}
function originJson(origin: InstalledComponentOrigin): JsonValue {
  return {
    schema: origin.schema,
    kind: origin.kind,
    component_id: origin.component_id,
    component_revision: origin.component_revision,
    component_digest: origin.component_digest,
  };
}

function copyPolicyDefinition(definition: PermissionPolicyDefinition): PermissionPolicyDefinition {
  return Object.freeze({
    schema: definition.schema,
    policy_id: definition.policy_id,
    policy_revision: definition.policy_revision,
    definition_schema_uri: definition.definition_schema_uri,
    definition_schema_digest: definition.definition_schema_digest,
    definition: cloneJson(definition.definition),
    origin: {
      schema: definition.origin.schema,
      kind: definition.origin.kind,
      source_id: definition.origin.source_id,
      source_revision: definition.origin.source_revision,
      source_digest: definition.origin.source_digest,
    },
    definition_digest: definition.definition_digest,
  });
}

function parsePolicySelections(value: JsonValue): readonly DurablePolicySelection[] {
  if (!Array.isArray(value)) throw invalid("durable authority policy selections are not an array");
  return value.map((raw, index) => {
    const label = `durable policy selections[${index}]`;
    exactKeys(
      raw,
      [
        "policy_id",
        "policy_revision",
        "policy_definition_digest",
        "binding_id",
        "binding_revision",
        "binding_digest",
      ],
      label,
    );
    const policy_id = identifier(raw.policy_id, `${label}.policy_id`);
    const policy_revision = positiveInteger(raw.policy_revision, `${label}.policy_revision`);
    const policy_definition_digest = digest(
      raw.policy_definition_digest,
      `${label}.policy_definition_digest`,
    );
    const binding_id = identifier(raw.binding_id, `${label}.binding_id`);
    const binding_revision = positiveInteger(raw.binding_revision, `${label}.binding_revision`);
    const binding_digest = digest(raw.binding_digest, `${label}.binding_digest`);
    return {
      policy_id,
      policy_revision,
      policy_definition_digest,
      binding_id,
      binding_revision,
      binding_digest,
    };
  });
}

function currentAuthority(database: RuntimeAuthorityDatabase): CurrentAuthority {
  const snapshot = database.readCurrentConfig();
  if (snapshot === null) {
    throw invalid("reserved version-10 package requires a committed durable configuration");
  }
  if (!isJsonObject(snapshot.canonicalConfig)) {
    throw tampered("durable authority configuration is not a JSON object");
  }
  const runtimeConfig = snapshot.canonicalConfig.runtime_config;
  if (runtimeConfig === undefined) {
    throw tampered("durable authority configuration has no runtime_config");
  }
  const configuration = validateDollyInstanceConfigV10Draft(runtimeConfig);
  const selectionsValue = snapshot.canonicalConfig.permission_policy_selections;
  if (selectionsValue === undefined) {
    throw tampered("durable authority configuration has no policy selections");
  }
  return {
    snapshot,
    configuration,
    selections: parsePolicySelections(selectionsValue),
  };
}

function samePolicyReferences(
  left: readonly DollyPermissionPolicyReferenceV10[],
  right: readonly ExtensionPackagePermissionPolicyReferenceV10[],
): boolean {
  const leftJson = left.map((reference) => ({
    policyId: reference.policyId,
    revision: reference.revision,
  }));
  const rightJson = right.map((reference) => ({
    policyId: reference.policyId,
    revision: reference.revision,
  }));
  return canonicalizeJson(leftJson) === canonicalizeJson(rightJson);
}

function assertCurrentConfigReferences(
  manifest: ExtensionPackageManifestV10,
  configuration: DollyInstanceConfigV10Draft,
): void {
  for (const configured of configuration.modules) {
    if (
      configured.extensionId !== manifest.extensionId ||
      configured.packageVersion !== manifest.packageVersion
    ) {
      continue;
    }
    const packageModule = manifest.modules.find(
      (candidate) => candidate.moduleKind === configured.moduleKind,
    );
    if (
      packageModule === undefined ||
      !samePolicyReferences(configured.permissionPolicyReferences, packageModule.permissionPolicyReferences)
    ) {
      throw invalid(
        `current durable config policy references do not match package Module ${configured.moduleKind}`,
      );
    }
  }
  for (const packageModule of manifest.modules) {
    if (packageModule.permissionPolicyReferences.length === 0) continue;
    const configured = configuration.modules.filter(
      (candidate) =>
        candidate.extensionId === manifest.extensionId &&
        candidate.packageVersion === manifest.packageVersion &&
        candidate.moduleKind === packageModule.moduleKind,
    );
    if (configured.length === 0) {
      throw invalid(
        `package Module ${packageModule.moduleKind} has policy references but is absent from current durable config`,
      );
    }
  }
}

function assertPolicyCompatibility(
  manifest: ExtensionPackageManifestV10,
  definitions: readonly ReservedV10ExtensionPackagePolicyDefinition[],
): void {
  const byReference = new Map(
    definitions.map((definition) => [referenceKey(definition), definition]),
  );
  for (const capability of manifest.requestedCapabilities) {
    const definition = byReference.get(`${capability.policyId}\u0000${capability.policyRevision}`);
    if (definition === undefined || !isJsonObject(definition.definition.definition)) {
      throw invalid("reserved version-10 capability request has no exact policy definition");
    }
    const kind = definition.definition.definition.kind;
    const expectedKind =
      capability.capabilityType === "model-operation"
        ? "strict-streaming-chat"
        : capability.capabilityType === "tool-invocation"
          ? "registered-tools"
          : "module-private-storage";
    if (kind !== expectedKind) {
      throw invalid(
        `reserved version-10 capability ${capability.capabilityType} is incompatible with policy ${capability.policyId}`,
      );
    }
  }
}

function derivePolicyDefinitions(
  manifest: ExtensionPackageManifestV10,
  authority: CurrentAuthority,
  packageOrigin: InstalledComponentOrigin,
): readonly ReservedV10ExtensionPackagePolicyDefinition[] {
  const references = expectedPolicyReferences(manifest);
  if (references.length === 0) return Object.freeze([]);
  if (authority.snapshot.premise === null) {
    throw invalid("reserved version-10 package policy references require a committed durable premise");
  }
  const definitions: ReservedV10ExtensionPackagePolicyDefinition[] = [];
  for (const reference of references) {
    const definitionMatches = authority.snapshot.premise.permission_policy_definitions.filter(
      (candidate) =>
        candidate.policy_id === reference.policyId &&
        canonicalJsonDigest(candidate.definition) === reference.revision,
    );
    if (definitionMatches.length !== 1) {
      throw invalid(
        `durable policy authority has no unique ${reference.policyId}@${reference.revision} definition`,
      );
    }
    const definition = definitionMatches[0]!;
    const selections = authority.selections.filter(
      (selection) =>
        selection.policy_id === definition.policy_id &&
        selection.policy_revision === definition.policy_revision &&
        selection.policy_definition_digest === definition.definition_digest,
    );
    if (selections.length !== 1) {
      throw invalid(
        `durable policy authority has no unique current selection for ${reference.policyId}@${reference.revision}`,
      );
    }
    const selection = selections[0]!;
    const bindings = authority.snapshot.premise!.permission_policy_backend_bindings.filter(
      (binding) =>
        binding.policy_id === definition.policy_id &&
        binding.policy_revision === definition.policy_revision &&
        binding.policy_definition_digest === definition.definition_digest &&
        binding.binding_id === selection.binding_id &&
        binding.binding_revision === selection.binding_revision &&
        binding.binding_digest === selection.binding_digest &&
        canonicalizeJson(originJson(binding.origin)) === canonicalizeJson(originJson(packageOrigin)),
    );
    if (bindings.length !== 1) {
      throw invalid(
        `durable policy authority has no unique package-origin binding for ${reference.policyId}@${reference.revision}`,
      );
    }
    definitions.push({
      policyId: reference.policyId,
      revision: reference.revision,
      definition: copyPolicyDefinition(definition),
    });
  }
  definitions.sort((left, right) => referenceKey(left).localeCompare(referenceKey(right)));
  const seen = new Set<string>();
  for (const definition of definitions) {
    const key = referenceKey(definition);
    if (seen.has(key)) throw invalid("durable policy authority returned duplicate package policy definitions");
    seen.add(key);
  }
  return Object.freeze(definitions);
}

function assertPolicyCoverage(
  manifest: ExtensionPackageManifestV10,
  definitions: readonly ReservedV10ExtensionPackagePolicyDefinition[],
): void {
  const expectedKeys = new Set(expectedPolicyReferences(manifest).map(referenceKey));
  const suppliedKeys = new Set(definitions.map(referenceKey));
  if (expectedKeys.size !== suppliedKeys.size) {
    throw invalid("durable policy definitions do not exactly cover package policy references");
  }
  for (const key of expectedKeys) {
    if (!suppliedKeys.has(key)) throw invalid("durable policy definition is missing");
  }
}

function copyOrigin(origin: VerifiedInstalledComponentOrigin): InstalledComponentOrigin {
  return Object.freeze({
    schema: origin.schema,
    kind: origin.kind,
    component_id: origin.component_id,
    component_revision: origin.component_revision,
    component_digest: origin.component_digest,
  });
}

function assertOriginShape(value: unknown): asserts value is InstalledComponentOrigin {
  exactKeys(
    value,
    ["schema", "kind", "component_id", "component_revision", "component_digest"],
    "installed package origin",
  );
  if (
    value.schema !== "dolly.installed-component-origin/v1" ||
    value.kind !== "installed_product_component"
  ) {
    throw tampered("installed package origin schema or kind is unsupported");
  }
  identifier(value.component_id, "installed package origin component_id");
  positiveInteger(value.component_revision, "installed package origin component_revision");
  digest(value.component_digest, "installed package origin component_digest");
}

function policyPremiseJson(premise: ReservedV10ExtensionPackagePolicyPremise): JsonValue {
  return {
    schemaVersion: premise.schemaVersion,
    packageDigest: premise.packageDigest,
    packageBytesDigest: premise.packageBytesDigest,
    definitions: premise.definitions.map((definition) => ({
      policyId: definition.policyId,
      revision: definition.revision,
      definition: policyDefinitionJson(definition.definition),
    })),
  };
}

function bodyForDigest(
  manifest: Omit<ReservedV10InstalledExtensionPackageManifest, "provenanceDigest">,
): JsonValue {
  return {
    schemaVersion: manifest.schemaVersion,
    extensionId: manifest.extensionId,
    packageVersion: manifest.packageVersion,
    packageDigest: manifest.packageDigest,
    packageBytesDigest: manifest.packageBytesDigest,
    origin: originJson(manifest.origin),
    packageManifest: manifest.packageManifest,
    packageManifestDigest: manifest.packageManifestDigest,
    policyPremise: policyPremiseJson(manifest.policyPremise),
    policyPremiseDigest: manifest.policyPremiseDigest,
  };
}
function assertPolicyDefinitionOriginShape(value: unknown): void {
  exactKeys(
    value,
    ["schema", "kind", "source_id", "source_revision", "source_digest"],
    "policy definition origin",
  );
  if (
    value.schema !== "dolly.policy-definition-origin/v1" ||
    value.kind !== "operator_approved_policy"
  ) {
    throw tampered("policy definition origin schema or kind is unsupported");
  }
  identifier(value.source_id, "policy definition origin source_id");
  positiveInteger(value.source_revision, "policy definition origin source_revision");
  digest(value.source_digest, "policy definition origin source_digest");
}

function assertManifestIdentity(value: unknown): asserts value is ReservedV10InstalledExtensionPackageManifest {
  exactKeys(
    value,
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
  if (value.schemaVersion !== INSTALLED_MANIFEST_SCHEMA_VERSION) {
    throw tampered("Reserved version-10 installed package manifest schema is unsupported");
  }
  identifier(value.extensionId, "installed package extensionId");
  identifier(value.packageVersion, "installed package packageVersion");
  digest(value.packageDigest, "installed package packageDigest");
  digest(value.packageBytesDigest, "installed package packageBytesDigest");
  digest(value.packageManifestDigest, "installed package packageManifestDigest");
  digest(value.policyPremiseDigest, "installed package policyPremiseDigest");
  digest(value.provenanceDigest, "installed package provenanceDigest");
  assertOriginShape(value.origin);
  if (!isJsonObject(value.packageManifest)) {
    throw tampered("installed package manifest is not a JSON object");
  }
  if (
    value.packageManifest.schemaVersion !== PACKAGE_SCHEMA_VERSION ||
    value.packageManifest.extensionId !== value.extensionId ||
    value.packageManifest.packageVersion !== value.packageVersion
  ) {
    throw tampered("installed package manifest identity or schema does not match");
  }
  if (!isJsonObject(value.policyPremise)) {
    throw tampered("installed package policy premise is not a JSON object");
  }
  exactKeys(
    value.policyPremise,
    ["schemaVersion", "packageDigest", "packageBytesDigest", "definitions"],
    "Reserved version-10 package policy premise",
  );
  if (value.policyPremise.schemaVersion !== POLICY_PREMISE_SCHEMA_VERSION) {
    throw tampered("Reserved version-10 package policy premise schema is unsupported");
  }
  digest(value.policyPremise.packageDigest, "installed package premise packageDigest");
  digest(value.policyPremise.packageBytesDigest, "installed package premise packageBytesDigest");
  if (!Array.isArray(value.policyPremise.definitions)) {
    throw tampered("installed package policy premise definitions are not an array");
  }
  for (const [index, definition] of value.policyPremise.definitions.entries()) {
    const label = `installed package policy premise definitions[${index}]`;
    exactKeys(definition, ["policyId", "revision", "definition"], label);
    identifier(definition.policyId, `${label}.policyId`);
    digest(definition.revision, `${label}.revision`);
    if (!isJsonObject(definition.definition)) {
      throw tampered(`${label}.definition is not an object`);
    }
    exactKeys(
      definition.definition,
      [
        "schema",
        "policy_id",
        "policy_revision",
        "definition_schema_uri",
        "definition_schema_digest",
        "definition",
        "origin",
        "definition_digest",
      ],
      `${label}.definition`,
    );
    if (!isJsonObject(definition.definition.definition)) {
      throw tampered(`${label}.definition.definition is not an object`);
    }
    assertPolicyDefinitionOriginShape(definition.definition.origin);
  }
}

/**
 * The installer/origin registries and the durable Runtime authority are the
 * only producer boundary for this artifact.
 */
export function produceReservedV10ExtensionPackageManifest(
  options: ProduceReservedV10ExtensionPackageManifestOptions,
): ReservedV10InstalledExtensionPackageManifest {
  exactKeys(
    options,
    ["installations", "origins", "database", "extensionId", "packageVersion"],
    "Reserved version-10 package producer options",
  );
  if (!(options.installations instanceof ExtensionInstallationRegistry)) {
    throw invalid("Reserved version-10 package producer requires the installation registry");
  }
  if (!(options.origins instanceof InstalledComponentOriginRegistry)) {
    throw invalid("Reserved version-10 package producer requires the origin registry");
  }
  if (!(options.database instanceof RuntimeAuthorityDatabase)) {
    throw invalid("Reserved version-10 package producer requires the durable policy authority");
  }
  assertLinux();
  const extensionId = identifier(options.extensionId, "extensionId");
  const packageVersion = identifier(options.packageVersion, "packageVersion");
  const installation = options.installations.resolve({ extensionId, packageVersion });
  if (installation.manifest.schemaVersion !== PACKAGE_SCHEMA_VERSION) {
    throw invalid("Package schemas 1 through 4 cannot produce non-empty capability or policy references");
  }
  const liveOrigin = options.origins.resolve({ extensionId, packageVersion });
  options.origins.assertCurrent(liveOrigin);
  if (
    liveOrigin.component_id !== extensionId ||
    liveOrigin.component_digest !== installation.packageDigest ||
    liveOrigin.component_revision < 1
  ) {
    throw tampered("Installed package origin does not match the verified package identity");
  }
  const authority = currentAuthority(options.database);
  assertCurrentConfigReferences(installation.manifest, authority.configuration);
  const definitions = derivePolicyDefinitions(installation.manifest, authority, liveOrigin);
  assertPolicyCoverage(installation.manifest, definitions);
  assertPolicyCompatibility(installation.manifest, definitions);
  const policyPremise: ReservedV10ExtensionPackagePolicyPremise = deepFreeze({
    schemaVersion: POLICY_PREMISE_SCHEMA_VERSION,
    packageDigest: installation.packageDigest,
    packageBytesDigest: installation.packageSnapshot.digest,
    definitions,
  });
  const packageManifestDigest = canonicalJsonDigest(installation.manifest);
  const policyPremiseDigest = canonicalJsonDigest(policyPremiseJson(policyPremise));
  const body = {
    schemaVersion: INSTALLED_MANIFEST_SCHEMA_VERSION,
    extensionId,
    packageVersion,
    packageDigest: installation.packageDigest,
    packageBytesDigest: installation.packageSnapshot.digest,
    origin: copyOrigin(liveOrigin),
    packageManifest: installation.manifest,
    packageManifestDigest,
    policyPremise,
    policyPremiseDigest,
  } as const;
  const provenanceDigest = canonicalJsonDigest(bodyForDigest(body));
  return deepFreeze({ ...body, provenanceDigest });
}

/**
 * Runtime verification only. It recomputes package, origin, config, and
 * policy facts from durable authorities; copied/deserialized artifacts remain
 * valid while stale or tampered facts fail closed.
 */
export function assertCurrentReservedV10ExtensionPackageManifest(
  manifest: unknown,
  options: VerifyReservedV10ExtensionPackageManifestOptions,
): asserts manifest is ReservedV10InstalledExtensionPackageManifest {
  exactKeys(
    options,
    ["installations", "origins", "database"],
    "Reserved version-10 package verifier options",
  );
  if (!(options.installations instanceof ExtensionInstallationRegistry)) {
    throw tampered("Reserved version-10 package verifier requires the installation registry");
  }
  if (!(options.origins instanceof InstalledComponentOriginRegistry)) {
    throw tampered("Reserved version-10 package verifier requires the origin registry");
  }
  if (!(options.database instanceof RuntimeAuthorityDatabase)) {
    throw tampered("Reserved version-10 package verifier requires the durable policy authority");
  }
  assertLinux();
  assertManifestIdentity(manifest);
  const installation = options.installations.resolve({
    extensionId: manifest.extensionId,
    packageVersion: manifest.packageVersion,
  });
  if (
    installation.manifest.schemaVersion !== PACKAGE_SCHEMA_VERSION ||
    canonicalizeJson(installation.manifest) !== canonicalizeJson(manifest.packageManifest) ||
    installation.packageDigest !== manifest.packageDigest ||
    installation.packageSnapshot.digest !== manifest.packageBytesDigest
  ) {
    throw tampered("Reserved version-10 package manifest does not match verified package bytes");
  }
  const liveOrigin = options.origins.resolve({
    extensionId: manifest.extensionId,
    packageVersion: manifest.packageVersion,
  });
  options.origins.assertCurrent(liveOrigin);
  if (
    canonicalizeJson(originJson(liveOrigin)) !== canonicalizeJson(originJson(manifest.origin)) ||
    liveOrigin.component_id !== manifest.extensionId ||
    liveOrigin.component_digest !== manifest.packageDigest
  ) {
    throw tampered("Reserved version-10 package manifest origin does not match durable origin");
  }
  const authority = currentAuthority(options.database);
  assertCurrentConfigReferences(manifest.packageManifest, authority.configuration);
  const definitions = derivePolicyDefinitions(manifest.packageManifest, authority, liveOrigin);
  assertPolicyCoverage(manifest.packageManifest, definitions);
  assertPolicyCompatibility(manifest.packageManifest, definitions);
  if (
    manifest.policyPremise.packageDigest !== manifest.packageDigest ||
    manifest.policyPremise.packageBytesDigest !== manifest.packageBytesDigest ||
    canonicalizeJson(policyPremiseJson(manifest.policyPremise)) !==
      canonicalizeJson(policyPremiseJson({
        schemaVersion: POLICY_PREMISE_SCHEMA_VERSION,
        packageDigest: manifest.packageDigest,
        packageBytesDigest: manifest.packageBytesDigest,
        definitions,
      }))
  ) {
    throw tampered("Reserved version-10 package policy premise is stale or mismatched");
  }
  if (canonicalJsonDigest(manifest.packageManifest) !== manifest.packageManifestDigest) {
    throw tampered("Reserved version-10 package manifest digest is stale");
  }
  if (canonicalJsonDigest(policyPremiseJson(manifest.policyPremise)) !== manifest.policyPremiseDigest) {
    throw tampered("Reserved version-10 package policy premise digest is stale");
  }
  if (canonicalJsonDigest(bodyForDigest(manifest)) !== manifest.provenanceDigest) {
    throw tampered("Reserved version-10 installed package provenance digest is stale");
  }
}
