/**
 * Proves the complete product-before-bootstrap Linux Extension process chain:
 * durable starting record -> reviewed launcher -> verified Module cgroup ->
 * attached protocol handshake -> one execute -> whole-group stop -> removed
 * cgroup -> durable stopped record.
 *
 * Run only through `scripts/run-linux-module-launcher-integration.sh`, normally
 * inside the repository's uniquely named disposable systemd container.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createExtensionEffectJournalLifecycle } from "../../../src/adapters/extension-effect-run-lifecycle.js";
import { createLinuxExtensionModuleExecutor } from "../../../src/adapters/linux-extension-module-executor.js";
import { defaultLauncherScriptPath } from "../../../src/adapters/linux-module-launcher/linux-module-launcher-process.js";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import { EffectIntentJournal } from "../../../src/core/capabilities/effect-intent-journal.js";
import { FileEffectIntentStore } from "../../../src/core/capabilities/file-effect-intent-store.js";
import {
  ExtensionIsolationPolicy,
  type ExtensionProcessHost,
} from "../../../src/core/extension-process-host.js";
import type { ExtensionPackageManifest } from "../../../src/core/extension-installation-registry.js";
import { createFileCoreStateStoreWithStoppedRecordWriter } from "../../../src/core/file-core-state-store.js";
import {
  deriveModuleCgroupPath,
  prepareDelegatedCgroupRoot,
  type ModuleCgroupLimits,
} from "../../../src/core/linux-module-cgroup.js";
import type { ModuleExecutor } from "../../../src/core/module-actor.js";
import type { ModuleProcessRecord } from "../../../src/core/module-process-records.js";
import type { ReactiveModuleInput } from "../../../src/core/reactive-module-input.js";
import type { ReactiveModuleResult } from "../../../src/core/reactive-module-runtime.js";

const PYTHON = "/usr/bin/python3";
const MODULE_GENERATION_ID = "generation-linux-extension";
const LIMITS: ModuleCgroupLimits = {
  memoryMaxBytes: 268_435_456,
  maxProcesses: 64,
  cpuQuotaMicros: 50_000,
  cpuPeriodMicros: 100_000,
};
const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/extension-process-fixture.mjs", import.meta.url),
);
const MANIFEST: ExtensionPackageManifest = {
  schemaVersion: "dolly.extension-package/1",
  extensionId: "com.example.linux-executor-fixture",
  packageVersion: "1.0.0",
  displayName: "Linux executor fixture",
  description: "Exercises the identity-bound Linux Extension executor.",
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

interface ProcessIdentity {
  readonly processId: number;
  readonly startTimeTicks: string;
  readonly state: string;
}

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

function readProcessIdentity(processId: number): ProcessIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${processId}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const state = fields[0];
    const startTimeTicks = fields[19];
    if (state === undefined || startTimeTicks === undefined) return undefined;
    return { processId, startTimeTicks, state };
  } catch {
    return undefined;
  }
}

function sameLiveProcess(identity: ProcessIdentity): boolean {
  const current = readProcessIdentity(identity.processId);
  return current !== undefined &&
    current.startTimeTicks === identity.startTimeTicks &&
    current.state !== "Z";
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function requireLifecycleOperations(
  executor: ModuleExecutor<ReactiveModuleInput, ReactiveModuleResult>,
): asserts executor is ModuleExecutor<ReactiveModuleInput, ReactiveModuleResult> &
  Required<Pick<ModuleExecutor<ReactiveModuleInput, ReactiveModuleResult>, "start" | "terminate">> {
  if (executor.start === undefined || executor.terminate === undefined) {
    throw new Error("The Linux Extension executor must implement start and terminate");
  }
}

const delegatedRoot = delegatedRootCgroupPath();
const available = delegatedRoot !== undefined && existsSync(PYTHON);
if (process.env.DOLLY_LINUX_MODULE_INTEGRATION_REQUIRED === "1" && !available) {
  throw new Error(
    "The Linux Module integration runner did not provide its delegated systemd service and Python launcher interpreter",
  );
}

describe.skipIf(!available)("Linux Extension Module executor in a real control group", () => {
  it("runs one request and closes the exact authorized process generation", async ({
    onTestFinished,
  }) => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-linux-extension-executor-"));
    const statePath = join(scratch, "core-state.json");
    const effectPath = join(scratch, "effect-intents.json");
    const processGenerationId = `process-linux-extension-${process.pid}-${Date.now()}`;
    const identity = {
      instanceId: "instance-linux-extension",
      moduleId: "module-linux-extension",
      processGenerationId,
    } as const;
    const moduleCgroupPath = deriveModuleCgroupPath(delegatedRoot!, identity).filesystemPath;
    const serviceInvocationId = process.env.INVOCATION_ID;
    if (serviceInvocationId === undefined) {
      throw new Error("systemd did not provide INVOCATION_ID");
    }
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const now = (): string => new Date().toISOString();
    const { store, stoppedRecordWriter } =
      createFileCoreStateStoreWithStoppedRecordWriter({
        path: statePath,
        maxFailedAttempts: 3,
        nextBlockId: () => "unused-linux-extension-block",
        nextDeliveryId: (kind) => `unused-linux-extension-${kind}`,
        now,
      });
    store.deliveries.createPage("input");
    store.deliveries.registerConsumer("input", identity.moduleId, "from-now");
    const inputBlock = store.blocks.commit(
      {
        payload: {
          schema: "dolly.content/1",
          value: {
            items: [{ type: "text", text: "Return the isolated process identity." }],
          },
        },
      },
      { kind: "external", id: "integration-test" },
    );
    store.deliveries.append("input", inputBlock.id);
    const claim = store.deliveries.claim({
      consumerId: identity.moduleId,
      pageIds: ["input"],
      moduleGenerationId: MODULE_GENERATION_ID,
      maxCount: 1,
      maxBytes: 64 * 1_024,
    });
    if (claim === null) throw new Error("The Linux integration input was not claimed");
    const effectJournal = new EffectIntentJournal({
      store: new FileEffectIntentStore({ path: effectPath }),
      now,
    });
    const effectRunLifecycle = createExtensionEffectJournalLifecycle({
      journal: effectJournal,
      getModuleSubmissionRecord: (runId) => store.getModuleSubmissionRecord(runId),
    });
    const createdAt = now();
    const processRecord: ModuleProcessRecord = {
      schemaVersion: "dolly.module-process-record/1",
      ...identity,
      moduleGenerationId: MODULE_GENERATION_ID,
      packageDigest: `sha256:${"2".repeat(64)}`,
      configurationReference: {
        configId: "config-linux-extension",
        revision: `sha256:${"3".repeat(64)}`,
        configVersion: 1,
      },
      declaredExternalEffects: "none",
      serviceInvocationId,
      bootId,
      moduleCgroupPath,
      state: "starting",
      createdAt,
      updatedAt: createdAt,
    };

    const root = await prepareDelegatedCgroupRoot({
      delegatedRootCgroupPath: delegatedRoot!,
    });
    if (!root.prepared) {
      throw new Error(`${root.failure.code}: ${root.failure.detail}`);
    }

    let host: ExtensionProcessHost | undefined;
    let launchedProcess: ProcessIdentity | undefined;
    let protocolIdentifier = 0;
    const standardErrorChunks: Uint8Array[] = [];
    const executor = createLinuxExtensionModuleExecutor({
      moduleId: identity.moduleId,
      moduleGenerationId: MODULE_GENERATION_ID,
      lifecycle: {
        records: store,
        stoppedRecordWriter,
        processRecord,
        delegatedRootCgroupPath: delegatedRoot!,
        identity,
        limits: LIMITS,
        maxOpenFiles: 64,
        execution: {
          program: process.execPath,
          argumentVector: [process.execPath, FIXTURE_PATH, "process-id"],
          environment: {},
        },
      },
      launcher: {
        interpreterProgram: PYTHON,
        launcherScriptPath: defaultLauncherScriptPath(),
        launcherEnvironment: {},
        controllerTimeouts: {
          configureTimeoutMs: 5_000,
          inCgroupTimeoutMs: 5_000,
          membershipTimeoutMs: 5_000,
          exitObservationTimeoutMs: 5_000,
        },
      },
      host: {
        trust: "trusted",
        isolationPolicy: new ExtensionIsolationPolicy(),
        manifest: MANIFEST,
        moduleKind: "fixture",
        config: {},
        maxFrameBytes: 64 * 1_024,
        initializationTimeoutMs: 10_000,
        shutdownRequestTimeoutMs: 2_000,
        forceKillDelayMs: 500,
        terminationTimeoutMs: 10_000,
        effectRunLifecycle,
      },
      executionTimeoutMs: 5_000,
      cancellationGraceMs: 1_000,
      terminationTimeoutMs: 10_000,
      channelCloseTimeoutMs: 5_000,
      nextProtocolIdentifier: (purpose) =>
        `${purpose}-linux-extension-${++protocolIdentifier}`,
      configureHost: (configuredHost, authorized) => {
        host = configuredHost;
        launchedProcess = readProcessIdentity(authorized.launcher.processId);
      },
      onStandardErrorChunk: (chunk) => {
        // Retain only a finite diagnostic prefix in the test; the adapter
        // continues draining all later chunks without buffering them itself.
        if (standardErrorChunks.length < 8) standardErrorChunks.push(chunk);
      },
    });
    requireLifecycleOperations(executor);
    const terminationContext = {
      moduleId: identity.moduleId,
      moduleGenerationId: MODULE_GENERATION_ID,
    } as const;
    onTestFinished(async () => {
      try {
        await executor.terminate(terminationContext);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }, 30_000);

    await expect(executor.start()).resolves.toBeUndefined();
    expect(host?.snapshot).toMatchObject({
      state: "ready",
      instanceId: identity.instanceId,
      moduleId: identity.moduleId,
      moduleGenerationId: MODULE_GENERATION_ID,
      processGenerationId,
      pid: launchedProcess?.processId,
    });
    expect(launchedProcess).toBeDefined();
    expect(store.getModuleProcessRecord(processGenerationId)?.state).toBe("running");

    const input = store.deliveries.inspectClaimInput(claim);
    store.appendModuleSubmissionRecord({
      schemaVersion: "dolly.module-submission-record/1",
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
      processGenerationId,
      inputDigest: canonicalJsonDigest(input),
      createdAt: now(),
    });

    const result = await executor.execute(
      input,
      {
        moduleId: identity.moduleId,
        moduleGenerationId: MODULE_GENERATION_ID,
        moduleJobId: claim.moduleJobId,
        runId: claim.runId,
        attempt: claim.attempt,
        startedAt: Date.now(),
        signal: new AbortController().signal,
      },
    );
    expect(result).toEqual({ processId: launchedProcess?.processId });
    expect(effectJournal.evidenceForRun(claim)).toEqual({ kind: "no-effect" });
    expect(
      new EffectIntentJournal({
        store: new FileEffectIntentStore({ path: effectPath }),
        now,
      }).evidenceForRun(claim),
    ).toEqual({ kind: "no-effect" });

    await expect(executor.terminate(terminationContext)).resolves.toBeUndefined();
    expect(store.getModuleProcessRecord(processGenerationId)).toMatchObject({
      state: "stopped",
      processGenerationId,
      moduleCgroupPath,
    });
    expect(existsSync(moduleCgroupPath)).toBe(false);
    expect(
      await waitFor(
        () => launchedProcess === undefined || !sameLiveProcess(launchedProcess),
        5_000,
      ),
    ).toBe(true);
    expect(Buffer.concat(standardErrorChunks.map((chunk) => Buffer.from(chunk))).byteLength)
      .toBeLessThanOrEqual(64 * 1_024);

    console.info(JSON.stringify({
      processGenerationId,
      launcherProcessId: launchedProcess?.processId,
      moduleCgroupPath,
      result,
      finalRecordState: store.getModuleProcessRecord(processGenerationId)?.state,
      effectEvidence: effectJournal.evidenceForRun(claim).kind,
      cgroupRemoved: !existsSync(moduleCgroupPath),
      exactProcessIdentityGone:
        launchedProcess === undefined || !sameLiveProcess(launchedProcess),
    }));
  }, 90_000);
});
