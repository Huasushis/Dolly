/**
 * A version 19 identity-capable record store and its id-less starting-record
 * fixture, shared by the lifecycle and installed-composition conformance
 * tests.
 *
 * The store allocates a version 19 identifier that is deliberately distinct
 * from every caller placeholder used in the tests (`process-generation-1` and
 * `process-installed-1`), so a test that accidentally follows the placeholder
 * instead of the minted identifier fails loudly on an exact-value assertion
 * rather than on an incidental one.
 */
import { formatVersion19ProcessGenerationId } from "../../../../src/core/linux-identifier-formats.js";
import {
  deriveModuleCgroupPath,
  type ModuleCgroupIdentity,
} from "../../../../src/core/linux-module-cgroup.js";
import type { ModuleProcessRecordStore } from "../../../../src/core/linux-module-process-lifecycle.js";
import {
  canTransitionModuleProcessRecordState,
  type ModuleProcessRecord,
  type ModuleProcessStartingRecordInput,
  type ModuleProcessStoppedRecordWriter,
} from "../../../../src/core/module-process-records.js";

/** The delegated control-group root the fixture records and lifecycle use. */
export const VERSION19_DELEGATED_ROOT = "/system.slice/dolly-core.service";

/** The identifier the fixture store mints, distinct from any caller placeholder. */
export const VERSION19_MINTED_PROCESS_GENERATION_ID =
  formatVersion19ProcessGenerationId(7);

/** The exact filesystem path Core derives for one minted process generation. */
export function version19CgroupPath(
  identity: Pick<ModuleCgroupIdentity, "instanceId" | "moduleId">,
  processGenerationId: string,
): string {
  return deriveModuleCgroupPath(VERSION19_DELEGATED_ROOT, {
    ...identity,
    processGenerationId,
  }).filesystemPath;
}

/** A valid id-less starting record for the version 19 allocation branch. */
export function version19StartingRecordInput(
  overrides: Partial<ModuleProcessStartingRecordInput> = {},
): ModuleProcessStartingRecordInput {
  return {
    schemaVersion: "dolly.module-process-record/1",
    instanceId: "instance-1",
    moduleId: "worker",
    moduleGenerationId: "module-generation-1",
    packageDigest: `sha256:${"a".repeat(64)}`,
    configurationReference: {
      configId: "config-1",
      revision: `sha256:${"b".repeat(64)}`,
      configVersion: 1,
    },
    declaredExternalEffects: "core-capabilities-only",
    serviceInvocationId: "2812432ad29e4d3bbd6776c62cafa929",
    bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
    delegatedRootCgroupPath: VERSION19_DELEGATED_ROOT,
    state: "starting",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

export interface Version19TestRecordStore extends ModuleProcessRecordStore {
  readonly current: ModuleProcessRecord | undefined;
  readonly log: readonly string[];
  readonly stoppedRecordWriter: ModuleProcessStoppedRecordWriter;
  readonly mintedProcessGenerationId: string;
}

/**
 * Builds the store the product would own after an explicit version 19
 * migration: it refuses every caller-supplied identifier or record and mints
 * its own. The minted identifier is a closed unknown to every lifecycle test,
 * so any seam or executor path that falls back to a caller placeholder cannot
 * match the stored record and fails on the same assertions a real store would.
 */
export function createVersion19RecordStore(
  options: { readonly rejectAllocation?: boolean } = {},
): Version19TestRecordStore {
  const log: string[] = [];
  let current: ModuleProcessRecord | undefined;
  const mintedProcessGenerationId = VERSION19_MINTED_PROCESS_GENERATION_ID;

  const writeState = (
    processGenerationId: string,
    state: ModuleProcessRecord["state"],
    failureCode?: string,
  ): ModuleProcessRecord => {
    if (current === undefined || current.processGenerationId !== processGenerationId) {
      throw new Error(`no durable record for ${processGenerationId}`);
    }
    if (!canTransitionModuleProcessRecordState(current.state, state)) {
      throw new Error(`invalid process-record transition ${current.state} -> ${state}`);
    }
    log.push(
      failureCode === undefined ? `state:${state}` : `state:${state}:${failureCode}`,
    );
    current = {
      ...current,
      state,
      ...(failureCode === undefined ? {} : { failureCode }),
    };
    return current;
  };

  return {
    get current() {
      return current;
    },
    log,
    stoppedRecordWriter: {
      isStoreBoundTo() {
        return true;
      },
      isBoundTo(record) {
        return current === record;
      },
      writeStopped(processGenerationId: string, failureCode?: string) {
        return writeState(processGenerationId, "stopped", failureCode);
      },
    },
    getModuleProcessRecord(processGenerationId) {
      return current?.processGenerationId === processGenerationId
        ? current
        : undefined;
    },
    appendModuleProcessRecord(): ModuleProcessRecord {
      log.push("append");
      throw new Error("a version 19 store never appends a caller-supplied process record");
    },
    supportsVersion19Identity() {
      return true;
    },
    allocateAndAppendStartingRecord(input) {
      log.push("allocate");
      if (options.rejectAllocation) {
        throw new Error("allocation refused");
      }
      if ((input as { processGenerationId?: unknown }).processGenerationId !== undefined) {
        throw new Error(
          "a caller-supplied process generation identifier is refused by the store",
        );
      }
      const delegatedRootCgroupPath = input.delegatedRootCgroupPath;
      const derivedPath = version19CgroupPath(
        { instanceId: input.instanceId, moduleId: input.moduleId },
        mintedProcessGenerationId,
      );
      const callerPath = (input as { moduleCgroupPath?: unknown }).moduleCgroupPath;
      if (callerPath !== undefined && callerPath !== derivedPath) {
        throw new Error(
          "the caller-supplied module control-group path is not the store's derivation",
        );
      }
      const {
        delegatedRootCgroupPath: _ignoredRoot,
        moduleCgroupPath: _ignoredCallerPath,
        declarationProvenance: _ignoredProvenance,
        ...body
      } = input;
      current = {
        ...body,
        processGenerationId: mintedProcessGenerationId,
        moduleCgroupPath: derivedPath,
      };
      return current;
    },
    updateModuleProcessRecordState(processGenerationId, state, failureCode) {
      return writeState(processGenerationId, state, failureCode);
    },
    mintedProcessGenerationId,
  };
}