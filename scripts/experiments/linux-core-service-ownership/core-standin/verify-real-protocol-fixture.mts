/**
 * Proves that the real-protocol Extension fixture is accepted by the shipped
 * `ExtensionProcessHost`, in both of the host's construction modes.
 *
 * Why this exists separately from the matrix: rewriting the fixture onto the
 * real Extension process protocol and reworking the Core stand-in onto the real
 * host are two different jobs, and only the second one needs a control group, a
 * systemd service, and an interruption. This program checks the first one on
 * its own, so a protocol mistake is found here in seconds instead of inside a
 * 210-case matrix run.
 *
 * It exercises both construction modes deliberately:
 *
 *   start-command     the host spawns its own direct child. This is what the
 *                     `baseline-direct-child` arm is defined as, and it is the
 *                     only mode that existed before the attached-process seam.
 *   attached-process  the host is handed a process that already exists. This is
 *                     the mode Architecture Decision Record 0009 needs, because
 *                     the reviewed launcher — not the host — must create the
 *                     process, join the Module control group, and have its
 *                     kernel membership verified before `exec`.
 *
 * The attachment here is a plain child this program starts, standing in for the
 * launcher. That is the point: the host must not care who created the process,
 * only that it can speak to it and can observe it exit.
 *
 * Run it on Linux:
 *   node --import file://<repo>/node_modules/tsx/dist/loader.mjs \
 *     scripts/experiments/linux-core-service-ownership/core-standin/verify-real-protocol-fixture.mts
 *
 * It creates one short-lived child per case, in a temporary directory it
 * removes, and starts no service and no control group.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ExtensionIsolationPolicy,
  ExtensionProcessHost,
  type AttachedExtensionProcess,
} from "../../../../src/core/extension-process-host.js";
import type { ExtensionPackageManifest } from "../../../../src/core/extension-installation-registry.js";
import type { JsonValue } from "../../../../src/core/canonical-json.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "dolly-protocol-extension-fixture.py");

// These three must equal what the fixture reports at initialization. The host
// compares them and rejects a mismatch, which is one of the things being
// checked here.
const EXTENSION_ID = "dolly-test-experiment-extension";
const PACKAGE_VERSION = "1.0.0";
const MODULE_KIND = "reactive";

const MANIFEST: ExtensionPackageManifest = {
  schemaVersion: "dolly.extension-package/1",
  extensionId: EXTENSION_ID,
  packageVersion: PACKAGE_VERSION,
  displayName: "Dolly experiment Extension fixture",
  description: "Fixed local fixture for the Linux Core service ownership experiment",
  supportedProtocolVersions: ["3.0"],
  entrypoint: "dolly-protocol-extension-fixture.py",
  modules: [
    {
      moduleKind: MODULE_KIND,
      activation: "reactive",
      configVersion: 1,
      configurationSchema: { type: "object" },
    },
  ],
  requestedCapabilities: [],
};

const WORKLOADS = [
  "no-output",
  "single-output",
  "multiple-output-pages",
  "processor-loop",
  "process-descendant",
  "active-capability-handler",
  "unknown-external-effect",
] as const;

type Mode = "start-command" | "attached-process";

interface CaseOutcome {
  readonly mode: Mode;
  readonly workload: string;
  readonly passed: boolean;
  readonly detail: string;
}

function interpreter(): string {
  return process.env["DOLLY_PYTHON"] ?? "/usr/bin/python3";
}

/**
 * Wraps a child this program started as the attachment shape the host takes.
 * It is the same shape the Linux Module executor will build over the reviewed
 * launcher's child; nothing here signals a recovered process identifier.
 */
function attachSpawnedChild(workingDirectory: string): {
  attached: AttachedExtensionProcess;
  waitForExit: () => Promise<void>;
} {
  const child = spawn(interpreter(), ["-I", "-B", FIXTURE], {
    cwd: workingDirectory,
    env: { DOLLY_ATTACHED_MODE: "yes" },
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
  });
  child.stderr?.on("data", () => undefined);
  let exited = child.exitCode !== null || child.signalCode !== null;
  const observers = new Set<() => void>();
  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      for (const observer of observers) observer();
      observers.clear();
      resolve();
    });
  });
  return {
    attached: {
      standardInput: child.stdin!,
      standardOutput: child.stdout!,
      get processId() {
        return child.pid;
      },
      get exited() {
        return exited;
      },
      onExit: (observer) => {
        if (exited) observer();
        else observers.add(observer);
      },
      requestTermination: () => {
        child.kill("SIGTERM");
      },
      forceTermination: () => {
        child.kill("SIGKILL");
      },
    },
    waitForExit: () => exitPromise,
  };
}

/**
 * Stops the descendant this check asked the fixture to record, and reports a
 * problem if it could not be proven gone.
 *
 * The identifier is read from a file this run's own fixture wrote moments ago,
 * inside a directory this run created, and the command line is re-read from
 * `/proc` before anything is signalled: a recycled identifier belonging to
 * someone else must never be signalled. That check is the same reason
 * Architecture Decision Record 0009 refuses to signal a recovered identifier,
 * applied to a checker that has no control group to terminate instead.
 */
function reapDescendant(pidPath: string): string | null {
  let recorded: string[];
  try {
    recorded = readFileSync(pidPath, "utf8").split("\n");
  } catch {
    return null;
  }
  const pid = Number.parseInt((recorded[0] ?? "").trim(), 10);
  const recordedStart = (recorded[1] ?? "").trim();
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    return "the fixture recorded an unusable descendant identifier";
  }
  // Field 22 of `/proc/<pid>/stat`, read from after the closing parenthesis so
  // a command name containing spaces cannot shift the offset.
  const startTicks = (): string | null => {
    try {
      const text = readFileSync(`/proc/${pid}/stat`, "utf8");
      const tail = text.slice(text.lastIndexOf(")") + 1).trim().split(/\s+/);
      return tail[19] ?? null;
    } catch {
      return null;
    }
  };
  const commandLine = (): string | null => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    } catch {
      return null;
    }
  };
  const current = commandLine();
  if (current === null) return null;
  // The identifier alone is not an identity: Linux reuses it, so a recycled
  // identifier could belong to another run — including another arm of this
  // experiment, which now executes the same fixture. The pair (identifier,
  // start time) is unique, and the command line is checked as well.
  if (recordedStart !== "" && startTicks() !== recordedStart) {
    return `descendant ${pid} no longer has the recorded start time and was not signalled`;
  }
  if (current !== "/bin/sleep 300") {
    return `descendant ${pid} is now ${JSON.stringify(current)} and was not signalled`;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return null;
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (commandLine() === null) return null;
  }
  return `descendant ${pid} did not stop`;
}

async function runCase(mode: Mode, workload: string): Promise<CaseOutcome> {
  const workingDirectory = mkdtempSync(join(tmpdir(), "dolly-fixture-check-"));
  const environPath = join(workingDirectory, "inherited-environment.json");
  const descendantPidPath = join(workingDirectory, "descendant.pid");
  const capabilityCalls: { operation: string; idempotencyKey?: string }[] = [];
  let attachedExit: (() => Promise<void>) | undefined;

  const config: JsonValue = {
    workload,
    outputCount: workload === "multiple-output-pages" ? 3 : workload === "no-output" ? 0 : 1,
    environPath,
    // This check runs with no control group, so nothing else would collect the
    // `process-descendant` workload's descendant and it would outlive the run.
    // In the matrix the control group collects it and no identifier is
    // recorded or signalled; here the checker must reap what it started.
    descendantPidPath,
  };

  const common = {
    isolation: "process" as const,
    trust: "trusted" as const,
    isolationPolicy: new ExtensionIsolationPolicy([]),
    manifest: MANIFEST,
    instanceId: "dolly-test-instance",
    moduleId: "experimentworker",
    moduleGenerationId: "dolly-test-module-generation-1",
    moduleKind: MODULE_KIND,
    config,
    initializationTimeoutMs: 30_000,
    shutdownRequestTimeoutMs: 10_000,
    forceKillDelayMs: 2_000,
    terminationTimeoutMs: 20_000,
  };

  let host: ExtensionProcessHost;
  if (mode === "start-command") {
    host = new ExtensionProcessHost({
      ...common,
      command: interpreter(),
      args: ["-I", "-B", FIXTURE],
      workingDirectory,
    });
  } else {
    const attachment = attachSpawnedChild(workingDirectory);
    attachedExit = attachment.waitForExit;
    host = new ExtensionProcessHost({ ...common, attachedProcess: attachment.attached });
  }

  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  host.grantCapability(
    {
      capabilityType: "structured-log",
      capabilityVersion: "v1",
      operations: ["write", "write-slow"],
      resourceScope: { moduleId: "experimentworker" },
      expiresAt,
      maxInvocations: 16,
      maxConcurrentInvocations: 4,
      maxArgumentBytes: 65_536,
      maxResultBytes: 65_536,
    },
    async (_argumentsValue, context) => {
      capabilityCalls.push({
        operation: context.operation,
        ...(context.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: context.idempotencyKey }),
      });
      if (context.operation === "write-slow") {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      return { written: true };
    },
  );
  host.grantCapability(
    {
      capabilityType: "external-effect",
      capabilityVersion: "v1",
      operations: ["emit"],
      resourceScope: { moduleId: "experimentworker" },
      expiresAt,
      maxInvocations: 16,
      maxConcurrentInvocations: 4,
      maxArgumentBytes: 65_536,
      maxResultBytes: 65_536,
      requireIdempotencyKey: true,
    },
    (_argumentsValue, context) => {
      capabilityCalls.push({
        operation: context.operation,
        ...(context.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: context.idempotencyKey }),
      });
      return { emitted: true };
    },
  );

  const problems: string[] = [];
  try {
    const started = await host.start();
    if (started.state !== "ready") problems.push(`host state after start is ${started.state}`);

    const deadline = new Date(Date.now() + 60_000).toISOString();
    const result = (await host.execute({
      moduleJobId: "dolly-test-module-job-1",
      runId: "dolly-test-run-1",
      attempt: 1,
      deadline,
      responseTimeoutMs: 120_000,
      hasMore: false,
      input: { schemaVersion: "dolly.reactive-module-input/2", claimedDeliveryIds: [], blockGroups: [], hasMore: false },
    })) as { schemaVersion?: string; blockProposal?: unknown };

    if (result?.schemaVersion !== "dolly.module-result/1") {
      problems.push(`result schemaVersion is ${String(result?.schemaVersion)}`);
    }
    const expectsBlock = workload !== "no-output";
    if (expectsBlock && result.blockProposal === undefined) {
      problems.push("result carries no output Block proposal");
    }
    if (!expectsBlock && result.blockProposal !== undefined) {
      problems.push("a no-output Run returned an output Block proposal");
    }

    // Boundary 8 must be reachable in every workload, so every workload must
    // have gone through at least one Core-mediated capability invocation.
    if (capabilityCalls.length === 0) problems.push("no capability invocation reached Core");
    if (workload === "active-capability-handler" && !capabilityCalls.some((call) => call.operation === "write-slow")) {
      problems.push("the slow capability handler was never invoked");
    }
    if (workload === "unknown-external-effect") {
      const effect = capabilityCalls.find((call) => call.operation === "emit");
      if (!effect) problems.push("the external effect capability was never invoked");
      else if (effect.idempotencyKey === undefined) {
        problems.push("the external effect invocation carried no idempotency key");
      }
    }

    // The environment the Extension inherited is recorded by the fixture. In
    // start-command mode the host spawns with an empty environment, so this
    // also checks that the host really does hand over nothing undeclared.
    let inherited: Record<string, string> = {};
    try {
      inherited = JSON.parse(readFileSync(environPath, "utf8")) as Record<string, string>;
    } catch {
      problems.push("the fixture recorded no inherited environment");
    }
    if (mode === "start-command" && Object.keys(inherited).length > 0) {
      problems.push(
        `the host passed ${Object.keys(inherited).length} environment value(s) it did not declare`,
      );
    }
    if (mode === "attached-process" && inherited["DOLLY_ATTACHED_MODE"] !== "yes") {
      problems.push("the attached process did not inherit the environment its creator set");
    }

    const stopped = await host.terminate();
    if (stopped.state !== "stopped") problems.push(`host state after terminate is ${stopped.state}`);
    if (attachedExit) await attachedExit();
  } catch (error) {
    problems.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    try {
      await host.terminate();
    } catch {
      // Already reported above; the temporary directory is still removed.
    }
  } finally {
    const leaked = reapDescendant(descendantPidPath);
    if (leaked !== null) problems.push(leaked);
    rmSync(workingDirectory, { recursive: true, force: true });
  }

  return {
    mode,
    workload,
    passed: problems.length === 0,
    detail:
      problems.length === 0
        ? `${capabilityCalls.length} capability invocation(s)`
        : problems.join("; "),
  };
}

async function main(): Promise<number> {
  if (process.platform !== "linux") {
    process.stderr.write(
      `This check needs Linux: the fixture reads /proc/self/environ. Platform is ${process.platform}.\n`,
    );
    return 3;
  }
  const outcomes: CaseOutcome[] = [];
  for (const mode of ["start-command", "attached-process"] as const) {
    for (const workload of WORKLOADS) {
      const outcome = await runCase(mode, workload);
      outcomes.push(outcome);
      process.stdout.write(
        `${outcome.passed ? "passed" : "FAILED"} ${outcome.mode} ${outcome.workload}: ${outcome.detail}\n`,
      );
    }
  }
  const failed = outcomes.filter((outcome) => !outcome.passed);
  process.stdout.write(
    `\n${outcomes.length - failed.length} of ${outcomes.length} case(s) passed across both host construction modes\n`,
  );
  return failed.length === 0 ? 0 : 1;
}

process.exit(await main());
