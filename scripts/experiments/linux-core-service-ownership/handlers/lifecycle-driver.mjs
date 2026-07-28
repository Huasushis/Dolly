/**
 * Case driver for the `lifecycle` family (SC-03-01 .. SC-03-07).
 *
 * The family splits into two kinds of case, and the difference matters when
 * reading a result.
 *
 * Cases SC-03-01 to SC-03-05 are *events*: the Core service restarts, the user
 * manager restarts, the login session ends, or the machine reboots. What must
 * be shown is that the whole Module control group went away, not merely that
 * the direct child of Core exited. Architecture Decision Record 0009 makes that
 * distinction the point of the design, so every one of these cases starts a
 * fixture that forks a descendant, records both process identifiers, and
 * afterwards requires `cgroup.events` to report `populated 0` (or the path to
 * be gone) *and* the descendant to be absent. A case that only proved the
 * direct child gone would prove nothing about group ownership.
 *
 * Cases SC-03-06 and SC-03-07 are *recovery evidence*: a later Core invocation
 * must decide whether an old Module process can still exist. They exercise the
 * production `LinuxModuleCgroupStopProver` and require the exact accepted
 * evidence, with a control that must not be accepted.
 *
 * This driver runs two roles, selected by its second argument:
 *   `setup`  runs as the main process of the unit under test, builds the group,
 *            starts the fixture, writes the barrier file, and waits;
 *   `decide` runs after the event and evaluates the invariants.
 * Splitting them is what lets the handler act on a barrier the setup role
 * reached rather than on a guessed delay.
 */
import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import {
  CGROUP_V2_MOUNT_POINT,
  LinuxModuleCgroupStopProver,
  deriveModuleCgroupPath,
  prepareDelegatedCgroupRoot,
  prepareModuleCgroup,
} from "../../../../src/core/linux-module-cgroup.ts";
import {
  Assertions,
  createJsonLineReader,
  readControlFile,
  readDelegatedRootCgroupPath,
  runDriver,
  startFixtureInModuleCgroup,
  waitForEmpty,
} from "./module-cgroup-harness.mjs";

const CASE_ID = process.argv[2];
const ROLE = process.argv[3];
const RUN_MARKER = process.argv[4] ?? "unmarked";
const CASE_DIR = process.argv[5] ?? ".";

const MODULE_LIMITS = {
  memoryMaxBytes: 67_108_864,
  maxProcesses: 32,
  cpuQuotaMicros: 50_000,
  cpuPeriodMicros: 100_000,
};

const HANDLERS = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const BARRIER_FILE = `${CASE_DIR}/barrier-snapshots`;
const SETUP_FILE = `${CASE_DIR}/setup.json`;

function identityFor(suffix) {
  return {
    instanceId: `dolly-test-instance-${RUN_MARKER}`,
    moduleId: `dolly-test-module-${RUN_MARKER}`,
    processGenerationId: `${RUN_MARKER}-${suffix}`,
  };
}

async function bootId() {
  return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
}

function processRecord(identity, moduleCgroupPath, serviceInvocationId, boot, overrides = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: "dolly.module-process-record/1",
    instanceId: identity.instanceId,
    moduleId: identity.moduleId,
    moduleGenerationId: `dolly-test-generation-${RUN_MARKER}`,
    processGenerationId: identity.processGenerationId,
    packageDigest: `sha256:${"0".repeat(64)}`,
    configurationReference: {
      configId: `dolly-test-config-${RUN_MARKER}`,
      revision: "1",
      configVersion: 1,
    },
    declaredExternalEffects: "none",
    serviceInvocationId,
    bootId: boot,
    moduleCgroupPath,
    state: "running",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Appends one barrier snapshot. The handler waits on these, never on a delay. */
async function barrier(name, detail) {
  const line = `${new Date().toISOString()} barrier ${name} reached ${JSON.stringify(detail)}\n`;
  await writeFile(BARRIER_FILE, line, { flag: "a" });
}

function decided(assertions, observations, reasonWhenBroken, reasonWhenHolds) {
  if (!assertions.allHold) {
    return {
      status: "failed",
      reason: reasonWhenBroken,
      observations: [...observations, ...assertions.lines()],
    };
  }
  return {
    status: "passed",
    reason: reasonWhenHolds,
    observations: [...observations, ...assertions.lines()],
  };
}

/**
 * Builds a real Module control group holding a fixture that has forked a
 * descendant, and reports both process identifiers. Used by every event case.
 */
async function buildGroupWithDescendant(suffix) {
  const delegatedRootCgroupPath = await readDelegatedRootCgroupPath();
  const root = await prepareDelegatedCgroupRoot({ delegatedRootCgroupPath });
  if (!root.prepared) {
    throw new Error(`${root.failure.code}: ${root.failure.detail}`);
  }
  const identity = identityFor(suffix);
  const prepared = await prepareModuleCgroup({
    delegatedRootCgroupPath,
    identity,
    limits: MODULE_LIMITS,
  });
  if (!prepared.prepared) {
    throw new Error(`${prepared.failure.code}: ${prepared.failure.detail}`);
  }
  const cgroup = prepared.cgroup;
  const { started } = await startFixtureInModuleCgroup({
    cgroup,
    fixture: `${HANDLERS}/fixture-hang.py`,
    protocolStdio: ["ignore", "pipe", "pipe"],
  });
  // The fixture reports its own and its descendant's identifier on its first
  // line. Waiting for that line is the deterministic readiness signal.
  const reader = createJsonLineReader(started.child.stdout);
  const report = await reader.next(20_000);
  const membership = await cgroup.waitForMembership({ timeoutMs: 20_000 });
  return { identity, cgroup, report, membership, delegatedRootCgroupPath };
}

/** Whether a process identifier is present in `/proc`. Sends no signal. */
function processPresent(processId) {
  return typeof processId === "number" && existsSync(`/proc/${processId}`);
}

// ---------------------------------------------------------------------------

await runDriver(async () => {
  const observations = [`case ${CASE_ID} role ${ROLE}`];
  const assertions = new Assertions();

  // -------------------------------------------------------------------------
  // Event cases, setup role: build the group and stop at the barrier.
  // -------------------------------------------------------------------------
  if (ROLE === "setup") {
    const built = await buildGroupWithDescendant("sc03");
    const boot = await bootId();
    const invocation = (process.env.INVOCATION_ID ?? "").trim();
    const state = {
      moduleCgroupFilesystemPath: built.cgroup.path,
      moduleCgroupPath: built.cgroup.path,
      processGenerationId: built.identity.processGenerationId,
      delegatedRootCgroupPath: built.delegatedRootCgroupPath,
      modulePid: built.report?.module_pid,
      descendantPid: built.report?.descendant_pid,
      membership: built.membership,
      bootId: boot,
      serviceInvocationId: invocation,
      corePid: process.pid,
    };
    await writeFile(SETUP_FILE, `${JSON.stringify(state, null, 2)}\n`);
    await barrier("module-group-populated", {
      moduleCgroupPath: state.moduleCgroupFilesystemPath,
      modulePid: state.modulePid,
      descendantPid: state.descendantPid,
      populated: await readControlFile(`${built.cgroup.path}/cgroup.events`),
    });
    // The handler now performs the lifecycle event. This process waits to be
    // terminated by it; the safety net keeps the case bounded if it is not.
    await new Promise((resolve) => setTimeout(resolve, 240_000));
    return { status: "inconclusive", reason: "setup-was-never-terminated", observations };
  }

  // -------------------------------------------------------------------------
  // Event cases, decide role: the whole group must be gone.
  // -------------------------------------------------------------------------
  if (ROLE === "decide") {
    // A restart starts the setup role again, which would overwrite the state
    // that describes the group under test. The handler snapshots it before the
    // event, so that snapshot is preferred whenever it exists.
    let state;
    try {
      const snapshot = `${CASE_DIR}/setup-before.json`;
      state = JSON.parse(
        await readFile(existsSync(snapshot) ? snapshot : SETUP_FILE, "utf8"),
      );
    } catch {
      return { status: "inconclusive", reason: "setup-state-unavailable", observations };
    }
    observations.push(`setup state ${JSON.stringify(state)}`);

    const events = await readControlFile(`${state.moduleCgroupFilesystemPath}/cgroup.events`);
    const pathPresent = existsSync(state.moduleCgroupFilesystemPath);
    observations.push(`module cgroup path present: ${pathPresent}`);
    observations.push(`cgroup.events after the event: ${JSON.stringify(events)}`);

    // The group is gone when the path was removed, or still exists and reports
    // no member. Anything else leaves a Module process unaccounted for.
    const groupEmpty = !pathPresent || (events !== undefined && events.includes("populated 0"));
    assertions.equal("the Module control group holds no process", true, groupEmpty);

    // The distinction ADR 0009 is about: the descendant, not only the direct
    // child of Core, must be gone.
    assertions.equal(
      "the Module process is gone",
      false,
      processPresent(state.modulePid),
    );
    assertions.equal(
      "the forked descendant is gone",
      false,
      processPresent(state.descendantPid),
    );
    assertions.equal(
      "the setup recorded a descendant to check",
      true,
      typeof state.descendantPid === "number" && state.descendantPid > 0,
    );

    return decided(
      assertions,
      observations,
      "expected-whole-group-termination",
      "whole-group-terminated",
    );
  }

  // -------------------------------------------------------------------------
  // SC-03-06: recovery within the same boot, old control-group path missing.
  // -------------------------------------------------------------------------
  if (CASE_ID === "SC-03-06-same-boot-missing-cgroup-path") {
    const boot = await bootId();
    const built = await buildGroupWithDescendant("sc0306");
    observations.push(`Module control group ${built.cgroup.path}`);
    observations.push(`fixture report ${JSON.stringify(built.report)}`);
    await barrier("module-group-populated", {
      moduleCgroupPath: built.cgroup.path,
      membership: built.membership,
    });

    // Terminate the whole group through the production path and prove it empty
    // before the directory is removed. The proof is the precondition of this
    // case, not an afterthought.
    const termination = await built.cgroup.terminate({ timeoutMs: 20_000 });
    observations.push(`terminate: ${JSON.stringify(termination)}`);
    assertions.equal("the whole group was terminated", true, termination.terminated);
    assertions.equal("the evidence is populated 0", "populated-zero", termination.evidence);
    assertions.equal(
      "the forked descendant is gone",
      false,
      processPresent(built.report?.descendant_pid),
    );
    await barrier("module-group-empty", { evidence: termination.evidence });

    await rmdir(built.cgroup.path).catch(() => undefined);
    observations.push(`path present after removal: ${existsSync(built.cgroup.path)}`);

    const prover = new LinuxModuleCgroupStopProver({ serviceBindingVerified: true });
    const record = processRecord(
      built.identity,
      built.cgroup.path,
      (process.env.INVOCATION_ID ?? "").trim(),
      boot,
    );
    const proof = await prover.proveStopped(record);
    observations.push(`stop proof: ${JSON.stringify(proof)}`);
    assertions.equal("the old process is proven stopped", true, proof.proven);
    assertions.equal("the evidence is the missing path", "missing-path", proof.evidence);

    // Control: a path that exists and still holds a process must NOT be
    // accepted. Without it, "proven" could be a constant.
    const live = await buildGroupWithDescendant("sc0306ctl");
    const liveRecord = processRecord(
      live.identity,
      live.cgroup.path,
      (process.env.INVOCATION_ID ?? "").trim(),
      boot,
    );
    const liveProof = await prover.proveStopped(liveRecord);
    observations.push(`control stop proof: ${JSON.stringify(liveProof)}`);
    assertions.equal("a populated group is not proven stopped", false, liveProof.proven);
    await live.cgroup.terminate({ timeoutMs: 20_000 });
    await waitForEmpty(live.cgroup, 10_000).catch(() => undefined);
    await rmdir(live.cgroup.path).catch(() => undefined);

    return decided(
      assertions,
      observations,
      "expected-missing-path-evidence",
      "missing-path-accepted-populated-path-refused",
    );
  }

  // -------------------------------------------------------------------------
  // SC-03-07: the Linux boot identifier has changed.
  //
  // A process from an earlier boot cannot still exist, so the record is proven
  // stopped without any reading of the old path. The control keeps everything
  // identical except the boot identifier.
  // -------------------------------------------------------------------------
  if (CASE_ID === "SC-03-07-changed-boot-identifier") {
    const boot = await bootId();
    const built = await buildGroupWithDescendant("sc0307");
    observations.push(`Module control group ${built.cgroup.path}`);
    observations.push(`current boot identifier ${boot}`);
    await barrier("module-group-populated", {
      moduleCgroupPath: built.cgroup.path,
      membership: built.membership,
    });

    const prover = new LinuxModuleCgroupStopProver({ serviceBindingVerified: true });
    const invocation = (process.env.INVOCATION_ID ?? "").trim();

    // An earlier boot. The group below is deliberately still populated, so the
    // only thing that can make this proof succeed is the boot identifier.
    const earlierBoot = "00000000-0000-4000-8000-000000000001";
    const earlier = await prover.proveStopped(
      processRecord(built.identity, built.cgroup.path, invocation, earlierBoot),
    );
    observations.push(`earlier-boot proof: ${JSON.stringify(earlier)}`);
    assertions.equal("the earlier boot is proven stopped", true, earlier.proven);
    assertions.equal(
      "the evidence is the changed boot identifier",
      "changed-boot-identifier",
      earlier.evidence,
    );

    // Control: same populated group, current boot identifier. Must be refused.
    const current = await prover.proveStopped(
      processRecord(built.identity, built.cgroup.path, invocation, boot),
    );
    observations.push(`current-boot proof: ${JSON.stringify(current)}`);
    assertions.equal(
      "the same populated group is not proven stopped within this boot",
      false,
      current.proven,
    );

    const termination = await built.cgroup.terminate({ timeoutMs: 20_000 });
    observations.push(`terminate: ${JSON.stringify(termination)}`);
    assertions.equal("the whole group was terminated", true, termination.terminated);
    assertions.equal(
      "the forked descendant is gone",
      false,
      processPresent(built.report?.descendant_pid),
    );
    await barrier("module-group-empty", { evidence: termination.evidence });
    await rmdir(built.cgroup.path).catch(() => undefined);

    return decided(
      assertions,
      observations,
      "expected-changed-boot-evidence",
      "changed-boot-accepted-same-boot-refused",
    );
  }

  return { status: "inconclusive", reason: "unknown-case-or-role", observations };
});
