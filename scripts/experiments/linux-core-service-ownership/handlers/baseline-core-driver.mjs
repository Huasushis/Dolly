#!/usr/bin/env node
// The Core stand-in for the `baseline-direct-child` arm.
//
// This is the *current* Dolly launch path: an ordinary process that owns a
// Module through the real `ExtensionProcessHost` direct child, running outside
// a validated stable systemd service. The experiment protocol's "Baselines"
// section names exactly this arm and expects it to prove cleanup only while its
// creating Core process remains alive.
//
// Nothing here simulates production code. The service binding check, the
// Module process record validator, the Module cgroup path derivation, the
// Core-state store, and the Extension process host are all imported from
// `src/core`. Where this arm cannot perform one of the protocol's fourteen
// durable boundaries, the driver *attempts the real operation* and records the
// real refusal rather than skipping the step or inventing a substitute. That is
// the difference between a baseline that is honestly limited and one that has
// been weakened, which the protocol forbids.
//
// Usage:
//   node --import <tsx loader> baseline-core-driver.mjs \
//     --boundary M04 --timing before --workload single-output \
//     --work-dir DIR --repository DIR --sentinel TOKEN --unit-name NAME
//
// The driver runs the ordered step list until it reaches the requested
// interruption point, writes `barrier.json` and a `barrier-ready` marker, and
// then blocks forever so the harness can terminate it at exactly that point.

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    options[argv[index].replace(/^--/, "")] = argv[index + 1];
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const TARGET_BOUNDARY = options.boundary;
const TARGET_TIMING = options.timing;
const WORKLOAD = options.workload;
const WORK_DIR = options["work-dir"];
const REPOSITORY = options.repository;
const SENTINEL = options.sentinel;
const UNIT_NAME = options["unit-name"];

const EVENTS_FILE = join(WORK_DIR, "driver-events");
const BARRIER_FILE = join(WORK_DIR, "barrier.json");
const READY_FILE = join(WORK_DIR, "barrier-ready");
const STATE_PATH = join(WORK_DIR, "core-state.json");

// ---------------------------------------------------------------------------
// Shared fixture contract. Every value here is also used by the transient-unit
// baseline and is documented in `baseline-fixture-contract.md`, so the arms can
// be compared without one having been given a longer deadline than the other.
// ---------------------------------------------------------------------------
// Every value is the proposed arm's, so neither arm was given a longer deadline
// or a different payload than the other. The three `ExtensionProcessHost`
// option names on the left carry the proposed arm's Core-side waits: readiness
// 30 s, result 120 s, stop 20 s.
const CONTRACT = {
  initializationTimeoutMs: 30_000,
  shutdownRequestTimeoutMs: 20_000,
  forceKillDelayMs: 2_000,
  terminationTimeoutMs: 20_000,
  maxFrameBytes: 4 * 1_024 * 1_024,
  executeDeadlineOffsetMs: 60_000,
  executeResponseTimeoutMs: 120_000,
  // The shared fixture's own constant, recorded here so the contract document
  // has one place to check it against.
  processorLoopSeconds: 2.0,
  slowCapabilityHandlerMs: 3_000,
  capabilityGrantLifetimeMs: 600_000,
};

const INSTANCE_ID = "dolly-test-instance";
const MODULE_ID = "experimentworker";
const MODULE_GENERATION_ID = "dolly-test-module-generation-1";
const PROCESS_GENERATION_ID = `bpg${randomBytes(16).toString("hex")}`;
const INPUT_PAGE = "experiment-input";
const CONSUMER_ID = "experimentworker";
const BLOCK_SCHEMA = "dolly.experiment.text/1";
// The protocol's workload list fixes how many output pages each Run writes.
const OUTPUT_COUNT = { "no-output": 0, "multiple-output-pages": 3 };
const outputCountFor = (workload) => OUTPUT_COUNT[workload] ?? 1;
const outputPageIds = (workload) =>
  Array.from({ length: outputCountFor(workload) }, (_unused, index) => `experiment-output-${index + 1}`);

const stepLog = [];
let extensionPid = 0;
let capabilityState = "not-started";

function event(text) {
  const line = `${new Date().toISOString()} ${text}\n`;
  appendFileSync(EVENTS_FILE, line, "utf8");
}

function step(name, performed, detail) {
  stepLog.push({ step: name, armPerformed: performed, detail });
  event(`step ${name} armPerformed=${performed} ${JSON.stringify(detail)}`);
}

// The shared fixture records the descendant's identifier on the first line and
// its start time on the second. Only the identifier is needed here; the harness
// checks both before it acts on the process.
function readDescendantPid() {
  const path = join(WORK_DIR, "descendant-pid");
  if (!existsSync(path)) return 0;
  const value = Number.parseInt(readFileSync(path, "utf8").split("\n")[0]?.trim() ?? "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function selfCgroupPath() {
  try {
    return parseProcessCgroupPath(readFileSync("/proc/self/cgroup", "utf8"));
  } catch {
    return undefined;
  }
}

// The interruption point. Everything the harness needs in order to observe what
// this arm left behind is written synchronously before the driver blocks,
// because the next thing that happens to this process is SIGKILL.
async function barrier(boundary, timing, extra = {}) {
  if (boundary !== TARGET_BOUNDARY || timing !== TARGET_TIMING) return;
  const snapshot = {
    boundary,
    timing,
    workload: WORKLOAD,
    arm: "baseline-direct-child",
    corePid: process.pid,
    coreCgroupPath: selfCgroupPath() ?? null,
    extensionPid,
    descendantPid: readDescendantPid(),
    capabilityState,
    processGenerationId: PROCESS_GENERATION_ID,
    statePath: STATE_PATH,
    sentinel: SENTINEL,
    steps: stepLog,
    ...extra,
  };
  writeFileSync(BARRIER_FILE, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  event(`barrier reached ${boundary} ${timing}`);
  writeFileSync(READY_FILE, `${process.pid}\n`, "utf8");
  // Hold the process at this exact point. The harness terminates it here.
  setInterval(() => undefined, 1_000);
  await new Promise(() => undefined);
}

// Some interruption points do not exist for some workloads: a Run with no
// output commits no Block and appends no output Delivery. That is a property of
// the Run, not of an arm, so it holds for the proposed design too and both arms
// report the case `not-applicable`. The driver records the fact and keeps
// running, so the artifacts still show the Run really produced no output.
let absentBoundary = null;
function structurallyAbsent(boundary, reason) {
  if (boundary !== TARGET_BOUNDARY) return;
  absentBoundary = { boundary, timing: TARGET_TIMING, reason };
  event(`boundary ${boundary} ${TARGET_TIMING} is structurally absent: ${reason}`);
  writeFileSync(
    BARRIER_FILE,
    `${JSON.stringify(
      {
        boundary,
        timing: TARGET_TIMING,
        workload: WORKLOAD,
        arm: "baseline-direct-child",
        structurallyAbsent: true,
        reason,
        corePid: process.pid,
        extensionPid,
        descendantPid: readDescendantPid(),
        processGenerationId: PROCESS_GENERATION_ID,
        steps: stepLog,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function describeError(error) {
  return {
    code: error?.code ?? error?.name ?? "unknown",
    message: error instanceof Error ? error.message : String(error),
  };
}

// ---------------------------------------------------------------------------
// Real product modules
// ---------------------------------------------------------------------------
const moduleUrl = (relative) => pathToFileURL(join(REPOSITORY, relative)).href;

const { inspectCoreServiceBinding, parseProcessCgroupPath } = await import(
  moduleUrl("src/core/linux-core-service-binding.ts")
);
const { deriveModuleCgroupPath } = await import(moduleUrl("src/core/linux-module-cgroup.ts"));
const { buildReactiveModuleInput } = await import(moduleUrl("src/core/reactive-module-input.ts"));
const { FileCoreStateStore } = await import(moduleUrl("src/core/file-core-state-store.ts"));
const { ExtensionProcessHost, ExtensionIsolationPolicy } = await import(
  moduleUrl("src/core/extension-process-host.ts")
);

// The manifest the shipped host validates the fixture's `dolly.initialize`
// reply against. The values are the shared fixture's own constants, so a drift
// on either side is rejected by the host rather than quietly accepted.
const MANIFEST = {
  schemaVersion: "dolly.extension-package/1",
  extensionId: "dolly-test-experiment-extension",
  packageVersion: "1.0.0",
  supportedProtocolVersions: ["3.0"],
  modules: [{ moduleKind: "reactive" }],
};

async function main() {
  writeFileSync(EVENTS_FILE, "", "utf8");
  writeFileSync(join(WORK_DIR, "process-generation-id"), `${PROCESS_GENERATION_ID}\n`, "utf8");
  event(`driver start boundary=${TARGET_BOUNDARY} timing=${TARGET_TIMING} workload=${WORKLOAD}`);

  let blockCounter = 0;
  let deliveryCounter = 0;
  const store = new FileCoreStateStore({
    path: STATE_PATH,
    maxFailedAttempts: 3,
    nextBlockId: () => `baseline-block-${(blockCounter += 1)}`,
    nextDeliveryId: (kind) => `baseline-${kind}-${(deliveryCounter += 1)}`,
    now: () => new Date().toISOString(),
  });

  // -------------------------------------------------------------------------
  // M01 service configuration validation for Core and Core readiness
  // -------------------------------------------------------------------------
  await barrier("M01", "before");
  const binding = await inspectCoreServiceBinding({
    unitName: UNIT_NAME,
    mode: "user",
    queryTimeoutMs: 5_000,
    overallTimeoutMs: 15_000,
  });
  const bindingFailures = binding.verified ? [] : binding.failures.map((failure) => failure.code);
  // This arm runs outside a validated stable service by definition, so this
  // refusal is the arm's independent variable, recorded in every case rather
  // than discovered in one.
  step("M01", true, { serviceBindingVerified: binding.verified === true, bindingFailures });
  writeFileSync(
    join(WORK_DIR, "binding.json"),
    `${JSON.stringify(binding, null, 2)}\n`,
    "utf8",
  );
  await barrier("M01", "after", { bindingFailures });

  // -------------------------------------------------------------------------
  // M02 Module process record creation
  //
  // The real validator is called with the values this arm actually has. It has
  // no systemd InvocationID, because it is not a systemd service, so the record
  // cannot be written at all. A second probe supplies a syntactically valid
  // placeholder to surface the *next* blocker, which is that this arm has no
  // Core-derived Module control-group path either. Neither probe persists
  // anything.
  // -------------------------------------------------------------------------
  await barrier("M02", "before");
  const coreCgroup = selfCgroupPath();
  const now = new Date().toISOString();
  const recordWithoutInvocationId = {
    schemaVersion: "dolly.module-process-record/1",
    instanceId: INSTANCE_ID,
    moduleId: MODULE_ID,
    moduleGenerationId: MODULE_GENERATION_ID,
    processGenerationId: PROCESS_GENERATION_ID,
    packageDigest: `sha256:${"a".repeat(64)}`,
    configurationReference: {
      configId: "baseline-config",
      revision: `sha256:${"b".repeat(64)}`,
      configVersion: 1,
    },
    declaredExternalEffects: "core-capabilities-only",
    bootId: readBootId() ?? "00000000-0000-4000-8000-000000000000",
    moduleCgroupPath: coreCgroup ?? "/unknown",
    state: "starting",
    createdAt: now,
    updatedAt: now,
  };
  const processRecordAttempt = { persisted: false };
  try {
    store.appendModuleProcessRecord(recordWithoutInvocationId);
    processRecordAttempt.persisted = true;
  } catch (error) {
    processRecordAttempt.refusal = describeError(error);
  }
  try {
    store.appendModuleProcessRecord({
      ...recordWithoutInvocationId,
      serviceInvocationId: "0".repeat(32),
    });
    processRecordAttempt.probeWithPlaceholderInvocationIdPersisted = true;
  } catch (error) {
    processRecordAttempt.probeWithPlaceholderInvocationId = describeError(error);
  }
  step("M02", processRecordAttempt.persisted, processRecordAttempt);
  await barrier("M02", "after", { processRecordAttempt });

  // -------------------------------------------------------------------------
  // M03 delegated control group creation and limit application
  //
  // `ExtensionProcessHost` creates no control group and applies no limit; the
  // child simply joins Core's own group. The driver derives the path the
  // proposed design would have used, so the successor can be asked to prove
  // that group empty, and creates nothing.
  // -------------------------------------------------------------------------
  await barrier("M03", "before");
  let derivedModuleCgroupPath = null;
  let derivationRefusal;
  try {
    derivedModuleCgroupPath = deriveModuleCgroupPath(coreCgroup ?? "/", {
      instanceId: INSTANCE_ID,
      moduleId: MODULE_ID,
      processGenerationId: PROCESS_GENERATION_ID,
    }).filesystemPath;
  } catch (error) {
    derivationRefusal = describeError(error);
  }
  const cgroupState = {
    coreCgroupPath: coreCgroup ?? null,
    moduleCgroupCreated: false,
    delegatedRootAvailable: binding.verified === true,
    derivedModuleCgroupPath,
    ...(derivationRefusal ? { derivationRefusal } : {}),
    limitsApplied: [],
  };
  writeFileSync(join(WORK_DIR, "cgroup.json"), `${JSON.stringify(cgroupState, null, 2)}\n`, "utf8");
  step("M03", false, cgroupState);
  await barrier("M03", "after", { cgroupState });

  // -------------------------------------------------------------------------
  // M04 Extension process creation and readiness
  // -------------------------------------------------------------------------
  await barrier("M04", "before");
  const host = new ExtensionProcessHost({
    isolation: "process",
    trust: "trusted",
    isolationPolicy: new ExtensionIsolationPolicy([]),
    manifest: MANIFEST,
    // The proposed arm's own child fixture, executed rather than reimplemented.
    // The protocol asks the arms to share a child fixture; sharing the file
    // makes that structural instead of two implementations kept in step by
    // hand. The trailing sentinel is ignored by the fixture and exists so this
    // case's processes are findable under the run's reserved prefix.
    command: options.python3 ?? "/usr/bin/python3",
    args: [
      "-I",
      "-B",
      join(REPOSITORY, PROPOSED_FIXTURE_RELATIVE_PATH),
      SENTINEL,
    ],
    workingDirectory: WORK_DIR,
    instanceId: INSTANCE_ID,
    moduleId: MODULE_ID,
    moduleGenerationId: MODULE_GENERATION_ID,
    moduleKind: "reactive",
    config: {
      workload: WORKLOAD,
      outputCount: outputCountFor(WORKLOAD),
      environPath: join(WORK_DIR, "extension-environment.json"),
      // This arm has no control group to collect the descendant with, which is
      // the deficiency the case measures. The harness therefore has to be told
      // the identifier so it can clean up after itself. That is harness
      // cleanup, not baseline recovery: the successor Core is never given this
      // file, and the case records that it has no handle of its own.
      descendantPidPath: join(WORK_DIR, "descendant-pid"),
    },
    maxFrameBytes: CONTRACT.maxFrameBytes,
    initializationTimeoutMs: CONTRACT.initializationTimeoutMs,
    shutdownRequestTimeoutMs: CONTRACT.shutdownRequestTimeoutMs,
    forceKillDelayMs: CONTRACT.forceKillDelayMs,
    terminationTimeoutMs: CONTRACT.terminationTimeoutMs,
  });

  // Two grants, matching the proposed arm's capability set. The external-effect
  // grant requires an idempotency key, because that is the one whose outcome a
  // Run may not assume either way.
  const grantLimits = {
    resourceScope: { scope: "experiment" },
    expiresAt: new Date(Date.now() + CONTRACT.capabilityGrantLifetimeMs).toISOString(),
    maxInvocations: 16,
    maxConcurrentInvocations: 4,
    maxArgumentBytes: 65_536,
    maxResultBytes: 65_536,
  };
  host.grantCapability(
    {
      capabilityType: "structured-log",
      capabilityVersion: "1.0",
      operations: ["write", "write-slow"],
      ...grantLimits,
    },
    capabilityHandler,
  );
  host.grantCapability(
    {
      capabilityType: "external-effect",
      capabilityVersion: "1.0",
      operations: ["emit"],
      ...grantLimits,
      requireIdempotencyKey: true,
    },
    capabilityHandler,
  );

  const started = await host.start();
  extensionPid = started.pid ?? 0;
  step("M04", true, { extensionPid, state: started.state });
  writeFileSync(join(WORK_DIR, "extension-pid"), `${extensionPid}\n`, "utf8");
  await barrier("M04", "after", { extensionPid });

  // -------------------------------------------------------------------------
  // M05 Delivery Claim persistence
  // -------------------------------------------------------------------------
  await barrier("M05", "before");
  store.deliveries.createPage(INPUT_PAGE);
  store.deliveries.registerConsumer(INPUT_PAGE, CONSUMER_ID, "from-now");
  const inputBlock = store.blocks.commit(
    { payload: { schema: BLOCK_SCHEMA, value: { text: `input for ${WORKLOAD}` } } },
    { kind: "external", id: "experiment-console" },
  );
  store.deliveries.append(INPUT_PAGE, inputBlock.id);
  for (const pageId of outputPageIds(WORKLOAD)) store.deliveries.createPage(pageId);
  const claim = store.deliveries.claim({
    consumerId: CONSUMER_ID,
    pageIds: [INPUT_PAGE],
    moduleGenerationId: MODULE_GENERATION_ID,
    maxCount: 1,
    maxBytes: 1024 * 1024,
  });
  if (!claim) throw new Error("the Core-state store issued no Delivery Claim");
  step("M05", true, { runId: claim.runId, moduleJobId: claim.moduleJobId, attempt: claim.attempt });
  await barrier("M05", "after", { runId: claim.runId });

  // -------------------------------------------------------------------------
  // M06 Module submission record persistence
  //
  // A submission record must refer to a process record with the same Module
  // generation. This arm has no process record, so the real store refuses. The
  // consequence is the one ADR 0009 names: after a Core exit nothing durable
  // says whether `module.execute` crossed the protocol boundary.
  // -------------------------------------------------------------------------
  await barrier("M06", "before");
  const submissionAttempt = { persisted: false };
  try {
    store.appendModuleSubmissionRecord({
      schemaVersion: "dolly.module-submission-record/1",
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: MODULE_GENERATION_ID,
      processGenerationId: PROCESS_GENERATION_ID,
      inputDigest: `sha256:${"c".repeat(64)}`,
      createdAt: new Date().toISOString(),
    });
    submissionAttempt.persisted = true;
  } catch (error) {
    submissionAttempt.refusal = describeError(error);
  }
  step("M06", submissionAttempt.persisted, submissionAttempt);
  await barrier("M06", "after", { submissionAttempt });

  // -------------------------------------------------------------------------
  // M07 `module.execute` protocol send
  //
  // The send happens inside `host.execute`, which does not return until the
  // result arrives, and the shipped host exposes no seam between the two. The
  // first thing that can only happen after the send crossed the boundary is
  // the fixture's first capability request arriving back at Core, so that is
  // what "after the send" is observed by. It makes `M07-after` and
  // `M08.start-before` the same instant, the same way `M03-after` and
  // `M04-before` are; both cases still run, and the collapse is a property of
  // the boundary list rather than of this arm.
  //
  // PROVISIONAL: the proposed arm faces the identical problem now that it runs
  // the real host, and both arms must use one definition. This is replaced by
  // whichever definition that arm adopts.
  // -------------------------------------------------------------------------
  await barrier("M07", "before");
  const deadline = new Date(Date.now() + CONTRACT.executeDeadlineOffsetMs).toISOString();
  const executePromise = host.execute({
    moduleJobId: claim.moduleJobId,
    runId: claim.runId,
    attempt: claim.attempt,
    deadline,
    responseTimeoutMs: CONTRACT.executeResponseTimeoutMs,
    hasMore: claim.hasMore === true,
    // The real reactive Module input the shipped builder produces, not a
    // placeholder, so both arms send the same bytes across the boundary.
    input: buildReactiveModuleInput({
      claimedDeliveryIds: claim.deliveryIds,
      blockGroups: claim.blockGroups,
      hasMore: claim.hasMore,
    }),
  });
  let executeFailure;
  executePromise.catch((error) => {
    executeFailure = describeError(error);
  });
  await firstCapabilityRequestArrived;
  step("M07", true, {
    deadline,
    responseTimeoutMs: CONTRACT.executeResponseTimeoutMs,
    sendObservedBy: "the first capability request arriving back at Core",
  });
  await barrier("M07", "after", { runId: claim.runId });

  // M08 start and completion are tripped from inside the capability handler.
  const executeResult = await executePromise;
  if (executeFailure) {
    step("M07-failure", false, executeFailure);
  }

  // -------------------------------------------------------------------------
  // M09 Extension result receipt persistence
  //
  // This arm has no durable receipt step. The received result exists only in
  // this process's memory, so a Core exit here loses it outright.
  // -------------------------------------------------------------------------
  await barrier("M09", "before", { resultInMemoryOnly: true });
  step("M09", false, {
    durableReceipt: false,
    detail: "the direct-child arm keeps the received Extension result in memory only",
  });
  await barrier("M09", "after", { resultInMemoryOnly: true });

  // -------------------------------------------------------------------------
  // M10 Core result commit preparation
  // -------------------------------------------------------------------------
  await barrier("M10", "before");
  // The fixture returns a `dolly.module-result/1`, the shape the reactive
  // runtime already defines, so Core commits its Block proposal unchanged.
  const blockPayload = executeResult?.blockProposal?.payload;
  const outputPages = blockPayload === undefined ? [] : outputPageIds(WORKLOAD);
  step("M10", true, { outputPageCount: outputPages.length });
  await barrier("M10", "after", { outputPageCount: outputPages.length });

  // -------------------------------------------------------------------------
  // M11 Block commit
  //
  // A Run with no output commits no Block, so this interruption point does not
  // exist for that workload. It is structurally absent for both arms, and the
  // case is reported `not-applicable` rather than passed or failed.
  // -------------------------------------------------------------------------
  if (outputPages.length === 0) {
    structurallyAbsent("M11", "a Run with no output commits no Block");
  } else {
    await barrier("M11", "before");
  }
  let committedBlockId;
  if (outputPages.length > 0) {
    committedBlockId = store.blocks.commit(
      { payload: blockPayload },
      { kind: "module", id: MODULE_ID },
    ).id;
  }
  step("M11", committedBlockId !== undefined, { committedBlockId: committedBlockId ?? null });
  if (outputPages.length > 0) await barrier("M11", "after", { committedBlockId });

  // -------------------------------------------------------------------------
  // M12 every output Delivery append
  //
  // The barrier is placed on the first append only, so a workload with several
  // output pages still has one deterministic interruption point.
  // -------------------------------------------------------------------------
  if (outputPages.length === 0) {
    structurallyAbsent("M12", "a Run with no output appends no output Delivery");
  } else {
    await barrier("M12", "before");
  }
  let appended = 0;
  for (const pageId of outputPages) {
    store.deliveries.append(pageId, committedBlockId);
    appended += 1;
    if (appended === 1) await barrier("M12", "after", { appended, pageId });
  }
  step("M12", appended > 0, { appended, outputPages });

  // -------------------------------------------------------------------------
  // M13 positive acknowledgement
  // -------------------------------------------------------------------------
  // `ack` is the positive acknowledgement: it marks every input Delivery
  // obligation acknowledged and the Claim committed. `releaseClaim` is the
  // opposite, returning the Deliveries for another attempt, so it would make
  // this arm look worse here than it is.
  await barrier("M13", "before");
  store.deliveries.ack({
    moduleJobId: claim.moduleJobId,
    claimToken: claim.claimToken,
    runId: claim.runId,
    attempt: claim.attempt,
    moduleGenerationId: claim.moduleGenerationId,
  });
  step("M13", true, { acknowledgedRunId: claim.runId });
  await barrier("M13", "after", { acknowledgedRunId: claim.runId });

  // -------------------------------------------------------------------------
  // M14 Module process record closure and collection
  //
  // `host.stop()` is the only cleanup proof this arm has, and it works: the
  // creating Core process is still alive to observe the child exit. There is no
  // record to close afterwards.
  // -------------------------------------------------------------------------
  await barrier("M14", "before");
  let stopFailure;
  try {
    const stopped = await host.stop();
    step("M14", true, { state: stopped.state, childExitConfirmed: stopped.state === "stopped" });
  } catch (error) {
    stopFailure = describeError(error);
    step("M14", false, stopFailure);
  }
  step("M14-record-closure", false, {
    detail: "no Module process record exists in this arm, so none can be closed or collected",
  });
  await barrier("M14", "after", { childExitConfirmed: stopFailure === undefined });

  if (absentBoundary !== null) {
    writeFileSync(join(WORK_DIR, "boundary-structurally-absent"), `${absentBoundary.reason}\n`, "utf8");
    process.exit(0);
  }

  // The requested boundary was never reached. That is a harness fault, not a
  // baseline result, so it is reported as such.
  writeFileSync(
    BARRIER_FILE,
    `${JSON.stringify({ boundaryNotReached: true, target: TARGET_BOUNDARY, timing: TARGET_TIMING, steps: stepLog }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(WORK_DIR, "boundary-not-reached"), "true\n", "utf8");
  process.exit(3);
}

// The Core-side capability handler. Boundary 8 of the fixed matrix names the
// start and the completion of a capability request; both moments are here.
//
// The proposed arm's fixture marks its own interruption request with a
// `barrier` field. `capability.invoke` has a closed parameter set, so the same
// choice is made here from the workload and the invocation order: the two
// workloads with their own capability behaviour trip the boundary on their
// second request, and the other five on their first.
// Resolved when the first capability request reaches Core, which can only
// happen after `module.execute` crossed the protocol boundary. See M07.
let announceFirstCapabilityRequest;
const firstCapabilityRequestArrived = new Promise((resolve) => {
  announceFirstCapabilityRequest = resolve;
});

let capabilityInvocations = 0;
async function capabilityHandler(argumentsValue, context) {
  capabilityInvocations += 1;
  if (capabilityInvocations === 1) announceFirstCapabilityRequest();
  const workloadHasItsOwnCapability =
    WORKLOAD === "active-capability-handler" || WORKLOAD === "unknown-external-effect";
  const isBarrierRequest = capabilityInvocations === (workloadHasItsOwnCapability ? 2 : 1);

  const at = async (boundary, timing, extra) => {
    if (isBarrierRequest) await barrier(boundary, timing, extra);
  };

  capabilityState = "started";
  await at("M08.start", "before", { capabilityOperation: context.operation });

  // The effect intent is what a durable capability would persist before doing
  // anything observable. This arm records it in memory only.
  const intent = {
    operation: context.operation,
    runId: context.runId ?? null,
    idempotencyKey: context.idempotencyKey ?? null,
    recordedAt: new Date().toISOString(),
  };
  capabilityState = "intent-recorded";
  await at("M08.start", "after", { capabilityIntent: intent });

  if (context.operation === "write-slow") {
    // The handler is deliberately still running, so an interruption at this
    // boundary finds an active capability handler as the protocol requires.
    capabilityState = "active";
    await sleep(CONTRACT.slowCapabilityHandlerMs);
  }

  // `M08.completion` is the moment the capability outcome is produced. "before"
  // is immediately before it is decided; "after" is immediately after it is
  // decided and recorded, while the host still has to transmit it. Both
  // timings sit inside the handler, so both are reachable for every workload
  // including the one whose outcome is unknown and leaves by throwing.
  await at("M08.completion", "before", { capabilityIntent: intent });
  capabilityState = "completed";
  const outcomeIsUnknown = context.operation === "emit";
  writeFileSync(
    join(WORK_DIR, "mark-capability-answered"),
    outcomeIsUnknown ? "unknown\n" : "known\n",
    "utf8",
  );
  await at("M08.completion", "after", {
    capabilityIntent: intent,
    capabilityOutcome: outcomeIsUnknown ? "unknown" : "known",
  });
  if (outcomeIsUnknown) {
    // An external effect whose outcome is unknown: the intent was recorded, the
    // effect may or may not have happened, and no durable proof exists either
    // way. The Run must not treat this as either success or failure.
    throw new Error("the external effect outcome is unknown");
  }
  return { recorded: true, intent, arguments: argumentsValue };
}

function readBootId() {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return undefined;
  }
}

// The proposed arm's child fixture, shared rather than reimplemented.
const PROPOSED_FIXTURE_RELATIVE_PATH =
  "scripts/experiments/linux-core-service-ownership/core-standin/dolly-protocol-extension-fixture.py";

main().catch((error) => {
  const failure = describeError(error);
  event(`driver failed ${JSON.stringify(failure)}`);
  writeFileSync(join(WORK_DIR, "driver-failure.json"), `${JSON.stringify(failure, null, 2)}\n`, "utf8");
  process.exit(4);
});
