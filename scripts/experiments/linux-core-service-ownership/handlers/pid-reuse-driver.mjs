/**
 * Case driver for `pid-reuse` (SC-05-01).
 *
 * Linux reuses process identifiers, so a saved identifier is not evidence about
 * the process that saved it. Architecture Decision Record 0009 therefore
 * requires startup recovery to decide from control-group evidence alone, and
 * requires that no signal is ever sent to a recovered identifier.
 *
 * The case builds the exact dangerous situation and then checks two things that
 * a design using the identifier would get wrong:
 *
 *   1. the old Module process record is still proven stopped, even though the
 *      identifier it carries currently belongs to a live process; and
 *   2. that live process is *still alive afterwards*. If recovery had signalled
 *      the recorded identifier, this unrelated process would be the casualty,
 *      so its survival is the observable evidence that nothing was signalled.
 *
 * The collision is produced one of two ways, and which one was used is always
 * recorded in the observations, in the barrier snapshots, and in the result
 * reason, so the two are never confused:
 *
 *   `kernel-reissued-the-exact-identifier` writes `/proc/sys/kernel/ns_last_pid`
 *      so the kernel hands the Module's old identifier to an unrelated program.
 *      This needs a writable procfs.
 *   `constructed-collision-because-ns-last-pid-is-not-writable` starts the
 *      unrelated program first and makes the record name *its* identifier.
 *
 * A measured attempt established that the first is unavailable here: that
 * control file is root-owned even inside a privileged container, and the runner
 * uses an unprivileged account. The second reaches the same observation, and
 * the difference does not reach the code under test: recovery reads the record
 * and the control group, and cannot tell how the kernel allocated an
 * identifier. It is a weaker *story*, not weaker evidence, and it is labelled.
 */
import { spawn } from "node:child_process";
import { readFile, rmdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import {
  LinuxModuleCgroupStopProver,
  prepareDelegatedCgroupRoot,
  prepareModuleCgroup,
} from "../../../../src/core/linux-module-cgroup.ts";
import {
  Assertions,
  createJsonLineReader,
  readDelegatedRootCgroupPath,
  runDriver,
  startFixtureInModuleCgroup,
  sleep,
} from "./module-cgroup-harness.mjs";

const CASE_ID = process.argv[2];
const RUN_MARKER = process.argv[3] ?? "unmarked";
const CASE_DIR = process.argv[4] ?? ".";

const NS_LAST_PID = "/proc/sys/kernel/ns_last_pid";
const HANDLERS = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

const MODULE_LIMITS = {
  memoryMaxBytes: 67_108_864,
  maxProcesses: 32,
  cpuQuotaMicros: 50_000,
  cpuPeriodMicros: 100_000,
};

async function barrier(name, detail) {
  await writeFile(
    `${CASE_DIR}/barrier-snapshots`,
    `${new Date().toISOString()} barrier ${name} reached ${JSON.stringify(detail)}\n`,
    { flag: "a" },
  );
}

/**
 * Starts a process that is guaranteed to receive `targetPid`, by telling the
 * kernel which identifier to allocate next. Returns undefined when the control
 * file cannot be written.
 */
async function claimExactPid(targetPid) {
  try {
    await writeFile(NS_LAST_PID, String(targetPid - 1));
  } catch {
    return undefined;
  }
  // `sleep` is an ordinary unrelated program: it has nothing to do with the
  // Module whose record carries this identifier.
  const child = spawn("/bin/sleep", ["120"], { stdio: "ignore" });
  if (child.pid !== targetPid) {
    child.kill("SIGKILL");
    return undefined;
  }
  return child;
}

await runDriver(async () => {
  const observations = [`case ${CASE_ID}`];
  const assertions = new Assertions();

  const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const invocation = (process.env.INVOCATION_ID ?? "").trim();
  const delegatedRootCgroupPath = await readDelegatedRootCgroupPath();
  const root = await prepareDelegatedCgroupRoot({ delegatedRootCgroupPath });
  if (!root.prepared) {
    return {
      status: "inconclusive",
      reason: "delegated-root-unavailable",
      observations: [...observations, JSON.stringify(root)],
    };
  }

  const identity = {
    instanceId: `dolly-test-instance-${RUN_MARKER}`,
    moduleId: `dolly-test-module-${RUN_MARKER}`,
    processGenerationId: `${RUN_MARKER}-sc0501`,
  };
  const prepared = await prepareModuleCgroup({
    delegatedRootCgroupPath,
    identity,
    limits: MODULE_LIMITS,
  });
  if (!prepared.prepared) {
    return {
      status: "inconclusive",
      reason: "module-cgroup-unavailable",
      observations: [...observations, JSON.stringify(prepared)],
    };
  }
  const cgroup = prepared.cgroup;
  observations.push(`Module control group ${cgroup.path}`);

  // A real Module process, whose identifier the record will carry.
  const { started } = await startFixtureInModuleCgroup({
    cgroup,
    fixture: `${HANDLERS}/fixture-hang.py`,
  });
  const reader = createJsonLineReader(started.child.stdout);
  const report = await reader.next(20_000);
  const membership = await cgroup.waitForMembership({ timeoutMs: 20_000 });
  const modulePid = report?.module_pid;
  observations.push(`Module process identifier ${modulePid}`);
  await barrier("module-group-populated", { modulePid, membership });

  // End the whole group and prove it empty, then remove the path. From here the
  // identifier is free for the kernel to hand to anybody.
  const termination = await cgroup.terminate({ timeoutMs: 20_000 });
  observations.push(`terminate: ${JSON.stringify(termination)}`);
  assertions.equal("the whole group was terminated", true, termination.terminated);
  assertions.equal("the evidence is populated 0", "populated-zero", termination.evidence);
  await barrier("module-group-empty", { evidence: termination.evidence });
  await rmdir(cgroup.path).catch(() => undefined);

  if (typeof modulePid !== "number") {
    return {
      status: "inconclusive",
      reason: "module-process-identifier-unavailable",
      observations,
    };
  }

  // Hand the freed identifier to an unrelated program.
  //
  // Forcing the kernel to reissue that exact identifier needs a writable
  // `/proc/sys/kernel/ns_last_pid`, which is root-owned even inside a
  // privileged container, so it is unavailable to the unprivileged account the
  // runner uses. A measured attempt confirmed that.
  //
  // The fallback builds the same collision from the other end: an unrelated
  // process is started and the *record* is made to name its identifier. What
  // recovery sees is identical either way — a durable record naming an
  // identifier that currently belongs to a live process that is not the Module
  // — because recovery reads the record and the control group, and has no way
  // to know how the kernel arrived at that allocation. The method actually used
  // is recorded in the observations and in the result reason, so no reader can
  // mistake one for the other.
  let reuseMethod = "kernel-reissued-the-exact-identifier";
  let impostor = await claimExactPid(modulePid);
  let recordedPid = modulePid;
  if (impostor === undefined) {
    reuseMethod = "constructed-collision-because-ns-last-pid-is-not-writable";
    impostor = spawn("/bin/sleep", ["120"], { stdio: "ignore" });
    recordedPid = impostor.pid;
    observations.push(
      `${NS_LAST_PID} is not writable by this account, so identifier ${modulePid} could not be reissued`,
    );
  }
  observations.push(`reuse method: ${reuseMethod}`);
  observations.push(`identifier ${recordedPid} belongs to an unrelated /bin/sleep`);
  await barrier("identifier-reused", { reusedPid: recordedPid, reuseMethod });
  assertions.equal(
    "the recorded identifier belongs to a live unrelated process",
    true,
    existsSync(`/proc/${recordedPid}`),
  );

  try {
    // The record carries the identifier in `diagnosticPid`, which is exactly
    // what its name promises: a diagnostic, never an input to a decision.
    const now = new Date().toISOString();
    const record = {
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
      serviceInvocationId: invocation,
      bootId: boot,
      moduleCgroupPath: cgroup.path,
      state: "running",
      createdAt: now,
      updatedAt: now,
      diagnosticPid: recordedPid,
    };

    const prover = new LinuxModuleCgroupStopProver({ serviceBindingVerified: true });
    const proof = await prover.proveStopped(record);
    observations.push(`stop proof: ${JSON.stringify(proof)}`);

    // A design that consulted the identifier would see it alive and refuse.
    assertions.equal("the old process is proven stopped", true, proof.proven);
    assertions.equal(
      "the evidence comes from the control group, not the identifier",
      true,
      proof.evidence === "missing-path" || proof.evidence === "populated-zero",
    );

    // The observable no-signal proof: recovery ran, and the unrelated holder of
    // the reused identifier is untouched.
    await sleep(200);
    const stillAlive = existsSync(`/proc/${recordedPid}`);
    observations.push(`unrelated process ${recordedPid} alive after recovery: ${stillAlive}`);
    assertions.equal(
      "no signal reached the reused identifier",
      true,
      stillAlive && impostor.exitCode === null && impostor.signalCode === null,
    );
  } finally {
    impostor.kill("SIGKILL");
  }

  if (!assertions.allHold) {
    return {
      status: "failed",
      reason: "expected-identifier-independent-recovery",
      observations: [...observations, ...assertions.lines()],
    };
  }
  return {
    status: "passed",
    reason: `identifier-ignored-and-nothing-signalled-via-${reuseMethod}`,
    observations: [...observations, ...assertions.lines()],
  };
});
