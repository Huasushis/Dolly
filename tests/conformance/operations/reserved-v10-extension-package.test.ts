import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  RuntimeAuthorityDatabase,
  type InstalledComponentOrigin,
  type ModuleActivationPremises,
  type PermissionPolicyBackendBinding,
  type PermissionPolicyDefinition,
  type RuntimeAuthorityIdentity,
} from "../../../src/adapters/storage/runtime-authority-database.js";
import { canonicalJsonDigest, type JsonValue } from "../../../src/core/canonical-json.js";
import { canonicalBytes } from "../../../src/schema-bundle/index.js";
import {
  reservedV10InstalledPermissionPolicyDefinition,
  reservedV10InstalledPermissionPolicyRevision,
  type InstalledModulePrivateStoragePolicy,
} from "../../../src/adapters/installed-module-permission-policy.js";
import { DEFAULT_MODULE_PRIVATE_STORAGE_LIMITS_V2, ModulePrivateStorageBackend } from "../../../src/core/capabilities/module-private-storage-capability.js";
import { createDefaultDollyInstanceConfig } from "../../../src/core/runtime-config.js";
import { ExtensionInstallationError, ExtensionInstallationRegistry } from "../../../src/core/extension-installation-registry.js";
import { InstalledComponentOriginRegistry, type VerifiedInstalledComponentOrigin } from "../../../src/core/installed-component-origin.js";
import { assertCurrentReservedV10ExtensionPackageManifest, produceReservedV10ExtensionPackageManifest, type ReservedV10InstalledExtensionPackageManifest } from "../../../src/core/reserved-v10-extension-package.js";

const IDENTITY: RuntimeAuthorityIdentity = {
  daemonInstallationId: "0198ab11-6c44-7e8a-b2bb-000000000531",
  instanceId: "instance-00000000000000000000000000000031",
};
const RUNTIME_INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const PACKAGE_ID = "org.example.worker";
const PACKAGE_VERSION = "Release:2026_08";
const temporaryRoots: string[] = [];

class FakeAuthorityLock {
  readonly held = true;
  assertHeld(): void {}
}

function digestWithout(record: Record<string, unknown>, field: string): string {
  const { [field]: _removed, ...rest } = record;
  return `sha256:${createHash("sha256").update(canonicalBytes(rest as never)).digest("hex")}`;
}

function writePackage(directory: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(directory, "dist"), { recursive: true });
  writeFileSync(join(directory, "dist", "main.mjs"), "export const worker = true;\n", "utf8");
  writeFileSync(join(directory, "dolly-extension.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function runtimeConfiguration(policyRevision: string, policyId = "storage-checkpoints"): JsonValue {
  const defaults = createDefaultDollyInstanceConfig(RUNTIME_INSTANCE_ID);
  return {
    schemaVersion: "dolly.instance/10",
    instanceId: RUNTIME_INSTANCE_ID,
    displayName: "Reserved package fixture",
    stateDirectory: null,
    core: {
      ...defaults.core,
      limits: { ...defaults.core.limits, maxRegisteredContentValueBytes: 64 * 1024 },
      scheduler: {
        pollIntervalMs: 100,
        retryBaseMs: 250,
        retryMaxMs: 30_000,
        maxConcurrentModules: 1,
        backpressureAction: "pause-upstream",
        downstreamRecheckMs: 100,
        noProgressAfterMs: 5_000,
        retryJitterBasisPoints: 0,
        lowWatermarkBasisPoints: 10_000,
        policy: { kind: "fixed" },
        policyFailureAction: "quarantine",
      },
    },
    pages: [
      { pageId: "input", quota: { maxEntries: 1_000_000, maxBytes: 64 * 1024 * 1024 } },
      { pageId: "output", quota: { maxEntries: 1_000_000, maxBytes: 64 * 1024 * 1024 } },
    ],
    modules: [{
      moduleId: "worker",
      extensionId: PACKAGE_ID,
      packageVersion: PACKAGE_VERSION,
      moduleKind: "worker",
      configurationReference: { configId: "worker-config", revision: `sha256:${"1".repeat(64)}`, configVersion: 1 },
      permissionPolicyReferences: [{ policyId, revision: policyRevision }],
      inputConnections: [{ pageId: "input", start: "from-now" }],
      outputPageIds: ["output"],
      activation: { kind: "reactive" },
      declaredExternalEffects: "core-capabilities-only",
      execution: {
        kind: "linux-process",
        isolation: "process",
        limits: {
          memoryMaxBytes: 64 * 1024 * 1024,
          maxTasks: 32,
          cpuQuotaMicros: 100_000,
          cpuPeriodMicros: 100_000,
          maxOpenFiles: 128,
        },
      },
      limits: {
        claim: { baselineCount: 1, baselineBytes: 4096, maxCount: 1, maxBytes: 4096 },
        mailbox: { maxResidentCount: 16, maxResidentBytes: 64 * 1024 },
        sourceRequestMaxBytes: null,
        maxInputBytes: 4096,
        maxResultBytes: 4096,
        maxFrameBytes: 8192,
        maxRunsPerGeneration: 10,
        maxGenerations: 2,
      },
      timeouts: {
        initializationTimeoutMs: 1000,
        executionTimeoutMs: 1000,
        cancellationGraceMs: 100,
        terminationTimeoutMs: 1000,
      },
    }],
    logging: defaults.logging,
  };
}

function packageManifest(policyRevision: string, schemaVersion = "dolly.extension-package/10", capabilityVersion = "v2"): Record<string, unknown> {
  return {
    schemaVersion,
    extensionId: PACKAGE_ID,
    packageVersion: PACKAGE_VERSION,
    displayName: "Reserved worker",
    description: "A durable package producer fixture.",
    supportedProtocolVersions: ["3.0"],
    entrypoint: "dist/main.mjs",
    modules: [{
      moduleKind: "worker",
      activation: "reactive",
      configVersion: 1,
      configurationSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
      },
      producedContentSchemas: [],
      permissionPolicyReferences: [{ policyId: "storage-checkpoints", revision: policyRevision }],
    }],
    requestedCapabilities: [{
      moduleKind: "worker",
      capabilityType: "module-private-storage",
      capabilityVersion,
      policyId: "storage-checkpoints",
      policyRevision,
    }],
  };
}

function policyFixture(root: string, origin: InstalledComponentOrigin, maxCalls = 4, policyId = "storage-checkpoints"): {
  readonly policy: InstalledModulePrivateStoragePolicy;
  readonly revision: string;
  readonly definition: PermissionPolicyDefinition;
  readonly binding: PermissionPolicyBackendBinding;
} {
  const policy: InstalledModulePrivateStoragePolicy = {
    kind: "module-private-storage",
    policyId,
    backend: new ModulePrivateStorageBackend({
      root: join(root, `policy-storage-${maxCalls}`),
      now: () => "2026-08-23T00:00:00.000Z",
    }),
    operations: ["get", "list", "set"],
    limits: { ...DEFAULT_MODULE_PRIVATE_STORAGE_LIMITS_V2, maxEntries: maxCalls },
    capabilityLifetimeMs: 5_000,
  };
  const revision = reservedV10InstalledPermissionPolicyRevision(policy);
  const definitionRecord: Record<string, unknown> = {
    schema: "dolly.permission-policy-definition/v1",
    policy_id: policy.policyId,
    policy_revision: 1,
    definition_schema_uri: "https://dolly.example/installed-permission-policy.schema.json",
    definition_schema_digest: `sha256:${"a".repeat(64)}`,
    definition: reservedV10InstalledPermissionPolicyDefinition(policy),
    origin: {
      schema: "dolly.policy-definition-origin/v1",
      kind: "operator_approved_policy",
      source_id: "org.dolly.policy-store",
      source_revision: 1,
      source_digest: `sha256:${"b".repeat(64)}`,
    },
    definition_digest: "",
  };
  definitionRecord.definition_digest = digestWithout(definitionRecord, "definition_digest");
  const definition = definitionRecord as unknown as PermissionPolicyDefinition;
  const bindingRecord: Record<string, unknown> = {
    schema: "dolly.permission-policy-backend-binding/v1",
    binding_id: `${policyId}-host`,
    binding_revision: 1,
    binding_digest: "",
    policy_id: policy.policyId,
    policy_revision: definition.policy_revision,
    policy_definition_digest: definition.definition_digest,
    origin,
  };
  bindingRecord.binding_digest = digestWithout(bindingRecord, "binding_digest");
  return { policy, revision, definition, binding: bindingRecord as unknown as PermissionPolicyBackendBinding };
}

function authorityFixture(
  origin: InstalledComponentOrigin,
  runtimeConfig: JsonValue,
  policy: ReturnType<typeof policyFixture>,
  configRevision = 1,
): { readonly bytes: Uint8Array; readonly digest: string; readonly premise: ModuleActivationPremises } {
  const serviceCandidate: Record<string, unknown> = {
    schema: "dolly.linux-service-candidate/v1",
    origin,
    unit_name: "dollyd@main.service",
    mode: "user",
    candidate_digest: "",
  };
  serviceCandidate.candidate_digest = digestWithout(serviceCandidate, "candidate_digest");
  const resolved = {
    runtime_config: runtimeConfig,
    permission_policy_selections: [{
      policy_id: policy.definition.policy_id,
      policy_revision: policy.definition.policy_revision,
      policy_definition_digest: policy.definition.definition_digest,
      binding_id: policy.binding.binding_id,
      binding_revision: policy.binding.binding_revision,
      binding_digest: policy.binding.binding_digest,
    }],
    service_candidate: serviceCandidate,
  };
  const bytes = canonicalBytes(resolved);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const premise: Record<string, unknown> = {
    schema: "dolly.module-activation-premises/v1",
    daemon_installation_id: IDENTITY.daemonInstallationId,
    instance_id: IDENTITY.instanceId,
    config_revision: configRevision,
    config_digest: digest,
    permission_policy_definitions: [policy.definition],
    permission_policy_backend_bindings: [policy.binding],
    service_candidate: serviceCandidate,
    premises_digest: "",
  };
  premise.premises_digest = digestWithout(premise, "premises_digest");
  return { bytes, digest, premise: premise as unknown as ModuleActivationPremises };
}

function expectPackageError(operation: () => unknown): void {
  expect(operation).toThrow(ExtensionInstallationError);
}

function setup(maxCalls = 4): {
  readonly root: string;
  readonly source: string;
  readonly installations: ExtensionInstallationRegistry;
  readonly origins: InstalledComponentOriginRegistry;
  readonly database: RuntimeAuthorityDatabase;
  readonly authorityPath: string;
  readonly policyRevision: string;
} {
  const root = mkdtempSync(join(tmpdir(), "dolly-reserved-v10-package-"));
  temporaryRoots.push(root);
  const source = join(root, "source");
  const installations = new ExtensionInstallationRegistry({ directory: join(root, "installations") });
  const origins = new InstalledComponentOriginRegistry({ directory: join(root, "origins"), installations });
  const policyRoot = join(root, "policy");
  mkdirSync(policyRoot, { recursive: true });
  const provisionalPolicy = policyFixture(policyRoot, {
    schema: "dolly.installed-component-origin/v1",
    kind: "installed_product_component",
    component_id: PACKAGE_ID,
    component_revision: 1,
    component_digest: `sha256:${"0".repeat(64)}`,
  }, maxCalls);
  writePackage(source, packageManifest(provisionalPolicy.revision));
  installations.installNodePackage({ sourceDirectory: source, trust: "trusted" });
  const packageOrigin = origins.resolve({ extensionId: PACKAGE_ID, packageVersion: PACKAGE_VERSION });
  const policy = policyFixture(policyRoot, packageOrigin, maxCalls);
  const authorityPath = join(root, "authority.sqlite3");
  const database = RuntimeAuthorityDatabase.open({ path: authorityPath, identity: IDENTITY, lock: new FakeAuthorityLock() });
  const fixture = authorityFixture(packageOrigin, runtimeConfiguration(policy.revision), policy);
  database.installConfig({
    identity: IDENTITY,
    canonicalConfigBytes: fixture.bytes,
    configDigest: fixture.digest,
    premise: fixture.premise,
    verifiedOrigins: [packageOrigin],
  });
  return { root, source, installations, origins, database, authorityPath, policyRevision: policy.revision };
}

function produce(state: ReturnType<typeof setup>): ReservedV10InstalledExtensionPackageManifest {
  return produceReservedV10ExtensionPackageManifest({
    installations: state.installations,
    origins: state.origins,
    database: state.database,
    extensionId: PACKAGE_ID,
    packageVersion: PACKAGE_VERSION,
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("reserved version-10 installed package producer", () => {
  it("produces durable canonical provenance and verifies after deserialize/reopen", () => {
    const state = setup();
    const produced = produce(state);
    expect(produced.schemaVersion).toBe("dolly.installed-extension-package/10");
    expect(produced.packageManifest.schemaVersion).toBe("dolly.extension-package/10");
    expect(produced.origin.component_id).toBe(PACKAGE_ID);
    expect(produced.origin.component_digest).toBe(produced.packageDigest);
    expect(produced.policyPremise.definitions).toHaveLength(1);
    expect(Object.isFrozen(produced)).toBe(true);

    state.database.close();
    const reopenedInstallations = new ExtensionInstallationRegistry({ directory: join(state.root, "installations") });
    const reopenedOrigins = new InstalledComponentOriginRegistry({ directory: join(state.root, "origins"), installations: reopenedInstallations });
    const reopenedDatabase = RuntimeAuthorityDatabase.open({ path: state.authorityPath, identity: IDENTITY, lock: new FakeAuthorityLock() });
    const reopened = structuredClone(produced);
    assertCurrentReservedV10ExtensionPackageManifest(reopened, {
      installations: reopenedInstallations,
      origins: reopenedOrigins,
      database: reopenedDatabase,
    });
    reopenedDatabase.close();
  });

  it("rejects copied/tampered package bytes and stale durable policy revisions", () => {
    const state = setup();
    const produced = produce(state);
    const copied: unknown = structuredClone(produced);
    assertCurrentReservedV10ExtensionPackageManifest(copied, {
      installations: state.installations,
      origins: state.origins,
      database: state.database,
    });
    const tamperedCopy = JSON.parse(JSON.stringify(produced)) as Record<string, unknown>;
    tamperedCopy.packageManifestDigest = `sha256:${"f".repeat(64)}`;
    expectPackageError(() => assertCurrentReservedV10ExtensionPackageManifest(tamperedCopy, {
      installations: state.installations,
      origins: state.origins,
      database: state.database,
    }));
    const resolved = state.installations.resolve({ extensionId: PACKAGE_ID, packageVersion: PACKAGE_VERSION });
    writeFileSync(resolved.entrypointPath, "export const worker = false;\n", "utf8");
    expectPackageError(() => assertCurrentReservedV10ExtensionPackageManifest(produced, {
      installations: state.installations,
      origins: state.origins,
      database: state.database,
    }));
  });

  it("rejects current config policy references that are stale relative to the package", () => {
    const state = setup(4);
    const produced = produce(state);
    const packageOrigin = state.origins.resolve({ extensionId: PACKAGE_ID, packageVersion: PACKAGE_VERSION });
    const changedPolicy = policyFixture(state.root, packageOrigin, 5, "storage-checkpoints-new");
    const changed = authorityFixture(
      packageOrigin,
      runtimeConfiguration(changedPolicy.revision, "storage-checkpoints-new"),
      changedPolicy,
      2,
    );
    state.database.installConfig({
      identity: IDENTITY,
      canonicalConfigBytes: changed.bytes,
      configDigest: changed.digest,
      premise: changed.premise,
      verifiedOrigins: [packageOrigin],
    });
    expectPackageError(() => assertCurrentReservedV10ExtensionPackageManifest(produced, {
      installations: state.installations,
      origins: state.origins,
      database: state.database,
    }));
  });

  it("keeps package schemas 1 through 4 empty and refusing", () => {
    const policyRevision = `sha256:${"a".repeat(64)}`;
    for (const version of [1, 2, 3, 4] as const) {
      const root = mkdtempSync(join(tmpdir(), `dolly-package-v${version}-`));
      temporaryRoots.push(root);
      const modules = version === 1
        ? [{ moduleKind: "worker", activation: "reactive", configVersion: 1, configurationSchema: {} }]
        : [{ moduleKind: "worker", activation: "reactive", configVersion: 1, configurationSchema: {}, producedContentSchemas: [] }];
      writePackage(join(root, "source"), packageManifest(policyRevision, `dolly.extension-package/${version}`, "v2"));
      const manifestPath = join(root, "source", "dolly-extension.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      manifest.modules = modules;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      const installations = new ExtensionInstallationRegistry({ directory: join(root, "installations") });
      expectPackageError(() => installations.installNodePackage({ sourceDirectory: join(root, "source"), trust: "trusted" }));
    }
  });

  it("rejects a capability version outside the closed vocabulary", () => {
    const state = setup();
    writePackage(state.source, packageManifest(state.policyRevision, "dolly.extension-package/10", "v3"));
    expectPackageError(() => state.installations.installNodePackage({ sourceDirectory: state.source, trust: "trusted" }));
  });
});
