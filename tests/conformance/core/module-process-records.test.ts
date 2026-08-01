import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import type {
  DeliveryClaim,
  DeliveryClaimIdentity,
  NegativeAcknowledgementRequest,
} from "../../../src/core/delivery-store.js";
import {
  CoreStateError,
  FileCoreStateStore,
  createFileCoreStateStoreWithStoppedRecordWriter,
} from "../../../src/core/file-core-state-store.js";
import {
  ModuleProcessRecordError,
  assertValidModuleProcessRecord,
  type ModuleProcessRecord,
  type ModuleProcessStoppedRecordWriter,
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
function cgroupPathFor(
  processGenerationId: string,
  moduleId: string = MODULE_ID,
): string {
  return deriveModuleCgroupPath(DELEGATED_ROOT, {
    instanceId: INSTANCE_ID,
    moduleId,
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

  function seedActiveClaim(
    store: FileCoreStateStore,
    options: {
      readonly consumerId?: string;
      readonly moduleGenerationId?: string;
      readonly pageId?: string;
    } = {},
  ): DeliveryClaim {
    const consumerId = options.consumerId ?? MODULE_ID;
    const moduleGenerationId = options.moduleGenerationId ?? "module-generation-1";
    const pageId = options.pageId ?? "input";
    store.deliveries.createPage(pageId);
    store.deliveries.registerConsumer(pageId, consumerId, "from-now");
    const block = store.blocks.commit(
      { payload: { schema: "test.content/1", value: { text: pageId } } },
      { kind: "external", id: "console" },
    );
    store.deliveries.append(pageId, block.id);
    return store.deliveries.claim({
      consumerId,
      pageIds: [pageId],
      moduleGenerationId,
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
  }

  function submissionForClaim(
    store: FileCoreStateStore,
    claim: DeliveryClaimIdentity,
    overrides: Partial<ModuleSubmissionRecord> = {},
  ): ModuleSubmissionRecord {
    return submissionRecord({
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
      inputDigest: canonicalJsonDigest(store.deliveries.inspectClaimInput(claim)),
      ...overrides,
    });
  }

  function seedSubmittedClaim(store: FileCoreStateStore): DeliveryClaim {
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    store.appendModuleSubmissionRecord(submissionForClaim(store, claim));
    return claim;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-module-records-"));
    path = join(root, "core-state.json");
    clock = NOW;
    stoppedRecordWriters = new WeakMap();
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
    expect(reopened.snapshot().schemaVersion).toBe("dolly.core-state/17");
  });

  it("copies an accessor-based process record once before validation and persistence", () => {
    const store = openStore("first");
    const input = processRecord();
    const reads = new Map<PropertyKey, number>();
    const configurationReads = new Map<PropertyKey, number>();
    const configurationReference = new Proxy(input.configurationReference, {
      get(target, property) {
        const count = (configurationReads.get(property) ?? 0) + 1;
        configurationReads.set(property, count);
        return count === 1 ? Reflect.get(target, property, target) : undefined;
      },
    });
    const supplied = new Proxy(input, {
      get(target, property) {
        const count = (reads.get(property) ?? 0) + 1;
        reads.set(property, count);
        if (count !== 1) return undefined;
        return property === "configurationReference"
          ? configurationReference
          : Reflect.get(target, property, target);
      },
    });

    const stored = store.appendModuleProcessRecord(supplied);
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect([...configurationReads.values()].every((count) => count === 1)).toBe(true);

    const reopened = openStore("second");
    expect(reopened.getModuleProcessRecord(input.processGenerationId)).toEqual(stored);
    expect(reopened.listModuleProcessRecords()).toEqual([stored]);
  });

  it("rejects a returned value without reading it or persisting a partial update", () => {
    const store = openStore("first");
    const savedBlocksSnapshot = store.blocks.snapshot;
    const beforeRevision = store.revision;
    const beforeBytes = readFileSync(path, "utf8");
    let thenGetterReads = 0;
    const returnedValue = Object.defineProperty({}, "then", {
      get() {
        thenGetterReads += 1;
        store.deliveries.createPage("then-getter-page");
        return () => undefined;
      },
    });
    const operation = () => {
      store.appendModuleProcessRecord(processRecord());
      return returnedValue;
    };

    if (false) {
      // The callback contract preserves its actual return type, so TypeScript
      // cannot apply the permissive `() => void` assignment rule here.
      // @ts-expect-error Atomic updates may not return a Promise.
      store.runAtomicUpdate(async () => undefined);
      // @ts-expect-error Atomic updates may not return any other value.
      store.runAtomicUpdate(() => "unexpected");
    }

    expect(() =>
      store.runAtomicUpdate(operation as unknown as () => undefined),
    ).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_REOPEN_REQUIRED",
      }),
    );
    expect(thenGetterReads).toBe(0);
    expect(() => store.revision).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_REOPEN_REQUIRED",
      }),
    );
    expect(savedBlocksSnapshot).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_REOPEN_REQUIRED",
      }),
    );
    expect(readFileSync(path, "utf8")).toBe(beforeBytes);
    const reopened = openStore("reopened");
    expect(reopened.revision).toBe(beforeRevision);
    expect(reopened.listModuleProcessRecords()).toEqual([]);
    expect(() =>
      reopened.deliveries.validateOutputPages(["then-getter-page"]),
    ).toThrowError();
  });

  it("prevents an asynchronous continuation from writing after rejection", async () => {
    const store = openStore("first");
    const savedDeliveriesSnapshot = store.deliveries.snapshot;
    const beforeRevision = store.revision;
    const beforeBytes = readFileSync(path, "utf8");
    let releaseContinuation!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseContinuation = resolve;
    });
    let continuation!: Promise<void>;
    const operation = () => {
      store.appendModuleProcessRecord(processRecord());
      continuation = (async () => {
        await gate;
        store.updateModuleProcessRecordState("process-generation-1", "running");
      })();
      return continuation;
    };

    expect(() =>
      store.runAtomicUpdate(operation as unknown as () => void),
    ).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_REOPEN_REQUIRED",
      }),
    );
    releaseContinuation();
    await expect(continuation).rejects.toEqual(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_REOPEN_REQUIRED",
      }),
    );
    expect(savedDeliveriesSnapshot).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_REOPEN_REQUIRED",
      }),
    );
    expect(readFileSync(path, "utf8")).toBe(beforeBytes);
    const reopened = openStore("reopened");
    expect(reopened.revision).toBe(beforeRevision);
    expect(reopened.listModuleProcessRecords()).toEqual([]);
  });

  it("fails closed before a returned Promise makes its first state change", async () => {
    const store = openStore("first");
    const beforeRevision = store.revision;
    const beforeBytes = readFileSync(path, "utf8");
    let releaseContinuation!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseContinuation = resolve;
    });
    let continuation!: Promise<void>;
    const operation = () => {
      continuation = (async () => {
        await gate;
        store.appendModuleProcessRecord(processRecord());
      })();
      return continuation;
    };

    expect(() =>
      store.runAtomicUpdate(operation as unknown as () => void),
    ).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_REOPEN_REQUIRED",
      }),
    );
    releaseContinuation();
    await expect(continuation).rejects.toEqual(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_REOPEN_REQUIRED",
      }),
    );
    expect(readFileSync(path, "utf8")).toBe(beforeBytes);
    const reopened = openStore("reopened");
    expect(reopened.revision).toBe(beforeRevision);
    expect(reopened.listModuleProcessRecords()).toEqual([]);
  });

  it("propagates an exception without poisoning an unchanged store", () => {
    const store = openStore("first");
    const beforeRevision = store.revision;
    const beforeBytes = readFileSync(path, "utf8");
    const stopped = new Error("stop");

    expect(() =>
      store.runAtomicUpdate(() => {
        throw stopped;
      }),
    ).toThrow(stopped);
    expect(store.revision).toBe(beforeRevision);
    expect(store.listModuleProcessRecords()).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(beforeBytes);
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

    const updateThroughRuntime = store.updateModuleProcessRecordState.bind(store) as (
      processGenerationId: string,
      state: string,
    ) => ModuleProcessRecord;
    expect(() => updateThroughRuntime("process-generation-1", "starting")).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_PROCESS_RECORD_STATE_INVALID",
      }),
    );

    stoppedRecordWriterFor(store).writeStopped("process-generation-1", "STOP_PROVEN");
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

  it("hides the stopped-record writer from direct construction and freezes the factory writer", () => {
    let blockId = 0;
    let runtimeId = 0;
    const directStore = new FileCoreStateStore({
      path,
      maxFailedAttempts: 3,
      nextBlockId: () => `direct-block-${++blockId}`,
      nextDeliveryId: (kind) => `direct-${kind}-${++runtimeId}`,
      now: () => clock,
    });
    expect(
      (directStore as unknown as Record<string, unknown>).stoppedRecordWriter,
    ).toBeUndefined();
    expect(
      (directStore as unknown as Record<string, unknown>).writeStopped,
    ).toBeUndefined();

    const store = openStore("factory");
    const writer = stoppedRecordWriterFor(store);
    expect(Object.isFrozen(writer)).toBe(true);

    store.appendModuleProcessRecord(
      processRecord({ processGenerationId: "process-generation-factory" }),
    );
    expect(() => writer.writeStopped("process-generation-other")).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_PROCESS_RECORD_NOT_FOUND",
      }),
    );
    expect(store.getModuleProcessRecord("process-generation-factory")).toMatchObject({
      state: "starting",
    });
    const stopped = writer.writeStopped("process-generation-factory", "STOP_PROVEN");
    expect(stopped).toMatchObject({
      processGenerationId: "process-generation-factory",
      state: "stopped",
      failureCode: "STOP_PROVEN",
    });
    expect(
      openStore("reopened").getModuleProcessRecord("process-generation-factory"),
    ).toEqual(stopped);
  });

  it("rejects a generic stopped write without stop proof and preserves durable state", () => {
    const store = openStore("first");
    store.appendModuleProcessRecord(processRecord());
    const beforeRevision = store.revision;
    const beforeBytes = readFileSync(path, "utf8");
    clock = LATER;

    // Exercise the runtime boundary rather than relying only on TypeScript's
    // call-site type. JavaScript consumers must receive the same refusal.
    const updateThroughRuntime = store.updateModuleProcessRecordState.bind(store) as (
      processGenerationId: string,
      state: string,
    ) => ModuleProcessRecord;
    expect(() => updateThroughRuntime("process-generation-1", "stopped")).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_PROCESS_STOP_PROOF_REQUIRED",
      }),
    );

    expect(store.revision).toBe(beforeRevision);
    expect(readFileSync(path, "utf8")).toBe(beforeBytes);
    expect(store.getModuleProcessRecord("process-generation-1")).toMatchObject({
      state: "starting",
      updatedAt: NOW,
    });
    expect(openStore("reopened").getModuleProcessRecord("process-generation-1")).toMatchObject({
      state: "starting",
      updatedAt: NOW,
    });
  });

  it("authorizes a submission record only for an exact active Claim and running process", () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    const submission = submissionForClaim(store, claim);
    store.appendModuleProcessRecord(processRecord());

    expect(() => store.appendModuleSubmissionRecord(submission)).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_SUBMISSION_RECORD_UNAUTHORIZED",
      }),
    );

    store.updateModuleProcessRecordState("process-generation-1", "running");
    const stored = store.appendModuleSubmissionRecord(submission);
    expect(store.getModuleSubmissionRecord(claim.runId)).toEqual(stored);

    expect(() => store.appendModuleSubmissionRecord(submission)).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_SUBMISSION_RECORD_CONFLICT",
      }),
    );
  });

  it("copies an accessor-based submission record once before validation and persistence", () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    const input = submissionForClaim(store, claim);
    const reads = new Map<PropertyKey, number>();
    const supplied = new Proxy(input, {
      get(target, property) {
        const count = (reads.get(property) ?? 0) + 1;
        reads.set(property, count);
        return count === 1 ? Reflect.get(target, property, target) : undefined;
      },
    });

    const stored = store.appendModuleSubmissionRecord(supplied);
    expect([...reads.values()].every((count) => count === 1)).toBe(true);

    const reopened = openStore("second");
    expect(reopened.getModuleSubmissionRecord(input.runId)).toEqual(stored);
    expect(reopened.listModuleSubmissionRecords()).toEqual([stored]);
  });

  it("rejects a submission record with no process record or a mismatched generation", () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");

    expect(() =>
      store.appendModuleSubmissionRecord(
        submissionForClaim(store, claim, {
          processGenerationId: "process-generation-9",
        }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_SUBMISSION_RECORD_UNAUTHORIZED",
      }),
    );

    expect(() =>
      store.appendModuleSubmissionRecord(
        submissionForClaim(store, claim, {
          moduleGenerationId: "module-generation-9",
        }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_SUBMISSION_RECORD_UNAUTHORIZED",
      }),
    );
    expect(store.listModuleSubmissionRecords()).toEqual([]);
  });

  it("reconstructs the exact persisted Module input for a Claim", () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    const expected = {
      schemaVersion: "dolly.reactive-module-input/2",
      claimedDeliveryIds: claim.deliveryIds,
      blockGroups: claim.blockGroups,
      hasMore: claim.hasMore,
    };

    expect(store.deliveries.inspectClaimInput(claim)).toEqual(expected);
    expect(openStore("second").deliveries.inspectClaimInput(claim)).toEqual(expected);
  });

  it("rejects a submission record when no exact active Claim exists", () => {
    const store = openStore("first");
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");

    expect(() => store.appendModuleSubmissionRecord(submissionRecord())).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_SUBMISSION_RECORD_UNAUTHORIZED",
      }),
    );
    expect(store.listModuleSubmissionRecords()).toEqual([]);
  });

  it.each([
    ["Module job", { moduleJobId: "another-module-job" }],
    ["Claim token", { claimToken: "another-claim-token" }],
    ["Run", { runId: "another-run" }],
    ["attempt", { attempt: 2 }],
    ["Module generation", { moduleGenerationId: "another-module-generation" }],
  ] satisfies readonly (readonly [string, Partial<ModuleSubmissionRecord>])[])(
    "rejects a submission record whose %s does not match the active Claim",
    (_label, mismatch) => {
      const store = openStore("first");
      const claim = seedActiveClaim(store);
      store.appendModuleProcessRecord(
        processRecord({
          ...("moduleGenerationId" in mismatch
            ? { moduleGenerationId: mismatch.moduleGenerationId }
            : {}),
        }),
      );
      store.updateModuleProcessRecordState("process-generation-1", "running");

      expect(() =>
        store.appendModuleSubmissionRecord(submissionForClaim(store, claim, mismatch)),
      ).toThrowError(
        expect.objectContaining<Partial<ModuleProcessRecordError>>({
          code: "MODULE_SUBMISSION_RECORD_UNAUTHORIZED",
        }),
      );
      expect(store.listModuleSubmissionRecords()).toEqual([]);
    },
  );

  it("rejects a submission record for a Claim owned by another Module", () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store, { consumerId: "another-module" });
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");

    expect(() =>
      store.appendModuleSubmissionRecord(submissionForClaim(store, claim)),
    ).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_SUBMISSION_RECORD_UNAUTHORIZED",
      }),
    );
    expect(store.listModuleSubmissionRecords()).toEqual([]);
  });

  it("rejects a submission record whose input digest is not the persisted Claim input", () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");

    expect(() =>
      store.appendModuleSubmissionRecord(
        submissionForClaim(store, claim, { inputDigest: DIGEST_C }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_SUBMISSION_RECORD_UNAUTHORIZED",
      }),
    );
    expect(store.listModuleSubmissionRecords()).toEqual([]);
  });

  it("blocks direct DeliveryStore Claim terminal methods", () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    if (false) {
      // @ts-expect-error FileCoreStateStore owns positive acknowledgement.
      store.deliveries.ack(claim);
      // @ts-expect-error FileCoreStateStore owns Claim release.
      store.deliveries.releaseClaim(claim);
      // @ts-expect-error FileCoreStateStore owns negative acknowledgement.
      store.deliveries.nack({
        ...claim,
        failure: { code: "test-failure", retryable: true },
      });
      // @ts-expect-error Submission removal is internal to a Claim terminal update.
      store.removeModuleSubmissionRecord(claim.runId);
    }
    const direct = store.deliveries as unknown as {
      ack(identity: DeliveryClaimIdentity): unknown;
      releaseClaim(identity: DeliveryClaimIdentity): unknown;
      nack(request: NegativeAcknowledgementRequest): unknown;
    };

    expect(() => direct.ack(claim)).toThrowError(TypeError);
    expect(() => direct.releaseClaim(claim)).toThrowError(TypeError);
    expect(() =>
      direct.nack({
        ...claim,
        failure: { code: "test-failure", retryable: true },
      }),
    ).toThrowError(TypeError);
    expect("removeModuleSubmissionRecord" in store).toBe(false);
    expect(store.deliveries.inspectClaim(claim).status).toBe("active");
  });

  it("acknowledges a Claim and removes its submission record in one Core-state update", () => {
    const store = openStore("first");
    const claim = seedSubmittedClaim(store);
    const before = store.revision;

    expect(store.acknowledgeDeliveryClaim(claim)).toBe("committed");
    expect(store.revision).toBe(before + 1);
    expect(store.acknowledgeDeliveryClaim(claim)).toBe("already-committed");
    expect(store.revision).toBe(before + 1);

    const reopened = openStore("second");
    expect(reopened.deliveries.inspectClaim(claim).status).toBe("committed");
    expect(reopened.getModuleSubmissionRecord(claim.runId)).toBeUndefined();
  });

  it("does not acknowledge an active Claim without its submission record", () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    const beforeRevision = store.revision;
    const beforeBytes = readFileSync(path, "utf8");

    expect(() => store.acknowledgeDeliveryClaim(claim)).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_SUBMISSION_RECORD_NOT_FOUND",
      }),
    );
    expect(store.revision).toBe(beforeRevision);
    expect(store.deliveries.inspectClaim(claim).status).toBe("active");
    expect(readFileSync(path, "utf8")).toBe(beforeBytes);

    const reopened = openStore("second");
    expect(reopened.deliveries.inspectClaim(claim).status).toBe("active");
    expect(reopened.getModuleSubmissionRecord(claim.runId)).toBeUndefined();
  });

  it("removes only the acknowledged Claim's submission and preserves another active Claim", () => {
    const store = openStore("first");
    const firstClaim = seedActiveClaim(store);
    const secondModuleId = "worker-two";
    const secondModuleGenerationId = "module-generation-2";
    const secondProcessGenerationId = "process-generation-2";
    const secondClaim = seedActiveClaim(store, {
      consumerId: secondModuleId,
      moduleGenerationId: secondModuleGenerationId,
      pageId: "input-two",
    });

    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    const secondProcess = store.appendModuleProcessRecord(
      processRecord({
        moduleId: secondModuleId,
        moduleGenerationId: secondModuleGenerationId,
        processGenerationId: secondProcessGenerationId,
        moduleCgroupPath: cgroupPathFor(
          secondProcessGenerationId,
          secondModuleId,
        ),
      }),
    );
    store.updateModuleProcessRecordState(secondProcessGenerationId, "running");

    const firstSubmission = store.appendModuleSubmissionRecord(
      submissionForClaim(store, firstClaim),
    );
    const secondSubmission = store.appendModuleSubmissionRecord(
      submissionForClaim(store, secondClaim, {
        processGenerationId: secondProcessGenerationId,
      }),
    );
    const secondClaimBefore = store.deliveries.inspectClaim(secondClaim);
    const secondInputBefore = store.deliveries.inspectClaimInput(secondClaim);

    expect(store.acknowledgeDeliveryClaim(firstClaim)).toBe("committed");

    const reopened = openStore("second");
    expect(reopened.deliveries.inspectClaim(firstClaim).status).toBe("committed");
    expect(reopened.getModuleSubmissionRecord(firstSubmission.runId)).toBeUndefined();
    expect(reopened.deliveries.inspectClaim(secondClaim)).toEqual(secondClaimBefore);
    expect(reopened.deliveries.inspectClaimInput(secondClaim)).toEqual(
      secondInputBefore,
    );
    expect(reopened.getModuleSubmissionRecord(secondSubmission.runId)).toEqual(
      secondSubmission,
    );
    expect(reopened.getModuleProcessRecord(secondProcessGenerationId)).toEqual({
      ...secondProcess,
      state: "running",
    });
    expect(reopened.deliveries.listActiveClaims()).toEqual([secondClaimBefore]);
  });

  it("releases a Claim and removes its submission record in one Core-state update", () => {
    const store = openStore("first");
    const claim = seedSubmittedClaim(store);
    const before = store.revision;

    expect(store.releaseDeliveryClaim(claim)).toBe("released");
    expect(store.revision).toBe(before + 1);

    const reopened = openStore("second");
    expect(reopened.deliveries.inspectClaim(claim).status).toBe("released");
    expect(reopened.getModuleSubmissionRecord(claim.runId)).toBeUndefined();
  });

  it("negatively acknowledges a Claim and removes its submission record in one Core-state update", () => {
    const store = openStore("first");
    const claim = seedSubmittedClaim(store);
    const before = store.revision;

    expect(store.negativelyAcknowledgeDeliveryClaim({
      ...claim,
      failure: { code: "test-failure", retryable: true },
    })).toBe("retry-scheduled");
    expect(store.revision).toBe(before + 1);

    const reopened = openStore("second");
    expect(reopened.deliveries.inspectClaim(claim).status).toBe("nacked");
    expect(reopened.getModuleSubmissionRecord(claim.runId)).toBeUndefined();
  });

  it("persists a non-retryable negative acknowledgement and its failure code", () => {
    const store = openStore("first");
    const claim = seedSubmittedClaim(store);
    const failure = {
      code: "permanent-module-failure",
      retryable: false,
    } as const;

    expect(
      store.negativelyAcknowledgeDeliveryClaim({
        ...claim,
        failure,
      }),
    ).toBe("dead-lettered");

    const reopened = openStore("second");
    expect(reopened.deliveries.inspectClaim(claim).status).toBe("dead-lettered");
    expect(reopened.getModuleSubmissionRecord(claim.runId)).toBeUndefined();
    expect(reopened.deliveries.listActiveClaims()).toEqual([]);
    expect(reopened.deliveries.listDeadLetters()).toEqual([
      expect.objectContaining({
        consumerId: MODULE_ID,
        moduleJobId: claim.moduleJobId,
        attempts: claim.attempt,
        failureCode: failure.code,
      }),
    ]);
  });

  it("fails closed when a terminal Claim still has a submission record", () => {
    const store = openStore("first");
    const claim = seedSubmittedClaim(store);
    const submission = store.getModuleSubmissionRecord(claim.runId)!;
    store.releaseDeliveryClaim(claim);

    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    document.moduleSubmissionRecords = [submission];
    const { schemaVersion: _schemaVersion, stateDigest: _stateDigest, ...payload } = document;
    document.stateDigest = canonicalJsonDigest(payload);
    writeFileSync(path, `${JSON.stringify(document)}\n`, "utf8");

    expect(() => openStore("second")).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_DOCUMENT_INVALID",
      }),
    );
  });

  it("writes the submission record in one Core-state revision", () => {
    const store = openStore("first");
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    const claim = seedActiveClaim(store);
    const beforeSubmission = store.revision;
    store.appendModuleSubmissionRecord(submissionForClaim(store, claim));
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
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    store.appendModuleSubmissionRecord(submissionForClaim(store, claim));
    stoppedRecordWriterFor(store).writeStopped("process-generation-1");

    expect(() => store.removeModuleProcessRecord("process-generation-1")).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_PROCESS_RECORD_IN_USE",
      }),
    );

    store.releaseDeliveryClaim(claim);
    store.removeModuleProcessRecord("process-generation-1");
    expect(openStore("second").listModuleProcessRecords()).toEqual([]);
  });

  it("pins a process record while its Module generation still has an active Claim", () => {
    const store = openStore("first");
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());
    stoppedRecordWriterFor(store).writeStopped("process-generation-1");

    expect(() => store.removeModuleProcessRecord("process-generation-1")).toThrowError(
      expect.objectContaining<Partial<ModuleProcessRecordError>>({
        code: "MODULE_PROCESS_RECORD_IN_USE",
      }),
    );
    expect(openStore("second").getModuleProcessRecord("process-generation-1")).toBeDefined();

    store.releaseDeliveryClaim(claim);
    store.removeModuleProcessRecord("process-generation-1");
    expect(openStore("third").getModuleProcessRecord("process-generation-1")).toBeUndefined();
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
    const claim = seedActiveClaim(store);
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState("process-generation-1", "running");
    store.appendModuleSubmissionRecord(submissionForClaim(store, claim));

    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    document.moduleProcessRecords = [];
    const { schemaVersion: _schemaVersion, stateDigest: _stateDigest, ...payload } = document;
    document.stateDigest = canonicalJsonDigest(payload);
    writeFileSync(path, `${JSON.stringify(document)}\n`, "utf8");

    expect(() => openStore("second")).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_DOCUMENT_INVALID",
      }),
    );
  });

  it.each([
    [
      "its process never reached running",
      (record: Record<string, unknown>) => ({ ...record, state: "starting" }),
    ],
    [
      "its process belongs to another Module generation",
      (record: Record<string, unknown>) => ({
        ...record,
        moduleGenerationId: "module-generation-other",
      }),
    ],
  ] as const)(
    "fails closed when a persisted submission record says %s",
    (_label, changeProcessRecord) => {
      const store = openStore("first");
      const claim = seedActiveClaim(store);
      store.appendModuleProcessRecord(processRecord());
      store.updateModuleProcessRecordState("process-generation-1", "running");
      store.appendModuleSubmissionRecord(submissionForClaim(store, claim));

      const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const processRecords = document.moduleProcessRecords as Record<string, unknown>[];
      document.moduleProcessRecords = [
        changeProcessRecord(processRecords[0]!),
      ];
      const {
        schemaVersion: _schemaVersion,
        stateDigest: _stateDigest,
        ...payload
      } = document;
      document.stateDigest = canonicalJsonDigest(payload);
      writeFileSync(path, `${JSON.stringify(document)}\n`, "utf8");

      expect(() => openStore("second")).toThrowError(
        expect.objectContaining<Partial<CoreStateError>>({
          code: "CORE_STATE_DOCUMENT_INVALID",
        }),
      );
    },
  );

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
