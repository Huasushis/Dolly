import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fileSystemCalls = vi.hoisted(() => ({
  directoryDescriptors: new Map<number, string>(),
  syncedDirectories: [] as string[],
  operations: [] as Array<{
    operation: "rename" | "unlink" | "fsync";
    path: string;
  }>,
  failNextRename: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    openSync(path: string, flags: string, mode?: number) {
      const descriptor = original.openSync(path, flags, mode);
      if (original.fstatSync(descriptor).isDirectory()) {
        fileSystemCalls.directoryDescriptors.set(
          descriptor,
          String(original.realpathSync(path)),
        );
      }
      return descriptor;
    },
    fsyncSync(descriptor: number) {
      original.fsyncSync(descriptor);
      const directory = fileSystemCalls.directoryDescriptors.get(descriptor);
      if (directory !== undefined) {
        fileSystemCalls.syncedDirectories.push(directory);
        fileSystemCalls.operations.push({ operation: "fsync", path: directory });
      }
    },
    closeSync(descriptor: number) {
      try {
        original.closeSync(descriptor);
      } finally {
        fileSystemCalls.directoryDescriptors.delete(descriptor);
      }
    },
    renameSync(previousPath: string, nextPath: string) {
      fileSystemCalls.operations.push({ operation: "rename", path: String(nextPath) });
      if (fileSystemCalls.failNextRename) {
        fileSystemCalls.failNextRename = false;
        throw new Error("simulated rename failure");
      }
      original.renameSync(previousPath, nextPath);
    },
    unlinkSync(path: string) {
      original.unlinkSync(path);
      fileSystemCalls.operations.push({ operation: "unlink", path: String(path) });
    },
  };
});

import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import { FileMediaByteStore } from "../../../src/core/file-media-byte-store.js";
import { FileModuleResultCommitRepository } from "../../../src/core/file-module-result-commit-repository.js";
import { InstanceConfigStore } from "../../../src/core/instance-config-store.js";
import {
  moduleJobResultDigest,
  type ModuleResultCommitRecord,
} from "../../../src/core/module-result-commit.js";
import {
  createDefaultDollyInstanceConfig,
  dollyInstanceConfigSchema,
} from "../../../src/core/runtime-config.js";

const NOW = "2026-07-25T00:00:00.000Z";
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
// POSIX means Portable Operating System Interface; Linux uses these test cases.
const posixIt = process.platform === "win32" ? it.skip : it;
const windowsIt = process.platform === "win32" ? it : it.skip;

function instanceConfigStore(root: string): InstanceConfigStore<
  ReturnType<typeof createDefaultDollyInstanceConfig>
> {
  return new InstanceConfigStore({
    schema: dollyInstanceConfigSchema,
    registryDirectory: join(root, "registry"),
    defaultStateRoot: join(root, "default-state"),
    maxConfigBytes: 1024 * 1024,
    nextInstanceId: () => INSTANCE_ID,
    now: () => NOW,
  });
}

function preparedRecord(moduleJobId = "module-job-1"): ModuleResultCommitRecord {
  const source = { kind: "module", id: "worker" } as const;
  const blockProposal = {
    payload: {
      schema: "dolly.content/1" as const,
      value: { items: [{ type: "text" as const, text: "durable", format: "plain" as const }] },
    },
  };
  const outputPageIds = ["output"];
  return {
    schemaVersion: "dolly.module-result-commit/1",
    moduleJobId,
    claimToken: "claim-1",
    runId: "run-1",
    attempt: 1,
    moduleGenerationId: "generation-1",
    resultDigest: moduleJobResultDigest({ source, blockProposal, outputPageIds }),
    state: "prepared",
    revision: 1,
    source,
    outputPageIds,
    outputDeliveries: [],
    createdAt: NOW,
    updatedAt: NOW,
    blockProposal,
  };
}

describe("Portable Operating System Interface directory synchronization", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-directory-fsync-"));
    fileSystemCalls.syncedDirectories.length = 0;
    fileSystemCalls.operations.length = 0;
    fileSystemCalls.failNextRename = false;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    fileSystemCalls.directoryDescriptors.clear();
    fileSystemCalls.syncedDirectories.length = 0;
    fileSystemCalls.operations.length = 0;
    fileSystemCalls.failNextRename = false;
  });

  posixIt("syncs the Media byte directory after link creation and deletion", async () => {
    const directory = realpathSync(root);
    const store = new FileMediaByteStore({ directory, maxMediaBytes: 1024 });

    await store.put("media-1", Uint8Array.of(1, 2, 3));
    expect(fileSystemCalls.syncedDirectories).toEqual([directory, directory]);

    fileSystemCalls.syncedDirectories.length = 0;
    await store.delete("media-1");
    expect(fileSystemCalls.syncedDirectories).toEqual([directory]);
  });

  posixIt("syncs the Core state parent after initial creation and replacement", () => {
    const directory = realpathSync(root);
    const path = join(directory, "core-state.json");
    let blockId = 0;
    let deliveryId = 0;
    const store = new FileCoreStateStore({
      path,
      maxFailedAttempts: 3,
      nextBlockId: () => `block-${++blockId}`,
      nextDeliveryId: (kind) => `${kind}-${++deliveryId}`,
      now: () => NOW,
    });
    expect(fileSystemCalls.syncedDirectories).toEqual([directory]);

    fileSystemCalls.syncedDirectories.length = 0;
    store.deliveries.createPage("page");
    expect(fileSystemCalls.syncedDirectories).toEqual([directory]);
  });

  posixIt("syncs each configuration parent immediately after rename", () => {
    const directory = realpathSync(root);
    const path = join(directory, "dolly.json");
    const stateDirectory = join(directory, "default-state", INSTANCE_ID);
    const registryDirectory = join(directory, "registry", "instances");
    const store = instanceConfigStore(directory);

    store.initialize(path, (instanceId) =>
      createDefaultDollyInstanceConfig(instanceId, "directory sync test"),
    );

    expect(fileSystemCalls.operations).toEqual([
      { operation: "rename", path },
      { operation: "fsync", path: directory },
      { operation: "rename", path: join(stateDirectory, ".dolly-instance.json") },
      { operation: "fsync", path: stateDirectory },
      { operation: "rename", path: join(registryDirectory, `${INSTANCE_ID}.json`) },
      { operation: "fsync", path: registryDirectory },
    ]);
  });

  posixIt("syncs the configuration parent after removing a temporary file", () => {
    const directory = realpathSync(root);
    const path = join(directory, "dolly.json");
    const store = instanceConfigStore(directory);
    fileSystemCalls.failNextRename = true;

    expect(() =>
      store.initialize(path, (instanceId) =>
        createDefaultDollyInstanceConfig(instanceId, "directory sync test"),
      ),
    ).toThrow("Atomic configuration write failed");

    expect(fileSystemCalls.operations.map(({ operation }) => operation)).toEqual([
      "rename",
      "unlink",
      "fsync",
    ]);
    expect(fileSystemCalls.operations[0]).toEqual({ operation: "rename", path });
    const temporaryPath = fileSystemCalls.operations[1]!.path;
    expect(dirname(temporaryPath)).toBe(directory);
    expect(basename(temporaryPath)).toMatch(/^\.dolly\.json\..+\.tmp$/u);
    expect(fileSystemCalls.operations[2]).toEqual({
      operation: "fsync",
      path: directory,
    });
  });

  posixIt("syncs the configuration parent after rolling back initialization", () => {
    const directory = realpathSync(root);
    const path = join(directory, "dolly.json");
    const stateDirectory = join(directory, "default-state", INSTANCE_ID);
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(
      join(stateDirectory, ".dolly-instance.json"),
      `${JSON.stringify({
        schemaVersion: "dolly.state-manifest/1",
        instanceId: "22222222-2222-4222-8222-222222222222",
      })}\n`,
      "utf8",
    );
    const store = instanceConfigStore(directory);

    expect(() =>
      store.initialize(path, (instanceId) =>
        createDefaultDollyInstanceConfig(instanceId, "directory sync test"),
      ),
    ).toThrow("State directory belongs to another instanceId");

    expect(fileSystemCalls.operations).toEqual([
      { operation: "rename", path },
      { operation: "fsync", path: directory },
      { operation: "unlink", path },
      { operation: "fsync", path: directory },
    ]);
  });

  posixIt("syncs the Module result commit repository parent after replacement", () => {
    const directory = realpathSync(root);
    const path = join(directory, "module-result-commits.json");
    const repository = new FileModuleResultCommitRepository({ path });
    expect(fileSystemCalls.syncedDirectories).toEqual([directory]);

    fileSystemCalls.syncedDirectories.length = 0;
    expect(repository.createPrepared(preparedRecord())).toBe("created");
    expect(fileSystemCalls.syncedDirectories).toEqual([directory]);
  });

  posixIt("syncs the Module result commit repository parent after temporary cleanup", () => {
    const directory = realpathSync(root);
    const path = join(directory, "module-result-commits.json");
    const repository = new FileModuleResultCommitRepository({ path });
    fileSystemCalls.syncedDirectories.length = 0;
    fileSystemCalls.failNextRename = true;

    expect(() => repository.createPrepared(preparedRecord())).toThrow(
      "Atomic Module result commit repository write failed",
    );
    expect(fileSystemCalls.syncedDirectories).toEqual([directory]);
  });

  windowsIt("does not synchronize Module result commit repository directories", () => {
    const directory = realpathSync(root);
    const path = join(directory, "module-result-commits.json");
    const repository = new FileModuleResultCommitRepository({ path });
    expect(fileSystemCalls.syncedDirectories).toEqual([]);

    expect(repository.createPrepared(preparedRecord())).toBe("created");
    expect(fileSystemCalls.syncedDirectories).toEqual([]);

    fileSystemCalls.failNextRename = true;
    expect(() => repository.createPrepared(preparedRecord("module-job-2"))).toThrow(
      "Atomic Module result commit repository write failed",
    );
    expect(fileSystemCalls.syncedDirectories).toEqual([]);
  });

  windowsIt("does not synchronize configuration directories", () => {
    const directory = realpathSync(root);
    const path = join(directory, "dolly.json");
    const store = instanceConfigStore(directory);

    store.initialize(path, (instanceId) =>
      createDefaultDollyInstanceConfig(instanceId, "directory sync test"),
    );
    expect(fileSystemCalls.syncedDirectories).toEqual([]);

    fileSystemCalls.failNextRename = true;
    expect(() =>
      store.initialize(join(directory, "failed.json"), (instanceId) =>
        createDefaultDollyInstanceConfig(instanceId, "directory sync test"),
      ),
    ).toThrow("Atomic configuration write failed");
    expect(fileSystemCalls.syncedDirectories).toEqual([]);
  });
});
