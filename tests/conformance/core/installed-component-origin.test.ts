import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExtensionInstallationError,
  ExtensionInstallationRegistry,
} from "../../../src/core/extension-installation-registry.js";
import {
  assertInstalledComponentOrigin,
  InstalledComponentOriginError,
  InstalledComponentOriginRegistry,
  type VerifiedInstalledComponentOrigin,
} from "../../../src/core/installed-component-origin.js";
import {
  RuntimeAuthorityDatabase,
  type InstalledComponentOrigin,
  type ModuleActivationPremises,
  type PermissionPolicyBackendBinding,
  type PermissionPolicyDefinition,
  type RuntimeAuthorityIdentity,
} from "../../../src/adapters/storage/runtime-authority-database.js";
import { JSON_SCHEMA_2020_12 } from "../../../src/core/json-schema.js";
import { canonicalJsonDigest, canonicalizeJson } from "../../../src/core/canonical-json.js";
import { canonicalBytes } from "../../../src/schema-bundle/index.js";

const temporaryDirectories: string[] = [];

const identity: RuntimeAuthorityIdentity = {
  daemonInstallationId: "0198ab11-6c44-7e8a-b2bb-000000000531",
  instanceId: "main",
};

class FakeLock {
  readonly held = true;
  readonly controllerGenerationId = "0198ab11-6c44-7e8a-b2bb-000000000631";

  assertHeld(): void {}
}

function moduleDeclaration(): Record<string, unknown> {
  return {
    moduleKind: "transform",
    activation: "reactive",
    configVersion: 1,
    configurationSchema: {
      $schema: JSON_SCHEMA_2020_12,
      type: "object",
      additionalProperties: false,
    },
  };
}

function packageManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "dolly.extension-package/1",
    extensionId: "org.example.transform",
    packageVersion: "Release:2026_07",
    displayName: "Example transform",
    description: "Transforms one test value without external services.",
    supportedProtocolVersions: ["3.0"],
    entrypoint: "dist/main.mjs",
    modules: [moduleDeclaration()],
    requestedCapabilities: [],
    ...overrides,
  };
}

function writePackage(
  directory: string,
  manifestOverrides: Record<string, unknown> = {},
  entrypointContents = "export default Object.freeze({ name: 'example' });\n",
): void {
  mkdirSync(join(directory, "dist"), { recursive: true });
  writeFileSync(join(directory, "dist", "main.mjs"), entrypointContents, "utf8");
  writeFileSync(
    join(directory, "dolly-extension.json"),
    `${JSON.stringify(packageManifest(manifestOverrides), null, 2)}\n`,
    "utf8",
  );
}

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "dolly-installed-component-origin-"));
  temporaryDirectories.push(directory);
  return directory;
}

function digestOfBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function recordDigest(record: Record<string, unknown>, field: string): string {
  const { [field]: _digest, ...rest } = record;
  return digestOfBytes(canonicalBytes(rest));
}

function policyDefinition(): PermissionPolicyDefinition {
  const record: Record<string, unknown> = {
    schema: "dolly.permission-policy-definition/v1",
    policy_id: "read-tools",
    policy_revision: 1,
    definition_schema_uri: "https://dolly.example/policies/read-tools.schema.json",
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
  };
  record.definition_digest = recordDigest(record, "definition_digest");
  return record as unknown as PermissionPolicyDefinition;
}

function binding(
  definition: PermissionPolicyDefinition,
  origin: InstalledComponentOrigin,
): PermissionPolicyBackendBinding {
  const record: Record<string, unknown> = {
    schema: "dolly.permission-policy-backend-binding/v1",
    binding_id: "read-tools-host",
    binding_revision: 1,
    binding_digest: "",
    policy_id: definition.policy_id,
    policy_revision: definition.policy_revision,
    policy_definition_digest: definition.definition_digest,
    origin,
  };
  record.binding_digest = recordDigest(record, "binding_digest");
  return record as unknown as PermissionPolicyBackendBinding;
}

function candidate(origin: InstalledComponentOrigin): Record<string, unknown> {
  const record: Record<string, unknown> = {
    schema: "dolly.linux-service-candidate/v1",
    origin,
    unit_name: "dollyd@main.service",
    mode: "user",
    candidate_digest: "",
  };
  record.candidate_digest = recordDigest(record, "candidate_digest");
  return record;
}

function authorityFixture(origin: VerifiedInstalledComponentOrigin): {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly premise: ModuleActivationPremises;
} {
  const definition = policyDefinition();
  const bindingRecord = binding(definition, origin);
  const serviceCandidate = candidate(origin);
  const resolved = {
    runtime_config: { component: "installed" },
    permission_policy_selections: [{
      policy_id: definition.policy_id,
      policy_revision: definition.policy_revision,
      policy_definition_digest: definition.definition_digest,
      binding_id: bindingRecord.binding_id,
      binding_revision: bindingRecord.binding_revision,
      binding_digest: bindingRecord.binding_digest,
    }],
    service_candidate: serviceCandidate,
  };
  const bytes = canonicalBytes(resolved);
  const digest = digestOfBytes(bytes);
  const premise: Record<string, unknown> = {
    schema: "dolly.module-activation-premises/v1",
    daemon_installation_id: identity.daemonInstallationId,
    instance_id: identity.instanceId,
    config_revision: 1,
    config_digest: digest,
    permission_policy_definitions: [definition],
    permission_policy_backend_bindings: [bindingRecord],
    service_candidate: serviceCandidate,
    premises_digest: "",
  };
  premise.premises_digest = recordDigest(premise, "premises_digest");
  return {
    bytes,
    digest,
    premise: premise as unknown as ModuleActivationPremises,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Host installed-component origin authority", () => {
  it("derives an immutable versioned origin from managed package bytes and survives restart", () => {
    const root = scratch();
    const sourceDirectory = join(root, "source");
    const installationDirectory = join(root, "installations");
    const originDirectory = join(root, "origins");
    writePackage(sourceDirectory);
    const installations = new ExtensionInstallationRegistry({ directory: installationDirectory });
    const installed = installations.installNodePackage({ sourceDirectory, trust: "trusted" });
    const producer = new InstalledComponentOriginRegistry({
      directory: originDirectory,
      installations,
    });

    const origin = producer.resolve({
      extensionId: installed.manifest.extensionId,
      packageVersion: installed.manifest.packageVersion,
    });

    expect(origin).toEqual({
      schema: "dolly.installed-component-origin/v1",
      kind: "installed_product_component",
      component_id: installed.manifest.extensionId,
      component_revision: 1,
      component_digest: installed.packageDigest,
    });
    expect(origin.component_digest).toBe(installed.packageDigest);
    expect(Object.keys(origin)).toEqual([
      "schema",
      "kind",
      "component_id",
      "component_revision",
      "component_digest",
    ]);
    expect(Object.isFrozen(origin)).toBe(true);
    expect(Object.isFrozen(origin)).toBe(true);
    assertInstalledComponentOrigin(origin);

    const recordPath = join(originDirectory, readdirSync(originDirectory)[0]!);
    const recordBytes = readFileSync(recordPath);
    expect(recordBytes.toString("utf8")).toBe(`${canonicalizeJson(origin)}\n`);

    const restarted: InstalledComponentOriginRegistry = new InstalledComponentOriginRegistry({
      directory: originDirectory,
      installations: new ExtensionInstallationRegistry({ directory: installationDirectory }),
    });
    const afterRestart = restarted.resolve({
      extensionId: installed.manifest.extensionId,
      packageVersion: installed.manifest.packageVersion,
    });
    expect(afterRestart).toEqual(origin);
    expect(afterRestart).not.toBe(origin);
    expect(() => restarted.assertCurrent(origin)).toThrowError(
      expect.objectContaining<Partial<InstalledComponentOriginError>>({
        code: "INSTALLED_COMPONENT_ORIGIN_UNAVAILABLE",
      }),
    );
    restarted.assertCurrent(afterRestart);
  });

  it("rejects caller labels, paths, absent evidence, and copied structural records", () => {
    const root = scratch();
    const installations = new ExtensionInstallationRegistry({ directory: join(root, "installations") });
    const producer = new InstalledComponentOriginRegistry({
      directory: join(root, "origins"),
      installations,
    });

    expect(() => producer.resolve({
      extensionId: "org.example.transform",
      packageVersion: "Release:2026_07",
      componentId: "org.attacker.forged",
    } as never)).toThrowError(
      expect.objectContaining<Partial<InstalledComponentOriginError>>({
        code: "INSTALLED_COMPONENT_ORIGIN_INVALID",
      }),
    );
    expect(() => producer.resolve({
      extensionId: "org.example.transform",
      packageVersion: "Release:2026_07",
      sourceDirectory: "/tmp/attacker",
    } as never)).toThrowError(
      expect.objectContaining<Partial<InstalledComponentOriginError>>({
        code: "INSTALLED_COMPONENT_ORIGIN_INVALID",
      }),
    );
    expect(() => producer.resolve({
      extensionId: "org.example.transform",
      packageVersion: "Release:2026_07",
    })).toThrowError(
      expect.objectContaining<Partial<ExtensionInstallationError>>({
        code: "EXTENSION_INSTALLATION_NOT_FOUND",
      }),
    );

    const sourceDirectory = join(root, "source");
    writePackage(sourceDirectory);
    const installed = installations.installNodePackage({ sourceDirectory, trust: "trusted" });
    const origin = producer.resolve({
      extensionId: installed.manifest.extensionId,
      packageVersion: installed.manifest.packageVersion,
    });
    expect(() => assertInstalledComponentOrigin({ ...origin })).toThrowError(
      expect.objectContaining<Partial<InstalledComponentOriginError>>({
        code: "INSTALLED_COMPONENT_ORIGIN_UNAVAILABLE",
      }),
    );
  });

  it("binds package identity and digest to immutable revisions and rejects stale or tampered records", () => {
    const root = scratch();
    const sourceDirectory = join(root, "source");
    const installationDirectory = join(root, "installations");
    const originDirectory = join(root, "origins");
    writePackage(sourceDirectory);
    const installations = new ExtensionInstallationRegistry({ directory: installationDirectory });
    const producer = new InstalledComponentOriginRegistry({ directory: originDirectory, installations });
    const installed = installations.installNodePackage({ sourceDirectory, trust: "trusted" });
    const first = producer.resolve({
      extensionId: installed.manifest.extensionId,
      packageVersion: installed.manifest.packageVersion,
    });

    writePackage(sourceDirectory, { packageVersion: "Release:2026_08" }, "export default 'new';\n");
    const secondInstallation = installations.installNodePackage({ sourceDirectory, trust: "trusted" });
    const second = producer.resolve({
      extensionId: secondInstallation.manifest.extensionId,
      packageVersion: secondInstallation.manifest.packageVersion,
    });
    expect(second.component_revision).toBe(first.component_revision + 1);
    expect(second.component_digest).not.toBe(first.component_digest);
    expect(second.component_id).toBe(first.component_id);

    const originalEntrypoint = readFileSync(installed.entrypointPath);
    writeFileSync(installed.entrypointPath, "export default 'stale';\n", "utf8");
    expect(() => producer.assertCurrent(first)).toThrowError(
      expect.objectContaining<Partial<ExtensionInstallationError>>({
        code: "EXTENSION_INSTALLATION_TAMPERED",
      }),
    );
    writeFileSync(installed.entrypointPath, originalEntrypoint);

    const recordPath = join(originDirectory, readdirSync(originDirectory).find((name) => name.endsWith(".json"))!);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    record.component_digest = `sha256:${"f".repeat(64)}`;
    writeFileSync(recordPath, `${JSON.stringify(record)}\n`, "utf8");
    expect(() => new InstalledComponentOriginRegistry({
      directory: originDirectory,
      installations,
    }).resolve({
      extensionId: first.component_id,
      packageVersion: installed.manifest.packageVersion,
    })).toThrowError(
      expect.objectContaining<Partial<InstalledComponentOriginError>>({
        code: "INSTALLED_COMPONENT_ORIGIN_TAMPERED",
      }),
    );
  });

  it("supplies the exact origin to RuntimeAuthorityDatabase and rejects a cross-origin premise", () => {
    const root = scratch();
    const sourceA = join(root, "source-a");
    const sourceB = join(root, "source-b");
    const installationsA = new ExtensionInstallationRegistry({ directory: join(root, "installations-a") });
    const installationsB = new ExtensionInstallationRegistry({ directory: join(root, "installations-b") });
    writePackage(sourceA);
    writePackage(sourceB, { extensionId: "org.other.runtime" });
    installationsA.installNodePackage({ sourceDirectory: sourceA, trust: "trusted" });
    installationsB.installNodePackage({ sourceDirectory: sourceB, trust: "trusted" });
    const originA = new InstalledComponentOriginRegistry({
      directory: join(root, "origins-a"),
      installations: installationsA,
    }).resolve({ extensionId: "org.example.transform", packageVersion: "Release:2026_07" });
    const originB = new InstalledComponentOriginRegistry({
      directory: join(root, "origins-b"),
      installations: installationsB,
    }).resolve({ extensionId: "org.other.runtime", packageVersion: "Release:2026_07" });
    const fixture = authorityFixture(originA);
    const lock = new FakeLock();
    const databasePath = join(root, "runtime-authority.sqlite");
    const database = RuntimeAuthorityDatabase.open({ path: databasePath, identity, lock });
    expect(database.installConfig({
      identity,
      canonicalConfigBytes: fixture.bytes,
      configDigest: fixture.digest,
      premise: fixture.premise,
      verifiedOrigins: [originA],
    })).toEqual({ config_revision: 1, allocated: true });
    expect(database.readCurrentConfig()?.premise?.service_candidate.origin).toEqual(originA);
    database.close();

    const crossOriginDatabase = RuntimeAuthorityDatabase.open({
      path: join(root, "cross-origin.sqlite"),
      identity,
      lock,
    });
    expect(() => crossOriginDatabase.installConfig({
      identity,
      canonicalConfigBytes: fixture.bytes,
      configDigest: fixture.digest,
      premise: fixture.premise,
      verifiedOrigins: [originB],
    })).toThrowError(
      expect.objectContaining({ code: "MODULE_ACTIVATION_PREMISES_INVALID" }),
    );
    crossOriginDatabase.close();
  });
});
