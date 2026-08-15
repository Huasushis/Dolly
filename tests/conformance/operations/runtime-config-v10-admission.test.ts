import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJsonDigest,
  cloneJson,
  type JsonValue,
} from "../../../src/core/canonical-json.js";
import {
  InstanceConfigStore,
} from "../../../src/core/instance-config-store.js";
import {
  createDefaultDollyInstanceConfig,
  dollyInstanceConfigSchema,
} from "../../../src/core/runtime-config.js";
import {
  validateDollyInstanceConfigV10Draft,
} from "../../../src/core/runtime-config-v10.js";
import { DollyInstanceConfigAdmission } from "../../../src/core/instance-config-admission.js";
import { openDollyRuntime } from "../../../src/core/runtime-bootstrap.js";
import { runDollyCli } from "../../../src/entry.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const CONFIGURATION_REVISION = `sha256:${"1".repeat(64)}`;

function scheduler(): Record<string, JsonValue> {
  return {
    pollIntervalMs: 100,
    retryBaseMs: 250,
    retryMaxMs: 30_000,
    maxConcurrentModules: 4,
    backpressureAction: "pause-upstream",
    downstreamRecheckMs: 100,
    noProgressAfterMs: 5_000,
    retryJitterBasisPoints: 0,
    lowWatermarkBasisPoints: 10_000,
    policy: { kind: "fixed" },
    policyFailureAction: "quarantine",
  };
}

function execution(): Record<string, JsonValue> {
  return {
    kind: "linux-process",
    isolation: "process",
    limits: {
      memoryMaxBytes: 64 * 1_024 * 1_024,
      maxTasks: 32,
      cpuQuotaMicros: 100_000,
      cpuPeriodMicros: 100_000,
      maxOpenFiles: 128,
    },
  };
}

function reactiveModule(
  overrides: Readonly<Record<string, JsonValue>> = {},
): Record<string, JsonValue> {
  return {
    moduleId: "worker",
    extensionId: "org.example.worker",
    packageVersion: "1.0.0",
    moduleKind: "transform",
    configurationReference: {
      configId: "worker-default",
      revision: CONFIGURATION_REVISION,
      configVersion: 1,
    },
    permissionPolicyReferences: [],
    inputConnections: [{ pageId: "input", start: { checkpoint: "0" } }],
    outputPageIds: ["output"],
    activation: { kind: "reactive" },
    declaredExternalEffects: "none",
    execution: execution(),
    limits: {
      claim: {
        baselineCount: 2,
        baselineBytes: 1_024,
        maxCount: 4,
        maxBytes: 4_096,
      },
      mailbox: { maxResidentCount: 16, maxResidentBytes: 64 * 1_024 },
      sourceRequestMaxBytes: null,
      maxInputBytes: 4_096,
      maxResultBytes: 4_096,
      maxFrameBytes: 8_192,
      maxRunsPerGeneration: 100,
      maxGenerations: 10,
    },
    timeouts: {
      initializationTimeoutMs: 10_000,
      executionTimeoutMs: 30_000,
      cancellationGraceMs: 1_000,
      terminationTimeoutMs: 2_000,
    },
    ...overrides,
  };
}

function configuration(
  modules: readonly JsonValue[] = [reactiveModule()],
  pages: readonly JsonValue[] = [
    { pageId: "input" },
    { pageId: "output" },
  ],
): Record<string, JsonValue> {
  const version9 = createDefaultDollyInstanceConfig(INSTANCE_ID);
  return {
    schemaVersion: "dolly.instance/10",
    instanceId: INSTANCE_ID,
    displayName: "Dolly v10 draft",
    stateDirectory: null,
    core: {
      limits: {
        ...version9.core.limits,
        maxRegisteredContentValueBytes: 64 * 1_024,
      },
      media: version9.core.media,
      scheduler: scheduler(),
    },
    pages,
    modules,
    logging: version9.logging,
  };
}

interface Sandbox {
  readonly root: string;
  readonly registryDirectory: string;
  readonly defaultStateRoot: string;
  readonly configPath: string;
  cleanup(): void;
}

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "dolly-v10-admission-"));
  const registryDirectory = join(root, "registry");
  const defaultStateRoot = join(root, "state");
  const projectDirectory = join(root, "project");
  mkdirSync(projectDirectory, { recursive: true });
  return {
    root,
    registryDirectory,
    defaultStateRoot,
    configPath: join(projectDirectory, "dolly.example.json"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function capture(): { text: string; write(text: string): void } {
  const sink = {
    text: "",
    write(text: string): void {
      sink.text += text;
    },
  };
  return sink;
}

describe("dolly.instance/10 product configuration admission", () => {
  it("config show admits a complete no-Module version 10 document with zero durable mutations", async () => {
    const box = sandbox();
    try {
      writeFileSync(box.configPath, JSON.stringify(configuration([])));
      const stdout = capture();
      const stderr = capture();
      const code = await runDollyCli(["config", "show", "--config", box.configPath], {
        directories: {
          registryDirectory: box.registryDirectory,
          defaultStateRoot: box.defaultStateRoot,
        },
        stdout,
        stderr,
      });
      expect(code).toBe(0);
      expect(stderr.text).toBe("");
      expect(JSON.parse(stdout.text)).toEqual(configuration([]));
      expect(existsSync(join(box.registryDirectory, "controllers"))).toBe(false);
      expect(existsSync(join(box.registryDirectory, "instances"))).toBe(false);
      expect(existsSync(join(box.defaultStateRoot, INSTANCE_ID))).toBe(false);
    } finally {
      box.cleanup();
    }
  });

  it("admission inspect reports schemaVersion dolly.instance/10 and preserves every version-10-only field", () => {
    const box = sandbox();
    try {
      writeFileSync(box.configPath, JSON.stringify(configuration([])));
      const admission = new DollyInstanceConfigAdmission({
        registryDirectory: box.registryDirectory,
        defaultStateRoot: box.defaultStateRoot,
      });
      const loaded = admission.inspect(box.configPath);
      expect(loaded.schemaVersion).toBe("dolly.instance/10");
      expect(loaded.document.schemaVersion).toBe("dolly.instance/10");
      const raw = configuration([]);
      const rawLimits = (raw.core as Record<string, JsonValue>)
        .limits as Record<string, JsonValue>;
      expect(loaded.document.core.limits.maxRegisteredContentValueBytes).toBe(
        rawLimits.maxRegisteredContentValueBytes,
      );
      expect(loaded.document.core.scheduler.policy).toEqual({ kind: "fixed" });
      expect(loaded.document.core.scheduler.maxConcurrentModules).toBe(4);
      expect(loaded.redactedDocument).toEqual(raw);
      expect(loaded.configRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(loaded.configRevision).toBe(canonicalJsonDigest(loaded.document));
    } finally {
      box.cleanup();
    }
  });

  it("configRevision binds every version-10-only field, so changing one changes the revision", () => {
    const box = sandbox();
    try {
      const admission = new DollyInstanceConfigAdmission({
        registryDirectory: box.registryDirectory,
        defaultStateRoot: box.defaultStateRoot,
      });
      writeFileSync(box.configPath, JSON.stringify(configuration([])));
      const base = admission.inspect(box.configPath).configRevision;
      const mutated = cloneJson(configuration([]));
      const mutatedLimits = (mutated.core as Record<string, JsonValue>)
        .limits as Record<string, JsonValue>;
      mutatedLimits.maxRegisteredContentValueBytes = 128 * 1_024;
      writeFileSync(box.configPath, JSON.stringify(mutated));
      const changed = admission.inspect(box.configPath).configRevision;
      expect(changed).not.toBe(base);
      expect(changed).toBe(
        canonicalJsonDigest(
          validateDollyInstanceConfigV10Draft(
            mutated as unknown as JsonValue,
          ),
        ),
      );
    } finally {
      box.cleanup();
    }
  });

  it("openDollyRuntime admits a no-Module version 10 document end to end", async () => {
    const box = sandbox();
    try {
      writeFileSync(box.configPath, JSON.stringify(configuration([])));
      const session = await openDollyRuntime({
        configPath: box.configPath,
        registryDirectory: box.registryDirectory,
        defaultStateRoot: box.defaultStateRoot,
      });
      expect(session.config.schemaVersion).toBe("dolly.instance/10");
      expect(session.config.document.modules).toEqual([]);
      await session.stop();
    } finally {
      box.cleanup();
    }
  });

  it("openDollyRuntime refuses a Module-bearing version 10 document before creating the controller lock", async () => {
    const box = sandbox();
    try {
      writeFileSync(box.configPath, JSON.stringify(configuration([reactiveModule()])));
      await expect(
        openDollyRuntime({
          configPath: box.configPath,
          registryDirectory: box.registryDirectory,
          defaultStateRoot: box.defaultStateRoot,
        }),
      ).rejects.toMatchObject({
        code: "RUNTIME_MODULE_MIGRATION_REQUIRED",
        name: "RuntimeBootstrapError",
      });
      expect(existsSync(join(box.registryDirectory, "controllers"))).toBe(false);
      expect(existsSync(join(box.registryDirectory, "instances"))).toBe(false);
      expect(existsSync(join(box.defaultStateRoot, INSTANCE_ID))).toBe(false);
    } finally {
      box.cleanup();
    }
  });

  it("dolly run refuses a Module-bearing version 10 document with no durable writes", async () => {
    const box = sandbox();
    try {
      writeFileSync(box.configPath, JSON.stringify(configuration([reactiveModule()])));
      const stderr = capture();
      const code = await runDollyCli(["run", "--config", box.configPath], {
        directories: {
          registryDirectory: box.registryDirectory,
          defaultStateRoot: box.defaultStateRoot,
        },
        stderr,
      });
      expect(code).toBe(1);
      expect(stderr.text).toContain("RUNTIME_MODULE_MIGRATION_REQUIRED");
      expect(existsSync(join(box.registryDirectory, "controllers"))).toBe(false);
      expect(existsSync(join(box.registryDirectory, "instances"))).toBe(false);
      expect(existsSync(join(box.defaultStateRoot, INSTANCE_ID))).toBe(false);
    } finally {
      box.cleanup();
    }
  });

  it("version 9 documents are still admitted as dolly.instance/9 with an unchanged configRevision", () => {
    const box = sandbox();
    try {
      const v9 = createDefaultDollyInstanceConfig(INSTANCE_ID);
      writeFileSync(box.configPath, JSON.stringify(v9));
      const admission = new DollyInstanceConfigAdmission({
        registryDirectory: box.registryDirectory,
        defaultStateRoot: box.defaultStateRoot,
      });
      const loaded = admission.inspect(box.configPath);
      expect(loaded.schemaVersion).toBe("dolly.instance/9");
      expect(loaded.configRevision).toBe(canonicalJsonDigest(v9));
    } finally {
      box.cleanup();
    }
  });

  it("a document invalid under both dialects reports the identical version-9 error deterministically", () => {
    const box = sandbox();
    try {
      const admission = new DollyInstanceConfigAdmission({
        registryDirectory: box.registryDirectory,
        defaultStateRoot: box.defaultStateRoot,
      });
      const version9 = new InstanceConfigStore({
        schema: dollyInstanceConfigSchema,
        registryDirectory: box.registryDirectory,
        defaultStateRoot: box.defaultStateRoot,
      });
const unversioned = configuration([]);
      unversioned.schemaVersion = "dolly.instance/7";
      const broken = cloneJson(configuration([]));
      const brokenCore = broken.core as Record<string, JsonValue>;
      delete (brokenCore.limits as Record<string, JsonValue>)
        .maxRegisteredContentValueBytes;
      broken.core = brokenCore;
      const extraFieldDocument = cloneJson(
        createDefaultDollyInstanceConfig(INSTANCE_ID),
      ) as unknown as Record<string, JsonValue>;
      extraFieldDocument.extra = 1;
      const invalidDocuments: Array<Record<string, JsonValue>> = [
        unversioned,
        broken,
        extraFieldDocument,
      ];
      for (const document of invalidDocuments) {
        writeFileSync(box.configPath, JSON.stringify(document));
        const directError = (() => {
          try {
            version9.inspect(box.configPath);
            throw new Error("expected version-9 rejection");
          } catch (error) {
            return error as Error;
          }
        })();
        const admissionError = (() => {
          try {
            admission.inspect(box.configPath);
            throw new Error("expected admission rejection");
          } catch (error) {
            return error as Error;
          }
        })();
        expect(admissionError).toMatchObject({ code: "CONFIG_DOCUMENT_INVALID" });
        expect(admissionError.message).toBe(directError.message);
        const again = (() => {
          try {
            admission.inspect(box.configPath);
            throw new Error("expected admission rejection");
          } catch (error) {
            return error as Error;
          }
        })();
        expect(again.message).toBe(admissionError.message);
      }
    } finally {
      box.cleanup();
    }
  });
});