/**
 * Linux integration scenarios for the child launcher and its Core-side
 * controller. They require a real delegated cgroup version 2 subtree, so they
 * run only on Linux inside a service started with `Delegate=yes` and
 * `DelegateSubgroup=core`, matching the topology in Architecture Decision
 * Record (ADR) 0009.
 *
 * The scenarios are exported as one function so that the same code runs both
 * from the vitest suite on a Linux host and from a small runner on the test
 * server.
 */
import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "../../../src/core/canonical-json.js";
import {
  createLauncherExecuteCommand,
  LAUNCHER_EXIT_STATUS,
} from "../../../src/adapters/linux-module-launcher/launcher-control-protocol.js";
import { readModuleCgroupProcessIds } from "../../../src/adapters/linux-module-launcher/cgroup-procs.js";
import {
  defaultLauncherScriptPath,
  startLinuxModuleLauncher,
  type StartedLinuxModuleLauncher,
} from "../../../src/adapters/linux-module-launcher/linux-module-launcher-process.js";

export interface LauncherScenarioResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: Record<string, unknown>;
}

export interface LauncherScenarioOptions {
  /** Absolute path of the Python 3 interpreter that runs the launcher. */
  readonly interpreterProgram?: string;
  /** Included so a caller can skip the ten-second fixed-deadline scenario. */
  readonly includeDeadlineScenario?: boolean;
}

const DEFAULT_INTERPRETER = "/usr/bin/python3";
const MODULE_MAX_OPEN_FILES = 64;
const MEMORY_MAX_BYTES = 67_108_864;
const PIDS_MAX = 16;
const CPU_MAX = "50000 100000";

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

function frameBytes(value: JsonValue): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

async function readText(path: string): Promise<string> {
  return (await readFile(path, "utf8")).trim();
}

/**
 * Returns the delegated service cgroup root. systemd places the service main
 * process in the `core` subgroup, so the delegated root is its parent.
 */
export async function resolveDelegatedCgroupRoot(): Promise<string> {
  const line = (await readFile("/proc/self/cgroup", "utf8"))
    .split("\n")
    .find((candidate) => candidate.startsWith("0::"));
  if (!line) throw new Error("No cgroup version 2 line in /proc/self/cgroup");
  const relative = line.slice("0::".length);
  if (!relative.endsWith("/core")) {
    throw new Error(
      `This process is at ${relative}; the scenarios need DelegateSubgroup=core`,
    );
  }
  return `/sys/fs/cgroup${relative.slice(0, -"/core".length)}`;
}

/** Applies the ADR 0009 checks Core makes before it accepts Module work. */
export async function prepareDelegatedCgroupRoot(
  delegatedRoot: string,
): Promise<Record<string, unknown>> {
  const rootProcesses = await readText(`${delegatedRoot}/cgroup.procs`);
  if (rootProcesses.length > 0) {
    throw new Error("The delegated cgroup root contains processes");
  }
  await writeFile(`${delegatedRoot}/cgroup.subtree_control`, "+cpu +memory +pids");
  const subtreeControl = await readText(`${delegatedRoot}/cgroup.subtree_control`);
  for (const controller of ["cpu", "memory", "pids"]) {
    if (!subtreeControl.split(/\s+/).includes(controller)) {
      throw new Error(`The delegated root did not enable ${controller}`);
    }
  }
  return {
    delegatedRoot,
    delegatedRootProcesses: rootProcesses,
    subtreeControl,
    controllers: await readText(`${delegatedRoot}/cgroup.controllers`),
  };
}

async function createModuleCgroup(
  delegatedRoot: string,
  name: string,
): Promise<{ path: string; limits: Record<string, string> }> {
  const path = `${delegatedRoot}/${name}`;
  await mkdir(path);
  await writeFile(`${path}/memory.max`, String(MEMORY_MAX_BYTES));
  await writeFile(`${path}/memory.oom.group`, "1");
  await writeFile(`${path}/pids.max`, String(PIDS_MAX));
  await writeFile(`${path}/cpu.max`, CPU_MAX);
  const limits = {
    "memory.max": await readText(`${path}/memory.max`),
    "memory.oom.group": await readText(`${path}/memory.oom.group`),
    "pids.max": await readText(`${path}/pids.max`),
    "cpu.max": await readText(`${path}/cpu.max`),
  };
  if (
    limits["memory.max"] !== String(MEMORY_MAX_BYTES) ||
    limits["memory.oom.group"] !== "1" ||
    limits["pids.max"] !== String(PIDS_MAX) ||
    limits["cpu.max"] !== CPU_MAX
  ) {
    throw new Error(`The Module cgroup did not read back its limits: ${JSON.stringify(limits)}`);
  }
  return { path, limits };
}

async function waitForEmptyCgroup(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let events = "";
  while (Date.now() <= deadline) {
    events = await readText(`${path}/cgroup.events`);
    if (/(^|\n)populated 0(\n|$)/.test(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return events;
}

/** Terminates and removes a Module cgroup, returning the observed evidence. */
async function terminateModuleCgroup(path: string): Promise<Record<string, unknown>> {
  const detail: Record<string, unknown> = {};
  try {
    await writeFile(`${path}/cgroup.kill`, "1");
    detail.cgroupKillWritten = true;
  } catch (error) {
    detail.cgroupKillWritten = false;
    detail.cgroupKillError = String(error);
  }
  detail.cgroupEvents = await waitForEmptyCgroup(path, 2_000);
  detail.remainingProcessIds = await readModuleCgroupProcessIds(path).catch(() => "unreadable");
  try {
    await rmdir(path);
    detail.removed = true;
  } catch (error) {
    detail.removed = false;
    detail.removeError = String(error);
  }
  return detail;
}

interface CapturedLauncher {
  readonly started: StartedLinuxModuleLauncher;
  readonly standardOutput: () => string;
  readonly standardError: () => string;
}

function startCapturedLauncher(
  interpreterProgram: string,
  launcherScriptPath: string,
  additionalInheritedStdio?: readonly ("pipe" | "ignore")[],
): CapturedLauncher {
  const started = startLinuxModuleLauncher({
    interpreterProgram,
    launcherScriptPath,
    protocolStdio: ["ignore", "pipe", "pipe"],
    additionalInheritedStdio,
    controllerTimeouts: {
      configureTimeoutMs: 3_000,
      inCgroupTimeoutMs: 3_000,
      membershipTimeoutMs: 3_000,
      exitObservationTimeoutMs: 3_000,
    },
  });
  let standardOutput = "";
  let standardError = "";
  started.child.stdout?.on("data", (chunk: Buffer) => {
    standardOutput += chunk.toString("utf8");
  });
  started.child.stderr?.on("data", (chunk: Buffer) => {
    standardError += chunk.toString("utf8");
  });
  return {
    started,
    standardOutput: () => standardOutput,
    standardError: () => standardError,
  };
}

async function runScenario(
  name: string,
  body: () => Promise<{ passed: boolean; detail: Record<string, unknown> }>,
): Promise<LauncherScenarioResult> {
  try {
    const result = await body();
    return { name, passed: result.passed, detail: result.detail };
  } catch (error) {
    return {
      name,
      passed: false,
      detail: { error: String(error), stack: (error as Error)?.stack ?? null },
    };
  }
}

export async function runLinuxModuleLauncherScenarios(
  options: LauncherScenarioOptions = {},
): Promise<LauncherScenarioResult[]> {
  const interpreterProgram = options.interpreterProgram ?? DEFAULT_INTERPRETER;
  const launcherScriptPath = defaultLauncherScriptPath();
  const falseLauncherScriptPath = fixturePath("false-in-cgroup-launcher.py");
  const moduleProgramPath = fixturePath("module-process-report.py");
  const delegatedRoot = await resolveDelegatedCgroupRoot();
  const preparation = await prepareDelegatedCgroupRoot(delegatedRoot);
  let sequence = 0;
  const nextCgroupName = (): string => `dolly-test-mod-${process.pid}-${(sequence += 1)}`;

  const results: LauncherScenarioResult[] = [
    { name: "delegated-cgroup-root-prepared", passed: true, detail: preparation },
  ];

  results.push(
    await runScenario("launcher-joins-cgroup-and-execs-after-verification", async () => {
      const moduleCgroup = await createModuleCgroup(delegatedRoot, nextCgroupName());
      // Two extra inherited descriptors stand in for descriptors a real Core
      // process might hold; the launcher must close them before it reports
      // in-cgroup, so the executed program must not see 4 or 5.
      const captured = startCapturedLauncher(interpreterProgram, launcherScriptPath, [
        "pipe",
        "pipe",
      ]);
      const detail: Record<string, unknown> = {
        moduleCgroupPath: moduleCgroup.path,
        additionalInheritedDescriptors: [4, 5],
      };
      try {
        const outcome = await captured.started.controller.authorizeExecution({
          launcherProcessId: captured.started.processId,
          moduleCgroupPath: moduleCgroup.path,
          maxOpenFiles: MODULE_MAX_OPEN_FILES,
          program: interpreterProgram,
          argumentVector: [interpreterProgram, "-I", moduleProgramPath],
          environment: { DOLLY_MODULE_MARKER: "closed-environment" },
        });
        detail.outcome = outcome;
        detail.limits = moduleCgroup.limits;
        const exited = await captured.started.waitForExit(5_000);
        detail.launcherExitObserved = exited;
        detail.exit = captured.started.exit;
        detail.standardError = captured.standardError();
        const reportLine = captured.standardOutput().trim();
        detail.report = reportLine;
        const report = reportLine.length > 0 ? JSON.parse(reportLine) : undefined;
        const passed =
          outcome.outcome === "executing" &&
          report !== undefined &&
          // exec replaces the process image, so the executed program keeps the
          // launcher's process identifier: it was not forked.
          report.processId === captured.started.processId &&
          String(report.cgroup).endsWith(moduleCgroup.path.slice("/sys/fs/cgroup".length)) &&
          report.maxOpenFiles[0] === MODULE_MAX_OPEN_FILES &&
          report.maxOpenFiles[1] === MODULE_MAX_OPEN_FILES &&
          // Only the Extension protocol transport and diagnostic standard
          // error survived exec; the control descriptor did not.
          JSON.stringify(report.openDescriptors) === JSON.stringify([0, 1, 2]) &&
          // The kernel's own record of what exec received proves the argument
          // vector and environment were exactly the Core-validated values.
          JSON.stringify(report.execEnvironment) ===
            JSON.stringify({ DOLLY_MODULE_MARKER: "closed-environment" }) &&
          JSON.stringify(report.execArgumentVector) ===
            JSON.stringify([interpreterProgram, "-I", moduleProgramPath]);
        return { passed, detail };
      } finally {
        detail.cleanup = await terminateModuleCgroup(moduleCgroup.path);
      }
    }),
  );

  results.push(
    await runScenario("exit-command-before-configure-stops-launcher", async () => {
      const moduleCgroup = await createModuleCgroup(delegatedRoot, nextCgroupName());
      const captured = startCapturedLauncher(interpreterProgram, launcherScriptPath);
      const detail: Record<string, unknown> = { moduleCgroupPath: moduleCgroup.path };
      try {
        captured.started.controller.requestStop();
        const outcome = await captured.started.controller.authorizeExecution({
          launcherProcessId: captured.started.processId,
          moduleCgroupPath: moduleCgroup.path,
          maxOpenFiles: MODULE_MAX_OPEN_FILES,
          program: interpreterProgram,
          argumentVector: [interpreterProgram, "-I", moduleProgramPath],
          environment: {},
        });
        detail.outcome = outcome;
        detail.exit = captured.started.exit;
        detail.moduleCgroupProcessIds = await readModuleCgroupProcessIds(moduleCgroup.path);
        detail.standardOutput = captured.standardOutput();
        const passed =
          outcome.outcome === "failed" &&
          outcome.code === "LAUNCHER_STOP_REQUESTED" &&
          outcome.membershipVerified === false &&
          outcome.launcherExitObserved === true &&
          captured.started.exit?.code === LAUNCHER_EXIT_STATUS.exitCommanded &&
          captured.started.exit?.signal === null &&
          (detail.moduleCgroupProcessIds as readonly number[]).length === 0 &&
          captured.standardOutput() === "";
        return { passed, detail };
      } finally {
        detail.cleanup = await terminateModuleCgroup(moduleCgroup.path);
      }
    }),
  );

  results.push(
    await runScenario("exit-command-after-membership-prevents-execute", async () => {
      const moduleCgroup = await createModuleCgroup(delegatedRoot, nextCgroupName());
      const detail: Record<string, unknown> = { moduleCgroupPath: moduleCgroup.path };
      const started = startLinuxModuleLauncher({
        interpreterProgram,
        launcherScriptPath,
        protocolStdio: ["ignore", "pipe", "pipe"],
        controllerTimeouts: { inCgroupTimeoutMs: 3_000, membershipTimeoutMs: 3_000 },
        readModuleCgroupProcessIds: async (path) => {
          const processIds = await readModuleCgroupProcessIds(path);
          // A stop arriving while Core reads the kernel files must still stop
          // the launcher, now with cgroup-level termination available.
          started.controller.requestStop();
          return processIds;
        },
      });
      let standardOutput = "";
      started.child.stdout?.on("data", (chunk: Buffer) => {
        standardOutput += chunk.toString("utf8");
      });
      try {
        const outcome = await started.controller.authorizeExecution({
          launcherProcessId: started.processId,
          moduleCgroupPath: moduleCgroup.path,
          maxOpenFiles: MODULE_MAX_OPEN_FILES,
          program: interpreterProgram,
          argumentVector: [interpreterProgram, "-I", moduleProgramPath],
          environment: {},
        });
        detail.outcome = outcome;
        detail.launcherExitObserved = await started.waitForExit(5_000);
        detail.exit = started.exit;
        detail.standardOutput = standardOutput;
        const passed =
          outcome.outcome === "failed" &&
          outcome.code === "LAUNCHER_STOP_REQUESTED" &&
          outcome.membershipVerified === true &&
          started.exit?.code === LAUNCHER_EXIT_STATUS.exitCommanded &&
          standardOutput === "";
        return { passed, detail };
      } finally {
        detail.cleanup = await terminateModuleCgroup(moduleCgroup.path);
      }
    }),
  );

  results.push(
    await runScenario("false-in-cgroup-report-fails-closed-without-signals", async () => {
      const moduleCgroup = await createModuleCgroup(delegatedRoot, nextCgroupName());
      const captured = startCapturedLauncher(interpreterProgram, falseLauncherScriptPath);
      const detail: Record<string, unknown> = { moduleCgroupPath: moduleCgroup.path };
      try {
        const outcome = await captured.started.controller.authorizeExecution({
          launcherProcessId: captured.started.processId,
          moduleCgroupPath: moduleCgroup.path,
          maxOpenFiles: MODULE_MAX_OPEN_FILES,
          program: interpreterProgram,
          argumentVector: [interpreterProgram, "-I", moduleProgramPath],
          environment: {},
        });
        detail.outcome = outcome;
        detail.exit = captured.started.exit;
        detail.standardError = captured.standardError();
        detail.standardOutput = captured.standardOutput();
        detail.moduleCgroupProcessIds = await readModuleCgroupProcessIds(moduleCgroup.path);
        const passed =
          outcome.outcome === "failed" &&
          outcome.code === "LAUNCHER_MEMBERSHIP_UNVERIFIED" &&
          outcome.membershipVerified === false &&
          outcome.launcherExitObserved === true &&
          // The controller stopped it with the exit command, never a signal.
          captured.started.exit?.signal === null &&
          captured.started.exit?.code === 13 &&
          captured.standardOutput() === "";
        return { passed, detail };
      } finally {
        detail.cleanup = await terminateModuleCgroup(moduleCgroup.path);
      }
    }),
  );

  const rawFrameCases: readonly {
    name: string;
    bytes: Buffer;
    expectedExit: number;
  }[] = [
    {
      name: "malformed-frame-exits-nonzero",
      bytes: Buffer.concat([
        (() => {
          const header = Buffer.allocUnsafe(4);
          header.writeUInt32BE(8, 0);
          return header;
        })(),
        Buffer.from("not json", "utf8"),
      ]),
      expectedExit: LAUNCHER_EXIT_STATUS.frameInvalid,
    },
    {
      name: "oversized-frame-exits-nonzero",
      bytes: (() => {
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(5_000, 0);
        return Buffer.concat([header, Buffer.alloc(5_000, 0x61)]);
      })(),
      expectedExit: LAUNCHER_EXIT_STATUS.frameInvalid,
    },
    {
      name: "out-of-order-execute-frame-exits-nonzero",
      bytes: frameBytes(
        createLauncherExecuteCommand("/bin/true", ["/bin/true"], {}) as unknown as JsonValue,
      ),
      expectedExit: LAUNCHER_EXIT_STATUS.frameInvalid,
    },
    {
      name: "unknown-protocol-version-exits-nonzero",
      bytes: frameBytes({ launcherProtocol: 2, command: "exit" }),
      expectedExit: LAUNCHER_EXIT_STATUS.frameInvalid,
    },
  ];

  for (const testCase of rawFrameCases) {
    results.push(
      await runScenario(testCase.name, async () => {
        const captured = startCapturedLauncher(interpreterProgram, launcherScriptPath);
        captured.started.writeRawControlBytes(testCase.bytes);
        const exited = await captured.started.waitForExit(5_000);
        const detail = {
          exited,
          exit: captured.started.exit,
          standardOutput: captured.standardOutput(),
          standardError: captured.standardError(),
        };
        return {
          passed:
            exited &&
            captured.started.exit?.code === testCase.expectedExit &&
            captured.standardOutput() === "",
          detail,
        };
      }),
    );
  }

  results.push(
    await runScenario("closed-control-descriptor-exits-nonzero", async () => {
      const captured = startCapturedLauncher(interpreterProgram, launcherScriptPath);
      captured.started.closeControlChannel();
      const exited = await captured.started.waitForExit(5_000);
      return {
        passed:
          exited && captured.started.exit?.code === LAUNCHER_EXIT_STATUS.controlChannelClosed,
        detail: {
          exited,
          exit: captured.started.exit,
          standardError: captured.standardError(),
        },
      };
    }),
  );

  if (options.includeDeadlineScenario !== false) {
    results.push(
      await runScenario("fixed-internal-deadline-exits-nonzero", async () => {
        const captured = startCapturedLauncher(interpreterProgram, launcherScriptPath);
        const startedAt = Date.now();
        const exited = await captured.started.waitForExit(20_000);
        return {
          passed:
            exited && captured.started.exit?.code === LAUNCHER_EXIT_STATUS.deadlineExpired,
          detail: {
            exited,
            exit: captured.started.exit,
            elapsedMs: Date.now() - startedAt,
            standardError: captured.standardError(),
          },
        };
      }),
    );
  }

  return results;
}
