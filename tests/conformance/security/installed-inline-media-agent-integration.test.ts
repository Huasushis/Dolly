/**
 * Composes the installed Scheduler path with model-operation/v3, the product
 * ChatModelBroker strict-SSE decoder, and FileCore active-Run Media authority.
 * Public Module bootstrap remains refused; this runs only in the disposable
 * systemd container selected by the Linux integration runner.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InstalledModulePermissionPolicyRegistry } from "../../../src/adapters/installed-module-permission-policy.js";
import {
  composeInstalledReactiveModuleHost,
  type InstalledReactiveModuleHost,
} from "../../../src/adapters/installed-reactive-module-runtime.js";
import { defaultLauncherScriptPath } from "../../../src/adapters/linux-module-launcher/linux-module-launcher-process.js";
import { FileEffectIntentStore } from "../../../src/core/capabilities/file-effect-intent-store.js";
import { CoreStartupRecovery } from "../../../src/core/core-startup-recovery.js";
import { ExtensionIsolationPolicy } from "../../../src/core/extension-process-host.js";
import { ExtensionInstallationRegistry } from "../../../src/core/extension-installation-registry.js";
import {
  FileCoreStateStore,
  createFileCoreStateStoreWithStoppedRecordWriter,
} from "../../../src/core/file-core-state-store.js";
import { FileMediaByteStore } from "../../../src/core/file-media-byte-store.js";
import { FileModuleResultCommitRepository } from "../../../src/core/file-module-result-commit-repository.js";
import { resolveInstalledContentSchemaRegistrationSet } from "../../../src/core/installed-extension-module.js";
import { JSON_SCHEMA_2020_12 } from "../../../src/core/json-schema.js";
import {
  deriveModuleCgroupPath,
  prepareDelegatedCgroupRoot,
  type ModuleCgroupLimits,
} from "../../../src/core/linux-module-cgroup.js";
import { inspectCoreServiceBinding } from "../../../src/core/linux-core-service-binding.js";
import { EndpointBindingRegistry } from "../../../src/core/model-provider-binding.js";
import type {
  ModelHttpTransport,
  ModelHttpTransportRequest,
  ModelHttpTransportResponse,
} from "../../../src/core/model-provider-broker.js";
import { ModelDescriptorRegistry } from "../../../src/core/model-provider-descriptor.js";
import { ModuleConfigurationStore } from "../../../src/core/module-configuration-store.js";
import { createModuleResultCommitCoordinator } from "../../../src/core/module-result-commit-factory.js";
import { systemSchedulerClock, type SchedulerEvent } from "../../../src/core/module-scheduler.js";
import {
  createDefaultDollyInstanceConfig,
  validateDollyInstanceConfig,
} from "../../../src/core/runtime-config.js";
import {
  CHAT_STRATEGIES,
  chatDescriptor,
  objectFormReasoning,
} from "../model-provider/fixtures.js";

const PYTHON = "/usr/bin/python3";
const INSTANCE_ID = "77777777-7777-4777-8777-777777777777";
const MODULE_ID = "installed-inline-media-agent";
const EXTENSION_ID = "org.example.installed-inline-media-agent";
const REQUIREMENT_ID = "aether-inline-png-v0";
const LIMITS: ModuleCgroupLimits = {
  memoryMaxBytes: 268_435_456,
  maxProcesses: 64,
  cpuQuotaMicros: 50_000,
  cpuPeriodMicros: 100_000,
};
const EXTENSION_PATH = fileURLToPath(new URL(
  "../../../scripts/experiments/probes/scheduler-inline-media-agent-live-v0/extension.mjs",
  import.meta.url,
));
const IMAGE_BYTES = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4);
const MODEL_ANSWER = Object.freeze({
  object: "violet",
  count: 3,
  label: "DOLLY-IMG-42",
  relation: "triangle-left-of-circle",
});

function delegatedRootCgroupPath(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const line = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find((candidate) => candidate.startsWith("0::"));
    if (line === undefined) return undefined;
    const path = line.slice("0::".length);
    return path.endsWith("/core") ? path.slice(0, -"/core".length) : undefined;
  } catch {
    return undefined;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

class StrictSseResponse implements ModelHttpTransportResponse {
  readonly status = 200;
  readonly headers = { "content-type": "text/event-stream" };
  readonly providerRequestId = "provider-installed-inline-media-1";
  readonly abort = () => undefined;
  readonly body: AsyncIterable<Uint8Array>;

  constructor() {
    const content = JSON.stringify(MODEL_ANSWER);
    const bytes = Buffer.from([
      `data: ${JSON.stringify({
        id: this.providerRequestId,
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: this.providerRequestId,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: this.providerRequestId,
        choices: [],
        usage: { prompt_tokens: 32, completion_tokens: 20, total_tokens: 52 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""), "utf8");
    this.body = {
      async *[Symbol.asyncIterator]() {
        yield bytes;
      },
    };
  }
}

class RecordingStrictSseTransport implements ModelHttpTransport {
  readonly requests: ModelHttpTransportRequest[] = [];

  async dispatch(request: ModelHttpTransportRequest): Promise<ModelHttpTransportResponse> {
    this.requests.push(request);
    return new StrictSseResponse();
  }
}

const delegatedRoot = delegatedRootCgroupPath();
const integrationUnitName = process.env.DOLLY_LINUX_MODULE_INTEGRATION_UNIT;
const available = delegatedRoot !== undefined && existsSync(PYTHON);
if (process.env.DOLLY_LINUX_MODULE_INTEGRATION_REQUIRED === "1" && !available) {
  throw new Error(
    "The installed inline Media Agent integration requires its delegated systemd service",
  );
}
if (
  process.env.DOLLY_LINUX_MODULE_INTEGRATION_REQUIRED === "1" &&
  integrationUnitName === undefined
) {
  throw new Error("The installed inline Media Agent integration lacks its Core service unit");
}

describe.skipIf(!available)("installed inline Media Agent in a real control group", () => {
  it("commits one strict-streaming image answer through the installed Scheduler", async () => {
    if (integrationUnitName === undefined) {
      throw new Error("The transient Core service unit name is unavailable");
    }
    const inspectedBinding = await inspectCoreServiceBinding({
      unitName: integrationUnitName,
      mode: "user",
      queryTimeoutMs: 5_000,
      overallTimeoutMs: 15_000,
    });
    if (!inspectedBinding.verified) {
      throw new Error(inspectedBinding.failures
        .map((failure) => `${failure.code}: ${failure.detail}`)
        .join("; "));
    }
    const preparedRoot = await prepareDelegatedCgroupRoot({
      delegatedRootCgroupPath: inspectedBinding.binding.delegatedRootCgroupPath,
    });
    if (!preparedRoot.prepared) {
      throw new Error(`${preparedRoot.failure.code}: ${preparedRoot.failure.detail}`);
    }

    const scratchParent = resolve(process.cwd(), ".tmp");
    mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(scratchParent, "installed-inline-media-agent-"));
    const statePath = join(scratch, "core-state.json");
    const commitPath = join(scratch, "module-result-commits.json");
    const effectPath = join(scratch, "effect-intents.json");
    const mediaDirectory = join(scratch, "media");
    const processGenerationId = `${MODULE_ID}-process-${process.pid}-${Date.now()}`;
    const moduleCgroupPath = deriveModuleCgroupPath(
      inspectedBinding.binding.delegatedRootCgroupPath,
      { instanceId: INSTANCE_ID, moduleId: MODULE_ID, processGenerationId },
    ).filesystemPath;
    let composed: InstalledReactiveModuleHost | undefined;
    let stopped = false;
    let primaryFailure: unknown;
    try {
      const packageSource = join(scratch, "package-source");
      mkdirSync(packageSource, { recursive: true, mode: 0o700 });
      copyFileSync(EXTENSION_PATH, join(packageSource, "extension.mjs"));
      const configurationSchema = {
        $schema: JSON_SCHEMA_2020_12,
        type: "object",
        properties: {},
        additionalProperties: false,
      } as const;
      writeFileSync(join(packageSource, "dolly-extension.json"), JSON.stringify({
        schemaVersion: "dolly.extension-package/1",
        extensionId: EXTENSION_ID,
        packageVersion: "1.0.0",
        displayName: "Installed inline Media Agent fixture",
        description: "Uses one Host-created model-operation/v3 capability.",
        supportedProtocolVersions: ["3.0"],
        entrypoint: "extension.mjs",
        modules: [{
          moduleKind: "general-agent",
          activation: "reactive",
          configVersion: 1,
          configurationSchema,
        }],
        requestedCapabilities: [],
      }), "utf8");
      const installations = new ExtensionInstallationRegistry({
        directory: join(scratch, "installations"),
      });
      const installed = installations.installNodePackage({
        sourceDirectory: packageSource,
        trust: "trusted",
      });
      rmSync(packageSource, { recursive: true, force: true });
      const configurations = new ModuleConfigurationStore({
        directory: join(scratch, "configurations"),
      });
      const moduleConfiguration = configurations.create({
        configId: "installed-inline-media-agent-config",
        extensionId: EXTENSION_ID,
        moduleKind: "general-agent",
        configVersion: 1,
        schema: configurationSchema,
        configuration: {},
      });
      const defaults = createDefaultDollyInstanceConfig(INSTANCE_ID);
      const configuration = validateDollyInstanceConfig({
        ...defaults,
        core: {
          ...defaults.core,
          media: {
            enabled: true,
            maxMediaBytes: 64 * 1024,
            maxTotalMediaBytes: 128 * 1024,
            maxRegistrationRecords: 16,
            maxStorageRecords: 16,
            maxProviderAccessRecords: 16,
            deletedRegistrationRetentionMs: 60_000,
            ingress: {
              maxActiveCapabilities: 1,
              maxConcurrentOperations: 1,
              maxCapabilityLifetimeMs: 60_000,
            },
          },
          scheduler: {
            pollIntervalMs: 60_000,
            retryBaseMs: 25,
            retryMaxMs: 250,
          },
        },
        pages: [{ pageId: "media-input" }, { pageId: "media-output" }],
        modules: [{
          moduleId: MODULE_ID,
          extensionId: EXTENSION_ID,
          packageVersion: "1.0.0",
          moduleKind: "general-agent",
          isolation: "process",
          configurationReference: {
            configId: moduleConfiguration.configId,
            revision: moduleConfiguration.revision,
            configVersion: moduleConfiguration.configVersion,
          },
          permissionPolicyIds: ["model.owner-inline-media"],
          inputPageIds: ["media-input"],
          outputPageIds: ["media-output"],
          subscriptionStart: "from-now",
          activation: { kind: "reactive" },
          limits: {
            claim: { maxCount: 1, maxBytes: 64 * 1024 },
            maxInputBytes: 64 * 1024,
            maxResultBytes: 128 * 1024,
            maxFrameBytes: 512 * 1024,
            maxRunsPerGeneration: 2,
            maxGenerations: 1,
          },
          timeouts: {
            initializationTimeoutMs: 10_000,
            executionTimeoutMs: 30_000,
            cancellationGraceMs: 1_000,
            terminationTimeoutMs: 10_000,
          },
        }],
      });

      const descriptors = new ModelDescriptorRegistry({
        schemaDigest: `sha256:${"7".repeat(64)}`,
        allowedStrategyIds: CHAT_STRATEGIES,
      });
      const baseDescriptor = chatDescriptor({
        inlinePng: true,
        jsonObjectOutput: "supported",
        reasoning: objectFormReasoning(),
      });
      const descriptor = descriptors.register({
        ...baseDescriptor,
        input: {
          ...baseDescriptor.input,
          media: baseDescriptor.input.media.map((requirement) => ({
            ...requirement,
            requirementId: REQUIREMENT_ID,
          })),
        },
        features: {
          ...baseDescriptor.features,
          mediaRequirementIds: [REQUIREMENT_ID],
        },
      });
      descriptors.setStatus(descriptor, "active");
      const bindings = new EndpointBindingRegistry();
      const binding = bindings.register({
        schemaVersion: "dolly.endpoint-binding/2",
        endpointId: descriptor.endpointId,
        bindingRevision: "installed-inline-media-binding-v1",
        descriptorRefs: [descriptor],
        exactUrl: "https://provider.example.test/v1/chat/completions",
        networkScope: "public",
        authentication: { kind: "none" },
        limits: {
          maxRequestBytes: 256 * 1024,
          maxResponseBytes: 64 * 1024,
          maxTimeoutMs: 30_000,
        },
      });
      bindings.setStatus(binding, "active");
      const transport = new RecordingStrictSseTransport();
      const permissionPolicies = new InstalledModulePermissionPolicyRegistry({
        nextRequestId: () => "installed-inline-media-model-request-1",
        policies: [{
          kind: "strict-streaming-chat",
          policyId: "model.owner-inline-media",
          descriptor,
          ownerScope: "owner-1",
          budgets: {
            maxProviderAttempts: 1,
            maxWallTimeMs: 30_000,
            maxRequestBytes: 256 * 1024,
            maxResponseBytes: 64 * 1024,
            maxInputItems: 8,
            maxInputBytes: 64 * 1024,
            maxOutputBytes: 32 * 1024,
            maxOutputTokens: 1_200,
            maxMediaItems: 1,
            maxResolvedMediaBytes: 64 * 1024,
          },
          mediaBrokerOptions: {
            descriptors,
            bindings,
            secrets: {
              resolve: async () => {
                throw new Error("An unauthenticated binding cannot request a secret");
              },
            },
            transport,
          },
          outputContracts: ["json-object"],
          mediaRequirementIds: [REQUIREMENT_ID],
          reasoningPolicies: ["disable"],
          roles: ["user"],
          limits: {
            maxInvocations: 1,
            maxInvocationsPerRun: 1,
            maxInvocationsPerWindow: 1,
            rateWindowMs: 60_000,
          },
          capabilityLifetimeMs: 60_000,
        }],
      });

      let blockId = 0;
      let deliveryId = 0;
      let protocolIdentifier = 0;
      let processIdentifierAllocated = false;
      const now = (): string => new Date().toISOString();
      const contentSchemas = resolveInstalledContentSchemaRegistrationSet({
        instanceConfiguration: configuration,
        installations,
        reservedRegistrations: [],
        maxRegisteredValueBytes: 256 * 1024,
      });
      const coreState = createFileCoreStateStoreWithStoppedRecordWriter({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `installed-media-block-${++blockId}`,
        nextDeliveryId: (kind) => `installed-media-${kind}-${++deliveryId}`,
        now,
        contentSchemas,
        media: {
          durability: "persistent",
          bytes: new FileMediaByteStore({
            directory: mediaDirectory,
            maxMediaBytes: 64 * 1024,
          }),
          inspector: {
            inspect: async () => ({ mimeType: "image/png", width: 2, height: 1 }),
          },
          maxMediaBytes: 64 * 1024,
          maxTotalMediaBytes: 128 * 1024,
          idNamespace: "installed-inline-media-agent",
        },
      });
      if (!coreState.store.media) throw new Error("FileCore Media is unavailable");
      coreState.store.deliveries.createPage("media-input");
      coreState.store.deliveries.createPage("media-output");
      coreState.store.deliveries.registerConsumer("media-input", MODULE_ID, "from-now");
      const registeredMedia = await coreState.store.media.registerMedia({
        registrationId: "installed-inline-media-registration",
        bytes: IMAGE_BYTES,
        declaredMimeType: "image/png",
        provenance: { sourceClass: "streamed-upload" },
      });
      const repository = new FileModuleResultCommitRepository({ path: commitPath });
      const effectIntentStore = new FileEffectIntentStore({ path: effectPath });
      const mailboxes = [{
        consumerId: MODULE_ID,
        pageIds: ["media-input"],
        maxResidentCount: 2,
        maxResidentBytes: 128 * 1024,
      }];
      const startupRecoveryHandoff = (await new CoreStartupRecovery({
        deliveries: coreState.store.deliveries,
        commits: createModuleResultCommitCoordinator({
          core: coreState.store,
          repository,
          now,
          mailboxes,
        }),
        moduleRecords: coreState.store,
        stoppedRecordWriter: coreState.stoppedRecordWriter,
      }).recover()).handoff;
      const schedulerEvents: SchedulerEvent[] = [];
      composed = composeInstalledReactiveModuleHost({
        configuration,
        installations,
        configurations,
        coreState,
        contentSchemas,
        maxRegisteredContentValueBytes: 256 * 1024,
        mailboxes,
        startupRecoveryHandoff,
        clock: systemSchedulerClock(),
        scheduling: {
          maxConcurrentModules: 1,
          backpressureAction: "pause-upstream",
          downstreamRecheckMs: 100,
          noProgressAfterMs: 31_000,
          claimLimitCount: 1,
          claimLimitBytes: 64 * 1024,
          retryJitterRatio: 0,
          lowWatermarkRatio: 1,
        },
        runtime: {
          resultCommitRepository: repository,
          permissionPolicies,
          effectIntentStore,
          now,
          initialModuleGenerationIdFor: (moduleId) => `${moduleId}-generation-1`,
          nextModuleGenerationIdFor: (moduleId) => `${moduleId}-generation-2`,
          binding: inspectedBinding.binding,
          lifecycle: { limits: LIMITS, maxOpenFiles: 64 },
          launcher: {
            interpreterProgram: PYTHON,
            launcherScriptPath: defaultLauncherScriptPath(),
            controllerTimeouts: {
              configureTimeoutMs: 5_000,
              inCgroupTimeoutMs: 5_000,
              membershipTimeoutMs: 5_000,
              exitObservationTimeoutMs: 5_000,
            },
          },
          host: {
            isolationPolicy: new ExtensionIsolationPolicy(),
            shutdownRequestTimeoutMs: 2_000,
            forceKillDelayMs: 500,
          },
          channelCloseTimeoutMs: 5_000,
          nextProcessGenerationId: () => {
            if (processIdentifierAllocated) {
              throw new Error("The inline Media Agent attempted a replacement process");
            }
            processIdentifierAllocated = true;
            return processGenerationId;
          },
          nextProtocolIdentifier: (purpose) =>
            `${purpose}-installed-inline-media-${++protocolIdentifier}`,
          classifyFailure: (failure) => ({ code: failure.code, retryable: false }),
        },
        onSchedulerEvent: (event) => schedulerEvents.push(event),
      });
      await composed.host.start();
      expect(composed.host.state).toBe("running");
      expect(coreState.store.getModuleProcessRecord(processGenerationId)).toMatchObject({
        state: "running",
        packageDigest: installed.packageDigest,
        declaredExternalEffects: "unrestricted",
      });
      expect(existsSync(moduleCgroupPath)).toBe(true);

      const inputBlock = coreState.store.blocks.commit({
        payload: {
          schema: "dolly.content/1",
          value: { items: [
            {
              type: "text",
              format: "plain",
              text: "Inspect the image and return the requested JSON object.",
            },
            { type: "media-reference", mediaId: registeredMedia.mediaId },
          ] },
        },
      }, { kind: "external", id: "installed-inline-media-test" });
      coreState.store.deliveries.append("media-input", inputBlock.id);
      expect(await waitFor(
        () => repository.list().length === 1 && repository.list()[0]?.state === "committed",
        30_000,
      )).toBe(true);
      const result = repository.list()[0]!;
      if (result.blockId === undefined) throw new Error("Agent output Block is missing");
      const output = coreState.store.blocks.get(result.blockId);
      if (output === null) throw new Error("Committed Agent output is absent");
      const outputText = (output.payload.value as {
        readonly items: readonly { readonly text?: string }[];
      }).items[0]?.text;
      if (outputText === undefined) throw new Error("Agent output text is absent");
      const agentOutput = JSON.parse(outputText) as {
        readonly capabilityVersion: string;
        readonly strictStreamRequested: boolean;
        readonly childCredentialEnvironmentPresent: boolean;
        readonly parsed: typeof MODEL_ANSWER;
      };
      expect(agentOutput).toMatchObject({
        capabilityVersion: "v3",
        strictStreamRequested: true,
        childCredentialEnvironmentPresent: false,
        parsed: MODEL_ANSWER,
      });
      expect(transport.requests).toHaveLength(1);
      const providerBody = JSON.parse(
        Buffer.from(transport.requests[0]!.body).toString("utf8"),
      ) as Record<string, unknown> & {
        readonly messages: readonly { readonly content: readonly unknown[] }[];
      };
      expect(providerBody).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
      });
      expect(providerBody).not.toHaveProperty("enable_thinking");
      const imagePart = providerBody.messages[0]?.content[1] as {
        readonly type?: string;
        readonly image_url?: { readonly url?: string };
      };
      expect(imagePart.type).toBe("image_url");
      expect(imagePart.image_url?.url).toBe(
        `data:image/png;base64,${Buffer.from(IMAGE_BYTES).toString("base64")}`,
      );
      expect(coreState.store.deliveries.listActiveClaims()).toEqual([]);
      expect(coreState.store.media.referenceGraph.leaseCountFor({
        kind: "media",
        id: registeredMedia.mediaId,
      })).toBe(0);
      expect(coreState.store.media.listProviderAccessRecords()).toEqual([]);
      const effectRecords = new FileEffectIntentStore({ path: effectPath }).list();
      expect(effectRecords).toHaveLength(1);
      expect(effectRecords[0]).toMatchObject({
        capabilityType: "model-operation",
        operation: "chat",
        outcome: {
          kind: "terminal",
          resultDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
      });
      expect(schedulerEvents).toContainEqual(expect.objectContaining({
        type: "scheduler.settled",
        moduleId: MODULE_ID,
        tickStatus: "committed",
      }));

      await composed.host.stop();
      stopped = true;
      expect(coreState.store.getModuleProcessRecord(processGenerationId)).toMatchObject({
        state: "stopped",
        moduleCgroupPath,
      });
      expect(existsSync(moduleCgroupPath)).toBe(false);
      const reopened = new FileCoreStateStore({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => `reopened-installed-media-block-${++blockId}`,
        nextDeliveryId: (kind) => `reopened-installed-media-${kind}-${++deliveryId}`,
        now,
        contentSchemas,
        media: {
          durability: "persistent",
          bytes: new FileMediaByteStore({
            directory: mediaDirectory,
            maxMediaBytes: 64 * 1024,
          }),
          inspector: {
            inspect: async () => ({ mimeType: "image/png", width: 2, height: 1 }),
          },
          maxMediaBytes: 64 * 1024,
          maxTotalMediaBytes: 128 * 1024,
          idNamespace: "installed-inline-media-agent",
        },
      });
      expect(reopened.getModuleProcessRecord(processGenerationId)?.state).toBe("stopped");
      expect(new FileModuleResultCommitRepository({ path: commitPath }).list()).toHaveLength(1);
      expect(reopened.media?.referenceGraph.leaseCountFor({
        kind: "media",
        id: registeredMedia.mediaId,
      })).toBe(0);

      console.info(JSON.stringify({
        packageDigest: installed.packageDigest,
        moduleId: MODULE_ID,
        capabilityVersion: agentOutput.capabilityVersion,
        providerRequests: transport.requests.length,
        strictSse: true,
        inlineMediaBytes: IMAGE_BYTES.byteLength,
        providerAccessRecords: coreState.store.media.listProviderAccessRecords().length,
        mediaLeases: coreState.store.media.referenceGraph.leaseCountFor({
          kind: "media",
          id: registeredMedia.mediaId,
        }),
        committedModuleResults: repository.list().length,
        finalRecordState: reopened.getModuleProcessRecord(processGenerationId)?.state,
        cgroupRemoved: !existsSync(moduleCgroupPath),
      }));
    } catch (error) {
      primaryFailure = error;
    } finally {
      const cleanupFailures: unknown[] = [];
      if (!stopped && composed !== undefined &&
        (composed.host.state === "running" || composed.host.state === "recovering" ||
          composed.host.state === "failed")) {
        await composed.host.stop().catch((error) => cleanupFailures.push(error));
      }
      if (existsSync(moduleCgroupPath)) {
        cleanupFailures.push(
          new Error(`Exact inline Media Agent control group remained: ${moduleCgroupPath}`),
        );
      }
      rmSync(scratch, { recursive: true, force: true });
      const failures = [
        ...(primaryFailure === undefined ? [] : [primaryFailure]),
        ...cleanupFailures,
      ];
      if (failures.length > 0) {
        throw new AggregateError(failures, "Installed inline Media Agent integration failed");
      }
    }
  }, 60_000);
});
