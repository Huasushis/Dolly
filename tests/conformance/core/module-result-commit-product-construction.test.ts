import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BlockStore } from "../../../src/core/block-store.js";
import { DeliveryStore } from "../../../src/core/delivery-store.js";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import { createModuleResultCommitCoordinator } from "../../../src/core/module-result-commit-factory.js";
import {
  InMemoryModuleResultCommitRepository,
  ModuleResultCommitCoordinator,
} from "../../../src/core/module-result-commit.js";

const NOW = "2026-07-31T00:00:00.000Z";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openCore(prefix: string): FileCoreStateStore {
  const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
  temporaryDirectories.push(directory);
  let blockId = 0;
  let deliveryId = 0;
  return new FileCoreStateStore({
    path: join(directory, "core-state.json"),
    maxFailedAttempts: 3,
    nextBlockId: () => `${prefix}-block-${++blockId}`,
    nextDeliveryId: (kind) => `${prefix}-${kind}-${++deliveryId}`,
    now: () => NOW,
  });
}

describe("product Module result commit construction", () => {
  it("constructs the product coordinator from one direct FileCoreStateStore", () => {
    const core = openCore("product-result-commit");
    const coordinator = createModuleResultCommitCoordinator({
      core,
      repository: new InMemoryModuleResultCommitRepository(),
      now: () => NOW,
      mailboxes: [],
    });

    expect(coordinator).toBeInstanceOf(ModuleResultCommitCoordinator);
  });

  it("obtains a frozen operation set that does not expose terminal Delivery methods", () => {
    const core = openCore("result-commit-operations");
    const operations = Reflect.apply(
      FileCoreStateStore.prototype.createModuleResultCommitOperations,
      core,
      [],
    );

    expect(Object.getPrototypeOf(operations)).toBeNull();
    expect(Object.isFrozen(operations)).toBe(true);
    expect(Object.getPrototypeOf(operations.deliveries)).toBeNull();
    expect(Object.isFrozen(operations.deliveries)).toBe(true);
    expect(operations.deliveries).not.toHaveProperty("ack");
    expect(operations.deliveries).not.toHaveProperty("releaseClaim");
    expect(operations.deliveries).not.toHaveProperty("nack");
    expect(operations.deliveries).not.toHaveProperty("setMutationObserver");
  });

  it("rejects separately assembled Core operations before creating a journal or effect", () => {
    let blockId = 0;
    let deliveryId = 0;
    const blocks = new BlockStore({
      nextBlockId: () => `block-${++blockId}`,
      now: () => NOW,
    });
    const deliveries = new DeliveryStore({
      blocks,
      maxFailedAttempts: 3,
      nextId: (kind) => `${kind}-${++deliveryId}`,
      now: () => NOW,
    });
    const repository = new InMemoryModuleResultCommitRepository();
    const assembledCore = {
      blocks,
      deliveries,
      getModuleSubmissionRecord: () => undefined,
      acknowledgeDeliveryClaim: () => "committed",
    } as unknown as FileCoreStateStore;

    expect(() =>
      createModuleResultCommitCoordinator({
        core: assembledCore,
        repository,
        now: () => NOW,
        mailboxes: [],
      }),
    ).toThrowError(
      new TypeError(
        "Module result commit requires one direct FileCoreStateStore instance",
      ),
    );
    expect(repository.list()).toEqual([]);
    expect(blocks.snapshot().commitEffects).toEqual([]);
    expect(deliveries.snapshot().appendEffects).toEqual([]);
  });

  it("rejects a Proxy around a real FileCoreStateStore", () => {
    const core = openCore("proxied-result-commit");
    const repository = new InMemoryModuleResultCommitRepository();

    expect(() =>
      createModuleResultCommitCoordinator({
        core: new Proxy(core, {}),
        repository,
        now: () => NOW,
        mailboxes: [],
      }),
    ).toThrowError(
      new TypeError(
        "Module result commit requires one direct FileCoreStateStore instance",
      ),
    );
    expect(repository.list()).toEqual([]);
  });

  it("keeps public operation fields fixed and does not read replaceable methods", () => {
    const core = openCore("private-result-commit-operations");
    const replacement = openCore("replacement-result-commit-operations");
    expect(Reflect.defineProperty(core, "blocks", {
      value: replacement.blocks,
    })).toBe(false);
    expect(Reflect.defineProperty(core, "deliveries", {
      value: replacement.deliveries,
    })).toBe(false);
    Object.defineProperties(core, {
      getModuleSubmissionRecord: {
        value: () => {
          throw new Error("replaceable method was called");
        },
      },
      acknowledgeDeliveryClaim: {
        value: () => {
          throw new Error("replaceable method was called");
        },
      },
    });

    expect(() =>
      createModuleResultCommitCoordinator({
        core,
        repository: new InMemoryModuleResultCommitRepository(),
        now: () => NOW,
        mailboxes: [],
      }),
    ).not.toThrow();
  });

  it("rejects a subclass that can replace public Core operations", () => {
    class ReplacingFileCoreStateStore extends FileCoreStateStore {}

    const directory = mkdtempSync(join(tmpdir(), "subclassed-result-commit-"));
    temporaryDirectories.push(directory);
    const core = new ReplacingFileCoreStateStore({
      path: join(directory, "core-state.json"),
      maxFailedAttempts: 3,
      nextBlockId: () => "block-1",
      nextDeliveryId: (kind) => `${kind}-1`,
      now: () => NOW,
    });
    const repository = new InMemoryModuleResultCommitRepository();

    expect(() =>
      createModuleResultCommitCoordinator({
        core,
        repository,
        now: () => NOW,
        mailboxes: [],
      }),
    ).toThrowError(
      new TypeError(
        "Module result commit requires one direct FileCoreStateStore instance",
      ),
    );
    expect(repository.list()).toEqual([]);
  });
});
