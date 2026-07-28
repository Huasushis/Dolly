import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type {
  CoreServiceBindingFailureCode,
  CoreServiceBindingResult,
  CoreServiceObservation,
} from "../../../src/core/linux-core-service-binding.js";

const execFileAsync = promisify(execFile);

const PROBE_PATH = fileURLToPath(
  new URL("./fixtures/core-service-binding-probe.ts", import.meta.url),
);
/**
 * The probe must run in the very process systemd starts, because the point of
 * this test is that the manager reports that exact process as the unit's main
 * one. The `tsx` command-line interface re-executes its script in a child
 * process, which would make the probe compare a child against the manager's
 * main process identifier. The loader is therefore imported into the current
 * process instead, by absolute path so it does not depend on a working
 * directory.
 */
const TSX_LOADER_URL = new URL(
  "../../../node_modules/tsx/dist/loader.mjs",
  import.meta.url,
);
const TSX_LOADER_PATH = fileURLToPath(TSX_LOADER_URL);

/** Node arguments that run the probe in the current process. */
function probeArgs(unitName: string, mode: string): readonly string[] {
  return ["--import", TSX_LOADER_URL.href, PROBE_PATH, unitName, mode];
}

/**
 * Every transient unit this test creates carries the `dolly-test-` prefix and
 * `--collect`, so systemd removes the unit and its whole control group as soon
 * as the probe exits.
 */
const UNIT_PREFIX = "dolly-test-binding-";

const COMMON_UNIT_PROPERTIES = [
  "-p",
  "Type=exec",
  "-p",
  "KillMode=control-group",
  "-p",
  "SendSIGKILL=yes",
  "-p",
  "TimeoutStopSec=20",
  "-p",
  "Restart=on-failure",
  "-p",
  "StartLimitBurst=3",
  "-p",
  "StartLimitIntervalSec=60",
  "-p",
  "ExitType=main",
  "-p",
  "RestartMode=normal",
  "-p",
  "Delegate=yes",
];

interface ProbeOutput {
  readonly pid: number;
  readonly observed: boolean;
  readonly observation?: CoreServiceObservation;
  readonly result?: CoreServiceBindingResult;
  readonly failures?: readonly { readonly code: CoreServiceBindingFailureCode }[];
}

/** The probe writes exactly one JSON line; anything else is a probe failure. */
function parseProbeOutput(stdout: string): ProbeOutput {
  for (const line of stdout.split("\n").reverse()) {
    const candidate = line.trim();
    if (!candidate.startsWith("{")) continue;
    const parsed = JSON.parse(candidate) as ProbeOutput;
    if (typeof parsed.observed === "boolean") return parsed;
  }
  throw new Error(`the probe printed no result line; its output was:\n${stdout}`);
}

function skipReason(): string | undefined {
  if (process.platform !== "linux") {
    return `requires Linux with systemd; this run is on ${process.platform}`;
  }
  if (!process.env.XDG_RUNTIME_DIR) {
    return "requires a running systemd user manager (XDG_RUNTIME_DIR is unset)";
  }
  if (!existsSync(TSX_LOADER_PATH)) {
    return `requires the tsx development dependency at ${TSX_LOADER_PATH}`;
  }
  return undefined;
}

const reason = skipReason();

/**
 * Skips at run time rather than at collection so the reporter still names the
 * test and carries the reason. A run that cannot reach systemd must never look
 * like a passing one.
 */
function requireSystemd(ctx: { skip: (note?: string) => void }): void {
  if (reason) ctx.skip(reason);
}

async function runProbeInTransientService(
  unitSuffix: string,
  extraProperties: readonly string[],
): Promise<ProbeOutput> {
  const unitName = `${UNIT_PREFIX}${unitSuffix}`;
  const args = [
    "--user",
    "--pipe",
    "--wait",
    "--collect",
    `--unit=${unitName}`,
    ...COMMON_UNIT_PROPERTIES,
    ...extraProperties,
    "--",
    process.execPath,
    ...probeArgs(`${unitName}.service`, "user"),
  ];
  try {
    const { stdout } = await execFileAsync("systemd-run", args, {
      encoding: "utf8",
      timeout: 60_000,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseProbeOutput(stdout);
  } finally {
    // `--collect` already removes a unit that exited, so this only cleans up
    // after a failed run and must never fail the test itself.
    await execFileAsync("systemctl", ["--user", "reset-failed", `${unitName}.service`], {
      encoding: "utf8",
      timeout: 10_000,
    }).catch(() => undefined);
  }
}

function failureCodesOf(result: CoreServiceBindingResult): readonly string[] {
  return result.verified ? [] : result.failures.map((failure) => failure.code);
}

describe("Core service binding against a real systemd service", () => {
  it("proves both directions inside a delegated transient service", async (ctx) => {
    requireSystemd(ctx);
    const output = await runProbeInTransientService("ok", [
      "-p",
      "DelegateSubgroup=core",
    ]);
    expect(output.observed).toBe(true);
    const observation = output.observation!;

    // Direction 1: the manager reports the probe process as the unit's main one.
    expect(observation.unit.mainPid).toBe(output.pid);
    expect(observation.selfPid).toBe(output.pid);

    // Direction 2: the probe's own control group is the delegated subgroup of
    // the control group the manager reports, not the reported path itself.
    expect(observation.unit.controlGroup).toMatch(/\.service$/);
    expect(observation.selfCgroupPath).toBe(`${observation.unit.controlGroup}/core`);
    expect(observation.selfCgroupPath).not.toBe(observation.unit.controlGroup);

    // The two identifiers a Module process record persists.
    expect(observation.unit.invocationId).toMatch(/^[0-9a-f]{32}$/);
    expect(observation.bootId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    expect(observation.cgroupFilesystemIsV2).toBe(true);
    expect(observation.delegatedRootControllers).toEqual(
      expect.arrayContaining(["cpu", "memory", "pids"]),
    );

    // A server without user lingering is a known deployment blocker, so it is
    // the one failure this environment may still report. Nothing else may fail.
    expect(failureCodesOf(output.result!)).toEqual(
      observation.lingerEnabled === true ? [] : ["CORE_SERVICE_USER_LINGERING_DISABLED"],
    );
  }, 90_000);

  it("rejects a service that does not delegate a core subgroup", async (ctx) => {
    requireSystemd(ctx);
    const output = await runProbeInTransientService("nosub", []);
    expect(output.observed).toBe(true);
    expect(output.observation!.unit.delegateSubgroup).toBe("");
    // Without a subgroup the main process runs in the delegated root itself,
    // which is exactly the topology ADR 0009 forbids.
    expect(output.observation!.selfCgroupPath).toBe(
      output.observation!.unit.controlGroup,
    );
    expect(failureCodesOf(output.result!)).toContain(
      "CORE_SERVICE_DELEGATE_SUBGROUP_INVALID",
    );
  }, 90_000);

  it("rejects a service whose ExitType keeps it active after the main process exits", async (ctx) => {
    requireSystemd(ctx);
    const output = await runProbeInTransientService("exittype", [
      "-p",
      "DelegateSubgroup=core",
      "-p",
      "ExitType=cgroup",
    ]);
    expect(output.observed).toBe(true);
    expect(output.observation!.unit.exitType).toBe("cgroup");
    expect(failureCodesOf(output.result!)).toContain("CORE_SERVICE_EXIT_TYPE_INVALID");
  }, 90_000);

  it("rejects a restart mode and success status that weaken forced-exit handling", async (ctx) => {
    requireSystemd(ctx);
    const output = await runProbeInTransientService("weak", [
      "-p",
      "DelegateSubgroup=core",
      "-p",
      "RestartMode=direct",
      "-p",
      "SuccessExitStatus=SIGKILL",
      "-p",
      "Restart=no",
    ]);
    expect(output.observed).toBe(true);
    // systemd reports SuccessExitStatus as one exit-code list and one signal
    // list, so a forced termination signal appears in the second list.
    expect(output.observation!.unit.successExitStatus).toEqual({
      exitCodes: [],
      signals: [9],
    });
    expect(failureCodesOf(output.result!)).toEqual(
      expect.arrayContaining([
        "CORE_SERVICE_RESTART_POLICY_INVALID",
        "CORE_SERVICE_RESTART_MODE_INVALID",
        "CORE_SERVICE_SUCCESS_EXIT_STATUS_OVERRIDDEN",
      ]),
    );
  }, 90_000);

  it("rejects a process that is not the main process of the unit it names", async (ctx) => {
    requireSystemd(ctx);
    const unitName = `${UNIT_PREFIX}live`;
    await execFileAsync(
      "systemd-run",
      [
        "--user",
        `--unit=${unitName}`,
        "-p",
        "Type=exec",
        "-p",
        "Delegate=yes",
        "-p",
        "DelegateSubgroup=core",
        "--",
        "/bin/sleep",
        "60",
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    try {
      // This test process runs in its own control group, not the unit's, so
      // both directions of the binding must fail for the live unit it names.
      const { stdout } = await execFileAsync(
        process.execPath,
        [...probeArgs(`${unitName}.service`, "user")],
        { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
      );
      const output = parseProbeOutput(stdout);
      expect(output.observed).toBe(true);
      expect(output.observation!.unit.mainPid).not.toBe(output.pid);
      expect(failureCodesOf(output.result!)).toEqual(
        expect.arrayContaining([
          "CORE_SERVICE_MAIN_PID_MISMATCH",
          "CORE_SERVICE_CGROUP_MISMATCH",
        ]),
      );
    } finally {
      await execFileAsync("systemctl", ["--user", "stop", `${unitName}.service`], {
        encoding: "utf8",
        timeout: 30_000,
      }).catch(() => undefined);
      await execFileAsync(
        "systemctl",
        ["--user", "reset-failed", `${unitName}.service`],
        { encoding: "utf8", timeout: 10_000 },
      ).catch(() => undefined);
    }
  }, 120_000);

  it("fails closed when the named unit is not loaded", async (ctx) => {
    requireSystemd(ctx);
    const { stdout } = await execFileAsync(
      process.execPath,
      [...probeArgs(`${UNIT_PREFIX}absent.service`, "user")],
      { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    );
    const output = parseProbeOutput(stdout);
    expect(output.observed).toBe(false);
    expect(output.failures!.map((failure) => failure.code)).toEqual([
      "CORE_SERVICE_UNIT_NOT_FOUND",
    ]);
  }, 90_000);

  it("leaves no test unit or control group behind", async (ctx) => {
    requireSystemd(ctx);
    const { stdout: units } = await execFileAsync(
      "systemctl",
      ["--user", "list-units", "--all", "--no-legend", `${UNIT_PREFIX}*`],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(units.trim()).toBe("");
    // `find` exits non-zero on any unrelated unreadable directory, so its
    // matches are read from the error too rather than being discarded.
    const { stdout: cgroups } = await execFileAsync(
      "find",
      ["/sys/fs/cgroup", "-maxdepth", "10", "-name", `${UNIT_PREFIX}*`],
      { encoding: "utf8", timeout: 20_000 },
    ).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
    expect(cgroups.trim()).toBe("");
  }, 60_000);
});
