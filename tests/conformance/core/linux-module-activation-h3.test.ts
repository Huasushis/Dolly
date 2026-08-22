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
import { ExtensionInstallationRegistry } from "../../../src/core/extension-installation-registry.js";
import {
  InstalledComponentOriginRegistry,
  type VerifiedInstalledComponentOrigin,
} from "../../../src/core/installed-component-origin.js";
import { InstanceControllerLock } from "../../../src/core/instance-controller-lock.js";
import { canonicalBytes } from "../../../src/schema-bundle/index.js";
import {
  resolveStartupAuthorityPremise,
  type StartupAuthorityPermission,
} from "../../../src/core/startup-authority-premise.js";
import {
  consumeLinuxModuleActivationHandoff,
  proveLinuxModuleActivation,
  type LinuxModuleActivationHandoff,
} from "../../../src/core/linux-module-activation.js";
import { reviewedLinuxModuleRuntimeIdentity } from "../../../src/linux-module-runtime-assets.js";
import type * as LinuxCoreServiceBindingModule from "../../../src/core/linux-core-service-binding.js";
import type * as LinuxModuleCgroupModule from "../../../src/core/linux-module-cgroup.js";
import type * as LinuxRuntimeAssetsModule from "../../../src/linux-module-runtime-assets.js";

type CoreServiceBindingResult = LinuxCoreServiceBindingModule.CoreServiceBindingResult;
type ReviewedLinuxModuleRuntimeIdentity = LinuxRuntimeAssetsModule.ReviewedLinuxModuleRuntimeIdentity;
type ReviewedLinuxModuleRuntimeInspection = LinuxRuntimeAssetsModule.ReviewedLinuxModuleRuntimeInspection;
type DelegatedCgroupRootResult = LinuxModuleCgroupModule.DelegatedCgroupRootResult;

const live = vi.hoisted(() => ({
  platform: "linux" as NodeJS.Platform,
  service: undefined as CoreServiceBindingResult | undefined,
  runtime: undefined as ReviewedLinuxModuleRuntimeInspection | undefined,
  delegatedRoot: undefined as DelegatedCgroupRootResult | undefined,
  beforeRuntimeProof: undefined as (() => Promise<void> | void) | undefined,
  runtimeIdentityStale: false,
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
    inspectReviewedLinuxModuleRuntime: vi.fn(async () => {
      await live.beforeRuntimeProof?.();
      live.beforeRuntimeProof = undefined;
      return live.runtime;
    }),
    assertReviewedLinuxModuleRuntimeIdentity: vi.fn((value) => {
      if (live.runtimeIdentityStale) {
        throw new TypeError("the reviewed runtime identity is stale");
      }
      return original.assertReviewedLinuxModuleRuntimeIdentity(value);
    }),
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
const temporaryDirectories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "dolly-startup-authority-h3-"));
  temporaryDirectories.push(directory);
  return directory;
}

function packageFiles(directory: string): void {
  mkdirSync(join(directory, "dist"), { recursive: true });
  writeFileSync(join(directory, "dist", "main.mjs"), "export default {}\n", "utf8");
  writeFileSync(join(directory, "dolly-extension.json"), JSON.stringify({
    schemaVersion: "dolly.extension-package/1",
    extensionId: "org.example.host",
    packageVersion: "2026.08.22",
    displayName: "Host component",
    description: "Installed host test component.",
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

function digestWithout(record: Record<string, unknown>, field: string): string {
  const { [field]: _removed, ...rest } = record;
  return `sha256:${createHash("sha256").update(canonicalBytes(rest as never)).digest("hex")}`;
}

function buildAuthority(
  origin: InstalledComponentOrigin,
  configRevision = 1,
): { bytes: Uint8Array; digest: string; premise: ModuleActivationPremises } {
  const definition = {
    schema: "dolly.permission-policy-definition/v1",
    policy_id: "read-tools",
    policy_revision: 1,
    definition_schema_uri: "https://dolly.example/read-tools.schema.json",
    definition_schema_digest: `sha256:${"d".repeat(64)}`,
    definition: { effect_class: "read-only" },
    origin: {
      schema: "dolly.policy-definition-origin/v1",
      kind: "operator_approved_policy",
      source_id: "org.dolly.policy-store",
      source_revision: 1,
      source_digest: `sha256:${"e".repeat(64)}`,
    },
    definition_digest: "",
  } satisfies Record<string, unknown>;
  definition.definition_digest = digestWithout(definition, "definition_digest");
  const binding = {
    schema: "dolly.permission-policy-backend-binding/v1",
    binding_id: "read-tools-host",
    binding_revision: 1,
    binding_digest: "",
    policy_id: definition.policy_id,
    policy_revision: definition.policy_revision,
    policy_definition_digest: definition.definition_digest,
    origin,
  } satisfies Record<string, unknown>;
  binding.binding_digest = digestWithout(binding, "binding_digest");
  const candidate = {
    schema: "dolly.linux-service-candidate/v1",
    origin,
    unit_name: "dollyd@main.service",
    mode: "user",
    candidate_digest: "",
  } satisfies Record<string, unknown>;
  candidate.candidate_digest = digestWithout(candidate, "candidate_digest");
  const resolved = {
    runtime_config: { component: `installed-${configRevision}` },
    permission_policy_selections: [{
      policy_id: definition.policy_id,
      policy_revision: definition.policy_revision,
      policy_definition_digest: definition.definition_digest,
      binding_id: binding.binding_id,
      binding_revision: binding.binding_revision,
      binding_digest: binding.binding_digest,
    }],
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
    permission_policy_definitions: [definition],
    permission_policy_backend_bindings: [binding],
    service_candidate: candidate,
    premises_digest: "",
  } satisfies Record<string, unknown>;
  premise.premises_digest = digestWithout(premise, "premises_digest");
  return { bytes, digest, premise: premise as unknown as ModuleActivationPremises };
}

async function fixture(configRevision = 1): Promise<{
  database: RuntimeAuthorityDatabase;
  controller: InstanceControllerLock;
  origins: InstalledComponentOriginRegistry;
  origin: VerifiedInstalledComponentOrigin;
  permission: StartupAuthorityPermission;
}> {
  const root = scratch();
  const packageDirectory = join(root, "package");
  packageFiles(packageDirectory);
  const installations = new ExtensionInstallationRegistry({ directory: join(root, "installations") });
  const installation = installations.installNodePackage({ sourceDirectory: packageDirectory, trust: "trusted" });
  const origins = new InstalledComponentOriginRegistry({ directory: join(root, "origins"), installations });
  const origin = origins.resolve({
    extensionId: installation.manifest.extensionId,
    packageVersion: installation.manifest.packageVersion,
  });
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
  const authority = buildAuthority(origin, configRevision);
  database.installConfig({
    identity,
    canonicalConfigBytes: authority.bytes,
    configDigest: authority.digest,
    premise: authority.premise,
    verifiedOrigins: [origin],
  });
  const permission = resolveStartupAuthorityPremise({
    database,
    controller,
    origins,
    installedComponentOrigins: [origin],
  });
  return { database, controller, origins, origin, permission };
}

function setCompleteLiveProof(): void {
  live.platform = "linux";
  live.beforeRuntimeProof = undefined;
  live.runtimeIdentityStale = false;
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

function currentRuntimeProfile(): ReviewedLinuxModuleRuntimeIdentity {
  const inspection = live.runtime;
  if (inspection === undefined || !inspection.available) {
    throw new Error("complete runtime proof fixture is unavailable");
  }
  return inspection.runtime;
}

beforeEach(() => {
  setCompleteLiveProof();
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("H3 live Linux Module activation proof", () => {
  it("mints one handoff only after the complete service, runtime, and delegated-root proof", async () => {
    const { permission, controller } = await fixture();
    const result = await proveLinuxModuleActivation({ startupAuthorityPermission: permission });
    expect(result.permitted).toBe(true);
    if (!result.permitted) throw new Error("expected complete live proof");
    expect(result.startupAuthorityPermission).toBe(permission);
    expect(result.controllerGenerationId).toBe(permission.controllerGenerationId);
    expect(result.configRevision).toBe(permission.configRevision);
    expect(result.configDigest).toBe(permission.configDigest);
    expect(result.premisesDigest).toBe(permission.premisesDigest);
    expect(result.serviceBinding.unitName).toBe(permission.serviceCandidate.unit_name);
    expect(result.runtimeBinding.auditProfile).toEqual(currentRuntimeProfile());
    expect(result.delegatedRoot.subtreeControl).toEqual(["cpu", "memory", "pids"]);
    expect(result.installedComponentOrigins).toContain(permission.serviceCandidate.origin);
    await controller.release();
  });

  it("does not mint after the authoritative H2 revision changes during an awaited live check", async () => {
    const { database, origin, permission, controller } = await fixture();
    const replacement = buildAuthority(origin, 2);
    live.beforeRuntimeProof = async () => {
      database.installConfig({
        identity,
        canonicalConfigBytes: replacement.bytes,
        configDigest: replacement.digest,
        premise: replacement.premise,
        verifiedOrigins: [origin],
      });
    };
    await expect(proveLinuxModuleActivation({
      startupAuthorityPermission: permission,
    })).rejects.toThrow(/stale|revision/i);
    await controller.release();
  });

  it("refuses every missing or mismatched required live proof and never returns a handoff", async () => {
    const cases: readonly [string, () => void][] = [
      ["platform", () => { live.platform = "darwin"; }],
      ["service", () => { live.service = { verified: false, failures: [{ code: "CORE_SERVICE_MANAGER_UNAVAILABLE", detail: "missing" }] }; }],
      ["service identity", () => {
        const service = live.service;
        if (service === undefined || !service.verified) {
          throw new Error("complete service proof fixture is unavailable");
        }
        live.service = {
          ...service,
          binding: { ...service.binding, unitName: "wrong.service" },
        };
      }],
      ["service mode", () => {
        const service = live.service;
        if (service === undefined || !service.verified) {
          throw new Error("complete service proof fixture is unavailable");
        }
        live.service = {
          ...service,
          binding: { ...service.binding, mode: "system" },
        };
      }],
      ["runtime", () => { live.runtime = { available: false, runtime: reviewedLinuxModuleRuntimeIdentity(), detail: "missing" }; }],
      ["runtime identity", () => {
        live.runtime = {
          available: true,
          runtime: { ...reviewedLinuxModuleRuntimeIdentity(), nodeVersion: "not-the-running-node" },
        };
      }],
      ["delegated root", () => { live.delegatedRoot = { prepared: false, failure: { code: "MODULE_CGROUP_CONTROLLER_UNAVAILABLE", detail: "missing" } }; }],
      ["delegated controller read-back", () => {
        live.delegatedRoot = {
          prepared: true,
          root: {
            filesystemPath: "/sys/fs/cgroup/user.slice/dollyd@main.service",
            controllers: ["cpu", "memory", "pids"],
            subtreeControl: ["cpu", "memory"],
          },
        };
      }],
    ];
    for (const [label, mutate] of cases) {
      setCompleteLiveProof();
      const { permission, controller } = await fixture();
      mutate();
      const result = await proveLinuxModuleActivation({ startupAuthorityPermission: permission });
      expect(result.permitted, label).toBe(false);
      if (result.permitted) throw new Error(`${label} unexpectedly minted a handoff`);
      expect(result.refusals.length, label).toBeGreaterThan(0);
      await controller.release();
    }
  });

  it("rejects copied permissions, stale generations, and downstream-shaped inputs", async () => {
    const { permission, controller } = await fixture();
    await expect(proveLinuxModuleActivation({
      startupAuthorityPermission: { ...permission },
    })).rejects.toThrow(/not minted|stale|ownership/i);
    await expect(proveLinuxModuleActivation({
      startupAuthorityPermission: permission,
      ready: true,
    } as never)).rejects.toThrow(/unknown|downstream|fields/i);
    await controller.release();
    await expect(proveLinuxModuleActivation({ startupAuthorityPermission: permission })).rejects.toThrow(/stale|held|ownership|kernel/i);
  });


  it("rejects a handoff after the authoritative revision changes", async () => {
    const { database, origin, permission, controller } = await fixture();
    const result = await proveLinuxModuleActivation({ startupAuthorityPermission: permission });
    expect(result.permitted).toBe(true);
    if (!result.permitted) throw new Error("expected complete live proof");
    const replacement = buildAuthority(origin, 2);
    database.installConfig({
      identity,
      canonicalConfigBytes: replacement.bytes,
      configDigest: replacement.digest,
      premise: replacement.premise,
      verifiedOrigins: [origin],
    });
    await expect(proveLinuxModuleActivation({
      startupAuthorityPermission: permission,
    })).rejects.toThrow(/stale|revision/i);
    expect(() => consumeLinuxModuleActivationHandoff({
      handoff: result,
      startupAuthorityPermission: permission,
    })).toThrow(/stale|revision/i);
    await controller.release();
  });

  it("consumes an authentic handoff once, rejects copies and serialization, and does not mint a replacement after a failed consume", async () => {
    const { permission, controller } = await fixture();
    const result = await proveLinuxModuleActivation({ startupAuthorityPermission: permission });
    expect(result.permitted).toBe(true);
    if (!result.permitted) throw new Error("expected complete live proof");
    const handoff: LinuxModuleActivationHandoff = result;
    expect(() => consumeLinuxModuleActivationHandoff({
      handoff: { ...handoff },
      startupAuthorityPermission: permission,
    } as never)).toThrow(/authentic|minted/i);
    expect(() => consumeLinuxModuleActivationHandoff({
      handoff: JSON.parse(JSON.stringify(handoff)),
      startupAuthorityPermission: permission,
    } as never)).toThrow(/authentic|minted/i);
    expect(() => consumeLinuxModuleActivationHandoff({
      handoff,
      startupAuthorityPermission: { ...permission },
    } as never)).toThrow(/not minted|stale|ownership|different/i);
    const activation = consumeLinuxModuleActivationHandoff({ handoff, startupAuthorityPermission: permission });
    expect(activation).toBe(handoff.activationPermission);
    expect(() => consumeLinuxModuleActivationHandoff({ handoff, startupAuthorityPermission: permission })).toThrow(/consumed|once/i);
    await controller.release();
  });

  it("rechecks the stored reviewed runtime identity before consuming", async () => {
    const { permission, controller } = await fixture();
    const result = await proveLinuxModuleActivation({ startupAuthorityPermission: permission });
    expect(result.permitted).toBe(true);
    if (!result.permitted) throw new Error("expected complete live proof");
    live.runtimeIdentityStale = true;
    expect(() => consumeLinuxModuleActivationHandoff({
      handoff: result,
      startupAuthorityPermission: permission,
    })).toThrow(/runtime.*stale|stale.*runtime/i);
    live.runtimeIdentityStale = false;
    expect(consumeLinuxModuleActivationHandoff({
      handoff: result,
      startupAuthorityPermission: permission,
    })).toBe(result.activationPermission);
    await controller.release();
  });

  it("does not accept Ready, process, result, acknowledgement, absence, or retry observations as upstream authority", async () => {
    const { permission, controller } = await fixture();
    for (const downstream of ["ready", "process", "result", "acknowledgement", "absence", "retry"]) {
      await expect(proveLinuxModuleActivation({
        startupAuthorityPermission: permission,
        [downstream]: true,
      } as never)).rejects.toThrow(/unknown|fields/i);
    }
    await controller.release();
  });
});
