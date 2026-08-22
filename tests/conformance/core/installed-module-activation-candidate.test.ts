import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeAuthorityDatabase,
  type InstalledComponentOrigin,
  type ModuleActivationPremises,
  type RuntimeAuthorityIdentity,
} from "../../../src/adapters/storage/runtime-authority-database.js";
import { canonicalBytes } from "../../../src/schema-bundle/index.js";
import { type JsonValue } from "../../../src/core/canonical-json.js";
import { ExtensionInstallationRegistry } from "../../../src/core/extension-installation-registry.js";
import {
  InstalledComponentOriginRegistry,
  type VerifiedInstalledComponentOrigin,
} from "../../../src/core/installed-component-origin.js";
import { InstanceControllerLock } from "../../../src/core/instance-controller-lock.js";
import {
  composeInstalledModuleActivationCandidate,
  assertInstalledModuleActivationCandidate,
  type InstalledModuleActivationCandidateOptions,
} from "../../../src/core/installed-module-activation-candidate.js";
import {
  proveLinuxModuleActivation,
  consumeLinuxModuleActivationHandoff,
  type LinuxModuleActivationHandoff,
} from "../../../src/core/linux-module-activation.js";
import { ModuleConfigurationStore } from "../../../src/core/module-configuration-store.js";
import {
  resolveStartupAuthorityPremise,
  type StartupAuthorityPermission,
} from "../../../src/core/startup-authority-premise.js";
import { createDefaultDollyInstanceConfig } from "../../../src/core/runtime-config.js";
import { reviewedLinuxModuleRuntimeIdentity } from "../../../src/linux-module-runtime-assets.js";
import type * as LinuxCoreServiceBindingModule from "../../../src/core/linux-core-service-binding.js";
import type * as LinuxModuleCgroupModule from "../../../src/core/linux-module-cgroup.js";
import type * as LinuxRuntimeAssetsModule from "../../../src/linux-module-runtime-assets.js";

type CoreServiceBindingResult = LinuxCoreServiceBindingModule.CoreServiceBindingResult;
type DelegatedCgroupRootResult = LinuxModuleCgroupModule.DelegatedCgroupRootResult;
type ReviewedLinuxModuleRuntimeInspection = LinuxRuntimeAssetsModule.ReviewedLinuxModuleRuntimeInspection;

const live = vi.hoisted(() => ({
  platform: "linux" as NodeJS.Platform,
  service: undefined as CoreServiceBindingResult | undefined,
  runtime: undefined as ReviewedLinuxModuleRuntimeInspection | undefined,
  delegatedRoot: undefined as DelegatedCgroupRootResult | undefined,
}));

vi.mock("../../../src/core/host-platform.js", () => ({
  observeHostPlatform: () => live.platform,
}));
vi.mock("../../../src/core/linux-core-service-binding.js", async (importOriginal) => ({
  ...await importOriginal<typeof LinuxCoreServiceBindingModule>(),
  inspectCoreServiceBinding: vi.fn(async () => live.service),
}));
vi.mock("../../../src/linux-module-runtime-assets.js", async (importOriginal) => {
  const original = await importOriginal<typeof LinuxRuntimeAssetsModule>();
  return {
    ...original,
    inspectReviewedLinuxModuleRuntime: vi.fn(async () => live.runtime),
  };
});
vi.mock("../../../src/core/linux-module-cgroup.js", async (importOriginal) => ({
  ...await importOriginal<typeof LinuxModuleCgroupModule>(),
  prepareDelegatedCgroupRoot: vi.fn(async () => live.delegatedRoot),
}));

const identity: RuntimeAuthorityIdentity = {
  daemonInstallationId: "0198ab11-6c44-7e8a-b2bb-000000000531",
  instanceId: "instance-00000000000000000000000000000031",
};
const runtimeInstanceId = "11111111-1111-4111-8111-111111111111";
const temporaryDirectories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "dolly-post-h3-candidate-"));
  temporaryDirectories.push(directory);
  return directory;
}

function digestWithout(record: Record<string, unknown>, field: string): string {
  const { [field]: _removed, ...rest } = record;
  return `sha256:${createHash("sha256").update(canonicalBytes(rest as never)).digest("hex")}`;
}

function writePackage(directory: string, extensionId: string, packageVersion: string): void {
  mkdirSync(join(directory, "dist"), { recursive: true });
  writeFileSync(join(directory, "dist", "main.mjs"), "export const candidate = true;\n", "utf8");
  writeFileSync(join(directory, "dolly-extension.json"), JSON.stringify({
    schemaVersion: "dolly.extension-package/1",
    extensionId,
    packageVersion,
    displayName: "Candidate fixture",
    description: "Reserved candidate composition fixture.",
    supportedProtocolVersions: ["3.0"],
    entrypoint: "dist/main.mjs",
    modules: [{
      moduleKind: "transform",
      activation: "reactive",
      configVersion: 1,
      configurationSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
      },
    }],
    requestedCapabilities: [],
  }, null, 2) + "\n", "utf8");
}

function reservedConfiguration(
  extensionId: string,
  packageVersion: string,
  revision: string,
): JsonValue {
  const defaults = createDefaultDollyInstanceConfig(runtimeInstanceId);
  return {
    schemaVersion: "dolly.instance/10",
    instanceId: runtimeInstanceId,
    displayName: "Post-H3 candidate fixture",
    stateDirectory: null,
    core: {
      limits: {
        ...defaults.core.limits,
        maxRegisteredContentValueBytes: 64 * 1024,
      },
      media: defaults.core.media,
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
      extensionId,
      packageVersion,
      moduleKind: "transform",
      configurationReference: {
        configId: "worker-config",
        revision,
        configVersion: 1,
      },
      permissionPolicyReferences: [],
      inputConnections: [{ pageId: "input", start: "from-now" }],
      outputPageIds: ["output"],
      activation: { kind: "reactive" },
      declaredExternalEffects: "none",
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
        claim: {
          baselineCount: 1,
          baselineBytes: 4096,
          maxCount: 1,
          maxBytes: 4096,
        },
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

function buildAuthority(
  origin: InstalledComponentOrigin,
  runtimeConfig: JsonValue,
  configRevision = 1,
): { bytes: Uint8Array; digest: string; premise: ModuleActivationPremises } {
  const candidate = {
    schema: "dolly.linux-service-candidate/v1",
    origin,
    unit_name: "dollyd@main.service",
    mode: "user",
    candidate_digest: "",
  } satisfies Record<string, unknown>;
  candidate.candidate_digest = digestWithout(candidate, "candidate_digest");
  const resolved = {
    runtime_config: runtimeConfig,
    permission_policy_selections: [],
    service_candidate: candidate,
  };
  const bytes = canonicalBytes(resolved);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const premise = {
    schema: "dolly.module-activation-premises/v1",
    daemon_installation_id: identity.daemonInstallationId,
    instance_id: identity.instanceId,
    config_revision: configRevision,
    config_digest: digest,
    permission_policy_definitions: [],
    permission_policy_backend_bindings: [],
    service_candidate: candidate,
    premises_digest: "",
  } satisfies Record<string, unknown>;
  premise.premises_digest = digestWithout(premise, "premises_digest");
  return { bytes, digest, premise: premise as unknown as ModuleActivationPremises };
}

function setCompleteLiveProof(): void {
  live.platform = "linux";
  live.service = {
    verified: true,
    binding: {
      mode: "user",
      unitName: "dollyd@main.service",
      serviceInvocationId: "2812432ad29e4d3bbd6776c62cafa929",
      bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
      mainPid: 10001,
      delegatedRootCgroupPath: "/user.slice/dollyd@main.service",
      coreCgroupPath: "/user.slice/dollyd@main.service/core",
      delegatedRootControllers: ["cpu", "memory", "pids"],
    },
  };
  live.runtime = { available: true, runtime: reviewedLinuxModuleRuntimeIdentity() };
  live.delegatedRoot = {
    prepared: true,
    root: {
      filesystemPath: "/sys/fs/cgroup/user.slice/dollyd@main.service",
      controllers: ["cpu", "memory", "pids"],
      subtreeControl: ["cpu", "memory", "pids"],
    },
  };
}

interface Fixture {
  readonly root: string;
  readonly database: RuntimeAuthorityDatabase;
  readonly controller: InstanceControllerLock;
  readonly origins: InstalledComponentOriginRegistry;
  readonly installations: ExtensionInstallationRegistry;
  readonly configurations: ModuleConfigurationStore;
  readonly permission: StartupAuthorityPermission;
  readonly handoff: LinuxModuleActivationHandoff;
  readonly serviceOrigin: VerifiedInstalledComponentOrigin;
}

async function fixture(
  packageExtensionId = "org.example.candidate",
  serviceExtensionId = packageExtensionId,
): Promise<Fixture> {
  const root = scratch();
  const packageDirectory = join(root, "package");
  writePackage(packageDirectory, packageExtensionId, "10.0.0");
  const serviceDirectory = join(root, "service-package");
  if (serviceExtensionId !== packageExtensionId) {
    writePackage(serviceDirectory, serviceExtensionId, "10.0.0");
  }
  const installations = new ExtensionInstallationRegistry({ directory: join(root, "installations") });
  const installation = installations.installNodePackage({ sourceDirectory: packageDirectory, trust: "trusted" });
  const serviceInstallation = serviceExtensionId === packageExtensionId
    ? installation
    : installations.installNodePackage({ sourceDirectory: serviceDirectory, trust: "trusted" });
  const configurations = new ModuleConfigurationStore({ directory: join(root, "configurations") });
  const configuration = configurations.create({
    configId: "worker-config",
    extensionId: packageExtensionId,
    moduleKind: "transform",
    configVersion: 1,
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
    },
    configuration: {},
  });
  const origins = new InstalledComponentOriginRegistry({
    directory: join(root, "origins"),
    installations,
  });
  const serviceOrigin = origins.resolve({
    extensionId: serviceInstallation.manifest.extensionId,
    packageVersion: serviceInstallation.manifest.packageVersion,
  });
  const runtimeConfig = reservedConfiguration(
    packageExtensionId,
    "10.0.0",
    configuration.revision,
  );
  const authority = buildAuthority(serviceOrigin, runtimeConfig);
  const controller = await InstanceControllerLock.acquire({
    directory: join(root, "controllers"),
    instanceId: identity.instanceId,
    controllerGenerationIdGenerator: () => "0198ab11-6c44-7e8a-b2bb-000000000631",
  });
  const database = RuntimeAuthorityDatabase.open({
    path: join(root, "authority.sqlite"),
    identity,
    lock: controller,
  });
  database.installConfig({
    identity,
    canonicalConfigBytes: authority.bytes,
    configDigest: authority.digest,
    premise: authority.premise,
    verifiedOrigins: [serviceOrigin],
  });
  const permission = resolveStartupAuthorityPremise({
    database,
    controller,
    origins,
    installedComponentOrigins: [serviceOrigin],
  });
  const result = await proveLinuxModuleActivation({ startupAuthorityPermission: permission });
  if (!result.permitted) throw new Error("complete H3 fixture proof was refused");
  return {
    root,
    database,
    controller,
    origins,
    installations,
    configurations,
    permission,
    handoff: result,
    serviceOrigin,
  };
}

function options(fixtureValue: Fixture): InstalledModuleActivationCandidateOptions {
  return {
    handoff: fixtureValue.handoff,
    database: fixtureValue.database,
    controller: fixtureValue.controller,
    origins: fixtureValue.origins,
    installations: fixtureValue.installations,
    configurations: fixtureValue.configurations,
  };
}

async function closeFixture(fixtureValue: Fixture): Promise<void> {
  fixtureValue.database.close();
  await fixtureValue.controller.release();
}

beforeEach(() => setCompleteLiveProof());
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("post-H3 installed Module activation candidate", () => {
  it("consumes one exact handoff and composes package provenance without downstream authority", async () => {
    const current = await fixture();
    try {
      const candidate = composeInstalledModuleActivationCandidate(options(current));
      expect(candidate.schemaVersion).toBe("dolly.installed-module-activation-candidate/1");
      expect(candidate.activationPermission).toBe(current.handoff.activationPermission);
      expect(candidate.serviceBinding).toBe(current.handoff.serviceBinding);
      expect(candidate.runtimeBinding).toBe(current.handoff.runtimeBinding);
      expect(candidate.delegatedRoot).toBe(current.handoff.delegatedRoot);
      expect(candidate.installedComponentOrigins).toBe(current.handoff.installedComponentOrigins);
      expect(candidate.controllerGenerationId).toBe(current.handoff.controllerGenerationId);
      expect(candidate.configRevision).toBe(current.handoff.configRevision);
      expect(candidate.configDigest).toBe(current.handoff.configDigest);
      expect(candidate.premisesDigest).toBe(current.handoff.premisesDigest);
      expect(candidate.modules).toHaveLength(1);
      expect(candidate.modules[0]!.packageOrigin).toBe(current.serviceOrigin);
      expect(candidate.modules[0]!.installedModule.installation.packageDigest)
        .toBe(current.serviceOrigin.component_digest);
      expect(Object.keys(candidate).sort()).toEqual([
        "activationPermission",
        "configDigest",
        "configRevision",
        "controllerGenerationId",
        "delegatedRoot",
        "installedComponentOrigins",
        "modules",
        "premisesDigest",
        "runtimeBinding",
        "schemaVersion",
        "serviceBinding",
      ]);
      expect(Object.isFrozen(candidate)).toBe(true);
      expect(() => assertInstalledModuleActivationCandidate({ ...candidate })).toThrow(/not minted/u);
      expect(() => composeInstalledModuleActivationCandidate(options(current))).toThrow(/already consumed|once/u);
    } finally {
      await closeFixture(current);
    }
  });

  it("fails closed for missing package origin before consuming the H3 handoff", async () => {
    const current = await fixture("org.example.package", "org.example.service");
    try {
      expect(() => composeInstalledModuleActivationCandidate(options(current)))
        .toThrow(/no matching H3 component origin/u);
      expect(() => consumeLinuxModuleActivationHandoff({
        handoff: current.handoff,
        startupAuthorityPermission: current.permission,
      })).not.toThrow();
    } finally {
      await closeFixture(current);
    }
  });

  it("fails closed for a stale current revision before package composition or handoff consumption", async () => {
    const current = await fixture();
    try {
      const replacement = buildAuthority(
        current.serviceOrigin,
        reservedConfiguration("org.example.candidate", "10.0.0", current.configurations.create({
          configId: "worker-config-2",
          extensionId: "org.example.candidate",
          moduleKind: "transform",
          configVersion: 1,
          schema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            additionalProperties: false,
          },
          configuration: {},
        }).revision),
        2,
      );
      current.database.installConfig({
        identity,
        canonicalConfigBytes: replacement.bytes,
        configDigest: replacement.digest,
        premise: replacement.premise,
        verifiedOrigins: [current.serviceOrigin],
      });
      expect(() => composeInstalledModuleActivationCandidate(options(current)))
        .toThrow(/stale|current Runtime authority|generation/u);
    } finally {
      await closeFixture(current);
    }
  });

  it("rejects copied handoffs, mismatched origin contexts, and downstream-shaped inputs", async () => {
    const current = await fixture();
    try {
      expect(() => composeInstalledModuleActivationCandidate({
        ...options(current),
        handoff: { ...current.handoff },
      } as never)).toThrow(/minted|authentic|handoff/u);
      expect(() => composeInstalledModuleActivationCandidate({
        ...options(current),
        handoff: JSON.parse(JSON.stringify(current.handoff)),
      } as never)).toThrow(/minted|Host|authority/u);
      const otherOrigins = new InstalledComponentOriginRegistry({
        directory: join(current.root, "other-origins"),
        installations: current.installations,
      });
      expect(() => composeInstalledModuleActivationCandidate({
        ...options(current),
        origins: otherOrigins,
      } as never)).toThrow(/different Runtime authority|current Host/u);
      for (const field of ["process", "ready", "acknowledgement", "absence", "retry"]) {
        expect(() => composeInstalledModuleActivationCandidate({
          ...options(current),
          [field]: true,
        } as never), field).toThrow(/unknown fields/u);
      }
    } finally {
      await closeFixture(current);
    }
  });
});
