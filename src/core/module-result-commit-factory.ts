import { FileCoreStateStore } from "./file-core-state-store.js";
import { type DeliveryMailboxCapacity } from "./delivery-store.js";
import {
  ModuleResultCommitCoordinator,
  type ModuleResultCommitHookEvent,
  type ModuleResultCommitRepository,
} from "./module-result-commit.js";

export interface CreateModuleResultCommitCoordinatorOptions {
  readonly core: FileCoreStateStore;
  readonly repository: ModuleResultCommitRepository;
  readonly now: () => string;
  readonly mailboxes: readonly DeliveryMailboxCapacity[];
  readonly afterEffect?: (
    event: ModuleResultCommitHookEvent,
  ) => void | Promise<void>;
}

function assertDirectFileCoreStateStore(
  core: FileCoreStateStore,
): void {
  let hasDirectPrototype = false;
  try {
    hasDirectPrototype =
      Object.getPrototypeOf(core) === FileCoreStateStore.prototype;
  } catch {
    // A revoked Proxy, like any other Proxy, is not a direct store instance.
  }
  if (!hasDirectPrototype) {
    throw new TypeError(
      "Module result commit requires one direct FileCoreStateStore instance",
    );
  }

  try {
    const revision = Object.getOwnPropertyDescriptor(
      FileCoreStateStore.prototype,
      "revision",
    )?.get;
    if (revision === undefined) {
      throw new TypeError("FileCoreStateStore revision getter is unavailable");
    }
    Reflect.apply(revision, core, []);
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message === "FileCoreStateStore revision getter is unavailable"
    ) {
      throw error;
    }
    if (error instanceof TypeError) {
      throw new TypeError(
        "Module result commit requires one direct FileCoreStateStore instance",
      );
    }
    throw error;
  }
}

/**
 * Creates the product result-commit coordinator from one persistent Core
 * state store. This prevents separately supplied Block, Delivery, submission,
 * and acknowledgement operations from referring to different stores.
 */
export function createModuleResultCommitCoordinator(
  options: CreateModuleResultCommitCoordinatorOptions,
): ModuleResultCommitCoordinator {
  assertDirectFileCoreStateStore(options.core);
  const operations = Reflect.apply(
    FileCoreStateStore.prototype.createModuleResultCommitOperations,
    options.core,
    [options.mailboxes],
  );

  return new ModuleResultCommitCoordinator({
    ...operations,
    repository: options.repository,
    now: options.now,
    ...(options.afterEffect === undefined
      ? {}
      : { afterEffect: options.afterEffect }),
  });
}
