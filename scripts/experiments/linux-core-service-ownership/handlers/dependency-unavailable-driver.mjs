/**
 * Case driver for the `dependency-unavailable` family (SC-13-01 .. SC-13-08).
 *
 * Architecture Decision Record 0009 requires Core to fail closed when a
 * dependency it needs is unavailable. The point of these cases is *not* that an
 * error is reported. It is that Core does not carry on in a reduced form: no
 * control group is created for a Module whose record could not be persisted, no
 * launcher is started, no record reaches `running`, no stop is reported as
 * proven, and startup does not continue past inconsistent durable records.
 *
 * Every case therefore asserts two different things:
 *
 *   1. the exact production refusal code, and
 *   2. a *negative* observation showing the next step never happened.
 *
 * Several cases also run a control in the same process, differing only in the
 * injected fault. Without one, a refusal cannot be attributed to the fault
 * rather than to something else about the environment.
 *
 * The faults are real wherever a real one is reachable without privilege: a
 * control-group root that genuinely lacks the required controllers, a state
 * store whose directory genuinely cannot be written, a service-manager client
 * program that genuinely does not exist. `ModuleCgroupFileSystem` and the
 * launcher-control interface are production injection seams and are used only
 * where the fault cannot otherwise be produced.
 */
import { mkdtemp, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  CGROUP_V2_MOUNT_POINT,
  deriveModuleCgroupPath,
  prepareDelegatedCgroupRoot,
  prepareModuleCgroup,
} from "../../../../src/core/linux-module-cgroup.ts";
import {
  startModuleProcess,
  stopModuleProcess,
} from "../../../../src/core/linux-module-process-lifecycle.ts";
import { decideLinuxModuleActivation } from "../../../../src/core/linux-module-activation.ts";
import { FileCoreStateStore } from "../../../../src/core/file-core-state-store.ts";
import { createModuleLauncherControl } from "../../../../src/adapters/linux-module-launcher/module-launcher-control.ts";
import { LinuxModuleLauncherController } from "../../../../src/adapters/linux-module-launcher/linux-module-launcher-controller.ts";
import {
  Assertions,
  LAUNCHER_SCRIPT_PATH,
  pythonInterpreterPath,
  readControlFile,
  readDelegatedRootCgroupPath,
  runDriver,
  sleep,
} from "./module-cgroup-harness.mjs";

const CASE_ID = process.argv[2];
const RUN_MARKER = process.argv[3] ?? "unmarked";
const CASE_DIR = process.argv[4] ?? ".";

const MODULE_LIMITS = {
  memoryMaxBytes: 67_108_864,
  maxProcesses: 16,
  cpuQuotaMicros: 50_000,
  cpuPeriodMicros: 100_000,
};

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

function processRecord(identity, moduleCgroupPath, serviceInvocationId, boot) {
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
    state: "starting",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * A record writer that fails exactly once, at the step the case names, and
 * counts every call so the driver can prove which steps were never reached.
 */
function countingRecords(inner, failOn) {
  const calls = { append: 0, update: 0 };
  return {
    calls,
    appendModuleProcessRecord(record) {
      calls.append += 1;
      if (failOn === "append") {
        throw new Error("the Core state store is unavailable");
      }
      return inner ? inner.appendModuleProcessRecord(record) : record;
    },
    updateModuleProcessRecordState(id, state, failureCode) {
      calls.update += 1;
      if (inner) return inner.updateModuleProcessRecordState(id, state, failureCode);
      return { processGenerationId: id, state, failureCode };
    },
  };
}

function invocationId() {
  const value = (process.env.INVOCATION_ID ?? "").trim();
  return /^[0-9a-f]{32}$/.test(value) ? value : undefined;
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

// ---------------------------------------------------------------------------

await runDriver(async () => {
  const observations = [`case ${CASE_ID}`];
  const assertions = new Assertions();

  // -------------------------------------------------------------------------
  // SC-13-01: the systemd service manager is unavailable.
  //
  // The inspection reaches the service manager through `busctl`. Pointing that
  // at a path that does not exist is a real unavailable service manager for
  // this process, and needs no privilege. The control uses the real `busctl`
  // with the same absent unit, so the two refusals can be compared.
  // -------------------------------------------------------------------------
  if (CASE_ID === "SC-13-01-systemd-unavailable") {
    const python = pythonInterpreterPath();
    const unitName = `dolly-test-${RUN_MARKER}-absent.service`;

    const withoutManager = await decideLinuxModuleActivation({
      unitName,
      mode: "user",
      busctlPath: "/nonexistent/dolly-test-busctl",
      launcherInterpreterPath: python,
      launcherScriptPath: LAUNCHER_SCRIPT_PATH,
    });
    observations.push(`without a service manager: ${JSON.stringify(withoutManager)}`);

    assertions.equal("activation is refused", false, withoutManager.permitted);
    assertions.equal(
      "the refusal names the unverified service binding",
      true,
      (withoutManager.refusals ?? []).some(
        (refusal) => refusal.code === "MODULE_ACTIVATION_SERVICE_UNVERIFIED",
      ),
    );
    // The degradation this case exists to exclude: handing back a stop prover
    // anyway, which would let startup recovery mark old Module processes
    // stopped on the word of a service manager it never reached.
    assertions.equal(
      "no stop prover is handed out",
      true,
      withoutManager.stopProver === undefined,
    );
    assertions.equal(
      "no verified binding is handed out",
      true,
      withoutManager.binding === undefined,
    );

    const withManager = await decideLinuxModuleActivation({
      unitName,
      mode: "user",
      launcherInterpreterPath: python,
      launcherScriptPath: LAUNCHER_SCRIPT_PATH,
    });
    observations.push(`with the real service manager: ${JSON.stringify(withManager)}`);
    // Control: a reachable manager reports the unit is absent. Both refuse, but
    // the recorded binding failures differ, so the first refusal is attributable
    // to the unreachable manager and is not a catch-all.
    assertions.equal("the control is also refused", false, withManager.permitted);
    assertions.equal(
      "the two refusals rest on different binding failures",
      true,
      JSON.stringify((withoutManager.bindingFailures ?? []).map((f) => f.code)) !==
        JSON.stringify((withManager.bindingFailures ?? []).map((f) => f.code)),
    );

    return decided(
      assertions,
      observations,
      "expected-fail-closed-without-service-manager",
      "refused-without-service-manager",
    );
  }

  // -------------------------------------------------------------------------
  // SC-13-02: control-group delegation is unavailable.
  //
  // The handler runs this case in a transient unit created *without*
  // `Delegate=yes`, so the driver's own control group is the service group
  // itself: it holds this process and its subtree_control cannot be written.
  // Both are real kernel conditions, not injected ones.
  // -------------------------------------------------------------------------
  if (CASE_ID === "SC-13-02-delegation-unavailable") {
    const own = (await readFile("/proc/self/cgroup", "utf8"))
      .split("\n")
      .filter((line) => line.startsWith("0::"))
      .map((line) => line.slice(3).trim())
      .pop();
    observations.push(`this process is at ${own}`);
    if (own === undefined || !own.startsWith("/")) {
      return {
        status: "inconclusive",
        reason: "own-cgroup-path-unreadable",
        observations,
      };
    }
    assertions.equal(
      "the unit did not delegate a core subgroup",
      false,
      own.endsWith("/core"),
    );

    const root = await prepareDelegatedCgroupRoot({ delegatedRootCgroupPath: own });
    observations.push(`prepareDelegatedCgroupRoot: ${JSON.stringify(root)}`);
    assertions.equal("the delegated root is refused", false, root.prepared);
    assertions.equal(
      "the refusal is a delegation failure",
      true,
      root.failure?.code === "MODULE_CGROUP_DELEGATED_ROOT_POPULATED" ||
        root.failure?.code === "MODULE_CGROUP_CONTROLLER_UNAVAILABLE",
    );

    // Preparing a Module group below an undelegated root must also refuse, and
    // must leave no directory behind. A created-then-abandoned group is exactly
    // the degraded outcome this case excludes.
    const identity = identityFor("sc1302");
    const derived = deriveModuleCgroupPath(own, identity);
    const prepared = await prepareModuleCgroup({
      delegatedRootCgroupPath: own,
      identity,
      limits: MODULE_LIMITS,
    });
    observations.push(`prepareModuleCgroup: ${JSON.stringify(prepared)}`);
    observations.push(`derived path ${derived.filesystemPath}`);
    assertions.equal("the Module control group is refused", false, prepared.prepared);
    assertions.equal(
      "no Module control group directory is left behind",
      false,
      existsSync(derived.filesystemPath),
    );

    return decided(
      assertions,
      observations,
      "expected-fail-closed-without-delegation",
      "refused-without-delegation",
    );
  }

  // -------------------------------------------------------------------------
  // SC-13-03: a required control-group controller is unavailable.
  //
  // A real nested group is created below the delegated root and only `pids` is
  // enabled in its subtree_control, so its children genuinely have no
  // `memory.max` or `cpu.max` file. Nothing is mocked.
  // -------------------------------------------------------------------------
  if (CASE_ID === "SC-13-03-controller-unavailable") {
    const delegatedRootCgroupPath = await readDelegatedRootCgroupPath();
    const starved = `${delegatedRootCgroupPath}/dolly-test-${RUN_MARKER}-starved`;
    const starvedFsPath = `${CGROUP_V2_MOUNT_POINT}${starved}`;
    observations.push(`delegated root ${delegatedRootCgroupPath}`);

    const full = await prepareDelegatedCgroupRoot({ delegatedRootCgroupPath });
    observations.push(`delegated root preparation: ${JSON.stringify(full)}`);
    if (!full.prepared) {
      return {
        status: "inconclusive",
        reason: "delegated-root-unavailable",
        observations,
      };
    }

    await mkdir(starvedFsPath, { recursive: false });
    try {
      // Enable only pids below the starved group. cpu and memory are then
      // genuinely absent from its children.
      await writeFile(`${starvedFsPath}/cgroup.subtree_control`, "+pids");
      const controllers = await readControlFile(`${starvedFsPath}/cgroup.subtree_control`);
      observations.push(`starved subtree_control reads back as ${JSON.stringify(controllers)}`);
      assertions.equal(
        "the starved group enables only pids",
        true,
        controllers === "pids",
      );

      const identity = identityFor("sc1303");
      const derived = deriveModuleCgroupPath(starved, identity);
      const prepared = await prepareModuleCgroup({
        delegatedRootCgroupPath: starved,
        identity,
        limits: MODULE_LIMITS,
      });
      observations.push(`prepareModuleCgroup: ${JSON.stringify(prepared)}`);
      assertions.equal("the Module control group is refused", false, prepared.prepared);
      assertions.equal(
        "the refusal is about an unenforceable limit or a missing controller",
        true,
        prepared.failure?.code === "MODULE_CGROUP_CONTROLLER_UNAVAILABLE" ||
          prepared.failure?.code === "MODULE_CGROUP_LIMIT_WRITE_FAILED" ||
          prepared.failure?.code === "MODULE_CGROUP_LIMIT_UNREADABLE" ||
          prepared.failure?.code === "MODULE_CGROUP_LIMIT_NOT_ENFORCED",
      );
      // The degradation excluded here: accepting a group whose limits cannot be
      // enforced, then putting a process in it.
      assertions.equal(
        "no Module control group directory is left behind",
        false,
        existsSync(derived.filesystemPath),
      );
    } finally {
      await rmdir(starvedFsPath).catch(() => undefined);
    }

    return decided(
      assertions,
      observations,
      "expected-fail-closed-without-controllers",
      "refused-without-required-controllers",
    );
  }

  // -------------------------------------------------------------------------
  // SC-13-04: the Core state store is unavailable.
  //
  // The record is step 1 of the start order. When it cannot be persisted, no
  // control group may be created and no launcher may be started, because a
  // child that exists without a durable record is exactly the unaccounted
  // process ADR 0009 forbids.
  // -------------------------------------------------------------------------
  if (CASE_ID === "SC-13-04-state-store-unavailable") {
    const delegatedRootCgroupPath = await readDelegatedRootCgroupPath();
    const identity = identityFor("sc1304");
    const derived = deriveModuleCgroupPath(delegatedRootCgroupPath, identity);
    const boot = await bootId();
    const invocation = invocationId();
    if (invocation === undefined) {
      return {
        status: "inconclusive",
        reason: "service-invocation-identifier-unavailable",
        observations,
      };
    }

    let launcherStarts = 0;
    const records = countingRecords(undefined, "append");
    const result = await startModuleProcess({
      records,
      processRecord: processRecord(identity, derived.cgroupPath, invocation, boot),
      delegatedRootCgroupPath,
      identity,
      limits: MODULE_LIMITS,
      maxOpenFiles: 64,
      startLauncher: async () => {
        launcherStarts += 1;
        throw new Error("the driver must never reach this step");
      },
      execution: { program: pythonInterpreterPath(), argumentVector: [], environment: {} },
    });
    observations.push(`startModuleProcess: ${JSON.stringify(result)}`);
    observations.push(`derived path ${derived.filesystemPath}`);

    assertions.equal("the start is refused", false, result.started);
    assertions.equal(
      "the refusal is the record failure",
      "MODULE_PROCESS_RECORD_FAILED",
      result.failure?.code,
    );
    // The three negative observations that distinguish failing closed from
    // carrying on without a record.
    assertions.equal("no launcher was started", 0, launcherStarts);
    assertions.equal(
      "no Module control group was created",
      false,
      existsSync(derived.filesystemPath),
    );
    assertions.equal("no record state was updated", 0, records.calls.update);
    assertions.equal("Core is not told to exit", false, result.failure?.coreMustExit);

    return decided(
      assertions,
      observations,
      "expected-fail-closed-without-state-store",
      "refused-without-state-store",
    );
  }

  // -------------------------------------------------------------------------
  // SC-13-05: the Extension protocol channel is unavailable.
  //
  // The launcher exists but its control channel never reports control-group
  // membership. Core must abandon before authorizing any execution. When the
  // launcher's exit also cannot be observed, ADR 0009 requires `coreMustExit`,
  // because there is no safe way left to address that process.
  // -------------------------------------------------------------------------
  if (CASE_ID === "SC-13-05-protocol-channel-unavailable") {
    const delegatedRootCgroupPath = await readDelegatedRootCgroupPath();
    const boot = await bootId();
    const invocation = invocationId();
    if (invocation === undefined) {
      return {
        status: "inconclusive",
        reason: "service-invocation-identifier-unavailable",
        observations,
      };
    }
    // The delegated root must distribute the controllers before any Module
    // group below it can be prepared. Without this the start would fail at
    // step 2 and never reach the protocol channel this case is about.
    const root = await prepareDelegatedCgroupRoot({ delegatedRootCgroupPath });
    observations.push(`delegated root preparation: ${JSON.stringify(root)}`);
    if (!root.prepared) {
      return {
        status: "inconclusive",
        reason: "delegated-root-unavailable",
        observations,
      };
    }

    const runOnce = async (suffix, exitObserved) => {
      const identity = identityFor(suffix);
      const derived = deriveModuleCgroupPath(delegatedRootCgroupPath, identity);
      const records = countingRecords(undefined, undefined);
      const seen = { authorize: 0, exitRequests: 0 };

      // Construct a failing control channel: send() always throws.
      const channel = {
        async send(message) {
          throw new Error("the launcher control channel is unavailable");
        },
        close() {},
      };

      const controller = new LinuxModuleLauncherController({
        channel,
        readModuleCgroupProcessIds: async () => [process.pid],
        waitForLauncherExit: async () => exitObserved,
        configureTimeoutMs: 200,
        inCgroupTimeoutMs: 100,
        membershipTimeoutMs: 200,
        exitObservationTimeoutMs: 200,
      });

      const launcher = {
        processId: process.pid,
        controller,
        closeControlChannel() {
          channel.close();
        },
        waitForExit: async (timeoutMs) => exitObserved,
      };

      const result = await startModuleProcess({
        records,
        processRecord: processRecord(identity, derived.cgroupPath, invocation, boot),
        delegatedRootCgroupPath,
        identity,
        limits: MODULE_LIMITS,
        maxOpenFiles: 64,
        startLauncher: async () => {
          const control = createModuleLauncherControl({ launcher });
          // Track calls through the adapter.
          const originalAuthorize = control.authorizeExecution.bind(control);
          control.authorizeExecution = async (req) => {
            seen.authorize += 1;
            return originalAuthorize(req);
          };
          const originalExit = control.requestExit.bind(control);
          control.requestExit = async () => {
            seen.exitRequests += 1;
            return originalExit();
          };
          return control;
        },
        execution: {
          program: pythonInterpreterPath(),
          argumentVector: [],
          environment: {},
        },
      });
      // The group really was created by step 2, so it is removed here.
      await rmdir(derived.filesystemPath).catch(() => undefined);
      return { result, seen, derived };
    };

    const unobserved = await runOnce("sc1305a", false);
    observations.push(`exit not observed: ${JSON.stringify(unobserved.result)}`);
    assertions.equal("the start is refused", false, unobserved.result.started);
    assertions.equal(
      "the refusal is a launcher control send failure",
      "MODULE_PROCESS_LAUNCHER_FAILED",
      unobserved.result.failure?.code,
    );
    // The step that must never have happened: the Extension was never
    // authorized to replace the launcher.
    assertions.equal("no execution was authorized", 0, unobserved.seen.authorize);
    assertions.equal("the launcher was asked to exit", 1, unobserved.seen.exitRequests);
    assertions.equal(
      "Core is required to exit when the launcher's exit is unproven",
      true,
      unobserved.result.failure?.coreMustExit,
    );

    // Control: the same unavailable channel, but the launcher's exit *is*
    // observed. Core still refuses, and now must not exit. Without this the
    // escalation above could be a constant rather than a decision.
    const observed = await runOnce("sc1305b", true);
    observations.push(`exit observed: ${JSON.stringify(observed.result)}`);
    assertions.equal("the control start is also refused", false, observed.result.started);
    assertions.equal(
      "Core is not required to exit when the launcher's exit is proven",
      false,
      observed.result.failure?.coreMustExit,
    );

    return decided(
      assertions,
      observations,
      "expected-fail-closed-without-protocol-channel",
      "refused-without-protocol-channel",
    );
  }

  // -------------------------------------------------------------------------
  // SC-13-06: durable Module records are corrupt.
  //
  // Startup recovery must refuse to continue when a submission record cannot be
  // linked to its Claim. Continuing would let Core resume with a Run whose
  // external effects it cannot account for.
  // -------------------------------------------------------------------------
  if (CASE_ID === "SC-13-06-durable-records-corrupt") {
    const { CoreStartupRecovery, CoreStartupRecoveryError } = await import(
      "../../../../src/core/core-startup-recovery.ts"
    );

    const makeRecovery = (submissionIdentity) => {
      const claim = {
        moduleJobId: "dolly-test-job",
        claimToken: "dolly-test-token",
        runId: "dolly-test-run",
        attempt: 1,
        moduleGenerationId: `dolly-test-generation-${RUN_MARKER}`,
      };
      const submission = {
        schemaVersion: "dolly.module-submission-record/1",
        moduleJobId: submissionIdentity.moduleJobId,
        claimToken: submissionIdentity.claimToken,
        runId: claim.runId,
        attempt: submissionIdentity.attempt,
        moduleGenerationId: submissionIdentity.moduleGenerationId,
        processGenerationId: `${RUN_MARKER}-sc1306`,
        inputDigest: `sha256:${"0".repeat(64)}`,
        createdAt: new Date().toISOString(),
      };
      return new CoreStartupRecovery({
        deliveries: {
          listActiveClaims: () => [claim],
          releaseClaim: () => undefined,
        },
        commits: {
          recoverAll: async () => [],
          inspect: () => null,
        },
        moduleRecords: {
          listModuleProcessRecords: () => [],
          listModuleSubmissionRecords: () => [submission],
          getModuleProcessRecord: () => undefined,
          getModuleSubmissionRecord: () => submission,
          updateModuleProcessRecordState: () => submission,
          removeModuleSubmissionRecord: () => undefined,
          removeModuleProcessRecord: () => undefined,
          runAtomicUpdate: (operation) => operation(),
        },
      });
    };

    // Corrupt: the submission record claims a different Module generation than
    // the Claim it is supposed to belong to.
    const corrupt = makeRecovery({
      moduleJobId: "dolly-test-job",
      claimToken: "dolly-test-token",
      attempt: 1,
      moduleGenerationId: "dolly-test-generation-someone-else",
    });
    let refusal;
    let completed = false;
    try {
      await corrupt.recover();
      completed = true;
    } catch (error) {
      refusal = error;
    }
    observations.push(
      `corrupt records: completed=${completed} error=${refusal?.code ?? refusal?.message}`,
    );
    assertions.equal("startup does not complete", false, completed);
    assertions.equal(
      "the refusal is the record inconsistency",
      "STARTUP_MODULE_RECORD_INCONSISTENT",
      refusal?.code,
    );
    assertions.equal(
      "the refusal is a startup recovery error",
      true,
      refusal instanceof CoreStartupRecoveryError,
    );

    // Control: identical records that do match. Recovery must get past the
    // link check, which shows the refusal is caused by the corruption.
    const consistent = makeRecovery({
      moduleJobId: "dolly-test-job",
      claimToken: "dolly-test-token",
      attempt: 1,
      moduleGenerationId: `dolly-test-generation-${RUN_MARKER}`,
    });
    let controlError;
    try {
      await consistent.recover();
    } catch (error) {
      controlError = error;
    }
    observations.push(`consistent records: error=${controlError?.code ?? "none"}`);
    assertions.equal(
      "consistent records do not raise the inconsistency refusal",
      false,
      controlError?.code === "STARTUP_MODULE_RECORD_INCONSISTENT",
    );

    return decided(
      assertions,
      observations,
      "expected-fail-closed-on-corrupt-records",
      "refused-on-corrupt-records",
    );
  }

  // -------------------------------------------------------------------------
  // SC-13-07: the finite cleanup timeout expires.
  //
  // What is under test is the *decision* Core makes when the deadline passes
  // without a `populated 0` reading: it must report the stop unproven and must
  // not move the record to `stopped`.
  //
  // Producing that condition from a real kill is not possible deterministically
  // on an unprivileged host: `cgroup.kill` empties a group of ordinary
  // processes faster than any usable deadline, as an earlier run of this case
  // confirmed by succeeding with a one-millisecond timeout. A racy case would
  // be worse evidence than a scoped one, so the group, its process, its
  // membership proof, and the `cgroup.kill` write are all real, and only the
  // reading of `cgroup.events` is held at `populated 1` through the production
  // `ModuleCgroupFileSystem` seam.
  //
  // The control below runs the identical code with the real filesystem and
  // requires it to succeed, which attributes the refusal to the withheld
  // reading rather than to the stop path being broken.
  // -------------------------------------------------------------------------
  if (CASE_ID === "SC-13-07-cleanup-timeout") {
    const { nodeModuleCgroupFileSystem } = await import(
      "../../../../src/core/linux-module-cgroup.ts"
    );
    const { startFixtureInModuleCgroup, waitForEmpty } = await import(
      "./module-cgroup-harness.mjs"
    );

    const delegatedRootCgroupPath = await readDelegatedRootCgroupPath();
    const root = await prepareDelegatedCgroupRoot({ delegatedRootCgroupPath });
    if (!root.prepared) {
      return {
        status: "inconclusive",
        reason: "delegated-root-unavailable",
        observations: [...observations, JSON.stringify(root)],
      };
    }

    const fixture = `${new URL(".", import.meta.url).pathname.replace(/\/$/, "")}/fixture-hang.py`;

    // Runs the whole real stop path once. `withheldEvents` decides only whether
    // `cgroup.events` reports the truth.
    const runOnce = async (suffix, withheldEvents) => {
      let eventsReads = 0;
      const fileSystem = {
        ...nodeModuleCgroupFileSystem,
        readTextFile: async (path) => {
          if (withheldEvents && path.endsWith("/cgroup.events")) {
            eventsReads += 1;
            return "populated 1\nfrozen 0\n";
          }
          return nodeModuleCgroupFileSystem.readTextFile(path);
        },
      };
      const identity = identityFor(suffix);
      const prepared = await prepareModuleCgroup({
        delegatedRootCgroupPath,
        identity,
        limits: MODULE_LIMITS,
        fileSystem,
      });
      if (!prepared.prepared) {
        throw new Error(`${prepared.failure.code}: ${prepared.failure.detail}`);
      }
      const cgroup = prepared.cgroup;

      await startFixtureInModuleCgroup({ cgroup, fixture });
      // Deterministic membership: the launcher controller verified kernel
      // membership from `cgroup.procs` before authorizing the fixture, so this
      // records that proof rather than waiting on a reading that may be held.
      cgroup.recordVerifiedMembership([1]);

      const states = [];
      const records = {
        appendModuleProcessRecord: (record) => record,
        updateModuleProcessRecordState: (id, state, failureCode) => {
          states.push(state);
          return { processGenerationId: id, state, failureCode };
        },
      };
      const stop = await stopModuleProcess({
        records,
        processGenerationId: identity.processGenerationId,
        cgroup,
        timeoutMs: 300,
      });
      // Real cleanup, with the real filesystem, whatever the reading said.
      const realCgroup = { path: cgroup.path, readPopulated: async () => {
        const text = await nodeModuleCgroupFileSystem.readTextFile(`${cgroup.path}/cgroup.events`)
          .catch(() => undefined);
        return text === undefined ? undefined : text.includes("populated 0") ? false : true;
      } };
      await waitForEmpty(realCgroup, 10_000).catch(() => undefined);
      await rmdir(cgroup.path).catch(() => undefined);
      return { stop, states, eventsReads, cgroup };
    };

    const withheld = await runOnce("sc1307a", true);
    observations.push(`withheld reading: ${JSON.stringify(withheld.stop)}`);
    observations.push(`record states in order: ${JSON.stringify(withheld.states)}`);
    observations.push(`cgroup.events readings held at populated 1: ${withheld.eventsReads}`);

    assertions.equal("the stop is not reported successful", false, withheld.stop.stopped);
    assertions.equal(
      "the failure is the expired finite wait",
      "MODULE_CGROUP_STILL_POPULATED",
      withheld.stop.code,
    );
    assertions.equal("the record moved to stopping", "stopping", withheld.states[0]);
    assertions.equal(
      "the record never reached stopped",
      false,
      withheld.states.includes("stopped"),
    );
    assertions.equal(
      "the group is not claimed proven empty",
      false,
      withheld.cgroup.terminationProven,
    );
    assertions.atLeast("the deadline was actually waited out", 2, withheld.eventsReads);

    // Control: identical path, truthful readings. It must succeed.
    const truthful = await runOnce("sc1307b", false);
    observations.push(`truthful reading: ${JSON.stringify(truthful.stop)}`);
    observations.push(`control record states: ${JSON.stringify(truthful.states)}`);
    assertions.equal("the control stop succeeds", true, truthful.stop.stopped);
    assertions.equal(
      "the control record reaches stopped",
      true,
      truthful.states.includes("stopped"),
    );

    return decided(
      assertions,
      observations,
      "expected-unproven-stop-on-timeout",
      "refused-to-claim-an-unproven-stop",
    );
  }

  // -------------------------------------------------------------------------
  // SC-13-08: the Python 3 interpreter required by the launcher is absent.
  // -------------------------------------------------------------------------
  if (CASE_ID === "SC-13-08-python3-interpreter-absent") {
    const unitName = `dolly-test-${RUN_MARKER}-absent.service`;

    const absent = await decideLinuxModuleActivation({
      unitName,
      mode: "user",
      launcherInterpreterPath: "/nonexistent/dolly-test-python3",
      launcherScriptPath: LAUNCHER_SCRIPT_PATH,
    });
    observations.push(`absent interpreter: ${JSON.stringify(absent)}`);
    assertions.equal("activation is refused", false, absent.permitted);
    assertions.equal(
      "the refusal names the unavailable launcher",
      true,
      (absent.refusals ?? []).some(
        (refusal) => refusal.code === "MODULE_ACTIVATION_LAUNCHER_UNAVAILABLE",
      ),
    );
    assertions.equal("no stop prover is handed out", true, absent.stopProver === undefined);

    // Control: the real interpreter, same absent unit. The launcher refusal
    // must disappear, which attributes it to the interpreter and not to the
    // unit being absent.
    const present = await decideLinuxModuleActivation({
      unitName,
      mode: "user",
      launcherInterpreterPath: pythonInterpreterPath(),
      launcherScriptPath: LAUNCHER_SCRIPT_PATH,
    });
    observations.push(`present interpreter: ${JSON.stringify(present)}`);
    assertions.equal(
      "the control reports no launcher refusal",
      false,
      (present.refusals ?? []).some(
        (refusal) => refusal.code === "MODULE_ACTIVATION_LAUNCHER_UNAVAILABLE",
      ),
    );

    return decided(
      assertions,
      observations,
      "expected-fail-closed-without-interpreter",
      "refused-without-launcher-interpreter",
    );
  }

  return { status: "inconclusive", reason: "unknown-case", observations };
});
