import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExtensionInstallationError,
  ExtensionInstallationRegistry,
  type ExtensionInstallationErrorCode,
  type ExtensionInstallationRegistryOptions,
} from "../../../src/core/extension-installation-registry.js";
import { JSON_SCHEMA_2020_12 } from "../../../src/core/json-schema.js";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";

const CONTENT_VALIDATOR = {
  $schema: JSON_SCHEMA_2020_12,
  type: "object",
  required: ["value"],
  properties: { value: { type: "string", maxLength: 64 } },
  additionalProperties: false,
} as const;

function moduleDeclaration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    moduleKind: "transform",
    activation: "reactive",
    configVersion: 1,
    configurationSchema: {
      $schema: JSON_SCHEMA_2020_12,
      type: "object",
      properties: {
        message: { type: "string", maxLength: 128 },
      },
      additionalProperties: false,
    },
    ...overrides,
  };
}

function moduleDeclarationV2(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return moduleDeclaration({
    producedContentSchemas: [{
      schema: "org.example.transform.result/1",
      validator: CONTENT_VALIDATOR,
      validatorDigest: canonicalJsonDigest(CONTENT_VALIDATOR),
      maxValueBytes: 1024,
      containsCoreReferences: false,
    }],
    ...overrides,
  });
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

function expectInstallationError(
  operation: () => unknown,
  code: ExtensionInstallationErrorCode,
): ExtensionInstallationError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ExtensionInstallationError);
    expect((error as ExtensionInstallationError).code).toBe(code);
    return error as ExtensionInstallationError;
  }
  throw new Error(`Expected ${code}`);
}

describe("static Extension installation registry", () => {
  let temporaryRoot: string;
  let sourceDirectory: string;
  let registryDirectory: string;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "dolly-extension-installation-"));
    sourceDirectory = join(temporaryRoot, "source");
    registryDirectory = join(temporaryRoot, "registry");
    writePackage(sourceDirectory);
  });

  afterEach(() => {
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function registry(
    overrides: Partial<ExtensionInstallationRegistryOptions> = {},
  ): ExtensionInstallationRegistry {
    return new ExtensionInstallationRegistry({
      directory: registryDirectory,
      ...overrides,
    });
  }

  it("installs ordinary files, reopens them by identity, and repeats the same install", () => {
    const firstRegistry = registry();
    const first = firstRegistry.installNodePackage({
      sourceDirectory,
      trust: "trusted",
    });
    const repeated = firstRegistry.installNodePackage({
      sourceDirectory,
      trust: "trusted",
    });
    const reopened = registry().resolve({
      extensionId: "org.example.transform",
      packageVersion: "Release:2026_07",
    });

    expect(repeated).toEqual(first);
    expect(reopened).toEqual(first);
    expect(first.packageDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(basename(first.workingDirectory)).toBe(first.packageDigest.slice("sha256:".length));
    expect(isAbsolute(first.workingDirectory)).toBe(true);
    expect(isAbsolute(first.entrypointPath)).toBe(true);
    expect(relative(first.workingDirectory, first.entrypointPath)).toBe(join("dist", "main.mjs"));
    expect(readFileSync(first.entrypointPath, "utf8")).toContain("Object.freeze");
    expect(first.manifest.packageVersion).toBe("Release:2026_07");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.manifest)).toBe(true);
    expect(Object.isFrozen(first.manifest.modules)).toBe(true);
    expect(Object.isFrozen(first.manifest.modules[0]?.configurationSchema)).toBe(true);

    const recordNames = readdirSync(join(registryDirectory, "records"));
    expect(recordNames).toHaveLength(1);
    expect(recordNames[0]).toMatch(/^[0-9a-f]{64}\.json$/u);
    const recordPath = join(registryDirectory, "records", recordNames[0]!);
    const recordText = readFileSync(recordPath, "utf8");
    const record = JSON.parse(recordText) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual([
      "extensionId",
      "files",
      "packageDigest",
      "packageVersion",
      "schemaVersion",
      "trust",
    ]);
    expect(record).toMatchObject({
      schemaVersion: "dolly.extension-installation/1",
      extensionId: "org.example.transform",
      packageVersion: "Release:2026_07",
      trust: "trusted",
      packageDigest: first.packageDigest,
    });
    expect(recordText).not.toMatch(/"(?:command|args|cwd|workingDirectory)"/u);

    if (process.platform !== "win32") {
      for (const privatePath of [
        registryDirectory,
        join(registryDirectory, "packages"),
        join(registryDirectory, "records"),
        join(registryDirectory, "locks"),
        first.workingDirectory,
        first.entrypointPath,
        recordPath,
      ]) {
        expect(statSync(privatePath).mode & 0o077, privatePath).toBe(0);
      }
    }
  });

  it("accepts a relative POSIX entrypoint with Unicode path segments", () => {
    const entrypoint = "module/入口.mjs";
    mkdirSync(join(sourceDirectory, "module"));
    writeFileSync(join(sourceDirectory, "module", "入口.mjs"), "export default {};\n", "utf8");
    writeFileSync(
      join(sourceDirectory, "dolly-extension.json"),
      `${JSON.stringify(packageManifest({ entrypoint }), null, 2)}\n`,
      "utf8",
    );

    const installed = registry().installNodePackage({ sourceDirectory, trust: "trusted" });

    expect(installed.manifest.entrypoint).toBe(entrypoint);
    expect(readFileSync(installed.entrypointPath, "utf8")).toContain("export default");
  });

  it("rejects a different trust value or different bytes for an installed identity", () => {
    const installationRegistry = registry();
    installationRegistry.installNodePackage({ sourceDirectory, trust: "trusted" });

    expectInstallationError(
      () => installationRegistry.installNodePackage({
        sourceDirectory,
        trust: "untrusted",
      }),
      "EXTENSION_INSTALLATION_CONFLICT",
    );

    writeFileSync(join(sourceDirectory, "dist", "main.mjs"), "export default 'changed';\n");
    expectInstallationError(
      () => installationRegistry.installNodePackage({ sourceDirectory, trust: "trusted" }),
      "EXTENSION_INSTALLATION_CONFLICT",
    );
  });

  it("detects changed managed package bytes on every resolution", () => {
    const installationRegistry = registry();
    const installed = installationRegistry.installNodePackage({
      sourceDirectory,
      trust: "trusted",
    });
    writeFileSync(installed.entrypointPath, "export default 'tampered';\n", "utf8");

    expectInstallationError(
      () => registry().resolve({
        extensionId: installed.manifest.extensionId,
        packageVersion: installed.manifest.packageVersion,
      }),
      "EXTENSION_INSTALLATION_TAMPERED",
    );
  });

  it("strictly rejects an installation record with an added command", () => {
    const installationRegistry = registry();
    installationRegistry.installNodePackage({ sourceDirectory, trust: "trusted" });
    const recordName = readdirSync(join(registryDirectory, "records"))[0]!;
    const recordPath = join(registryDirectory, "records", recordName);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    record.command = "node";
    writeFileSync(recordPath, JSON.stringify(record), "utf8");

    expectInstallationError(
      () => registry().resolve({
        extensionId: "org.example.transform",
        packageVersion: "Release:2026_07",
      }),
      "EXTENSION_INSTALLATION_TAMPERED",
    );
  });

  it("treats a changed installation-record identity as tampering during reinstall", () => {
    const installationRegistry = registry();
    installationRegistry.installNodePackage({ sourceDirectory, trust: "trusted" });
    const recordName = readdirSync(join(registryDirectory, "records"))[0]!;
    const recordPath = join(registryDirectory, "records", recordName);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    record.extensionId = "org.example.other";
    writeFileSync(recordPath, JSON.stringify(record), "utf8");

    expectInstallationError(
      () => installationRegistry.installNodePackage({ sourceDirectory, trust: "trusted" }),
      "EXTENSION_INSTALLATION_TAMPERED",
    );
  });

  it("rejects duplicate JSON object keys before installation", () => {
    const manifestText = JSON.stringify(packageManifest());
    const duplicateKeyText = manifestText.replace(
      '"extensionId":"org.example.transform"',
      '"extensionId":"org.example.transform","extensionId":"org.example.other"',
    );
    expect(duplicateKeyText).not.toBe(manifestText);
    writeFileSync(join(sourceDirectory, "dolly-extension.json"), duplicateKeyText, "utf8");

    expectInstallationError(
      () => registry().installNodePackage({ sourceDirectory, trust: "trusted" }),
      "EXTENSION_PACKAGE_INVALID",
    );
  });

  it.each([
    ["an unknown root field", { launch: { command: "node", args: ["dist/main.mjs"] } }],
    ["an old schema version", { schemaVersion: "dolly.extension-package/0" }],
  ])("rejects a manifest with %s", (_label, overrides) => {
    writePackage(sourceDirectory, overrides);
    expectInstallationError(
      () => registry().installNodePackage({ sourceDirectory, trust: "trusted" }),
      "EXTENSION_PACKAGE_INVALID",
    );
  });

  it("rejects invalid Draft 2020-12 JSON Schema", () => {
    writePackage(sourceDirectory, {
      modules: [moduleDeclaration({
        configurationSchema: {
          $schema: JSON_SCHEMA_2020_12,
          type: "not-a-json-schema-type",
        },
      })],
    });

    expectInstallationError(
      () => registry().installNodePackage({ sourceDirectory, trust: "trusted" }),
      "EXTENSION_PACKAGE_INVALID",
    );
  });

  it.each([
    ["a duplicate module kind", { modules: [moduleDeclaration(), moduleDeclaration()] }],
    ["non-reactive activation", { modules: [moduleDeclaration({ activation: "periodic" })] }],
    ["a requested capability", { requestedCapabilities: ["network"] }],
  ])("rejects %s in package schema version 1", (_label, overrides) => {
    writePackage(sourceDirectory, overrides);
    expectInstallationError(
      () => registry().installNodePackage({ sourceDirectory, trust: "trusted" }),
      "EXTENSION_PACKAGE_INVALID",
    );
  });

  it("installs and reopens the complete package schema version 2 declaration", () => {
    writePackage(sourceDirectory, {
      schemaVersion: "dolly.extension-package/2",
      modules: [moduleDeclarationV2()],
    });

    const installed = registry().installNodePackage({
      sourceDirectory,
      trust: "trusted",
    });
    const reopened = registry().resolve({
      extensionId: "org.example.transform",
      packageVersion: "Release:2026_07",
    });

    expect(reopened).toEqual(installed);
    expect(installed.manifest.schemaVersion).toBe("dolly.extension-package/2");
    if (installed.manifest.schemaVersion !== "dolly.extension-package/2") {
      throw new Error("Expected package schema version 2");
    }
    expect(installed.manifest.modules[0]?.producedContentSchemas).toEqual([
      expect.objectContaining({
        schema: "org.example.transform.result/1",
        validatorDigest: canonicalJsonDigest(CONTENT_VALIDATOR),
        maxValueBytes: 1024,
        containsCoreReferences: false,
      }),
    ]);
    expect(Object.isFrozen(
      installed.manifest.modules[0]?.producedContentSchemas,
    )).toBe(true);
  });

  it.each([
    ["a version 1-only Module shape", moduleDeclaration()],
    ["an invalid schema name", moduleDeclarationV2({
      producedContentSchemas: [{
        schema: "invalid",
        validator: CONTENT_VALIDATOR,
        validatorDigest: canonicalJsonDigest(CONTENT_VALIDATOR),
        maxValueBytes: 1024,
        containsCoreReferences: false,
      }],
    })],
    ["a schema outside the package namespace", moduleDeclarationV2({
      producedContentSchemas: [{
        schema: "org.other.result/1",
        validator: CONTENT_VALIDATOR,
        validatorDigest: canonicalJsonDigest(CONTENT_VALIDATOR),
        maxValueBytes: 1024,
        containsCoreReferences: false,
      }],
    })],
    ["a reserved schema", moduleDeclarationV2({
      producedContentSchemas: [{
        schema: "dolly.result/1",
        validator: CONTENT_VALIDATOR,
        validatorDigest: canonicalJsonDigest(CONTENT_VALIDATOR),
        maxValueBytes: 1024,
        containsCoreReferences: false,
      }],
    })],
    ["duplicate schema names", moduleDeclarationV2({
      producedContentSchemas: [
        {
          schema: "org.example.transform.result/1",
          validator: CONTENT_VALIDATOR,
          validatorDigest: canonicalJsonDigest(CONTENT_VALIDATOR),
          maxValueBytes: 1024,
          containsCoreReferences: false,
        },
        {
          schema: "org.example.transform.result/1",
          validator: CONTENT_VALIDATOR,
          validatorDigest: canonicalJsonDigest(CONTENT_VALIDATOR),
          maxValueBytes: 1024,
          containsCoreReferences: false,
        },
      ],
    })],
    ["an invalid validator", moduleDeclarationV2({
      producedContentSchemas: [{
        schema: "org.example.transform.result/1",
        validator: { $schema: JSON_SCHEMA_2020_12, type: "invalid" },
        validatorDigest: canonicalJsonDigest({
          $schema: JSON_SCHEMA_2020_12,
          type: "invalid",
        }),
        maxValueBytes: 1024,
        containsCoreReferences: false,
      }],
    })],
    ["a changed validator digest", moduleDeclarationV2({
      producedContentSchemas: [{
        schema: "org.example.transform.result/1",
        validator: CONTENT_VALIDATOR,
        validatorDigest: `sha256:${"0".repeat(64)}`,
        maxValueBytes: 1024,
        containsCoreReferences: false,
      }],
    })],
    ["a non-positive value limit", moduleDeclarationV2({
      producedContentSchemas: [{
        schema: "org.example.transform.result/1",
        validator: CONTENT_VALIDATOR,
        validatorDigest: canonicalJsonDigest(CONTENT_VALIDATOR),
        maxValueBytes: 0,
        containsCoreReferences: false,
      }],
    })],
    ["an undeclared Core-reference extractor", moduleDeclarationV2({
      producedContentSchemas: [{
        schema: "org.example.transform.result/1",
        validator: CONTENT_VALIDATOR,
        validatorDigest: canonicalJsonDigest(CONTENT_VALIDATOR),
        maxValueBytes: 1024,
        containsCoreReferences: true,
      }],
    })],
  ])("rejects package schema version 2 with %s", (_label, declaration) => {
    writePackage(sourceDirectory, {
      schemaVersion: "dolly.extension-package/2",
      modules: [declaration],
    });

    expectInstallationError(
      () => registry().installNodePackage({ sourceDirectory, trust: "trusted" }),
      "EXTENSION_PACKAGE_INVALID",
    );
  });

  it("does not accept package schema version 2 fields in version 1", () => {
    writePackage(sourceDirectory, { modules: [moduleDeclarationV2()] });

    expectInstallationError(
      () => registry().installNodePackage({ sourceDirectory, trust: "trusted" }),
      "EXTENSION_PACKAGE_INVALID",
    );
  });

  it("keeps requested capabilities closed in package schema version 2", () => {
    writePackage(sourceDirectory, {
      schemaVersion: "dolly.extension-package/2",
      modules: [moduleDeclarationV2()],
      requestedCapabilities: ["network"],
    });

    expectInstallationError(
      () => registry().installNodePackage({ sourceDirectory, trust: "trusted" }),
      "EXTENSION_PACKAGE_INVALID",
    );
  });

  it.each([
    "../outside.mjs",
    "/outside.mjs",
    "C:/outside.mjs",
    "dist\\main.mjs",
    "./dist/main.mjs",
    "dist/main.js",
    "dist/missing.mjs",
  ])("rejects unsafe or missing entrypoint %s", (entrypoint) => {
    writePackage(sourceDirectory, { entrypoint });
    expectInstallationError(
      () => registry().installNodePackage({ sourceDirectory, trust: "trusted" }),
      "EXTENSION_PACKAGE_PATH_INVALID",
    );
  });

  const linuxOnly = process.platform === "linux" ? it : it.skip;

  linuxOnly("rejects a symbolic-link entrypoint on Linux", () => {
    const entrypointPath = join(sourceDirectory, "dist", "main.mjs");
    const outsidePath = join(temporaryRoot, "outside.mjs");
    writeFileSync(outsidePath, "export default 'outside';\n", "utf8");
    rmSync(entrypointPath);
    symlinkSync(outsidePath, entrypointPath, "file");
    expect(lstatSync(entrypointPath).isSymbolicLink()).toBe(true);

    expectInstallationError(
      () => registry().installNodePackage({ sourceDirectory, trust: "trusted" }),
      "EXTENSION_PACKAGE_PATH_INVALID",
    );
  });

  linuxOnly("rejects paths that differ only by case on Linux", () => {
    writeFileSync(join(sourceDirectory, "README.txt"), "upper\n", "utf8");
    writeFileSync(join(sourceDirectory, "readme.txt"), "lower\n", "utf8");

    expectInstallationError(
      () => registry().installNodePackage({ sourceDirectory, trust: "trusted" }),
      "EXTENSION_PACKAGE_PATH_INVALID",
    );
  });

  linuxOnly("treats a dangling installation-record link as tampering on Linux", () => {
    const installationRegistry = registry();
    installationRegistry.installNodePackage({ sourceDirectory, trust: "trusted" });
    const recordName = readdirSync(join(registryDirectory, "records"))[0]!;
    const recordPath = join(registryDirectory, "records", recordName);
    rmSync(recordPath);
    symlinkSync(join(temporaryRoot, "missing-record.json"), recordPath, "file");

    expectInstallationError(
      () => installationRegistry.resolve({
        extensionId: "org.example.transform",
        packageVersion: "Release:2026_07",
      }),
      "EXTENSION_INSTALLATION_TAMPERED",
    );
  });

  it("enforces the manifest byte limit and removes its own temporary directory", () => {
    const manifestBytes = statSync(join(sourceDirectory, "dolly-extension.json")).size;
    expectInstallationError(
      () => registry({ maxManifestBytes: manifestBytes - 1 }).installNodePackage({
        sourceDirectory,
        trust: "trusted",
      }),
      "EXTENSION_PACKAGE_LIMIT_EXCEEDED",
    );
    expect(readdirSync(join(registryDirectory, "packages"))).toEqual([]);
  });

  it("enforces the JSON nesting limit", () => {
    expectInstallationError(
      () => registry({ maxManifestDepth: 2 }).installNodePackage({
        sourceDirectory,
        trust: "trusted",
      }),
      "EXTENSION_PACKAGE_INVALID",
    );
    expect(readdirSync(join(registryDirectory, "packages"))).toEqual([]);
  });

  it("enforces the ordinary-file count limit", () => {
    expectInstallationError(
      () => registry({ maxFileCount: 1 }).installNodePackage({
        sourceDirectory,
        trust: "trusted",
      }),
      "EXTENSION_PACKAGE_LIMIT_EXCEEDED",
    );
    expect(readdirSync(join(registryDirectory, "packages"))).toEqual([]);
  });

  it("enforces the per-file byte limit", () => {
    const manifestBytes = statSync(join(sourceDirectory, "dolly-extension.json")).size;
    writeFileSync(join(sourceDirectory, "dist", "main.mjs"), Buffer.alloc(manifestBytes + 1, 0x61));
    expectInstallationError(
      () => registry({ maxFileBytes: manifestBytes }).installNodePackage({
        sourceDirectory,
        trust: "trusted",
      }),
      "EXTENSION_PACKAGE_LIMIT_EXCEEDED",
    );
    expect(readdirSync(join(registryDirectory, "packages"))).toEqual([]);
  });

  it("enforces the total package byte limit", () => {
    const totalBytes =
      statSync(join(sourceDirectory, "dolly-extension.json")).size +
      statSync(join(sourceDirectory, "dist", "main.mjs")).size;
    expectInstallationError(
      () => registry({ maxPackageBytes: totalBytes - 1 }).installNodePackage({
        sourceDirectory,
        trust: "trusted",
      }),
      "EXTENSION_PACKAGE_LIMIT_EXCEEDED",
    );
    expect(readdirSync(join(registryDirectory, "packages"))).toEqual([]);
  });
});
