import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const activationDependencies = vi.hoisted(() => {
  const binding = {
    mode: "system" as const,
    unitName: "dolly-core.service",
    serviceInvocationId: "3812432ad29e4d3bbd6776c62cafa929",
    bootId: "1a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
    mainPid: 10_002,
    delegatedRootCgroupPath: "/system.slice/dolly-core.service",
    coreCgroupPath: "/system.slice/dolly-core.service/core",
    delegatedRootControllers: ["cpu", "memory", "pids"],
  };
  const runtime = {
    schemaVersion: "dolly.linux-module-runtime-profile/1" as const,
    nodeProgram: process.execPath,
    nodeVersion: process.versions.node,
    interpreterProgram: "/usr/bin/python3" as const,
    launcherScriptPath: new URL(
      "../../../src/adapters/linux-module-launcher/launcher.py",
      import.meta.url,
    ).pathname,
    launcherDigest:
      "sha256:2c95f759603f902340f719abaaf12b2df0ab7194d9c89f35aa835927486d3177" as const,
    confinementProgram: "/usr/bin/bwrap" as const,
  };
  const root = {
    filesystemPath: "/sys/fs/cgroup/system.slice/dolly-core.service",
    controllers: ["cpu", "memory", "pids"],
    subtreeControl: ["cpu", "memory", "pids"],
  };
  return { binding, runtime, root };
});

vi.mock("../../../src/core/linux-core-service-binding.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/core/linux-core-service-binding.js")>(),
  inspectCoreServiceBinding: vi.fn(async () => ({
    verified: true as const,
    binding: activationDependencies.binding,
  })),
}));
vi.mock("../../../src/core/linux-module-cgroup.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/core/linux-module-cgroup.js")>(),
  LinuxModuleCgroupStopProver: class {
    async proveStopped(record: ModuleProcessRecord): Promise<ModuleProcessStopProof> {
      return {
        proven: true as const,
        evidence: "populated-zero" as const,
        recordIdentityDigest: moduleProcessStopProofIdentityDigest(record),
      };
    }
  },
  prepareDelegatedCgroupRoot: vi.fn(async () => ({
    prepared: true as const,
    root: activationDependencies.root,
  })),
}));
vi.mock("../../../src/linux-module-runtime-assets.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/linux-module-runtime-assets.js")>(),
  inspectReviewedLinuxModuleRuntime: vi.fn(async () => ({
    available: true as const,
    runtime: activationDependencies.runtime,
  })),
}));
import {
  composeInstalledReactiveModuleHost,
  createInstalledReactiveModuleRuntime,
} from "../../../src/adapters/installed-reactive-module-runtime.js";
import { InstalledModulePermissionPolicyRegistry } from "../../../src/adapters/installed-module-permission-policy.js";
import type { BlockProposal } from "../../../src/core/block-store.js";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import { FileEffectIntentStore } from "../../../src/core/capabilities/file-effect-intent-store.js";
import { ModulePrivateStorageBackend } from "../../../src/core/capabilities/module-private-storage-capability.js";
import { ContentSchemaRegistrationSet } from "../../../src/core/content-schema-registry.js";
import {
  CoreStartupRecovery,
  moduleProcessStopProofIdentityDigest,
  type ModuleProcessStopProof,
} from "../../../src/core/core-startup-recovery.js";
import { ExtensionIsolationPolicy } from "../../../src/core/extension-process-host.js";
import { ExtensionInstallationRegistry } from "../../../src/core/extension-installation-registry.js";
import { createFileCoreStateStoreWithStoppedRecordWriter } from "../../../src/core/file-core-state-store.js";
import { FileMediaByteStore } from "../../../src/core/file-media-byte-store.js";
import { resolveInstalledContentSchemaRegistrationSet } from "../../../src/core/installed-extension-module.js";
import { FileModuleResultCommitRepository } from "../../../src/core/file-module-result-commit-repository.js";
import { FileToolJournalRepository } from "../../../src/core/file-tool-journal-repository.js";
import { JSON_SCHEMA_2020_12 } from "../../../src/core/json-schema.js";
import {
  decideLinuxModuleActivation,
  type LinuxModuleActivationPermission,
} from "../../../src/core/linux-module-activation.js";
import type { ChatBrokerInvocation } from "../../../src/core/model-provider-broker.js";
import { ModelDescriptorRegistry } from "../../../src/core/model-provider-descriptor.js";
import { EndpointBindingRegistry } from "../../../src/core/model-provider-binding.js";
import {
  LinuxModuleCgroupStopProver,
  deriveModuleCgroupPath,
} from "../../../src/core/linux-module-cgroup.js";
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
const BINDING = activationDependencies.binding;
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

describe("installed reactive Module runtime composition", () => {
  let scratch: string;
  let installations: ExtensionInstallationRegistry;
  let configurations: ModuleConfigurationStore;
  let instanceConfiguration: ReturnType<typeof validateDollyInstanceConfig>;
  let activationPermission: LinuxModuleActivationPermission;

  beforeEach(async () => {
    const activationResult = await decideLinuxModuleActivation({
      unitName: BINDING.unitName,
      mode: BINDING.mode,
    });
    if (!activationResult.permitted) {
      throw new Error("fixture activation permission was unexpectedly refused");
    }
    activationPermission = activationResult;
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
    media = false,
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
      ...(media
        ? {
            media: {
              durability: "persistent" as const,
              bytes: new FileMediaByteStore({
                directory: resolve(scratch, `${name}-media`),
                maxMediaBytes: 64 * 1024,
              }),
              inspector: {
                inspect: async () => ({ mimeType: "image/png", width: 2, height: 1 }),
              },
              maxMediaBytes: 64 * 1024,
              idNamespace: `${name}-media`,
            },
          }
        : {}),
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
      activation: activationPermission,
      lifecycle: {
        limits: {
          memoryMaxBytes: 64 * 1024 * 1024,
          maxProcesses: 16,
          cpuQuotaMicros: 50_000,
          cpuPeriodMicros: 100_000,
        },
        maxOpenFiles: 64,
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

  function modelPolicies(
    media = false,
    prebuiltMediaChat = false,
    productTextBroker = false,
  ) {
    const descriptors = new ModelDescriptorRegistry({
      schemaDigest: MODEL_SCHEMA_DIGEST,
      allowedStrategyIds: CHAT_STRATEGIES,
    });
    const descriptor = descriptors.register(chatDescriptor({ inlinePng: media }));
    descriptors.setStatus(descriptor, "active");
    const bindings = new EndpointBindingRegistry();
    if (media || productTextBroker) {
      const binding = bindings.register({
        schemaVersion: "dolly.endpoint-binding/2",
        endpointId: descriptor.endpointId,
        bindingRevision: "installed-media-binding-v1",
        descriptorRefs: [descriptor],
        exactUrl: "https://provider.example.test/v1/chat/completions",
        networkScope: "public",
        authentication: { kind: "none" },
        limits: {
          maxRequestBytes: 64 * 1024,
          maxResponseBytes: 256 * 1024,
          maxTimeoutMs: 180_000,
        },
      });
      bindings.setStatus(binding, "active");
    }
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
            ...(media
              ? { maxMediaItems: 1, maxResolvedMediaBytes: 32 * 1024 }
              : {}),
          },
          ...((media && !prebuiltMediaChat) || (!media && productTextBroker)
            ? {
                brokerOptions: {
                  descriptors,
                  bindings,
                  secrets: {
                    resolve: async () => {
                      throw new Error("The construction test cannot read a provider secret");
                    },
                  },
                  transport: {
                    dispatch: async () => {
                      throw new Error("The construction test cannot dispatch a provider request");
                    },
                  },
                },
              }
            : { chat: { invoke } }),
          outputContracts: ["text"],
          ...(media ? { mediaRequirementIds: ["inline-png-v1"] } : {}),
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
      processStopProver: activationPermission.stopProver,
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
      processStopProver: activationPermission.stopProver,
    }).recover();
    expect(report.deferredCommits).toHaveLength(1);

    const {
      configurations: _configurations,
      activation: _activation,
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
      activation: activationPermission,
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
    expect(composed.modules[0]?.outputCommitWaiting).toBe(true);
    expect(pair.store.getModuleProcessRecord(processGenerationId)).toMatchObject({
      state: "stopped",
    });

    await composed.host.start();
    expect(composed.host.state).toBe("recovering");
    expect(pair.store.listModuleProcessRecords()).toEqual([
      expect.objectContaining({ processGenerationId, state: "stopped" }),
    ]);

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
      expect(composed.modules[0]!.outputCommitWaiting).toBe(false);
      expect(composed.modules[0]!.startupRecoveryPending).toBe(false);
      expect(composed.host.state).toBe("running");
    });
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

    const productPair = coreState("model-product-broker-policy", configuration);
    const productSelected = modelPolicies(false, false, true);
    const productComposed = createInstalledReactiveModuleRuntime({
      ...options(productPair),
      instanceConfiguration: configuration,
      permissionPolicies: productSelected.registry,
      effectIntentStore: new FileEffectIntentStore({
        path: resolve(scratch, "model-product-broker-effect-intents.json"),
      }),
    });
    expect(productComposed.permissionPolicySetup?.snapshot.capabilities).toEqual([
      expect.objectContaining({
        capabilityType: "model-operation",
        capabilityVersion: "v2",
        streaming: "required",
      }),
    ]);
    expect(productSelected.invoke).not.toHaveBeenCalled();
    expect(productPair.store.listModuleProcessRecords()).toEqual([]);
  });

  it("selects model-operation v3 only for a finite delivered-Media policy", () => {
    const configuration = validateDollyInstanceConfig({
      ...instanceConfiguration,
      modules: instanceConfiguration.modules.map((module) => ({
        ...module,
        permissionPolicyIds: ["model.owner-primary"],
      })),
    });
    const pair = coreState("model-media-policy", configuration, undefined, true);
    const selected = modelPolicies(true);
    const composed = createInstalledReactiveModuleRuntime({
      ...options(pair),
      instanceConfiguration: configuration,
      permissionPolicies: selected.registry,
      effectIntentStore: new FileEffectIntentStore({
        path: resolve(scratch, "model-media-policy-effect-intents.json"),
      }),
    });

    expect(composed.permissionPolicySetup?.snapshot.capabilities).toEqual([{
      capabilityType: "model-operation",
      capabilityVersion: "v3",
      policyId: "model.owner-primary",
      streaming: "required",
      mediaRequirementIds: ["inline-png-v1"],
    }]);
    const capability = composed.permissionPolicySetup?.snapshot.capabilities[0];
    if (capability?.capabilityType !== "model-operation") {
      throw new Error("Expected the installed model capability");
    }
    expect(Object.isFrozen(capability.mediaRequirementIds)).toBe(true);
    expect(selected.invoke).not.toHaveBeenCalled();
    expect(pair.store.listModuleProcessRecords()).toEqual([]);
  });

  it("rejects a prebuilt chat port and a Media-disabled Core for a v3 policy", () => {
    expect(() => modelPolicies(true, true)).toThrow(/cannot accept a prebuilt chat port/u);
    const configuration = configurationWithModelPolicy();
    const pair = coreState("model-media-policy-disabled", configuration);
    const selected = modelPolicies(true);
    expect(() => createInstalledReactiveModuleRuntime({
      ...options(pair),
      instanceConfiguration: configuration,
      permissionPolicies: selected.registry,
      effectIntentStore: new FileEffectIntentStore({
        path: resolve(scratch, "model-media-policy-disabled-effect-intents.json"),
      }),
    })).toThrow(/requires the FileCore active-Run Media resolver/u);
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
    expect(() => new InstalledModulePermissionPolicyRegistry({
      policies: [{
        ...toolPolicy,
        limits: {
          ...toolPolicy.limits,
          maxInvocations: 1,
          maxInvocationsPerRun: 2,
        },
      }],
    })).toThrow(/Run limit exceeds.*process-session limit/iu);
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

  it("binds bounded private checkpoint storage without granting deletion", () => {
    const configuration = validateDollyInstanceConfig({
      ...instanceConfiguration,
      modules: instanceConfiguration.modules.map((module) => ({
        ...module,
        permissionPolicyIds: ["memory.owner-checkpoints"],
      })),
    });
    const pair = coreState("checkpoint-storage-policy", configuration);
    const backend = new ModulePrivateStorageBackend({
      root: resolve(scratch, "module-private-storage"),
      now: () => "2026-08-12T00:00:00.000Z",
    });
    const policy = {
      kind: "module-private-storage" as const,
      policyId: "memory.owner-checkpoints",
      backend,
      operations: ["get", "list", "set"] as const,
      limits: {
        maxKeyBytes: 128,
        maxValueBytes: 16 * 1_024,
        maxEntries: 64,
        maxTotalBytes: 256 * 1_024,
        maxListResults: 32,
        maxArgumentBytes: 32 * 1_024,
        maxResultBytes: 32 * 1_024,
        maxInvocations: 256,
        maxInvocationsPerRun: 8,
      },
      capabilityLifetimeMs: 60_000,
    };
    const deletePolicy = {
      ...policy,
      operations: ["get", "delete"],
    } as unknown as typeof policy;
    expect(() => new InstalledModulePermissionPolicyRegistry({
      policies: [deletePolicy],
    })).toThrow(/permits only get, list, and set/u);
    const { maxTotalBytes: _maxTotalBytes, ...incompleteLimits } = policy.limits;
    const incompletePolicy = {
      ...policy,
      limits: incompleteLimits,
    } as unknown as typeof policy;
    expect(() => new InstalledModulePermissionPolicyRegistry({
      policies: [incompletePolicy],
    })).toThrow(/limits are incomplete or open/u);

    const composed = createInstalledReactiveModuleRuntime({
      ...options(pair),
      instanceConfiguration: configuration,
      permissionPolicies: new InstalledModulePermissionPolicyRegistry({
        policies: [policy],
      }),
      effectIntentStore: new FileEffectIntentStore({
        path: resolve(scratch, "checkpoint-policy-effect-intents.json"),
      }),
    });

    expect(composed.permissionPolicySetup?.snapshot).toMatchObject({
      instanceId: INSTANCE_ID,
      moduleId: "worker",
      packageDigest: composed.resolvedModule.installation.packageDigest,
      configurationRevision: configuration.modules[0]!.configurationReference.revision,
      policyIds: ["memory.owner-checkpoints"],
      capabilities: [{
        capabilityType: "module-private-storage",
        capabilityVersion: "v2",
        policyId: "memory.owner-checkpoints",
        operations: ["get", "list", "set"],
        limits: policy.limits,
        effectPolicy: "persistent-storage",
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
      activation: _activation,
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
      activation: { ...activationPermission },
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
    })).toThrow(/was not minted by the Host activation decision/u);
    expect(pair.store.listModuleProcessRecords()).toEqual([]);
    expect(() => composeInstalledReactiveModuleHost({
      activation: activationPermission,
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
      activation: activationPermission,
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
      activation: activationPermission,
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
    const unverifiedProcessPair = coreState("unverified-old-process");
    const unverifiedProcessOptions = options(unverifiedProcessPair);
    const installed = installations.resolve({
      extensionId: "org.example.installed-runtime",
      packageVersion: "1.0.0",
    });
    const processGenerationId = "unverified-old-process-generation";
    unverifiedProcessPair.store.appendModuleProcessRecord({
      schemaVersion: "dolly.module-process-record/1",
      instanceId: INSTANCE_ID,
      moduleId: "worker",
      moduleGenerationId: "unverified-old-module-generation",
      processGenerationId,
      packageDigest: installed.packageDigest,
      configurationReference: instanceConfiguration.modules[0]!.configurationReference,
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
    unverifiedProcessPair.store.updateModuleProcessRecordState(processGenerationId, "running");
    const unverifiedProcessHandoff = (await new CoreStartupRecovery({
      deliveries: unverifiedProcessPair.store.deliveries,
      commits: createModuleResultCommitCoordinator({
        core: unverifiedProcessPair.store,
        repository: unverifiedProcessOptions.resultCommitRepository,
        now: unverifiedProcessOptions.now,
        mailboxes,
      }),
    }).recover()).handoff;
    expect(() => composeInstalledReactiveModuleHost({
      activation: activationPermission,
      configuration: instanceConfiguration,
      installations,
      configurations,
      coreState: unverifiedProcessPair,
      ...contentSchemaOptions(unverifiedProcessPair),
      mailboxes,
      startupRecoveryHandoff: unverifiedProcessHandoff,
      clock,
      scheduling,
      runtime: {
        ...runtime,
        resultCommitRepository: unverifiedProcessOptions.resultCommitRepository,
      },
    })).toThrow(/Module record store/u);
    expect(unverifiedProcessPair.store.getModuleProcessRecord(processGenerationId))
      .toMatchObject({ state: "running" });
    const verifiedHandoff = await startupHandoff(
      pair,
      runtime.resultCommitRepository,
      mailboxes,
    );
    const alternateActivationResult = await decideLinuxModuleActivation({
      unitName: BINDING.unitName,
      mode: BINDING.mode,
    });
    if (!alternateActivationResult.permitted) {
      throw new Error("alternate fixture activation permission was unexpectedly refused");
    }
    expect(() => composeInstalledReactiveModuleHost({
      activation: alternateActivationResult,
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
    })).toThrow(/stop prover/u);
    expect(pair.store.listModuleProcessRecords()).toEqual([]);
    expect(() => composeInstalledReactiveModuleHost({
      activation: activationPermission,
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
      activation: activationPermission,
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
    expect(composed.modules).toHaveLength(1);
    expect(composed.modules[0]?.moduleGenerationId)
      .toBe("worker-module-generation-a");
    expect(composed.modules[0]).not.toHaveProperty("runtime");
    expect(composed.modules[0]).not.toHaveProperty("generations");
    expect(composed.modules[0]).not.toHaveProperty("recover");
    expect(pair.store.listModuleProcessRecords()).toEqual([]);
    expect(() => composeInstalledReactiveModuleHost({
      activation: activationPermission,
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
      activation: activationPermission,
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

    const allocatorHandoff = await startupHandoff(
      pair,
      runtime.resultCommitRepository,
      mailboxes,
    );
    expect(() => composeInstalledReactiveModuleHost({
      activation: activationPermission,
      configuration: instanceConfiguration,
      installations,
      configurations,
      coreState: pair,
      ...contentSchemaOptions(pair),
      mailboxes,
      startupRecoveryHandoff: allocatorHandoff,
      clock,
      scheduling,
      runtime: {
        ...runtime,
        initialModuleGenerationIdFor: () => {
          throw new Error("injected generation allocator failure");
        },
      },
    })).toThrow(/injected generation allocator failure/u);
    expect(() => composeInstalledReactiveModuleHost({
      activation: activationPermission,
      configuration: instanceConfiguration,
      installations,
      configurations,
      coreState: pair,
      ...contentSchemaOptions(pair),
      mailboxes,
      startupRecoveryHandoff: allocatorHandoff,
      clock,
      scheduling,
      runtime,
    })).not.toThrow();
  });

  it("rejects a handoff minted with a structurally equivalent but separately constructed stop prover", async () => {
    const pair = coreState("prover-identity");
    const complete = options(pair);
    const mailboxes = [...complete.mailboxes];
    const {
      configurations: _configurations,
      activation: _activation,
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
    const separatelyConstructedProver = new LinuxModuleCgroupStopProver({
      serviceBindingVerified: true,
      delegatedRootCgroupPath: BINDING.delegatedRootCgroupPath,
    });
    expect(separatelyConstructedProver)
      .not.toBe(activationPermission.stopProver);
    const controlHandoff = (await new CoreStartupRecovery({
      deliveries: pair.store.deliveries,
      commits: createModuleResultCommitCoordinator({
        core: pair.store,
        repository: complete.resultCommitRepository,
        now: complete.now,
        mailboxes,
      }),
      moduleRecords: pair.store,
      stoppedRecordWriter: pair.stoppedRecordWriter,
      processStopProver: activationPermission.stopProver,
    }).recover()).handoff;
    // Positive control: the same Core, repository, records, and compose
    // arguments succeed with the exact permission prover, so the rejection
    // below is attributable to stop-prover object identity alone.
    expect(() => composeInstalledReactiveModuleHost({
      activation: activationPermission,
      configuration: instanceConfiguration,
      installations,
      configurations,
      coreState: pair,
      ...contentSchemaOptions(pair),
      mailboxes,
      startupRecoveryHandoff: controlHandoff,
      clock,
      scheduling,
      runtime,
    })).not.toThrow();
    const handoff = (await new CoreStartupRecovery({
      deliveries: pair.store.deliveries,
      commits: createModuleResultCommitCoordinator({
        core: pair.store,
        repository: complete.resultCommitRepository,
        now: complete.now,
        mailboxes,
      }),
      moduleRecords: pair.store,
      stoppedRecordWriter: pair.stoppedRecordWriter,
      processStopProver: separatelyConstructedProver,
    }).recover()).handoff;
    expect(() => composeInstalledReactiveModuleHost({
      activation: activationPermission,
      configuration: instanceConfiguration,
      installations,
      configurations,
      coreState: pair,
      ...contentSchemaOptions(pair),
      mailboxes,
      startupRecoveryHandoff: handoff,
      clock,
      scheduling,
      runtime,
    })).toThrow(/stop prover/u);
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
      activation: _activation,
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
      activation: activationPermission,
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
      activation: activationPermission,
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

    expect(() => composeInstalledReactiveModuleHost({ activation: activationPermission, ...common }))
      .toThrow(/require activation limits/u);
    const pagesBeforeForgedHandoff = pair.store.deliveries.listPageIds();
    expect(() => composeInstalledReactiveModuleHost({
      activation: activationPermission,
      ...common,
      startupRecoveryHandoff: {
        schemaVersion: "dolly.core-startup-recovery-handoff/1",
      },
      sourceActivationLimits: [{
        moduleId: "source-worker",
        maxResidentCount: 2,
        maxResidentBytes: 4096,
        maxRequestBytes: 2048,
      }],
    })).toThrow(/handoff is not authentic/u);
    expect(pair.store.deliveries.listPageIds()).toEqual(pagesBeforeForgedHandoff);
    const composed = composeInstalledReactiveModuleHost({
      activation: activationPermission,
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
    expect(composed.modules[0]).toMatchObject({
      moduleId: "source-worker",
      activation: { kind: "source" },
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
      activation: _activation,
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
      activation: activationPermission,
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
    expect(composed.modules).toHaveLength(1);
    expect(composed.modules[0]?.activation).toEqual({
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
      activation: _activation,
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
      activation: activationPermission,
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
    expect(composed.modules.map((installed) =>
      installed.moduleId
    )).toEqual(["worker", "worker-two"]);
    expect(composed.modules.map((installed) =>
      installed.moduleGenerationId
    )).toEqual([
      "worker-module-generation-a",
      "worker-two-module-generation-a",
    ]);
    expect(pair.store.listModuleProcessRecords()).toEqual([]);
  });
});
