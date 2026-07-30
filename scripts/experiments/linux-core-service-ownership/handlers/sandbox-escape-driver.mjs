/**
 * Case driver for the `sandbox-escape` family (SC-14-01 to SC-14-11).
 *
 * Architecture Decision Record (ADR) 0009 required failure test 6 asks for an
 * untrusted fixture that fails every cgroup-change, cgroup-escape, Core-signal,
 * Core-state, manager-control, inherited-descriptor, other-process `/proc`
 * state, filesystem, network, or subprocess escape attempt. This driver starts
 * exactly that fixture as a real Module process, inside a real prepared Module
 * control group, through the reviewed child launcher, and then judges one case
 * per attempt.
 *
 * How a case is decided
 * ---------------------
 * The decision is made from what the kernel actually did, never from what the
 * decision record hopes:
 *
 *   * every required attempt denied, with the exact errno the case declares →
 *     `passed`;
 *   * a required attempt that succeeded → the boundary that ADR 0009 assigns to
 *     this attempt does not exist in this deployment. Where a component that
 *     must deny it exists and is under test, that is `failed`. Where the
 *     decision assigns the denial to a sandbox backend or to a Linux execution
 *     backend that this deployment has not got, the honest report is
 *     `not-applicable` with the successful attempt recorded, because there is
 *     nothing under test that could have denied it; and
 *   * an attempt that could not be made at all → `inconclusive`.
 *
 * `docs/spec/extension-process-protocol.md` Section 3 states that `process`
 * isolation "does not deny ambient filesystem, network, or subprocess access"
 * and that it "MUST report that ambient filesystem/network/process denial is
 * not guaranteed", and ADR 0009 states that sharing a user account with Core
 * means cgroup delegation alone is not a hostile-code boundary. The
 * `not-applicable` cases below are exactly those, and each one carries the
 * observed evidence so the gap is visible rather than assumed.
 *
 * Safety: the fixture is a fixed local script that takes no input, everything
 * it creates is inside this run's own transient service subtree, and this
 * driver terminates the whole group and removes every control group the
 * fixture made before it reports.
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import {
  Assertions,
  createJsonLineReader,
  collectStream,
  fixturePath,
  prepareModuleCgroupForCase,
  processExists,
  pythonInterpreterPath,
  readDelegatedRootCgroupPath,
  removeStrayEscapeGroups,
  runDriver,
  sleep,
  startFixtureInModuleCgroup,
} from "./module-cgroup-harness.mjs";

const CASE_ID = process.argv[2];
const RUN_MARKER = process.argv[3] ?? "unmarked";

/**
 * Constants shared with `fixture-escape.py` and `fixture-core-standin.py`. The
 * fixture reads none of them from its environment or command line; they are
 * literals in both files, and the driver asserts on what the fixture found, so
 * a drift between the files shows up as a failed case.
 */
const CORE_STANDIN_SENTINEL = "dolly-test-core-standin-sentinel";
const CORE_SECRET_ENV_NAME = "DOLLY_TEST_CORE_SECRET_SENTINEL";
const CORE_SECRET_ENV_VALUE = "dolly-test-core-secret-1f7a";
const CORE_STATE_PROBE_DIRECTORY = "/tmp/dolly-test-escape-probe";
const CORE_STATE_PROBE_PATH = `${CORE_STATE_PROBE_DIRECTORY}/core-state.json`;
const CORE_STATE_SENTINEL = "dolly-test-core-state-sentinel";

const MODULE_LIMITS = {
  memoryMaxBytes: 67_108_864,
  maxProcesses: 32,
  cpuQuotaMicros: 50_000,
  cpuPeriodMicros: 100_000,
};

/**
 * What each case requires, and which component ADR 0009 makes responsible.
 *
 * `enforcer: "launcher"` means the reviewed child launcher is the component
 * under test and a success is a defect. `enforcer: "absent-backend"` means the
 * decision assigns the denial to an isolation or sandbox backend that this
 * deployment does not have, so a success is recorded as `not-applicable` with
 * the evidence rather than as a pass or as a Dolly defect.
 */
const CASES = {
  "SC-14-01-change-own-cgroup": {
    attempts: ["create_sibling_cgroup_outside_own", "create_child_cgroup_under_own"],
    enforcer: "absent-backend",
    passedReason: "every-control-group-change-was-denied",
    absentReason: "no-backend-denies-control-group-change",
  },
  "SC-14-02-leave-own-cgroup": {
    attempts: [
      "migrate_out_of_module_cgroup",
      "open_parent_cgroup_procs_for_write",
      "open_user_manager_cgroup_procs_for_write",
    ],
    enforcer: "absent-backend",
    passedReason: "every-control-group-escape-was-denied",
    absentReason: "no-backend-denies-control-group-escape",
  },
  "SC-14-03-change-own-limits": {
    attempts: ["change_own_memory_max", "change_own_pids_max"],
    enforcer: "absent-backend",
    passedReason: "every-limit-change-was-denied",
    absentReason: "no-backend-denies-limit-change",
  },
  "SC-14-04-signal-core": {
    attempts: ["signal_core_presence", "signal_core_terminate"],
    enforcer: "absent-backend",
    passedReason: "every-signal-to-core-was-denied",
    absentReason: "no-backend-denies-signalling-core",
  },
  "SC-14-05-open-core-state": {
    attempts: ["open_core_state_for_read", "open_core_state_for_write"],
    enforcer: "absent-backend",
    passedReason: "every-core-state-open-was-denied",
    absentReason: "no-backend-denies-opening-core-state",
  },
  "SC-14-06-open-manager-control-files": {
    attempts: [
      "connect_user_bus_socket",
      "connect_user_manager_private_socket",
      "connect_system_manager_private_socket",
    ],
    enforcer: "absent-backend",
    passedReason: "every-manager-control-open-was-denied",
    absentReason: "no-backend-denies-manager-control-access",
  },
  "SC-14-07-read-other-process-proc-state": {
    attempts: ["read_core_proc_status", "read_core_proc_cmdline", "read_core_proc_environ"],
    enforcer: "absent-backend",
    passedReason: "every-other-process-proc-read-was-denied",
    absentReason: "no-backend-denies-reading-other-process-proc-state",
  },
  "SC-14-08-use-inherited-descriptor": {
    attempts: ["inherited_control_descriptor_3", "inherited_extra_descriptor_4"],
    enforcer: "launcher",
    expectedErrno: 9,
    passedReason: "every-inherited-descriptor-was-closed-before-exec",
  },
  "SC-14-09-ambient-filesystem-authority": {
    attempts: ["ambient_read_outside_scratch", "ambient_write_outside_scratch"],
    enforcer: "absent-backend",
    passedReason: "ambient-filesystem-authority-was-denied",
    absentReason: "no-sandbox-backend-denies-ambient-filesystem",
  },
  "SC-14-10-ambient-network-authority": {
    attempts: ["ambient_network_socket"],
    enforcer: "absent-backend",
    passedReason: "ambient-network-authority-was-denied",
    absentReason: "no-sandbox-backend-denies-ambient-network",
  },
  "SC-14-11-ambient-subprocess-authority": {
    attempts: ["ambient_subprocess"],
    enforcer: "absent-backend",
    passedReason: "ambient-subprocess-authority-was-denied",
    absentReason: "no-sandbox-backend-denies-ambient-subprocess",
  },
};

/** Starts the Core stand-in the escape attempts aim at. */
async function startCoreStandIn() {
  const child = spawn(
    pythonInterpreterPath(),
    [
      "-I",
      "-B",
      fixturePath("fixture-core-standin.py"),
      CORE_STANDIN_SENTINEL,
      CORE_STATE_PROBE_PATH,
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: { [CORE_SECRET_ENV_NAME]: CORE_SECRET_ENV_VALUE },
    },
  );
  const diagnostics = collectStream(child.stderr, 4096);
  let exit;
  child.once("exit", (code, signalName) => {
    exit = { code, signal: signalName };
  });
  for (let attempt = 0; attempt < 100 && !diagnostics.read().includes("ready"); attempt += 1) {
    await sleep(20);
  }
  return {
    processId: child.pid,
    diagnostics,
    get exit() {
      return exit;
    },
    stop() {
      if (exit === undefined) child.kill("SIGKILL");
    },
  };
}

await runDriver(async () => {
  const observations = [];
  const declared = CASES[CASE_ID];
  if (declared === undefined) {
    return { status: "inconclusive", reason: "unknown-case", observations: [`no branch for ${CASE_ID}`] };
  }

  const delegatedRootCgroupPath = await readDelegatedRootCgroupPath();
  observations.push(`case ${CASE_ID}`);
  observations.push(`delegated root ${delegatedRootCgroupPath}`);
  observations.push("isolation under test: process (no sandbox backend is installed on this platform)");

  await rm(CORE_STATE_PROBE_DIRECTORY, { recursive: true, force: true });
  await mkdir(CORE_STATE_PROBE_DIRECTORY, { recursive: true, mode: 0o700 });
  await writeFile(
    CORE_STATE_PROBE_PATH,
    `${JSON.stringify({ schemaVersion: "dolly.core-state/16", sentinel: CORE_STATE_SENTINEL })}\n`,
    { mode: 0o600 },
  );

  const standIn = await startCoreStandIn();
  observations.push(`Core stand-in process ${standIn.processId} started in the core subgroup`);

  const { cgroup } = await prepareModuleCgroupForCase({
    identity: {
      instanceId: `dolly-test-instance-${RUN_MARKER}`,
      moduleId: `dolly-test-module-${RUN_MARKER}`,
      processGenerationId: `${RUN_MARKER}-${CASE_ID.slice(0, 8).replace(/-/g, "")}`,
    },
    limits: MODULE_LIMITS,
  });
  observations.push(`prepared ${cgroup.path}`);
  observations.push(`limits read back ${JSON.stringify(cgroup.limits)}`);

  let report;
  let fixtureError;
  try {
    const { started, outcome } = await startFixtureInModuleCgroup({
      cgroup,
      fixture: fixturePath("fixture-escape.py"),
      maxOpenFiles: 64,
      // One extra inherited descriptor, so SC-14-08 has something the launcher
      // must have closed.
      additionalInheritedStdio: ["pipe"],
    });
    observations.push(`launcher outcome ${JSON.stringify(outcome)}`);
    if (outcome.outcome !== "executing") {
      throw new Error(`the launcher was not authorized to execute: ${outcome.code}`);
    }
    cgroup.recordObservedProcessIds(outcome.verifiedProcessIds);
    const diagnostics = collectStream(started.child.stderr, 8192);
    const reader = createJsonLineReader(started.child.stdout);
    report = await reader.next(40_000);
    observations.push(`fixture standard error: ${JSON.stringify(diagnostics.read().slice(0, 512))}`);
  } catch (error) {
    fixtureError = error;
  }

  const standInSurvived = standIn.processId !== undefined && processExists(standIn.processId);
  observations.push(
    `Core stand-in after the fixture: alive ${standInSurvived}, exit ${JSON.stringify(standIn.exit)}`,
  );

  // Clean up before deciding, so a decision path can never skip it.
  const termination = await cgroup.terminate({ timeoutMs: 10_000 });
  observations.push(`terminate ${JSON.stringify(termination)}`);
  if (termination.terminated) {
    const removal = await cgroup.remove();
    observations.push(`remove ${JSON.stringify(removal)}`);
  }
  const strays = await removeStrayEscapeGroups(delegatedRootCgroupPath);
  observations.push(`control groups the fixture left behind and this driver removed: ${JSON.stringify(strays)}`);
  standIn.stop();
  await rm(CORE_STATE_PROBE_DIRECTORY, { recursive: true, force: true });

  if (fixtureError !== undefined) {
    return {
      status: "inconclusive",
      reason: "hostile-fixture-did-not-report",
      observations: [...observations, `fixture error: ${String(fixtureError)}`],
    };
  }

  observations.push(`fixture uid ${report.uid}, own cgroup ${report.own_cgroup}`);
  observations.push(`fixture found Core stand-in ${JSON.stringify(report.core_standin_pid)}`);
  for (const [name, entry] of Object.entries(report.attempts ?? {})) {
    observations.push(`attempt ${name}: ${JSON.stringify(entry)}`);
  }

  // ---- judge this case ----------------------------------------------------
  const assertions = new Assertions();
  const attempts = declared.attempts.map((name) => [name, report.attempts?.[name]]);
  const missing = attempts.filter(([, entry]) => entry === undefined).map(([name]) => name);
  if (missing.length > 0) {
    return {
      status: "inconclusive",
      reason: "attempt-not-reported",
      observations: [...observations, `the fixture reported no result for ${missing.join(", ")}`],
    };
  }
  const errored = attempts.filter(([, entry]) => entry.outcome === "error");
  if (errored.length > 0) {
    return {
      status: "inconclusive",
      reason: "attempt-could-not-be-made",
      observations: [
        ...observations,
        `the fixture could not make ${errored.map(([name]) => name).join(", ")}`,
      ],
    };
  }

  const succeeded = attempts.filter(([, entry]) => entry.outcome === "succeeded");
  if (succeeded.length === 0) {
    for (const [name, entry] of attempts) {
      assertions.equal(`${name} was denied`, "denied", entry.outcome);
      if (declared.expectedErrno !== undefined) {
        assertions.equal(`${name} refusal errno`, declared.expectedErrno, entry.errno);
      }
    }
    if (CASE_ID === "SC-14-04-signal-core") {
      assertions.equal("the Core stand-in survived", true, standInSurvived);
    }
    const lines = [...observations, "", "assertions:", ...assertions.lines()];
    return assertions.allHold
      ? { status: "passed", reason: declared.passedReason, observations: lines }
      : { status: "failed", reason: "expected-refusal-not-exact", observations: lines };
  }

  const names = succeeded.map(([name]) => name).join(", ");
  if (declared.enforcer === "launcher") {
    return {
      status: "failed",
      reason: "escape-attempt-succeeded",
      observations: [
        ...observations,
        "",
        `the child launcher is the component required to deny this, and it did not: ${names} succeeded`,
      ],
    };
  }
  return {
    status: "not-applicable",
    reason: declared.absentReason,
    observations: [
      ...observations,
      "",
      `these attempts succeeded: ${names}`,
      "ADR 0009 assigns this denial to an isolation or sandbox backend that must prevent it, and states that",
      "sharing a user account with Core means control-group delegation alone is not a hostile-code boundary.",
      "docs/spec/extension-process-protocol.md Section 3 states that process isolation does not deny ambient",
      "filesystem, network, or subprocess access and must report that the denial is not guaranteed.",
      "No such backend is installed on this platform, so nothing under test could have denied the attempt.",
      "This case is reported not-applicable rather than passed, and the successful attempt is recorded above.",
    ],
  };
});
