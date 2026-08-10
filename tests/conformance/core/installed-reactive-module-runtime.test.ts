import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composeInstalledReactiveModuleHost,
  createInstalledReactiveModuleRuntime,
} from "../../../src/adapters/installed-reactive-module-runtime.js";
import type { BlockProposal } from "../../../src/core/block-store.js";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import {
  CoreStartupRecovery,
  moduleProcessStopProofIdentityDigest,
  type ModuleProcessStopProof,
} from "../../../src/core/core-startup-recovery.js";
import { ExtensionIsolationPolicy } from "../../../src/core/extension-process-host.js";
import { ExtensionInstallationRegistry } from "../../../src/core/extension-installation-registry.js";
import { createFileCoreStateStoreWithStoppedRecordWriter } from "../../../src/core/file-core-state-store.js";
import { FileModuleResultCommitRepository } from "../../../src/core/file-module-result-commit-repository.js";
import { JSON_SCHEMA_2020_12 } from "../../../src/core/json-schema.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import type { ModuleProcessRecord } from "../../../src/core/module-process-records.js";
import { ModuleConfigurationStore } from "../../../src/core/module-configuration-store.js";
import { createModuleResultCommitCoordinator } from "../../../src/core/module-result-commit-factory.js";
import type { DeliveryMailboxCapacity } from "../../../src/core/delivery-store.js";
import {
  createDefaultDollyInstanceConfig,
  validateDollyInstanceConfig,
} from "../../../src/core/runtime-config.js";

const INSTANCE_ID = "33333333-3333-4333-8333-333333333333";
const DELEGATED_ROOT = "/system.slice/dolly-core.service";
const BINDING = {
  mode: "system",
  unitName: "dolly-core.service",
  serviceInvocationId: "3812432ad29e4d3bbd6776c62cafa929",
  bootId: "1a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
  mainPid: 10_002,
  delegatedRootCgroupPath: DELEGATED_ROOT,
  coreCgroupPath: `${DELEGATED_ROOT}/core`,
  delegatedRootControllers: ["cpu", "memory", "pids"],
} as const;
const SCHEMA = {
  $schema: JSON_SCHEMA_2020_12,
  type: "object",
  properties: { prefix: { type: "string" } },
  required: ["prefix"],
  additionalProperties: false,
} as const;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scratchParent = resolve(repositoryRoot, "..", ".tmp");

function proposal(text: string): BlockProposal {
  return {
    payload: {
      schema: "dolly.content/1",
      value: { items: [{ type: "text", text, format: "plain" }] },
    },
  };
}

const provenStopped = {
  proveStopped: async (
    record: ModuleProcessRecord,
  ): Promise<ModuleProcessStopProof> => ({
    proven: true,
    evidence: "populated-zero",
    recordIdentityDigest: moduleProcessStopProofIdentityDigest(record),
  }),
};

describe("installed reactive Module runtime composition", () => {
  let scratch: string;
  let installations: ExtensionInstallationRegistry;
  let configurations: ModuleConfigurationStore;
  let instanceConfiguration: ReturnType<typeof validateDollyInstanceConfig>;

  beforeEach(() => {
    mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
    scratch = mkdtempSync(resolve(scratchParent, "installed-reactive-runtime-"));
    const source = resolve(scratch, "package-source");
    mkdirSync(source, { recursive: true, mode: 0o700 });
    writeFileSync(resolve(source, "main.mjs"), "export const fixture = true;\n", "utf8");
    writeFileSync(resolve(source, "dolly-extension.json"), JSON.stringify({
      schemaVersion: "dolly.extension-package/1",
      extensionId: "org.example.installed-runtime",
      packageVersion: "1.0.0",
      displayName: "Installed runtime fixture",
      description: "Binds runtime state to installed package provenance.",
      supportedProtocolVersions: ["3.0"],
      entrypoint: "main.mjs",
      modules: [{
        moduleKind: "transform",
        activation: "reactive",
        configVersion: 1,
        configurationSchema: SCHEMA,
      }],
      requestedCapabilities: [],
    }), "utf8");
    installations = new ExtensionInstallationRegistry({
      directory: resolve(scratch, "installations"),
    });
    installations.installNodePackage({ sourceDirectory: source, trust: "trusted" });
    configurations = new ModuleConfigurationStore({
      directory: resolve(scratch, "configurations"),
    });
    const configuration = configurations.create({
      configId: "worker-config",
      extensionId: "org.example.installed-runtime",
      moduleKind: "transform",
      configVersion: 1,
      schema: SCHEMA,
      configuration: { prefix: "verified" },
    });
    const defaults = createDefaultDollyInstanceConfig(INSTANCE_ID);
    instanceConfiguration = validateDollyInstanceConfig({
      ...defaults,
      pages: [{ pageId: "input" }, { pageId: "output" }],
      modules: [{
        moduleId: "worker",
        extensionId: "org.example.installed-runtime",
        packageVersion: "1.0.0",
        moduleKind: "transform",
        isolation: "process",
        configurationReference: {
          configId: configuration.configId,
          revision: configuration.revision,
          configVersion: configuration.configVersion,
        },
        permissionPolicyIds: [],
        inputPageIds: ["input"],
        outputPageIds: ["output"],
        subscriptionStart: "from-now",
        activation: { kind: "reactive" },
        limits: {
          claim: { maxCount: 2, maxBytes: 4096 },
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
    });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function coreState(name: string) {
    let blockId = 0;
    let deliveryId = 0;
    const pair = createFileCoreStateStoreWithStoppedRecordWriter({
      path: resolve(scratch, `${name}-core.json`),
      maxFailedAttempts: 3,
      nextBlockId: () => `${name}-block-${++blockId}`,
      nextDeliveryId: (kind) => `${name}-${kind}-${++deliveryId}`,
      now: () => "2026-08-10T00:00:00.000Z",
    });
    pair.store.deliveries.createPage("input");
    pair.store.deliveries.createPage("output");
    pair.store.deliveries.registerConsumer("input", "worker", "from-now");
    return pair;
  }

  function options(pair: ReturnType<typeof coreState>) {
    return {
      instanceConfiguration,
      moduleId: "worker",
      installations,
      configurations,
      core: pair.store,
      stoppedRecordWriter: pair.stoppedRecordWriter,
      resultCommitRepository: new FileModuleResultCommitRepository({
        path: resolve(scratch, "result-commits.json"),
      }),
      mailboxes: [{
        consumerId: "worker",
        pageIds: ["input"],
        maxResidentCount: 10,
        maxResidentBytes: 64 * 1024,
      }],
      now: () => "2026-08-10T00:00:00.000Z",
      initialModuleGenerationId: "module-generation-a",
      nextModuleGenerationId: () => "module-generation-b",
      monotonicNow: () => 0,
      binding: BINDING,
      lifecycle: {
        limits: {
          memoryMaxBytes: 64 * 1024 * 1024,
          maxProcesses: 16,
          cpuQuotaMicros: 50_000,
          cpuPeriodMicros: 100_000,
        },
        maxOpenFiles: 64,
      },
      declaredExternalEffects: "none" as const,
      launcher: {
        interpreterProgram: "/usr/bin/python3",
        launcherScriptPath: "/opt/dolly/launcher.py",
      },
      host: {
        isolationPolicy: new ExtensionIsolationPolicy(),
        shutdownRequestTimeoutMs: 250,
        forceKillDelayMs: 100,
      },
      channelCloseTimeoutMs: 500,
      nextProcessGenerationId: () => "process-installed-runtime-a",
      classifyFailure: () => ({ code: "FIXTURE_FAILURE", retryable: false }),
    };
  }

  async function startupHandoff(
    pair: ReturnType<typeof coreState>,
    repository: FileModuleResultCommitRepository,
    mailboxes: readonly DeliveryMailboxCapacity[],
  ) {
    const recovery = new CoreStartupRecovery({
      deliveries: pair.store.deliveries,
      commits: createModuleResultCommitCoordinator({
        core: pair.store,
        repository,
        now: () => "2026-08-10T00:00:00.000Z",
        mailboxes,
      }),
      moduleRecords: pair.store,
      stoppedRecordWriter: pair.stoppedRecordWriter,
    });
    return (await recovery.recover()).handoff;
  }

  it("constructs one unstarted runtime whose process and commit paths use the same Core", async () => {
    const pair = coreState("first");
    const composed = createInstalledReactiveModuleRuntime(options(pair));

    expect(composed.resolvedModule.installation.packageDigest)
      .toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(composed.runtime.moduleGenerationId).toBe("module-generation-a");
    expect(() => composed.generations.processGenerationIdFor("module-generation-a"))
      .toThrow(/does not have a process generation/u);
    expect(pair.store.listModuleProcessRecords()).toEqual([]);
    await expect(composed.runtime.tick()).rejects.toMatchObject({
      code: "RUNTIME_NOT_STARTED",
    });
    expect(pair.store.listModuleProcessRecords()).toEqual([]);
  });

  it("accepts a stopped-process handoff without starting a replacement Extension", async () => {
    const pair = coreState("deferred-installed");
    pair.store.deliveries.registerConsumer("output", "sink", "from-now");
    const resident = pair.store.blocks.commit(proposal("resident"), {
      kind: "external",
      id: "console",
    });
    pair.store.deliveries.append("output", resident.id);
    const input = pair.store.blocks.commit(proposal("input"), {
      kind: "external",
      id: "console",
    });
    pair.store.deliveries.append("input", input.id);
    const claim = pair.store.deliveries.claim({
      consumerId: "worker",
      pageIds: ["input"],
      moduleGenerationId: "worker-old-generation",
      maxCount: 1,
      maxBytes: 4096,
    })!;
    const installed = installations.resolve({
      extensionId: "org.example.installed-runtime",
      packageVersion: "1.0.0",
    });
    const reference = instanceConfiguration.modules[0]!.configurationReference;
    const processGenerationId = "process-deferred-installed-1";
    pair.store.appendModuleProcessRecord({
      schemaVersion: "dolly.module-process-record/1",
      instanceId: INSTANCE_ID,
      moduleId: "worker",
      moduleGenerationId: claim.moduleGenerationId,
      processGenerationId,
      packageDigest: installed.packageDigest,
      configurationReference: reference,
      declaredExternalEffects: "none",
      serviceInvocationId: BINDING.serviceInvocationId,
      bootId: BINDING.bootId,
      moduleCgroupPath: deriveModuleCgroupPath(BINDING.delegatedRootCgroupPath, {
        instanceId: INSTANCE_ID,
        moduleId: "worker",
        processGenerationId,
      }).filesystemPath,
      state: "starting",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    });
    pair.store.updateModuleProcessRecordState(processGenerationId, "running");
    pair.store.appendModuleSubmissionRecord({
      schemaVersion: "dolly.module-submission-record/1",
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
      processGenerationId,
      inputDigest: canonicalJsonDigest(pair.store.deliveries.inspectClaimInput(claim)),
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    pair.stoppedRecordWriter.writeStopped(processGenerationId);
    const complete = options(pair);
    const mailboxes = [...complete.mailboxes, {
      consumerId: "sink",
      pageIds: ["output"],
      maxResidentCount: 1,
      maxResidentBytes: 64 * 1024,
    }];
    const commits = createModuleResultCommitCoordinator({
      core: pair.store,
      repository: complete.resultCommitRepository,
      now: complete.now,
      mailboxes,
    });
    await expect(commits.commit({
      ...claim,
      source: { kind: "module", id: "worker" },
      outputPageIds: ["output"],
      blockProposal: proposal("deferred"),
    })).rejects.toMatchObject({ code: "MODULE_RESULT_OUTPUT_BACKPRESSURED" });
    const report = await new CoreStartupRecovery({
      deliveries: pair.store.deliveries,
      commits,
      moduleRecords: pair.store,
      stoppedRecordWriter: pair.stoppedRecordWriter,
      processStopProver: provenStopped,
    }).recover();
    expect(report.deferredCommits).toHaveLength(1);

    const {
      configurations: _configurations,
      core: _core,
      initialModuleGenerationId,
      installations: _installations,
      instanceConfiguration: _instanceConfiguration,
      mailboxes: _mailboxes,
      moduleId: _moduleId,
      monotonicNow: _monotonicNow,
      nextModuleGenerationId,
      stoppedRecordWriter: _stoppedRecordWriter,
      ...sharedRuntime
    } = complete;
    const composed = composeInstalledReactiveModuleHost({
      configuration: instanceConfiguration,
      installations,
      configurations,
      coreState: pair,
      mailboxes,
      startupRecoveryHandoff: report.handoff,
      clock: {
        monotonicNow: () => 0,
        schedule: () => ({ cancel: () => undefined }),
      },
      scheduling: {
        maxConcurrentModules: 1,
        backpressureAction: "pause-upstream",
        downstreamRecheckMs: 100,
        noProgressAfterMs: 5_000,
        claimLimitCount: 1,
        claimLimitBytes: 1024,
        retryJitterRatio: 0,
        lowWatermarkRatio: 1,
      },
      runtime: {
        ...sharedRuntime,
        initialModuleGenerationIdFor: (moduleId) =>
          `${moduleId}-${initialModuleGenerationId}`,
        nextModuleGenerationIdFor: (moduleId) =>
          `${moduleId}-${nextModuleGenerationId()}`,
      },
    });
    expect(composed.installedRuntimes[0]?.runtime.outputCommitWaiting).toBe(true);
    expect(composed.installedRuntimes[0]?.generations.processGenerationIdFor)
      .toBeDefined();
    expect(() => composed.installedRuntimes[0]!.generations
      .processGenerationIdFor("worker-module-generation-a"))
      .toThrow(/does not have a process generation/u);
    expect(pair.store.getModuleProcessRecord(processGenerationId)).toMatchObject({
      state: "stopped",
    });
  });

  it("rejects a stopped-record writer from another Core before executor creation", () => {
    const first = coreState("first");
    const second = coreState("second");

    expect(() => createInstalledReactiveModuleRuntime({
      ...options(first),
      stoppedRecordWriter: second.stoppedRecordWriter,
    })).toThrow(/writer is not bound to its FileCoreStateStore/u);
    expect(first.store.listModuleProcessRecords()).toEqual([]);
    expect(second.store.listModuleProcessRecords()).toEqual([]);
  });

  it("builds one Scheduler host without accepting a supplied manifest or runtime", async () => {
    const pair = coreState("first");
    const complete = options(pair);
    const {
      configurations: _configurations,
      core: _core,
      initialModuleGenerationId,
      installations: _installations,
      instanceConfiguration: _instanceConfiguration,
      mailboxes,
      moduleId: _moduleId,
      monotonicNow: _monotonicNow,
      nextModuleGenerationId,
      stoppedRecordWriter: _stoppedRecordWriter,
      ...sharedRuntime
    } = complete;
    const runtime = {
      ...sharedRuntime,
      initialModuleGenerationIdFor: (moduleId: string) =>
        `${moduleId}-${initialModuleGenerationId}`,
      nextModuleGenerationIdFor: (moduleId: string) =>
        `${moduleId}-${nextModuleGenerationId()}`,
    };
    const clock = {
      monotonicNow: () => 0,
      schedule: () => ({ cancel: () => undefined }),
    };
    const scheduling = {
      maxConcurrentModules: 1,
      backpressureAction: "pause-upstream" as const,
      downstreamRecheckMs: 100,
      noProgressAfterMs: 5_000,
      claimLimitCount: 1,
      claimLimitBytes: 1024,
      retryJitterRatio: 0,
      lowWatermarkRatio: 1,
    };
    expect(() => composeInstalledReactiveModuleHost({
      configuration: instanceConfiguration,
      installations,
      configurations,
      coreState: pair,
      mailboxes,
      startupRecoveryHandoff: {
        schemaVersion: "dolly.core-startup-recovery-handoff/1",
      },
      clock,
      scheduling,
      runtime,
    })).toThrow(/handoff is not authentic/u);
    const verifiedHandoff = await startupHandoff(
      pair,
      runtime.resultCommitRepository,
      mailboxes,
    );
    expect(() => composeInstalledReactiveModuleHost({
      configuration: instanceConfiguration,
      installations,
      configurations,
      coreState: pair,
      mailboxes,
      startupRecoveryHandoff: verifiedHandoff,
      clock,
      scheduling,
      runtime: {
        ...runtime,
        resultCommitRepository: new FileModuleResultCommitRepository({
          path: resolve(scratch, "another-result-commits.json"),
        }),
      },
    })).toThrow(/handoff is not bound to this Core store and result repository/u);
    const composed = composeInstalledReactiveModuleHost({
      configuration: instanceConfiguration,
      installations,
      configurations,
      coreState: pair,
      mailboxes,
      startupRecoveryHandoff: verifiedHandoff,
      clock,
      scheduling,
      runtime,
    });

    expect(composed.host.state).toBe("created");
    expect(composed.installedRuntimes).toHaveLength(1);
    expect(composed.installedRuntimes[0]?.runtime.moduleGenerationId)
      .toBe("worker-module-generation-a");
    expect(pair.store.listModuleProcessRecords()).toEqual([]);
    expect(() => composeInstalledReactiveModuleHost({
      configuration: instanceConfiguration,
      installations,
      configurations,
      coreState: pair,
      mailboxes,
      startupRecoveryHandoff: verifiedHandoff,
      clock,
      scheduling,
      runtime,
    })).toThrow(/handoff was already consumed/u);
    const invalidMailboxHandoff = await startupHandoff(
      pair,
      runtime.resultCommitRepository,
      mailboxes,
    );
    expect(() => composeInstalledReactiveModuleHost({
      configuration: instanceConfiguration,
      installations,
      configurations,
      coreState: pair,
      mailboxes: [{
        ...mailboxes[0]!,
        pageIds: ["output"],
      }],
      startupRecoveryHandoff: invalidMailboxHandoff,
      clock,
      scheduling,
      runtime,
    })).toThrow(/mailbox Pages do not match Module worker/u);
    expect(pair.store.listModuleProcessRecords()).toEqual([]);
  });

  it("composes every configured installed Module into one Scheduler host", async () => {
    const pair = coreState("pipeline");
    pair.store.deliveries.createPage("middle");
    pair.store.deliveries.registerConsumer("middle", "worker-two", "from-now");
    const complete = options(pair);
    const {
      configurations: _configurations,
      core: _core,
      initialModuleGenerationId,
      installations: _installations,
      instanceConfiguration: _instanceConfiguration,
      mailboxes: _mailboxes,
      moduleId: _moduleId,
      monotonicNow: _monotonicNow,
      nextModuleGenerationId,
      stoppedRecordWriter: _stoppedRecordWriter,
      ...sharedRuntime
    } = complete;
    const runtime = {
      ...sharedRuntime,
      initialModuleGenerationIdFor: (moduleId: string) =>
        `${moduleId}-${initialModuleGenerationId}`,
      nextModuleGenerationIdFor: (moduleId: string) =>
        `${moduleId}-${nextModuleGenerationId()}`,
    };
    const first = instanceConfiguration.modules[0]!;
    const pipelineConfiguration = validateDollyInstanceConfig({
      ...instanceConfiguration,
      pages: [{ pageId: "input" }, { pageId: "middle" }, { pageId: "output" }],
      modules: [{
        ...first,
        outputPageIds: ["middle"],
      }, {
        ...first,
        moduleId: "worker-two",
        inputPageIds: ["middle"],
        outputPageIds: ["output"],
      }],
    });
    const mailboxes = [{
      consumerId: "worker",
      pageIds: ["input"],
      maxResidentCount: 10,
      maxResidentBytes: 64 * 1024,
    }, {
      consumerId: "worker-two",
      pageIds: ["middle"],
      maxResidentCount: 10,
      maxResidentBytes: 64 * 1024,
    }];

    const composed = composeInstalledReactiveModuleHost({
      configuration: pipelineConfiguration,
      installations,
      configurations,
      coreState: pair,
      mailboxes,
      startupRecoveryHandoff: await startupHandoff(
        pair,
        runtime.resultCommitRepository,
        mailboxes,
      ),
      clock: {
        monotonicNow: () => 0,
        schedule: () => ({ cancel: () => undefined }),
      },
      scheduling: {
        maxConcurrentModules: 2,
        backpressureAction: "pause-upstream",
        downstreamRecheckMs: 100,
        noProgressAfterMs: 5_000,
        claimLimitCount: 1,
        claimLimitBytes: 1024,
        retryJitterRatio: 0,
        lowWatermarkRatio: 1,
      },
      runtime,
    });
    expect(composed.installedRuntimes.map((installed) =>
      installed.resolvedModule.module.moduleId
    )).toEqual(["worker", "worker-two"]);
    expect(composed.installedRuntimes.map((installed) =>
      installed.runtime.moduleGenerationId
    )).toEqual([
      "worker-module-generation-a",
      "worker-two-module-generation-a",
    ]);
    expect(pair.store.listModuleProcessRecords()).toEqual([]);
  });
});
