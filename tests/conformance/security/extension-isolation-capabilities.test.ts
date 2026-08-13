import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createExtensionProcessModuleExecutor } from "../../../src/adapters/extension-process-module-executor.js";
import { createExtensionEffectJournalLifecycle } from "../../../src/adapters/extension-effect-run-lifecycle.js";
import { InstalledModulePermissionPolicyRegistry } from "../../../src/adapters/installed-module-permission-policy.js";
import { EffectIntentJournal } from "../../../src/core/capabilities/effect-intent-journal.js";
import { FileEffectIntentStore } from "../../../src/core/capabilities/file-effect-intent-store.js";
import { ModulePrivateStorageBackend } from "../../../src/core/capabilities/module-private-storage-capability.js";
import {
  ExtensionIsolationPolicy,
  ExtensionProcessHost,
  type ExtensionEffectRunLifecycle,
  type ExtensionIsolationGuarantees,
  type ExtensionProcessHostOptions,
} from "../../../src/core/extension-process-host.js";
import type { JsonValue } from "../../../src/core/canonical-json.js";
import type { ExtensionPackageManifest } from "../../../src/core/extension-installation-registry.js";
import type { InstalledExtensionModule } from "../../../src/core/installed-extension-module.js";
import { FileToolJournalRepository } from "../../../src/core/file-tool-journal-repository.js";
import type { ChatBrokerInvocation } from "../../../src/core/model-provider-broker.js";
import { ModelDescriptorRegistry } from "../../../src/core/model-provider-descriptor.js";
import { createToolInvocationCapabilityV2 } from "../../../src/core/provider-capabilities/index.js";
import {
  ModuleActor,
  ModuleExecutorTerminationUnconfirmedError,
  ModuleExecutorTerminatedError,
} from "../../../src/core/module-actor.js";
import type { ReactiveModuleInput } from "../../../src/core/reactive-module-input.js";
import type { ReactiveModuleResult } from "../../../src/core/reactive-module-runtime.js";
import {
  InMemoryToolJournalRepository,
  ToolPolicySession,
  ToolRegistry,
  type ToolDescriptor,
  type ToolTurnBudget,
} from "../../../src/core/tool-policy.js";
import {
  CHAT_STRATEGIES,
  chatDescriptor,
} from "../model-provider/fixtures.js";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/extension-process-fixture.mjs", import.meta.url),
);
const FIXTURE_PACKAGE_MANIFEST: ExtensionPackageManifest = {
  schemaVersion: "dolly.extension-package/1",
  extensionId: "com.example.fixture",
  packageVersion: "1.0.0",
  displayName: "Process test fixture",
  description: "Exercises the Extension process protocol in conformance tests.",
  supportedProtocolVersions: ["3.0"],
  entrypoint: "extension-process-fixture.mjs",
  modules: [{
    moduleKind: "fixture",
    activation: "reactive",
    configVersion: 1,
    configurationSchema: { type: "object" },
  }],
  requestedCapabilities: [],
};
const ALL_SANDBOX_GUARANTEES: ExtensionIsolationGuarantees = {
  crashContained: true,
  cpuHangContained: true,
  inheritedEnvironmentScrubbed: true,
  ambientFilesystemDenied: true,
  ambientNetworkDenied: true,
  ambientSubprocessDenied: true,
  hardMemoryLimit: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHost(
  mode: string,
  workingDirectory: string,
  overrides: Partial<ExtensionProcessHostOptions> = {},
): ExtensionProcessHost {
  let id = 0;
  let handle = 0;
  return new ExtensionProcessHost({
    isolation: "process",
    trust: "trusted",
    isolationPolicy: new ExtensionIsolationPolicy(),
    manifest: FIXTURE_PACKAGE_MANIFEST,
    command: process.execPath,
    args: [FIXTURE, mode],
    workingDirectory,
    instanceId: "instance-a",
    moduleId: "module-a",
    moduleGenerationId: "module-generation-a",
    moduleKind: "fixture",
    config: {},
    maxFrameBytes: 16 * 1_024,
    initializationTimeoutMs: 5_000,
    shutdownRequestTimeoutMs: 1_000,
    forceKillDelayMs: 500,
    terminationTimeoutMs: 2_000,
    nextIdentifier: (purpose) => `${purpose}-${++id}`,
    nextCapabilityHandle: () => Buffer.alloc(32, ++handle).toString("base64url"),
    ...overrides,
  });
}

function execution(input = {}) {
  return {
    moduleJobId: "module-job-a",
    runId: "run-a",
    attempt: 1,
    deadline: new Date(Date.now() + 1_000).toISOString(),
    responseTimeoutMs: 2_000,
    hasMore: false,
    input,
  } as const;
}

describe("Extension process isolation and capability checks", () => {
  it("does not send a Run whose Host-owned admission has already expired", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-expired-run-admission-"));
    let now = Date.parse("2026-08-12T00:00:00.000Z");
    const host = createHost("normal", scratch, { wallClockNow: () => now });
    try {
      await host.start();
      const prepared = host.prepareRun(1_000);
      if (prepared.status !== "ready") throw new Error("expected ready Run admission");
      now += 1_000;
      await expect(host.execute({
        moduleJobId: "module-job-expired",
        runId: "run-expired",
        attempt: 1,
        admission: prepared.admission,
        responseTimeoutMs: 2_000,
        hasMore: false,
        input: {},
      })).rejects.toMatchObject({ code: "EXTENSION_RUN_ADMISSION_EXPIRED" });
      expect(host.snapshot.state).toBe("ready");
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rechecks an admitted deadline after durable pre-dispatch work", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-pre-dispatch-deadline-"));
    const markerPath = join(scratch, "module-executed");
    let now = Date.parse("2026-08-12T00:00:00.000Z");
    const openRun = vi.fn();
    const closeRun = vi.fn();
    const effectRunLifecycle: ExtensionEffectRunLifecycle = {
      resolveRunIdentity: (request) => ({
        moduleJobId: request.moduleJobId,
        runId: request.runId,
        attempt: request.attempt,
        claimToken: "claim-token-deadline",
        moduleGenerationId: request.moduleGenerationId,
      }),
      openRun,
      invokeCapability: async (_invocation, execute) => await execute(),
      closeRun,
    };
    const host = createHost("execute-marker", scratch, {
      wallClockNow: () => now,
      config: { markerPath },
      effectRunLifecycle,
    });
    try {
      await host.start();
      const prepared = host.prepareRun(1_000);
      if (prepared.status !== "ready") throw new Error("expected ready Run admission");
      await expect(host.execute({
        moduleJobId: "module-job-deadline",
        runId: "run-deadline",
        attempt: 1,
        admission: prepared.admission,
        responseTimeoutMs: 2_000,
        hasMore: false,
        input: {},
        beforeDispatch: () => {
          now += 1_000;
        },
      })).rejects.toMatchObject({ code: "EXTENSION_RUN_ADMISSION_EXPIRED" });

      expect(existsSync(markerPath)).toBe(false);
      expect(openRun).toHaveBeenCalledOnce();
      expect(closeRun).toHaveBeenCalledOnce();
      expect(host.snapshot.state).toBe("ready");
      expect(Object.hasOwn(host.snapshot, "activeRun")).toBe(false);
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("fixes one Host-owned deadline and consumes its Run admission exactly once", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-run-admission-"));
    let now = Date.parse("2026-08-12T00:00:00.000Z");
    const host = createHost("normal", scratch, { wallClockNow: () => now });
    host.grantCapability(
      {
        capabilityType: "private-storage",
        capabilityVersion: "v1",
        operations: ["read"],
        resourceScope: { namespace: "module-a" },
        expiresAt: "2026-08-12T00:00:05.000Z",
        maxInvocations: 1,
        maxInvocationsPerRun: 1,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 256,
        maxResultBytes: 256,
      },
      async () => ({ ok: true }),
    );
    try {
      await host.start();
      const first = host.prepareRun(1_000);
      expect(first).toMatchObject({
        status: "ready",
        admission: { deadline: "2026-08-12T00:00:01.000Z" },
      });
      if (first.status !== "ready") throw new Error("expected ready Run admission");
      now += 500;
      const repeated = host.prepareRun(1_000);
      expect(repeated).toMatchObject({ status: "ready" });
      if (repeated.status !== "ready") throw new Error("expected repeated Run admission");
      expect(repeated.admission).toBe(first.admission);

      await expect(host.execute({
        moduleJobId: "module-job-direct",
        runId: "run-direct",
        attempt: 1,
        deadline: "2026-08-12T00:00:01.500Z",
        responseTimeoutMs: 2_000,
        hasMore: false,
        input: {},
      })).rejects.toMatchObject({ code: "EXTENSION_INVOCATION_INVALID" });

      await expect(host.execute({
        moduleJobId: "module-job-a",
        runId: "run-a",
        attempt: 1,
        admission: first.admission,
        responseTimeoutMs: 2_000,
        hasMore: false,
        input: {},
      })).resolves.toEqual({ ok: true, input: {} });
      await expect(host.execute({
        moduleJobId: "module-job-b",
        runId: "run-b",
        attempt: 1,
        admission: first.admission,
        responseTimeoutMs: 2_000,
        hasMore: false,
        input: {},
      })).rejects.toMatchObject({ code: "EXTENSION_INVOCATION_INVALID" });
      expect(host.prepareRun(4_500)).toEqual({
        status: "rotation-required",
        reason: "capability-expiry",
      });
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("does not open or send a Run when the durable dispatch transition fails", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-dispatch-transition-"));
    const host = createHost("normal", scratch);
    const beforeDispatch = vi.fn(() => {
      throw new Error("persist dispatch transition failed");
    });
    try {
      await host.start();
      const prepared = host.prepareRun(1_000);
      if (prepared.status !== "ready") throw new Error("expected ready Run admission");
      await expect(host.execute({
        moduleJobId: "module-job-not-sent",
        runId: "run-not-sent",
        attempt: 1,
        admission: prepared.admission,
        responseTimeoutMs: 2_000,
        hasMore: false,
        input: {},
        beforeDispatch,
      })).rejects.toThrow("persist dispatch transition failed");
      expect(beforeDispatch).toHaveBeenCalledOnce();
      expect(host.snapshot.state).toBe("ready");
      expect(Object.hasOwn(host.snapshot, "activeRun")).toBe(false);

      const asynchronous = host.prepareRun(1_000);
      if (asynchronous.status !== "ready") throw new Error("expected replacement admission");
      await expect(host.execute({
        moduleJobId: "module-job-async-boundary",
        runId: "run-async-boundary",
        attempt: 1,
        admission: asynchronous.admission,
        responseTimeoutMs: 2_000,
        hasMore: false,
        input: {},
        beforeDispatch: async () => undefined,
      })).rejects.toMatchObject({ code: "EXTENSION_INVOCATION_INVALID" });
      expect(host.snapshot.state).toBe("ready");

      const next = host.prepareRun(1_000);
      if (next.status !== "ready") throw new Error("expected next admission");
      await expect(host.execute({
        moduleJobId: "module-job-next",
        runId: "run-next",
        attempt: 1,
        admission: next.admission,
        responseTimeoutMs: 2_000,
        hasMore: false,
        input: {},
      })).resolves.toEqual({ ok: true, input: {} });
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("enforces a registry-selected strict streaming model policy in a real child", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-installed-model-policy-"));
    const claim = {
      moduleJobId: "module-job-a",
      runId: "run-a",
      attempt: 1,
      claimToken: "claim-token-a",
      moduleGenerationId: "module-generation-a",
    } as const;
    const effectStorePath = join(scratch, "effect-intents.json");
    const effectJournal = new EffectIntentJournal({
      store: new FileEffectIntentStore({ path: effectStorePath }),
      now: () => "2026-08-12T00:00:00.000Z",
    });
    const effectRunLifecycle = createExtensionEffectJournalLifecycle({
      journal: effectJournal,
      getModuleSubmissionRecord: (runId) =>
        runId === claim.runId
          ? {
              schemaVersion: "dolly.module-submission-record/1",
              ...claim,
              processGenerationId: "process-generation-1",
              inputDigest: `sha256:${"c".repeat(64)}`,
              createdAt: "2026-08-12T00:00:00.000Z",
            }
          : undefined,
    });
    const host = createHost("model-stream-required", scratch, { effectRunLifecycle });
    const descriptors = new ModelDescriptorRegistry({
      schemaDigest: `sha256:${"7".repeat(64)}`,
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
        finalContent: "streamed",
        reasoning: { state: "not-observed" as const },
        toolCalls: [],
        finishReason: "stop",
      },
      usage: { providerAttempts: 1, observations: [] },
    }));
    const registry = new InstalledModulePermissionPolicyRegistry({
      policies: [{
        kind: "strict-streaming-chat",
        policyId: "model.owner-primary",
        descriptor,
        ownerScope: "owner-1",
        budgets: {
          maxProviderAttempts: 1,
          maxWallTimeMs: 1_000,
          maxRequestBytes: 16 * 1_024,
          maxResponseBytes: 16 * 1_024,
          maxInputItems: 8,
          maxInputBytes: 8 * 1_024,
          maxOutputBytes: 8 * 1_024,
          maxOutputTokens: 128,
        },
        chat: { invoke },
        outputContracts: ["text"],
        reasoningPolicies: ["disable"],
        roles: ["user"],
        limits: {
          maxInvocations: 2,
          maxInvocationsPerRun: 2,
          maxInvocationsPerWindow: 2,
          rateWindowMs: 60_000,
        },
        capabilityLifetimeMs: 60_000,
      }],
    });
    const resolved = {
      instanceId: "instance-a",
      installation: {
        manifest: FIXTURE_PACKAGE_MANIFEST,
        packageDigest: `sha256:${"a".repeat(64)}`,
      },
      module: {
        moduleId: "module-a",
        extensionId: FIXTURE_PACKAGE_MANIFEST.extensionId,
        moduleKind: "fixture",
        timeouts: {
          initializationTimeoutMs: 5_000,
          executionTimeoutMs: 1_000,
          cancellationGraceMs: 1_000,
          terminationTimeoutMs: 2_000,
        },
        permissionPolicyIds: ["model.owner-primary"],
        configurationReference: {
          configId: "fixture-config",
          revision: `sha256:${"b".repeat(64)}`,
          configVersion: 1,
        },
      },
      packageModule: FIXTURE_PACKAGE_MANIFEST.modules[0],
      configuration: {
        schemaVersion: "dolly.module-configuration/1",
        configId: "fixture-config",
        revision: `sha256:${"b".repeat(64)}`,
        extensionId: FIXTURE_PACKAGE_MANIFEST.extensionId,
        moduleKind: "fixture",
        configVersion: 1,
        configuration: {},
      },
    } as unknown as InstalledExtensionModule;
    registry.setupFor(resolved).configureHost(host);

    try {
      await host.start();
      await expect(host.execute({
        ...execution(),
        deadline: new Date(Date.now() + 5_000).toISOString(),
        responseTimeoutMs: 6_000,
      })).resolves.toMatchObject({
        nonStreaming: { capabilityErrorCode: "CAPABILITY_DENIED" },
        streaming: {
          schemaVersion: "dolly.model-operation-result/1",
          operation: "chat",
          status: "succeeded",
          output: { finalContent: "streamed" },
        },
      });
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke.mock.calls[0]![0].input.stream).toBe(true);
      expect(effectJournal.listForRun(claim).map((record) => record.outcome.kind))
        .toEqual(["unknown", "terminal"]);
      expect(new EffectIntentJournal({
        store: new FileEffectIntentStore({ path: effectStorePath }),
        now: () => "2026-08-12T00:00:00.000Z",
      }).evidenceForRun(claim)).toMatchObject({ kind: "unknown" });
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("persists and reloads a bounded task checkpoint through an installed Host policy", async () => {
    const workspaceTmp = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));
    mkdirSync(workspaceTmp, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(workspaceTmp, "dolly-extension-checkpoint-policy-"));
    const claim = {
      moduleJobId: "module-job-a",
      runId: "run-a",
      attempt: 1,
      claimToken: "claim-token-a",
      moduleGenerationId: "module-generation-a",
    } as const;
    const effectStorePath = join(scratch, "effect-intents.json");
    const effectJournal = new EffectIntentJournal({
      store: new FileEffectIntentStore({ path: effectStorePath }),
      now: () => "2026-08-12T00:00:00.000Z",
    });
    const effectRunLifecycle = createExtensionEffectJournalLifecycle({
      journal: effectJournal,
      getModuleSubmissionRecord: (runId) =>
        runId === claim.runId
          ? {
              schemaVersion: "dolly.module-submission-record/1",
              ...claim,
              processGenerationId: "process-generation-1",
              inputDigest: `sha256:${"c".repeat(64)}`,
              createdAt: "2026-08-12T00:00:00.000Z",
            }
          : undefined,
    });
    const host = createHost("private-storage-checkpoint-active-run", scratch, {
      effectRunLifecycle,
    });
    const backend = new ModulePrivateStorageBackend({
      root: join(scratch, "module-private-storage"),
      now: () => "2026-08-12T00:00:00.000Z",
    });
    const registry = new InstalledModulePermissionPolicyRegistry({
      policies: [{
        kind: "module-private-storage",
        policyId: "memory.owner-checkpoints",
        backend,
        operations: ["get", "list", "set"],
        limits: {
          maxKeyBytes: 128,
          maxValueBytes: 16 * 1_024,
          maxEntries: 64,
          maxTotalBytes: 256 * 1_024,
          maxListResults: 32,
          maxArgumentBytes: 32 * 1_024,
          maxResultBytes: 32 * 1_024,
          maxInvocations: 16,
          maxInvocationsPerRun: 4,
        },
        capabilityLifetimeMs: 60_000,
      }],
    });
    const resolved = {
      instanceId: "instance-a",
      installation: {
        manifest: FIXTURE_PACKAGE_MANIFEST,
        packageDigest: `sha256:${"a".repeat(64)}`,
      },
      module: {
        moduleId: "module-a",
        extensionId: FIXTURE_PACKAGE_MANIFEST.extensionId,
        moduleKind: "fixture",
        timeouts: {
          initializationTimeoutMs: 5_000,
          executionTimeoutMs: 1_000,
          cancellationGraceMs: 1_000,
          terminationTimeoutMs: 2_000,
        },
        permissionPolicyIds: ["memory.owner-checkpoints"],
        configurationReference: {
          configId: "fixture-config",
          revision: `sha256:${"b".repeat(64)}`,
          configVersion: 1,
        },
      },
      packageModule: FIXTURE_PACKAGE_MANIFEST.modules[0],
      configuration: {
        schemaVersion: "dolly.module-configuration/1",
        configId: "fixture-config",
        revision: `sha256:${"b".repeat(64)}`,
        extensionId: FIXTURE_PACKAGE_MANIFEST.extensionId,
        moduleKind: "fixture",
        configVersion: 1,
        configuration: {},
      },
    } as unknown as InstalledExtensionModule;
    const setup = registry.setupFor(resolved);
    expect(setup.snapshot.capabilities).toEqual([{
      capabilityType: "module-private-storage",
      capabilityVersion: "v2",
      policyId: "memory.owner-checkpoints",
      operations: ["get", "list", "set"],
      limits: {
        maxKeyBytes: 128,
        maxValueBytes: 16 * 1_024,
        maxEntries: 64,
        maxTotalBytes: 256 * 1_024,
        maxListResults: 32,
        maxArgumentBytes: 32 * 1_024,
        maxResultBytes: 32 * 1_024,
        maxInvocations: 16,
        maxInvocationsPerRun: 4,
      },
      effectPolicy: "persistent-storage",
    }]);
    setup.configureHost(host);

    try {
      await host.start();
      await expect(host.execute(execution())).resolves.toMatchObject({
        stored: {
          schemaVersion: "dolly.storage-set/1",
          stored: true,
          entryCount: 1,
        },
        listed: {
          schemaVersion: "dolly.storage-list/1",
          keys: ["task-checkpoint"],
          truncated: false,
        },
        loaded: {
          schemaVersion: "dolly.storage-get/1",
          found: true,
          value: {
            schemaVersion: "dolly.task-checkpoint/1",
            taskId: "task-a",
            nextAction: "resume-step-2",
            evidenceKeys: ["source-a"],
          },
        },
      });
      const namespace = backend.namespaceFor("instance-a", "module-a");
      expect(backend.read({
        namespace,
        instanceId: "instance-a",
        moduleId: "module-a",
      }).entries).toEqual([
        expect.objectContaining({ key: "task-checkpoint" }),
      ]);
      expect(effectJournal.listForRun(claim).map((record) => record.outcome.kind))
        .toEqual(["terminal", "terminal", "terminal"]);
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("derives an active-Run registered-tool view from the installed Host policy", async () => {
    const workspaceTmp = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));
    mkdirSync(workspaceTmp, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(workspaceTmp, "dolly-extension-installed-tool-policy-"));
    const claim = {
      moduleJobId: "module-job-a",
      runId: "run-a",
      attempt: 1,
      claimToken: "claim-token-a",
      moduleGenerationId: "module-generation-a",
    } as const;
    const effectStorePath = join(scratch, "effect-intents.json");
    const effectJournal = new EffectIntentJournal({
      store: new FileEffectIntentStore({ path: effectStorePath }),
      now: () => "2026-08-12T00:00:00.000Z",
    });
    const effectRunLifecycle = createExtensionEffectJournalLifecycle({
      journal: effectJournal,
      getModuleSubmissionRecord: (runId) =>
        runId === claim.runId
          ? {
              schemaVersion: "dolly.module-submission-record/1",
              ...claim,
              processGenerationId: "process-generation-1",
              inputDigest: `sha256:${"c".repeat(64)}`,
              createdAt: "2026-08-12T00:00:00.000Z",
            }
          : undefined,
    });
    const host = createHost("tool-registry-execute-active-run", scratch, {
      effectRunLifecycle,
    });
    const readTool: ToolDescriptor = {
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
    const tools = new ToolRegistry([readTool], [readTool.toolId]);
    const execute = vi.fn().mockResolvedValue({
      status: "succeeded" as const,
      content: "value",
    });
    const toolJournalPath = join(scratch, "tool-rounds.json");
    const registry = new InstalledModulePermissionPolicyRegistry({
      policies: [{
        kind: "registered-tools",
        policyId: "tools.owner-notes",
        registry: tools,
        repository: new FileToolJournalRepository({ path: toolJournalPath }),
        executor: { execute },
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
      }],
    });
    const resolved = {
      instanceId: "instance-a",
      installation: {
        manifest: FIXTURE_PACKAGE_MANIFEST,
        packageDigest: `sha256:${"a".repeat(64)}`,
      },
      module: {
        moduleId: "module-a",
        extensionId: FIXTURE_PACKAGE_MANIFEST.extensionId,
        moduleKind: "fixture",
        timeouts: {
          initializationTimeoutMs: 5_000,
          executionTimeoutMs: 1_000,
          cancellationGraceMs: 1_000,
          terminationTimeoutMs: 2_000,
        },
        permissionPolicyIds: ["tools.owner-notes"],
        configurationReference: {
          configId: "fixture-config",
          revision: `sha256:${"b".repeat(64)}`,
          configVersion: 1,
        },
      },
      packageModule: FIXTURE_PACKAGE_MANIFEST.modules[0],
      configuration: {
        schemaVersion: "dolly.module-configuration/1",
        configId: "fixture-config",
        revision: `sha256:${"b".repeat(64)}`,
        extensionId: FIXTURE_PACKAGE_MANIFEST.extensionId,
        moduleKind: "fixture",
        configVersion: 1,
        configuration: {},
      },
    } as unknown as InstalledExtensionModule;
    const setup = registry.setupFor(resolved);
    expect(setup.snapshot.capabilities).toEqual([{
      capabilityType: "tool-invocation",
      capabilityVersion: "v2",
      policyId: "tools.owner-notes",
      registryDigest: tools.snapshot().registryDigest,
      toolWireNames: ["read_note"],
      effectPolicy: "read-only",
    }]);
    setup.configureHost(host);

    try {
      await host.start();
      await expect(host.execute(execution())).resolves.toMatchObject({
        view: {
          schemaVersion: "dolly.tool-registry-view/2",
          moduleJobId: "module-job-a",
          registryDigest: tools.snapshot().registryDigest,
          tools: [{
            name: "read_note",
            schemaDialect: "dolly.tool-value-schema/1",
            effectClass: "read",
          }],
        },
        round: {
          schemaVersion: "dolly.tool-round-result/2",
          moduleJobId: "module-job-a",
          roundIndex: 1,
          state: "complete",
          canContinue: true,
          results: [{
            callId: "call-read-note",
            name: "read_note",
            status: "succeeded",
            content: "value",
          }],
        },
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({
        moduleJobId: "module-job-a",
        toolId: "notes.read",
        arguments: { key: "deployment-note" },
      }));
      expect(new FileToolJournalRepository({ path: toolJournalPath })
        .getRound("module-job-a", 1)).toMatchObject({
          state: "complete",
          effects: [{
            status: "terminal",
            result: { status: "succeeded", content: "value" },
          }],
        });
      expect(effectJournal.listForRun(claim).map((record) => record.outcome.kind))
        .toEqual(["terminal", "terminal"]);
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("refuses public untrusted code without a passing operating-system sandbox", () => {
    const policy = new ExtensionIsolationPolicy();
    expect(() => policy.resolve("process", "untrusted")).toThrowError(
      expect.objectContaining({ code: "EXTENSION_ISOLATION_DENIED" }),
    );
    expect(() => policy.resolve("sandbox", "untrusted")).toThrowError(
      expect.objectContaining({ code: "EXTENSION_SANDBOX_UNAVAILABLE" }),
    );

    const declaredBackend = new ExtensionIsolationPolicy([
      {
        backendId: "test-only-sandbox",
        backendVersion: "v1",
        platform: process.platform,
        conformanceStatus: "passed",
        guarantees: ALL_SANDBOX_GUARANTEES,
      },
    ]);
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-process-protocol-isolation-"));
    try {
      expect(
        () =>
          createHost("normal", scratch, {
            isolation: "sandbox",
            trust: "untrusted",
            isolationPolicy: declaredBackend,
          }),
      ).toThrowError(expect.objectContaining({ code: "EXTENSION_ISOLATION_DENIED" }));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects incomplete sandbox guarantee evidence", () => {
    expect(
      () =>
        new ExtensionIsolationPolicy([
          {
            backendId: "incomplete-sandbox",
            backendVersion: "v1",
            platform: process.platform,
            conformanceStatus: "passed",
            guarantees: {
              crashContained: true,
            } as ExtensionIsolationGuarantees,
          },
        ]),
    ).toThrowError(expect.objectContaining({ code: "EXTENSION_HOST_OPTIONS_INVALID" }));
  });

  it("rejects Extension process protocol 2.0 during manifest negotiation", () => {
    expect(() =>
      createHost("normal", tmpdir(), {
        manifest: {
          ...FIXTURE_PACKAGE_MANIFEST,
          extensionId: "com.example.old-protocol",
          supportedProtocolVersions: ["2.0"],
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "EXTENSION_PROCESS_PROTOCOL_INCOMPATIBLE" }),
    );
  });

  it.each([
    ["dolly.extension-package/2", {
      ...FIXTURE_PACKAGE_MANIFEST,
      schemaVersion: "dolly.extension-package/2",
      modules: [{
        ...FIXTURE_PACKAGE_MANIFEST.modules[0]!,
        activation: "reactive",
        producedContentSchemas: [],
      }],
    } satisfies ExtensionPackageManifest],
    ["dolly.extension-package/3", {
      ...FIXTURE_PACKAGE_MANIFEST,
      schemaVersion: "dolly.extension-package/3",
      modules: [{
        ...FIXTURE_PACKAGE_MANIFEST.modules[0]!,
        activation: "source",
        producedContentSchemas: [],
      }],
    } satisfies ExtensionPackageManifest],
    ["dolly.extension-package/4", {
      ...FIXTURE_PACKAGE_MANIFEST,
      schemaVersion: "dolly.extension-package/4",
      modules: [{
        ...FIXTURE_PACKAGE_MANIFEST.modules[0]!,
        activation: "periodic",
        producedContentSchemas: [],
      }],
    } satisfies ExtensionPackageManifest],
  ] as const)("negotiates the common process contract for %s", async (
    _schemaVersion,
    manifest,
  ) => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-versioned-process-"));
    const host = createHost("normal", scratch, {
      manifest,
    });
    try {
      await expect(host.start()).resolves.toMatchObject({
        state: "ready",
        extensionId: "com.example.fixture",
        moduleId: "module-a",
      });
      await host.stop();
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a forged requested capability before process creation", () => {
    const manifest = {
      ...FIXTURE_PACKAGE_MANIFEST,
      requestedCapabilities: ["network"],
    } as unknown as ExtensionPackageManifest;
    expect(() => createHost("normal", tmpdir(), { manifest })).toThrowError(
      expect.objectContaining({ code: "EXTENSION_HOST_OPTIONS_INVALID" }),
    );
  });

  it("rejects a process that responds with Extension process protocol 2.0", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-old-protocol-"));
    const host = createHost("old-protocol", scratch);
    try {
      await expect(host.start()).rejects.toMatchObject({
        code: "EXTENSION_PROCESS_PROTOCOL_INCOMPATIBLE",
      });
      await host.stop();
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("revokes the session and reaches stopped state when process startup fails", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-start-failure-"));
    const host = createHost("normal", scratch, {
      command: join(scratch, "missing-extension-command"),
      args: [],
    });
    try {
      await expect(host.start()).rejects.toMatchObject({ code: "EXTENSION_INTERNAL" });
      expect(host.snapshot.state).toBe("stopped");
      await expect(host.terminate()).resolves.toMatchObject({ state: "stopped" });
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("does not begin initialization after termination starts during process launch", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-initialization-stop-"));
    const host = createHost("initialize-hang", scratch, {
      initializationTimeoutMs: 5_000,
      forceKillDelayMs: 50,
      terminationTimeoutMs: 1_000,
    });
    const startFailure = host.start().catch((error: unknown) => error);

    try {
      await vi.waitFor(() => expect(host.snapshot.pid).toBeTypeOf("number"), {
        timeout: 1_000,
        interval: 5,
      });
      await expect(host.terminate()).resolves.toMatchObject({ state: "stopped" });
      await expect(startFailure).resolves.toMatchObject({ code: "EXTENSION_STATE_INVALID" });
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("keeps a terminated process stopped when Module creation is still pending", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-module-create-stop-"));
    const markerPath = join(scratch, "module-create-received.txt");
    const host = createHost("module-create-hang", scratch, {
      config: { markerPath },
      initializationTimeoutMs: 5_000,
      forceKillDelayMs: 50,
      terminationTimeoutMs: 1_000,
    });
    const startFailure = host.start().catch((error: unknown) => error);

    try {
      await vi.waitFor(() => expect(existsSync(markerPath)).toBe(true), {
        timeout: 1_000,
        interval: 5,
      });
      await expect(host.terminate()).resolves.toMatchObject({ state: "stopped" });
      await expect(startFailure).resolves.toMatchObject({ code: "EXTENSION_PROCESS_EXITED" });
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects the removed moduleInstanceId field under protocol 3.0", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-old-module-id-field-"));
    const host = createHost("old-module-id-field", scratch);
    try {
      await expect(host.start()).rejects.toMatchObject({
        code: "EXTENSION_PROCESS_PROTOCOL_VIOLATION",
      });
      await host.stop();
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects the removed moduleHandle field under protocol 3.0", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-old-module-handle-field-"));
    const host = createHost("old-module-handle-field", scratch);
    try {
      await expect(host.start()).rejects.toMatchObject({
        code: "EXTENSION_PROCESS_PROTOCOL_VIOLATION",
      });
      await host.stop();
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("sends isolation, not the removed profile field, during initialization", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-initialization-fields-"));
    const host = createHost("initialization-fields", scratch);
    try {
      await host.start();
      await expect(host.execute(execution())).resolves.toEqual({
        isolation: "process",
        hasProfile: false,
      });
      const stop = host.stop();
      expect(host.stop()).toBe(stop);
      await stop;
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("scrubs inherited environment but truthfully exposes ordinary process authority", async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-extension-process-protocol-authority-"));
    const scratch = join(root, "scratch");
    const outside = join(root, "outside-host-canary.txt");
    mkdirSync(scratch);
    writeFileSync(outside, "synthetic-host-canary", "utf8");
    const previousSecret = process.env.DOLLY_HOST_SECRET;
    process.env.DOLLY_HOST_SECRET = "must-not-be-inherited";
    const host = createHost("authority-probe", scratch, {
      config: { probeFilePath: outside },
    });

    try {
      const ready = await host.start();
      expect(ready).toMatchObject({
        isolation: "process",
        state: "ready",
        guarantees: {
          crashContained: true,
          cpuHangContained: true,
          inheritedEnvironmentScrubbed: true,
          ambientFilesystemDenied: false,
          ambientNetworkDenied: false,
          ambientSubprocessDenied: false,
          hardMemoryLimit: false,
        },
      });
      await expect(host.execute(execution())).resolves.toEqual({
        inheritedSecret: null,
        fileValue: "synthetic-host-canary",
        listenerOpened: true,
        subprocessCreated: true,
      });
      await expect(host.stop()).resolves.toMatchObject({ state: "stopped" });
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      if (previousSecret === undefined) delete process.env.DOLLY_HOST_SECRET;
      else process.env.DOLLY_HOST_SECRET = previousSecret;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("contains a real CPU loop and confirms process exit after the response timeout", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-process-protocol-cpu-"));
    const host = createHost("cpu-loop", scratch, {
      shutdownRequestTimeoutMs: 200,
      forceKillDelayMs: 500,
    });
    try {
      await host.start();
      const startedAt = Date.now();
      await expect(
        host.execute({
          ...execution(),
          deadline: new Date(Date.now() + 25).toISOString(),
          responseTimeoutMs: 50,
        }),
      ).rejects.toBeInstanceOf(ModuleExecutorTerminatedError);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("stops a real unresponsive child within the configured host response bound", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-process-stop-hang-"));
    const host = createHost("cpu-loop", scratch, {
      shutdownRequestTimeoutMs: 50,
      forceKillDelayMs: 500,
    });
    try {
      await host.start();
      const executionResult = host.execute({
        ...execution(),
        deadline: new Date(Date.now() + 2_000).toISOString(),
        responseTimeoutMs: 4_000,
      });
      const rejection = expect(executionResult).rejects.toBeInstanceOf(
        ModuleExecutorTerminatedError,
      );
      const startedAt = Date.now();
      await expect(host.stop()).resolves.toMatchObject({ state: "stopped" });
      await rejection;
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("delivers cooperative cancellation without stopping a responsive process", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-process-cancel-"));
    const host = createHost("cancel-aware", scratch);
    try {
      await host.start();
      const result = host.execute(execution());
      await expect(host.cancel("run-a", "soft-timeout")).resolves.toBe("sent");
      await expect(host.cancel("run-a", "soft-timeout")).resolves.toBe("already-sent");
      await expect(result).resolves.toEqual({ cancelled: true, reason: "soft-timeout" });
      expect(host.snapshot.state).toBe("ready");
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("waits for real process exit and rejects a result that arrives after termination", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-process-late-result-"));
    const host = createHost("late-after-cancel", scratch);
    try {
      await host.start();
      const executionResult = host.execute(execution());
      const rejection = expect(executionResult).rejects.toBeInstanceOf(
        ModuleExecutorTerminatedError,
      );
      await expect(host.cancel("run-a", "hard-timeout")).resolves.toBe("sent");
      const termination = host.terminate();
      expect(host.terminate()).toBe(termination);
      await expect(termination).resolves.toMatchObject({ state: "stopped" });
      await rejection;
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("reports a real child crash only after the stopped environment is confirmed", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-process-crash-"));
    const host = createHost("crash", scratch);
    try {
      await host.start();
      await expect(host.execute(execution())).rejects.toBeInstanceOf(
        ModuleExecutorTerminatedError,
      );
      expect(host.snapshot.state).toBe("stopped");
      await expect(host.terminate()).resolves.toMatchObject({ state: "stopped" });
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("keeps the same process ready after an ordinary extension business error", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-process-business-error-"));
    const host = createHost("business-error", scratch);
    try {
      await host.start();
      const processGenerationId = host.snapshot.processGenerationId;
      await expect(host.execute(execution())).rejects.toMatchObject({
        code: "EXTENSION_INTERNAL",
      });
      expect(host.snapshot).toMatchObject({ state: "ready", processGenerationId });
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("durably closes an exact zero-capability Run before returning its result", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-effect-empty-run-"));
    const path = join(scratch, "effect-intents.json");
    const identity = {
      moduleJobId: "module-job-a",
      runId: "run-a",
      attempt: 1,
      claimToken: "claim-token-a",
      moduleGenerationId: "module-generation-a",
    } as const;
    const journal = new EffectIntentJournal({
      store: new FileEffectIntentStore({ path }),
      now: () => "2026-08-10T03:00:00.000Z",
    });
    const host = createHost("normal", scratch, {
      effectRunLifecycle: createExtensionEffectJournalLifecycle({
        journal,
        getModuleSubmissionRecord: (runId) => {
          expect(runId).toBe(identity.runId);
          return {
            schemaVersion: "dolly.module-submission-record/1",
            ...identity,
            processGenerationId: "process-generation-1",
            inputDigest: `sha256:${"a".repeat(64)}`,
            createdAt: "2026-08-10T03:00:00.000Z",
          };
        },
      }),
    });
    try {
      await host.start();
      await expect(host.execute(execution())).resolves.toMatchObject({ ok: true });
      expect(journal.evidenceForRun(identity)).toEqual({ kind: "no-effect" });
      expect(
        new EffectIntentJournal({
          store: new FileEffectIntentStore({ path }),
          now: () => "2026-08-10T03:00:01.000Z",
        }).evidenceForRun(identity),
      ).toEqual({ kind: "no-effect" });
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a submission that does not match the Host execution", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-effect-foreign-submission-"));
    const path = join(scratch, "effect-intents.json");
    const journal = new EffectIntentJournal({
      store: new FileEffectIntentStore({ path }),
      now: () => "2026-08-10T03:00:00.000Z",
    });
    const host = createHost("normal", scratch, {
      effectRunLifecycle: createExtensionEffectJournalLifecycle({
        journal,
        getModuleSubmissionRecord: (runId) => {
          expect(runId).toBe("run-a");
          return {
            schemaVersion: "dolly.module-submission-record/1",
            moduleJobId: "foreign-module-job",
            runId,
            attempt: 1,
            claimToken: "foreign-claim-token",
            moduleGenerationId: "module-generation-a",
            processGenerationId: "process-generation-1",
            inputDigest: `sha256:${"b".repeat(64)}`,
            createdAt: "2026-08-10T03:00:00.000Z",
          };
        },
      }),
    });
    try {
      await host.start();
      await expect(host.execute(execution())).rejects.toThrow(
        "Module submission does not match the Host execution identity",
      );
      expect(host.snapshot.state).toBe("ready");
      expect(journal.evidenceForRun({
        moduleJobId: "module-job-a",
        runId: "run-a",
        attempt: 1,
        claimToken: "foreign-claim-token",
        moduleGenerationId: "module-generation-a",
      }).kind).toBe("unknown");
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("records a granted capability before exposing the later Module failure", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-effect-terminal-run-"));
    const path = join(scratch, "effect-intents.json");
    const identity = {
      moduleJobId: "module-job-a",
      runId: "run-a",
      attempt: 1,
      claimToken: "claim-token-a",
      moduleGenerationId: "module-generation-a",
    } as const;
    const store = new FileEffectIntentStore({ path });
    const journal = new EffectIntentJournal({
      store,
      now: () => "2026-08-10T03:00:00.000Z",
    });
    const handler = vi.fn(async () => ({ fromHost: true }));
    const host = createHost("capability-then-business-error", scratch, {
      effectRunLifecycle: createExtensionEffectJournalLifecycle({
        journal,
        getModuleSubmissionRecord: () => ({
          schemaVersion: "dolly.module-submission-record/1",
          ...identity,
          processGenerationId: "process-generation-1",
          inputDigest: `sha256:${"c".repeat(64)}`,
          createdAt: "2026-08-10T03:00:00.000Z",
        }),
      }),
    });
    host.grantCapability(
      {
        capabilityType: "private-storage",
        capabilityVersion: "v1",
        operations: ["read"],
        resourceScope: { descriptor: "fixture-storage", executionScope: "active-run" },
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxInvocations: 1,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 256,
        maxResultBytes: 256,
        requireIdempotencyKey: true,
      },
      handler,
    );
    try {
      await host.start();
      await expect(host.execute(execution())).rejects.toMatchObject({
        code: "EXTENSION_INTERNAL",
      });
      expect(handler).toHaveBeenCalledOnce();
      expect(store.list()).toHaveLength(1);
      expect(journal.evidenceForRun(identity)).toEqual({ kind: "terminal" });
      expect(host.snapshot.state).toBe("ready");
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("records a Host quota refusal as no-effect without hiding earlier terminal effects", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-effect-quota-refusal-"));
    const path = join(scratch, "effect-intents.json");
    const identity = {
      moduleJobId: "module-job-a",
      runId: "run-a",
      attempt: 1,
      claimToken: "claim-token-a",
      moduleGenerationId: "module-generation-a",
    } as const;
    const store = new FileEffectIntentStore({ path });
    const journal = new EffectIntentJournal({
      store,
      now: () => "2026-08-10T03:00:00.000Z",
    });
    const handler = vi.fn(async () => ({ fromHost: true }));
    const host = createHost("capability-quota-then-business-error", scratch, {
      effectRunLifecycle: createExtensionEffectJournalLifecycle({
        journal,
        getModuleSubmissionRecord: () => ({
          schemaVersion: "dolly.module-submission-record/1",
          ...identity,
          processGenerationId: "process-generation-1",
          inputDigest: `sha256:${"d".repeat(64)}`,
          createdAt: "2026-08-10T03:00:00.000Z",
        }),
      }),
    });
    host.grantCapability(
      {
        capabilityType: "private-storage",
        capabilityVersion: "v1",
        operations: ["read"],
        resourceScope: { descriptor: "fixture-storage", executionScope: "active-run" },
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxInvocations: 1,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 256,
        maxResultBytes: 256,
        requireIdempotencyKey: true,
      },
      handler,
    );
    try {
      await host.start();
      await expect(host.execute(execution())).rejects.toMatchObject({
        code: "EXTENSION_INTERNAL",
      });
      expect(handler).toHaveBeenCalledOnce();
      expect(store.list().map((record) => record.outcome.kind)).toEqual([
        "terminal",
        "no-effect",
      ]);
      expect(journal.evidenceForRun(identity)).toEqual({ kind: "terminal" });
      expect(host.snapshot.state).toBe("ready");
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects an oversized frame before JSON parsing and terminates only that extension", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-process-protocol-frame-"));
    const host = createHost("oversized-frame", scratch);
    try {
      await host.start();
      await expect(host.execute(execution())).rejects.toBeInstanceOf(
        ModuleExecutorTerminatedError,
      );
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("routes declared capabilities through the broker and rejects a handle in a new session", async () => {
    const root = mkdtempSync(join(tmpdir(), "dolly-extension-process-protocol-capability-"));
    const firstScratch = join(root, "first");
    const secondScratch = join(root, "second");
    mkdirSync(firstScratch);
    mkdirSync(secondScratch);
    const handler = vi.fn(async () => ({ fromHost: true }));
    const first = createHost("capability", firstScratch);
    const oldHandle = first.grantCapability(
      {
        capabilityType: "private-storage",
        capabilityVersion: "v1",
        operations: ["read"],
        resourceScope: { namespace: "module-a" },
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxInvocations: 2,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 256,
        maxResultBytes: 256,
        executionScope: {
          moduleJobId: "module-job-capability",
          runId: "run-capability",
        },
        requireIdempotencyKey: true,
      },
      handler,
    );

    let second: ExtensionProcessHost | undefined;
    try {
      await first.start();
      await expect(
        first.execute({
          ...execution(),
          moduleJobId: "module-job-capability",
          runId: "run-capability",
        }),
      ).resolves.toEqual({ fromHost: true });
      expect(handler).toHaveBeenCalledTimes(1);
      await first.stop();

      second = createHost("stale-capability", secondScratch, {
        config: {
          staleHandle: {
            schemaVersion: oldHandle.schemaVersion,
            handle: oldHandle.handle,
          },
        },
      });
      await second.start();
      await expect(
        second.execute({
          ...execution(),
          moduleJobId: "module-job-capability",
          runId: "run-capability",
        }),
      ).resolves.toEqual({ capabilityErrorCode: "CAPABILITY_DENIED" });
      await second.stop();
    } finally {
      if (first.snapshot.state !== "stopped") await first.stop().catch(() => undefined);
      if (second && second.snapshot.state !== "stopped") {
        await second.stop().catch(() => undefined);
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds one process-lifetime capability handle to each current Run", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-active-run-capability-"));
    const host = createHost("capability-active-run", scratch);
    const observed: Array<{ moduleJobId?: string; runId?: string; attempt?: number }> = [];
    host.grantCapability(
      {
        capabilityType: "private-storage",
        capabilityVersion: "v1",
        operations: ["read"],
        resourceScope: { descriptor: "fixture-model", executionScope: "active-run" },
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxInvocations: 2,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 256,
        maxResultBytes: 256,
        requireIdempotencyKey: true,
      },
      async (_argumentsValue, context) => {
        observed.push({
          moduleJobId: context.moduleJobId,
          runId: context.runId,
          attempt: (context as typeof context & { attempt?: number }).attempt,
        });
        return { fromHost: true };
      },
    );

    try {
      await host.start();
      await expect(host.execute(execution())).resolves.toEqual({ fromHost: true });
      await expect(
        host.execute({
          ...execution(),
          moduleJobId: "module-job-b",
          runId: "run-b",
          attempt: 2,
        }),
      ).resolves.toEqual({ fromHost: true });
      expect(observed).toEqual([
        { moduleJobId: "module-job-a", runId: "run-a", attempt: 1 },
        { moduleJobId: "module-job-b", runId: "run-b", attempt: 2 },
      ]);
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("requires process rotation before Claim when the remaining session quota cannot cover a Run", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-active-run-quota-"));
    const host = createHost("capability-active-run", scratch);
    host.grantCapability(
      {
        capabilityType: "private-storage",
        capabilityVersion: "v2",
        operations: ["read"],
        resourceScope: { descriptor: "fixture-model", executionScope: "active-run" },
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxInvocations: 1,
        maxInvocationsPerRun: 1,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 256,
        maxResultBytes: 256,
        requireIdempotencyKey: true,
      },
      async () => ({ fromHost: true }),
    );

    try {
      await host.start();
      const prepared = host.prepareRun(1_000);
      if (prepared.status !== "ready") throw new Error("expected first Run admission");
      await expect(host.execute({
        moduleJobId: "module-job-a",
        runId: "run-a",
        attempt: 1,
        admission: prepared.admission,
        responseTimeoutMs: 2_000,
        hasMore: false,
        input: {},
      })).resolves.toEqual({ fromHost: true });
      expect(host.prepareRun(1_000)).toEqual({
        status: "rotation-required",
        reason: "capability-invocation-capacity",
      });
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("projects the Host-selected version-two tool registry for each active Run", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-tool-registry-active-run-"));
    const host = createHost("tool-registry-active-run", scratch);
    const budget: ToolTurnBudget = {
      maxRounds: 2,
      maxCalls: 4,
      maxCallsPerRound: 2,
      maxApprovals: 0,
      maxCallBytes: 512,
    };
    const descriptor = (moduleJobId: string): ToolDescriptor => ({
      toolId: `notes.${moduleJobId}`,
      wireName: moduleJobId === "module-job-a" ? "read_note" : "read_second",
      description: `Read notes selected for ${moduleJobId}`,
      argumentSchema: {
        type: "object",
        properties: { key: { type: "string", maxBytes: 32 } },
        required: ["key"],
        additionalProperties: false,
        maxProperties: 1,
      },
      resultSchema: { type: "string", maxBytes: 64 },
      effectClass: "read",
      resourceScope: `scope.${moduleJobId}`,
      approval: "never",
      idempotency: "effect-key",
      outcomeQuery: "supported",
      parallel: "safe",
      deadlineMs: 1_000,
      maxArgumentBytes: 128,
      maxResultBytes: 128,
    });
    const observed: Array<{ moduleJobId: string; runId: string; attempt: number }> = [];
    const definition = createToolInvocationCapabilityV2({
      executionScope: "active-run",
      expiresAt: "2099-01-01T00:00:00.000Z",
      resolveRun: (context) => {
        observed.push({
          moduleJobId: context.moduleJobId,
          runId: context.runId,
          attempt: context.attempt,
        });
        const selected = descriptor(context.moduleJobId);
        const registry = new ToolRegistry([selected], [selected.toolId]);
        return {
          registry,
          budget,
          policy: new ToolPolicySession({
            moduleJobId: context.moduleJobId,
            registry,
            repository: new InMemoryToolJournalRepository(),
            approval: { decide: vi.fn() },
            executor: { execute: vi.fn() },
            budget,
            approvalPolicyRevision: "policy-1",
          }),
        };
      },
    });
    host.grantCapability(definition.grant, definition.handler);

    try {
      await host.start();
      const first = await host.execute(execution());
      const second = await host.execute({
        ...execution(),
        moduleJobId: "module-job-b",
        runId: "run-b",
        attempt: 2,
      });
      expect(first).toMatchObject({
        schemaVersion: "dolly.tool-registry-view/2",
        moduleJobId: "module-job-a",
        tools: [{ name: "read_note", schemaDialect: "dolly.tool-value-schema/1" }],
      });
      expect(second).toMatchObject({
        schemaVersion: "dolly.tool-registry-view/2",
        moduleJobId: "module-job-b",
        tools: [{ name: "read_second", schemaDialect: "dolly.tool-value-schema/1" }],
      });
      expect(observed).toEqual([
        { moduleJobId: "module-job-a", runId: "run-a", attempt: 1 },
        { moduleJobId: "module-job-b", runId: "run-b", attempt: 2 },
      ]);
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("does not treat a settled capability handler as active while its response is delivered", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-capability-then-error-"));
    const host = createHost("capability-then-business-error", scratch);
    const handler = vi.fn(async () => ({ fromHost: true }));
    host.grantCapability(
      {
        capabilityType: "private-storage",
        capabilityVersion: "v1",
        operations: ["read"],
        resourceScope: { descriptor: "fixture-model", executionScope: "active-run" },
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxInvocations: 1,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 256,
        maxResultBytes: 256,
        requireIdempotencyKey: true,
      },
      handler,
    );

    try {
      await host.start();
      const processGenerationId = host.snapshot.processGenerationId;
      await expect(host.execute(execution())).rejects.toMatchObject({
        code: "EXTENSION_INTERNAL",
      });
      expect(handler).toHaveBeenCalledOnce();
      expect(host.snapshot).toMatchObject({ state: "ready", processGenerationId });
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a Module result while one of that Run's capabilities is still active", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-result-before-capability-"));
    const capabilityStartedMarkerPath = join(scratch, "capability-started");
    const effectIdentity = {
      moduleJobId: "module-job-a",
      runId: "run-a",
      attempt: 1,
      claimToken: "claim-token-a",
      moduleGenerationId: "module-generation-a",
    } as const;
    const openRun = vi.fn();
    const closeRun = vi.fn();
    const effectRunLifecycle: ExtensionEffectRunLifecycle = {
      resolveRunIdentity: () => effectIdentity,
      openRun,
      invokeCapability: async (_invocation, execute) => await execute(),
      closeRun,
    };
    const host = createHost("capability-result-before-effect", scratch, {
      config: { capabilityStartedMarkerPath },
      effectRunLifecycle,
    });
    let handlerStarted = false;
    let handlerAborted = false;
    const finishHandler = deferred<{ fromHost: boolean }>();
    host.grantCapability(
      {
        capabilityType: "private-storage",
        capabilityVersion: "v1",
        operations: ["read"],
        resourceScope: { descriptor: "fixture-model" },
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxInvocations: 1,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 256,
        maxResultBytes: 256,
        requireIdempotencyKey: true,
      },
      async (_argumentsValue, context) => {
        handlerStarted = true;
        context.signal.addEventListener(
          "abort",
          () => {
            handlerAborted = true;
          },
          { once: true },
        );
        writeFileSync(capabilityStartedMarkerPath, "started", "utf8");
        return finishHandler.promise;
      },
    );

    try {
      await host.start();
      const result = host.execute(execution()).then(
        (value) => ({ status: "succeeded" as const, value }),
        (error: unknown) => ({ status: "failed" as const, error }),
      );
      await vi.waitFor(() => expect(handlerStarted).toBe(true), {
        timeout: 1_000,
        interval: 5,
      });
      await vi.waitFor(() => expect(handlerAborted).toBe(true), {
        timeout: 1_000,
        interval: 5,
      });
      expect(openRun).toHaveBeenCalledOnce();
      expect(closeRun).not.toHaveBeenCalled();
      finishHandler.resolve({ fromHost: true });
      const boundedResult = Promise.race([
        result,
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error(`Module result did not settle from ${host.snapshot.state}`)),
            3_000,
          );
        }),
      ]);
      await expect(boundedResult).resolves.toEqual({
        status: "failed",
        error: expect.any(ModuleExecutorTerminatedError),
      });
      expect(closeRun).toHaveBeenCalledOnce();
      expect(closeRun).toHaveBeenCalledWith(effectIdentity);
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      finishHandler.resolve({ fromHost: true });
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects Module job and Run identifiers that do not match the active Run", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-forged-run-identifiers-"));
    const host = createHost("capability", scratch);
    const handler = vi.fn(async () => ({ fromHost: true }));
    host.grantCapability(
      {
        capabilityType: "private-storage",
        capabilityVersion: "v1",
        operations: ["read"],
        resourceScope: { namespace: "module-a" },
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxInvocations: 1,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 256,
        maxResultBytes: 256,
        requireIdempotencyKey: true,
      },
      handler,
    );

    try {
      await host.start();
      await expect(host.execute(execution())).resolves.toEqual({
        capabilityErrorCode: "CAPABILITY_SCOPE_MISMATCH",
      });
      expect(handler).not.toHaveBeenCalled();
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a capability request made while no Run is active", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-capability-idle-"));
    const host = createHost("capability-outside-run", scratch);
    const handler = vi.fn(async () => ({ fromHost: true }));
    host.grantCapability(
      {
        capabilityType: "private-storage",
        capabilityVersion: "v1",
        operations: ["read"],
        resourceScope: { namespace: "module-a" },
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxInvocations: 1,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 256,
        maxResultBytes: 256,
        executionScope: {
          moduleJobId: "module-job-capability",
          runId: "run-capability",
        },
        requireIdempotencyKey: true,
      },
      handler,
    );

    try {
      await host.start();
      await expect(
        host.execute({
          ...execution(),
          moduleJobId: "module-job-capability",
          runId: "run-capability",
        }),
      ).resolves.toEqual({ capabilityErrorCode: "CAPABILITY_SCOPE_MISMATCH" });
      expect(handler).not.toHaveBeenCalled();
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a capability request that omits the Run identifier", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-capability-no-run-"));
    const host = createHost("capability-missing-run-id", scratch);
    const handler = vi.fn(async () => ({ fromHost: true }));
    host.grantCapability(
      {
        capabilityType: "private-storage",
        capabilityVersion: "v1",
        operations: ["read"],
        resourceScope: { namespace: "module-a" },
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxInvocations: 1,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 256,
        maxResultBytes: 256,
        executionScope: {
          moduleJobId: "module-job-capability",
          runId: "run-capability",
        },
        requireIdempotencyKey: true,
      },
      handler,
    );

    try {
      await host.start();
      await expect(
        host.execute({
          ...execution(),
          moduleJobId: "module-job-capability",
          runId: "run-capability",
        }),
      ).resolves.toEqual({ capabilityErrorCode: "CAPABILITY_SCOPE_MISMATCH" });
      expect(handler).not.toHaveBeenCalled();
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects the processingId capability field under protocol 3.0", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-old-module-job-field-"));
    const host = createHost("old-module-job-field", scratch);
    const handler = vi.fn(async () => ({ fromHost: true }));
    host.grantCapability(
      {
        capabilityType: "private-storage",
        capabilityVersion: "v1",
        operations: ["read"],
        resourceScope: { namespace: "module-a" },
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxInvocations: 1,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 256,
        maxResultBytes: 256,
        executionScope: {
          moduleJobId: "module-job-capability",
          runId: "run-capability",
        },
        requireIdempotencyKey: true,
      },
      handler,
    );
    try {
      await host.start();
      await expect(host.execute({
        ...execution(),
        moduleJobId: "module-job-capability",
        runId: "run-capability",
      })).resolves.toEqual({
        capabilityErrorCode: "CAPABILITY_DENIED",
      });
      expect(handler).not.toHaveBeenCalled();
      await host.stop();
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });


  it("does not replace a Module executor until an aborted capability handler settles", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-capability-drain-"));
    const host = createHost("capability", scratch);
    const handlerStarted = deferred<void>();
    const handlerAborted = deferred<void>();
    const finishHandler = deferred<{ fromHost: boolean }>();
    host.grantCapability(
      {
        capabilityType: "private-storage",
        capabilityVersion: "v1",
        operations: ["read"],
        resourceScope: { namespace: "module-a" },
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxInvocations: 1,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 256,
        maxResultBytes: 256,
        executionScope: {
          moduleJobId: "module-job-capability",
          runId: "run-capability",
        },
        requireIdempotencyKey: true,
      },
      async (_argumentsValue, context) => {
        context.signal.addEventListener(
          "abort",
          () => handlerAborted.resolve(),
          { once: true },
        );
        handlerStarted.resolve();
        return finishHandler.promise;
      },
    );

    let executorCreations = 0;
    const actor = new ModuleActor<ReactiveModuleInput, ReactiveModuleResult>({
      moduleId: "module-a",
      initialModuleGenerationId: "module-generation-a",
      maxQueuedRuns: 1,
      maxQueuedInputBytes: 1_024,
      maxInputBytes: 512,
      maxRunsPerGeneration: 10,
      maxGenerations: 2,
      requireProcessIsolation: true,
      initializationTimeoutMs: 5_000,
      terminationTimeoutMs: 3_000,
      nextModuleGenerationId: () => "module-generation-b",
      monotonicNow: () => 1,
      snapshotInput: (input) => structuredClone(input),
      measureInputBytes: (input) => Buffer.byteLength(JSON.stringify(input)),
      snapshotOutput: (output) => structuredClone(output),
      createExecutor: (moduleGenerationId) => {
        executorCreations += 1;
        if (executorCreations === 1) {
          return createExtensionProcessModuleExecutor(host, {
            moduleId: "module-a",
            moduleGenerationId,
            executionTimeoutMs: 1_000,
            cancellationGraceMs: 2_000,
          });
        }
        return {
          isolation: "process" as const,
          start: async () => undefined,
          execute: async () => ({ schemaVersion: "dolly.module-result/1" as const }),
          terminate: vi.fn().mockResolvedValue(undefined),
        };
      },
      acceptResult: () => undefined,
    });

    try {
      await actor.start();
      await actor.prepareNextRun();
      const outcome = actor.submit({
        moduleGenerationId: "module-generation-a",
        moduleJobId: "module-job-capability",
        runId: "run-capability",
        attempt: 1,
        input: {
          schemaVersion: "dolly.reactive-module-input/2",
          claimedDeliveryIds: [],
          blockGroups: [],
          hasMore: false,
        },
      });
      await handlerStarted.promise;
      const hardTimeout = actor.hardTimeout("run-capability");
      await handlerAborted.promise;
      await Promise.resolve();
      expect(executorCreations).toBe(1);
      expect(actor.moduleGenerationId).toBe("module-generation-a");

      finishHandler.resolve({ fromHost: true });
      await expect(hardTimeout).resolves.toBe("module-generation-fenced");
      await expect(outcome).resolves.toMatchObject({ status: "fenced" });
      expect(executorCreations).toBe(2);
      expect(actor.moduleGenerationId).toBe("module-generation-b");
      await actor.stop();
    } finally {
      if (host.snapshot.state !== "stopped") {
        finishHandler.resolve({ fromHost: true });
        await host.terminate().catch(() => undefined);
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("reports unconfirmed termination while a capability handler ignores abort", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-capability-timeout-"));
    const host = createHost("capability", scratch, {
      forceKillDelayMs: 20,
      terminationTimeoutMs: 100,
    });
    const handlerStarted = deferred<void>();
    const handlerAborted = deferred<void>();
    const finishHandler = deferred<{ fromHost: boolean }>();
    let handlerAbortObserved = false;
    host.grantCapability(
      {
        capabilityType: "private-storage",
        capabilityVersion: "v1",
        operations: ["read"],
        resourceScope: { namespace: "module-a" },
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxInvocations: 1,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 256,
        maxResultBytes: 256,
        executionScope: {
          moduleJobId: "module-job-capability",
          runId: "run-capability",
        },
        requireIdempotencyKey: true,
      },
      async (_argumentsValue, context) => {
        context.signal.addEventListener(
          "abort",
          () => {
            handlerAbortObserved = true;
            handlerAborted.resolve();
          },
          { once: true },
        );
        handlerStarted.resolve();
        return finishHandler.promise;
      },
    );

    try {
      await host.start();
      const result = host.execute({
        ...execution(),
        moduleJobId: "module-job-capability",
        runId: "run-capability",
      });
      await handlerStarted.promise;
      const termination = host.terminate();
      expect(handlerAbortObserved).toBe(true);
      await handlerAborted.promise;
      await expect(termination).rejects.toMatchObject({
        code: "EXTENSION_TERMINATION_UNCONFIRMED",
      });
      await expect(result).rejects.toBeInstanceOf(
        ModuleExecutorTerminationUnconfirmedError,
      );
      expect(host.snapshot.state).toBe("failed");

      finishHandler.resolve({ fromHost: true });
      await expect(host.terminate()).resolves.toMatchObject({ state: "stopped" });
    } finally {
      finishHandler.resolve({ fromHost: true });
      if (host.snapshot.state !== "stopped") {
        await host.terminate().catch(() => undefined);
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("treats a stale Run result as a protocol violation, not a valid late result", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-extension-process-protocol-stale-"));
    const host = createHost("stale-result", scratch);
    try {
      await host.start();
      await expect(host.execute(execution())).rejects.toBeInstanceOf(
        ModuleExecutorTerminatedError,
      );
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      if (host.snapshot.state !== "stopped") await host.stop().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
