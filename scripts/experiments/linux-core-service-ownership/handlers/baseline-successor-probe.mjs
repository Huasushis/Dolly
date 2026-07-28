#!/usr/bin/env node
// The successor Core for the `baseline-direct-child` arm.
//
// This process starts after the creating Core stand-in was terminated with
// SIGKILL. It has exactly what a real successor would have: the durable Core
// state file and the operating system. It never sees the harness's own
// observations, so what it reports is what this arm could actually recover.
//
// Every judgement below comes from shipped code:
//
//   * `inspectCoreValidatedServiceBinding` decides whether this process is the
//     main process of a validated stable Core service;
//   * `FileCoreStateStore` provides the durable records; and
//   * `decideModuleProcessStopProof` decides whether an old Module process may
//     be marked stopped.
//
// Usage:
//   node --import <tsx loader> baseline-successor-probe.mjs \
//     --work-dir DIR --repository DIR --unit-name NAME --process-generation ID
//
// It prints one JSON object on standard output and writes nothing outside the
// work directory.

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    options[argv[index].replace(/^--/, "")] = argv[index + 1];
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const WORK_DIR = options["work-dir"];
const REPOSITORY = options.repository;
const UNIT_NAME = options["unit-name"];
const STATE_PATH = join(WORK_DIR, "core-state.json");

const moduleUrl = (relative) => pathToFileURL(join(REPOSITORY, relative)).href;

const { inspectCoreServiceBinding } = await import(
  moduleUrl("src/core/linux-core-service-binding.ts")
);
const { FileCoreStateStore } = await import(moduleUrl("src/core/file-core-state-store.ts"));
const { decideModuleProcessStopProof, deriveModuleCgroupPath, parseCgroupEventsPopulated } =
  await import(moduleUrl("src/core/linux-module-cgroup.ts"));

function describeError(error) {
  return {
    code: error?.code ?? error?.name ?? "unknown",
    message: error instanceof Error ? error.message : String(error),
  };
}

function readBootId() {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return undefined;
  }
}

const report = {
  arm: "baseline-direct-child",
  serviceBindingVerified: false,
  bindingFailures: [],
  durableState: {
    stateFilePresent: existsSync(STATE_PATH),
    readable: false,
    moduleProcessRecords: 0,
    moduleSubmissionRecords: 0,
    activeClaims: [],
    committedBlocks: null,
  },
  // What the successor can conclude about the previous generation.
  knowsAProcessGenerationExisted: false,
  hasRecoveredProcessIdentifier: false,
  canProveOldGenerationStopped: false,
  canDecideWhetherExecuteWasSent: false,
  stopProof: null,
  hypotheticalStopProof: null,
};

const binding = await inspectCoreServiceBinding({
  unitName: UNIT_NAME,
  mode: "user",
  queryTimeoutMs: 5_000,
  overallTimeoutMs: 15_000,
});
report.serviceBindingVerified = binding.verified === true;
report.bindingFailures = binding.verified ? [] : binding.failures.map((failure) => failure.code);

if (report.durableState.stateFilePresent) {
  try {
    let blockCounter = 0;
    let deliveryCounter = 0;
    const store = new FileCoreStateStore({
      path: STATE_PATH,
      maxFailedAttempts: 3,
      nextBlockId: () => `successor-block-${(blockCounter += 1)}`,
      nextDeliveryId: (kind) => `successor-${kind}-${(deliveryCounter += 1)}`,
      now: () => new Date().toISOString(),
    });
    const processRecords = store.listModuleProcessRecords();
    const submissionRecords = store.listModuleSubmissionRecords();
    const activeClaims = store.deliveries.listActiveClaims();
    report.durableState.readable = true;
    report.durableState.moduleProcessRecords = processRecords.length;
    report.durableState.moduleSubmissionRecords = submissionRecords.length;
    report.durableState.activeClaims = activeClaims.map((claim) => ({
      runId: claim.runId,
      moduleJobId: claim.moduleJobId,
      attempt: claim.attempt,
    }));
    report.knowsAProcessGenerationExisted = processRecords.length > 0;
    report.hasRecoveredProcessIdentifier = processRecords.some(
      (record) => record.diagnosticPid !== undefined,
    );

    // With no active Claim the Run is already terminal, so nothing is pending
    // and there is nothing to decide. With an active Claim the question is
    // real, and only a submission record answers it: in this arm no submission
    // record can exist, so the absence of one proves nothing about whether
    // `module.execute` crossed the protocol boundary.
    report.canDecideWhetherExecuteWasSent =
      activeClaims.length === 0 ? true : submissionRecords.length > 0;

    for (const record of processRecords) {
      const observation = buildObservation(record.moduleCgroupPath);
      report.stopProof = decideModuleProcessStopProof(record, observation);
      report.canProveOldGenerationStopped = report.stopProof.proven === true;
    }
  } catch (error) {
    report.durableState.refusal = describeError(error);
  }
}

// Even if a well-formed Module process record had somehow been written, the
// shipped prover refuses to trust any observation of an old Module control
// group while the current service binding is unverified. This probe shows that
// second, independent blocker; the record is built in memory and never stored.
try {
  const processGenerationId = options["process-generation"] ?? "bpg0";
  const derived = deriveModuleCgroupPath("/baseline-not-a-delegated-root", {
    instanceId: "baseline-instance-1",
    moduleId: "baseline-worker",
    processGenerationId,
  });
  const now = new Date().toISOString();
  report.hypotheticalStopProof = decideModuleProcessStopProof(
    {
      schemaVersion: "dolly.module-process-record/1",
      instanceId: "baseline-instance-1",
      moduleId: "baseline-worker",
      moduleGenerationId: "baseline-module-generation-1",
      processGenerationId,
      packageDigest: `sha256:${"a".repeat(64)}`,
      configurationReference: {
        configId: "baseline-config",
        revision: `sha256:${"b".repeat(64)}`,
        configVersion: 1,
      },
      declaredExternalEffects: "core-capabilities-only",
      serviceInvocationId: "0".repeat(32),
      bootId: readBootId() ?? "00000000-0000-4000-8000-000000000000",
      moduleCgroupPath: derived.filesystemPath,
      state: "running",
      createdAt: now,
      updatedAt: now,
    },
    buildObservation(derived.filesystemPath),
  );
} catch (error) {
  report.hypotheticalStopProof = { proven: false, reason: describeError(error).message };
}

function buildObservation(moduleCgroupPath) {
  let events = { kind: "missing" };
  try {
    const content = readFileSync(join(moduleCgroupPath, "cgroup.events"), "utf8");
    const populated = parseCgroupEventsPopulated(content);
    events =
      populated === undefined
        ? { kind: "unparsable", detail: "cgroup.events had no populated line" }
        : { kind: "populated", populated };
  } catch (error) {
    events = error?.code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable", detail: String(error?.code) };
  }
  return {
    currentBootId: readBootId(),
    serviceBindingVerified: report.serviceBindingVerified,
    events,
    pathRecreated: existsSync(moduleCgroupPath),
    cgroupMountPoint: "/sys/fs/cgroup",
  };
}

writeFileSync(join(WORK_DIR, "successor.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report)}\n`);
