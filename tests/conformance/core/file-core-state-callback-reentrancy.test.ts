import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CoreStateError,
  FileCoreStateStore,
  createFileCoreStateStoreWithStoppedRecordWriter,
} from "../../../src/core/file-core-state-store.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import type {
  ModuleProcessRecord,
  ModuleProcessStoppedRecordWriter,
} from "../../../src/core/module-process-records.js";

const NOW = "2026-07-31T00:00:00.000Z";
const LATER = "2026-07-31T00:00:05.000Z";
const INSTANCE_ID = "instance-1";
const MODULE_ID = "worker";
const PROCESS_GENERATION_ID = "process-generation-1";
const PACKAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const CONFIGURATION_DIGEST = `sha256:${"b".repeat(64)}`;
const SERVICE_INVOCATION_ID = "2812432ad29e4d3bbd6776c62cafa929";
const BOOT_ID = "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9";
const DELEGATED_ROOT = "/system.slice/dolly-core.service";

function processRecord(
  processGenerationId: string = PROCESS_GENERATION_ID,
): ModuleProcessRecord {
  return {
    schemaVersion: "dolly.module-process-record/1",
    instanceId: INSTANCE_ID,
    moduleId: MODULE_ID,
    moduleGenerationId: "module-generation-1",
    processGenerationId,
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
      processGenerationId,
    }).filesystemPath,
    state: "starting",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function caught(operation: () => void): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("FileCore configured callback reentrancy", () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-core-callback-reentrancy-"));
    path = join(root, "core-state.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects a clock that tries to change a process record while an outer transition uses its old state", () => {
    let store!: FileCoreStateStore;
    let stoppedRecordWriter!: ModuleProcessStoppedRecordWriter;
    let reenter = false;
    let blockId = 0;
    let deliveryId = 0;
    ({ store, stoppedRecordWriter } =
      createFileCoreStateStoreWithStoppedRecordWriter({
        path,
        maxFailedAttempts: 3,
        nextBlockId: () => `block-${++blockId}`,
        nextDeliveryId: (kind) => `${kind}-${++deliveryId}`,
        now: () => {
          if (reenter) {
            reenter = false;
            stoppedRecordWriter.writeStopped(PROCESS_GENERATION_ID);
          }
          return LATER;
        },
      }));
    store.appendModuleProcessRecord(processRecord());
    store.updateModuleProcessRecordState(PROCESS_GENERATION_ID, "running");
    const revisionBefore = store.revision;
    const bytesBefore = readFileSync(path);

    reenter = true;
    const error = caught(() => {
      store.updateModuleProcessRecordState(PROCESS_GENERATION_ID, "stopping");
    });

    expect(error).toBeInstanceOf(CoreStateError);
    expect(error).toMatchObject({ code: "CORE_STATE_LOCKED" });
    expect(store.revision).toBe(revisionBefore);
    expect(store.getModuleProcessRecord(PROCESS_GENERATION_ID)?.state).toBe("running");
    expect(readFileSync(path)).toEqual(bytesBefore);

    expect(
      store.updateModuleProcessRecordState(PROCESS_GENERATION_ID, "stopping").state,
    ).toBe("stopping");
  });

  it("rejects an identifier generator that tries to mutate Core during an atomic component update", () => {
    let store!: FileCoreStateStore;
    let reenter = false;
    let blockId = 0;
    let deliveryId = 0;
    store = new FileCoreStateStore({
      path,
      maxFailedAttempts: 3,
      nextBlockId: () => {
        if (reenter) {
          reenter = false;
          store.appendModuleProcessRecord(processRecord("nested-process-generation"));
        }
        return `block-${++blockId}`;
      },
      nextDeliveryId: (kind) => `${kind}-${++deliveryId}`,
      now: () => NOW,
    });
    const revisionBefore = store.revision;
    const bytesBefore = readFileSync(path);

    reenter = true;
    const error = caught(() => {
      store.runAtomicUpdate(() => {
        store.blocks.commit(
          { payload: { schema: "test.content/1", value: { text: "input" } } },
          { kind: "external", id: "console" },
        );
      });
    });

    expect(error).toMatchObject({ code: "BLOCK_ID_INVALID" });
    expect(store.revision).toBe(revisionBefore);
    expect(store.blocks.snapshot().records).toEqual([]);
    expect(store.listModuleProcessRecords()).toEqual([]);
    expect(readFileSync(path)).toEqual(bytesBefore);

    expect(
      store.blocks.commit(
        { payload: { schema: "test.content/1", value: { text: "input" } } },
        { kind: "external", id: "console" },
      ).id,
    ).toBe("block-1");
  });

  it("rejects a Delivery identifier generator that tries to mutate Core during an atomic update", () => {
    let store!: FileCoreStateStore;
    let reenter = false;
    let blockId = 0;
    let deliveryId = 0;
    store = new FileCoreStateStore({
      path,
      maxFailedAttempts: 3,
      nextBlockId: () => `block-${++blockId}`,
      nextDeliveryId: (kind) => {
        if (reenter) {
          reenter = false;
          store.appendModuleProcessRecord(processRecord("nested-process-generation"));
        }
        return `${kind}-${++deliveryId}`;
      },
      now: () => NOW,
    });
    store.deliveries.createPage("input");
    store.deliveries.registerConsumer("input", MODULE_ID, "from-now");
    const block = store.blocks.commit(
      { payload: { schema: "test.content/1", value: { text: "input" } } },
      { kind: "external", id: "console" },
    );
    const revisionBefore = store.revision;
    const bytesBefore = readFileSync(path);

    reenter = true;
    const error = caught(() => {
      store.runAtomicUpdate(() => {
        store.deliveries.append("input", block.id);
      });
    });

    expect(error).toMatchObject({ code: "DELIVERY_ID_INVALID" });
    expect(store.revision).toBe(revisionBefore);
    expect(store.deliveries.snapshot().deliveries).toEqual([]);
    expect(store.listModuleProcessRecords()).toEqual([]);
    expect(readFileSync(path)).toEqual(bytesBefore);

    expect(store.deliveries.append("input", block.id).deliveryId).toBe("delivery-1");
  });
});
