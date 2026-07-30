import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createLinuxModuleExecutor } from "../../../../src/adapters/linux-module-executor.js";
import {
  startLinuxModuleLauncher,
} from "../../../../src/adapters/linux-module-launcher/linux-module-launcher-process.js";
import { createModuleLauncherControl } from "../../../../src/adapters/linux-module-launcher/module-launcher-control.js";
import { FileCoreStateStore } from "../../../../src/core/file-core-state-store.js";
import {
  deriveModuleCgroupPath,
  prepareDelegatedCgroupRoot,
  type ModuleCgroupIdentity,
  type ModuleCgroupLimits,
} from "../../../../src/core/linux-module-cgroup.js";
import type { ModuleProcessRecord } from "../../../../src/core/module-process-records.js";

const REPORT_PATH = process.argv[2];
const STATE_PATH = process.argv[3];
const FALLBACK_PATH = process.argv[4];
const PYTHON = "/usr/bin/python3";
const LAUNCHER_PATH = fileURLToPath(
  new URL("./false-in-cgroup-unresponsive-launcher.py", import.meta.url),
);
const PROCESS_GENERATION_ID = "process-systemd-exit";
const MODULE_GENERATION_ID = "generation-systemd-exit";
const LIMITS: ModuleCgroupLimits = {
  memoryMaxBytes: 268_435_456,
  maxProcesses: 64,
  cpuQuotaMicros: 50_000,
  cpuPeriodMicros: 100_000,
};

let fallbackStarted = false;

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function exitThroughFallback(status: number, reason: string, error?: unknown): never {
  if (fallbackStarted) process.exit(status);
  fallbackStarted = true;
  try {
    writeFileSync(
      FALLBACK_PATH!,
      `${JSON.stringify({ status, reason, ...(error === undefined ? {} : { error: describe(error) }) })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } finally {
    process.exit(status);
  }
}

process.on("uncaughtException", (error) => {
  exitThroughFallback(95, "uncaught exception", error);
});
process.on("unhandledRejection", (error) => {
  exitThroughFallback(96, "unhandled rejection", error);
});

function unifiedCgroupPath(processId: number | "self"): string {
  const line = readFileSync(`/proc/${processId}/cgroup`, "utf8")
    .split("\n")
    .find((candidate) => candidate.startsWith("0::"));
  if (line === undefined || line.length <= "0::".length) {
    throw new Error(`process ${processId} has no cgroup version 2 path`);
  }
  return line.slice("0::".length);
}

function processStartTimeTicks(processId: number): string {
  const stat = readFileSync(`/proc/${processId}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const startTimeTicks = fields[19];
  if (startTimeTicks === undefined || !/^\d+$/u.test(startTimeTicks)) {
    throw new Error(`process ${processId} has no valid start time in /proc`);
  }
  return startTimeTicks;
}

function requiredArgument(value: string | undefined, label: string): string {
  if (value === undefined || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return value;
}

async function main(): Promise<void> {
  const reportPath = requiredArgument(REPORT_PATH, "report path");
  const statePath = requiredArgument(STATE_PATH, "state path");
  requiredArgument(FALLBACK_PATH, "fallback path");

  const coreCgroupPath = unifiedCgroupPath("self");
  if (!coreCgroupPath.endsWith("/core")) {
    throw new Error(`Core process cgroup ${coreCgroupPath} does not end in /core`);
  }
  const delegatedRootCgroupPath = coreCgroupPath.slice(0, -"/core".length);
  if (delegatedRootCgroupPath.length === 0) {
    throw new Error("the delegated service control-group path is empty");
  }
  const root = await prepareDelegatedCgroupRoot({ delegatedRootCgroupPath });
  if (!root.prepared) {
    throw new Error(`${root.failure.code}: ${root.failure.detail}`);
  }

  const serviceInvocationId = process.env.INVOCATION_ID;
  if (serviceInvocationId === undefined) {
    throw new Error("systemd did not supply INVOCATION_ID to the service main process");
  }
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const identity: ModuleCgroupIdentity = {
    instanceId: "instance-systemd-exit",
    moduleId: "module-systemd-exit",
    processGenerationId: PROCESS_GENERATION_ID,
  };
  const moduleCgroup = deriveModuleCgroupPath(delegatedRootCgroupPath, identity);
  const now = (): string => new Date().toISOString();
  const state = new FileCoreStateStore({
    path: statePath,
    maxFailedAttempts: 3,
    nextBlockId: () => "unused-block",
    nextDeliveryId: (kind) => `unused-${kind}`,
    now,
  });
  const createdAt = now();
  const processRecord: ModuleProcessRecord = {
    schemaVersion: "dolly.module-process-record/1",
    ...identity,
    moduleGenerationId: MODULE_GENERATION_ID,
    packageDigest: `sha256:${"0".repeat(64)}`,
    configurationReference: {
      configId: "config-systemd-exit",
      revision: `sha256:${"1".repeat(64)}`,
      configVersion: 1,
    },
    declaredExternalEffects: "none",
    serviceInvocationId,
    bootId,
    moduleCgroupPath: moduleCgroup.filesystemPath,
    state: "starting",
    createdAt,
    updatedAt: createdAt,
  };

  const watchdog = setTimeout(() => {
    exitThroughFallback(93, "executor did not end Core before the fixture deadline");
  }, 12_000);

  const executor = createLinuxModuleExecutor({
    moduleId: identity.moduleId,
    moduleGenerationId: MODULE_GENERATION_ID,
    lifecycle: {
      records: state,
      processRecord,
      delegatedRootCgroupPath,
      identity,
      limits: LIMITS,
      maxOpenFiles: 64,
      startLauncher: async () => {
        const launcher = startLinuxModuleLauncher({
          interpreterProgram: PYTHON,
          launcherScriptPath: LAUNCHER_PATH,
          protocolStdio: ["ignore", "ignore", "pipe"],
          launcherEnvironment: {},
          controllerTimeouts: {
            configureTimeoutMs: 2_000,
            inCgroupTimeoutMs: 2_000,
            membershipTimeoutMs: 2_000,
            exitObservationTimeoutMs: 2_000,
          },
        });
        launcher.child.stderr?.on("data", () => undefined);
        writeFileSync(
          reportPath,
          `${JSON.stringify({
            processGenerationId: PROCESS_GENERATION_ID,
            serviceInvocationId,
            core: {
              processId: process.pid,
              startTimeTicks: processStartTimeTicks(process.pid),
              cgroupPath: coreCgroupPath,
            },
            launcher: {
              processId: launcher.processId,
              startTimeTicks: processStartTimeTicks(launcher.processId),
              cgroupPath: unifiedCgroupPath(launcher.processId),
            },
            serviceCgroupFilesystemPath: `/sys/fs/cgroup${delegatedRootCgroupPath}`,
            moduleCgroupFilesystemPath: moduleCgroup.filesystemPath,
          })}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        return createModuleLauncherControl({ launcher });
      },
      execution: {
        program: "/bin/true",
        argumentVector: ["/bin/true"],
        environment: {},
      },
    },
    openProtocolSession: () =>
      exitThroughFallback(94, "protocol session opened after false cgroup membership"),
    terminationTimeoutMs: 5_000,
    channelCloseTimeoutMs: 2_000,
  });

  void executor.start!().then(
    () => exitThroughFallback(91, "executor start unexpectedly resolved"),
    (error) => exitThroughFallback(92, "executor start rejected instead of ending Core", error),
  );

  // The timer is intentionally referenced. It distinguishes a missing Core
  // exit from an empty event loop that happens to end with status zero.
  void watchdog;
}

void main().catch((error) => {
  exitThroughFallback(90, "fixture setup failed", error);
});
