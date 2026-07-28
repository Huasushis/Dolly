import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockStore, type BlockProposal } from "../../../src/core/block-store.js";
import { DeliveryStore } from "../../../src/core/delivery-store.js";
import { FileModuleResultCommitRepository } from "../../../src/core/file-module-result-commit-repository.js";
import {
  ModuleResultCommitCoordinator,
  ModuleResultCommitError,
  moduleJobResultDigest,
  type ModuleResultCommitRecord,
} from "../../../src/core/module-result-commit.js";
import { withSynchronousCrossProcessLock } from "../../../src/core/synchronous-cross-process-lock.js";

const NOW = "2026-07-24T00:00:00.000Z";
const source = { kind: "module", id: "worker" } as const;

function proposal(text: string): BlockProposal {
  return {
    payload: {
      schema: "dolly.content/1",
      value: { items: [{ type: "text", text, format: "plain" }] },
    },
  };
}

function preparedRecord(): ModuleResultCommitRecord {
  const blockProposal = proposal("durable");
  const outputPageIds = ["output"];
  return {
    schemaVersion: "dolly.module-result-commit/1",
    moduleJobId: "module-job-1",
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

describe("CORE durable Module result commit repository", () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-module-result-commit-repository-"));
    path = join(root, "module-result-commits.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("persists prepared and CAS revisions across repository reconstruction", () => {
    const first = new FileModuleResultCommitRepository({ path });
    const prepared = preparedRecord();
    expect(first.createPrepared(prepared)).toBe("created");

    const reopened = new FileModuleResultCommitRepository({ path });
    expect(reopened.get(prepared.moduleJobId)).toEqual(prepared);
    const withBlock: ModuleResultCommitRecord = {
      ...prepared,
      revision: 2,
      blockId: "block-2",
    };
    expect(reopened.compareAndSet(prepared.moduleJobId, 1, withBlock)).toBe(true);
    expect(first.compareAndSet(prepared.moduleJobId, 1, withBlock)).toBe(false);
    expect(new FileModuleResultCommitRepository({ path }).get(prepared.moduleJobId)).toEqual(
      withBlock,
    );
  });

  it("serializes writers with an explicit lock and re-reads before CAS", () => {
    const repository = new FileModuleResultCommitRepository({ path });
    withSynchronousCrossProcessLock({ resourceId: `${path}.lock` }, () => {
      expect(() => repository.createPrepared(preparedRecord())).toThrowError(
        expect.objectContaining<Partial<ModuleResultCommitError>>({ code: "MODULE_RESULT_COMMIT_LOCKED" }),
      );
    });
    expect(repository.createPrepared(preparedRecord())).toBe("created");
  });

  it("rejects strict-JSON corruption without replacing the last in-memory truth", () => {
    const repository = new FileModuleResultCommitRepository({ path });
    repository.createPrepared(preparedRecord());
    writeFileSync(
      path,
      '{"schemaVersion":"dolly.module-result-commit-repository/1","revision":1,"revision":2,"records":[]}',
      "utf8",
    );
    expect(() => new FileModuleResultCommitRepository({ path })).toThrowError(
      expect.objectContaining<Partial<ModuleResultCommitError>>({
        code: "MODULE_RESULT_COMMIT_DOCUMENT_INVALID",
      }),
    );
  });

  it("rejects the previous commit schema and processingId field", () => {
    const repository = new FileModuleResultCommitRepository({ path });
    const current = preparedRecord();
    expect(() => repository.createPrepared({
      ...current,
      schemaVersion: "dolly.processing-commit/1",
    } as unknown as ModuleResultCommitRecord)).toThrowError(
      expect.objectContaining<Partial<ModuleResultCommitError>>({
        code: "MODULE_RESULT_COMMIT_REPOSITORY_CONFLICT",
      }),
    );
    const { moduleJobId, ...withoutModuleJobId } = current;
    expect(() => repository.createPrepared({
      ...withoutModuleJobId,
      processingId: moduleJobId,
    } as unknown as ModuleResultCommitRecord)).toThrowError(
      expect.objectContaining<Partial<ModuleResultCommitError>>({
        code: "MODULE_JOB_ID_INVALID",
      }),
    );
  });

  it("rejects the previous repository schema", () => {
    writeFileSync(
      path,
      '{"schemaVersion":"dolly.processing-commit-repository/1","revision":0,"records":[]}\n',
      "utf8",
    );
    expect(() => new FileModuleResultCommitRepository({ path })).toThrowError(
      expect.objectContaining<Partial<ModuleResultCommitError>>({
        code: "MODULE_RESULT_COMMIT_DOCUMENT_INVALID",
      }),
    );
  });


  it("recovers an interrupted journal through a newly opened repository object", async () => {
    let blockId = 0;
    let runtimeId = 0;
    const blocks = new BlockStore({
      nextBlockId: () => `block-${++blockId}`,
      now: () => NOW,
    });
    const deliveries = new DeliveryStore({
      blocks,
      maxFailedAttempts: 3,
      nextId: (kind) => `${kind}-${++runtimeId}`,
      now: () => NOW,
    });
    deliveries.createPage("input");
    deliveries.createPage("output");
    deliveries.registerConsumer("input", "worker", "from-now");
    const inputBlock = blocks.commit(proposal("input"), { kind: "external", id: "console" });
    deliveries.append("input", inputBlock.id);
    const claim = deliveries.claim({
      consumerId: "worker",
      pageIds: ["input"],
      moduleGenerationId: "generation-1",
      maxCount: 1,
      maxBytes: 1024 * 1024,
    })!;
    let injected = false;
    const firstRepository = new FileModuleResultCommitRepository({ path });
    const interrupted = new ModuleResultCommitCoordinator({
      blocks,
      deliveries,
      repository: firstRepository,
      now: () => NOW,
      afterEffect: (event) => {
        if (!injected && event.phase === "after-block-effect") {
          injected = true;
          throw new Error("simulated process interruption");
        }
      },
    });
    const input = {
      moduleJobId: claim.moduleJobId,
      claimToken: claim.claimToken,
      runId: claim.runId,
      attempt: claim.attempt,
      moduleGenerationId: claim.moduleGenerationId,
      source,
      outputPageIds: ["output"],
      blockProposal: proposal("output"),
    } as const;
    await expect(interrupted.commit(input)).rejects.toThrow("simulated process interruption");

    const reopenedRepository = new FileModuleResultCommitRepository({ path });
    expect(reopenedRepository.get(claim.moduleJobId)).toMatchObject({
      state: "prepared",
      revision: 1,
    });
    const recovered = new ModuleResultCommitCoordinator({
      blocks,
      deliveries,
      repository: reopenedRepository,
      now: () => NOW,
    });
    await expect(recovered.recover(claim.moduleJobId)).resolves.toMatchObject({
      state: "committed",
      blockId: "block-2",
    });
    expect(new FileModuleResultCommitRepository({ path }).get(claim.moduleJobId)).toMatchObject({
      state: "committed",
    });
    expect(blocks.size).toBe(2);
  });
});
