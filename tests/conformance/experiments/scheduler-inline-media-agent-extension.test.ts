import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createExtensionProcessModuleExecutor } from "../../../src/adapters/extension-process-module-executor.js";
import { ExtensionIsolationPolicy, ExtensionProcessHost } from "../../../src/core/extension-process-host.js";
import { ModelDescriptorRegistry } from "../../../src/core/model-provider-descriptor.js";
import { createModelOperationCapabilityV3 } from "../../../src/core/provider-capabilities/model-operation-capability.js";
import type { ReactiveModuleInput } from "../../../src/core/reactive-module-input.js";
import { CHAT_STRATEGIES, chatDescriptor } from "../model-provider/fixtures.js";

const EXTENSION = fileURLToPath(new URL(
  "../../../scripts/experiments/probes/scheduler-inline-media-agent-live-v0/extension.mjs",
  import.meta.url,
));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("Scheduler inline-Media Agent Extension preflight", () => {
  it("starts a real child and forwards only one delivered Media reference through v3", async () => {
    const scratchParent = resolve(process.cwd(), "..", ".tmp");
    mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(scratchParent, "scheduler-media-agent-preflight-"));
    const descriptors = new ModelDescriptorRegistry({
      schemaDigest: `sha256:${"c".repeat(64)}`,
      allowedStrategyIds: CHAT_STRATEGIES,
    });
    const descriptor = descriptors.register(chatDescriptor({
      jsonObjectOutput: "supported",
      inlinePng: true,
    }));
    descriptors.setStatus(descriptor, "active");
    const invoke = vi.fn(async (invocation) => ({
      schemaVersion: "dolly.model-result/2" as const,
      requestId: invocation.requestId,
      operationId: invocation.context.operationId,
      descriptor: invocation.descriptor,
      status: "succeeded" as const,
      output: {
        schemaVersion: "dolly.model.chat-output/1" as const,
        finalContent: JSON.stringify({ answer: "preflight" }),
        reasoning: { state: "not-observed" as const },
        toolCalls: [],
        finishReason: "stop",
      },
      usage: { providerAttempts: 1, observations: [] },
    }));
    let identifier = 0;
    const host = new ExtensionProcessHost({
      isolation: "process",
      trust: "trusted",
      isolationPolicy: new ExtensionIsolationPolicy(),
      manifest: {
        schemaVersion: "dolly.extension-package/1",
        extensionId: "org.dolly.scheduler-inline-media-agent-preflight",
        packageVersion: "1.0.0",
        displayName: "Scheduler Media Agent preflight",
        description: "Protocol-only preflight for model-operation/v3.",
        supportedProtocolVersions: ["3.0"],
        entrypoint: "extension.mjs",
        modules: [{
          moduleKind: "general-agent",
          activation: "reactive",
          configVersion: 1,
          configurationSchema: { type: "object" },
        }],
        requestedCapabilities: [],
      },
      command: process.execPath,
      args: [EXTENSION],
      workingDirectory: scratch,
      instanceId: "instance-media-preflight",
      moduleId: "general-agent",
      moduleGenerationId: "module-generation-media-preflight",
      moduleKind: "general-agent",
      config: {},
      maxFrameBytes: 1024 * 1024,
      maxConcurrentCapabilityRequests: 1,
      initializationTimeoutMs: 5_000,
      shutdownRequestTimeoutMs: 1_000,
      forceKillDelayMs: 250,
      terminationTimeoutMs: 5_000,
      nextIdentifier: (purpose) => `${purpose}-media-preflight-${++identifier}`,
    });
    const capability = createModelOperationCapabilityV3({
      descriptor,
      ownerScope: "owner-preflight",
      budgets: {
        maxProviderAttempts: 1,
        maxWallTimeMs: 10_000,
        maxRequestBytes: 128 * 1024,
        maxResponseBytes: 128 * 1024,
        maxInputItems: 4,
        maxInputBytes: 64 * 1024,
        maxOutputBytes: 64 * 1024,
        maxOutputTokens: 1_200,
        maxMediaItems: 1,
        maxResolvedMediaBytes: 32 * 1024,
      },
      executionScope: "active-run",
      expiresAt: "2099-01-01T00:00:00.000Z",
      now: () => "2026-08-12T18:00:00.000Z",
      chat: { invoke },
      operations: ["chat", "describe"],
      reasoningPolicies: ["disable"],
      allowStreaming: true,
      requireStreaming: true,
      roles: ["user"],
      limits: {
        maxInvocations: 1,
        maxInvocationsPerRun: 1,
        maxInvocationsPerWindow: 1,
        rateWindowMs: 60_000,
      },
      requireIdempotencyKey: true,
      nextRequestId: () => "model-request-media-preflight",
      outputContracts: ["json-object"],
      mediaRequirementIds: ["aether-inline-png-v0"],
    });
    host.grantCapability(capability.grant, capability.handler);
    const executor = createExtensionProcessModuleExecutor(host, {
      moduleId: "general-agent",
      moduleGenerationId: "module-generation-media-preflight",
      executionTimeoutMs: 10_000,
      cancellationGraceMs: 1_000,
    });
    let pid: number | undefined;
    try {
      await executor.start?.();
      pid = host.snapshot.pid;
      expect(pid).toBeTypeOf("number");
      const input: ReactiveModuleInput = {
        schemaVersion: "dolly.reactive-module-input/2",
        claimedDeliveryIds: ["delivery-media-preflight"],
        blockGroups: [{
          block: {
            schemaVersion: "dolly.block/2",
            id: "block-media-preflight",
            sequence: "1",
            source: { kind: "external", id: "preflight" },
            createdAt: "2026-08-12T18:00:00.000Z",
            payload: {
              schema: "dolly.content/1",
              value: {
                items: [
                  { type: "text", text: "Read this image.", format: "plain" },
                  { type: "media-reference", mediaId: "media:preflight:0" },
                ],
              },
            },
          },
          deliveryIds: ["delivery-media-preflight"],
          occurrenceCount: 1,
          firstGlobalSequence: "1",
          lastGlobalSequence: "1",
        }],
        hasMore: false,
      };
      const result = await executor.execute(input, {
        moduleId: "general-agent",
        moduleGenerationId: "module-generation-media-preflight",
        moduleJobId: "module-job-media-preflight",
        runId: "run-media-preflight",
        attempt: 1,
        startedAt: Date.now(),
        signal: new AbortController().signal,
      });
      expect(result.blockProposal?.payload.value).toMatchObject({
        items: [expect.objectContaining({ type: "text" })],
      });
      expect(invoke).toHaveBeenCalledOnce();
      expect(invoke.mock.calls[0]![0]).toMatchObject({
        input: {
          schemaVersion: "dolly.model.chat-input/3",
          stream: true,
          messages: [{
            role: "user",
            parts: [
              { kind: "text", text: "Read this image." },
              {
                kind: "media",
                mediaReference: { type: "media-reference", mediaId: "media:preflight:0" },
                requirementId: "aether-inline-png-v0",
              },
            ],
          }],
        },
      });
    } finally {
      if (executor.terminate) {
        await executor.terminate({
          moduleId: "general-agent",
          moduleGenerationId: "module-generation-media-preflight",
        }).catch(() => undefined);
      }
      if (pid !== undefined && alive(pid)) throw new Error(`Preflight child ${pid} remained alive`);
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);
});
