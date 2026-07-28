import { describe, expect, it } from "vitest";

import { applyActivationRequest } from "../../../src/extensions/memory/module-action.js";
import { MemoryError } from "../../../src/extensions/memory/errors.js";
import { MemoryStore } from "../../../src/extensions/memory/store.js";
import {
  CrashingJournal,
  delivered,
  grantBackground,
  harness,
  indexInputs,
  indexerFor,
  leaseIdFactory,
  readerFor,
  runAction,
  textBlock,
} from "./fixtures.js";

function inputs(count: number) {
  return Array.from({ length: count }, (_unused, index) =>
    delivered({
      deliveryId: `d${index + 1}`,
      sourceBlockId: `b${index + 1}`,
      block: textBlock(`document number ${index + 1} about budgets`),
      pageSequence: index + 1,
      coreSequence: index + 1,
    }),
  );
}

/** §3 invariant 4, §6.2. */
describe("bounded background indexing", () => {
  it("never exceeds its configured concurrency and still drains every job", async () => {
    const h = harness();
    const batch = inputs(5);
    const { report } = await indexInputs(h, batch, { maxConcurrency: 2 });
    expect(report.maxObservedConcurrency).toBe(2);
    expect(report.succeeded).toHaveLength(5);
    expect(report.permanentFailures).toEqual([]);
    const query = h.store.session(h.namespace, h.authorization, "query");
    expect(query.records()).toHaveLength(5);
    expect(query.runnableFeatureJobs()).toEqual([]);
  });

  it("releases every AccessLease on success and on failure", async () => {
    const h = harness();
    const batch = inputs(3);
    const reader = readerFor(batch);
    reader.failFor("b2");
    const { report } = await indexInputs(h, batch, { reader });
    expect(reader.acquired.length).toBe(reader.released.length);
    expect(reader.outstanding).toBe(0);
    expect(report.outstandingLeases).toBe(0);
  });

  it("lets one failing job reach a dead letter without stopping the others", async () => {
    const h = harness();
    const batch = inputs(3);
    const reader = readerFor(batch);
    reader.failFor("b2");
    const { report } = await indexInputs(h, batch, { reader });
    expect(report.succeeded).toHaveLength(2);
    expect(report.permanentFailures).toHaveLength(1);

    const query = h.store.session(h.namespace, h.authorization, "query");
    const failed = query.featureJobs().find((job) => job.sourceBlockId === "b2")!;
    expect(failed.state).toBe("permanent-failure");
    // The attempt budget is finite: it retried and then dead-lettered.
    expect(failed.attempt).toBe(failed.maxAttempts);
    expect(query.records().map((record) => record.sourceBlockId).sort()).toEqual(["b1", "b3"]);
  });

  it("reports a permanent failure in processedThrough but not in completeThrough", async () => {
    const h = harness();
    const batch = inputs(3);
    const reader = readerFor(batch);
    reader.failFor("b2");
    await indexInputs(h, batch, { reader });
    const coverage = h.store
      .session(h.namespace, h.authorization, "query")
      .coverage("page-main");
    expect(coverage.processedThrough).toBe(3);
    expect(coverage.completeThrough).toBe(1);
    expect(coverage.permanentFailureSequences).toEqual([2]);
  });

  it("enumerates durable jobs on startup rather than trusting an in-memory queue", async () => {
    const h = harness();
    const batch = inputs(2);
    await runAction(h, batch);
    // A brand new store object over the same journal is a fresh process.
    const restarted = MemoryStore.open(h.journal);
    const indexer = indexerFor(h, readerFor(batch), { store: restarted });
    expect(indexer.resume().map((job) => job.sourceBlockId).sort()).toEqual(["b1", "b2"]);
  });
});

/** §12.4 and §16.2: recovery reaches the same committed state. */
describe("crash recovery", () => {
  it("resumes an abandoned running job and reaches the uninterrupted state", async () => {
    const uninterrupted = harness();
    const batch = inputs(2);
    await indexInputs(uninterrupted, batch);
    const expectedRecords = uninterrupted.store
      .session(uninterrupted.namespace, uninterrupted.authorization, "query")
      .records()
      .map((record) => record.recordId)
      .sort();

    const journal = new CrashingJournal();
    const crashed = harness({ journal });
    await runAction(crashed, batch);

    // Storage stops accepting writes part-way through the first job, so the
    // worker cannot even record its own failure. The process dies with the job
    // durably `running`.
    journal.failFromAppend(journal.appendCount + 2);
    const indexer = indexerFor(crashed, readerFor(batch), { maxConcurrency: 1 });
    await expect(indexer.drain()).rejects.toThrow(/injected crash/u);

    journal.clearFault();
    const recovered = MemoryStore.open(journal);
    const session = recovered.session(crashed.namespace, crashed.authorization, "query");
    const abandoned = session.featureJobs().filter((job) => job.state === "running");
    expect(abandoned).toEqual([]);
    expect(session.runnableFeatureJobs().length).toBeGreaterThan(0);

    const resumed = indexerFor(crashed, readerFor(batch), { store: recovered });
    const report = await resumed.drain();
    expect(report.permanentFailures).toEqual([]);
    expect(
      session
        .records()
        .map((record) => record.recordId)
        .sort(),
    ).toEqual(expectedRecords);
  });

  it("does not make a write that never reached the journal visible after restart", async () => {
    const journal = new CrashingJournal();
    const h = harness({ journal });
    const batch = inputs(1);
    await runAction(h, batch);
    const before = journal.read().length;

    journal.failFromAppend(journal.appendCount + 2);
    const indexer = indexerFor(h, readerFor(batch), { maxConcurrency: 1 });
    await expect(indexer.drain()).rejects.toThrow(/injected crash/u);
    journal.clearFault();

    const recovered = MemoryStore.open(journal);
    const session = recovered.session(h.namespace, h.authorization, "query");
    // Exactly one durable event landed after the action: the job claim.
    expect(journal.read().length).toBe(before + 1);
    expect(session.records()).toEqual([]);
    expect(session.features()).toEqual([]);
  });

  it("converges duplicate wakeups on one job and one committed feature set", async () => {
    const h = harness({ withEmbedding: true });
    const batch = inputs(2);
    const reader = readerFor(batch);
    const first = await indexInputs(h, batch, { reader });
    const query = h.store.session(h.namespace, h.authorization, "query");
    const featureIds = query.features().map((feature) => feature.featureId).sort();

    // A duplicate wakeup: a second indexer over the same durable state.
    const second = indexerFor(h, reader, { leaseIds: leaseIdFactory("second") });
    const report = await second.drain();
    expect(report.succeeded).toEqual([]);
    expect(query.features().map((feature) => feature.featureId).sort()).toEqual(featureIds);
    expect(h.embedding!.calls.flat()).toHaveLength(2);
    expect(first.report.succeeded).toHaveLength(2);
  });
});

/** §6.2 and §11.2: background work never emits a Block or drops a reference. */
describe("background work stays off the actor", () => {
  it("cannot obtain a retention-change capability at all", () => {
    const h = harness();
    let code = "no-error";
    try {
      h.store.session(h.namespace, grantBackground(h.namespace), "retention-change");
    } catch (error) {
      code = error instanceof MemoryError ? error.code : "unexpected";
    }
    expect(code).toBe("MEMORY_SCOPE_DENIED");
  });

  it("leaves the admission strong reference live until a serialized result removes it", async () => {
    const h = harness();
    const batch = inputs(1);
    const { action, report } = await indexInputs(h, batch);
    const admissionId = action.preparation.admission.admissionId;
    const query = h.store.session(h.namespace, h.authorization, "query");

    // The terminal job asked; it did not act.
    expect(report.activationRequests).toHaveLength(1);
    expect(report.activationRequests[0]!.admissionIds).toEqual([admissionId]);
    expect(query.admission(admissionId)!.retentionTargets).toHaveLength(1);

    const removals = applyActivationRequest({
      store: h.store,
      namespace: h.namespace,
      authorization: h.authorization,
      request: report.activationRequests[0]!,
    });
    expect(removals).toEqual([
      {
        operation: "remove",
        ownerKind: "module",
        retentionKey: action.preparation.retentionChanges[0]!.retentionKey,
        targetBlockId: "b1",
      },
    ]);
    expect(query.admission(admissionId)!.retentionTargets).toEqual([]);
  });

  it("uses a stable idempotency key so a repeated signal is one request", async () => {
    const h = harness();
    const batch = inputs(1);
    const { indexer, report } = await indexInputs(h, batch);
    const key = report.activationRequests[0]!.idempotencyKey;
    await indexer.drain();
    expect(indexer.activationRequests).toHaveLength(1);
    expect(indexer.activationRequests[0]!.idempotencyKey).toBe(key);
  });

  it("carries no Block-, Page-, or proposal-shaped method on its surface", () => {
    const h = harness();
    const indexer = indexerFor(h, readerFor([]));
    const surface = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(indexer) as object),
      ...Object.keys(indexer),
    ];
    expect(surface.filter((name) => /propose|emit|block|page/iu.test(name))).toEqual([]);
  });
});

/** §3 invariant 11 and §6.3: every queue has a finite limit and fails visibly. */
describe("backpressure", () => {
  it("refuses new jobs past the pending capacity instead of dropping them", async () => {
    const journal = new CrashingJournal();
    const store = MemoryStore.open(journal, {
      maxPreparedAdmissions: 64,
      maxPendingJobs: 2,
      maxRecordsPerNamespace: 100,
      maxFeaturesPerNamespace: 100,
      maxTrackedGapsPerPage: 8,
      maxJobAttempts: 3,
    });
    const h = harness({ journal, store });
    await runAction(h, inputs(2), { commit: false });
    let code = "no-error";
    try {
      await runAction(h, inputs(3).slice(2), { moduleJobId: "job-2", commit: false });
    } catch (error) {
      code = error instanceof MemoryError ? error.code : "unexpected";
    }
    expect(code).toBe("MEMORY_LIMIT_EXCEEDED");
  });

  it("refuses new records past the namespace capacity", async () => {
    const journal = new CrashingJournal();
    const store = MemoryStore.open(journal, {
      maxPreparedAdmissions: 64,
      maxPendingJobs: 64,
      maxRecordsPerNamespace: 1,
      maxFeaturesPerNamespace: 64,
      maxTrackedGapsPerPage: 8,
      maxJobAttempts: 3,
    });
    const h = harness({ journal, store });
    const batch = inputs(2);
    const { report } = await indexInputs(h, batch, { maxConcurrency: 1 });
    expect(report.succeeded).toHaveLength(1);
    expect(report.permanentFailures).toHaveLength(1);
    const failed = store
      .session(h.namespace, h.authorization, "query")
      .featureJobs()
      .find((job) => job.state === "permanent-failure")!;
    expect(failed.lastErrorCode).toBe("MEMORY_LIMIT_EXCEEDED");
  });
});
