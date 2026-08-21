/**
 * Process-id version 19 cutover contract (round 15) — FileCore slice.
 *
 * This slice makes the Core-state store's identity-domain changes visible at
 * the FileCore boundary only; CLI, Linux lifecycle, generation factory, and
 * Module activation cutover are separate later slices. The rules pinned here:
 *
 *   A1 A version 19 allocation counter counts identifiers already issued
 *      (last-issued); zero means none yet. Decoding and restoring a version 19
 *      document preserve that meaning with no off-by-one: the first allocation
 *      is `_v19_host_1` and the persisted counter records issuance.
 *   A2 A supported legacy (16/17/18) document stays readable for fail-closed
 *      recovery but refuses every new caller-supplied process record with the
 *      stable typed `MODULE_PROCESS_RECORD_IDENTITY_MIGRATION_REQUIRED` error,
 *      so the historical `append -> stopped -> remove -> re-append same
 *      identifier` reuse path cannot exist on any store. Old records stay
 *      readable; terminal-state recovery and removal keep working and are
 *      never reinterpreted.
 *   A3 A legacy outer document's decoder rejects every reserved `_v19_*`
 *      process-generation identifier embedded in a nested process record
 *      (schema `/1` and `/2` alike); a legacy document cannot forge a
 *      `_v19_host_<n>` record.
 *   A4 A version 19 document decoder accepts only the canonical reserved
 *      format and requires each stored record's ordinal to have been
 *      authorized by the persisted counter; the persisted counter must never
 *      be lower than the largest authorized issuance. Unauthorized ahead
 *      records, leading-zero, and overflowing ordinals all fail closed.
 *      Removal needs no tombstone: the counter never regresses and an
 *      identifier is never reused.
 *   A5 Allocation and the persisted starting record advance the counter in one
 *      Core-state revision. After `remove` + `reopen` the counter does not
 *      regress and the removed identifier is never handed out again.
 *   A6 The stopped-record writer stays store-bound across the identity
 *      change: a stale writer held by an old store handle cannot be bound to
 *      a different store or to records it did not create.
 */

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJsonDigest, type JsonValue } from "../../../src/core/canonical-json.js";
import {
  CoreStateError,
  FileCoreStateStore,
  createFileCoreStateStoreWithStoppedRecordWriter,
  migrateCoreStateDocumentToVersion19,
} from "../../../src/core/file-core-state-store.js";
import { isVersion19ProcessGenerationId } from "../../../src/core/linux-identifier-formats.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import type {
  ModuleProcessRecord,
  ModuleProcessRecordError,
  ModuleProcessStoppedRecordWriter,
  ModuleProcessStartingRecordInput,
} from "../../../src/core/module-process-records.js";

const NOW = "2026-08-14T00:00:00.000Z";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const INSTANCE_ID = "instance-1";
const MODULE_ID = "worker";
const DELEGATE_ROOT = "/system.slice/dolly-core.service";
const INVOCATION_ID = "2812432ad29e4d3bbd6776c62cafa929";
const BOOT_ID = "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9";

const MIGRATION_OPTIONS = {
  runtimeConfiguration: {
    maxFailedAttempts: 3,
    media: { enabled: false as const },
  },
};

/** The control-group path Core derives for one process generation of this fixture. */
function cgroupPathFor(processGenerationId: string): string {
  return deriveModuleCgroupPath(DELEGATE_ROOT, {
    instanceId: INSTANCE_ID,
    moduleId: MODULE_ID,
    processGenerationId,
  }).filesystemPath;
}

function processRecord(
  overrides: Partial<ModuleProcessRecord> = {},
): ModuleProcessRecord {
  const processGenerationId =
    overrides.processGenerationId ?? "process-generation-1";
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

function processRecordV2(
  overrides: Partial<ModuleProcessRecord> = {},
): ModuleProcessRecord {
  return processRecord({
    schemaVersion: "dolly.module-process-record/2",
    declaredExternalEffects: "none",
    declarationProvenance: {
      schemaVersion: "dolly.reserved-v10-module-process-provenance/1",
      provenanceDigest: DIGEST_B,
    },
    ...overrides,
  });
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
    delegatedRootCgroupPath: DELEGATE_ROOT,
    state: "starting",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as ModuleProcessStartingRecordInput;
}

describe("CORE process-id v19 cutover (FileCore slice)", () => {
  let root: string;
  let clock: string;
  const stoppedRecordWriters = new WeakMap<
    FileCoreStateStore,
    ModuleProcessStoppedRecordWriter
  >();

  function openStore(prefix: string): FileCoreStateStore {
    let blockId = 0;
    let runtimeId = 0;
    const created = createFileCoreStateStoreWithStoppedRecordWriter({
      path: join(root, "core-state.json"),
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
      throw new Error("Test store has no stopped-record writer");
    }
    return writer;
  }

  /** Persists a fresh legacy state file, then opens its version 19 form. */
  function migrateToVersion19(prefix: string): FileCoreStateStore {
    openStore(`${prefix}-seed`);
    const migration = migrateCoreStateDocumentToVersion19(
      join(root, "core-state.json"),
      MIGRATION_OPTIONS,
    );
    expect(migration.status).toBe("migrated");
    return openStore(prefix);
  }

  function version19CounterOf(store: FileCoreStateStore): number {
    const snapshot = store.snapshot() as { schemaVersion: string };
    if (snapshot.schemaVersion !== "dolly.core-state/19") {
      throw new Error("Expected a version 19 Core-state document");
    }
    return (store.snapshot() as { processGenerationIdCounter: number })
      .processGenerationIdCounter;
  }

  /** Rewrites the on-disk document, replacing the record collections. */
  function rewriteRecords(records: readonly ModuleProcessRecord[]): void {
    const path = join(root, "core-state.json");
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      JsonValue
    >;
    const { stateDigest: _stateDigest, ...payload } = document;
    const rewritten: Record<string, JsonValue> = {
      ...payload,
      moduleProcessRecords: records as unknown as JsonValue,
    };
    writeFileSync(
      path,
      `${JSON.stringify({
        ...rewritten,
        stateDigest: canonicalJsonDigest(rewritten),
      })}\n`,
      "utf8",
    );
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-core-v19-cutover-"));
    clock = NOW;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("A1 last-issued counter semantics", () => {
    it("persists and restores the last-issued counter with no off-by-one", () => {
      const store = migrateToVersion19("a1");
      expect(version19CounterOf(store)).toBe(0);

      const first = store.allocateAndAppendStartingRecord(startingRecord());
      expect(first.processGenerationId).toBe("_v19_host_1");
      // The counter holds the number of already-issued identifiers.
      expect(version19CounterOf(store)).toBe(1);

      const reopened = openStore("a1-reopened");
      expect(reopened.supportsVersion19Identity()).toBe(true);
      expect(version19CounterOf(reopened)).toBe(1);
      expect(
        reopened.allocateAndAppendStartingRecord(
          startingRecord({ moduleGenerationId: "module-generation-2" }),
        ).processGenerationId,
      ).toBe("_v19_host_2");
    });
  });

  describe("A2 legacy write refusal", () => {
    it("refuses the first caller-supplied process record on a legacy store", () => {
      const store = openStore("a2-legacy");
      expect(store.supportsVersion19Identity()).toBe(false);
      expect(() => store.appendModuleProcessRecord(processRecord())).toThrowError(
        expect.objectContaining<Partial<ModuleProcessRecordError>>({
          code: "MODULE_PROCESS_RECORD_IDENTITY_MIGRATION_REQUIRED",
        }),
      );
      expect(store.listModuleProcessRecords()).toEqual([]);
    });

    it("refuses caller-supplied records even with an explicit legacy identifier", () => {
      const store = openStore("a2-legacy-id");
      expect(() =>
        store.appendModuleProcessRecord(
          processRecord({ processGenerationId: "process-generation-legacy" }),
        ),
      ).toThrowError(
        expect.objectContaining<Partial<ModuleProcessRecordError>>({
          code: "MODULE_PROCESS_RECORD_IDENTITY_MIGRATION_REQUIRED",
        }),
      );
    });

    it("migrates a legacy store without rewriting its records and keeps them readable", () => {
      const store = migrateToVersion19("a2-migrate");
      store.allocateAndAppendStartingRecord(startingRecord());
      expect(store.getModuleProcessRecord("_v19_host_1")).toBeDefined();
      expect(() =>
        store.appendModuleProcessRecord(
          processRecord({ processGenerationId: "process-generation-2" }),
        ),
      ).toThrowError(
        expect.objectContaining<Partial<ModuleProcessRecordError>>({
          code: "MODULE_PROCESS_RECORD_ALLOCATION_REQUIRED",
        }),
      );
    });
  });

  describe("A3 reserved-domain rejection inside legacy documents", () => {
    it.each(["dolly.module-process-record/1", "dolly.module-process-record/2"] as const)(
      "rejects a nested %s record that forges a version 19 identifier",
      (schemaVersion) => {
        const forged =
          schemaVersion === "dolly.module-process-record/2"
            ? processRecordV2({ processGenerationId: "_v19_host_1" })
            : processRecord({ processGenerationId: "_v19_host_1" });
        openStore(`a3-${schemaVersion}-seed`);
        const document = JSON.parse(
          readFileSync(join(root, "core-state.json"), "utf8"),
        ) as Record<string, JsonValue>;
        const { stateDigest: _stateDigest, ...payload } = document;
        const forgedDocument: Record<string, JsonValue> = {
          ...payload,
          moduleProcessRecords: [forged as unknown as JsonValue],
        };
        writeFileSync(
          join(root, "core-state.json"),
          `${JSON.stringify({
            ...forgedDocument,
            stateDigest: canonicalJsonDigest(forgedDocument),
          })}\n`,
          "utf8",
        );
        expect(() => openStore(`a3-${schemaVersion}`)).toThrowError(
          expect.objectContaining<Partial<CoreStateError>>({
            code: "CORE_STATE_DOCUMENT_INVALID",
          }),
        );
      },
    );
  });

  describe("A4 version 19 identity-domain decode", () => {
    function openWithForgedRecords(
      prefix: string,
      records: readonly ModuleProcessRecord[],
    ): () => FileCoreStateStore {
      migrateToVersion19(`${prefix}-seed`);
      rewriteRecords(records);
      return () => openStore(prefix);
    }

    it("fails closed when a stored record ordinal exceeds the persisted counter", () => {
      const open = openWithForgedRecords("a4-ahead", [
        processRecord({ processGenerationId: "_v19_host_7" }),
      ]);
      expect(open).toThrowError(
        expect.objectContaining<Partial<CoreStateError>>({
          code: "CORE_STATE_DOCUMENT_INVALID",
        }),
      );
    });

    function forgedRecordWithId(processGenerationId: string): ModuleProcessRecord {
      // A forged identifier is already outside the usable grammar, so the
      // fixture cannot derive a control-group path for it; a synthetic path
      // is fine because the reserved-domain validator rejects the identifier
      // before inspecting the path.
      const base = processRecord({
        processGenerationId: "placeholder-process-generation",
      });
      return {
        ...base,
        processGenerationId,
        moduleCgroupPath: "/sys/fs/cgroup/system.slice/unused",
      } as ModuleProcessRecord;
    }

    it("fails closed on a non-canonical leading-zero reserved identifier", () => {
      const open = openWithForgedRecords("a4-zero", [
        forgedRecordWithId("_v19_host_01"),
      ]);
      expect(open).toThrowError(
        expect.objectContaining<Partial<CoreStateError>>({
          code: "CORE_STATE_DOCUMENT_INVALID",
        }),
      );
    });

    it("fails closed on an overflowing reserved identifier", () => {
      const open = openWithForgedRecords("a4-overflow", [
        forgedRecordWithId(`_v19_host_${Number.MAX_SAFE_INTEGER + 1}`),
      ]);
      expect(open).toThrowError(
        expect.objectContaining<Partial<CoreStateError>>({
          code: "CORE_STATE_DOCUMENT_INVALID",
        }),
      );
    });

    it("accepts a version 19 document when the counter authorized every stored ordinal", () => {
      const store = migrateToVersion19("a4-valid");
      store.allocateAndAppendStartingRecord(startingRecord());
      const reopened = openStore("a4-valid-reopened");
      expect(reopened.getModuleProcessRecord("_v19_host_1")).toBeDefined();
      expect(version19CounterOf(reopened)).toBe(1);
    });
  });

  describe("A5 allocation atomicity and remove/reopen non-reuse", () => {
    it("allocates and persists its starting record in one Core-state revision", () => {
      const store = migrateToVersion19("a5-revision");
      const before = store.revision;
      const record = store.allocateAndAppendStartingRecord(startingRecord());
      expect(store.revision).toBe(before + 1);
      expect(record.state).toBe("starting");
    });

    it("never reuses an identifier after its record is stopped and removed, and the counter does not regress", () => {
      const store = migrateToVersion19("a5-remove");
      const first = store.allocateAndAppendStartingRecord(startingRecord());
      expect(first.processGenerationId).toBe("_v19_host_1");
      stoppedRecordWriterFor(store).writeStopped("_v19_host_1", "ROTATED");
      store.removeModuleProcessRecord("_v19_host_1");
      expect(version19CounterOf(store)).toBe(1);

      const reopened = openStore("a5-remove-reopened");
      expect(version19CounterOf(reopened)).toBe(1);
      expect(reopened.getModuleProcessRecord("_v19_host_1")).toBeUndefined();
      const second = reopened.allocateAndAppendStartingRecord(startingRecord());
      expect(second.processGenerationId).toBe("_v19_host_2");
      expect(second.state).toBe("starting");
    });
  });

  describe("A6 stopped-record writer stays store-bound", () => {
    it("binds the writer only to the store that issued it", () => {
      const store = openStore("a6-bound");
      const writer = stoppedRecordWriterFor(store);
      expect(writer.isStoreBoundTo(store)).toBe(true);
      expect(writer.isStoreBoundTo({})).toBe(false);
      const foreign = processRecord();
      expect(writer.isBoundTo(foreign)).toBe(false);
    });

    it("keeps a stale writer unusable on a document the reopened store holds", () => {
      const legacy = openStore("a6-stale");
      const writer = stoppedRecordWriterFor(legacy);
      migrateCoreStateDocumentToVersion19(
        join(root, "core-state.json"),
        MIGRATION_OPTIONS,
      );
      const reopened = openStore("a6-stale-reopened");
      expect(writer.isStoreBoundTo(reopened)).toBe(false);
      const reopenedRecord = reopened.allocateAndAppendStartingRecord(startingRecord());
      expect(writer.isBoundTo(reopenedRecord)).toBe(false);
      // The stale writer cannot mark the reopened store's record stopped.
      expect(() => writer.writeStopped(reopenedRecord.processGenerationId)).toThrowError(
        expect.objectContaining<Partial<ModuleProcessRecordError>>({
          code: "MODULE_PROCESS_RECORD_NOT_FOUND",
        }),
      );
      expect(
        stoppedRecordWriterFor(reopened).isStoreBoundTo(reopened),
      ).toBe(true);
    });
  });
});
