/**
 * Kernel-level scenarios for the launcher-to-attached-process adapter.
 *
 * These are the two claims that cannot be established anywhere else:
 *
 * 1. A descendant that left the launcher's process group stays inside the
 *    Module control group, and `cgroup.kill` terminates it. This is why
 *    Architecture Decision Record (ADR) 0009
 *    requires whole-group termination, and why Required failure test 13 puts
 *    that obligation on the adapter rather than on `ExtensionProcessHost`. An
 *    in-memory control-group stand-in cannot show it, because simulating the
 *    signal's reach would assume the very thing being proven.
 * 2. After the launcher replaces its process image, descriptors 0 and 1 still
 *    carry the Extension process protocol, so a host attached over them
 *    completes the handshake and one Run against the real Extension.
 *
 * The platform-independent adapter rules - both termination steps performing a
 * whole-group operation, an exit reported only from `populated 0`, and a direct
 * child exit never counting as proof - are covered on every platform by
 * `tests/conformance/core/linux-module-attached-process.test.ts`.
 *
 * These need Linux, cgroup version 2, and a delegated service subtree with
 * `DelegateSubgroup=core`, exactly as ADR 0009 places the Core service. An
 * ordinary shell is not in such a subtree, so the suite skips itself and says
 * why. Run it through the existing script, which takes the test file as its
 * argument:
 *
 *   ./scripts/run-linux-module-launcher-integration.sh \
 *       tests/conformance/security/linux-module-attached-process-integration.test.ts
 */

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { readFile as readFileAsync, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { attachLinuxModuleProcess } from "../../../src/adapters/linux-module-attached-process.js";
import {
  defaultLauncherScriptPath,
  startLinuxModuleLauncher,
  type StartedLinuxModuleLauncher,
} from "../../../src/adapters/linux-module-launcher/linux-module-launcher-process.js";
import {
  ExtensionIsolationPolicy,
  ExtensionProcessHost,
} from "../../../src/core/extension-process-host.js";
import type { ExtensionPackageManifest } from "../../../src/core/extension-installation-registry.js";
import {
  prepareDelegatedCgroupRoot,
  prepareModuleCgroup,
  type ModuleCgroup,
  type ModuleCgroupLimits,
} from "../../../src/core/linux-module-cgroup.js";

const INTERPRETER = "/usr/bin/python3";
const LIMITS: ModuleCgroupLimits = {
  // These limits should never be the reason the test group exits. In
  // particular, pids.max counts threads as well as processes.
  memoryMaxBytes: 268_435_456,
  maxProcesses: 64,
  cpuQuotaMicros: 50_000,
  cpuPeriodMicros: 100_000,
};
const MAX_OPEN_FILES = 64;

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

function delegatedRootCgroupPath(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const line = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find((candidate) => candidate.startsWith("0::"));
    if (!line) return undefined;
    const path = line.slice("0::".length);
    return path.endsWith("/core") ? path.slice(0, -"/core".length) : undefined;
  } catch {
    return undefined;
  }
}

const delegatedRoot = delegatedRootCgroupPath();
if (
  process.env.DOLLY_LINUX_MODULE_INTEGRATION_REQUIRED === "1" &&
  delegatedRoot === undefined
) {
  throw new Error(
    "The Linux Module integration runner did not place the test process in the required delegated control-group subtree",
  );
}

if (delegatedRoot === undefined) {
  // eslint-disable-next-line no-console
  console.warn(
    `[skip] The Linux Module attached-process scenarios need Linux with a delegated ` +
      `cgroup v2 service subtree (DelegateSubgroup=core). Platform is ${process.platform}.`,
  );
}

interface LinuxProcessIdentity {
  readonly processId: number;
  /** Field 5 of `/proc/<pid>/stat`. */
  readonly processGroupId: number;
  /** Field 22 prevents a reused process identifier from matching this process. */
  readonly startTimeTicks: string;
  readonly state: string;
}

async function readLinuxProcessIdentity(
  processId: number,
): Promise<LinuxProcessIdentity | undefined> {
  try {
    const stat = await readFileAsync(`/proc/${processId}/stat`, "utf8");
    // The second field is the executable name in parentheses and may itself
    // contain spaces, so the fields are read after the last closing parenthesis.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const processGroupId = Number(fields[2]);
    const state = fields[0];
    const startTimeTicks = fields[19];
    if (
      !Number.isSafeInteger(processGroupId) ||
      state === undefined ||
      startTimeTicks === undefined
    ) {
      return undefined;
    }
    return { processId, processGroupId, startTimeTicks, state };
  } catch {
    return undefined;
  }
}

async function sameLiveProcess(identity: LinuxProcessIdentity): Promise<boolean> {
  const current = await readLinuxProcessIdentity(identity.processId);
  return (
    current !== undefined &&
    current.startTimeTicks === identity.startTimeTicks &&
    current.state !== "Z"
  );
}

async function cgroupProcessIds(filesystemPath: string): Promise<number[]> {
  const content = await readFileAsync(`${filesystemPath}/cgroup.procs`, "utf8");
  return content
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

async function cgroupEventCount(
  filesystemPath: string,
  fileName: string,
  eventName: string,
): Promise<number> {
  const content = await readFileAsync(`${filesystemPath}/${fileName}`, "utf8");
  const matching = content
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .find(([name]) => name === eventName);
  const count = Number(matching?.[1]);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${fileName} did not contain a valid ${eventName} counter`);
  }
  return count;
}

async function populated(filesystemPath: string): Promise<boolean | undefined> {
  try {
    const content = await readFileAsync(`${filesystemPath}/cgroup.events`, "utf8");
    if (/(^|\n)populated 1(\n|$)/.test(content)) return true;
    if (/(^|\n)populated 0(\n|$)/.test(content)) return false;
    return undefined;
  } catch {
    return undefined;
  }
}

function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const attempt = async (): Promise<boolean> => {
    for (;;) {
      if (await condition()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  return attempt();
}

let generation = 0;

interface TestResources {
  cgroup?: ModuleCgroup;
  launcher?: StartedLinuxModuleLauncher;
  descendant?: LinuxProcessIdentity;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * Releases only resources recorded by one test. This cleanup deliberately
 * calls the control group directly, so a deliberately broken attached-process
 * adapter cannot prevent cleanup after a negative test.
 */
async function cleanupTestResources(resources: TestResources): Promise<void> {
  const failures: Error[] = [];
  const { cgroup, launcher } = resources;

  if (cgroup !== undefined) {
    if (!cgroup.membershipObserved && launcher?.controller.membershipVerified) {
      cgroup.recordObservedProcessIds([launcher.processId]);
    }

    if (!cgroup.membershipObserved) {
      const processIds = await cgroupProcessIds(cgroup.path);
      if (processIds.length > 0) cgroup.recordObservedProcessIds(processIds);
    }

    if (!cgroup.membershipObserved && launcher !== undefined) {
      launcher.controller.requestStop();
      launcher.closeControlChannel();
      let launcherStopped = await launcher.waitForExit(5_000);
      if (!launcherStopped) {
        launcher.child.kill("SIGKILL");
        launcherStopped = await launcher.waitForExit(5_000);
      }
      if (!launcherStopped) {
        failures.push(new Error(`launcher ${launcher.processId} did not exit during test cleanup`));
      }
    }

    if (!cgroup.membershipObserved) {
      const current = await cgroup.readPopulated();
      if (current === undefined) {
        failures.push(new Error(`could not read ${cgroup.path}/cgroup.events during test cleanup`));
      }
    }

    if (cgroup.membershipObserved && !cgroup.terminationProven) {
      const termination = await cgroup.terminate({ timeoutMs: 10_000 });
      if (!termination.terminated) {
        failures.push(
          new Error(`${termination.code}: ${termination.detail}`),
        );
      }
    }

    if (cgroup.terminationProven) {
      const removal = await cgroup.remove();
      if (!removal.removed) {
        failures.push(new Error(`${removal.code}: ${removal.detail}`));
      }
    } else if (
      !cgroup.membershipObserved &&
      (launcher === undefined || launcher.exit !== undefined)
    ) {
      // No process ever joined. ModuleCgroup.remove correctly refuses this
      // pre-membership state, so the test removes its own known-empty directory.
      try {
        await rmdir(cgroup.path);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          failures.push(
            new Error(`the unused control group ${cgroup.path} could not be removed`, {
              cause: error,
            }),
          );
        }
      }
    }

    try {
      await readFileAsync(`${cgroup.path}/cgroup.events`, "utf8");
      failures.push(new Error(`the test left control group ${cgroup.path} behind`));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        failures.push(
          new Error(`the removed control group ${cgroup.path} could not be checked`, {
            cause: error,
          }),
        );
      }
    }
  }

  if (resources.descendant !== undefined) {
    const gone = await waitFor(
      async () => !(await sameLiveProcess(resources.descendant!)),
      10_000,
    );
    if (!gone) {
      failures.push(
        new Error(`descendant ${resources.descendant.processId} survived test cleanup`),
      );
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "Linux Module test cleanup failed");
  }
}

/**
 * Prepares a real Module control group, starts the reviewed launcher into it,
 * and authorizes it to execute the given program.
 *
 * This drives `LinuxModuleLauncherController` directly rather than through
 * `startModuleProcess`, and that is now a deliberate narrowing rather than a
 * necessity.
 *
 * It was written this way while two gaps made the ordered start impossible to
 * assemble: nothing implemented the `ModuleLauncherControl` shape it is written
 * against, and it handed the launcher the kernel-relative control-group path,
 * which the launcher control protocol rejects. Both are fixed -
 * `createModuleLauncherControl` in
 * `src/adapters/linux-module-launcher/module-launcher-control.ts` supplies the
 * shape, and the ordered start now passes the control-group filesystem path -
 * so these scenarios could go through `startModuleProcess` today.
 *
 * They still do not, so that a failure here is unambiguous: these two claims
 * are about the attached-process adapter and the launcher's descriptors, and
 * routing them through the durable record and the whole ordered start would
 * add failure modes that belong to other tests. Proving the complete ordered
 * assembly end to end is worth doing and is not what this file covers.
 */
async function startModule(
  execution: {
    readonly program: string;
    readonly argumentVector: readonly string[];
  },
  resources: TestResources,
) {
  const root = await prepareDelegatedCgroupRoot({
    delegatedRootCgroupPath: delegatedRoot!,
  });
  if (!root.prepared) {
    throw new Error(`${root.failure.code}: ${root.failure.detail}`);
  }

  const processGenerationId = `pg-attached-${Date.now()}-${++generation}`;
  const prepared = await prepareModuleCgroup({
    delegatedRootCgroupPath: delegatedRoot!,
    identity: {
      instanceId: "instance-attached",
      moduleId: "worker",
      processGenerationId,
    },
    limits: LIMITS,
  });
  if (!prepared.prepared) {
    throw new Error(`${prepared.failure.code}: ${prepared.failure.detail}`);
  }
  const { cgroup } = prepared;
  resources.cgroup = cgroup;
  const oomKillCountBefore = await cgroupEventCount(cgroup.path, "memory.events", "oom_kill");

  const launcher: StartedLinuxModuleLauncher = startLinuxModuleLauncher({
    interpreterProgram: INTERPRETER,
    launcherScriptPath: defaultLauncherScriptPath(),
    // Descriptors 0 and 1 carry the Extension protocol and survive `exec`.
    // This is the arrangement the attached-process adapter binds to.
    protocolStdio: ["pipe", "pipe", "pipe"],
    controllerTimeouts: {
      configureTimeoutMs: 5_000,
      inCgroupTimeoutMs: 5_000,
      membershipTimeoutMs: 5_000,
      exitObservationTimeoutMs: 5_000,
    },
  });
  resources.launcher = launcher;
  launcher.child.stderr?.on("data", () => undefined);

  // The launcher control protocol addresses the group by its filesystem path
  // below the cgroup version 2 mount point, which is `cgroup.path`.
  const outcome = await launcher.controller.authorizeExecution({
    launcherProcessId: launcher.processId,
    moduleCgroupPath: cgroup.path,
    maxOpenFiles: MAX_OPEN_FILES,
    program: execution.program,
    argumentVector: execution.argumentVector,
    environment: {},
  });
  if (outcome.outcome !== "executing") {
    throw new Error(`${outcome.code}: ${outcome.message}`);
  }
  // Membership was verified from kernel files, so the group is the unit of
  // termination from here on.
  cgroup.recordObservedProcessIds(outcome.verifiedProcessIds);
  return { launcher, cgroup, oomKillCountBefore };
}

describe.skipIf(delegatedRoot === undefined)(
  "Linux Module attached process in a real control group",
  () => {
    it("terminates a descendant that left the process group", async ({ onTestFinished }) => {
      const scratch = mkdtempSync(join(tmpdir(), "dolly-attached-escape-"));
      const descendantPidPath = join(scratch, "descendant-pid.txt");
      const resources: TestResources = {};
      onTestFinished(async () => {
        try {
          await cleanupTestResources(resources);
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      }, 35_000);

      const { launcher, cgroup, oomKillCountBefore } = await startModule(
        {
          program: process.execPath,
          argumentVector: [
            process.execPath,
            fixturePath("escaping-descendant-extension.mjs"),
            descendantPidPath,
          ],
        },
        resources,
      );
      const attached = attachLinuxModuleProcess({
        launcher,
        cgroup,
        terminationTimeoutMs: 5_000,
      });

      const wrote = await waitFor(async () => {
        try {
          const text = await readFileAsync(descendantPidPath, "utf8");
          return text.trim().length > 0;
        } catch {
          return false;
        }
      }, 10_000);
      expect(wrote).toBe(true);
      const descendantPid = Number((await readFileAsync(descendantPidPath, "utf8")).trim());
      expect(Number.isSafeInteger(descendantPid)).toBe(true);

      // The descendant is inside the Module control group and outside the
      // launcher's process group. The test does not signal the launcher's real
      // process group because the launcher inherits the Vitest worker's group,
      // which would terminate the test runner too.
      const members = await waitFor(
        async () => (await cgroupProcessIds(cgroup.path)).includes(descendantPid),
        10_000,
      );
      expect(members).toBe(true);
      const descendant = await readLinuxProcessIdentity(descendantPid);
      const launcherIdentity = await readLinuxProcessIdentity(launcher.processId);
      expect(descendant).toBeDefined();
      expect(launcherIdentity).toBeDefined();
      expect(descendant?.processGroupId).not.toBe(launcherIdentity?.processGroupId);
      resources.descendant = descendant;

      expect(descendant === undefined ? false : await sameLiveProcess(descendant)).toBe(true);
      expect(await populated(cgroup.path)).toBe(true);
      expect(attached.exited).toBe(false);

      // Whole-group termination is what empties it.
      attached.requestTermination();
      const reported = await waitFor(async () => attached.exited, 10_000);
      expect(reported).toBe(true);
      expect(await populated(cgroup.path)).toBe(false);
      const descendantStopped = await waitFor(
        async () => descendant === undefined || !(await sameLiveProcess(descendant)),
        10_000,
      );
      expect(descendantStopped).toBe(true);
      expect(attached.terminationAttempts.at(-1)).toMatchObject({
        terminated: true,
        evidence: "populated-zero",
      });
      expect(await cgroupEventCount(cgroup.path, "memory.events", "oom_kill")).toBe(
        oomKillCountBefore,
      );
    }, 90_000);

    it("carries the Extension protocol on descriptors 0 and 1 after exec", async ({
      onTestFinished,
    }) => {
      const scratch = mkdtempSync(join(tmpdir(), "dolly-attached-protocol-"));
      const resources: TestResources = {};
      onTestFinished(async () => {
        try {
          await cleanupTestResources(resources);
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      }, 35_000);

      const { launcher, cgroup, oomKillCountBefore } = await startModule(
        {
          program: process.execPath,
          argumentVector: [
            process.execPath,
            fixturePath("extension-process-fixture.mjs"),
            "process-id",
          ],
        },
        resources,
      );
      const attached = attachLinuxModuleProcess({
        launcher,
        cgroup,
        terminationTimeoutMs: 5_000,
      });
      const manifest: ExtensionPackageManifest = {
        schemaVersion: "dolly.extension-package/1",
        extensionId: "com.example.fixture",
        packageVersion: "1.0.0",
        displayName: "Process test fixture",
        description: "Exercises the Extension process protocol after exec.",
        supportedProtocolVersions: ["3.0"],
        entrypoint: "extension-process-fixture.mjs",
        modules: [{
          moduleKind: "fixture",
          activation: "reactive",
          configVersion: 1,
          configurationSchema: { type: "object" },
        }],
        requestedCapabilities: [],
      };
      let id = 0;
      const host = new ExtensionProcessHost({
        isolation: "process",
        trust: "trusted",
        isolationPolicy: new ExtensionIsolationPolicy(),
        manifest,
        instanceId: "instance-attached",
        moduleId: "module-a",
        moduleGenerationId: "module-generation-a",
        moduleKind: "fixture",
        config: {},
        maxFrameBytes: 16 * 1_024,
        initializationTimeoutMs: 10_000,
        shutdownRequestTimeoutMs: 2_000,
        forceKillDelayMs: 500,
        terminationTimeoutMs: 15_000,
        nextIdentifier: (purpose) => `${purpose}-${++id}`,
        attachedProcess: attached,
      });

      // This is the claim: the pipes Core created before `exec` are the ones
      // the executed Extension speaks the protocol on.
      await expect(host.start()).resolves.toMatchObject({ state: "ready" });
      const result = await host.execute({
        moduleJobId: "module-job-a",
        runId: "run-a",
        attempt: 1,
        deadline: new Date(Date.now() + 5_000).toISOString(),
        responseTimeoutMs: 10_000,
        hasMore: false,
        input: {},
      });
      expect(result).toEqual({ processId: launcher.processId });

      await expect(host.stop()).resolves.toMatchObject({ state: "stopped" });
      expect(await populated(cgroup.path)).toBe(false);
      expect(await cgroupEventCount(cgroup.path, "memory.events", "oom_kill")).toBe(
        oomKillCountBefore,
      );
    }, 90_000);
  },
);
