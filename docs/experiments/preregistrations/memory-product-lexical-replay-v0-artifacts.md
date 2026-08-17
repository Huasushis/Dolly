# Product lexical replay v0 artifacts

This document freezes the closed artifact set for
`memory-product-lexical-replay-v0`. It is authoritative before any run; a new
schema, required field, or renamed artifact invalidates the previous frozen
bundle and requires a new experiment version.

## Run directory layout

Every run lives under:
`artifacts/experiments/probes/memory-product-lexical-replay-v0/runs/<run-id>/`

Required files:

| File | Kind | Purpose |
| --- | --- | --- |
| `cases.jsonl` | sealed copy | exactly 500 gold-blind projection rows, each with `question_id`, `question`, `sessions`, `caseSha256`; never any gold |
| `split.jsonl` | sealed | 500 rows `{question_id, question_type, split, goldSessionIds}` written only after treatment rows are durable |
| `treatment.jsonl` | results | 500 rows, one per question, in `question_id` order |
| `product-rankings.jsonl` | results | one or more rank objects per question, preserving original record ranks |
| `analyse.json` | results | analyzer output |
| `run-manifest.json` | results | runner, analyzer, verifier metadata |
| `sha256sums.txt` | hashes | every produced artifact |
| `command.txt` | hashes | the exact reproducer commands |
| `mutation-summary.json` | hashes | mutation harness outcome |

## Closed result schemas

**treatment row** — two closed shapes keyed by `state`:
- ok row, stable key order:
  `questionId, caseSha256, state, coverage, terminalJobs, limit, queries,
  recordCount, featureCount, canonicalRecordBytes, canonicalFeatureBytes`;
- failed row, stable key order:
  `questionId, caseSha256, state, failure`.

Where:
- `state` is `"ok"` or `"failed"`;
- only a failed row carries `failure:{kind,reason}` and omits every ok field;
- `coverage` is `{normalizedInputBytes, coveredNormalizedBytes,
  uncoveredNormalizedBytes, truncatedItems, skippedItemsByReason, complete}`;
- `terminalJobs` is a closed map of counts
  `(pending, running, retryable, succeeded, skipped, permanentFailure,
  cancelled, outstandingLeases, maxObservedConcurrency)`;
- `queries` is an array of query snapshots
  `{mode, limit, contextExpansion, generation, channelSent}`;
- `limit` is the query cutoff (10).

**product ranking row** — closed order:
`questionId, rank, recordId, sourceBlockId, sessionId, rawBm25, caseSha256`.
`rank` starts at 1 and is contiguous with no refill; a duplicate sessionId
still consumes its original rank.

**run manifest** — closed order:
`experimentId, experimentVersion, runId, frozenAt, casesSha256, splitSha256,
legacyReferenceRows, productRows, rankingRows, treatmentHash, sourceHash,
checksumInventoryVerified, workerCount, startedAtUs, totalJobs, status` with
`status: "ok" | "failed"`.

**analysis** — closed order:
`classification, decisionGates, primaryMetrics, diceScore, errorRates,
duplicateOccupancy, discordantCases, mutationRejected, verifier, verdict` —
`verdict.valid`, `verdict.classification`.

## Independent verification surface

The verifier does not import the treatment, analyzer, or product Memory
source. It recomputes the following from frozen bytes:

1. source freeze — the registered product Memory sources and the treatment
   entry are byte-identical to the hashes frozen in the preregistration;
2. rank/record/Block/session mapping — every ranking row is re-derived from
   persisted treatment rows and each rank's record belongs to the declared
   source Block of the declared session;
3. coverage/skip/truncation/job accounting — recomputed from the persisted
   treatment `coveredNormalizedBytes` row and compared to the same product
   segment iterator (the verifier owns an independent implementation of the
   segment-union arithmetic);
4. checksums & closed schemas — every artifact hash matches
   `sha256sums.txt` and passes the closed field-order schema; beyond caches the
   verifier may keep recomputed per-question values in memory;
5. mutation rejection — every declared mutation of gold, ranking, coverage,
   or hash is independently rejected.

## Verification

```sh
npx tsx scripts/experiments/probes/memory-product-lexical-replay-v0/verify-synthetic.mjs \
  artifacts/experiments/probes/memory-product-lexical-replay-v0/runs/synthetic-foundation
```

No output and exit 0 means the bundle is valid.
