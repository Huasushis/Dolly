import { createLinuxModuleExecutor } from "../../../../src/adapters/linux-module-executor.js";
import { deriveModuleCgroupPath } from "../../../../src/core/linux-module-cgroup.js";
import type { ModuleProcessRecord } from "../../../../src/core/module-process-records.js";

const delegatedRootCgroupPath = "/system.slice/dolly-core.service";
const identity = {
  instanceId: "instance-1",
  moduleId: "worker",
  processGenerationId: "process-generation-1",
};
const moduleGenerationId = "module-generation-1";
const hangingCleanup = process.argv[2] === "hanging-cleanup";
const processRecord: ModuleProcessRecord = {
  schemaVersion: "dolly.module-process-record/1",
  instanceId: identity.instanceId,
  moduleId: identity.moduleId,
  moduleGenerationId,
  processGenerationId: identity.processGenerationId,
  packageDigest: `sha256:${"a".repeat(64)}`,
  configurationReference: {
    configId: "config-1",
    revision: `sha256:${"b".repeat(64)}`,
    configVersion: 1,
  },
  declaredExternalEffects: "core-capabilities-only",
  serviceInvocationId: "2812432ad29e4d3bbd6776c62cafa929",
  bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
  moduleCgroupPath: deriveModuleCgroupPath(delegatedRootCgroupPath, identity).filesystemPath,
  state: "starting",
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
};

const directories = new Set<string>();
const files = new Map<string, string>();
let currentRecord = processRecord;

const executor = createLinuxModuleExecutor({
  moduleId: identity.moduleId,
  moduleGenerationId,
  lifecycle: {
    records: {
      getModuleProcessRecord(processGenerationId) {
        return currentRecord.processGenerationId === processGenerationId
          ? currentRecord
          : undefined;
      },
      appendModuleProcessRecord(record) {
        currentRecord = record;
        return record;
      },
      updateModuleProcessRecordState(_processGenerationId, state) {
        currentRecord = { ...currentRecord, state };
        return currentRecord;
      },
    },
    stoppedRecordWriter: {
      isBoundTo(record) {
        return currentRecord === record;
      },
      writeStopped(_processGenerationId, failureCode) {
        currentRecord = { ...currentRecord, state: "stopped", failureCode };
        return currentRecord;
      },
    },
    processRecord,
    delegatedRootCgroupPath,
    identity,
    limits: {
      memoryMaxBytes: 64 * 1024 * 1024,
      maxProcesses: 16,
      cpuQuotaMicros: 50_000,
      cpuPeriodMicros: 100_000,
    },
    maxOpenFiles: 256,
    startLauncher: async () => ({
      processId: 4242,
      configure: async () => {
        if (!hangingCleanup) {
          throw new Error("simulated launcher control failure");
        }
      },
      authorizeExecution: async () =>
        hangingCleanup
          ? {
              executionAuthorized: false,
              code: "LAUNCHER_MEMBERSHIP_UNVERIFIED",
              detail: "the control group contained an unexplained process",
              membershipVerified: false,
              observedProcessIds: [99],
              executeCommandMayHaveBeenDelivered: false,
              launcherExitObserved: false,
            }
          : {
              executionAuthorized: true,
              verifiedProcessIds: [4242],
            },
      requestExit: async () => false,
    }),
    execution: {
      program: "/opt/dolly/node",
      argumentVector: ["/opt/dolly/node", "/opt/dolly/extension/index.mjs"],
      environment: {},
    },
    cgroupFileSystem: {
      async createDirectory(path: string) {
        directories.add(path);
      },
      async removeDirectory(path: string) {
        directories.delete(path);
      },
      async directoryExists(path: string) {
        return directories.has(path);
      },
      async listChildDirectoryNames() {
        return [] as readonly string[];
      },
      async writableFileExists(path: string) {
        return directories.has(path.slice(0, path.lastIndexOf("/")));
      },
      async readTextFile(path: string) {
        if (path.endsWith("/cgroup.events")) return "populated 0\nfrozen 0\n";
        const value = files.get(path);
        if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return value;
      },
      async writeTextFile(path: string, contents: string) {
        if (hangingCleanup && path.endsWith("/cgroup.kill") && contents === "1") {
          await new Promise<void>(() => undefined);
        }
        files.set(path, contents);
      },
    },
  },
  openProtocolSession: () => {
    throw new Error("the protocol session must not open after launcher failure");
  },
  terminationTimeoutMs: 100,
  channelCloseTimeoutMs: 100,
});

process.stdout.write("STARTED\n");
if (executor.start === undefined) {
  throw new Error("the Linux Module executor must provide start");
}
void executor.start().then(
  () => process.exit(91),
  () => {
    process.stdout.write("EXIT_HOOK_RETURNED\n");
    process.exit(92);
  },
);
