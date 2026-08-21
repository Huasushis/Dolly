import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BlockProposal } from "../../../src/core/block-store.js";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import {
  DeliveryStoreError,
  type DeliveryClaimIdentity,
} from "../../../src/core/delivery-store.js";
import {
  CoreStateError,
  FileCoreStateStore,
} from "../../../src/core/file-core-state-store.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import type {
  MediaByteStore,
  MediaInspector,
} from "../../../src/core/media-store.js";
import type {
  ModuleProcessRecord,
  ModuleSubmissionRecord,
} from "../../../src/core/module-process-records.js";
import { seedLegacyProcessRecords } from "./fixtures/process-id-v19-cutover.js";

const NOW = "2026-07-31T00:00:00.000Z";
const INSTANCE_ID = "instance-1";
const MODULE_ID = "worker";
const MODULE_GENERATION_ID = "module-generation-1";
const PROCESS_GENERATION_ID = "process-generation-1";
const PACKAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const CONFIGURATION_REVISION = `sha256:${"b".repeat(64)}`;
const SERVICE_INVOCATION_ID = "2812432ad29e4d3bbd6776c62cafa929";
const BOOT_ID = "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9";

type DeliveryIdKind =
  | "delivery"
  | "module-job"
  | "run"
  | "claim"
  | "lease"
  | "dead-letter";

interface FaultControls {
  failClock: boolean;
  failClockAfterSuccessfulCalls?: number;
  failDeliveryIdKind?: DeliveryIdKind;
}

class PersistentMediaBytes implements MediaByteStore {
  readonly durability = "persistent" as const;
  readonly #values = new Map<string, Uint8Array>();

  async put(mediaId: string, bytes: Uint8Array): Promise<void> {
    this.#values.set(mediaId, Uint8Array.from(bytes));
  }

  async get(mediaId: string): Promise<Uint8Array> {
    const bytes = this.#values.get(mediaId);
    if (bytes === undefined) throw new Error(`Bytes for ${mediaId} do not exist`);
    return Uint8Array.from(bytes);
  }

  async delete(mediaId: string): Promise<void> {
    this.#values.delete(mediaId);
  }

  async has(mediaId: string): Promise<boolean> {
    return this.#values.has(mediaId);
  }
}

function proposal(text: string): BlockProposal {
  return {
    payload: { schema: "test.content/1", value: { text } },
  };
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
      revision: CONFIGURATION_REVISION,
      configVersion: 1,
    },
    declaredExternalEffects: "core-capabilities-only",
    serviceInvocationId: SERVICE_INVOCATION_ID,
    bootId: BOOT_ID,
    moduleCgroupPath: deriveModuleCgroupPath("/system.slice/dolly-core.service", {
      instanceId: INSTANCE_ID,
      moduleId: MODULE_ID,
      processGenerationId: PROCESS_GENERATION_ID,
    }).filesystemPath,
    state: "starting",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function openStore(options: {
  readonly path: string;
  readonly prefix: string;
  readonly controls: FaultControls;
  readonly maxFailedAttempts?: number;
  readonly mediaBytes?: MediaByteStore;
  readonly mediaInspector?: MediaInspector;
}): FileCoreStateStore {
  let blockId = 0;
  let deliveryId = 0;
  return new FileCoreStateStore({
    path: options.path,
    maxFailedAttempts: options.maxFailedAttempts ?? 3,
    nextBlockId: () => `${options.prefix}-block-${++blockId}`,
    nextDeliveryId: (kind) => {
      if (options.controls.failDeliveryIdKind === kind) {
        throw new Error(`injected ${kind} identifier failure`);
      }
      return `${options.prefix}-${kind}-${++deliveryId}`;
    },
    now: () => {
      if (
        options.controls.failClock ||
        options.controls.failClockAfterSuccessfulCalls === 0
      ) {
        throw new Error("injected clock failure");
      }
      if (options.controls.failClockAfterSuccessfulCalls !== undefined) {
        options.controls.failClockAfterSuccessfulCalls -= 1;
      }
      return NOW;
    },
    ...(options.mediaBytes === undefined
      ? {}
      : {
          media: {
            durability: "persistent" as const,
            bytes: options.mediaBytes,
            inspector: options.mediaInspector ?? {
              inspect: async () => ({ mimeType: "application/octet-stream" }),
            },
            maxMediaBytes: 1024,
            idNamespace: options.prefix,
          },
        }),
  });
}

function claimIdentity(claim: DeliveryClaimIdentity): DeliveryClaimIdentity {
  return {
    moduleJobId: claim.moduleJobId,
    claimToken: claim.claimToken,
    runId: claim.runId,
    attempt: claim.attempt,
    moduleGenerationId: claim.moduleGenerationId,
  };
}

function seedSubmittedClaim(store: FileCoreStateStore): {
  readonly identity: DeliveryClaimIdentity;
  readonly blockId: string;
} {
  store.deliveries.createPage("input");
  store.deliveries.registerConsumer("input", MODULE_ID, "from-now");
  const block = store.blocks.commit(proposal("input"), {
    kind: "external",
    id: "console",
  });
  store.deliveries.append("input", block.id);
  store.updateModuleProcessRecordState(PROCESS_GENERATION_ID, "running");
  const claim = store.deliveries.claim({
    consumerId: MODULE_ID,
    pageIds: ["input"],
    moduleGenerationId: MODULE_GENERATION_ID,
    maxCount: 1,
    maxBytes: 1024 * 1024,
  })!;
  const identity = claimIdentity(claim);
  const submission: ModuleSubmissionRecord = {
    schemaVersion: "dolly.module-submission-record/1",
    ...identity,
    processGenerationId: PROCESS_GENERATION_ID,
    inputDigest: canonicalJsonDigest(store.deliveries.inspectClaimInput(identity)),
    createdAt: NOW,
  };
  store.appendModuleSubmissionRecord(submission);
  return { identity, blockId: block.id };
}

function expectReopenRequired(operation: () => unknown): void {
  expect(operation).toThrowError(
    expect.objectContaining<Partial<CoreStateError>>({
      code: "CORE_STATE_REOPEN_REQUIRED",
    }),
  );
}

describe("File Core state mutation failures before persistence notification", () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-core-mutation-failure-"));
    path = join(root, "core-state.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // A legacy document can no longer accept caller-supplied process records
  // through the store's write API, so the fixture seeds the exact record into
  // the freshly created version-18 document before the store is reopened.
  function seededStore(
    prefix: string,
    controls: FaultControls,
    options: {
      readonly maxFailedAttempts?: number;
      readonly mediaBytes?: MediaByteStore;
      readonly mediaInspector?: MediaInspector;
    } = {},
  ): FileCoreStateStore {
    openStore({
      path,
      prefix: `${prefix}-seed`,
      controls: { failClock: false },
      ...options,
    });
    seedLegacyProcessRecords(path, { processRecords: [processRecord()] });
    return openStore({ path, prefix, controls, ...options });
  }

  it("requires reopening when Delivery append consumes an ID before the clock fails", () => {
    const controls: FaultControls = { failClock: false };
    const store = openStore({ path, prefix: "append", controls });
    store.deliveries.createPage("input");
    const block = store.blocks.commit(proposal("input"), {
      kind: "external",
      id: "console",
    });
    const beforeSnapshot = store.snapshot();
    const beforeRevision = store.revision;
    const beforeBytes = readFileSync(path);
    const savedDeliverySnapshot = store.deliveries.snapshot;
    const savedBlockLookup = store.blocks.get;

    controls.failClock = true;
    expectReopenRequired(() => store.deliveries.append("input", block.id));

    expectReopenRequired(() => store.revision);
    expectReopenRequired(savedDeliverySnapshot);
    expectReopenRequired(() => savedBlockLookup(block.id));
    expect(readFileSync(path)).toEqual(beforeBytes);

    controls.failClock = false;
    const reopened = openStore({
      path,
      prefix: "append-reopened",
      controls: { failClock: false },
    });
    expect(reopened.revision).toBe(beforeRevision);
    expect(reopened.snapshot()).toEqual(beforeSnapshot);
  });

  for (const fault of [
    {
      name: "dead-letter identifier allocation",
      enable(controls: FaultControls) {
        controls.failDeliveryIdKind = "dead-letter";
      },
    },
    {
      name: "dead-letter timestamp",
      enable(controls: FaultControls) {
        controls.failClock = true;
      },
    },
  ] as const) {
    it(`requires reopening when ${fault.name} fails after nack has changed Delivery state`, () => {
      const controls: FaultControls = { failClock: false };
      const store = seededStore("nack", controls, { maxFailedAttempts: 1 });
      const { identity, blockId } = seedSubmittedClaim(store);
      const beforeSnapshot = store.snapshot();
      const beforeRevision = store.revision;
      const beforeBytes = readFileSync(path);
      const savedDeliverySnapshot = store.deliveries.snapshot;
      const savedLeaseCount = store.referenceGraph.leaseCountFor;

      fault.enable(controls);
      expectReopenRequired(() =>
        store.negativelyAcknowledgeDeliveryClaim({
          ...identity,
          failure: { code: "MODULE_FAILED", retryable: false },
        }),
      );

      expectReopenRequired(() => store.revision);
      expectReopenRequired(savedDeliverySnapshot);
      expectReopenRequired(() =>
        savedLeaseCount({ kind: "block", id: blockId }),
      );
      expect(readFileSync(path)).toEqual(beforeBytes);

      const reopened = openStore({
        path,
        prefix: "nack-reopened",
        controls: { failClock: false },
        maxFailedAttempts: 1,
      });
      expect(reopened.revision).toBe(beforeRevision);
      expect(reopened.snapshot()).toEqual(beforeSnapshot);
      expect(reopened.deliveries.inspectClaim(identity)).toMatchObject({
        ...identity,
        status: "active",
      });
      expect(reopened.getModuleSubmissionRecord(identity.runId)).toEqual(
        beforeSnapshot.moduleSubmissionRecords[0],
      );
      expect(
        reopened.referenceGraph.leaseCountFor({ kind: "block", id: blockId }),
      ).toBe(1);
    });
  }

  it("keeps an unchanged store usable when an atomic callback throws before mutation", () => {
    const store = openStore({
      path,
      prefix: "callback",
      controls: { failClock: false },
    });
    const beforeSnapshot = store.snapshot();
    const beforeRevision = store.revision;
    const beforeBytes = readFileSync(path);
    const savedDeliverySnapshot = store.deliveries.snapshot;
    const stopped = new Error("stop before mutation");

    expect(() =>
      store.runAtomicUpdate(() => {
        throw stopped;
      }),
    ).toThrow(stopped);

    expect(store.revision).toBe(beforeRevision);
    expect(savedDeliverySnapshot()).toEqual(beforeSnapshot.deliveries);
    expect(store.snapshot()).toEqual(beforeSnapshot);
    expect(readFileSync(path)).toEqual(beforeBytes);
  });

  it("keeps an unchanged store usable after duplicate Page validation fails", () => {
    const store = openStore({
      path,
      prefix: "duplicate-page",
      controls: { failClock: false },
    });
    store.deliveries.createPage("input");
    const beforeSnapshot = store.snapshot();
    const beforeRevision = store.revision;
    const beforeBytes = readFileSync(path);
    const savedDeliverySnapshot = store.deliveries.snapshot;

    expect(() => store.deliveries.createPage("input")).toThrowError(
      expect.objectContaining<Partial<DeliveryStoreError>>({
        code: "PAGE_EXISTS",
      }),
    );

    expect(store.revision).toBe(beforeRevision);
    expect(savedDeliverySnapshot()).toEqual(beforeSnapshot.deliveries);
    expect(store.snapshot()).toEqual(beforeSnapshot);
    expect(readFileSync(path)).toEqual(beforeBytes);
    expect(
      openStore({
        path,
        prefix: "duplicate-page-reopened",
        controls: { failClock: false },
      }).snapshot(),
    ).toEqual(beforeSnapshot);
  });

  it("requires reopening when asynchronous Media registration allocates an ID before the clock fails", async () => {
    const controls: FaultControls = { failClock: false };
    const mediaBytes = new PersistentMediaBytes();
    const store = openStore({
      path,
      prefix: "media-registration",
      controls,
      mediaBytes,
    });
    const beforeSnapshot = store.snapshot();
    const beforeRevision = store.revision;
    const beforeBytes = readFileSync(path);
    const savedMediaSnapshot = store.media!.snapshot;

    controls.failClockAfterSuccessfulCalls = 1;
    await expect(
      store.media!.registerMedia({
        registrationId: "registration-1",
        bytes: Uint8Array.from([1, 2, 3]),
        provenance: {
          sourceClass: "streamed-upload",
          sourceLabel: "test",
        },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_REOPEN_REQUIRED",
      }),
    );

    expectReopenRequired(() => store.revision);
    expectReopenRequired(savedMediaSnapshot);
    expect(readFileSync(path)).toEqual(beforeBytes);

    const reopened = openStore({
      path,
      prefix: "media-registration",
      controls: { failClock: false },
      mediaBytes,
    });
    expect(reopened.revision).toBe(beforeRevision);
    expect(reopened.snapshot()).toEqual(beforeSnapshot);
  });

  it("blocks other Core access until an asynchronous Media mutation settles", async () => {
    const mediaBytes = new PersistentMediaBytes();
    let completeInspection!: (
      inspection: { readonly mimeType: string },
    ) => void;
    const inspection = new Promise<{ readonly mimeType: string }>((resolve) => {
      completeInspection = resolve;
    });
    const store = openStore({
      path,
      prefix: "media-pending",
      controls: { failClock: false },
      mediaBytes,
      mediaInspector: {
        inspect: () => inspection,
      },
    });

    const registration = store.media!.registerMedia({
      registrationId: "registration-pending",
      bytes: Uint8Array.from([1, 2, 3]),
      provenance: { sourceClass: "streamed-upload" },
    });
    expect(() => store.snapshot()).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_LOCKED",
      }),
    );
    expect(() => store.deliveries.createPage("while-media-pending"))
      .toThrowError(
        expect.objectContaining<Partial<CoreStateError>>({
          code: "CORE_STATE_LOCKED",
        }),
      );

    completeInspection({ mimeType: "application/octet-stream" });
    await expect(registration).resolves.toMatchObject({
      mimeType: "application/octet-stream",
    });
    expect(() => store.snapshot()).not.toThrow();

    const reopened = openStore({
      path,
      prefix: "media-pending",
      controls: { failClock: false },
      mediaBytes,
    });
    expect(reopened.media!.listRegistrations()).toHaveLength(1);
  });

  it("rejects an asynchronous Media mutation before an atomic callback can start it", async () => {
    const mediaBytes = new PersistentMediaBytes();
    let inspectionCalls = 0;
    const store = openStore({
      path,
      prefix: "media-atomic",
      controls: { failClock: false },
      mediaBytes,
      mediaInspector: {
        inspect: async () => {
          inspectionCalls += 1;
          return { mimeType: "application/octet-stream" };
        },
      },
    });
    const before = store.snapshot();

    expect(() =>
      store.runAtomicUpdate(() => {
        void store.media!.registerMedia({
          registrationId: "registration-atomic",
          bytes: Uint8Array.from([1, 2, 3]),
          provenance: { sourceClass: "streamed-upload" },
        });
      }),
    ).toThrowError(
      expect.objectContaining<Partial<CoreStateError>>({
        code: "CORE_STATE_IO_FAILED",
      }),
    );
    expect(store.snapshot()).toEqual(before);
    expect(inspectionCalls).toBe(0);
  });
});
