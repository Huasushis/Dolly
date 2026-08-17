import { describe, expect, it, vi } from "vitest";
import {
  NO_ENVIRONMENT_EXPANSION_FLAG,
  collectCoreServiceObservation,
  inspectCgroupFilesystemVersion2,
  inspectCoreServiceBinding,
  parseBootId,
  parseCgroupControllers,
  parseInvocationId,
  parseLingerProperty,
  parseProcessCgroupPath,
  verifyCoreServiceBinding,
  type CoreServiceBindingFailureCode,
  type CoreServiceExecCommand,
  type CoreServiceObservation,
  type CoreServiceUnitProperties,
} from "../../../src/core/linux-core-service-binding.js";

// Host-owned platform observation. Defaulting to the real platform keeps every
// existing Linux test unchanged; only the refusal test overrides it so the
// non-Linux refusal is provable on Linux CI, matching the activation-decision
// test pattern in linux-module-activation.test.ts.
const platformMock = vi.hoisted(() => ({
  observe: vi.fn<() => NodeJS.Platform>(() => process.platform),
}));

vi.mock("../../../src/core/host-platform.js", () => ({
  observeHostPlatform: platformMock.observe,
}));

const SERVICE_CGROUP =
  "/user.slice/user-1000.slice/user@1000.service/app.slice/dolly-core.service";
const CORE_CGROUP = `${SERVICE_CGROUP}/core`;
const INVOCATION_ID = "2812432ad29e4d3bbd6776c62cafa929";
const BOOT_ID = "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9";
const SELF_PID = 4242;

/**
 * The installed Core command: absolute Node.js and Dolly paths, started with
 * the systemd `:` prefix that suppresses environment-variable expansion.
 */
function execStart(
  overrides: Partial<CoreServiceExecCommand> = {},
): readonly CoreServiceExecCommand[] {
  return [
    {
      path: "/usr/bin/node",
      argumentVector: [
        "/usr/bin/node",
        "/opt/dolly/bin/dolly.js",
        "run",
        "--config",
        "/etc/dolly/instance.json",
      ],
      flags: [NO_ENVIRONMENT_EXPANSION_FLAG],
      ...overrides,
    },
  ];
}

function unitProperties(
  overrides: Partial<CoreServiceUnitProperties> = {},
): CoreServiceUnitProperties {
  return {
    invocationId: INVOCATION_ID,
    startLimitBurst: 3,
    startLimitIntervalUSec: 60_000_000,
    mainPid: SELF_PID,
    controlGroup: SERVICE_CGROUP,
    type: "exec",
    restart: "on-failure",
    killMode: "control-group",
    sendSigkill: true,
    timeoutStopUSec: 20_000_000,
    delegate: true,
    delegateSubgroup: "core",
    exitType: "main",
    restartMode: "normal",
    remainAfterExit: false,
    successExitStatus: { exitCodes: [], signals: [] },
    restartPreventExitStatus: { exitCodes: [], signals: [] },
    passEnvironment: [],
    environmentFiles: [],
    execStart: execStart(),
    user: "",
    ...overrides,
  };
}

function observation(
  overrides: Partial<CoreServiceObservation> = {},
  unitOverrides: Partial<CoreServiceUnitProperties> = {},
): CoreServiceObservation {
  return {
    mode: "user",
    unitName: "dolly-core.service",
    selfPid: SELF_PID,
    selfCgroupPath: CORE_CGROUP,
    bootId: BOOT_ID,
    unit: unitProperties(unitOverrides),
    delegatedRootControllers: ["cpu", "memory", "pids"],
    cgroupFilesystemIsV2: true,
    lingerEnabled: true,
    ...overrides,
  };
}

function failureCodes(
  value: CoreServiceObservation,
): readonly CoreServiceBindingFailureCode[] {
  const result = verifyCoreServiceBinding(value);
  return result.verified ? [] : result.failures.map((failure) => failure.code);
}

/** Asserts that one weakening produces exactly one named rejection. */
function expectOnlyFailure(
  value: CoreServiceObservation,
  code: CoreServiceBindingFailureCode,
): void {
  expect(failureCodes(value)).toEqual([code]);
}

describe("Core service binding, accepted service", () => {
  it("verifies both directions and reports the identifiers a process record persists", () => {
    const result = verifyCoreServiceBinding(observation());
    expect(result.verified).toBe(true);
    if (!result.verified) return;
    expect(result.binding).toEqual({
      mode: "user",
      unitName: "dolly-core.service",
      serviceInvocationId: INVOCATION_ID,
      bootId: BOOT_ID,
      mainPid: SELF_PID,
      delegatedRootCgroupPath: SERVICE_CGROUP,
      coreCgroupPath: CORE_CGROUP,
      delegatedRootControllers: ["cpu", "memory", "pids"],
    });
  });

  it("accepts a system service with a dedicated account and ignores lingering there", () => {
    const result = verifyCoreServiceBinding(
      observation(
        { mode: "system", lingerEnabled: false },
        { user: "dolly" },
      ),
    );
    expect(result.verified).toBe(true);
  });

  it("accepts extra controllers beyond the required cpu, memory, and pids", () => {
    const result = verifyCoreServiceBinding(
      observation({ delegatedRootControllers: ["cpu", "io", "memory", "pids"] }),
    );
    expect(result.verified).toBe(true);
  });
});

describe("Core service binding, two-direction proof", () => {
  it("rejects a manager-reported main process that is not this process", () => {
    expectOnlyFailure(
      observation({}, { mainPid: SELF_PID + 1 }),
      "CORE_SERVICE_MAIN_PID_MISMATCH",
    );
  });

  it("rejects a unit with no main process at all", () => {
    expectOnlyFailure(
      observation({}, { mainPid: 0 }),
      "CORE_SERVICE_MAIN_PID_MISMATCH",
    );
  });

  it("rejects a process sitting in the delegated root instead of its core subgroup", () => {
    // The manager reports the service root while the main process must live in
    // the delegated subgroup. Comparing against the reported path directly
    // would wrongly accept this observation.
    expectOnlyFailure(
      observation({ selfCgroupPath: SERVICE_CGROUP }),
      "CORE_SERVICE_CGROUP_MISMATCH",
    );
  });

  it("rejects a process running in another unit's control group", () => {
    expectOnlyFailure(
      observation({
        selfCgroupPath:
          "/user.slice/user-1000.slice/user@1000.service/app.slice/other.service/core",
      }),
      "CORE_SERVICE_CGROUP_MISMATCH",
    );
  });

  it("rejects a manager reply without a control group", () => {
    expectOnlyFailure(
      observation({}, { controlGroup: "" }),
      "CORE_SERVICE_CONTROL_GROUP_UNAVAILABLE",
    );
  });

  it("rejects an unreadable process control group", () => {
    expectOnlyFailure(
      observation({ selfCgroupPath: undefined }),
      "CORE_SERVICE_PROCESS_CGROUP_UNAVAILABLE",
    );
  });

  it("rejects a missing invocation identifier", () => {
    expectOnlyFailure(
      observation({}, { invocationId: "" }),
      "CORE_SERVICE_INVOCATION_ID_UNAVAILABLE",
    );
  });

  it("rejects an unreadable Linux boot identifier", () => {
    expectOnlyFailure(
      observation({ bootId: undefined }),
      "CORE_SERVICE_BOOT_ID_UNAVAILABLE",
    );
  });
});

describe("Core service binding, effective unit settings", () => {
  it("requires Type=exec", () => {
    expectOnlyFailure(observation({}, { type: "simple" }), "CORE_SERVICE_TYPE_INVALID");
  });

  it("requires Restart=on-failure", () => {
    expectOnlyFailure(
      observation({}, { restart: "always" }),
      "CORE_SERVICE_RESTART_POLICY_INVALID",
    );
  });

  it("rejects a zero restart burst, which disables the restart limit", () => {
    expectOnlyFailure(
      observation({}, { startLimitBurst: 0 }),
      "CORE_SERVICE_RESTART_LIMIT_INVALID",
    );
  });

  it("rejects a zero restart interval, which disables the restart limit", () => {
    expectOnlyFailure(
      observation({}, { startLimitIntervalUSec: 0 }),
      "CORE_SERVICE_RESTART_LIMIT_INVALID",
    );
  });

  it("rejects an infinite restart interval", () => {
    expectOnlyFailure(
      observation({}, { startLimitIntervalUSec: Number.POSITIVE_INFINITY }),
      "CORE_SERVICE_RESTART_LIMIT_INVALID",
    );
  });

  it("requires KillMode=control-group", () => {
    expectOnlyFailure(
      observation({}, { killMode: "process" }),
      "CORE_SERVICE_KILL_MODE_INVALID",
    );
  });

  it("requires SendSIGKILL", () => {
    expectOnlyFailure(
      observation({}, { sendSigkill: false }),
      "CORE_SERVICE_SIGKILL_DISABLED",
    );
  });

  it("rejects an infinite stop timeout", () => {
    expectOnlyFailure(
      observation({}, { timeoutStopUSec: Number.POSITIVE_INFINITY }),
      "CORE_SERVICE_STOP_TIMEOUT_INVALID",
    );
  });

  it("rejects a zero stop timeout", () => {
    expectOnlyFailure(
      observation({}, { timeoutStopUSec: 0 }),
      "CORE_SERVICE_STOP_TIMEOUT_INVALID",
    );
  });

  it("requires Delegate", () => {
    expectOnlyFailure(
      observation({}, { delegate: false }),
      "CORE_SERVICE_DELEGATION_DISABLED",
    );
  });

  it("requires DelegateSubgroup=core when the process sits in the delegated root", () => {
    // Without a subgroup the main process is in the delegated root itself, so
    // the binding still holds; only the topology requirement is violated.
    expectOnlyFailure(
      observation({ selfCgroupPath: SERVICE_CGROUP }, { delegateSubgroup: "" }),
      "CORE_SERVICE_DELEGATE_SUBGROUP_INVALID",
    );
  });

  it("rejects a delegated subgroup with another name", () => {
    expect(
      failureCodes(
        observation(
          { selfCgroupPath: `${SERVICE_CGROUP}/worker` },
          { delegateSubgroup: "worker" },
        ),
      ),
    ).toEqual(["CORE_SERVICE_DELEGATE_SUBGROUP_INVALID"]);
  });

  it("requires control-group version 2", () => {
    expectOnlyFailure(
      observation({ cgroupFilesystemIsV2: false }),
      "CORE_SERVICE_CGROUP_V2_UNAVAILABLE",
    );
  });

  it("rejects a delegated root missing a required controller", () => {
    expectOnlyFailure(
      observation({ delegatedRootControllers: ["cpu", "pids"] }),
      "CORE_SERVICE_CONTROLLER_UNAVAILABLE",
    );
  });

  it("rejects an unreadable delegated root controller list", () => {
    expectOnlyFailure(
      observation({ delegatedRootControllers: undefined }),
      "CORE_SERVICE_CONTROLLER_UNAVAILABLE",
    );
  });

  it("requires ExitType=main", () => {
    expectOnlyFailure(
      observation({}, { exitType: "cgroup" }),
      "CORE_SERVICE_EXIT_TYPE_INVALID",
    );
  });

  it("requires RestartMode=normal", () => {
    expectOnlyFailure(
      observation({}, { restartMode: "direct" }),
      "CORE_SERVICE_RESTART_MODE_INVALID",
    );
  });
});

describe("Core service binding, settings that weaken the required semantics", () => {
  it("rejects RemainAfterExit", () => {
    expectOnlyFailure(
      observation({}, { remainAfterExit: true }),
      "CORE_SERVICE_REMAIN_AFTER_EXIT_ENABLED",
    );
  });

  it("rejects SuccessExitStatus that treats a forced termination signal as success", () => {
    expectOnlyFailure(
      observation({}, { successExitStatus: { exitCodes: [], signals: [9] } }),
      "CORE_SERVICE_SUCCESS_EXIT_STATUS_OVERRIDDEN",
    );
  });

  it("rejects SuccessExitStatus that treats a failure exit code as success", () => {
    expectOnlyFailure(
      observation({}, { successExitStatus: { exitCodes: [1], signals: [] } }),
      "CORE_SERVICE_SUCCESS_EXIT_STATUS_OVERRIDDEN",
    );
  });

  it("rejects RestartPreventExitStatus that suppresses the required restart", () => {
    expectOnlyFailure(
      observation({}, { restartPreventExitStatus: { exitCodes: [1], signals: [] } }),
      "CORE_SERVICE_RESTART_PREVENT_EXIT_STATUS_OVERRIDDEN",
    );
  });

  it("rejects RestartPreventExitStatus naming a termination signal", () => {
    expectOnlyFailure(
      observation({}, { restartPreventExitStatus: { exitCodes: [], signals: [15] } }),
      "CORE_SERVICE_RESTART_PREVENT_EXIT_STATUS_OVERRIDDEN",
    );
  });

  it("rejects an inherited environment declared through PassEnvironment", () => {
    expectOnlyFailure(
      observation({}, { passEnvironment: ["PATH"] }),
      "CORE_SERVICE_ENVIRONMENT_NOT_MINIMAL",
    );
  });

  it("rejects an environment file, which is not an explicit minimal environment", () => {
    expectOnlyFailure(
      observation({}, { environmentFiles: ["/etc/default/dolly"] }),
      "CORE_SERVICE_ENVIRONMENT_NOT_MINIMAL",
    );
  });

  it("rejects an inherited-environment sentinel imported by name", () => {
    // The sentinel a deployment test sets in the service manager's own
    // environment must not reach Core through the unit.
    expectOnlyFailure(
      observation({}, { passEnvironment: ["DOLLY_INHERITED_ENVIRONMENT_SENTINEL"] }),
      "CORE_SERVICE_ENVIRONMENT_NOT_MINIMAL",
    );
    const detail = verifyCoreServiceBinding(
      observation({}, { passEnvironment: ["DOLLY_INHERITED_ENVIRONMENT_SENTINEL"] }),
    );
    expect(detail.verified).toBe(false);
    if (detail.verified) return;
    expect(detail.failures[0]!.detail).toContain("DOLLY_INHERITED_ENVIRONMENT_SENTINEL");
  });
});

describe("Core service binding, the command the manager executes", () => {
  it("accepts one absolute installed command started with the systemd colon prefix", () => {
    expect(verifyCoreServiceBinding(observation()).verified).toBe(true);
  });

  it("rejects an ExecStart that lets systemd expand environment variables", () => {
    expectOnlyFailure(
      observation({}, { execStart: execStart({ flags: [] }) }),
      "CORE_SERVICE_EXEC_START_ENVIRONMENT_EXPANDED",
    );
    expectOnlyFailure(
      observation({}, { execStart: execStart({ flags: ["ignore-failure"] }) }),
      "CORE_SERVICE_EXEC_START_ENVIRONMENT_EXPANDED",
    );
  });

  it("rejects an executable path containing spaces", () => {
    expectOnlyFailure(
      observation({}, { execStart: execStart({ path: "/opt/dolly runtime/bin/node" }) }),
      "CORE_SERVICE_EXEC_START_PATH_INVALID",
    );
  });

  it("rejects an executable path containing literal variable-like text", () => {
    for (const path of [
      "/opt/${DOLLY_HOME}/bin/node",
      "/opt/$DOLLY_HOME/bin/node",
      "/opt/dolly/%i/bin/node",
    ]) {
      const result = verifyCoreServiceBinding(
        observation({}, { execStart: execStart({ path }) }),
      );
      expect(result.verified, path).toBe(false);
      if (result.verified) continue;
      expect(result.failures.map((failure) => failure.code)).toEqual([
        "CORE_SERVICE_EXEC_START_PATH_INVALID",
      ]);
    }
  });

  it("rejects an executable path that is relative or carries relative segments", () => {
    for (const path of ["node", "opt/dolly/bin/node", "/opt/dolly/../bin/node", "/"]) {
      const result = verifyCoreServiceBinding(
        observation({}, { execStart: execStart({ path }) }),
      );
      expect(result.verified, path).toBe(false);
      if (result.verified) continue;
      expect(result.failures.map((failure) => failure.code)).toEqual([
        "CORE_SERVICE_EXEC_START_PATH_INVALID",
      ]);
    }
  });

  it("rejects shell syntax in the executable path", () => {
    expectOnlyFailure(
      observation({}, { execStart: execStart({ path: "/bin/sh -c '/opt/dolly/start'" }) }),
      "CORE_SERVICE_EXEC_START_PATH_INVALID",
    );
  });

  it("rejects variable-like text in an argument", () => {
    expectOnlyFailure(
      observation(
        {},
        {
          execStart: execStart({
            argumentVector: ["/usr/bin/node", "/opt/dolly/bin/dolly.js", "run", "$DOLLY_ARGS"],
          }),
        },
      ),
      "CORE_SERVICE_EXEC_START_ENVIRONMENT_EXPANDED",
    );
  });

  it("rejects a missing or multi-command ExecStart", () => {
    expectOnlyFailure(observation({}, { execStart: [] }), "CORE_SERVICE_EXEC_START_PATH_INVALID");
    expectOnlyFailure(
      observation({}, { execStart: [...execStart(), ...execStart()] }),
      "CORE_SERVICE_EXEC_START_PATH_INVALID",
    );
  });
});

describe("Core service binding, bounded control-group mount inspection", () => {
  it("reads the filesystem type of a control-group version 2 mount", async () => {
    // 0x63677270 is CGROUP2_SUPER_MAGIC.
    await expect(
      inspectCgroupFilesystemVersion2("/sys/fs/cgroup", 1_000, async () => ({
        type: 0x63677270,
      })),
    ).resolves.toBe(true);
    await expect(
      inspectCgroupFilesystemVersion2("/sys/fs/cgroup", 1_000, async () => ({
        type: 0x27e0eb,
      })),
    ).resolves.toBe(false);
  });

  it("fails closed rather than treating an unreadable mount as version 2", async () => {
    await expect(
      inspectCgroupFilesystemVersion2("/sys/fs/cgroup", 1_000, () =>
        Promise.reject(new Error("EACCES")),
      ),
    ).resolves.toBe(false);
  });

  it("bounds a mount whose filesystem type never comes back", async () => {
    const started = Date.now();
    // A `statfs` on an unresponsive mount never settles; the module's own
    // bound must end the wait, because `statfs` takes no abort signal.
    await expect(
      inspectCgroupFilesystemVersion2("/sys/fs/cgroup", 25, () => new Promise(() => {})),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "CORE_SERVICE_QUERY_TIMEOUT" }),
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("Core service binding, service-manager lifetime", () => {
  it("rejects a user service without lingering", () => {
    // This is the current state of the authorized test server: the service
    // manager would stop when the last login session ends.
    const result = verifyCoreServiceBinding(observation({ lingerEnabled: false }));
    expect(result.verified).toBe(false);
    if (result.verified) return;
    expect(result.failures.map((failure) => failure.code)).toEqual([
      "CORE_SERVICE_USER_LINGERING_DISABLED",
    ]);
    expect(result.failures[0]!.detail).toContain("lingering is disabled");
  });

  it("rejects a user service whose lingering could not be determined", () => {
    expectOnlyFailure(
      observation({ lingerEnabled: undefined }),
      "CORE_SERVICE_USER_LINGERING_UNKNOWN",
    );
  });

  it("rejects a system service without a dedicated account", () => {
    expectOnlyFailure(
      observation({ mode: "system", lingerEnabled: undefined }, { user: "" }),
      "CORE_SERVICE_ACCOUNT_INVALID",
    );
  });

  it("rejects a system service running as root", () => {
    expectOnlyFailure(
      observation({ mode: "system", lingerEnabled: undefined }, { user: "root" }),
      "CORE_SERVICE_ACCOUNT_INVALID",
    );
  });
});

describe("Core service binding, reported failures", () => {
  it("reports every violation together instead of only the first", () => {
    const codes = failureCodes(
      observation(
        { cgroupFilesystemIsV2: false, lingerEnabled: false },
        { type: "simple", remainAfterExit: true },
      ),
    );
    expect(codes).toEqual(
      expect.arrayContaining([
        "CORE_SERVICE_TYPE_INVALID",
        "CORE_SERVICE_CGROUP_V2_UNAVAILABLE",
        "CORE_SERVICE_REMAIN_AFTER_EXIT_ENABLED",
        "CORE_SERVICE_USER_LINGERING_DISABLED",
      ]),
    );
  });

  it("never reports a binding when any check failed", () => {
    const result = verifyCoreServiceBinding(observation({ bootId: undefined }));
    expect(result.verified).toBe(false);
    expect(result).not.toHaveProperty("binding");
  });
});

describe("Core service binding, systemd value parsing", () => {
  it("reads the unified control-group path of the calling process", () => {
    expect(parseProcessCgroupPath(`0::${CORE_CGROUP}\n`)).toBe(CORE_CGROUP);
  });

  it("keeps a colon inside a control-group path", () => {
    expect(parseProcessCgroupPath("0::/app.slice/a:b.service/core\n")).toBe(
      "/app.slice/a:b.service/core",
    );
  });

  it("rejects a hybrid hierarchy that still exposes control-group version 1 lines", () => {
    expect(
      parseProcessCgroupPath(`0::${CORE_CGROUP}\n1:name=systemd:/user.slice\n`),
    ).toBeUndefined();
  });

  it("rejects an empty or malformed process control-group file", () => {
    expect(parseProcessCgroupPath("")).toBeUndefined();
    expect(parseProcessCgroupPath("garbage\n")).toBeUndefined();
    expect(parseProcessCgroupPath("0::relative/path\n")).toBeUndefined();
  });

  it("reads a Linux boot identifier and rejects anything else", () => {
    expect(parseBootId(`${BOOT_ID}\n`)).toBe(BOOT_ID);
    expect(parseBootId("not-a-boot-id\n")).toBeUndefined();
    expect(parseBootId("")).toBeUndefined();
  });

  it("reads an invocation identifier from the byte array systemd reports", () => {
    const bytes = [
      0x28, 0x12, 0x43, 0x2a, 0xd2, 0x9e, 0x4d, 0x3b, 0xbd, 0x67, 0x76, 0xc6, 0x2c,
      0xaf, 0xa9, 0x29,
    ];
    expect(parseInvocationId(bytes)).toBe(INVOCATION_ID);
    expect(parseInvocationId(Buffer.from(bytes).toString("base64"))).toBe(INVOCATION_ID);
  });

  it("rejects an absent or malformed invocation identifier", () => {
    expect(parseInvocationId(new Array(16).fill(0))).toBeUndefined();
    expect(parseInvocationId([1, 2, 3])).toBeUndefined();
    expect(parseInvocationId(undefined)).toBeUndefined();
    expect(parseInvocationId(42)).toBeUndefined();
  });

  it("reads the delegated root controller list", () => {
    expect(parseCgroupControllers("cpu memory pids\n")).toEqual([
      "cpu",
      "memory",
      "pids",
    ]);
    expect(parseCgroupControllers("\n")).toEqual([]);
  });

  it("reads user lingering and treats an unknown value as undetermined", () => {
    expect(parseLingerProperty("yes\n")).toBe(true);
    expect(parseLingerProperty("no\n")).toBe(false);
    expect(parseLingerProperty("")).toBeUndefined();
    expect(parseLingerProperty("Failed to get user: No such process\n")).toBeUndefined();
  });
});

describe("Core service binding, unsupported platform", () => {
  it("types the non-Linux platform refusal with zero probes on any host", async () => {
    // A nonexistent busctl proves the refusal precedes any service-manager
    // probe: the platform gate must fire before busctl is even consulted.
    const options = {
      unitName: "dolly-core.service",
      mode: "user" as const,
      busctlPath: "/nonexistent/dolly-test-busctl",
    };

    platformMock.observe.mockReturnValueOnce("win32");
    const collected = await collectCoreServiceObservation(options);
    expect(collected.observed).toBe(false);
    if (collected.observed) throw new Error("expected a refusal");
    expect(collected.failures.map((failure) => failure.code)).toEqual([
      "CORE_SERVICE_PLATFORM_UNSUPPORTED",
    ]);

    platformMock.observe.mockReturnValueOnce("darwin");
    const inspected = await inspectCoreServiceBinding(options);
    expect(inspected.verified).toBe(false);
    if (inspected.verified) throw new Error("expected a refusal");
    expect(inspected.failures.map((failure) => failure.code)).toEqual([
      "CORE_SERVICE_PLATFORM_UNSUPPORTED",
    ]);
  });
});
