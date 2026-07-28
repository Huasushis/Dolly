import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CoreStateError,
  FileCoreStateStore,
} from "../../../src/core/file-core-state-store.js";
import {
  ModuleProcessRecordError,
  assertValidModuleProcessRecord,
  type ModuleProcessRecord,
  type ModuleSubmissionRecord,
} from "../../../src/core/module-process-records.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import { isDerivedModuleCgroupPath } from "../../../src/core/linux-identifier-formats.js";

const NOW = "2026-07-26T00:00:00.000Z";
const LATER = "2026-07-26T00:00:05.000Z";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const INSTANCE_ID = "instance-1";
const MODULE_ID = "worker";
const DELEGATED_ROOT = "/system.slice/dolly-core.service";
/** systemd reports an invocation identifier as 32 lower-case hexadecimal digits. */
const INVOCATION_ID = "2812432ad29e4d3bbd6776c62cafa929";
const BOOT_ID = "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9";

/** The exact path Core derives for one process generation of this fixture. */
function cgroupPathFor(processGenerationId: string): string {
  return deriveModuleCgroupPath(DELEGATED_ROOT, {
    instanceId: INSTANCE_ID,
    moduleId: MODULE_ID,
    processGenerationId,
  }).filesystemPath;
}

function processRecord(
  overrides: Partial<ModuleProcessRecord> = {},
): ModuleProcessRecord {
  const processGenerationId = overrides.processGenerationId ?? "process-generation-1";
  return {
    schemaVersion: "dolly.module-process-record/1",
    instanceId: INSTANCE_ID,
    moduleId: MODULE_ID,
    moduleGenerationId: "module-generation-1",
    processGenerationId,
    packageDigest: DIGEST_A,
    configurationReference: {
      configId: "config-1",
      revision: DIGEST_B,
      configVersion: 1,
    },
    declaredExternalEffects: "core-capabilities-only",
    serviceInvocationId: INVOCATION_ID,
    bootId: BOOT_ID,
    moduleCgroupPath: cgroupPathFor(processGenerationId),
    state: "starting",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as ModuleProcessRecord;
}

function submissionRecord(
  overrides: Partial<ModuleSubmissionRecord> = {},
): ModuleSubmissionRecord {
  return {
    schemaVersion: "dolly.module-submission-record/1",
    moduleJobId: "module-job-1",
    claimToken: "claim-token-1",
    runId: "run-1",
    attempt: 1,
    moduleGenerationId: "module-generation-1",
    processGenerationId: "process-generation-1",
    inputDigest: DIGEST_C,
    createdAt: NOW,
    ...overrides,
  } as ModuleSubmissionRecord;
}

describe("CORE Module process and submission records", () => {
  let root: string;
  let path: string;
  let clock: string;

  function openStore(prefix: string): FileCoreStateStore {
    let blockId = 0;
    let runtimeId = 0;
    return new FileCoreStateStore({
      path,
      maxFailedAttempts: 3,
      nextBlockId: () => `${prefix}-block-${++blockId}`,
      nextDeliveryId: (kind) => `${prefix}-${kind}-${++runtimeId}`,
      now: () => clock,
    });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-module-records-"));
    path = join(root, "core-state.json");
    clock = NOW;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("persists a process record before any child and reopens it unchanged", () => {
    const store = openStore("first");
    const record = store.appendModuleProcessRecord(processRecord());
    expect(record.state).toBe("starting");

    const reopened = openStore("second");
    expect(reopened.listModuleProcessRecords()).toEqual([record]);
    expect(reopened.getModuleProcessRecord("process-generation-1")).toEqual(record);
    expect(reopened.snapshot().schemaVersion).toBe("dolly.core-state/16");
  });

  it("never reuses a process-generation identifier", () => {
    const store = openStore("first");
    store.appendModuleProcessRecord(processRecord());

    expect(() => store.appendModuleProcessRecord(processRecord())).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_PROCESS_RECORD_CONFLICT",
      }),
    );
    expect(store.listModuleProcessRecords()).toHaveLength(1);
  });

  it("rejects a new record that does not begin in the starting state", () => {
    const store = openStore("first");
    expect(() =>
      store.appendModuleProcessRecord(processRecord({ state: "running" })),
    ).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_PROCESS_RECORD_STATE_INVALID",
      }),
    );
    expect(store.listModuleProcessRecords()).toEqual([]);
  });

  it("advances process state only along the permitted order", () => {
    const store = openStore("first");
    store.appendModuleProcessRecord(processRecord());
    clock = LATER;

    const running = store.updateModuleProcessRecordState("process-generation-1", "running");
    expect(running).toMatchObject({ state: "running", updatedAt: LATER });

    expect(() =>
      store.updateModuleProcessRecordState("process-generation-1", "starting"),
    ).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_PROCESS_RECORD_STATE_INVALID",
      }),
    );

    store.updateModuleProcessRecordState("process-generation-1", "stopped", "STOP_PROVEN");
    expect(store.getModuleProcessRecord("process-generation-1")).toMatchObject({
      state: "stopped",
      failureCode: "STOP_PROVEN",
    });
    expect(() =>
      store.updateModuleProcessRecordState("process-generation-1", "running"),
    ).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_PROCESS_RECORD_STATE_INVALID",
      }),
    );
  });

  it("authorizes a submission record only while its process record is running", () => {
    const store = openStore("first");
    store.appendModuleProcessRecord(processRecord());

    expect(() => store.appendModuleSubmissionRecord(submissionRecord())).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_SUBMISSION_RECORD_UNAUTHORIZED",
      }),
    );

    store.updateModuleProcessRecordState("process-generation-1", "running");
    const submission = store.appendModuleSubmissionRecord(submissionRecord());
    expect(store.getModuleSubmissionRecord("run-1")).toEqual(submission);

    expect(() => store.appendModuleSubmissionRecord(submissionRecord())).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_SUBMISSION_RECORD_CONFLICT",
      }),
    );
  });

  it("rejects a submission record with no process record or a mismatched generation", () => {
    const store = openStore("first");
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");

    expect(() =>
      store.appendModuleSubmissionRecord(
        submissionRecord({ runId: "run-2", processGenerationId: "process-generation-9" }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_SUBMISSION_RECORD_UNAUTHORIZED",
      }),
    );

    expect(() =>
      store.appendModuleSubmissionRecord(
        submissionRecord({ runId: "run-3", moduleGenerationId: "module-generation-9" }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_SUBMISSION_RECORD_UNAUTHORIZED",
      }),
    );
    expect(store.listModuleSubmissionRecords()).toEqual([]);
  });

  it("writes the Claim and the submission record in one Core-state revision each", () => {
    const store = openStore("first");
    store.deliveries.createPage("input");
    store.deliveries.registerConsumer("input", "worker", "from-now");
    const block = store.blocks.commit(
      { payload: { schema: "test.content/1", value: { text: "input" } } },
      { kind: "external", id: "console" },
    );
    store.deliveries.append("input", block.id);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    const claim = store.deliveries.claim({
      consumerId: "worker",
      pageIds: ["input"],
      moduleGenerationId: "module-generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    const beforeSubmission = store.revision;
    store.appendModuleSubmissionRecord(
      submissionRecord({
        moduleJobId: claim.moduleJobId,
        claimToken: claim.claimToken,
        runId: claim.runId,
        attempt: claim.attempt,
      }),
    );
    expect(store.revision).toBe(beforeSubmission + 1);

    const reopened = openStore("second");
    expect(reopened.deliveries.listActiveClaims()).toHaveLength(1);
    expect(reopened.listModuleSubmissionRecords()).toEqual([
      expect.objectContaining({ runId: claim.runId, moduleJobId: claim.moduleJobId }),
    ]);
    expect(reopened.listModuleProcessRecords()).toEqual([
      expect.objectContaining({ state: "running" }),
    ]);
  });

  it("pins a process record that a submission record still references", () => {
    const store = openStore("first");
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    store.appendModuleSubmissionRecord(submissionRecord());
    store.updateModuleProcessRecordState("process-generation-1", "stopped");

    expect(() => store.removeModuleProcessRecord("process-generation-1")).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_PROCESS_RECORD_IN_USE",
      }),
    );

    store.removeModuleSubmissionRecord("run-1");
    store.removeModuleProcessRecord("process-generation-1");
    expect(openStore("second").listModuleProcessRecords()).toEqual([]);
  });

  it("refuses to remove a process record that has not stopped", () => {
    const store = openStore("first");
    store.appendModuleProcessRecord(processRecord());
    expect(() => store.removeModuleProcessRecord("process-generation-1")).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_PROCESS_RECORD_IN_USE",
      }),
    );
  });

  it("rejects a stored record whose cgroup path omits its process generation", () => {
    const store = openStore("first");
    expect(() =>
      store.appendModuleProcessRecord(
        processRecord({ moduleCgroupPath: "/sys/fs/cgroup/dolly/other" }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_PROCESS_RECORD_INVALID",
      }),
    );
  });

  it("accepts exactly the control-group path Core derives", () => {
    const store = openStore("first");
    const derived = cgroupPathFor("process-generation-1");
    expect(isDerivedModuleCgroupPath(derived, "process-generation-1")).toBe(true);
    expect(store.appendModuleProcessRecord(processRecord())).toMatchObject({
      moduleCgroupPath: derived,
    });
  });

  it("rejects records carrying unknown fields or unsupported declarations", () => {
    const store = openStore("first");
    expect(() =>
      store.appendModuleProcessRecord({
        ...processRecord(),
        capabilityHandle: "secret",
      } as unknown as ModuleProcessRecord),
    ).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_PROCESS_RECORD_INVALID",
      }),
    );
    expect(() =>
      store.appendModuleProcessRecord(
        processRecord({
          declaredExternalEffects: "direct-ambient" as never,
        }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_PROCESS_RECORD_INVALID",
      }),
    );
  });

  it("fails closed when a persisted document holds an orphan submission record", () => {
    const store = openStore("first");
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    store.appendModuleSubmissionRecord(submissionRecord());

    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    document.moduleProcessRecords = [];
    writeFileSync(path, `${JSON.stringify(document)}\n`, "utf8");

    expect(() => openStore("second")).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_DOCUMENT_INVALID",
      }),
    );
  });

  /**
   * One value, one rule. These are the paths and identifiers the durable
   * record validator used to accept while `isDerivedModuleCgroupPath` and the
   * service-binding proof rejected the same values.
   */
  describe("path and identifier rules match their producers", () => {
    const rejectedPaths: readonly (readonly [string, string])[] = [
      [
        "escapes the mount point through relative segments",
        "/sys/fs/cgroup/../../etc/process-generation-1",
      ],
      ["is not below the control-group mount point", "/tmp/evil/process-generation-1"],
      [
        "is below the mount point but is not a derived directory name",
        "/sys/fs/cgroup/dolly/process-generation-1",
      ],
      [
        "carries the identifier without the derived name",
        "/sys/fs/cgroup/process-generation-1",
      ],
      [
        "hides a second line in the directory name",
        `${cgroupPathFor("process-generation-1")}\n/etc/passwd`,
      ],
      ["ends with a separator", `${cgroupPathFor("process-generation-1")}/`],
      ["is relative", "sys/fs/cgroup/dolly-module-process-generation-1-abc"],
      [
        "replaces the identity digest with arbitrary text",
        "/sys/fs/cgroup/dolly-module-process-generation-1-not-a-digest",
      ],
    ];

    for (const [label, moduleCgroupPath] of rejectedPaths) {
      it(`rejects a control-group path that ${label}`, () => {
        expect(
          isDerivedModuleCgroupPath(moduleCgroupPath, "process-generation-1"),
          `${moduleCgroupPath} must not look Core-derived`,
        ).toBe(false);
        expect(() =>
          assertValidModuleProcessRecord(processRecord({ moduleCgroupPath })),
        ).toThrowError(
          expect.objectContaining<Partial<ModuleProcessRecordError>>({
            code: "MODULE_PROCESS_RECORD_INVALID",
          }),
        );
      });
    }

    it("rejects a process-generation identifier that is not a usable directory name", () => {
      // The fixture path is built for the valid identifier, then both fields
      // are replaced: Core's own derivation refuses to produce a path for
      // these identifiers at all.
      const base = processRecord();
      for (const processGenerationId of ["../../etc", "pg/escape", "pg with space", "-lead", ""]) {
        expect(() =>
          assertValidModuleProcessRecord({
            ...base,
            processGenerationId,
            moduleCgroupPath: `/sys/fs/cgroup/dolly-module-${processGenerationId}-${"a".repeat(64)}`,
          }),
          `processGenerationId ${JSON.stringify(processGenerationId)} must be rejected`,
        ).toThrowError(
          expect.objectContaining<Partial<ModuleProcessRecordError>>({
            code: "MODULE_PROCESS_RECORD_INVALID",
          }),
        );
      }
    });

    it("rejects a service invocation identifier systemd could not have reported", () => {
      for (const serviceInvocationId of [
        "invocation-1",
        INVOCATION_ID.toUpperCase(),
        INVOCATION_ID.slice(0, 31),
        `${INVOCATION_ID}0`,
        "",
      ]) {
        expect(() =>
          assertValidModuleProcessRecord(processRecord({ serviceInvocationId })),
          `serviceInvocationId ${JSON.stringify(serviceInvocationId)} must be rejected`,
        ).toThrowError(
          expect.objectContaining<Partial<ModuleProcessRecordError>>({
            code: "MODULE_PROCESS_RECORD_INVALID",
          }),
        );
      }
    });

    it("rejects a boot identifier the Linux kernel could not have reported", () => {
      for (const bootId of [
        "not a uuid at all",
        "boot-1",
        BOOT_ID.toUpperCase(),
        BOOT_ID.replace(/-/g, ""),
        "",
      ]) {
        expect(() =>
          assertValidModuleProcessRecord(processRecord({ bootId })),
          `bootId ${JSON.stringify(bootId)} must be rejected`,
        ).toThrowError(
          expect.objectContaining<Partial<ModuleProcessRecordError>>({
            code: "MODULE_PROCESS_RECORD_INVALID",
          }),
        );
      }
    });

    it("rejects a submission record whose process generation is not a usable name", () => {
      const store = openStore("first");
      store.appendModuleProcessRecord(processRecord());
      store.updateModuleProcessRecordState("process-generation-1", "running");
      expect(() =>
        store.appendModuleSubmissionRecord(
          submissionRecord({ processGenerationId: "../../etc" }),
        ),
      ).toThrowError(
        expect.objectContaining<Partial<ModuleProcessRecordError>>({
          code: "MODULE_SUBMISSION_RECORD_INVALID",
        }),
      );
    });
  });

  it("keeps records unchanged when the atomic write of an update fails", () => {
    const store = openStore("first");
    store.appendModuleProcessRecord(processRecord());
    const before = store.revision;

    rmSync(root, { recursive: true, force: true });
    expect(() =>
      store.updateModuleProcessRecordState("process-generation-1", "running"),
    ).toThrowError(CoreStateError);
    expect(store.getModuleProcessRecord("process-generation-1")).toMatchObject({
      state: "starting",
    });
    expect(store.revision).toBe(before);
  });
});
