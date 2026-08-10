import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { isJsonObject, type JsonValue } from "../../../src/core/canonical-json.js";
import {
  ExtensionIsolationPolicy,
  ExtensionProcessHost,
} from "../../../src/core/extension-process-host.js";
import type { ExtensionPackageManifest } from "../../../src/core/extension-installation-registry.js";

const EXTENSION = fileURLToPath(
  new URL(
    "../../../scripts/experiments/probes/scheduler-agent-task-switch-v0/extension.mjs",
    import.meta.url,
  ),
);
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const WORKSPACE_TMP = resolve(REPOSITORY_ROOT, "..", ".tmp");
const TASK_ID = "release-aurora";
const CHECKPOINT_KEY = `task.${TASK_ID}.checkpoint`;
const CHECKPOINT = {
  schemaVersion: "dolly.task-checkpoint/1",
  taskId: TASK_ID,
  objective: "Publish the Aurora package after owner approval",
  completed: ["unit-tests", "package-built"],
  constraints: { channel: "canary", retentionHours: 24 },
  nextAction: { kind: "request-approval", target: "owner", reason: "publish-canary" },
  sourceId: "task-a-input",
} as const;
const MANIFEST: ExtensionPackageManifest = {
  schemaVersion: "dolly.extension-package/1",
  extensionId: "org.dolly.scheduler-agent-task-switch",
  packageVersion: "1.0.0",
  displayName: "Scheduler task-switch Agent fixture",
  description: "Exercises a sourced task checkpoint across three Scheduler Runs.",
  supportedProtocolVersions: ["3.0"],
  entrypoint: "extension.mjs",
  modules: [{
    moduleKind: "task-switch-agent",
    activation: "reactive",
    configVersion: 1,
    configurationSchema: { type: "object" },
  }],
  requestedCapabilities: [],
};

function execution(
  moduleJobId: string,
  runId: string,
  task: JsonValue,
): Parameters<ExtensionProcessHost["execute"]>[0] {
  return {
    moduleJobId,
    runId,
    attempt: 1,
    deadline: new Date(Date.now() + 5_000).toISOString(),
    responseTimeoutMs: 30_000,
    hasMore: false,
    input: {
      blockGroups: [{
        block: {
          payload: {
            schema: "dolly.content/1",
            value: {
              items: [{ type: "text", text: JSON.stringify(task), format: "plain" }],
            },
          },
        },
      }],
    },
  };
}

function resultValue(value: JsonValue): Record<string, unknown> {
  const items = (value as { blockProposal?: { payload?: { value?: { items?: unknown } } } })
    .blockProposal?.payload?.value?.items;
  if (!Array.isArray(items) || typeof (items[0] as { text?: unknown })?.text !== "string") {
    throw new Error("Agent result text is absent");
  }
  return JSON.parse((items[0] as { text: string }).text) as Record<string, unknown>;
}

function messageText(argumentsValue: JsonValue): string {
  if (!isJsonObject(argumentsValue) || !Array.isArray(argumentsValue.messages)) {
    throw new Error("model messages are absent");
  }
  return JSON.stringify(argumentsValue.messages);
}

describe("Scheduler Agent task-switch Extension", () => {
  it("checkpoints task A, isolates task B, and resumes task A in one process", async () => {
    mkdirSync(WORKSPACE_TMP, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(WORKSPACE_TMP, "dolly-task-switch-extension-"));
    let identifier = 0;
    let handle = 0;
    let storedCheckpoint: JsonValue | undefined;
    const toolActions: string[] = [];
    const modelRounds = new Map<string, number>();
    const modelMessages = new Map<string, string[]>();
    const host = new ExtensionProcessHost({
      isolation: "process",
      trust: "trusted",
      isolationPolicy: new ExtensionIsolationPolicy(),
      manifest: MANIFEST,
      command: process.execPath,
      args: [EXTENSION],
      workingDirectory: scratch,
      instanceId: "instance-task-switch",
      moduleId: "task-switch-agent",
      moduleGenerationId: "module-generation-task-switch",
      moduleKind: "task-switch-agent",
      config: {},
      maxFrameBytes: 1024 * 1024,
      maxConcurrentCapabilityRequests: 1,
      initializationTimeoutMs: 5_000,
      shutdownRequestTimeoutMs: 1_000,
      forceKillDelayMs: 500,
      terminationTimeoutMs: 2_000,
      nextIdentifier: (purpose) => `${purpose}-${++identifier}`,
      nextCapabilityHandle: () => Buffer.alloc(32, ++handle).toString("base64url"),
    });

    host.grantCapability(
      {
        capabilityType: "model-operation",
        capabilityVersion: "v2",
        operations: ["chat"],
        resourceScope: {
          executionScope: "active-run",
          model: "fake-task-switch",
          outputContracts: ["text", "json-object"],
        },
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxInvocations: 11,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 128 * 1024,
        maxResultBytes: 128 * 1024,
        requireIdempotencyKey: true,
      },
      async (argumentsValue, context): Promise<JsonValue> => {
        if (context.moduleJobId === undefined) throw new Error("active Module job is absent");
        const messages = messageText(argumentsValue);
        const retained = modelMessages.get(context.moduleJobId) ?? [];
        retained.push(messages);
        modelMessages.set(context.moduleJobId, retained);
        const round = (modelRounds.get(context.moduleJobId) ?? 0) + 1;
        modelRounds.set(context.moduleJobId, round);
        let finalContent: string;
        let reasoning: JsonValue = { state: "not-observed" };
        if (context.moduleJobId === "job-checkpoint") {
          if (round === 1) {
            finalContent = "Store the exact sourced checkpoint, then confirm the write.";
            reasoning = { state: "observed", parts: ["Persist only the provided task state."] };
          } else if (round === 2) {
            finalContent = JSON.stringify({
              action: "storage_set",
              arguments: { key: CHECKPOINT_KEY, value: CHECKPOINT },
            });
          } else {
            finalContent = JSON.stringify({
              action: "checkpointed",
              taskId: TASK_ID,
              checkpointKey: CHECKPOINT_KEY,
              stored: true,
            });
          }
        } else if (context.moduleJobId === "job-unrelated") {
          finalContent = JSON.stringify({ action: "answered", taskId: "arithmetic-cobalt", answer: 17 });
        } else {
          if (round === 1) {
            finalContent = "List the task checkpoint, read it, then resume only its recorded next action.";
            reasoning = { state: "observed", parts: ["Retrieve before reconstructing task state."] };
          } else if (round === 2) {
            finalContent = JSON.stringify({
              action: "storage_list",
              arguments: { prefix: `task.${TASK_ID}.`, limit: 3 },
            });
          } else if (round === 3) {
            finalContent = JSON.stringify({
              action: "storage_get",
              arguments: { key: CHECKPOINT_KEY },
            });
          } else {
            finalContent = JSON.stringify({
              action: "resumed",
              taskId: TASK_ID,
              resumed: true,
              nextAction: CHECKPOINT.nextAction,
              evidenceKeys: [CHECKPOINT_KEY],
            });
          }
        }
        return {
          schemaVersion: "dolly.model-operation-result/1",
          operation: "chat",
          status: "succeeded",
          output: { finalContent, finishReason: "stop", reasoning },
        };
      },
    );

    host.grantCapability(
      {
        capabilityType: "tool-invocation",
        capabilityVersion: "v2",
        operations: ["list-tools", "execute-round"],
        resourceScope: { executionScope: "active-run", tools: "task-checkpoint" },
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxInvocations: 5,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 128 * 1024,
        maxResultBytes: 128 * 1024,
        requireIdempotencyKey: true,
      },
      async (argumentsValue, context): Promise<JsonValue> => {
        if (context.moduleJobId === undefined) throw new Error("active Module job is absent");
        const registryDigest = `sha256:${"7".repeat(64)}`;
        if (context.operation === "list-tools") {
          return {
            schemaVersion: "dolly.tool-registry-view/2",
            moduleJobId: context.moduleJobId,
            registryDigest,
            budget: {
              maxRounds: 2,
              maxCalls: 2,
              maxCallsPerRound: 1,
              maxApprovals: 1,
              maxCallBytes: 12 * 1024,
            },
            tools: ["storage_get", "storage_list", "storage_set"].map((name) => ({
              name,
              description: `Fake ${name} contract`,
              schemaDialect: "dolly.tool-value-schema/1",
              argumentSchema: { type: "object" },
              successResultSchema: { type: "object" },
              effectClass: name === "storage_set" ? "write" : "read",
              approval: name === "storage_set" ? "required" : "never",
              idempotency: "effect-key",
              outcomeQuery: "supported",
              parallel: "serial",
              limits: { deadlineMs: 1000, maxArgumentBytes: 8192, maxResultBytes: 8192 },
            })),
          };
        }
        if (!isJsonObject(argumentsValue) || !Array.isArray(argumentsValue.calls)) {
          throw new Error("tool round is absent");
        }
        const call = argumentsValue.calls[0];
        if (!isJsonObject(call) || typeof call.name !== "string" || typeof call.callId !== "string") {
          throw new Error("tool call is invalid");
        }
        const args = JSON.parse(String(call.argumentsJson)) as Record<string, JsonValue>;
        toolActions.push(call.name);
        let content: JsonValue;
        if (call.name === "storage_set") {
          storedCheckpoint = args.value;
          content = { schemaVersion: "dolly.storage-set/1", stored: true, revision: 1, entryCount: 1 };
        } else if (call.name === "storage_list") {
          content = { schemaVersion: "dolly.storage-list/1", keys: [CHECKPOINT_KEY], truncated: false };
        } else {
          if (storedCheckpoint === undefined) throw new Error("checkpoint was not stored");
          content = {
            schemaVersion: "dolly.storage-get/1",
            found: true,
            value: storedCheckpoint,
            updatedAt: "2026-08-10T00:00:00.000Z",
          };
        }
        return {
          schemaVersion: "dolly.tool-round-result/2",
          moduleJobId: context.moduleJobId,
          registryDigest,
          roundIndex: argumentsValue.roundIndex,
          state: "complete",
          canContinue: true,
          results: [{
            callId: call.callId,
            name: call.name,
            status: "succeeded",
            code: "OK",
            content,
          }],
        };
      },
    );

    try {
      await host.start();
      let checkpointResult: Record<string, unknown>;
      try {
        checkpointResult = resultValue(await host.execute(execution(
          "job-checkpoint",
          "run-checkpoint",
          {
            phase: "checkpoint",
            taskId: TASK_ID,
            checkpointKey: CHECKPOINT_KEY,
            checkpoint: CHECKPOINT,
          },
        )));
      } catch (error) {
        throw new Error(
          `checkpoint phase failed after model rounds ${modelRounds.get("job-checkpoint") ?? 0} and tools ${toolActions.join(",")}`,
          { cause: error },
        );
      }
      let unrelatedResult: Record<string, unknown>;
      try {
        unrelatedResult = resultValue(await host.execute(execution(
          "job-unrelated",
          "run-unrelated",
          { phase: "unrelated", taskId: "arithmetic-cobalt", question: "What is 29 - 12?" },
        )));
      } catch (error) {
        throw new Error(
          `unrelated phase failed after model rounds ${modelRounds.get("job-unrelated") ?? 0}`,
          { cause: error },
        );
      }
      let resumeResult: Record<string, unknown>;
      try {
        resumeResult = resultValue(await host.execute(execution(
          "job-resume",
          "run-resume",
          {
            phase: "resume",
            taskId: TASK_ID,
            request: "Resume this task from memory and identify the next action.",
          },
        )));
      } catch (error) {
        throw new Error(
          `resume phase failed after model rounds ${modelRounds.get("job-resume") ?? 0} and tools ${toolActions.join(",")}`,
          { cause: error },
        );
      }

      expect(checkpointResult).toMatchObject({
        phase: "checkpoint",
        actions: ["storage_set", "checkpointed"],
        final: { stored: true, checkpointKey: CHECKPOINT_KEY },
      });
      expect(unrelatedResult).toMatchObject({
        phase: "unrelated",
        actions: ["answer"],
        final: { answer: 17 },
      });
      expect(resumeResult).toEqual({
        phase: "resume",
        actions: ["storage_list", "storage_get", "resumed"],
        final: {
          action: "resumed",
          taskId: TASK_ID,
          resumed: true,
          nextAction: CHECKPOINT.nextAction,
          evidenceKeys: [CHECKPOINT_KEY],
        },
        reasoningObserved: [true],
        registryDigest: `sha256:${"7".repeat(64)}`,
      });
      expect(storedCheckpoint).toEqual(CHECKPOINT);
      expect(toolActions).toEqual(["storage_set", "storage_list", "storage_get"]);

      const unrelatedMessages = modelMessages.get("job-unrelated")?.join("\n") ?? "";
      const firstResumeMessages = modelMessages.get("job-resume")?.[0] ?? "";
      for (const text of [unrelatedMessages, firstResumeMessages]) {
        expect(text).not.toContain(CHECKPOINT_KEY);
        expect(text).not.toContain(CHECKPOINT.objective);
        expect(text).not.toContain("unit-tests");
        expect(text).not.toContain("retentionHours");
        expect(text).not.toContain("request-approval");
      }
      expect(host.snapshot.moduleGenerationId).toBe("module-generation-task-switch");
      await host.stop();
      expect(host.snapshot.state).toBe("stopped");
    } finally {
      if (host.snapshot.state !== "stopped") await host.terminate().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
