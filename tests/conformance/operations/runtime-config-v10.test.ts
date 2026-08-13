import { describe, expect, it, vi } from "vitest";
import { cloneJson, type JsonValue } from "../../../src/core/canonical-json.js";
import {
  composeReservedV10ReactiveModuleHost,
  type ManagedReactiveModuleRuntime,
} from "../../../src/core/reactive-module-host.js";
import {
  deriveDollyInstanceV10SchedulerPlan,
  planDollyInstanceConfigV10Migration,
  validateDollyInstanceConfigV10Draft,
} from "../../../src/core/runtime-config-v10.js";
import {
  createDefaultDollyInstanceConfig,
  dollyInstanceConfigSchema,
  validateDollyInstanceConfig,
} from "../../../src/core/runtime-config.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const CONFIGURATION_REVISION = `sha256:${"1".repeat(64)}`;
const POLICY_REVISION = `sha256:${"2".repeat(64)}`;
const SOURCE_REVISION = `sha256:${"3".repeat(64)}`;

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

function sourceModule(
  overrides: Readonly<Record<string, JsonValue>> = {},
): Record<string, JsonValue> {
  const base = reactiveModule({
    moduleId: "source",
    extensionId: "org.example.source",
    configurationReference: {
      configId: "source-default",
      revision: CONFIGURATION_REVISION,
      configVersion: 1,
    },
    inputConnections: [],
    activation: { kind: "source", trigger: "manual" },
    limits: {
      claim: {
        baselineCount: 1,
        baselineBytes: 1_024,
        maxCount: 1,
        maxBytes: 4_096,
      },
      mailbox: { maxResidentCount: 4, maxResidentBytes: 8_192 },
      sourceRequestMaxBytes: 2_048,
      maxInputBytes: 4_096,
      maxResultBytes: 4_096,
      maxFrameBytes: 8_192,
      maxRunsPerGeneration: 100,
      maxGenerations: 10,
    },
  });
  return { ...base, ...overrides };
}

function configuration(
  modules: readonly JsonValue[] = [reactiveModule()],
  pages: readonly JsonValue[] = [{ pageId: "input" }, { pageId: "output" }],
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

function version9ModuleConfiguration() {
  const base = createDefaultDollyInstanceConfig(INSTANCE_ID);
  return validateDollyInstanceConfig({
    ...base,
    pages: [
      { pageId: "input-a" },
      { pageId: "input-b" },
      { pageId: "output" },
    ],
    modules: [{
      moduleId: "worker",
      extensionId: "org.example.worker",
      packageVersion: "1.0.0",
      moduleKind: "transform",
      isolation: "process",
      configurationReference: {
        configId: "worker-default",
        revision: CONFIGURATION_REVISION,
        configVersion: 1,
      },
      permissionPolicyIds: ["model.primary"],
      inputPageIds: ["input-a", "input-b"],
      outputPageIds: ["output"],
      subscriptionStart: "from-now",
      activation: { kind: "reactive" },
      limits: {
        claim: { maxCount: 4, maxBytes: 4_096 },
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
    }],
  });
}

function immediateSchedulerClock() {
  return {
    monotonicNow: () => 0,
    schedule: (delayMs: number, callback: () => void) => {
      let cancelled = false;
      if (delayMs === 0) {
        queueMicrotask(() => {
          if (!cancelled) callback();
        });
      }
      return {
        cancel: () => {
          cancelled = true;
        },
      };
    },
  };
}

function version9SourceModuleConfiguration() {
  const base = createDefaultDollyInstanceConfig(INSTANCE_ID);
  return validateDollyInstanceConfig({
    ...base,
    pages: [{ pageId: "output" }],
    modules: [{
      moduleId: "source",
      extensionId: "org.example.source",
      packageVersion: "1.0.0",
      moduleKind: "source",
      isolation: "process",
      configurationReference: {
        configId: "source-default",
        revision: CONFIGURATION_REVISION,
        configVersion: 1,
      },
      permissionPolicyIds: [],
      inputPageIds: [],
      outputPageIds: ["output"],
      subscriptionStart: "from-head",
      activation: { kind: "source", trigger: "manual" },
      limits: {
        claim: null,
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
    }],
  });
}

function migrationInput(
  overrides: Readonly<Record<string, JsonValue>> = {},
): Record<string, JsonValue> {
  return {
    schemaVersion: "dolly.instance-v10-migration-input/1",
    expectedSourceRevision: SOURCE_REVISION,
    maxRegisteredContentValueBytes: 64 * 1_024,
    scheduler: scheduler(),
    modules: [{
      moduleId: "worker",
      claimBaseline: { count: 2, bytes: 1_024 },
      mailbox: { maxResidentCount: 16, maxResidentBytes: 64 * 1_024 },
      sourceRequestMaxBytes: null,
      execution: execution(),
      declaredExternalEffects: "core-capabilities-only",
      permissionPolicyReferences: [{
        policyId: "model.primary",
        revision: POLICY_REVISION,
      }],
    }],
    ...overrides,
  };
}

function sourceSnapshot(document = version9ModuleConfiguration()) {
  return { document, configRevision: SOURCE_REVISION };
}

describe("reserved Dolly instance version 10 configuration", () => {
  it("validates the complete closed shape but does not register it as product schema", () => {
    const raw = configuration();
    const validated = validateDollyInstanceConfigV10Draft(raw);

    expect(validated.schemaVersion).toBe("dolly.instance/10");
    expect(validated.modules[0]).toMatchObject({
      inputConnections: [{ pageId: "input", start: { checkpoint: "0" } }],
      limits: {
        claim: { baselineCount: 2, maxCount: 4 },
        mailbox: { maxResidentCount: 16 },
      },
      execution: { kind: "linux-process" },
    });
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.modules[0]!.inputConnections[0]!.start)).toBe(true);
    expect(dollyInstanceConfigSchema.schemaVersion).toBe("dolly.instance/9");
    expect(() => validateDollyInstanceConfig(raw)).toThrow(/schemaVersion is unsupported/u);
  });

  it.each([
    {
      label: "top-level alias",
      mutate: (base: Record<string, JsonValue>) => ({ ...base, subscriptionStart: "from-now" }),
    },
    {
      label: "Scheduler extension",
      mutate: (base: Record<string, JsonValue>) => {
        const core = base.core as Record<string, JsonValue>;
        return { ...base, core: { ...core, scheduler: { ...scheduler(), seed: 1 } } };
      },
    },
    {
      label: "version-9 Module route alias",
      mutate: (base: Record<string, JsonValue>) => ({
        ...base,
        modules: [{ ...reactiveModule(), inputPageIds: ["input"] }],
      }),
    },
    {
      label: "old Linux task name",
      mutate: (base: Record<string, JsonValue>) => ({
        ...base,
        modules: [reactiveModule({
          execution: {
            kind: "linux-process",
            isolation: "process",
            limits: {
              memoryMaxBytes: 64 * 1_024 * 1_024,
              maxProcesses: 32,
              cpuQuotaMicros: 100_000,
              cpuPeriodMicros: 100_000,
              maxOpenFiles: 128,
            },
          },
        })],
      }),
    },
  ])("rejects the $label instead of accepting aliases", ({ mutate }) => {
    expect(() => validateDollyInstanceConfigV10Draft(
      mutate(configuration()) as JsonValue,
    )).toThrow(/unknown fields|missing fields/u);
  });

  it("enforces deterministic fixed Scheduler policy fields", () => {
    for (const changed of [
      { retryJitterBasisPoints: 1 },
      { policy: { kind: "adaptive" } },
      { policyFailureAction: "fallback-baseline" },
      { lowWatermarkBasisPoints: 0 },
    ]) {
      const base = configuration();
      const core = base.core as Record<string, JsonValue>;
      expect(() => validateDollyInstanceConfigV10Draft({
        ...base,
        core: { ...core, scheduler: { ...scheduler(), ...changed } },
      } as unknown as JsonValue)).toThrow();
    }
  });

  it("enforces per-Module Claim, source, effect, and Linux execution invariants", () => {
    const mutations: readonly Record<string, JsonValue>[] = [
      reactiveModule({
        limits: {
          ...(reactiveModule().limits as Record<string, JsonValue>),
          claim: { baselineCount: 5, baselineBytes: 1_024, maxCount: 4, maxBytes: 4_096 },
        },
      }),
      reactiveModule({
        limits: {
          ...(reactiveModule().limits as Record<string, JsonValue>),
          sourceRequestMaxBytes: 1_024,
        },
      }),
      reactiveModule({
        declaredExternalEffects: "none",
        permissionPolicyReferences: [{ policyId: "model.primary", revision: POLICY_REVISION }],
      }),
      reactiveModule({ execution: {
        ...execution(),
        limits: {
          ...(execution().limits as Record<string, JsonValue>),
          memoryMaxBytes: 64 * 1_024 * 1_024 + 1,
        },
      } }),
      reactiveModule({ execution: {
        ...execution(),
        isolation: "sandbox",
      } }),
      sourceModule({
        limits: {
          ...(sourceModule().limits as Record<string, JsonValue>),
          claim: { baselineCount: 2, baselineBytes: 1_024, maxCount: 2, maxBytes: 4_096 },
        },
      }),
      sourceModule({ inputConnections: [{ pageId: "input", start: "from-head" }] }),
      sourceModule({
        limits: {
          ...(sourceModule().limits as Record<string, JsonValue>),
          sourceRequestMaxBytes: null,
        },
      }),
    ];
    for (const module of mutations) {
      expect(() => validateDollyInstanceConfigV10Draft(
        configuration([module]) as JsonValue,
      )).toThrow();
    }
  });

  it("rejects duplicate, invalid, or unknown input connection positions", () => {
    for (const inputConnections of [
      [
        { pageId: "input", start: "from-now" },
        { pageId: "input", start: "from-head" },
      ],
      [{ pageId: "missing", start: "from-now" }],
      [{ pageId: "input", start: { checkpoint: "01" } }],
    ]) {
      expect(() => validateDollyInstanceConfigV10Draft(configuration([
        reactiveModule({ inputConnections }),
      ]) as JsonValue)).toThrow();
    }
  });

  it("requires an empty mailbox to fit the durable Block ceiling across fan-out", () => {
    const producer = reactiveModule({
      moduleId: "producer",
      inputConnections: [{ pageId: "trigger", start: "from-now" }],
      outputPageIds: ["fan-a", "fan-b"],
    });
    const consumer = reactiveModule({
      moduleId: "consumer",
      extensionId: "org.example.consumer",
      configurationReference: {
        configId: "consumer-default",
        revision: CONFIGURATION_REVISION,
        configVersion: 1,
      },
      inputConnections: [
        { pageId: "fan-a", start: "from-now" },
        { pageId: "fan-b", start: "from-now" },
      ],
      outputPageIds: [],
      limits: {
        ...(reactiveModule().limits as Record<string, JsonValue>),
        mailbox: { maxResidentCount: 1, maxResidentBytes: 8_192 },
      },
    });
    const pages = ["trigger", "fan-a", "fan-b"].map((pageId) => ({ pageId }));
    expect(() => validateDollyInstanceConfigV10Draft(
      configuration([producer, consumer], pages) as JsonValue,
    )).toThrow(/mailbox cannot hold one maximum durable Block/u);

    const limits = consumer.limits as Record<string, JsonValue>;
    expect(() => validateDollyInstanceConfigV10Draft(configuration([
      producer,
      { ...consumer, limits: {
        ...limits,
        mailbox: { maxResidentCount: 2, maxResidentBytes: 8_192 },
      } },
    ], pages) as JsonValue)).toThrow(/durable Block/u);

    expect(validateDollyInstanceConfigV10Draft(configuration([
      producer,
      { ...consumer, limits: {
        ...limits,
        mailbox: {
          maxResidentCount: 2,
          maxResidentBytes: 2 * 64 * 1_024 * 1_024,
        },
      } },
    ], pages) as JsonValue).modules).toHaveLength(2);
  });
});

describe("reserved version 10 Scheduler composition", () => {
  it("derives every Scheduler and per-Module correctness value from the document", () => {
    const plan = deriveDollyInstanceV10SchedulerPlan(configuration() as JsonValue);

    expect(plan).toEqual({
      schemaVersion: "dolly.instance-v10-scheduler-plan/1",
      instanceId: INSTANCE_ID,
      scheduler: scheduler(),
      modules: [{
        moduleId: "worker",
        inputPageIds: ["input"],
        outputPageIds: ["output"],
        mailbox: { maxResidentCount: 16, maxResidentBytes: 64 * 1_024 },
        claimLimits: {
          baselineCount: 2,
          baselineBytes: 1_024,
          maxCount: 4,
          maxBytes: 4_096,
        },
        sourceRequestMaxBytes: null,
        activation: { kind: "reactive" },
      }],
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.scheduler)).toBe(true);
    expect(Object.isFrozen(plan.modules[0])).toBe(true);
  });

  it("drives exact per-Module Claim baselines and rejects a second correctness input", async () => {
    const tick = vi.fn(async () => ({ status: "idle" as const }));
    const managed: ManagedReactiveModuleRuntime = {
      moduleGenerationId: "worker-generation",
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      tick,
    };
    const input = {
      configuration: configuration() as JsonValue,
      deliveries: {
        inspectPending: () => ({ pendingCount: 1, pendingBytes: 128 }),
        inspectResident: () => ({
          pendingCount: 1,
          pendingBytes: 128,
          claimedCount: 0,
          claimedBytes: 0,
          residentCount: 1,
          residentBytes: 128,
        }),
      },
      clock: immediateSchedulerClock(),
      registrations: [{ moduleId: "worker", runtime: managed }],
    } as const;

    expect(() => composeReservedV10ReactiveModuleHost({
      ...input,
      scheduling: { claimLimitCount: 99 },
    } as never)).toThrow(/caller-supplied correctness fields/u);
    expect(() => composeReservedV10ReactiveModuleHost({
      ...input,
      registrations: [{
        moduleId: "worker",
        runtime: managed,
        mailbox: { maxResidentCount: 1, maxResidentBytes: 1 },
      }],
    } as never)).toThrow(/caller-supplied correctness fields/u);

    const host = composeReservedV10ReactiveModuleHost(input);
    await host.start();
    await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(1));
    expect(tick).toHaveBeenCalledWith({
      claimLimitCount: 2,
      claimLimitBytes: 1_024,
    });
    await host.stop();
  });
});

describe("explicit version 9 to version 10 migration planning", () => {
  it("copies stable fields and expands every input connection without side effects", () => {
    const source = sourceSnapshot();
    const input = migrationInput();
    const sourceBefore = cloneJson(source);
    const inputBefore = cloneJson(input);
    const plan = planDollyInstanceConfigV10Migration(source, input);

    expect(plan).toMatchObject({
      schemaVersion: "dolly.instance-v10-migration-plan/1",
      sourceSchemaVersion: "dolly.instance/9",
      expectedSourceRevision: SOURCE_REVISION,
      document: {
        schemaVersion: "dolly.instance/10",
        core: {
          limits: { maxRegisteredContentValueBytes: 64 * 1_024 },
          scheduler: { policy: { kind: "fixed" } },
        },
        modules: [{
          moduleId: "worker",
          inputConnections: [
            { pageId: "input-a", start: "from-now" },
            { pageId: "input-b", start: "from-now" },
          ],
          permissionPolicyReferences: [{
            policyId: "model.primary",
            revision: POLICY_REVISION,
          }],
          limits: {
            claim: {
              baselineCount: 2,
              baselineBytes: 1_024,
              maxCount: 4,
              maxBytes: 4_096,
            },
          },
        }],
      },
    });
    expect(Object.isFrozen(plan.document.modules[0]!.execution)).toBe(true);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.document.modules[0]!.inputConnections)).toBe(true);
    expect(source).toEqual(sourceBefore);
    expect(input).toEqual(inputBefore);
  });

  it("derives the source Claim ceiling and keeps the source request limit explicit", () => {
    const source = sourceSnapshot(version9SourceModuleConfiguration());
    const input = migrationInput({
      modules: [{
        moduleId: "source",
        claimBaseline: { count: 1, bytes: 1_024 },
        mailbox: { maxResidentCount: 4, maxResidentBytes: 8_192 },
        sourceRequestMaxBytes: 2_048,
        execution: execution(),
        declaredExternalEffects: "none",
        permissionPolicyReferences: [],
      }],
    });

    expect(planDollyInstanceConfigV10Migration(source, input).document.modules[0]).toMatchObject({
      moduleId: "source",
      inputConnections: [],
      limits: {
        claim: {
          baselineCount: 1,
          baselineBytes: 1_024,
          maxCount: 1,
          maxBytes: 4_096,
        },
        sourceRequestMaxBytes: 2_048,
      },
    });
  });

  it.each([
    {
      label: "missing Module",
      change: { modules: [] },
      pattern: /Module set does not match/u,
    },
    {
      label: "extra Module",
      change: {
        modules: [
          ...(migrationInput().modules as readonly JsonValue[]),
          {
            ...(migrationInput().modules as readonly Record<string, JsonValue>[])[0]!,
            moduleId: "other",
          },
        ],
      },
      pattern: /Module set does not match/u,
    },
    {
      label: "duplicate Module",
      change: {
        modules: [
          ...(migrationInput().modules as readonly JsonValue[]),
          ...(migrationInput().modules as readonly JsonValue[]),
        ],
      },
      pattern: /duplicate Module identifiers/u,
    },
    {
      label: "oversized baseline",
      change: {
        modules: [{
          ...(migrationInput().modules as readonly Record<string, JsonValue>[])[0]!,
          claimBaseline: { count: 5, bytes: 1_024 },
        }],
      },
      pattern: /baseline exceeds/u,
    },
    {
      label: "changed isolation",
      change: {
        modules: [{
          ...(migrationInput().modules as readonly Record<string, JsonValue>[])[0]!,
          execution: { ...execution(), isolation: "sandbox" },
        }],
      },
      pattern: /isolation is unsupported/u,
    },
    {
      label: "foreign policy",
      change: {
        modules: [{
          ...(migrationInput().modules as readonly Record<string, JsonValue>[])[0]!,
          permissionPolicyReferences: [{ policyId: "model.other", revision: POLICY_REVISION }],
        }],
      },
      pattern: /policy references.*do not match/u,
    },
  ])("rejects $label migration input", ({ change, pattern }) => {
    expect(() => planDollyInstanceConfigV10Migration(
      sourceSnapshot(),
      migrationInput(change) as JsonValue,
    )).toThrow(pattern);
  });

  it("rejects stale or malformed source revisions and unknown migration fields", () => {
    expect(() => planDollyInstanceConfigV10Migration(
      { ...sourceSnapshot(), configRevision: `sha256:${"4".repeat(64)}` },
      migrationInput() as JsonValue,
    )).toThrow(/does not match the source snapshot/u);
    expect(() => planDollyInstanceConfigV10Migration(
      sourceSnapshot(),
      migrationInput({ expectedSourceRevision: "latest" }) as JsonValue,
    )).toThrow(/lowercase SHA-256 digest/u);
    expect(() => planDollyInstanceConfigV10Migration(
      sourceSnapshot(),
      { ...migrationInput(), apply: true } as JsonValue,
    )).toThrow(/unknown fields/u);
  });
});
