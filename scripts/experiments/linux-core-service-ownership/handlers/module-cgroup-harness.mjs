/**
 * Shared harness for the case drivers that need a real Module control group
 * (cgroup) and a real Module process.
 *
 * Every driver that imports this file runs as the main process of one transient
 * user service the runner's prefix reserves, created with `Delegate=yes` and
 * `DelegateSubgroup=core`. That places the driver in the `core` subgroup and
 * leaves the delegated service root empty, which is the topology Architecture
 * Decision Record (ADR) 0009 requires before a parent may distribute the `cpu`,
 * `memory`, and `pids` controllers to Module cgroups.
 *
 * The harness deliberately owns no policy. It calls the production
 * implementations in `src/core/linux-module-cgroup.ts` and
 * `src/adapters/linux-module-launcher/` rather than reimplementing preparation,
 * limit read-back, membership proof, or whole-group termination, so a case
 * result is evidence about Dolly and not about this script.
 *
 * Everything it creates lives inside the transient service's own delegated
 * subtree. Nothing here reads, signals, or removes any process, control group,
 * or file outside that subtree.
 */
import { spawn } from "node:child_process";
import { readFile, readdir, rmdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  CGROUP_V2_MOUNT_POINT,
  prepareDelegatedCgroupRoot,
  prepareModuleCgroup,
} from "../../../../src/core/linux-module-cgroup.ts";
import { startLinuxModuleLauncher } from "../../../../src/adapters/linux-module-launcher/linux-module-launcher-process.ts";

export { CGROUP_V2_MOUNT_POINT };

/** Directory holding this file, so fixtures are addressed by absolute path. */
export const HANDLERS_DIRECTORY = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

/** Absolute path of the reviewed child launcher this experiment must exercise. */
export const LAUNCHER_SCRIPT_PATH = new URL(
  "../../../../src/adapters/linux-module-launcher/launcher.py",
  import.meta.url,
).pathname;

/** The name `systemd-run -p DelegateSubgroup=core` gives Core's own subgroup. */
const CORE_SUBGROUP_NAME = "core";

export function pythonInterpreterPath() {
  for (const candidate of ["/usr/bin/python3", "/usr/local/bin/python3", "/bin/python3"]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("no python3 interpreter was found at a fixed absolute path");
}

export function fixturePath(name) {
  return `${HANDLERS_DIRECTORY}/${name}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The delegated service root of the transient unit this process runs in.
 *
 * `/proc/self/cgroup` reports the position inside the delegated subgroup, so
 * the service root is that path with the `core` segment removed. The delegation
 * probe recorded exactly this difference between the manager-reported service
 * cgroup and the process's own cgroup.
 */
export async function readDelegatedRootCgroupPath() {
  const text = await readFile("/proc/self/cgroup", "utf8");
  let own;
  for (const line of text.split("\n")) {
    if (line.startsWith("0::")) own = line.slice(3).trim();
  }
  if (own === undefined || !own.startsWith("/")) {
    throw new Error(`/proc/self/cgroup did not report a cgroup version 2 path: ${text.trim()}`);
  }
  if (!own.endsWith(`/${CORE_SUBGROUP_NAME}`)) {
    throw new Error(
      `this process is at ${own}, which is not the "${CORE_SUBGROUP_NAME}" subgroup of a delegated service root`,
    );
  }
  return own.slice(0, -(CORE_SUBGROUP_NAME.length + 1));
}

/** Reads one control file, trimmed. Returns `undefined` when it cannot be read. */
export async function readControlFile(path) {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return undefined;
  }
}

/**
 * Reads a `key value` control file such as `memory.events`, `pids.events`, or
 * `cpu.stat` into a plain object of numbers.
 */
export async function readKeyedControlFile(path) {
  const text = await readControlFile(path);
  if (text === undefined) return undefined;
  const values = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf(" ");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator);
    const value = Number.parseInt(trimmed.slice(separator + 1).trim(), 10);
    values[key] = Number.isSafeInteger(value) ? value : Number.NaN;
  }
  return values;
}

/** Whether a process identifier still exists. Reads `/proc`; sends no signal. */
export function processExists(processId) {
  return existsSync(`/proc/${processId}`);
}

/**
 * Prepares the delegated root and one Module cgroup through the production
 * implementation. Throws with the production failure code when either step
 * fails, so a driver never has to invent its own reason.
 */
export async function prepareModuleCgroupForCase(options) {
  const delegatedRootCgroupPath = await readDelegatedRootCgroupPath();
  const root = await prepareDelegatedCgroupRoot({ delegatedRootCgroupPath });
  if (!root.prepared) {
    throw new Error(`${root.failure.code}: ${root.failure.detail}`);
  }
  const prepared = await prepareModuleCgroup({
    delegatedRootCgroupPath,
    identity: options.identity,
    limits: options.limits,
  });
  if (!prepared.prepared) {
    throw new Error(`${prepared.failure.code}: ${prepared.failure.detail}`);
  }
  return { delegatedRootCgroupPath, root: root.root, cgroup: prepared.cgroup };
}

/**
 * Starts the reviewed child launcher, drives the whole launcher control
 * sequence, and returns once the launcher was authorized to replace itself with
 * the fixture. The Module process therefore exists only inside the prepared
 * cgroup: no process is created first and moved afterwards.
 */
export async function startFixtureInModuleCgroup(options) {
  const started = startLinuxModuleLauncher({
    interpreterProgram: pythonInterpreterPath(),
    launcherScriptPath: LAUNCHER_SCRIPT_PATH,
    protocolStdio: options.protocolStdio ?? ["ignore", "pipe", "pipe"],
    ...(options.additionalInheritedStdio === undefined
      ? {}
      : { additionalInheritedStdio: options.additionalInheritedStdio }),
    launcherEnvironment: {},
    controllerTimeouts: { inCgroupTimeoutMs: 10_000, membershipTimeoutMs: 10_000 },
  });
  const launchError = await started.waitForLaunchError(500);
  if (launchError) throw new Error(`the child launcher did not start: ${launchError.message}`);

  const outcome = await started.controller.authorizeExecution({
    launcherProcessId: started.processId,
    moduleCgroupPath: options.cgroup.path,
    maxOpenFiles: options.maxOpenFiles ?? 64,
    program: pythonInterpreterPath(),
    argumentVector: ["python3", "-I", "-B", options.fixture],
    environment: options.environment ?? {},
  });
  return { started, outcome };
}

/** Collects a child stream into a bounded string. */
export function collectStream(stream, limitBytes = 262_144) {
  let text = "";
  if (!stream) return { read: () => text };
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    if (text.length < limitBytes) text += chunk;
  });
  stream.on("error", () => undefined);
  return { read: () => text };
}

/**
 * Reads the JSON report lines a fixture writes, one at a time.
 *
 * The listener is attached once and every line is queued, so a caller that
 * waits for a second report cannot lose one that arrived while it was busy. A
 * fixture that forks keeps the pipe open through its children, so waiting for
 * end-of-file would hang; this waits for the next report instead.
 */
export function createJsonLineReader(stream) {
  const queue = [];
  const waiters = [];
  let ended = false;
  let buffer = "";

  const deliver = (value) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(value);
    else queue.push(value);
  };

  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith("{")) continue;
      try {
        deliver(JSON.parse(line));
      } catch {
        // Not a report line; keep reading.
      }
    }
  });
  const finish = () => {
    ended = true;
    while (waiters.length > 0) {
      waiters.shift().reject(new Error("the fixture stream ended before its next report line"));
    }
  };
  stream.once("end", finish);
  stream.once("error", finish);

  return {
    next(timeoutMs) {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      if (ended) {
        return Promise.reject(new Error("the fixture stream ended before its next report line"));
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`no JSON report line arrived within ${timeoutMs} ms`));
        }, timeoutMs);
        const waiter = {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        waiters.push(waiter);
      });
    },
  };
}

/** Waits for `cgroup.events` to report `populated 0` through the production reader. */
export async function waitForEmpty(cgroup, timeoutMs) {
  const startedAt = Date.now();
  for (;;) {
    const populated = await cgroup.readPopulated();
    if (populated === false) return { empty: true, waitedMs: Date.now() - startedAt };
    if (Date.now() - startedAt >= timeoutMs) {
      return { empty: false, waitedMs: Date.now() - startedAt };
    }
    await sleep(20);
  }
}

/**
 * Removes any control group a fixture created inside the delegated root, after
 * emptying it with `cgroup.kill`.
 *
 * This is a bounded backstop for the escape cases, which deliberately let a
 * fixture create groups. It only ever touches directories directly below the
 * delegated root of this run's own transient service, and only names carrying
 * the reserved `dolly-test-` prefix.
 */
export async function removeStrayEscapeGroups(delegatedRootCgroupPath) {
  const root = `${CGROUP_V2_MOUNT_POINT}${delegatedRootCgroupPath}`;
  const removed = [];
  let names;
  try {
    names = await readdir(root, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith("dolly-test-")) continue;
    const path = `${root}/${entry.name}`;
    try {
      await writeFile(`${path}/cgroup.kill`, "1");
    } catch {
      // Already empty or already gone.
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const events = await readControlFile(`${path}/cgroup.events`);
      if (events === undefined || events.includes("populated 0")) break;
      await sleep(20);
    }
    try {
      await rmdir(path);
      removed.push(path);
    } catch {
      // Left in place deliberately; the runner reports it as residue.
    }
  }
  return removed;
}

/**
 * One assertion about an exact observed value. A case passes only when every
 * assertion it declared holds, and the recorded text always carries both the
 * expected and the observed value so a reader can check the claim.
 */
export class Assertions {
  #entries = [];

  equal(name, expected, observed) {
    const ok = JSON.stringify(expected) === JSON.stringify(observed);
    this.#entries.push({ name, relation: "==", expected, observed, ok });
    return ok;
  }

  atLeast(name, minimum, observed) {
    const ok = typeof observed === "number" && Number.isFinite(observed) && observed >= minimum;
    this.#entries.push({ name, relation: ">=", expected: minimum, observed, ok });
    return ok;
  }

  atMost(name, maximum, observed) {
    const ok = typeof observed === "number" && Number.isFinite(observed) && observed <= maximum;
    this.#entries.push({ name, relation: "<=", expected: maximum, observed, ok });
    return ok;
  }

  get entries() {
    return this.#entries;
  }

  get allHold() {
    return this.#entries.every((entry) => entry.ok);
  }

  get firstFailure() {
    return this.#entries.find((entry) => !entry.ok);
  }

  lines() {
    return this.#entries.map(
      (entry) =>
        `${entry.ok ? "HOLDS " : "BROKEN"} ${entry.name} ${entry.relation} ${JSON.stringify(
          entry.expected,
        )} observed=${JSON.stringify(entry.observed)}`,
    );
  }
}

/**
 * Writes the driver's single result line. Every driver ends here, including on
 * an unexpected error, so the shell handler always has a machine-readable
 * outcome instead of having to guess from an exit status.
 */
export function reportResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/** Runs one driver body and turns any thrown error into an inconclusive result. */
export async function runDriver(body) {
  try {
    const result = await body();
    reportResult(result);
  } catch (error) {
    reportResult({
      status: "inconclusive",
      reason: "driver-error",
      observations: [`driver error: ${error instanceof Error ? error.stack : String(error)}`],
    });
  }
  // The fixtures fork, so a lingering pipe could keep the event loop alive
  // after the case is decided. The result line is already written.
  process.exit(0);
}
