/**
 * Case driver for the `identifier-reuse` family (SC-06-01 and SC-06-02).
 *
 * Architecture Decision Record 0009 required failure test 10 asks for rejected
 * reuse of a process-generation identifier and of a Module control-group path.
 * The two refusals live in different layers, so the two cases exercise
 * different production code:
 *
 *   SC-06-01 the durable Core-state store, which refuses a second Module
 *            process record for an identifier it already holds; and
 *   SC-06-02 the control-group preparation, which refuses a derived path that
 *            already exists on the delegated root.
 *
 * Both cases assert the exact production failure code, not merely that
 * something went wrong.
 */
import { readFile, rmdir } from "node:fs/promises";
import {
  deriveModuleCgroupPath,
  prepareDelegatedCgroupRoot,
  prepareModuleCgroup,
} from "../../../../src/core/linux-module-cgroup.ts";
import { isDerivedModuleCgroupPath } from "../../../../src/core/linux-identifier-formats.ts";
import { FileCoreStateStore } from "../../../../src/core/file-core-state-store.ts";
import {
  Assertions,
  readControlFile,
  readDelegatedRootCgroupPath,
  runDriver,
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

function identityFor(processGenerationId, instanceSuffix = "a") {
  return {
    instanceId: `dolly-test-instance-${RUN_MARKER}-${instanceSuffix}`,
    moduleId: `dolly-test-module-${RUN_MARKER}`,
    processGenerationId,
  };
}

function failureCodeOf(error) {
  return error?.code ?? String(error);
}

await runDriver(async () => {
  const observations = [];
  const assertions = new Assertions();
  const delegatedRootCgroupPath = await readDelegatedRootCgroupPath();
  observations.push(`case ${CASE_ID}`);
  observations.push(`delegated root ${delegatedRootCgroupPath}`);

  if (CASE_ID === "SC-06-01-process-generation-identifier-reuse") {
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const serviceInvocationId = (process.env.INVOCATION_ID ?? "").trim();
    observations.push(`boot identifier ${bootId}`);
    observations.push(`service invocation identifier ${serviceInvocationId}`);
    if (!/^[0-9a-f]{32}$/.test(serviceInvocationId)) {
      return {
        status: "inconclusive",
        reason: "service-invocation-identifier-unavailable",
        observations: [
          ...observations,
          "the transient service did not report an InvocationID, so no valid Module process record could be built",
        ],
      };
    }

    const processGenerationId = `${RUN_MARKER}-sc0601`;
    const identity = identityFor(processGenerationId);
    const derived = deriveModuleCgroupPath(delegatedRootCgroupPath, identity);
    observations.push(`derived Module control-group path ${derived.filesystemPath}`);

    const now = new Date().toISOString();
    const record = {
      schemaVersion: "dolly.module-process-record/1",
      instanceId: identity.instanceId,
      moduleId: identity.moduleId,
      moduleGenerationId: `dolly-test-generation-${RUN_MARKER}`,
      processGenerationId,
      packageDigest: `sha256:${"0".repeat(64)}`,
      configurationReference: {
        configId: `dolly-test-config-${RUN_MARKER}`,
        revision: `sha256:${"1".repeat(64)}`,
        configVersion: 1,
      },
      declaredExternalEffects: "core-capabilities-only",
      serviceInvocationId,
      bootId,
      moduleCgroupPath: derived.filesystemPath,
      state: "starting",
      createdAt: now,
      updatedAt: now,
    };

    let counter = 0;
    const store = new FileCoreStateStore({
      path: `${CASE_DIR}/core-state.json`,
      maxFailedAttempts: 3,
      nextBlockId: () => `dolly-test-block-${(counter += 1)}`,
      nextDeliveryId: () => `dolly-test-delivery-${(counter += 1)}`,
      now: () => new Date().toISOString(),
    });

    store.appendModuleProcessRecord(record);
    const stored = store.getModuleProcessRecord(processGenerationId);
    observations.push(`first record stored: ${stored !== undefined}`);
    assertions.equal("the first process generation is accepted", true, stored !== undefined);

    // A second attempt at the same identifier, deliberately with a different
    // Module generation and timestamp, so only the identifier is the same.
    const later = new Date(Date.now() + 1000).toISOString();
    let reuseCode;
    try {
      store.appendModuleProcessRecord({
        ...record,
        moduleGenerationId: `dolly-test-generation-${RUN_MARKER}-second`,
        createdAt: later,
        updatedAt: later,
      });
      reuseCode = "accepted";
    } catch (error) {
      reuseCode = failureCodeOf(error);
    }
    observations.push(`reusing the process generation identifier: ${reuseCode}`);
    assertions.equal(
      "reusing a process-generation identifier",
      "MODULE_PROCESS_RECORD_CONFLICT",
      reuseCode,
    );

    // The identifier also cannot be smuggled in through the control-group
    // path: a path derived from a different generation is refused outright.
    const otherGeneration = `${RUN_MARKER}-sc0601other`;
    const otherPath = deriveModuleCgroupPath(
      delegatedRootCgroupPath,
      identityFor(otherGeneration),
    ).filesystemPath;
    let mismatchCode;
    try {
      store.appendModuleProcessRecord({
        ...record,
        processGenerationId: otherGeneration,
        moduleCgroupPath: derived.filesystemPath,
        createdAt: later,
        updatedAt: later,
      });
      mismatchCode = "accepted";
    } catch (error) {
      mismatchCode = failureCodeOf(error);
    }
    observations.push(
      `a record whose control-group path belongs to another generation: ${mismatchCode}`,
    );
    assertions.equal(
      "a control-group path from another process generation",
      "MODULE_PROCESS_RECORD_INVALID",
      mismatchCode,
    );
    assertions.equal(
      "the other generation derives its own distinct path",
      false,
      otherPath === derived.filesystemPath,
    );
    assertions.equal(
      "the stored path is not a valid path for the other generation",
      false,
      isDerivedModuleCgroupPath(derived.filesystemPath, otherGeneration),
    );

    observations.push(`records held after the refusals: ${store.listModuleProcessRecords().length}`);
    assertions.equal(
      "the refusals left exactly one record",
      1,
      store.listModuleProcessRecords().length,
    );

    return decide(assertions, observations, "process-generation-identifier-reuse-refused");
  }

  if (CASE_ID === "SC-06-02-module-cgroup-path-reuse") {
    const root = await prepareDelegatedCgroupRoot({ delegatedRootCgroupPath });
    if (!root.prepared) {
      return {
        status: "inconclusive",
        reason: "delegated-root-not-prepared",
        observations: [...observations, `${root.failure.code}: ${root.failure.detail}`],
      };
    }
    const identity = identityFor(`${RUN_MARKER}-sc0602`);
    const first = await prepareModuleCgroup({
      delegatedRootCgroupPath,
      identity,
      limits: MODULE_LIMITS,
    });
    if (!first.prepared) {
      return {
        status: "inconclusive",
        reason: "module-control-group-not-prepared",
        observations: [...observations, `${first.failure.code}: ${first.failure.detail}`],
      };
    }
    const path = first.cgroup.path;
    observations.push(`prepared ${path}`);
    observations.push(`limits read back ${JSON.stringify(first.cgroup.limits)}`);

    const second = await prepareModuleCgroup({
      delegatedRootCgroupPath,
      identity,
      limits: MODULE_LIMITS,
    });
    const secondCode = second.prepared ? "prepared" : second.failure.code;
    observations.push(`reusing the Module control-group path: ${secondCode}`);
    if (!second.prepared) observations.push(`detail: ${second.failure.detail}`);
    assertions.equal("reusing a Module control-group path", "MODULE_CGROUP_PATH_IN_USE", secondCode);

    // The refusal must not have removed or weakened the group that already
    // exists: a cleanup that ran on the refused attempt would destroy a live
    // Module's limits.
    const survivingLimits = {
      "memory.max": await readControlFile(`${path}/memory.max`),
      "memory.oom.group": await readControlFile(`${path}/memory.oom.group`),
      "pids.max": await readControlFile(`${path}/pids.max`),
      "cpu.max": await readControlFile(`${path}/cpu.max`),
    };
    observations.push(`limits after the refusal ${JSON.stringify(survivingLimits)}`);
    assertions.equal("memory.max survived the refusal", "67108864", survivingLimits["memory.max"]);
    assertions.equal("memory.oom.group survived the refusal", "1", survivingLimits["memory.oom.group"]);
    assertions.equal("pids.max survived the refusal", "16", survivingLimits["pids.max"]);
    assertions.equal("cpu.max survived the refusal", "50000 100000", survivingLimits["cpu.max"]);

    // Two different Core identities never derive the same path, so a reused
    // generation identifier cannot address another Module's group.
    const otherInstance = deriveModuleCgroupPath(
      delegatedRootCgroupPath,
      identityFor(identity.processGenerationId, "b"),
    );
    observations.push(`the same generation under another instance derives ${otherInstance.filesystemPath}`);
    assertions.equal(
      "another Core identity derives a different directory",
      false,
      otherInstance.filesystemPath === path,
    );
    assertions.equal(
      "both derived names still carry the process generation literally",
      true,
      isDerivedModuleCgroupPath(otherInstance.filesystemPath, identity.processGenerationId) &&
        isDerivedModuleCgroupPath(path, identity.processGenerationId),
    );

    // The group never held a process, which is the one state in which removing
    // it destroys no evidence; `prepareModuleCgroup` cleans up the same way.
    let removed = false;
    try {
      await rmdir(path);
      removed = true;
    } catch (error) {
      observations.push(`removal failed: ${String(error)}`);
    }
    observations.push(`removed the never-populated group: ${removed}`);
    assertions.equal("the case left no control group behind", true, removed);

    return decide(assertions, observations, "module-control-group-path-reuse-refused");
  }

  return {
    status: "inconclusive",
    reason: "unknown-case",
    observations: [...observations, `no driver branch for ${CASE_ID}`],
  };
});

function decide(assertions, observations, passedReason) {
  const lines = [...observations, "", "assertions:", ...assertions.lines()];
  if (assertions.allHold) {
    return { status: "passed", reason: passedReason, observations: lines };
  }
  return { status: "failed", reason: "expected-refusal-not-seen", observations: lines };
}
