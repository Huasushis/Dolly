import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalJsonDigest,
  type JsonValue,
} from "../../../src/core/canonical-json.js";
import type { DeliveryClaimIdentity } from "../../../src/core/delivery-store.js";
import {
  FileCoreStateStore,
  migrateCoreStateDocumentToVersion17,
} from "../../../src/core/file-core-state-store.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import {
  assertValidModuleSubmissionRecord,
  type ModuleProcessRecord,
  type ModuleSubmissionRecord,
} from "../../../src/core/module-process-records.js";

const NOW = "2026-07-31T00:00:00.000Z";
const MIGRATION_OPTIONS = {
  runtimeConfiguration: {
    maxFailedAttempts: 3,
    media: { enabled: false as const },
  },
};
const INSTANCE_ID = "instance-1";
const MODULE_ID = "worker";
const MODULE_GENERATION_ID = "module-generation-1";
const PROCESS_GENERATION_ID = "process-generation-1";
const DELEGATED_ROOT = "/system.slice/dolly-core.service";
const PACKAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const CONFIGURATION_DIGEST = `sha256:${"b".repeat(64)}`;
const SERVICE_INVOCATION_ID = "2812432ad29e4d3bbd6776c62cafa929";
const BOOT_ID = "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9";

/**
 * This error means that migration from an older Core-state document cannot
 * determine whether the matching Module submission record ever existed. It
 * describes missing historical evidence, not a current authorization result.
 */
const UNKNOWN_SUBMISSION_HISTORY_ERROR =
  "MODULE_CLAIM_SUBMISSION_HISTORY_UNKNOWN";

type JsonObject = Record<string, JsonValue>;

interface SeededState {
  readonly store: FileCoreStateStore;
  readonly identity: DeliveryClaimIdentity;
  readonly submission: ModuleSubmissionRecord;
}

interface StateBeforeRejectedWrite {
  readonly raw: string;
  readonly revision: number;
  readonly claim: ReturnType<FileCoreStateStore["deliveries"]["inspectClaim"]>;
  readonly deliveries: ReturnType<FileCoreStateStore["deliveries"]["snapshot"]>;
  readonly processRecords: readonly ModuleProcessRecord[];
  readonly submissionRecords: readonly ModuleSubmissionRecord[];
  readonly unknownSubmissionHistory: readonly DeliveryClaimIdentity[];
}

function openStore(path: string, prefix: string): FileCoreStateStore {
  let blockId = 0;
  let deliveryId = 0;
  return new FileCoreStateStore({
    path,
    maxFailedAttempts: 3,
    nextBlockId: () => `${prefix}-block-${++blockId}`,
    nextDeliveryId: (kind) => `${prefix}-${kind}-${++deliveryId}`,
    now: () => NOW,
  });
}

function processRecord(): ModuleProcessRecord {
  return {
    schemaVersion: "dolly.module-process-record/1",
    instanceId: INSTANCE_ID,
    moduleId: MODULE_ID,
    moduleGenerationId: MODULE_GENERATION_ID,
    processGenerationId: PROCESS_GENERATION_ID,
    packageDigest: PACKAGE_DIGEST,
    configurationReference: {
      configId: "config-1",
      revision: CONFIGURATION_DIGEST,
      configVersion: 1,
    },
    declaredExternalEffects: "core-capabilities-only",
    serviceInvocationId: SERVICE_INVOCATION_ID,
    bootId: BOOT_ID,
    moduleCgroupPath: deriveModuleCgroupPath(DELEGATED_ROOT, {
      instanceId: INSTANCE_ID,
      moduleId: MODULE_ID,
      processGenerationId: PROCESS_GENERATION_ID,
    }).filesystemPath,
    state: "starting",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function readDocument(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}

function rewriteAsVersion16(path: string): void {
  const current = readDocument(path);
  const payload: JsonObject = {
    revision: current.revision!,
    referenceGraph: current.referenceGraph!,
    ...(current.media === undefined ? {} : { media: current.media }),
    blocks: current.blocks!,
    deliveries: current.deliveries!,
    moduleProcessRecords: current.moduleProcessRecords!,
    moduleSubmissionRecords: current.moduleSubmissionRecords!,
  };
  const version16: JsonObject = {
    schemaVersion: "dolly.core-state/16",
    stateDigest: canonicalJsonDigest(payload),
    ...payload,
  };
  writeFileSync(path, `${JSON.stringify(version16)}\n`, "utf8");
}

function seedMigratedState(path: string): SeededState {
  const initial = openStore(path, "initial");
  initial.deliveries.createPage("input");
  initial.deliveries.registerConsumer("input", MODULE_ID, "from-now");
  const block = initial.blocks.commit(
    {
      payload: {
        schema: "test.content/1",
        value: { text: "submission history boundary" },
      },
    },
    { kind: "external", id: "console" },
  );
  initial.deliveries.append("input", block.id);
  const claim = initial.deliveries.claim({
    consumerId: MODULE_ID,
    pageIds: ["input"],
    moduleGenerationId: MODULE_GENERATION_ID,
    maxCount: 1,
    maxBytes: 1024 * 1024,
  })!;
  const identity: DeliveryClaimIdentity = Object.freeze({
    moduleJobId: claim.moduleJobId,
    claimToken: claim.claimToken,
    runId: claim.runId,
    attempt: claim.attempt,
    moduleGenerationId: claim.moduleGenerationId,
  });
  initial.appendModuleProcessRecord(processRecord());
  initial.updateModuleProcessRecordState(PROCESS_GENERATION_ID, "running");

  const inputDigest = canonicalJsonDigest(
    initial.deliveries.inspectClaimInput(identity),
  );
  rewriteAsVersion16(path);
  expect(migrateCoreStateDocumentToVersion17(path, MIGRATION_OPTIONS)).toEqual({
    status: "migrated",
    sourceSchemaVersion: "dolly.core-state/16",
    backupPath: `${path}.v16.backup`,
  });

  const store = openStore(path, "reopened");
  const submission: ModuleSubmissionRecord = Object.freeze({
    schemaVersion: "dolly.module-submission-record/1",
    ...identity,
    processGenerationId: PROCESS_GENERATION_ID,
    inputDigest,
    createdAt: NOW,
  });
  assertValidModuleSubmissionRecord(submission);
  expect(store.getModuleProcessRecord(PROCESS_GENERATION_ID)?.state).toBe(
    "running",
  );
  expect(canonicalJsonDigest(store.deliveries.inspectClaimInput(identity))).toBe(
    inputDigest,
  );

  return { store, identity, submission };
}

function captureState(
  path: string,
  state: SeededState,
): StateBeforeRejectedWrite {
  return {
    raw: readFileSync(path, "utf8"),
    revision: state.store.revision,
    claim: state.store.deliveries.inspectClaim(state.identity),
    deliveries: state.store.deliveries.snapshot(),
    processRecords: state.store.listModuleProcessRecords(),
    submissionRecords: state.store.listModuleSubmissionRecords(),
    unknownSubmissionHistory:
      state.store.listActiveClaimsWithUnknownSubmissionHistory(),
  };
}

function expectRejectedWriteChangedNothing(
  path: string,
  state: SeededState,
  before: StateBeforeRejectedWrite,
): void {
  expect(readFileSync(path, "utf8")).toBe(before.raw);
  expect(state.store.revision).toBe(before.revision);
  expect(state.store.deliveries.inspectClaim(state.identity)).toEqual(
    before.claim,
  );
  expect(state.store.deliveries.snapshot()).toEqual(before.deliveries);
  expect(
    state.store.deliveries.snapshot().moduleJobs.find(
      (job) => job.moduleJobId === state.identity.moduleJobId,
    )?.failedAttemptCount,
  ).toBe(0);
  expect(state.store.deliveries.listDeadLetters()).toEqual([]);
  expect(state.store.listModuleProcessRecords()).toEqual(before.processRecords);
  expect(state.store.listModuleSubmissionRecords()).toEqual(
    before.submissionRecords,
  );
  expect(state.store.listActiveClaimsWithUnknownSubmissionHistory()).toEqual(
    before.unknownSubmissionHistory,
  );
  expect(
    state.store.hasActiveClaimWithUnknownSubmissionHistory(state.identity),
  ).toBe(true);

  const reopened = openStore(path, "unchanged");
  expect(reopened.revision).toBe(before.revision);
  expect(reopened.deliveries.inspectClaim(state.identity)).toEqual(before.claim);
  expect(reopened.deliveries.snapshot()).toEqual(before.deliveries);
  expect(reopened.listModuleSubmissionRecords()).toEqual(
    before.submissionRecords,
  );
  expect(reopened.listActiveClaimsWithUnknownSubmissionHistory()).toEqual(
    before.unknownSubmissionHistory,
  );
}

describe("FileCore writes when migrated submission history is unknown", () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(
      join(tmpdir(), "dolly-core-state-unknown-submission-history-"),
    );
    path = join(root, "core-state.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("queries all five Claim identity fields exactly", () => {
    const state = seedMigratedState(path);

    expect(
      state.store.hasActiveClaimWithUnknownSubmissionHistory(state.identity),
    ).toBe(true);
    for (const [field, differentValue] of [
      ["moduleJobId", `${state.identity.moduleJobId}-different`],
      ["claimToken", `${state.identity.claimToken}-different`],
      ["runId", `${state.identity.runId}-different`],
      ["attempt", state.identity.attempt + 1],
      [
        "moduleGenerationId",
        `${state.identity.moduleGenerationId}-different`,
      ],
    ] as const) {
      expect(
        state.store.hasActiveClaimWithUnknownSubmissionHistory({
          ...state.identity,
          [field]: differentValue,
        }),
      ).toBe(false);
    }
  });

  it("rejects an otherwise valid submission record before changing state", () => {
    const state = seedMigratedState(path);
    const before = captureState(path, state);

    expect(() =>
      state.store.appendModuleSubmissionRecord(state.submission),
    ).toThrowError(
      expect.objectContaining({
        code: UNKNOWN_SUBMISSION_HISTORY_ERROR,
      }),
    );
    expectRejectedWriteChangedNothing(path, state, before);
  });

  it.each([
    [
      "acknowledgement",
      (state: SeededState) =>
        state.store.acknowledgeDeliveryClaim(state.identity),
    ],
    [
      "result-commit acknowledgement",
      (state: SeededState) =>
        state.store
          .createModuleResultCommitOperations()
          .acknowledgeDeliveryClaim(state.identity),
    ],
    [
      "release",
      (state: SeededState) => state.store.releaseDeliveryClaim(state.identity),
    ],
    [
      "retryable negative acknowledgement",
      (state: SeededState) =>
        state.store.negativelyAcknowledgeDeliveryClaim({
          ...state.identity,
          failure: { code: "temporary-failure", retryable: true },
        }),
    ],
    [
      "non-retryable negative acknowledgement",
      (state: SeededState) =>
        state.store.negativelyAcknowledgeDeliveryClaim({
          ...state.identity,
          failure: { code: "permanent-failure", retryable: false },
        }),
    ],
  ] as const)(
    "rejects %s before changing the Claim, failure count, dead letters, or file",
    (_label, write) => {
      const state = seedMigratedState(path);
      const before = captureState(path, state);

      expect(() => write(state)).toThrowError(
        expect.objectContaining({
          code: UNKNOWN_SUBMISSION_HISTORY_ERROR,
        }),
      );
      expectRejectedWriteChangedNothing(path, state, before);
    },
  );

  it("does not expose the collection for deletion and preserves it across other writes", () => {
    const state = seedMigratedState(path);
    const listed = state.store.listActiveClaimsWithUnknownSubmissionHistory();

    (listed as DeliveryClaimIdentity[]).splice(0, listed.length);
    expect(state.store.listActiveClaimsWithUnknownSubmissionHistory()).toEqual([
      state.identity,
    ]);
    expect("ack" in state.store.deliveries).toBe(false);
    expect("releaseClaim" in state.store.deliveries).toBe(false);
    expect("nack" in state.store.deliveries).toBe(false);

    const revisionBeforeUnrelatedWrite = state.store.revision;
    state.store.blocks.commit(
      {
        payload: {
          schema: "test.content/1",
          value: { text: "unrelated durable write" },
        },
      },
      { kind: "external", id: "console" },
    );

    expect(state.store.revision).toBe(revisionBeforeUnrelatedWrite + 1);
    expect(state.store.listActiveClaimsWithUnknownSubmissionHistory()).toEqual([
      state.identity,
    ]);
    const reopened = openStore(path, "after-unrelated-write");
    expect(reopened.listActiveClaimsWithUnknownSubmissionHistory()).toEqual([
      state.identity,
    ]);
  });
});
