/**
 * Fault injection over the Core-state atomic write boundaries named in
 * `docs/spec/core-runtime.md` Section 7.7: writing the replacement file,
 * synchronizing it, renaming it, and synchronizing the parent directory.
 *
 * Every injected failure must leave exactly one complete committed view on
 * disk. Per ADR 0009 a terminal Delivery Claim transition and the matching
 * Module submission-record removal become durable in one Core-state update.
 * Recovery may observe the complete old revision or the complete new one, but
 * never a released Claim whose submission record survives, or a surviving
 * submission record without its referenced Module process record.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJsonDigest,
  type JsonValue,
} from "../../../src/core/canonical-json.js";
import {
  CoreStateError,
  FileCoreStateStore,
  migrateCoreStateDocumentToVersion16,
} from "../../../src/core/file-core-state-store.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import { type ModuleProcessRecord } from "../../../src/core/module-process-records.js";

const faults = vi.hoisted(() => ({
  beforeOpen: undefined as ((path: string, flags: string) => void) | undefined,
  afterOpen: undefined as
    | ((path: string, flags: string, descriptor: number) => void)
    | undefined,
  beforeWrite: undefined as ((target: unknown) => void) | undefined,
  beforeFsync: undefined as ((descriptor: number) => void) | undefined,
  beforeRename: undefined as ((from: string, to: string) => void) | undefined,
  afterRename: undefined as ((from: string, to: string) => void) | undefined,
  failAfterLockRelease: false,
}));

// The synchronous file operations of the atomic writer are wrapped so a test
// can fail one exact boundary. Every wrapper passes through unless its test
// installed a hook, so this file changes no behaviour of its own.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const patched = {
    ...actual,
    openSync(...args: Parameters<typeof actual.openSync>): number {
      faults.beforeOpen?.(String(args[0]), String(args[1]));
      const descriptor = actual.openSync(...args);
      faults.afterOpen?.(String(args[0]), String(args[1]), descriptor);
      return descriptor;
    },
    writeFileSync(...args: Parameters<typeof actual.writeFileSync>): void {
      faults.beforeWrite?.(args[0]);
      actual.writeFileSync(...args);
    },
    fsyncSync(...args: Parameters<typeof actual.fsyncSync>): void {
      faults.beforeFsync?.(args[0]);
      actual.fsyncSync(...args);
    },
    renameSync(...args: Parameters<typeof actual.renameSync>): void {
      faults.beforeRename?.(String(args[0]), String(args[1]));
      actual.renameSync(...args);
      faults.afterRename?.(String(args[0]), String(args[1]));
    },
  };
  return { ...patched, default: patched };
});

// This wrapper retains the real lock acquisition, callback, and release. The
// one-shot failure happens only after all three completed, which isolates the
// store's handling of a failed release confirmation from callback failures.
vi.mock("../../../src/core/synchronous-cross-process-lock.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/core/synchronous-cross-process-lock.js")>();
  return {
    ...actual,
    withSynchronousCrossProcessLock<Result>(
      options: Parameters<typeof actual.withSynchronousCrossProcessLock>[0],
      operation: () => Result,
    ): Result {
      const result = actual.withSynchronousCrossProcessLock(options, operation);
      if (faults.failAfterLockRelease) {
        faults.failAfterLockRelease = false;
        throw new actual.SynchronousCrossProcessLockError(
          "CROSS_PROCESS_LOCK_OWNERSHIP_LOST",
          "injected failure after lock release",
        );
      }
      return result;
    },
  };
});

const NOW = "2026-07-26T00:00:00.000Z";
const PACKAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const CONFIG_REVISION = `sha256:${"b".repeat(64)}`;
const INPUT_DIGEST = `sha256:${"c".repeat(64)}`;
const PROCESS_GENERATION_ID = "process-generation-1";
const MODULE_GENERATION_ID = "module-generation-1";
/** The shapes systemd and the Linux kernel report; a record stores no other. */
const INVOCATION_ID = "2812432ad29e4d3bbd6776c62cafa929";
const BOOT_ID = "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9";

interface ClaimIdentity {
  readonly moduleJobId: string;
  readonly claimToken: string;
  readonly runId: string;
  readonly attempt: number;
  readonly moduleGenerationId: string;
}

interface ClaimedState {
  readonly store: FileCoreStateStore;
  readonly blockId: string;
  readonly identity: ClaimIdentity;
  readonly revision: number;
}

function clearFaults(): void {
  faults.beforeOpen = undefined;
  faults.afterOpen = undefined;
  faults.beforeWrite = undefined;
  faults.beforeFsync = undefined;
  faults.beforeRename = undefined;
  faults.afterRename = undefined;
  faults.failAfterLockRelease = false;
}

function injectedFailure(code: string, syscall: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`injected ${syscall} failure`);
  error.code = code;
  error.syscall = syscall;
  return error;
}

function isTemporaryCoreStatePath(candidate: string): boolean {
  return candidate.endsWith(".tmp");
}

function processRecord(): ModuleProcessRecord {
  return {
    schemaVersion: "dolly.module-process-record/1",
    instanceId: "instance-1",
    moduleId: "worker",
    moduleGenerationId: MODULE_GENERATION_ID,
    processGenerationId: PROCESS_GENERATION_ID,
    packageDigest: PACKAGE_DIGEST,
    configurationReference: {
      configId: "config-1",
      revision: CONFIG_REVISION,
      configVersion: 1,
    },
    declaredExternalEffects: "core-capabilities-only",
    serviceInvocationId: INVOCATION_ID,
    bootId: BOOT_ID,
    moduleCgroupPath: deriveModuleCgroupPath("/system.slice/dolly-core.service", {
      instanceId: "instance-1",
      moduleId: "worker",
      processGenerationId: PROCESS_GENERATION_ID,
    }).filesystemPath,
    state: "starting",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("CORE state atomic write fault injection", () => {
  let root: string;
  let path: string;

  function openStore(prefix: string): FileCoreStateStore {
    let blockId = 0;
    let runtimeId = 0;
    return new FileCoreStateStore({
      path,
      maxFailedAttempts: 3,
      nextBlockId: () => `${prefix}-block-${++blockId}`,
      nextDeliveryId: (kind) => `${prefix}-${kind}-${++runtimeId}`,
      now: () => NOW,
    });
  }

  /**
   * Builds the smallest state in which a torn write is observable: one Page,
   * one consumer, one committed Block, one Delivery, one active Claim, one
   * running Module process record, and the submission record that authorizes
   * the Run of that Claim.
   */
  function seedClaimedState(prefix: string): ClaimedState {
    const store = openStore(prefix);
    store.deliveries.createPage("input");
    store.deliveries.registerConsumer("input", "worker", "from-now");
    const block = store.blocks.commit(
      { payload: { schema: "test.content/1", value: { text: "input" } } },
      { kind: "external", id: "console" },
    );
    store.deliveries.append("input", block.id);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState(PROCESS_GENERATION_ID, "running");
    const claim = store.deliveries.claim({
      consumerId: "worker",
      pageIds: ["input"],
      moduleGenerationId: MODULE_GENERATION_ID,
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    const identity: ClaimIdentity = {
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
    };
    store.appendModuleSubmissionRecord({
      schemaVersion: "dolly.module-submission-record/1",
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: MODULE_GENERATION_ID,
      processGenerationId: PROCESS_GENERATION_ID,
      inputDigest: INPUT_DIGEST,
      createdAt: NOW,
    });
    expect(store.deliveries.listActiveClaims()).toHaveLength(1);
    return { store, blockId: block.id, identity, revision: store.revision };
  }

  /**
   * The one Core-state update ADR 0009 requires: the Claim becomes terminal
   * and its submission record disappears together.
   */
  function makeClaimTerminal(state: ClaimedState): void {
    state.store.runAtomicUpdate(() => {
      state.store.deliveries.releaseClaim(state.identity);
      state.store.removeModuleSubmissionRecord(state.identity.runId);
    });
  }

  function committedRevision(): unknown {
    return (JSON.parse(readFileSync(path, "utf8")) as Record<string, JsonValue>).revision;
  }

  /**
   * Rereads the committed file and the state it reconstructs, and returns
   * which of the two permitted views survived.
   */
  function assertOneCompleteView(prefix: string, state: ClaimedState): "old" | "new" {
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, JsonValue>;
    const { schemaVersion, stateDigest, ...payload } = document;
    expect(schemaVersion).toBe("dolly.core-state/16");
    expect(canonicalJsonDigest(payload)).toBe(stateDigest);
    expect(readdirSync(root).filter(isTemporaryCoreStatePath)).toEqual([]);

    const reopened = openStore(prefix);
    const claimActive = reopened.deliveries
      .listActiveClaims()
      .some((claim) => claim.runId === state.identity.runId);
    const submission = reopened.getModuleSubmissionRecord(state.identity.runId);

    expect(submission === undefined).toBe(!claimActive);
    expect(
      reopened.referenceGraph.leaseCountFor({ kind: "block", id: state.blockId }),
    ).toBe(claimActive ? 1 : 0);
    for (const record of reopened.listModuleSubmissionRecords()) {
      const process = reopened.getModuleProcessRecord(record.processGenerationId);
      expect(process).toBeDefined();
      expect(process?.moduleGenerationId).toBe(record.moduleGenerationId);
    }
    expect(reopened.listModuleProcessRecords()).toEqual([
      expect.objectContaining({
        processGenerationId: PROCESS_GENERATION_ID,
        state: "running",
      }),
    ]);
    expect(reopened.revision).toBe(claimActive ? state.revision : state.revision + 1);
    return claimActive ? "old" : "new";
  }

  /** A store whose single write failed may not expose its in-memory view again. */
  function assertReopenRequired(state: ClaimedState): void {
    const operations: readonly [label: string, operation: () => unknown][] = [
      ["revision", () => state.store.revision],
      ["complete snapshot", () => state.store.snapshot()],
      ["flush", () => state.store.flush()],
      ["process-record list", () => state.store.listModuleProcessRecords()],
      [
        "process-record lookup",
        () => state.store.getModuleProcessRecord(PROCESS_GENERATION_ID),
      ],
      ["submission-record list", () => state.store.listModuleSubmissionRecords()],
      [
        "submission-record lookup",
        () => state.store.getModuleSubmissionRecord(state.identity.runId),
      ],
      ["reference graph", () => state.store.referenceGraph.snapshot()],
      ["Block store", () => state.store.blocks.snapshot()],
      ["Delivery store", () => state.store.deliveries.snapshot()],
      ["atomic update", () => state.store.runAtomicUpdate(() => undefined)],
    ];
    for (const [label, operation] of operations) {
      expect(operation, label).toThrowError(
        expect.objectContaining<Partial<CoreStateError>>({
          code: "CORE_STATE_REOPEN_REQUIRED",
        }),
      );
    }
  }

  /**
   * Rewrites the committed file as a `dolly.core-state/15` document holding
   * the same Page, Block, Delivery, and active Claim, and returns its exact
   * bytes.
   */
  function seedVersion15Document(): string {
    const seed = openStore("v15-seed");
    seed.deliveries.createPage("input");
    seed.deliveries.registerConsumer("input", "worker", "from-now");
    const block = seed.blocks.commit(
      { payload: { schema: "test.content/1", value: { text: "input" } } },
      { kind: "external", id: "console" },
    );
    seed.deliveries.append("input", block.id);
    seed.deliveries.claim({
      consumerId: "worker",
      pageIds: ["input"],
      moduleGenerationId: MODULE_GENERATION_ID,
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, JsonValue>;
    delete current.schemaVersion;
    delete current.stateDigest;
    delete current.moduleProcessRecords;
    delete current.moduleSubmissionRecords;
    const legacy = {
      schemaVersion: "dolly.core-state/15",
      stateDigest: canonicalJsonDigest(current),
      ...current,
    };
    const raw = `${JSON.stringify(legacy)}\n`;
    writeFileSync(path, raw, "utf8");
    return raw;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-core-state-faults-"));
    path = join(root, "core-state.json");
  });

  afterEach(() => {
    clearFaults();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the old view when the temporary file cannot be created", () => {
    const state = seedClaimedState("first");
    faults.beforeOpen = (openPath, flags) => {
      if (flags === "wx" && isTemporaryCoreStatePath(openPath)) {
        throw injectedFailure("EACCES", "open");
      }
    };

    expect(() => makeClaimTerminal(state)).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({ code: "CORE_STATE_IO_FAILED" }),
    );
    clearFaults();

    assertReopenRequired(state);
    expect(assertOneCompleteView("second", state)).toBe("old");
  });

  it("keeps the old view when the replacement payload cannot be written", () => {
    const state = seedClaimedState("first");
    faults.beforeWrite = (target) => {
      if (typeof target === "number") throw injectedFailure("ENOSPC", "write");
    };

    expect(() => makeClaimTerminal(state)).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({ code: "CORE_STATE_IO_FAILED" }),
    );
    clearFaults();

    assertReopenRequired(state);
    expect(assertOneCompleteView("second", state)).toBe("old");
  });

  it("keeps the old view when the replacement file cannot be synchronized", () => {
    const state = seedClaimedState("first");
    let temporaryDescriptor: number | undefined;
    faults.afterOpen = (openPath, flags, descriptor) => {
      if (flags === "wx" && isTemporaryCoreStatePath(openPath)) {
        temporaryDescriptor = descriptor;
      }
    };
    faults.beforeFsync = (descriptor) => {
      if (descriptor === temporaryDescriptor) throw injectedFailure("EIO", "fsync");
    };

    expect(() => makeClaimTerminal(state)).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({ code: "CORE_STATE_IO_FAILED" }),
    );
    clearFaults();
    expect(temporaryDescriptor).toBeTypeOf("number");

    assertReopenRequired(state);
    expect(assertOneCompleteView("second", state)).toBe("old");
  });

  it("keeps the old view when the atomic rename fails", () => {
    const state = seedClaimedState("first");
    faults.beforeRename = (_from, to) => {
      if (to === resolve(path)) throw injectedFailure("EPERM", "rename");
    };

    expect(() => makeClaimTerminal(state)).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({ code: "CORE_STATE_IO_FAILED" }),
    );
    clearFaults();

    assertReopenRequired(state);
    expect(assertOneCompleteView("second", state)).toBe("old");
  });

  it("recovers the complete new view when the update fails after its rename", () => {
    const state = seedClaimedState("first");
    // The rename is the commit point. This models any failure of the step that
    // follows it, which on POSIX is the parent directory synchronization.
    faults.afterRename = (_from, to) => {
      if (to === resolve(path)) throw injectedFailure("EIO", "fsync");
    };

    expect(() => makeClaimTerminal(state)).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({ code: "CORE_STATE_IO_FAILED" }),
    );
    clearFaults();

    // The write is uncertain, not favourable: the store refuses further use and
    // the exact revision is established only by rereading the file.
    assertReopenRequired(state);
    expect(assertOneCompleteView("second", state)).toBe("new");
  });

  it.skipIf(process.platform === "win32")(
    "recovers the complete new view when the parent directory cannot be synchronized",
    () => {
      const state = seedClaimedState("first");
      const parent = resolve(root);
      let directoryDescriptor: number | undefined;
      faults.afterOpen = (openPath, flags, descriptor) => {
        if (openPath === parent && flags === "r") directoryDescriptor = descriptor;
      };
      faults.beforeFsync = (descriptor) => {
        if (descriptor === directoryDescriptor) throw injectedFailure("EIO", "fsync");
      };

      expect(() => makeClaimTerminal(state)).toThrowError(
        expect.objectContaining<Partial<CoreStateError>>({
          code: "CORE_STATE_IO_FAILED",
        }),
      );
      clearFaults();
      expect(directoryDescriptor).toBeTypeOf("number");

      assertReopenRequired(state);
      expect(assertOneCompleteView("second", state)).toBe("new");
    },
  );

  it.runIf(process.platform === "win32")(
    "opens no parent directory descriptor on Windows",
    () => {
      const state = seedClaimedState("first");
      const parent = resolve(root);
      const opened: { path: string; flags: string }[] = [];
      faults.beforeOpen = (openPath, flags) => {
        opened.push({ path: openPath, flags });
      };

      makeClaimTerminal(state);
      clearFaults();

      // `fsyncDirectory` returns before opening anything on Windows, so the
      // parent directory synchronization boundary does not exist here and
      // cannot be injected; the preceding test covers it on POSIX.
      expect(opened.some((entry) => entry.path === parent)).toBe(false);
      expect(
        opened.some(
          (entry) => entry.flags === "wx" && isTemporaryCoreStatePath(entry.path),
        ),
      ).toBe(true);
      expect(assertOneCompleteView("second", state)).toBe("new");
    },
  );

  it("fails closed after a single-record write commits its rename and then fails", () => {
    // The rename is the commit point. A record API rolls its in-memory record
    // back when the write throws, so after a post-rename failure the file
    // holds the new revision while the store holds the old one. The store can
    // no longer prove that its memory equals the file, so it must refuse
    // further use rather than continue from an unproven state.
    const state = seedClaimedState("first");
    faults.afterRename = (_from, to) => {
      if (to === resolve(path)) throw injectedFailure("EIO", "fsync");
    };

    expect(() =>
      state.store.updateModuleProcessRecordState(PROCESS_GENERATION_ID, "stopping"),
    ).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({ code: "CORE_STATE_IO_FAILED" }),
    );
    clearFaults();

    // Every later operation refuses, including a read-modify-write that would
    // otherwise silently start from the stale in-memory view.
    expect(() =>
      state.store.updateModuleProcessRecordState(PROCESS_GENERATION_ID, "stopped"),
    ).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_REOPEN_REQUIRED",
      }),
    );

    // The committed file is the complete new revision and reopens cleanly.
    const reopened = openStore("second");
    expect(reopened.revision).toBe(state.revision + 1);
    expect(reopened.getModuleProcessRecord(PROCESS_GENERATION_ID)).toMatchObject({
      state: "stopping",
    });
    expect(reopened.deliveries.listActiveClaims()).toHaveLength(1);
    expect(reopened.getModuleSubmissionRecord(state.identity.runId)).toBeDefined();
  });

  it("preserves a lock callback error without requiring a reopen", () => {
    const state = seedClaimedState("first");
    const committed = readFileSync(path);
    writeFileSync(path, "{}\n", "utf8");

    try {
      expect(() =>
        state.store.updateModuleProcessRecordState(PROCESS_GENERATION_ID, "stopping"),
      ).toThrowError(
        expect.objectContaining<Partial<CoreStateError>>({
          code: "CORE_STATE_DOCUMENT_INVALID",
        }),
      );
    } finally {
      writeFileSync(path, committed);
    }

    expect(state.store.getModuleProcessRecord(PROCESS_GENERATION_ID)).toMatchObject({
      state: "running",
    });
    expect(
      state.store.updateModuleProcessRecordState(PROCESS_GENERATION_ID, "stopping"),
    ).toMatchObject({ state: "stopping" });
  });

  it("requires a reopen when lock release confirmation fails after a record commit", () => {
    const state = seedClaimedState("first");
    const readsObtainedBeforeFailure: readonly [
      label: string,
      operation: () => unknown,
    ][] = [
      ["complete snapshot", state.store.snapshot.bind(state.store)],
      ["reference graph", state.store.referenceGraph.snapshot],
      ["Block store", state.store.blocks.snapshot],
      ["Delivery store", state.store.deliveries.snapshot],
    ];
    faults.failAfterLockRelease = true;

    expect(() =>
      state.store.updateModuleProcessRecordState(PROCESS_GENERATION_ID, "stopping"),
    ).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({ code: "CORE_STATE_IO_FAILED" }),
    );
    expect(faults.failAfterLockRelease).toBe(false);

    // The callback and real release completed before the injected error. The
    // file therefore contains the new record even though the record API has
    // handled the error by restoring its previous in-memory Map entry.
    expect(committedRevision()).toBe(state.revision + 1);
    const reopened = openStore("second");
    expect(reopened.getModuleProcessRecord(PROCESS_GENERATION_ID)).toMatchObject({
      state: "stopping",
    });

    assertReopenRequired(state);
    for (const [label, operation] of readsObtainedBeforeFailure) {
      expect(operation, label).toThrowError(
        expect.objectContaining<Partial<CoreStateError>>({
          code: "CORE_STATE_REOPEN_REQUIRED",
        }),
      );
    }
  });

  it("never replaces a newer committed file after a post-rename failure", () => {
    const state = seedClaimedState("first");
    // A Delivery mutation persists through the store's mutation observer
    // instead of runAtomicUpdate. A failure after the rename therefore commits
    // revision N + 1 while the store still holds revision N in memory.
    faults.afterRename = (_from, to) => {
      if (to === resolve(path)) throw injectedFailure("EIO", "fsync");
    };

    expect(() => state.store.deliveries.createPage("second")).toThrowError();
    clearFaults();

    expect(committedRevision()).toBe(state.revision + 1);
    assertReopenRequired(state);

    // Every later write rereads the exact revision first, so the store fails
    // closed rather than replacing the newer file with its stale view.
    expect(() => state.store.deliveries.createPage("third")).toThrowError();
    expect(committedRevision()).toBe(state.revision + 1);

    const reopened = openStore("second");
    expect(reopened.revision).toBe(state.revision + 1);
    expect(reopened.deliveries.validateOutputPages(["second"])).toEqual(["second"]);
    expect(() => reopened.deliveries.validateOutputPages(["third"])).toThrowError();
    // The committed revision still carries the whole Claim view unchanged.
    expect(
      reopened.deliveries
        .listActiveClaims()
        .some((claim) => claim.runId === state.identity.runId),
    ).toBe(true);
    expect(reopened.getModuleSubmissionRecord(state.identity.runId)).toBeDefined();
  });

  it("refuses to migrate version 15 when a backup already exists", () => {
    const raw = seedVersion15Document();
    const backupPath = `${path}.v15.backup`;
    writeFileSync(backupPath, "earlier backup\n", "utf8");

    expect(() => migrateCoreStateDocumentToVersion16(path)).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({ code: "CORE_STATE_IO_FAILED" }),
    );

    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(readFileSync(backupPath, "utf8")).toBe("earlier backup\n");
    expect(() => openStore("after")).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_MIGRATION_REQUIRED",
      }),
    );
  });

  it("refuses to migrate a version 15 document whose digest does not match", () => {
    const raw = seedVersion15Document();
    const tampered = JSON.parse(raw) as Record<string, JsonValue>;
    tampered.revision = (tampered.revision as number) + 1;
    const tamperedRaw = `${JSON.stringify(tampered)}\n`;
    writeFileSync(path, tamperedRaw, "utf8");

    expect(() => migrateCoreStateDocumentToVersion16(path)).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_DOCUMENT_INVALID",
      }),
    );

    expect(existsSync(`${path}.v15.backup`)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(tamperedRaw);
  });

  it("leaves the version 15 document readable when its migration write fails", () => {
    const raw = seedVersion15Document();
    const backupPath = `${path}.v15.backup`;
    faults.beforeRename = (_from, to) => {
      if (to === resolve(path)) throw injectedFailure("EPERM", "rename");
    };

    expect(() => migrateCoreStateDocumentToVersion16(path)).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({ code: "CORE_STATE_IO_FAILED" }),
    );
    clearFaults();

    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(readdirSync(root).filter(isTemporaryCoreStatePath)).toEqual([]);
    expect(() => openStore("after")).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_MIGRATION_REQUIRED",
      }),
    );

    // The backup written before the replacement survives the failure and
    // blocks every retry until an operator removes it.
    expect(readFileSync(backupPath, "utf8")).toBe(raw);
    expect(() => migrateCoreStateDocumentToVersion16(path)).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({ code: "CORE_STATE_IO_FAILED" }),
    );
    rmSync(backupPath);
    expect(migrateCoreStateDocumentToVersion16(path)).toBe("migrated");

    const migrated = openStore("migrated");
    expect(migrated.snapshot().schemaVersion).toBe("dolly.core-state/16");
    expect(migrated.listModuleProcessRecords()).toEqual([]);
    expect(migrated.listModuleSubmissionRecords()).toEqual([]);
    expect(migrated.deliveries.listActiveClaims()).toHaveLength(1);
  });
});
