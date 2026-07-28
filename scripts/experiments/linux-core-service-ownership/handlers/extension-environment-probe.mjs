/**
 * In-service driver for the `environment-sentinels` case handler.
 *
 * It runs as the main process of one transient systemd service and reports, as
 * one line of JavaScript Object Notation on standard output, what that process
 * and the Extension process below it actually received from the kernel at
 * `execve` time. `/proc/<pid>/environ` is used rather than `process.env` or
 * `os.environ`, because those are copies a runtime is free to add to; the
 * process filesystem holds what the kernel was handed.
 *
 * Two modes:
 *
 *   service-environment
 *     Report only this process's own environment. The handler uses it to show
 *     both that a sentinel placed in the service manager reaches an ordinary
 *     service, and that it does not survive a Core command that clears the
 *     inherited environment before the Node.js runtime starts.
 *
 *   extension <module-cgroup-name> <go-file>
 *     Additionally start the real child launcher from
 *     `src/adapters/linux-module-launcher/` inside a Module control group that
 *     is a sibling of this process's `core` subgroup, and have it replace
 *     itself with the Extension stand-in from the conformance fixtures. The
 *     stand-in reports its own `execve` environment, which is the evidence
 *     about what an Extension observes.
 *
 * The go file exists so the handler can record the Module control group in the
 * run's ledger before this process creates it. Nothing is created until the
 * handler has written that file.
 */
import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const EXTENSION_PROGRAM = `${REPOSITORY_ROOT}tests/conformance/security/fixtures/module-process-report.py`;
const INTERPRETER_PROGRAM = "/usr/bin/python3";
const MODULE_MAX_OPEN_FILES = 64;

/**
 * The whole environment a Module process is declared to receive. ADR 0009 lets
 * Core carry a non-secret candidate unit name in a minimal environment; nothing
 * else is declared, so nothing else may appear.
 */
const DECLARED_EXTENSION_ENVIRONMENT = {
  DOLLY_MODULE_MARKER: "declared-minimal-environment",
};

/** Reads a NUL-separated `/proc` file as an environment object. */
async function readProcessEnvironment(path) {
  const raw = await readFile(path);
  const environment = {};
  for (const entry of raw.toString("utf8").split("\0")) {
    if (entry.length === 0) continue;
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return environment;
}

async function readSelfCgroup() {
  const content = await readFile("/proc/self/cgroup", "utf8");
  const line = content.split("\n").find((candidate) => candidate.startsWith("0::"));
  if (!line) throw new Error("no control group version 2 line in /proc/self/cgroup");
  return line.slice("0::".length);
}

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await readFile(path);
      return true;
    } catch {
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function waitForEmptyCgroup(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let events = "";
  for (;;) {
    events = (await readFile(`${path}/cgroup.events`, "utf8").catch(() => "")).trim();
    if (/(^|\n)populated 0(\n|$)/.test(events)) return events;
    if (Date.now() > deadline) return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Runs the Extension stand-in under the real launcher and returns everything
 * observed about it, including the control group it was in and the environment
 * the kernel gave it.
 */
async function runExtension(moduleCgroupName, goFile) {
  // Imported here rather than at the top of the file so that the
  // `service-environment` mode needs no TypeScript loader. That mode stands in
  // for the installed Core executable, and the fewer things its command line
  // carries, the closer it is to the one ADR 0009 describes.
  const { defaultLauncherScriptPath, startLinuxModuleLauncher } = await import(
    "../../../../src/adapters/linux-module-launcher/linux-module-launcher-process.js"
  );
  const selfCgroup = await readSelfCgroup();
  if (!selfCgroup.endsWith("/core")) {
    throw new Error(`this process is at ${selfCgroup}; the case needs DelegateSubgroup=core`);
  }
  const delegatedRoot = `/sys/fs/cgroup${selfCgroup.slice(0, -"/core".length)}`;
  const detail = { delegatedRoot, selfCgroup };

  if (!(await waitForFile(goFile, 30_000))) {
    throw new Error("the handler never recorded the Module control group in the ledger");
  }

  // The delegated root holds no process of its own, which is what lets it
  // distribute controllers to the Module control groups below it.
  detail.delegatedRootProcesses = (
    await readFile(`${delegatedRoot}/cgroup.procs`, "utf8")
  ).trim();
  await writeFile(`${delegatedRoot}/cgroup.subtree_control`, "+cpu +memory +pids");
  detail.subtreeControl = (
    await readFile(`${delegatedRoot}/cgroup.subtree_control`, "utf8")
  ).trim();

  const moduleCgroupPath = `${delegatedRoot}/${moduleCgroupName}`;
  detail.moduleCgroupPath = moduleCgroupPath;
  await mkdir(moduleCgroupPath);
  try {
    const started = startLinuxModuleLauncher({
      interpreterProgram: INTERPRETER_PROGRAM,
      launcherScriptPath: defaultLauncherScriptPath(),
      protocolStdio: ["ignore", "pipe", "pipe"],
      controllerTimeouts: {
        configureTimeoutMs: 5_000,
        inCgroupTimeoutMs: 5_000,
        membershipTimeoutMs: 5_000,
        exitObservationTimeoutMs: 5_000,
      },
    });
    let standardOutput = "";
    let standardError = "";
    started.child.stdout?.on("data", (chunk) => {
      standardOutput += chunk.toString("utf8");
    });
    started.child.stderr?.on("data", (chunk) => {
      standardError += chunk.toString("utf8");
    });

    detail.declaredEnvironment = DECLARED_EXTENSION_ENVIRONMENT;
    detail.outcome = await started.controller.authorizeExecution({
      launcherProcessId: started.processId,
      moduleCgroupPath,
      maxOpenFiles: MODULE_MAX_OPEN_FILES,
      program: INTERPRETER_PROGRAM,
      argumentVector: [INTERPRETER_PROGRAM, "-I", EXTENSION_PROGRAM],
      environment: DECLARED_EXTENSION_ENVIRONMENT,
    });
    detail.launcherExitObserved = await started.waitForExit(10_000);
    detail.exit = started.exit ?? null;
    detail.standardError = standardError.slice(0, 4_000);
    const reportLine = standardOutput.trim();
    detail.report = reportLine.length > 0 ? JSON.parse(reportLine) : null;
    return detail;
  } finally {
    await writeFile(`${moduleCgroupPath}/cgroup.kill`, "1").catch(() => undefined);
    detail.cgroupEventsAfterKill = await waitForEmptyCgroup(moduleCgroupPath, 5_000);
    detail.moduleCgroupRemoved = await rmdir(moduleCgroupPath).then(
      () => true,
      () => false,
    );
  }
}

const [mode, moduleCgroupName, goFile] = process.argv.slice(2);
const payload = { mode, processId: process.pid };
try {
  payload.serviceEnvironment = await readProcessEnvironment("/proc/self/environ");
  payload.selfCgroup = await readSelfCgroup();
  if (mode === "extension") {
    payload.extension = await runExtension(moduleCgroupName, goFile);
  }
  payload.completed = true;
} catch (error) {
  payload.completed = false;
  payload.error = String(error);
}
process.stdout.write(`${JSON.stringify(payload)}\n`);
