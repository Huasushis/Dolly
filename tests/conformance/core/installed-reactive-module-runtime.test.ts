import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  composeInstalledReactiveModuleHost,
  createInstalledReactiveModuleRuntime,
} from "../../../src/adapters/installed-reactive-module-runtime.js";
import { InstalledModulePermissionPolicyRegistry } from "../../../src/adapters/installed-module-permission-policy.js";
import type { BlockProposal } from "../../../src/core/block-store.js";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import { FileEffectIntentStore } from "../../../src/core/capabilities/file-effect-intent-store.js";
import { ContentSchemaRegistrationSet } from "../../../src/core/content-schema-registry.js";
import {
  CoreStartupRecovery,
  moduleProcessStopProofIdentityDigest,
  type ModuleProcessStopProof,
} from "../../../src/core/core-startup-recovery.js";
import { ExtensionIsolationPolicy } from "../../../src/core/extension-process-host.js";
import { ExtensionInstallationRegistry } from "../../../src/core/extension-installation-registry.js";
import { createFileCoreStateStoreWithStoppedRecordWriter } from "../../../src/core/file-core-state-store.js";
import { resolveInstalledContentSchemaRegistrationSet } from "../../../src/core/installed-extension-module.js";
import { FileModuleResultCommitRepository } from "../../../src/core/file-module-result-commit-repository.js";
import { FileToolJournalRepository } from "../../../src/core/file-tool-journal-repository.js";
import { JSON_SCHEMA_2020_12 } from "../../../src/core/json-schema.js";
import type { ChatBrokerInvocation } from "../../../src/core/model-provider-broker.js";
import { ModelDescriptorRegistry } from "../../../src/core/model-provider-descriptor.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import type { ModuleProcessRecord } from "../../../src/core/module-process-records.js";
import { ModuleConfigurationStore } from "../../../src/core/module-configuration-store.js";
import { createModuleResultCommitCoordinator } from "../../../src/core/module-result-commit-factory.js";
import type { DeliveryMailboxCapacity } from "../../../src/core/delivery-store.js";
import {
  createDefaultDollyInstanceConfig,
  validateDollyInstanceConfig,
} from "../../../src/core/runtime-config.js";
import { ToolRegistry, type ToolDescriptor } from "../../../src/core/tool-policy.js";
import {
  CHAT_STRATEGIES,
  chatDescriptor,
} from "../model-provider/fixtures.js";

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
const MODEL_SCHEMA_DIGEST = `sha256:${"7".repeat(64)}`;

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

  function coreState(
    name: string,
    configuration = instanceConfiguration,
    suppliedContentSchemas?: ContentSchemaRegistrationSet,
  ) {
    let blockId = 0;
    let deliveryId = 0;
    const contentSchemas = suppliedContentSchemas ??
      resolveInstalledContentSchemaRegistrationSet({
        instanceConfiguration: configuration,
        installations,
        reservedRegistrations: [],
        maxRegisteredValueBytes: 64 * 1024,
      });
    const pair = createFileCoreStateStoreWithStoppedRecordWriter({
      path: resolve(scratch, `${name}-core.json`),
      maxFailedAttempts: 3,
      nextBlockId: () => `${name}-block-${++blockId}`,
      nextDeliveryId: (kind) => `${name}-${kind}-${++deliveryId}`,
      now: () => "2026-08-10T00:00:00.000Z",
      contentSchemas,
    });
    for (const page of configuration.pages) {
      pair.store.deliveries.createPage(page.pageId);
    }
    for (const module of configuration.modules) {
      for (const pageId of module.inputPageIds) {
        pair.store.deliveries.registerConsumer(
          pageId,
          module.moduleId,
          module.subscriptionStart,
        );
      }
    }
    return { ...pair, contentSchemas };
  }

  function contentSchemaOptions(pair: ReturnType<typeof coreState>) {
    return {
      contentSchemas: pair.contentSchemas,
      maxRegisteredContentValueBytes: 64 * 1024,
    } as const;
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

  function configurationWithModelPolicy() {
    return validateDollyInstanceConfig({
      ...instanceConfiguration,
      modules: instanceConfiguration.modules.map((module) => ({
        ...module,
        permissionPolicyIds: ["model.owner-primary"],
      })),
    });
  }

  function modelPolicies() {
    const descriptors = new ModelDescriptorRegistry({
      schemaDigest: MODEL_SCHEMA_DIGEST,
      allowedStrategyIds: CHAT_STRATEGIES,
    });
    const descriptor = descriptors.register(chatDescriptor());
    descriptors.setStatus(descriptor, "active");
    const invoke = vi.fn(async (invocation: ChatBrokerInvocation) => ({
      schemaVersion: "dolly.model-result/2" as const,
      requestId: invocation.requestId,
      operationId: invocation.context.operationId,
      descriptor: invocation.descriptor,
      status: "succeeded" as const,
      output: {
        schemaVersion: "dolly.model.chat-output/1" as const,
        finalContent: "ok",
        reasoning: { state: "not-observed" as const },
        toolCalls: [],
        finishReason: "stop",
      },
      usage: { providerAttempts: 1, observations: [] },
    }));
    return {
      invoke,
      registry: new InstalledModulePermissionPolicyRegistry({
        now: () => Date.parse("2026-08-10T00:00:00.000Z"),
        nextRequestId: () => "installed-model-request-1",
        policies: [{
          kind: "strict-streaming-chat",
          policyId: "model.owner-primary",
          descriptor,
          ownerScope: "owner-1",
          budgets: {
            maxProviderAttempts: 1,
            maxWallTimeMs: 180_000,
            maxRequestBytes: 64 * 1024,
            maxResponseBytes: 256 * 1024,
            maxInputItems: 32,
            maxInputBytes: 48 * 1024,
            maxOutputBytes: 128 * 1024,
            maxOutputTokens: 5_200,
          },
          chat: { invoke },
          outputContracts: ["text"],
          reasoningPolicies: ["require", "disable"],
          roles: ["system", "user"],
          limits: {
            maxInvocations: 4,
            maxInvocationsPerRun: 2,
            maxInvocationsPerWindow: 4,
            rateWindowMs: 60_000,
          },
          capabilityLifetimeMs: 30 * 60_000,
        }],
      }),
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
      declaredExternalEffects: "unrestricted",
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
    const scheduled: Array<{ readonly delayMs: number; readonly callback: () => void }> = [];
    const composed = composeInstalledReactiveModuleHost({
      configuration: instanceConfiguration,
      installations,
      configurations,
      coreState: pair,
      ...contentSchemaOptions(pair),
      mailboxes,
      startupRecoveryHandoff: report.handoff,
      clock: {
        monotonicNow: () => 0,
        schedule: (delayMs, callback) => {
          scheduled.push({ delayMs, callback });
          return { cancel: () => undefined };
        },
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

    await composed.host.start();
    expect(composed.host.state).toBe("recovering");
    expect(() => composed.installedRuntimes[0]!.generations
      .processGenerationIdFor("worker-module-generation-a"))
      .toThrow(/does not have a process generation/u);

    const sinkClaim = pair.store.deliveries.claim({
      consumerId: "sink",
      pageIds: ["output"],
      moduleGenerationId: "sink-drain-generation",
      maxCount: 1,
      maxBytes: 64 * 1024,
    })!;
    const sinkProcessGenerationId = "sink-drain-process";
    pair.store.appendModuleProcessRecord({
      schemaVersion: "dolly.module-process-record/1",
      instanceId: INSTANCE_ID,
      moduleId: "sink",
      moduleGenerationId: sinkClaim.moduleGenerationId,
      processGenerationId: sinkProcessGenerationId,
      packageDigest: installed.packageDigest,
      configurationReference: reference,
      declaredExternalEffects: "none",
      serviceInvocationId: BINDING.serviceInvocationId,
      bootId: BINDING.bootId,
      moduleCgroupPath: deriveModuleCgroupPath(BINDING.delegatedRootCgroupPath, {
        instanceId: INSTANCE_ID,
        moduleId: "sink",
        processGenerationId: sinkProcessGenerationId,
      }).filesystemPath,
      state: "starting",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    });
    pair.store.updateModuleProcessRecordState(sinkProcessGenerationId, "running");
    pair.store.appendModuleSubmissionRecord({
      schemaVersion: "dolly.module-submission-record/1",
      moduleJobId: sinkClaim.moduleJobId,
      claimToken: sinkClaim.claimToken,
      runId: sinkClaim.runId,
      attempt: sinkClaim.attempt,
      moduleGenerationId: sinkClaim.moduleGenerationId,
      processGenerationId: sinkProcessGenerationId,
      inputDigest: canonicalJsonDigest(pair.store.deliveries.inspectClaimInput(sinkClaim)),
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    expect(pair.store.acknowledgeDeliveryClaim(sinkClaim)).toBe("committed");
    scheduled.find((timer) => timer.delayMs === 0)!.callback();
    await vi.waitFor(() => {
      expect(composed.installedRuntimes[0]!.runtime.outputCommitWaiting).toBe(false);
      expect(composed.installedRuntimes[0]!.runtime.startupRecoveryPending).toBe(false);
      expect(composed.host.state).toBe("running");
    });
    expect(() => composed.installedRuntimes[0]!.generations
      .processGenerationIdFor("worker-module-generation-a"))
      .toThrow(/does not have a process generation/u);
    await expect(composed.host.stop()).resolves.toBeUndefined();
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

  it("rejects caller-supplied external-effect recovery claims", () => {
    const pair = coreState("effect-claim");
    const callerDeclaredNone = {
      ...options(pair),
      declaredExternalEffects: "none" as const,
    };
    const callerEvidence = {
      ...options(pair),
      externalEffectEvidence: {
        inspectRunEffects: async () => ({ kind: "no-effect" as const }),
      },
    };

    expect(() => createInstalledReactiveModuleRuntime(callerDeclaredNone))
      .toThrow(/cannot accept caller-supplied external-effect recovery inputs/u);
    expect(() => createInstalledReactiveModuleRuntime(callerEvidence))
      .toThrow(/cannot accept caller-supplied external-effect recovery inputs/u);
    expect(pair.store.listModuleProcessRecords()).toEqual([]);
  });

  it("derives strict-streaming model authority only from selected Host policies", () => {
    const configuration = configurationWithModelPolicy();
    const pair = coreState("model-policy", configuration);
    const selected = modelPolicies();
    const base = {
      ...options(pair),
      instanceConfiguration: configuration,
    };

    expect(() => createInstalledReactiveModuleRuntime(base))
      .toThrow(/require one direct Host policy registry/u);
    expect(() => createInstalledReactiveModuleRuntime({
      ...base,
      permissionPolicies: selected.registry,
    })).toThrow(/require one direct durable effect intent store/u);

    const effectIntentStore = new FileEffectIntentStore({
      path: resolve(scratch, "model-policy-effect-intents.json"),
    });
    expect(() => createInstalledReactiveModuleRuntime({
      ...base,
      permissionPolicies: new InstalledModulePermissionPolicyRegistry({ policies: [] }),
      effectIntentStore,
    })).toThrow(/model\.owner-primary is not registered/u);
    const composed = createInstalledReactiveModuleRuntime({
      ...base,
      permissionPolicies: selected.registry,
      effectIntentStore,
    });

    expect(composed.permissionPolicySetup?.snapshot).toMatchObject({
      instanceId: INSTANCE_ID,
      moduleId: "worker",
      extensionId: "org.example.installed-runtime",
      configurationRevision: configuration.modules[0]!.configurationReference.revision,
      policyIds: ["model.owner-primary"],
      capabilities: [{
        capabilityType: "model-operation",
        capabilityVersion: "v2",
        policyId: "model.owner-primary",
        streaming: "required",
      }],
    });
    expect(composed.permissionPolicySetup?.snapshot.packageDigest)
      .toBe(composed.resolvedModule.installation.packageDigest);
    expect(selected.invoke).not.toHaveBeenCalled();
    expect(pair.store.listModuleProcessRecords()).toEqual([]);
  });

  it("binds an installed tool policy to the selected package and configuration", () => {
    const configuration = validateDollyInstanceConfig({
      ...instanceConfiguration,
      modules: instanceConfiguration.modules.map((module) => ({
        ...module,
        permissionPolicyIds: ["tools.owner-notes"],
      })),
    });
    const pair = coreState("tool-policy", configuration);
    const descriptor: ToolDescriptor = {
      toolId: "notes.read",
      wireName: "read_note",
      description: "Read one Host-owned note",
      argumentSchema: {
        type: "object",
        properties: { key: { type: "string", maxBytes: 32 } },
        required: ["key"],
        additionalProperties: false,
        maxProperties: 1,
      },
      resultSchema: { type: "string", maxBytes: 128 },
      effectClass: "read",
      resourceScope: "notes.owner",
      approval: "never",
      idempotency: "effect-key",
      outcomeQuery: "supported",
      parallel: "safe",
      deadlineMs: 1_000,
      maxArgumentBytes: 128,
      maxResultBytes: 256,
    };
    const tools = new ToolRegistry([descriptor], [descriptor.toolId]);
    const toolPolicy = {
      kind: "registered-tools" as const,
      policyId: "tools.owner-notes",
      registry: tools,
      repository: new FileToolJournalRepository({
        path: resolve(scratch, "tool-policy-rounds.json"),
      }),
      executor: { execute: vi.fn() },
      budget: {
        maxRounds: 2,
        maxCalls: 2,
        maxCallsPerRound: 1,
        maxApprovals: 0,
        maxCallBytes: 512,
      },
      approvalPolicyRevision: "approval-policy-1",
      limits: {
        maxCallsPerRound: 1,
        maxArgumentBytes: 1_024,
        maxResultBytes: 4_096,
        maxInvocations: 4,
        maxInvocationsPerRun: 2,
      },
      capabilityLifetimeMs: 60_000,
    };
    const permissionPolicies = new InstalledModulePermissionPolicyRegistry({
      policies: [toolPolicy],
    });
    const writeTool = {
      ...descriptor,
      effectClass: "write" as const,
      approval: "required" as const,
    };
    expect(() => new InstalledModulePermissionPolicyRegistry({
      policies: [{
        ...toolPolicy,
        registry: new ToolRegistry([writeTool], [writeTool.toolId]),
        repository: new FileToolJournalRepository({
          path: resolve(scratch, "effectful-tool-policy-rounds.json"),
        }),
        budget: { ...toolPolicy.budget, maxApprovals: 1 },
      }],
    })).toThrow(/currently permits only read tools/u);
    const composed = createInstalledReactiveModuleRuntime({
      ...options(pair),
      instanceConfiguration: configuration,
      permissionPolicies,
      effectIntentStore: new FileEffectIntentStore({
        path: resolve(scratch, "tool-policy-effect-intents.json"),
      }),
    });

    expect(composed.permissionPolicySetup?.snapshot).toMatchObject({
      instanceId: INSTANCE_ID,
      moduleId: "worker",
      packageDigest: composed.resolvedModule.installation.packageDigest,
      configurationRevision: configuration.modules[0]!.configurationReference.revision,
      policyIds: ["tools.owner-notes"],
      capabilities: [{
        capabilityType: "tool-invocation",
        capabilityVersion: "v2",
        policyId: "tools.owner-notes",
        registryDigest: tools.snapshot().registryDigest,
        toolWireNames: ["read_note"],
        effectPolicy: "read-only",
      }],
    });
    expect(pair.store.listModuleProcessRecords()).toEqual([]);
  });

  it("rejects a caller-supplied Host effect lifecycle before executor creation", () => {
    const pair = coreState("host-effect-lifecycle");
    const supplied = options(pair);
    const forged = {
      ...supplied,
      host: {
        ...supplied.host,
        effectRunLifecycle: {},
      },
    };

    expect(() => createInstalledReactiveModuleRuntime(forged))
      .toThrow(/cannot accept a caller-supplied capability effect lifecycle/u);
    expect(pair.store.listModuleProcessRecords()).toEqual([]);
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
    const equivalentButUnboundContentSchemas =
      resolveInstalledContentSchemaRegistrationSet({
        instanceConfiguration,
        installations,
        reservedRegistrations: [],
        maxRegisteredValueBytes: 64 * 1024,
      });
    expect(() => composeInstalledReactiveModuleHost({
      configuration: instanceConfiguration,
      installations,
      configurations,
      coreState: pair,
      contentSchemas: equivalentButUnboundContentSchemas,
      maxRegisteredContentValueBytes: 64 * 1024,
      mailboxes,
      startupRecoveryHandoff: {
        schemaVersion: "dolly.core-startup-recovery-handoff/1",
      },
      clock,
      scheduling,
      runtime,
    })).toThrow(/content schemas are not bound to its FileCore state/u);
    const configuredModule = instanceConfiguration.modules[0]!;
    const injectedReservedSchemas = new ContentSchemaRegistrationSet({
      modules: [{
        moduleId: configuredModule.moduleId,
        extensionId: configuredModule.extensionId,
        packageVersion: configuredModule.packageVersion,
        moduleKind: configuredModule.moduleKind,
      }],
      registrations: [{
        source: "deployment",
        schema: "dolly.fixture/1",
        producer: {
          extensionId: configuredModule.extensionId,
          packageVersion: configuredModule.packageVersion,
          moduleKind: configuredModule.moduleKind,
        },
        validator: SCHEMA,
        validatorDigest: canonicalJsonDigest(SCHEMA),
        maxValueBytes: 1024,
        containsCoreReferences: false,
      }],
      maxRegisteredValueBytes: 64 * 1024,
    });
    const mismatchedPair = coreState(
      "injected-schema",
      instanceConfiguration,
      injectedReservedSchemas,
    );
    expect(() => composeInstalledReactiveModuleHost({
      configuration: instanceConfiguration,
      installations,
      configurations,
      coreState: mismatchedPair,
      contentSchemas: injectedReservedSchemas,
      maxRegisteredContentValueBytes: 64 * 1024,
      mailboxes,
      startupRecoveryHandoff: {
        schemaVersion: "dolly.core-startup-recovery-handoff/1",
      },
      clock,
      scheduling,
      runtime,
    })).toThrow(/content schemas do not match its verified installations/u);
    expect(() => composeInstalledReactiveModuleHost({
      configuration: instanceConfiguration,
      installations,
      configurations,
      coreState: pair,
      ...contentSchemaOptions(pair),
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
      ...contentSchemaOptions(pair),
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
      ...contentSchemaOptions(pair),
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
      ...contentSchemaOptions(pair),
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
      ...contentSchemaOptions(pair),
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

  it("binds a package-version-3 source Module to one Core-private activation queue", async () => {
    const sourcePackage = resolve(scratch, "source-package");
    mkdirSync(sourcePackage, { recursive: true, mode: 0o700 });
    writeFileSync(resolve(sourcePackage, "main.mjs"), "export const source = true;\n", "utf8");
    writeFileSync(resolve(sourcePackage, "dolly-extension.json"), JSON.stringify({
      schemaVersion: "dolly.extension-package/3",
      extensionId: "org.example.source-runtime",
      packageVersion: "1.0.0",
      displayName: "Installed source fixture",
      description: "Consumes bounded Core-private source activation requests.",
      supportedProtocolVersions: ["3.0"],
      entrypoint: "main.mjs",
      modules: [{
        moduleKind: "refresh",
        activation: "source",
        configVersion: 1,
        configurationSchema: SCHEMA,
        producedContentSchemas: [],
      }],
      requestedCapabilities: [],
    }), "utf8");
    installations.installNodePackage({ sourceDirectory: sourcePackage, trust: "trusted" });
    const sourceConfiguration = configurations.create({
      configId: "source-config",
      extensionId: "org.example.source-runtime",
      moduleKind: "refresh",
      configVersion: 1,
      schema: SCHEMA,
      configuration: { prefix: "source" },
    });
    const sourceInstance = validateDollyInstanceConfig({
      ...createDefaultDollyInstanceConfig(INSTANCE_ID),
      pages: [{ pageId: "source-output" }],
      modules: [{
        moduleId: "source-worker",
        extensionId: "org.example.source-runtime",
        packageVersion: "1.0.0",
        moduleKind: "refresh",
        isolation: "process",
        configurationReference: {
          configId: sourceConfiguration.configId,
          revision: sourceConfiguration.revision,
          configVersion: sourceConfiguration.configVersion,
        },
        permissionPolicyIds: [],
        inputPageIds: [],
        outputPageIds: ["source-output"],
        subscriptionStart: "from-head",
        activation: { kind: "source", trigger: "manual" },
        limits: {
          claim: null,
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
    const pair = coreState("source", sourceInstance);
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
    const handoff = await startupHandoff(
      pair,
      runtime.resultCommitRepository,
      [],
    );
    const common = {
      configuration: sourceInstance,
      installations,
      configurations,
      coreState: pair,
      ...contentSchemaOptions(pair),
      mailboxes: [],
      startupRecoveryHandoff: handoff,
      clock: {
        monotonicNow: () => 0,
        schedule: () => ({ cancel: () => undefined }),
      },
      scheduling: {
        maxConcurrentModules: 1,
        backpressureAction: "pause-upstream" as const,
        downstreamRecheckMs: 100,
        noProgressAfterMs: 5_000,
        claimLimitCount: 1,
        claimLimitBytes: 1024,
        retryJitterRatio: 0,
        lowWatermarkRatio: 1,
      },
      runtime,
    };

    const pagesBeforeRejectedPeriodicSource = pair.store.deliveries.listPageIds();
    const periodicSourceInstance = validateDollyInstanceConfig({
      ...sourceInstance,
      modules: [{
        ...sourceInstance.modules[0]!,
        activation: { kind: "source", trigger: "periodic", periodMs: 1_000 },
      }],
    });
    expect(() => composeInstalledReactiveModuleHost({
      ...common,
      configuration: periodicSourceInstance,
      sourceActivationLimits: [{
        moduleId: "source-worker",
        maxResidentCount: 2,
        maxResidentBytes: 4096,
        maxRequestBytes: 2048,
      }],
    })).toThrow(/automatic periodic request producer/u);
    expect(pair.store.deliveries.listPageIds()).toEqual(
      pagesBeforeRejectedPeriodicSource,
    );

    expect(() => composeInstalledReactiveModuleHost({
      ...common,
      mailboxes: [{
        consumerId: "source-worker",
        pageIds: [],
        maxResidentCount: 2,
        maxResidentBytes: 4096,
      }],
      sourceActivationLimits: [{
        moduleId: "source-worker",
        maxResidentCount: 2,
        maxResidentBytes: 4096,
        maxRequestBytes: 2048,
      }],
    })).toThrow(/cannot have a public mailbox/u);
    expect(pair.store.deliveries.listPageIds()).toEqual(
      pagesBeforeRejectedPeriodicSource,
    );

    expect(() => composeInstalledReactiveModuleHost(common))
      .toThrow(/require activation limits/u);
    const composed = composeInstalledReactiveModuleHost({
      ...common,
      sourceActivationLimits: [{
        moduleId: "source-worker",
        maxResidentCount: 2,
        maxResidentBytes: 4096,
        maxRequestBytes: 2048,
      }],
    });

    expect(composed.host.state).toBe("created");
    expect(composed.sourceActivations).toHaveLength(1);
    expect(composed.installedRuntimes[0]).toMatchObject({
      resolvedModule: { module: { moduleId: "source-worker", activation: { kind: "source" } } },
      sourceActivationBinding: {
        schemaVersion: "dolly.source-activation-binding/1",
        moduleId: "source-worker",
      },
    });
    const activation = composed.sourceActivations[0]!;
    expect(activation.limits).toEqual({
      maxResidentCount: 2,
      maxResidentBytes: 4096,
      maxRequestBytes: 2048,
    });
    const firstRequest = {
      idempotencyKey: "manual:source-worker:1",
      body: { kind: "manual/1", instruction: "refresh" },
    } as const;
    let admissionFailure: unknown;
    try {
      activation.submit(firstRequest);
    } catch (error) {
      admissionFailure = error;
    }
    expect(admissionFailure).toMatchObject({
      code: "SOURCE_ACTIVATION_ADMISSION_CLOSED",
      message: expect.stringMatching(/not running/u),
    });
    expect(activation.inspect()).toMatchObject({ pendingCount: 0, residentCount: 0 });
    expect(pair.store.listModuleProcessRecords()).toEqual([]);
  });

  it("binds a package-version-4 non-empty periodic Module to the installed Scheduler", async () => {
    const periodicPackage = resolve(scratch, "periodic-package");
    mkdirSync(periodicPackage, { recursive: true, mode: 0o700 });
    writeFileSync(resolve(periodicPackage, "main.mjs"), "export const periodic = true;\n", "utf8");
    writeFileSync(resolve(periodicPackage, "dolly-extension.json"), JSON.stringify({
      schemaVersion: "dolly.extension-package/4",
      extensionId: "org.example.installed-runtime",
      packageVersion: "4.0.0",
      displayName: "Installed periodic fixture",
      description: "Exercises non-empty periodic Scheduler composition.",
      supportedProtocolVersions: ["3.0"],
      entrypoint: "main.mjs",
      modules: [{
        moduleKind: "transform",
        activation: "periodic",
        configVersion: 1,
        configurationSchema: SCHEMA,
        producedContentSchemas: [],
      }],
      requestedCapabilities: [],
    }), "utf8");
    installations.installNodePackage({ sourceDirectory: periodicPackage, trust: "trusted" });
    const periodicInstance = validateDollyInstanceConfig({
      ...instanceConfiguration,
      modules: [{
        ...instanceConfiguration.modules[0]!,
        packageVersion: "4.0.0",
        activation: { kind: "periodic", periodMs: 250, allowEmptyInput: false },
      }],
    });
    const pair = coreState("periodic", periodicInstance);
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
    const handoff = await startupHandoff(
      pair,
      runtime.resultCommitRepository,
      mailboxes,
    );
    const composed = composeInstalledReactiveModuleHost({
      configuration: periodicInstance,
      installations,
      configurations,
      coreState: pair,
      ...contentSchemaOptions(pair),
      mailboxes,
      startupRecoveryHandoff: handoff,
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
      runtime,
    });

    expect(composed.host.state).toBe("created");
    expect(composed.installedRuntimes).toHaveLength(1);
    expect(composed.installedRuntimes[0]?.resolvedModule.module.activation).toEqual({
      kind: "periodic",
      periodMs: 250,
      allowEmptyInput: false,
    });
    expect(composed.sourceActivations).toEqual([]);
    expect(pair.store.listModuleProcessRecords()).toEqual([]);
  });

  it("composes every configured installed Module into one Scheduler host", async () => {
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
    const pair = coreState("pipeline", pipelineConfiguration);
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
      ...contentSchemaOptions(pair),
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
