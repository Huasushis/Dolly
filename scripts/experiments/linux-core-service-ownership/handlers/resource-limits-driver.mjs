/**
 * Case driver for the `resource-limits` family (LM-01 to LM-07).
 *
 * It runs as the main process of one transient user service with `Delegate=yes`
 * and `DelegateSubgroup=core`, prepares one real Module control group through
 * `src/core/linux-module-cgroup.ts`, and starts one real Module process through
 * the reviewed child launcher in `src/adapters/linux-module-launcher/`. Every
 * limit is then exercised by a real process rather than by writing a control
 * file and reading it back again.
 *
 * Every case asserts exact observed values: the exact control-file read-back,
 * the exact kernel event counter, the exact refusal errno, or the exact
 * termination evidence string. "It failed somehow" is never enough to pass.
 */
import { writeFile } from "node:fs/promises";
import { FramedJsonChannel } from "../../../../src/core/framed-json-channel.ts";
import { canonicalJsonByteLength } from "../../../../src/core/canonical-json.ts";
import { ExtensionCapabilityAuthority } from "../../../../src/core/extension-capability.ts";
import {
  Assertions,
  createJsonLineReader,
  fixturePath,
  prepareModuleCgroupForCase,
  processExists,
  readControlFile,
  readDelegatedRootCgroupPath,
  readKeyedControlFile,
  runDriver,
  sleep,
  startFixtureInModuleCgroup,
  waitForEmpty,
} from "./module-cgroup-harness.mjs";

const CASE_ID = process.argv[2];
const RUN_MARKER = process.argv[3] ?? "unmarked";

/**
 * The Core default `maxFrameBytes` in `src/core/extension-process-host.ts`.
 * `fixture-protocol-frame.py` carries the same constant and the case asserts
 * the received frame was exactly this many bytes, so a drift between the two
 * files fails the case instead of passing quietly.
 */
const CORE_DEFAULT_MAX_FRAME_BYTES = 256 * 1024;

function identityFor(suffix) {
  return {
    instanceId: `dolly-test-instance-${RUN_MARKER}`,
    moduleId: `dolly-test-module-${RUN_MARKER}`,
    processGenerationId: `${RUN_MARKER}-${suffix}`,
  };
}

const BASE_LIMITS = {
  memoryMaxBytes: 67_108_864,
  maxProcesses: 32,
  cpuQuotaMicros: 50_000,
  cpuPeriodMicros: 100_000,
};

/** Terminates and removes the group through the production implementation. */
async function terminateAndRemove(cgroup, observations, assertions) {
  const termination = await cgroup.terminate({ timeoutMs: 10_000 });
  observations.push(`terminate ${JSON.stringify(termination)}`);
  assertions.equal("whole-group termination evidence", "populated-zero", termination.evidence);
  const removal = await cgroup.remove();
  observations.push(`remove ${JSON.stringify(removal)}`);
  assertions.equal("Module control group removed", true, removal.removed);
}

await runDriver(async () => {
  const observations = [];
  const assertions = new Assertions();
  observations.push(`case ${CASE_ID}`);
  observations.push(`delegated root ${await readDelegatedRootCgroupPath()}`);

  switch (CASE_ID) {
    // -----------------------------------------------------------------------
    case "LM-01-memory": {
      const limits = { ...BASE_LIMITS, memoryMaxBytes: 8_388_608, maxProcesses: 16 };
      const { cgroup } = await prepareModuleCgroupForCase({
        identity: identityFor("lm01"),
        limits,
      });
      observations.push(`prepared ${cgroup.path}`);
      observations.push(`limits read back ${JSON.stringify(cgroup.limits)}`);
      assertions.equal("memory.max read-back", "8388608", cgroup.limits["memory.max"]);
      assertions.equal("memory.oom.group read-back", "1", cgroup.limits["memory.oom.group"]);

      // `prepareModuleCgroup` writes no `memory.swap.max`. On a host with swap
      // the memory limit would be satisfied by swapping instead of by ending
      // the group, so the case disables swap here and records that the
      // production code did not.
      const swapBefore = await readControlFile(`${cgroup.path}/memory.swap.max`);
      observations.push(
        `memory.swap.max after prepareModuleCgroup: ${swapBefore} (the production code does not write this file)`,
      );
      await writeFile(`${cgroup.path}/memory.swap.max`, "0");
      observations.push(
        `memory.swap.max set by this case: ${await readControlFile(`${cgroup.path}/memory.swap.max`)}`,
      );

      const { started, outcome } = await startFixtureInModuleCgroup({
        cgroup,
        fixture: fixturePath("fixture-memory.py"),
      });
      observations.push(`launcher outcome ${JSON.stringify(outcome)}`);
      assertions.equal("launcher authorized to execute", "executing", outcome.outcome);
      cgroup.recordObservedProcessIds(outcome.verifiedProcessIds);

      const reader = createJsonLineReader(started.child.stdout);
      const report = await reader.next(15_000);
      observations.push(`fixture report ${JSON.stringify(report)}`);
      assertions.equal(
        "the Module process is the launcher process, not a later child",
        started.processId,
        report.allocating_pid,
      );

      const emptied = await waitForEmpty(cgroup, 30_000);
      observations.push(`group emptied ${JSON.stringify(emptied)}`);
      assertions.equal("control group reported populated 0", true, emptied.empty);

      const events = await readKeyedControlFile(`${cgroup.path}/memory.events`);
      observations.push(`memory.events ${JSON.stringify(events)}`);
      assertions.equal("memory.events oom_group_kill", 1, events?.oom_group_kill);
      assertions.atLeast("memory.events oom_kill", 1, events?.oom_kill);
      assertions.atLeast("memory.events max", 1, events?.max);
      assertions.equal(
        "the innocent process in the same group was killed with it",
        false,
        processExists(report.bystander_pid),
      );

      await terminateAndRemove(cgroup, observations, assertions);
      return decide(assertions, observations, "memory-limit-ended-the-whole-group");
    }

    // -----------------------------------------------------------------------
    case "LM-02-process-count": {
      const limits = { ...BASE_LIMITS, maxProcesses: 10 };
      const { cgroup } = await prepareModuleCgroupForCase({
        identity: identityFor("lm02"),
        limits,
      });
      observations.push(`prepared ${cgroup.path}`);
      observations.push(`limits read back ${JSON.stringify(cgroup.limits)}`);
      assertions.equal("pids.max read-back", "10", cgroup.limits["pids.max"]);

      const { started, outcome } = await startFixtureInModuleCgroup({
        cgroup,
        fixture: fixturePath("fixture-pids.py"),
      });
      assertions.equal("launcher authorized to execute", "executing", outcome.outcome);
      cgroup.recordObservedProcessIds(outcome.verifiedProcessIds);

      const reader = createJsonLineReader(started.child.stdout);
      const report = await reader.next(20_000);
      observations.push(`fixture report ${JSON.stringify(report)}`);

      // One Module process plus nine children is exactly the ten the limit
      // allows, and the tenth fork must be refused with EAGAIN.
      assertions.equal("forks accepted before the refusal", 9, report.forks_succeeded);
      assertions.equal("fork refusal errno (EAGAIN)", 11, report.failure_errno);
      assertions.equal("pids.current at the refusal", "10", report.pids_current_at_failure);
      assertions.equal("pids.max seen by the Module process", "10", report.pids_max);

      const events = await readKeyedControlFile(`${cgroup.path}/pids.events`);
      observations.push(`pids.events ${JSON.stringify(events)}`);
      assertions.atLeast("pids.events max", 1, events?.max);

      await terminateAndRemove(cgroup, observations, assertions);
      return decide(assertions, observations, "process-count-limit-refused-a-real-fork");
    }

    // -----------------------------------------------------------------------
    case "LM-03-processor-rate": {
      const limits = { ...BASE_LIMITS, cpuQuotaMicros: 20_000, cpuPeriodMicros: 100_000 };
      const { cgroup } = await prepareModuleCgroupForCase({
        identity: identityFor("lm03"),
        limits,
      });
      observations.push(`prepared ${cgroup.path}`);
      observations.push(`limits read back ${JSON.stringify(cgroup.limits)}`);
      assertions.equal("cpu.max read-back", "20000 100000", cgroup.limits["cpu.max"]);

      const { started, outcome } = await startFixtureInModuleCgroup({
        cgroup,
        fixture: fixturePath("fixture-cpu.py"),
      });
      assertions.equal("launcher authorized to execute", "executing", outcome.outcome);
      cgroup.recordObservedProcessIds(outcome.verifiedProcessIds);

      const reader = createJsonLineReader(started.child.stdout);
      const start = await reader.next(15_000);
      observations.push(`fixture start ${JSON.stringify(start)}`);
      const before = await readKeyedControlFile(`${cgroup.path}/cpu.stat`);
      const finish = await reader.next(30_000);
      const after = await readKeyedControlFile(`${cgroup.path}/cpu.stat`);
      observations.push(`fixture finish ${JSON.stringify(finish)}`);
      observations.push(`cpu.stat before ${JSON.stringify(before)}`);
      observations.push(`cpu.stat after ${JSON.stringify(after)}`);

      const usedMicros = (after?.usage_usec ?? 0) - (before?.usage_usec ?? 0);
      const throttledMicros = (after?.throttled_usec ?? 0) - (before?.throttled_usec ?? 0);
      const throttledPeriods = (after?.nr_throttled ?? 0) - (before?.nr_throttled ?? 0);
      const elapsedMicros = finish.elapsed_seconds * 1_000_000;
      const share = usedMicros / elapsedMicros;
      observations.push(
        `busy window ${elapsedMicros.toFixed(0)} us, processor time ${usedMicros} us, share ${share.toFixed(3)}, throttled ${throttledMicros} us in ${throttledPeriods} period(s)`,
      );

      assertions.atLeast("processor time actually used", 1, usedMicros);
      assertions.atLeast("cpu.stat nr_throttled during the busy window", 1, throttledPeriods);
      assertions.atLeast("cpu.stat throttled_usec during the busy window", 1, throttledMicros);
      // The quota is 20000 us of every 100000 us period, that is 0.20. The
      // bound allows accounting slack but still fails an unenforced limit,
      // which would sit near 1.00 on this host.
      assertions.atMost("processor share of one processor", 0.3, share);

      await terminateAndRemove(cgroup, observations, assertions);
      return decide(assertions, observations, "processor-rate-limit-throttled-a-real-loop");
    }

    // -----------------------------------------------------------------------
    case "LM-04-open-files": {
      const { cgroup } = await prepareModuleCgroupForCase({
        identity: identityFor("lm04"),
        limits: BASE_LIMITS,
      });
      observations.push(`prepared ${cgroup.path}`);

      const { started, outcome } = await startFixtureInModuleCgroup({
        cgroup,
        fixture: fixturePath("fixture-open-files.py"),
        maxOpenFiles: 64,
        // One extra inherited descriptor, so the case can also show the
        // launcher closed everything it must not keep.
        additionalInheritedStdio: ["pipe"],
      });
      assertions.equal("launcher authorized to execute", "executing", outcome.outcome);
      cgroup.recordObservedProcessIds(outcome.verifiedProcessIds);

      const reader = createJsonLineReader(started.child.stdout);
      const report = await reader.next(20_000);
      observations.push(`fixture report ${JSON.stringify(report)}`);

      assertions.equal("RLIMIT_NOFILE seen by the executed program", [64, 64], report.getrlimit_nofile);
      assertions.equal("/proc/self/limits soft open-file limit", "64", report.proc_self_limits?.soft);
      assertions.equal("/proc/self/limits hard open-file limit", "64", report.proc_self_limits?.hard);
      assertions.equal("highest descriptor the program could open", 63, report.highest_descriptor);
      assertions.equal("refusal errno past the limit (EMFILE)", 24, report.failure_errno);
      assertions.equal("launcher control descriptor 3 after exec", false, report.control_descriptor_3?.open);
      assertions.equal("descriptor 3 refusal errno (EBADF)", 9, report.control_descriptor_3?.errno);
      assertions.equal("extra inherited descriptor 4 after exec", false, report.extra_inherited_descriptor_4?.open);
      assertions.equal("descriptor 4 refusal errno (EBADF)", 9, report.extra_inherited_descriptor_4?.errno);

      await terminateAndRemove(cgroup, observations, assertions);
      return decide(assertions, observations, "open-file-limit-applied-before-exec");
    }

    // -----------------------------------------------------------------------
    case "LM-05-protocol-frame": {
      const { cgroup } = await prepareModuleCgroupForCase({
        identity: identityFor("lm05"),
        limits: BASE_LIMITS,
      });
      observations.push(`prepared ${cgroup.path}`);

      const { started, outcome } = await startFixtureInModuleCgroup({
        cgroup,
        fixture: fixturePath("fixture-protocol-frame.py"),
        protocolStdio: ["pipe", "pipe", "pipe"],
      });
      assertions.equal("launcher authorized to execute", "executing", outcome.outcome);
      cgroup.recordObservedProcessIds(outcome.verifiedProcessIds);

      const received = [];
      let firstError;
      let resolveError;
      const errorSeen = new Promise((resolve) => {
        resolveError = resolve;
      });
      const channel = new FramedJsonChannel(started.child.stdout, started.child.stdin, {
        maxFrameBytes: CORE_DEFAULT_MAX_FRAME_BYTES,
        onMessage: (message) => received.push(message),
        onError: (error) => {
          firstError ??= error;
          resolveError();
        },
        onEnd: () => resolveError(),
      });

      // Outbound first: `send` rejects without failing the channel, so the
      // inbound observations below are unaffected.
      let outboundCode;
      try {
        await channel.send({ pad: "b".repeat(CORE_DEFAULT_MAX_FRAME_BYTES) });
        outboundCode = "accepted";
      } catch (error) {
        outboundCode = error?.code ?? String(error);
      }
      observations.push(`outbound oversized frame: ${outboundCode}`);
      assertions.equal("outbound frame over the limit", "FRAME_LENGTH_INVALID", outboundCode);

      await Promise.race([errorSeen, sleep(20_000)]);
      const atLimit = received[0];
      const atLimitBytes = atLimit === undefined ? 0 : Buffer.byteLength(JSON.stringify(atLimit), "utf8");
      observations.push(
        `inbound frames accepted: ${received.length}; first frame ${atLimitBytes} byte(s), sentinel ${JSON.stringify(atLimit?.sentinel)}`,
      );
      observations.push(`inbound refusal ${JSON.stringify({ code: firstError?.code, message: firstError?.message })}`);

      assertions.equal("frames accepted before the refusal", 1, received.length);
      assertions.equal("the accepted frame was exactly at the limit", CORE_DEFAULT_MAX_FRAME_BYTES, atLimitBytes);
      assertions.equal("the accepted frame carried the fixture sentinel", "dolly-test-frame-boundary", atLimit?.sentinel);
      assertions.equal("inbound frame one byte over the limit", "FRAME_LENGTH_INVALID", firstError?.code);

      channel.close();
      await terminateAndRemove(cgroup, observations, assertions);
      return decide(assertions, observations, "protocol-frame-limit-refused-an-oversized-frame");
    }

    // -----------------------------------------------------------------------
    case "LM-06-result-size": {
      // The result-size limit is enforced inside Core, by the capability
      // authority, before a result becomes observable. It needs no Module
      // process, so this case records the control-group context and then
      // exercises the production authority directly.
      observations.push(
        "the Core-enforced result-size limit lives in src/core/extension-capability.ts; no Module process is needed to reach it",
      );
      observations.push(`driver control group ${(await readControlFile("/proc/self/cgroup")) ?? "unreadable"}`);

      const authority = new ExtensionCapabilityAuthority({ now: () => new Date().toISOString() });
      const session = authority.openSession({
        extensionId: "dolly-test-extension",
        instanceId: `dolly-test-instance-${RUN_MARKER}`,
        processGenerationId: `${RUN_MARKER}-lm06`,
        sessionId: `${RUN_MARKER}-session`,
        moduleId: "dolly-test-module",
        moduleGenerationId: "dolly-test-generation",
      });

      const maxResultBytes = 1024;
      // A result of an exact byte length, built by measuring the production
      // canonical encoder rather than by guessing.
      const sized = (bytes) => {
        const skeleton = { pad: "" };
        const overhead = canonicalJsonByteLength(skeleton);
        return { pad: "a".repeat(bytes - overhead) };
      };
      const atLimit = sized(maxResultBytes);
      const overLimit = sized(maxResultBytes + 1);
      observations.push(
        `result byte lengths: at-limit ${canonicalJsonByteLength(atLimit)}, over-limit ${canonicalJsonByteLength(overLimit)}`,
      );
      assertions.equal("the at-limit result is exactly at the limit", maxResultBytes, canonicalJsonByteLength(atLimit));
      assertions.equal("the over-limit result is one byte over", maxResultBytes + 1, canonicalJsonByteLength(overLimit));

      const grant = {
        capabilityType: "dolly.test-result-size",
        capabilityVersion: "1",
        operations: ["produce"],
        resourceScope: { scope: "test" },
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        maxInvocations: 8,
        maxConcurrentInvocations: 1,
        maxArgumentBytes: 4096,
        maxResultBytes,
      };
      let produced = atLimit;
      const handle = session.issue(grant, () => produced);

      const accepted = await session.invoke({ handle, operation: "produce", arguments: { n: 1 } });
      observations.push(`at-limit result accepted, ${canonicalJsonByteLength(accepted)} byte(s)`);
      assertions.equal("a result exactly at the limit is returned", maxResultBytes, canonicalJsonByteLength(accepted));

      produced = overLimit;
      let refusalCode;
      try {
        await session.invoke({ handle, operation: "produce", arguments: { n: 2 } });
        refusalCode = "accepted";
      } catch (error) {
        refusalCode = error?.code ?? String(error);
      }
      observations.push(`over-limit result: ${refusalCode}`);
      assertions.equal("a result one byte over the limit", "CAPABILITY_QUOTA_EXCEEDED", refusalCode);

      let argumentRefusalCode;
      try {
        produced = atLimit;
        await session.invoke({
          handle,
          operation: "produce",
          arguments: { pad: "a".repeat(4096) },
        });
        argumentRefusalCode = "accepted";
      } catch (error) {
        argumentRefusalCode = error?.code ?? String(error);
      }
      observations.push(`over-limit argument: ${argumentRefusalCode}`);
      assertions.equal("an argument over the limit", "CAPABILITY_QUOTA_EXCEEDED", argumentRefusalCode);

      await session.close();
      return decide(assertions, observations, "result-size-limit-refused-an-oversized-result");
    }

    // -----------------------------------------------------------------------
    case "LM-07-elapsed-time": {
      const { cgroup } = await prepareModuleCgroupForCase({
        identity: identityFor("lm07"),
        limits: { ...BASE_LIMITS, maxProcesses: 16 },
      });
      observations.push(`prepared ${cgroup.path}`);

      const deadlineMs = 2_000;
      const { started, outcome } = await startFixtureInModuleCgroup({
        cgroup,
        fixture: fixturePath("fixture-hang.py"),
      });
      assertions.equal("launcher authorized to execute", "executing", outcome.outcome);
      cgroup.recordObservedProcessIds(outcome.verifiedProcessIds);

      const reader = createJsonLineReader(started.child.stdout);
      const report = await reader.next(15_000);
      observations.push(`fixture report ${JSON.stringify(report)}`);
      assertions.equal(
        "the Module process is the launcher process, not a later child",
        started.processId,
        report.module_pid,
      );

      const startedAt = Date.now();
      await sleep(deadlineMs);
      const elapsed = Date.now() - startedAt;
      // The fixture ignores SIGTERM and never ends by itself, so a case that
      // relied on a timer or on a direct-child exit would still be waiting.
      const moduleAliveAtDeadline = processExists(report.module_pid);
      const descendantAliveAtDeadline = processExists(report.descendant_pid);
      observations.push(
        `at the ${elapsed} ms deadline: Module process alive ${moduleAliveAtDeadline}, descendant alive ${descendantAliveAtDeadline}, direct child exit ${JSON.stringify(started.exit)}`,
      );
      assertions.equal("the Module process outlived the deadline", true, moduleAliveAtDeadline);
      assertions.equal("its descendant outlived the deadline", true, descendantAliveAtDeadline);
      assertions.equal("no direct-child exit was available as evidence", undefined, started.exit);

      const termination = await cgroup.terminate({ timeoutMs: 10_000 });
      observations.push(`terminate ${JSON.stringify(termination)}`);
      assertions.equal("whole-group termination succeeded", true, termination.terminated);
      assertions.equal("whole-group termination evidence", "populated-zero", termination.evidence);
      assertions.equal("the Module process is gone", false, processExists(report.module_pid));
      assertions.equal("its descendant is gone", false, processExists(report.descendant_pid));

      const removal = await cgroup.remove();
      observations.push(`remove ${JSON.stringify(removal)}`);
      assertions.equal("Module control group removed", true, removal.removed);
      return decide(assertions, observations, "deadline-ended-the-whole-control-group");
    }

    default:
      return {
        status: "inconclusive",
        reason: "unknown-case",
        observations: [`no driver branch for ${CASE_ID}`],
      };
  }
});

function decide(assertions, observations, passedReason) {
  const lines = [...observations, "", "assertions:", ...assertions.lines()];
  if (assertions.allHold) {
    return { status: "passed", reason: passedReason, observations: lines };
  }
  return {
    status: "failed",
    reason: "expected-observation-not-seen",
    observations: lines,
  };
}
