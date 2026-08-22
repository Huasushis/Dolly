import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeAuthorityDatabase, type InstalledComponentOrigin, type ModuleActivationPremises, type PermissionPolicyBackendBinding, type PermissionPolicyDefinition, type RuntimeAuthorityIdentity } from "../../../src/adapters/storage/runtime-authority-database.js";
import { ExtensionInstallationRegistry } from "../../../src/core/extension-installation-registry.js";
import { InstalledComponentOriginRegistry, type VerifiedInstalledComponentOrigin } from "../../../src/core/installed-component-origin.js";
import { InstanceControllerLock } from "../../../src/core/instance-controller-lock.js";
import { canonicalJsonDigest, canonicalizeJson } from "../../../src/core/canonical-json.js";
import { canonicalBytes } from "../../../src/schema-bundle/index.js";
import { assertStartupAuthorityPermission, resolveStartupAuthorityPremise, type StartupAuthorityPermission } from "../../../src/core/startup-authority-premise.js";

const temporaryDirectories: string[] = [];
const identity: RuntimeAuthorityIdentity = {
  daemonInstallationId: "0198ab11-6c44-7e8a-b2bb-000000000531",
  instanceId: "instance-00000000000000000000000000000031",
};

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "dolly-startup-authority-h2-"));
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
      configurationSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false },
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
  component = "installed",
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
    runtime_config: { component },
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

async function fixture(withPremise = true): Promise<{ database: RuntimeAuthorityDatabase; controller: InstanceControllerLock; origins: InstalledComponentOriginRegistry; origin: VerifiedInstalledComponentOrigin; root: string }> {
  const root = scratch();
  const packageDirectory = join(root, "package");
  packageFiles(packageDirectory);
  const installations = new ExtensionInstallationRegistry({ directory: join(root, "installations") });
  const installation = installations.installNodePackage({ sourceDirectory: packageDirectory, trust: "trusted" });
  const origins = new InstalledComponentOriginRegistry({ directory: join(root, "origins"), installations });
  const origin = origins.resolve({ extensionId: installation.manifest.extensionId, packageVersion: installation.manifest.packageVersion });
  const controller = await InstanceControllerLock.acquire({
    directory: join(root, "controllers"),
    instanceId: identity.instanceId,
    controllerGenerationIdGenerator: () => "0198ab11-6c44-7e8a-b2bb-000000000631",
  });
  const database = RuntimeAuthorityDatabase.open({ path: join(root, "authority.sqlite"), identity, lock: controller });
  if (withPremise) {
    const authority = buildAuthority(origin);
    database.installConfig({
      identity,
      canonicalConfigBytes: authority.bytes,
      configDigest: authority.digest,
      premise: authority.premise,
      verifiedOrigins: [origin],
    });
  } else {
    const bytes = canonicalBytes({
      runtime_config: { component: "no-premise" },
      permission_policy_selections: [],
      service_candidate: null,
    });
    database.installConfig({
      identity,
      canonicalConfigBytes: bytes,
      configDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      premise: null,
      verifiedOrigins: [],
    });
  }
  return { database, controller, origins, origin, root };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("H2 startup authority premise", () => {
  it("resolves the exact current premise into one generation-bound permission", async () => {
    const { database, controller, origins, origin } = await fixture();
    const permission = resolveStartupAuthorityPremise({
      database,
      controller,
      origins,
      installedComponentOrigins: [origin],
    });
    expect(permission.controllerGenerationId).toBe(controller.info.controllerGenerationId);
    expect(permission.configRevision).toBe(1);
    expect(permission.configDigest).toBe(database.readCurrentConfig()!.config_digest);
    expect(permission.premisesDigest).toBe(database.readCurrentConfig()!.premise!.premises_digest);
    expect(permission.policyBindings).toHaveLength(1);
    expect(permission.policyBindings[0]!.origin).toBe(origin);
    assertStartupAuthorityPermission(permission);
    await controller.release();
  });

  it("does not accept a copied permission or synthesize one from downstream-shaped input", async () => {
    const { database, controller, origins, origin } = await fixture();
    const permission = resolveStartupAuthorityPremise({ database, controller, origins, installedComponentOrigins: [origin] });
    expect(() => assertStartupAuthorityPermission({ ...permission })).toThrow(/not minted|stale|ownership/i);
    expect(() => resolveStartupAuthorityPremise({ database, controller, origins, installedComponentOrigins: [origin], ready: true } as never)).toThrow();
    await controller.release();
  });

  it("fails closed for absent, stale, mismatched, and cardinality-conflicting evidence", async () => {
    const empty = await fixture(false);
    expect(() => resolveStartupAuthorityPremise({
      database: empty.database,
      controller: empty.controller,
      origins: empty.origins,
      installedComponentOrigins: [empty.origin],
    })).toThrow();
    await empty.controller.release();

    const { database, controller, origins, origin, root } = await fixture();
    expect(() => resolveStartupAuthorityPremise({ database, controller, origins, installedComponentOrigins: [] })).toThrow();
    expect(() => resolveStartupAuthorityPremise({
      database,
      controller,
      origins,
      installedComponentOrigins: [{ ...origin } as VerifiedInstalledComponentOrigin],
    })).toThrow();
    expect(() => resolveStartupAuthorityPremise({
      database,
      controller,
      origins,
      installedComponentOrigins: [origin, origin],
    })).toThrow();
    const wrongController = await InstanceControllerLock.acquire({
      directory: join(root, "wrong-controller"),
      instanceId: "instance-00000000000000000000000000000032",
      controllerGenerationIdGenerator: () => "0198ab11-6c44-7e8a-b2bb-000000000632",
    });
    expect(() => resolveStartupAuthorityPremise({
      database,
      controller: wrongController,
      origins,
      installedComponentOrigins: [origin],
    })).toThrow();
    await wrongController.release();
    const permission = resolveStartupAuthorityPremise({ database, controller, origins, installedComponentOrigins: [origin] });
    const replacement = buildAuthority(origin, 2, "replaced");
    database.installConfig({ identity, canonicalConfigBytes: replacement.bytes, configDigest: replacement.digest, premise: replacement.premise, verifiedOrigins: [origin] });
    expect(() => assertStartupAuthorityPermission(permission)).toThrow();
    await controller.release();
  });
});

