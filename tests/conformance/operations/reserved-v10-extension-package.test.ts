import {
  mkdirSync,
  mkdtempSync,
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
  InstalledComponentOriginRegistry,
} from "../../../src/core/installed-component-origin.js";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import {
  assertCurrentReservedV10ExtensionPackageManifest,
  produceReservedV10ExtensionPackageManifest,
  type ReservedV10ExtensionPackagePolicyDefinition,
} from "../../../src/core/reserved-v10-extension-package.js";

const POLICY_DEFINITION = {
  policyId: "read-tools",
  kind: "registered-tools",
  toolWireNames: ["list-files"],
  limits: { maxCalls: 4 },
} as const;
const POLICY_REVISION = canonicalJsonDigest(POLICY_DEFINITION);
const POLICY = {
  policyId: "read-tools",
  revision: POLICY_REVISION,
  definition: POLICY_DEFINITION,
} satisfies ReservedV10ExtensionPackagePolicyDefinition;

function moduleDeclaration(
  policyId = "read-tools",
  policyRevision = POLICY_REVISION,
): Record<string, unknown> {
  return {
    moduleKind: "worker",
    activation: "reactive",
    configVersion: 1,
    configurationSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
    },
    producedContentSchemas: [],
    permissionPolicyReferences: [{ policyId, revision: policyRevision }],
  };
}

function packageManifest(
  schemaVersion = "dolly.extension-package/10",
  requestedCapabilities: readonly Record<string, unknown>[] = [{
    moduleKind: "worker",
    capabilityType: "tool-invocation",
    capabilityVersion: "v2",
    policyId: "read-tools",
    policyRevision: POLICY_REVISION,
  }],
  modules: readonly Record<string, unknown>[] = [moduleDeclaration()],
): Record<string, unknown> {
  return {
    schemaVersion,
    extensionId: "org.example.worker",
    packageVersion: "Release:2026_08",
    displayName: "Example worker",
    description: "A reserved package producer fixture.",
    supportedProtocolVersions: ["3.0"],
    entrypoint: "dist/main.mjs",
    modules,
    requestedCapabilities,
  };
}

function writePackage(
  directory: string,
  manifest: Record<string, unknown> = packageManifest(),
): void {
  mkdirSync(join(directory, "dist"), { recursive: true });
  writeFileSync(join(directory, "dist", "main.mjs"), "export default Object.freeze({});\n", "utf8");
  writeFileSync(join(directory, "dolly-extension.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function setup(): {
  root: string;
  source: string;
  registryDirectory: string;
  originsDirectory: string;
  installations: ExtensionInstallationRegistry;
  origins: InstalledComponentOriginRegistry;
} {
  const root = mkdtempSync(join(tmpdir(), "dolly-reserved-v10-package-"));
  const source = join(root, "source");
  const registryDirectory = join(root, "registry");
  const originsDirectory = join(root, "origins");
  writePackage(source);
  const installations = new ExtensionInstallationRegistry({ directory: registryDirectory });
  const origins = new InstalledComponentOriginRegistry({
    directory: originsDirectory,
    installations,
  });
  return { root, source, registryDirectory, originsDirectory, installations, origins };
}

function install(
  installations: ExtensionInstallationRegistry,
  source: string,
): void {
  installations.installNodePackage({ sourceDirectory: source, trust: "trusted" });
}

function expectPackageError(operation: () => unknown): void {
  expect(operation).toThrow(ExtensionInstallationError);
}

describe("reserved version-10 installed package producer", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("produces canonical package provenance and verifies it after reopen", () => {
    const state = setup();
    roots.push(state.root);
    install(state.installations, state.source);

    const produced = produceReservedV10ExtensionPackageManifest({
      installations: state.installations,
      origins: state.origins,
      extensionId: "org.example.worker",
      packageVersion: "Release:2026_08",
      policyDefinitions: [POLICY],
    });

    expect(produced.schemaVersion).toBe("dolly.installed-extension-package/10");
    expect(produced.packageManifest.schemaVersion).toBe("dolly.extension-package/10");
    expect(produced.origin.component_id).toBe("org.example.worker");
    expect(produced.origin.component_digest).toBe(produced.packageDigest);
    expect(produced.policyPremise.definitions).toEqual([POLICY]);
    expect(Object.isFrozen(produced)).toBe(true);
    expect(Object.isFrozen(produced.packageManifest)).toBe(true);
    expect(Object.isFrozen(produced.policyPremise)).toBe(true);
    expect(Object.isFrozen(produced.policyPremise.definitions)).toBe(true);
    const reopenedInstallations = new ExtensionInstallationRegistry({
      directory: state.registryDirectory,
    });
    const reopenedOrigins = new InstalledComponentOriginRegistry({
      directory: state.originsDirectory,
      installations: reopenedInstallations,
    });
    const reopened = produceReservedV10ExtensionPackageManifest({
      installations: reopenedInstallations,
      origins: reopenedOrigins,
      extensionId: "org.example.worker",
      packageVersion: "Release:2026_08",
      policyDefinitions: [POLICY],
    });
    expect(reopened.provenanceDigest).toBe(produced.provenanceDigest);
    assertCurrentReservedV10ExtensionPackageManifest(reopened, {
      installations: reopenedInstallations,
      origins: reopenedOrigins,
      policyDefinitions: [POLICY],
    });
  });

  it("rejects missing, extra, and stale policy definitions before producing", () => {
    const state = setup();
    roots.push(state.root);
    install(state.installations, state.source);
    const extraDefinition = {
      policyId: "extra-policy",
      revision: canonicalJsonDigest({ policyId: "extra-policy", kind: "registered-tools" }),
      definition: { policyId: "extra-policy", kind: "registered-tools" },
    } satisfies ReservedV10ExtensionPackagePolicyDefinition;
    const staleDefinition = {
      policyId: POLICY.policyId,
      revision: canonicalJsonDigest({ ...POLICY_DEFINITION, limits: { maxCalls: 5 } }),
      definition: { ...POLICY_DEFINITION, limits: { maxCalls: 5 } },
    } satisfies ReservedV10ExtensionPackagePolicyDefinition;
    const options = {
      installations: state.installations,
      origins: state.origins,
      extensionId: "org.example.worker",
      packageVersion: "Release:2026_08",
    };

    expectPackageError(() => produceReservedV10ExtensionPackageManifest({
      ...options,
      policyDefinitions: [],
    }));
    expectPackageError(() => produceReservedV10ExtensionPackageManifest({
      ...options,
      policyDefinitions: [POLICY, extraDefinition],
    }));
    expectPackageError(() => produceReservedV10ExtensionPackageManifest({
      ...options,
      policyDefinitions: [staleDefinition],
    }));
  });

  it("rejects copied producer artifacts and stale managed package bytes on reopen", () => {
    const state = setup();
    roots.push(state.root);
    install(state.installations, state.source);
    const produced = produceReservedV10ExtensionPackageManifest({
      installations: state.installations,
      origins: state.origins,
      extensionId: "org.example.worker",
      packageVersion: "Release:2026_08",
      policyDefinitions: [POLICY],
    });
    const copied = { ...produced };
    expectPackageError(() => assertCurrentReservedV10ExtensionPackageManifest(copied, {
      installations: state.installations,
      origins: state.origins,
      policyDefinitions: [POLICY],
    }));

    const resolved = state.installations.resolve({
      extensionId: "org.example.worker",
      packageVersion: "Release:2026_08",
    });
    writeFileSync(resolved.entrypointPath, "export default Object.freeze({ changed: true });\n", "utf8");
    expectPackageError(() => assertCurrentReservedV10ExtensionPackageManifest(produced, {
      installations: state.installations,
      origins: state.origins,
      policyDefinitions: [POLICY],
    }));
  });

  it("keeps package schemas 1 through 4 empty and refusing", () => {
    const versions = [1, 2, 3, 4] as const;
    for (const version of versions) {
      const state = setup();
      roots.push(state.root);
      const module = version === 1
        ? {
            moduleKind: "worker",
            activation: "reactive",
            configVersion: 1,
            configurationSchema: {},
          }
        : moduleDeclaration();
      writePackage(
        state.source,
        packageManifest(`dolly.extension-package/${version}`, [{
          moduleKind: "worker",
          capabilityType: "tool-invocation",
          capabilityVersion: "v2",
          policyId: "read-tools",
          policyRevision: POLICY_REVISION,
        }], [module]),
      );
      expectPackageError(() => install(state.installations, state.source));
    }
  });

  it("rejects a capability version outside the closed vocabulary", () => {
    const state = setup();
    roots.push(state.root);
    writePackage(state.source, packageManifest(
      "dolly.extension-package/10",
      [{
        moduleKind: "worker",
        capabilityType: "tool-invocation",
        capabilityVersion: "v3",
        policyId: "read-tools",
        policyRevision: POLICY_REVISION,
      }],
    ));
    expectPackageError(() => install(state.installations, state.source));
  });

  it("uses the exact policy revision in the package manifest", () => {
    const state = setup();
    roots.push(state.root);
    const wrongRevision = canonicalJsonDigest({ ...POLICY_DEFINITION, limits: { maxCalls: 5 } });
    writePackage(state.source, packageManifest(
      "dolly.extension-package/10",
      [{
        moduleKind: "worker",
        capabilityType: "tool-invocation",
        capabilityVersion: "v2",
        policyId: "read-tools",
        policyRevision: wrongRevision,
      }],
      [moduleDeclaration("read-tools", wrongRevision)],
    ));
    install(state.installations, state.source);
    expectPackageError(() => produceReservedV10ExtensionPackageManifest({
      installations: state.installations,
      origins: state.origins,
      extensionId: "org.example.worker",
      packageVersion: "Release:2026_08",
      policyDefinitions: [POLICY],
    }));
  });
});
