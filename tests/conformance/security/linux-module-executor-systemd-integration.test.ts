/**
 * Proves the Linux Module executor's uncertain-ownership exit at the real
 * service-manager boundary. The executor fixture is the transient service's
 * main process; Vitest remains in a separate parent service and observes the
 * result from outside the failed unit.
 *
 * Run this file through:
 *
 *   ./scripts/run-linux-module-launcher-integration.sh \
 *     tests/conformance/security/linux-module-executor-systemd-integration.test.ts
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";

const execFileAsync = promisify(execFile);
const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/linux-module-executor-systemd-exit.ts", import.meta.url),
);
const TSX_LOADER_URL = new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url);
const TSX_LOADER_PATH = fileURLToPath(TSX_LOADER_URL);
const UNIT_PREFIX = "dolly-test-executor-exit-";

interface ProcessIdentity {
  readonly processId: number;
  readonly startTimeTicks: string;
}

interface ExitFixtureReport {
  readonly processGenerationId: string;
  readonly serviceInvocationId: string;
  readonly core: ProcessIdentity & { readonly cgroupPath: string };
  readonly launcher: ProcessIdentity & { readonly cgroupPath: string };
  readonly serviceCgroupFilesystemPath: string;
  readonly moduleCgroupFilesystemPath: string;
}

interface CommandResult {
  readonly exitCode: number | string | undefined;
  readonly signal: string | undefined;
  readonly killed: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

function delegatedSubgroupAvailable(): boolean {
  if (process.platform !== "linux" || !process.env.XDG_RUNTIME_DIR) return false;
  try {
    return readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .some((line) => line.startsWith("0::") && line.endsWith("/core"));
  } catch {
    return false;
  }
}

const available = delegatedSubgroupAvailable() && existsSync(TSX_LOADER_PATH);
if (process.env.DOLLY_LINUX_MODULE_INTEGRATION_REQUIRED === "1" && !available) {
  throw new Error(
    "The Linux Module integration runner did not provide its delegated systemd service or the tsx loader",
  );
}

async function runCommandAllowingFailure(
  program: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(program, [...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    return { exitCode: 0, signal: undefined, killed: false, stdout, stderr };
  } catch (error) {
    const failed = error as Error & {
      readonly code?: number | string;
      readonly signal?: string;
      readonly killed?: boolean;
      readonly stdout?: string;
      readonly stderr?: string;
    };
    return {
      exitCode: failed.code,
      signal: failed.signal,
      killed: failed.killed === true,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

function parseProperties(text: string): ReadonlyMap<string, string> {
  const properties = new Map<string, string>();
  for (const line of text.trim().split("\n")) {
    if (line.length === 0) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`systemctl returned an invalid property line: ${line}`);
    const name = line.slice(0, separator);
    if (properties.has(name)) throw new Error(`systemctl returned ${name} more than once`);
    properties.set(name, line.slice(separator + 1));
  }
  return properties;
}

async function showUnit(unitName: string): Promise<ReadonlyMap<string, string>> {
  const names = [
    "ActiveState",
    "SubState",
    "Result",
    "ExecMainCode",
    "ExecMainStatus",
    "Type",
    "ExitType",
    "Restart",
    "KillMode",
    "Delegate",
    "DelegateSubgroup",
    "InvocationID",
    "ControlGroup",
  ];
  const { stdout } = await execFileAsync(
    "systemctl",
    ["--user", "show", unitName, ...names.map((name) => `--property=${name}`)],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024 },
  );
  return parseProperties(stdout);
}

async function cleanupExactUnit(unitName: string): Promise<void> {
  await execFileAsync("systemctl", ["--user", "stop", unitName], {
    encoding: "utf8",
    timeout: 10_000,
  }).catch(() => undefined);
  await execFileAsync("systemctl", ["--user", "reset-failed", unitName], {
    encoding: "utf8",
    timeout: 10_000,
  }).catch(() => undefined);
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function readProcessIdentity(processId: number): (ProcessIdentity & { state: string }) | undefined {
  try {
    const stat = readFileSync(`/proc/${processId}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const state = fields[0];
    const startTimeTicks = fields[19];
    if (state === undefined || startTimeTicks === undefined) return undefined;
    return { processId, startTimeTicks, state };
  } catch {
    return undefined;
  }
}

function sameLiveProcess(identity: ProcessIdentity): boolean {
  const current = readProcessIdentity(identity.processId);
  return current !== undefined &&
    current.startTimeTicks === identity.startTimeTicks &&
    current.state !== "Z";
}

function openCoreState(path: string): FileCoreStateStore {
  return new FileCoreStateStore({
    path,
    maxFailedAttempts: 3,
    nextBlockId: () => "unused-reopen-block",
    nextDeliveryId: (kind) => `unused-reopen-${kind}`,
    now: () => new Date().toISOString(),
  });
}

describe.skipIf(!available)("Linux Module executor exit through systemd", () => {
  it("ends Core with status 1 and lets systemd remove the unowned launcher", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dolly-executor-systemd-"));
    const reportPath = join(scratch, "launcher.json");
    const statePath = join(scratch, "core.json");
    const fallbackPath = join(scratch, "fallback.json");
    const unitBase = `${UNIT_PREFIX}${process.pid}-${Date.now()}`;
    const unitName = `${unitBase}.service`;
    let unitCleaned = false;

    try {
      const command = await runCommandAllowingFailure(
        "systemd-run",
        [
          "--user",
          "--quiet",
          "--pipe",
          "--wait",
          `--unit=${unitBase}`,
          "-p",
          "Type=exec",
          "-p",
          "ExitType=main",
          "-p",
          "Restart=no",
          "-p",
          "KillMode=control-group",
          "-p",
          "SendSIGKILL=yes",
          "-p",
          "TimeoutStopSec=5",
          "-p",
          "RuntimeMaxSec=20",
          "-p",
          "Delegate=yes",
          "-p",
          "DelegateSubgroup=core",
          `--working-directory=${process.cwd()}`,
          "--",
          process.execPath,
          "--import",
          TSX_LOADER_URL.href,
          FIXTURE_PATH,
          reportPath,
          statePath,
          fallbackPath,
        ],
        40_000,
      );
      expect(command.killed, `systemd-run timed out: ${command.stderr}`).toBe(false);

      const properties = await showUnit(unitName);
      expect(Object.fromEntries(properties)).toMatchObject({
        ActiveState: "failed",
        SubState: "failed",
        Result: "exit-code",
        ExecMainCode: "1",
        ExecMainStatus: "1",
        Type: "exec",
        ExitType: "main",
        Restart: "no",
        KillMode: "control-group",
        Delegate: "yes",
        DelegateSubgroup: "core",
      });

      const fallback = existsSync(fallbackPath) ? readFileSync(fallbackPath, "utf8") : "";
      expect(fallback, "a distinct fixture fallback path ended the service").toBe("");
      expect(existsSync(reportPath), `fixture output: ${command.stdout}\n${command.stderr}`)
        .toBe(true);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as ExitFixtureReport;
      expect(report.serviceInvocationId).toBe(properties.get("InvocationID"));
      // The fixture captured live process membership from /proc before the
      // product executor ended Core. Some systemd versions clear ControlGroup
      // after the last process exits; if it is retained, it must agree with
      // that live path.
      const serviceCgroupPath = report.core.cgroupPath.slice(0, -"/core".length);
      const retainedServiceCgroupPath = properties.get("ControlGroup");
      if (retainedServiceCgroupPath !== "") {
        expect(retainedServiceCgroupPath).toBe(serviceCgroupPath);
      }
      expect(serviceCgroupPath.endsWith(`/${unitName}`)).toBe(true);
      expect(report.serviceCgroupFilesystemPath).toBe(`/sys/fs/cgroup${serviceCgroupPath}`);
      expect(report.launcher.cgroupPath).toBe(report.core.cgroupPath);
      expect(report.moduleCgroupFilesystemPath.startsWith(
        `${report.serviceCgroupFilesystemPath}/`,
      )).toBe(true);

      const state = openCoreState(statePath);
      expect(state.revision).toBe(2);
      expect(state.listModuleProcessRecords()).toEqual([
        expect.objectContaining({
          processGenerationId: report.processGenerationId,
          serviceInvocationId: report.serviceInvocationId,
          moduleCgroupPath: report.moduleCgroupFilesystemPath,
          state: "stopping",
        }),
      ]);

      expect(await waitFor(() => !sameLiveProcess(report.launcher), 5_000)).toBe(true);
      expect(await waitFor(() => !sameLiveProcess(report.core), 5_000)).toBe(true);
      expect(await waitFor(() => !existsSync(report.moduleCgroupFilesystemPath), 5_000))
        .toBe(true);
      expect(await waitFor(() => !existsSync(report.serviceCgroupFilesystemPath), 5_000))
        .toBe(true);

      // Printed output is retained by the Linux validation run and records
      // the exact systemd result and process identities that the assertions
      // above checked.
      console.info(JSON.stringify({
        unitName,
        systemdRunExitCode: command.exitCode,
        systemdRunSignal: command.signal,
        systemd: Object.fromEntries(properties),
        core: report.core,
        launcher: report.launcher,
        processRecordState: "stopping",
        moduleCgroupRemoved: true,
        serviceCgroupRemoved: true,
      }));

      await cleanupExactUnit(unitName);
      unitCleaned = true;
      const { stdout: remainingUnit } = await execFileAsync(
        "systemctl",
        ["--user", "list-units", "--all", "--no-legend", unitName],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(remainingUnit.trim()).toBe("");
    } finally {
      if (!unitCleaned) await cleanupExactUnit(unitName);
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 90_000);
});
