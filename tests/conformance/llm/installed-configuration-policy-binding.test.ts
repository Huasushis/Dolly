import { describe, expect, it } from "vitest";
import { InstalledModulePermissionPolicyRegistry } from "../../../src/adapters/installed-module-permission-policy.js";
import { cloneJson, type JsonValue } from "../../../src/core/canonical-json.js";
import type { InstalledExtensionModule } from "../../../src/core/installed-extension-module.js";
import { EndpointBindingRegistry } from "../../../src/core/model-provider-binding.js";
import type { ModelInvocationBudgets } from "../../../src/core/model-provider-broker.js";
import { ModelDescriptorRegistry, type ChatDescriptorSnapshot } from "../../../src/core/model-provider-descriptor.js";
import { createDefaultLlmModuleConfiguration } from "../../../src/extensions/llm/module-configuration.js";
import { CHAT_STRATEGIES, chatDescriptor } from "../model-provider/fixtures.js";

const INSTANCE_ID = "88888888-8888-4888-8888-888888888888";
const SCHEMA_DIGEST = `sha256:${"8".repeat(64)}`;

function model(modelId: string): {
  readonly descriptor: ChatDescriptorSnapshot;
  readonly descriptors: ModelDescriptorRegistry;
  readonly bindings: EndpointBindingRegistry;
} {
  const descriptors = new ModelDescriptorRegistry({
    schemaDigest: SCHEMA_DIGEST,
    allowedStrategyIds: CHAT_STRATEGIES,
  });
  const ref = descriptors.register(chatDescriptor({ modelId }));
  descriptors.setStatus(ref, "active");
  const bindings = new EndpointBindingRegistry();
  const binding = bindings.register({
    schemaVersion: "dolly.endpoint-binding/2",
    endpointId: ref.endpointId,
    bindingRevision: `${modelId}-binding-v1`,
    descriptorRefs: [ref],
    exactUrl: "https://provider.example.test/v1/chat/completions",
    networkScope: "public",
    authentication: { kind: "none" },
    limits: {
      maxRequestBytes: 64 * 1024,
      maxResponseBytes: 64 * 1024,
      maxTimeoutMs: 60_000,
    },
  });
  bindings.setStatus(binding, "active");
  return { descriptor: descriptors.snapshot(ref), descriptors, bindings };
}

function configuredFor(
  descriptor: ChatDescriptorSnapshot,
  permissionPolicyId: string,
): JsonValue {
  return cloneJson(
    createDefaultLlmModuleConfiguration(
      descriptor,
      permissionPolicyId,
    ) as unknown as JsonValue,
  );
}

function resolved(configuration: JsonValue): InstalledExtensionModule {
  const revision = `sha256:${"a".repeat(64)}`;
  return {
    instanceId: INSTANCE_ID,
    module: {
      moduleId: "agent",
      extensionId: "dolly.llm",
      packageVersion: "1.0.0",
      moduleKind: "conversation",
      isolation: "process",
      configurationReference: { configId: "agent-config", revision, configVersion: 1 },
      permissionPolicyIds: ["model.owner-primary"],
      inputPageIds: ["inbox"],
      outputPageIds: ["outbox"],
      subscriptionStart: "from-now",
      activation: { kind: "reactive" },
      limits: {
        claim: { maxCount: 8, maxBytes: 64 * 1024 },
        maxInputBytes: 1024 * 1024,
        maxResultBytes: 1024 * 1024,
        maxFrameBytes: 2 * 1024 * 1024,
        maxRunsPerGeneration: 100,
        maxGenerations: 10,
      },
      timeouts: {
        initializationTimeoutMs: 30_000,
        executionTimeoutMs: 600_000,
        cancellationGraceMs: 5_000,
        terminationTimeoutMs: 5_000,
      },
    },
    installation: {
      manifest: { extensionId: "dolly.llm" },
      packageDigest: `sha256:${"b".repeat(64)}`,
    },
    packageModule: {},
    configuration: {
      revision,
      configuration,
    },
  } as unknown as InstalledExtensionModule;
}

function policies(
  selected: ReturnType<typeof model>,
  budgetOverrides: Partial<ModelInvocationBudgets> = {},
): InstalledModulePermissionPolicyRegistry {
  return new InstalledModulePermissionPolicyRegistry({
    policies: [{
      kind: "strict-streaming-chat",
      policyId: "model.owner-primary",
      descriptor: selected.descriptor.ref,
      ownerScope: "owner-1",
      budgets: {
        maxProviderAttempts: 1,
        maxWallTimeMs: 60_000,
        maxRequestBytes: 64 * 1024,
        maxResponseBytes: 64 * 1024,
        maxInputItems: 64,
        maxInputBytes: 48 * 1024,
        maxOutputBytes: 32 * 1024,
        maxInputTokens: 30_720,
        maxOutputTokens: 4_096,
        ...budgetOverrides,
      },
      brokerOptions: {
        descriptors: selected.descriptors,
        bindings: selected.bindings,
        secrets: { resolve: async () => { throw new Error("No secret is expected"); } },
        transport: { dispatch: async () => { throw new Error("No request is expected"); } },
      },
      outputContracts: ["text"],
      reasoningPolicies: ["default"],
      roles: ["system", "user", "assistant", "tool"],
      limits: {
        maxMessages: 64,
        maxPartsPerMessage: 8,
        maxPartBytes: 32 * 1024,
        maxInvocations: 4,
        maxInvocationsPerRun: 1,
        maxInvocationsPerWindow: 4,
        rateWindowMs: 60_000,
      },
      capabilityLifetimeMs: 60_000,
    }],
  });
}

describe("installed LLM configuration and Host policy binding", () => {
  it("accepts one exact configuration revision, descriptor snapshot, and Host grant", () => {
    const selected = model("owner-qwen");
    const setup = policies(selected).setupFor(resolved(
      configuredFor(selected.descriptor, "model.owner-primary"),
    ));

    expect(setup.snapshot).toMatchObject({
      moduleId: "agent",
      configurationRevision: `sha256:${"a".repeat(64)}`,
      policyIds: ["model.owner-primary"],
      capabilities: [{
        capabilityType: "model-operation",
        capabilityVersion: "v2",
        policyId: "model.owner-primary",
        streaming: "required",
      }],
    });
  });

  it("rejects a configuration for one descriptor when the selected policy grants another", () => {
    const configured = model("owner-qwen");
    const granted = model("other-model");

    expect(() => policies(granted).setupFor(resolved(
      configuredFor(configured.descriptor, "model.owner-primary"),
    ))).toThrow(/configuration.*descriptor|descriptor.*configuration/iu);
  });

  it("rejects a configuration whose input-token budget exceeds the Host grant by one", () => {
    const selected = model("owner-qwen");

    expect(() => policies(selected, { maxInputTokens: 30_719 }).setupFor(resolved(
      configuredFor(selected.descriptor, "model.owner-primary"),
    ))).toThrow(/configuration exceeds.*Host model invocation budgets/iu);
  });

  it("rejects a configuration that names a model policy the instance did not select", () => {
    const selected = model("owner-qwen");

    expect(() => policies(selected).setupFor(resolved(
      configuredFor(selected.descriptor, "model.unselected"),
    ))).toThrow(/select exactly.*Host model permission policy/iu);
  });
});
