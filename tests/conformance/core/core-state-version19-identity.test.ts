/**
 * Core-state version 19 process-generation identity domain.
 *
 * A version 19 process-generation identifier is the durable identity Core
 * persists for one Module process when the Core-state document has been
 * migrated to `dolly.core-state/19`. The store alone mints these identifiers
 * from its durable monotonic counter; no caller may supply one. The wire form
 * is `_v19_host_<counter>`: a leading underscore domain marker, the host
 * domain literal, and the canonical base-ten counter with no leading zeros.
 * The counter is a safe integer, first allocation is `_v19_host_1`, and
 * allocation refuses to advance past `Number.MAX_SAFE_INTEGER`.
 *
 * The legacy version 18 grammar is `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`, which
 * requires a leading letter or digit. Every version 19 identifier begins with
 * an underscore, so the two domains are provably disjoint: no string is both a
 * legacy and a version 19 identifier.
 *
 * Required behavior (R1-R6):
 *
 *   R1 Caller-supplied version 19 identifiers are rejected by
 *      `appendModuleProcessRecord` on every store; only
 *      `allocateAndAppendStartingRecord` mints them.
 *   R2 Allocation advances a durable monotonic counter; stopped identifiers
 *      are never reused and the counter survives reopening the store.
 *   R3 The version 19 grammar accepts canonical counters, rejects non-canonical
 *      and overflowing counters, and never collides with the legacy shapes
 *      `process-<uuid>`, `process-<base64url>`, or `generation_<epoch>_<n>`.
 *   R4 Allocation is atomic: an injected write failure either leaves no
 *      allocated identifier and no counter advance, or a complete committed
 *      view; a phantom allocation never skips a counter value.
 *   R5 The allocated record's control-group path is identity-bound to the
 *      allocated identifier, and a foreign path is rejected before storage.
 *   R6 Explicit migration to version 19 preserves legacy records, recovery
 *      bytes, and the exact source backup, reports already-current on rerun,
 *      and then forbids new legacy identifiers; only the store allocates.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type * as NodeFS from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJsonDigest,
  type JsonValue,
} from "../../../src/core/canonical-json.js";
import {
  FileCoreStateStore,
  createFileCoreStateStoreWithStoppedRecordWriter,
  migrateCoreStateDocumentToVersion19,
  CoreStateError,
  type CoreStateMigrationResult,
} from "../../../src/core/file-core-state-store.js";
import {
  formatVersion19ProcessGenerationId,
  isProcessGenerationId,
  isVersion19ProcessGenerationId,
  version19ProcessGenerationCounter,
} from "../../../src/core/linux-identifier-formats.js";
import {
  isIdentityBoundModuleCgroupPath,
} from "../../../src/core/linux-module-cgroup-identity.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import {
  assertValidModuleProcessRecord,
  type ModuleProcessDeclarationProvenanceAuthority,
  type ModuleProcessRecord,
  type ModuleProcessRecordError,
  type ModuleProcessStoppedRecordWriter,
  type ModuleProcessStartingRecordInput,
} from "../../../src/core/module-process-records.js";
import {
  createInstalledModuleProcessDeclarationProvenanceAuthority,
} from "../../../src/adapters/installed-linux-extension-module-executor.js";
import { seedLegacyProcessRecords } from "./fixtures/process-id-v19-cutover.js";

const MIGRATION_OPTIONS = {
  runtimeConfiguration: {
    maxFailedAttempts: 3,
    media: { enabled: false as const },
  },
};

const NOW = "2026-08-14T00:00:00.000Z";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const INSTANCE_ID = "instance-1";
const MODULE_ID = "worker";
const DELEGATED_ROOT = "/system.slice/dolly-core.service";
const INVOCATION_ID = "2812432ad29e4d3bbd6776c62cafa929";
const BOOT_ID = "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9";

/** Inert unless a test arms a hook; mirrors the Core-state fault harness. */
const faults = vi.hoisted(() => ({
  beforeOpen: undefined as ((path: string, flags: string) => void) | undefined,
  afterOpen: undefined as
    | ((path: string, flags: string, descriptor: number) => void)
    | undefined,
  beforeWrite: undefined as ((target: unknown) => void) | undefined,
  beforeFsync: undefined as ((descriptor: number) => void) | undefined,
  beforeRename: undefined as ((from: string, to: string) => void) | undefined,
  afterRename: undefined as ((from: string, to: string) => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFS>();
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

function startingRecord(
  overrides: Partial<ModuleProcessStartingRecordInput> = {},
): ModuleProcessStartingRecordInput {
  return {
    schemaVersion: "dolly.module-process-record/1",
    instanceId: INSTANCE_ID,
    moduleId: MODULE_ID,
    moduleGenerationId: "module-generation-1",
    packageDigest: DIGEST_A,
    configurationReference: {
      configId: "config-1",
      revision: DIGEST_B,
      configVersion: 1,
    },
    declaredExternalEffects: "core-capabilities-only",
    serviceInvocationId: INVOCATION_ID,
    bootId: BOOT_ID,
    delegatedRootCgroupPath: DELEGATED_ROOT,
    state: "starting",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as ModuleProcessStartingRecordInput;
}

describe("CORE process-generation identity domain (version 19)", () => {
  let root: string;
  let path: string;
  let clock: string;
  let stoppedRecordWriters: WeakMap<
    FileCoreStateStore,
    ModuleProcessStoppedRecordWriter
  >;

  function openStore(prefix: string): FileCoreStateStore {
    let blockId = 0;
    let runtimeId = 0;
    const created = createFileCoreStateStoreWithStoppedRecordWriter({
      path,
      maxFailedAttempts: 3,
      nextBlockId: () => `${prefix}-block-${++blockId}`,
      nextDeliveryId: (kind) => `${prefix}-${kind}-${++runtimeId}`,
      now: () => clock,
    });
    stoppedRecordWriters.set(created.store, created.stoppedRecordWriter);
    return created.store;
  }

  function stoppedRecordWriterFor(
    store: FileCoreStateStore,
  ): ModuleProcessStoppedRecordWriter {
    const writer = stoppedRecordWriters.get(store);
    if (writer === undefined) {
      throw new Error("Test fixture did not retain the store-bound stopped-record writer");
    }
    return writer;
  }

  /**
   * Builds a version 19 Core-state document from a fresh version 18 store the
   * same way an operator would: persist legacy state at version 18, run the
   * explicit migration, then open the migrated document.
   */
  function migrateToVersion19(prefix: string): FileCoreStateStore {
    // Persist a fresh version 18 document first, the same way an operator
    // would before running the explicit migration.
    openStore(`${prefix}-seed`);
    const migration = migrateCoreStateDocumentToVersion19(path, MIGRATION_OPTIONS);
    expect(migration.status).toBe("migrated");
    return openStore(`${prefix}`);
  }

  /** The store's persisted allocation counter, narrowed to a version 19 document. */
  function version19CounterOf(store: FileCoreStateStore): number {
    const snapshot = store.snapshot();
    if (snapshot.schemaVersion !== "dolly.core-state/19") {
      throw new Error("Expected a version 19 Core-state document");
    }
    return snapshot.processGenerationIdCounter;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-core-v19-identity-"));
    path = join(root, "core-state.json");
    clock = NOW;
    stoppedRecordWriters = new WeakMap();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("R3 grammar disjointness", () => {
    it("accepts canonical version 19 identifiers including the safe-integer bound", () => {
      for (const id of [
        "_v19_host_1",
        "_v19_host_2",
        "_v19_host_42",
        `_v19_host_${Number.MAX_SAFE_INTEGER}`,
      ]) {
        expect(isVersion19ProcessGenerationId(id), id).toBe(true);
      }
    });

    it.each([
      "_v19_host_0",
      "_v19_host_01",
      "_v19_host_",
      "_v19_host",
      "_v19_",
      "v19_host_1",
      "_v20_host_1",
      "_v19_worker_1",
      "_v19_host_1.5",
      "_v19_host_-1",
      "_v19_host_9007199254740992", // MAX_SAFE_INTEGER + 1
      "_v19_host_999999999999999999999999999999",
      "_v19_host_1_2",
    ])("rejects non-canonical or overflowing identifier %s", (id) => {
      expect(isVersion19ProcessGenerationId(id), id).toBe(false);
    });

    it("keeps the legacy validator disjoint from every version 19 identifier", () => {
      expect(isProcessGenerationId("_v19_host_1")).toBe(false);
      expect(isProcessGenerationId(`_v19_host_${Number.MAX_SAFE_INTEGER}`)).toBe(
        false,
      );
    });

    it("never collides with the legacy shapes or their allocators", () => {
      const uuid = "process-550e8400-e29b-41d4-a716-446655440000";
      const base64url = "process-xhppZ3JhdGlvbi1leGFtcGxlLTAxLTAyLTAz";
      const daemon = "generation_1710000000_3";
      for (const legacy of [uuid, base64url, daemon]) {
        expect(isProcessGenerationId(legacy), legacy).toBe(true);
        expect(isVersion19ProcessGenerationId(legacy), legacy).toBe(false);
      }
      expect(isProcessGenerationId("_v19_host_7")).toBe(false);
      expect(isVersion19ProcessGenerationId("_v19_host_7")).toBe(true);
    });

    it("parses and formats counters canonically", () => {
      expect(version19ProcessGenerationCounter("_v19_host_1")).toBe(1);
      expect(
        version19ProcessGenerationCounter(`_v19_host_${Number.MAX_SAFE_INTEGER}`),
      ).toBe(Number.MAX_SAFE_INTEGER);
      expect(version19ProcessGenerationCounter("_v19_host_01")).toBeUndefined();
      expect(version19ProcessGenerationCounter("_v19_worker_1")).toBeUndefined();
      expect(formatVersion19ProcessGenerationId(1)).toBe("_v19_host_1");
      expect(
        formatVersion19ProcessGenerationId(Number.MAX_SAFE_INTEGER),
      ).toBe(`_v19_host_${Number.MAX_SAFE_INTEGER}`);
    });
  });

  describe("R1 caller-supplied version 19 identifiers are rejected", () => {
    it("rejects a fabricated version 19 identifier on a legacy version 18 store", () => {
      const store = openStore("legacy");
      expect(() =>
        store.appendModuleProcessRecord(
          processRecord({ processGenerationId: "_v19_host_1" }),
        ),
      ).toThrowError(
        expect.objectContaining<Partial<ModuleProcessRecordError>>({
          code: "MODULE_PROCESS_RECORD_ALLOCATION_REQUIRED",
        }),
      );
      expect(store.listModuleProcessRecords()).toEqual([]);
    });

    it("rejects a fabricated version 19 identifier after migration to version 19", () => {
      const store = migrateToVersion19("migrated");
      expect(() =>
        store.appendModuleProcessRecord(
          processRecord({ processGenerationId: "_v19_host_1" }),
        ),
      ).toThrowError(
        expect.objectContaining<Partial<ModuleProcessRecordError>>({
          code: "MODULE_PROCESS_RECORD_ALLOCATION_REQUIRED",
        }),
      );
      expect(store.listModuleProcessRecords()).toEqual([]);
    });
  });

  describe("R2 store-owned allocation is durable and monotonic", () => {
    it("allocates canonical identifiers from the first counter value", () => {
      const store = migrateToVersion19("alloc");
      const first = store.allocateAndAppendStartingRecord(startingRecord());
      expect(first.processGenerationId).toBe("_v19_host_1");
      expect(first.state).toBe("starting");
      expect(first.moduleCgroupPath).toBe(cgroupPathFor("_v19_host_1"));

      const second = store.allocateAndAppendStartingRecord(
        startingRecord({ moduleGenerationId: "module-generation-2" }),
      );
      expect(second.processGenerationId).toBe("_v19_host_2");
      expect(store.getModuleProcessRecord("_v19_host_2")).toEqual(second);
    });

    it("never reuses an identifier after its record is stopped", () => {
      const store = migrateToVersion19("stop");
      const first = store.allocateAndAppendStartingRecord(startingRecord());
      stoppedRecordWriterFor(store).writeStopped(first.processGenerationId, "ROTATED");
      const second = store.allocateAndAppendStartingRecord(startingRecord());
      expect(second.processGenerationId).toBe("_v19_host_2");
    });

    it("persists the counter across reopening", () => {
      const store = migrateToVersion19("reopen");
      store.allocateAndAppendStartingRecord(startingRecord());
      store.allocateAndAppendStartingRecord(
        startingRecord({ moduleGenerationId: "module-generation-2" }),
      );

      const reopened = openStore("reopen-two");
      expect(reopened.snapshot().schemaVersion).toBe("dolly.core-state/19");
      expect(reopened.allocateAndAppendStartingRecord(
        startingRecord({ moduleGenerationId: "module-generation-3" }),
      ).processGenerationId)
        .toBe("_v19_host_3");
    });

    it("refuses a second non-terminal record for one Module tuple", () => {
      const store = migrateToVersion19("tuple");
      store.allocateAndAppendStartingRecord(startingRecord());
      expect(() =>
        store.allocateAndAppendStartingRecord(startingRecord()),
      ).toThrowError(
        expect.objectContaining<Partial<ModuleProcessRecordError>>({
          code: "MODULE_PROCESS_RECORD_CONFLICT",
        }),
      );
    });

    it("refuses allocation when the store has not been migrated", () => {
      const store = openStore("legacy-only");
      expect(() => store.allocateAndAppendStartingRecord(startingRecord())).toThrowError(
        expect.objectContaining<Partial<ModuleProcessRecordError>>({
          code: "MODULE_PROCESS_RECORD_IDENTITY_MIGRATION_REQUIRED",
        }),
      );
    });
  });

  describe("R4 allocation atomicity under injected write failure", () => {
    it("leaves no allocated identifier and no skipped counter when the rename fails", () => {
      const store = migrateToVersion19("atomic");
      const beforeBytes = readFileSync(path, "utf8");
      const beforeRevision = store.revision;

      faults.beforeRename = () => {
        throw new Error("injected rename failure");
      };
      expect(() => store.allocateAndAppendStartingRecord(startingRecord())).toThrowError(
        expect.objectContaining<Partial<CoreStateError>>({
          code: "CORE_STATE_IO_FAILED",
        }),
      );
      faults.beforeRename = undefined;

      // The store fails closed after the failed persist; the file still holds
      // the complete pre-allocation view.
      expect(() => store.allocateAndAppendStartingRecord(startingRecord())).toThrowError(
        expect.objectContaining<Partial<CoreStateError>>({
          code: "CORE_STATE_REOPEN_REQUIRED",
        }),
      );
      expect(readFileSync(path, "utf8")).toBe(beforeBytes);

      const reopened = openStore("atomic-reopened");
      expect(reopened.revision).toBe(beforeRevision);
      expect(reopened.getModuleProcessRecord("_v19_host_1")).toBeUndefined();
      expect(version19CounterOf(reopened)).toBe(0);
      // No phantom allocation: the next allocation is the same counter value.
      expect(reopened.allocateAndAppendStartingRecord(startingRecord()).processGenerationId)
        .toBe("_v19_host_1");
    });

    it("reports the complete committed view and never skips a counter when rename confirmation fails", () => {
      const store = migrateToVersion19("atomic-after");
      let renamed = false;
      faults.afterRename = () => {
        renamed = true;
        throw new Error("injected rename confirmation failure");
      };
      expect(() => store.allocateAndAppendStartingRecord(startingRecord())).toThrowError(
        expect.objectContaining<Partial<CoreStateError>>({
          code: "CORE_STATE_IO_FAILED",
        }),
      );
      faults.afterRename = undefined;
      expect(renamed).toBe(true);

      const reopened = openStore("atomic-after-reopened");
      expect(version19CounterOf(reopened)).toBe(1);
      expect(reopened.getModuleProcessRecord("_v19_host_1")).toBeDefined();
      expect(
        reopened.allocateAndAppendStartingRecord(
          startingRecord({ moduleGenerationId: "module-generation-2" }),
        ).processGenerationId,
      ).toBe("_v19_host_2");
    });
  });

  describe("R5 control-group identity binding for allocated identifiers", () => {
    it("binds the stored control-group path to the allocated identifier", () => {
      const store = migrateToVersion19("cgroup");
      const record = store.allocateAndAppendStartingRecord(startingRecord());
      expect(
        isIdentityBoundModuleCgroupPath(record.moduleCgroupPath, {
          instanceId: INSTANCE_ID,
          moduleId: MODULE_ID,
          processGenerationId: record.processGenerationId,
        }),
      ).toBe(true);
      expect(record.moduleCgroupPath).toBe(cgroupPathFor(record.processGenerationId));
      // The record round-trips through the durable validator unchanged.
      assertValidModuleProcessRecord(record);
    });

    it("rejects a foreign control-group path before storage", () => {
      const store = migrateToVersion19("cgroup-foreign");
      expect(() =>
        store.allocateAndAppendStartingRecord(
          startingRecord({ moduleCgroupPath: cgroupPathFor("_v19_host_999") }),
        ),
      ).toThrowError(
        expect.objectContaining<Partial<ModuleProcessRecordError>>({
          code: "MODULE_PROCESS_RECORD_INVALID",
        }),
      );
    });
  });

  describe("R6 explicit v18 to v19 migration", () => {
    it("preserves legacy records and exact source bytes, then forbids new legacy identifiers", () => {
      // Legacy documents no longer accept caller-supplied process records, so
      // the fixture seeds the exact legacy record into the fresh document the
      // same way a pre-cutover Dolly would have left it on disk.
      const seedStore = openStore("legacy-seed");
      seedLegacyProcessRecords(path, { processRecords: [processRecord()] });
      void seedStore;
      const store = openStore("legacy-migrate");
      store.updateModuleProcessRecordState("process-generation-1", "running");
      const running = store.getModuleProcessRecord("process-generation-1");
      expect(running?.state).toBe("running");
      const before = readFileSync(path, "utf8");
      const beforeRevision = store.revision;

      const migration = migrateCoreStateDocumentToVersion19(path, MIGRATION_OPTIONS);
      expect(migration).toEqual({
        status: "migrated",
        sourceSchemaVersion: "dolly.core-state/18",
        backupPath: resolve(`${path}.v18.backup`),
      });
      expect(readFileSync(`${path}.v18.backup`, "utf8")).toBe(before);

      const migrated = openStore("migrated-legacy");
      expect(migrated.snapshot().schemaVersion).toBe("dolly.core-state/19");
      expect(migrated.revision).toBe(beforeRevision + 1);
      expect(version19CounterOf(migrated)).toBe(0);
      // The legacy record and its running state are preserved, not re-allocated.
      expect(migrated.getModuleProcessRecord("process-generation-1")).toEqual(running);
      expect(migrated.getModuleProcessRecord("process-generation-1")?.state).toBe(
        "running",
      );

      // New legacy identifiers are forbidden after migration.
      expect(() =>
        migrated.appendModuleProcessRecord(
          processRecord({ processGenerationId: "process-generation-2" }),
        ),
      ).toThrowError(
        expect.objectContaining<Partial<ModuleProcessRecordError>>({
          code: "MODULE_PROCESS_RECORD_ALLOCATION_REQUIRED",
        }),
      );

      // The store allocates the first version 19 identifier after the legacy
      // record; the two domains never collide.
      expect(
        migrated.allocateAndAppendStartingRecord(
          startingRecord({ moduleGenerationId: "module-generation-2" }),
        ).processGenerationId,
      ).toBe("_v19_host_1");
    });

    it("reports already-current when run again on a version 19 document", () => {
      migrateToVersion19("current");
      const migration = migrateCoreStateDocumentToVersion19(path, MIGRATION_OPTIONS);
      expect(migration).toEqual({
        status: "already-current",
        schemaVersion: "dolly.core-state/19",
      });
      expect(existsSync(`${path}.v19.backup`)).toBe(false);
    });

    it("migrates a version 15 document directly to version 19 without records", () => {
      const store = openStore("v15-source");
      const current = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        unknown
      >;
      const payload = {
        revision: current.revision!,
        referenceGraph: current.referenceGraph!,
        ...(current.media === undefined ? {} : { media: current.media }),
        blocks: current.blocks!,
        deliveries: current.deliveries!,
      };
      const legacy: Record<string, unknown> = {
        schemaVersion: "dolly.core-state/15",
        stateDigest: canonicalJsonDigest(payload as unknown as JsonValue),
        ...payload,
      };
      const raw = `${JSON.stringify(legacy)}\n`;
      writeFileSync(path, raw, "utf8");

      const migration = migrateCoreStateDocumentToVersion19(path, MIGRATION_OPTIONS);
      expect(migration).toEqual({
        status: "migrated",
        sourceSchemaVersion: "dolly.core-state/15",
        backupPath: resolve(`${path}.v15.backup`),
      });
      expect(readFileSync(`${path}.v15.backup`, "utf8")).toBe(raw);

      const migrated = openStore("v15-migrated");
      expect(migrated.snapshot().schemaVersion).toBe("dolly.core-state/19");
      expect(migrated.snapshot().revision).toBe((legacy.revision as number) + 1);
      expect(version19CounterOf(migrated)).toBe(0);
      expect(migrated.listModuleProcessRecords()).toEqual([]);

      // The migrated document is the current version and needs no further work.
      expect(
        migrateCoreStateDocumentToVersion19(path, MIGRATION_OPTIONS),
      ).toEqual({
        status: "already-current",
        schemaVersion: "dolly.core-state/19",
      });
    });
  });

  describe("version 2 declaration provenance authority gate", () => {
    function openStoreWithAuthority(
      prefix: string,
      authority: ModuleProcessDeclarationProvenanceAuthority,
    ): FileCoreStateStore {
      let blockId = 0;
      let runtimeId = 0;
      const created = createFileCoreStateStoreWithStoppedRecordWriter({
        path,
        maxFailedAttempts: 3,
        nextBlockId: () => `${prefix}-block-${++blockId}`,
        nextDeliveryId: (kind) => `${prefix}-${kind}-${++runtimeId}`,
        now: () => clock,
        declarationProvenanceAuthorityProvider: () => authority,
      });
      return created.store;
    }

    it("refuses a version 2 allocation when no authority is bound", () => {
      const store = migrateToVersion19("no-authority");
      expect(() =>
        store.allocateAndAppendStartingRecord(
          startingRecord({
            schemaVersion: "dolly.module-process-record/2",
            declarationProvenance: { minted: true },
          }),
        ),
      ).toThrowError(
        expect.objectContaining<Partial<ModuleProcessRecordError>>({
          code: "MODULE_PROCESS_RECORD_DECLARATION_PROVENANCE_REQUIRED",
        }),
      );
    });

    it("refuses construction when the authority is not store-bound", () => {
      const foreign = openStore("foreign");
      let blockId = 0;
      let runtimeId = 0;
      expect(() =>
        createFileCoreStateStoreWithStoppedRecordWriter({
          path: join(root, "core-state-foreign-auth.json"),
          maxFailedAttempts: 3,
          nextBlockId: () => `foreign-auth-block-${++blockId}`,
          nextDeliveryId: (kind) => `foreign-auth-${kind}-${++runtimeId}`,
          now: () => clock,
          declarationProvenanceAuthorityProvider: () =>
            createInstalledModuleProcessDeclarationProvenanceAuthority(foreign),
        }),
      ).toThrowError(CoreStateError);
    });

    it("allocates a version 2 record when the store-bound authority verifies", () => {
      const DIGEST_C = `sha256:${"c".repeat(64)}`;
      migrateToVersion19("with-authority");
      // Reopen the migrated document with a provider that binds the
      // authority to the store under construction, the same way the
      // installed composition calls
      // `createInstalledModuleProcessDeclarationProvenanceAuthority(store)`.
      let blockId = 0;
      let runtimeId = 0;
      const reopened = createFileCoreStateStoreWithStoppedRecordWriter({
        path,
        maxFailedAttempts: 3,
        nextBlockId: () => `with-auth-block-${++blockId}`,
        nextDeliveryId: (kind) => `with-auth-${kind}-${++runtimeId}`,
        now: () => clock,
        declarationProvenanceAuthorityProvider: (store) => ({
          isStoreBoundTo: (candidate: unknown) => candidate === store,
          verify: () => ({
            schemaVersion: "dolly.reserved-v10-module-process-provenance/1",
            provenanceDigest: DIGEST_C,
          }),
        }),
      }).store;
      const record = reopened.allocateAndAppendStartingRecord(
        startingRecord({
          schemaVersion: "dolly.module-process-record/2",
          declaredExternalEffects: "none",
          declarationProvenance: { minted: true },
        }),
      );
      expect(record.schemaVersion).toBe("dolly.module-process-record/2");
      expect(record.declarationProvenance).toEqual({
        schemaVersion: "dolly.reserved-v10-module-process-provenance/1",
        provenanceDigest: DIGEST_C,
      });
      assertValidModuleProcessRecord(record);
    });
  });
});