# Product lexical replay v0 protocol

This protocol is frozen with preregistration
`memory-product-lexical-replay-v0.json` before any formal retrieval run. It
governs both the synthetic foundation bundle and the later sealed 500-case
evaluation run. Nothing in it authorizes automatic recall, automatic resume,
vector/hybrid retrieval, association expansion, checkpointing, a model call,
or a network request.

## Dataset and gold labels

The only dataset is the local MIT-licensed LongMemEval-S file with SHA-256
`08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894`. The formal
run must verify the complete v4 checksum inventory
(`retrieval-v4-20260813a/sha256sums.txt`) and bind every case by
`questionId` plus `caseSha256` before treatment. The split is exactly 147
development and 353 evaluation. Every split row's `split` value must be
exactly one of the frozen enum strings `development` or `evaluation`; unknown,
duplicate, or missing split membership fails closed. Metrics, gates, and cost
are computed exclusively over the `evaluation` rows; development rows never
enter the scored result or any final gate. The reference is the frozen
`content` top-10 ranking from `retrieval-v4`; it is never recomputed.

## Gold-blind treatment

The treatment reads only `cases.jsonl` projection rows containing
`question_id`, `question`, and `sessions`. It must never receive or persist
`answer_session_ids`, answers, `question_type`, dates, split membership, or
reference rankings.

For each question, independently:

1. Create a fresh `InMemoryMemoryJournal`, `MemoryStore`, authenticated session
   namespace, product text extractor, feature plan, and lexical generation.
2. Map every projected session to one `dolly.content/1` source Block; each
   message becomes one text item with exact text
   `<lowercase role>: <content>`; message and session order are preserved.
3. Deliver all session Blocks through `runMemoryModuleAction`, commit the
   returned admission, and drain `MemoryBackgroundIndexer` to a fixed point
   with concurrency one. Any permanent failure, cancellation, leaked read
   lease, configured limit failure, or nonterminal job aborts the run.
4. Submit exactly one explicit `dolly.memory.query/1` action with
   `mode:"lexical"`, `limit:10`, `contextExpansion:0`, an empty lexical
   threshold profile, and `includeSourceRefs:false`.
5. Take the first ten ranked Memory records, then map each record's
   `sourceBlockId` to its source session and persist each original rank with
   its `recordId`, `sourceBlockId`, `sessionId`, and raw `lexical.bm25`
   score. Do not collapse before truncation and do not backfill.

## Typed failures

A product failure is a row-level typed outcome, never an unstructured crash:
- `limit-failure` when a configured budget (input bytes, segment count,
  feature count, record count, job count) is exceeded;
- `coverage-failure` when `coveredNormalizedBytes` cannot cover all
  source bytes (uncovered bytes, truncated items, or non-empty typed skips);
- `job-failure` when a feature job is pending, retryable, running, or
  permanently failed, or a lease remains outstanding;
- `permanent-error` for any other unrecoverable treatment error.

Every typed failure is persisted as a closed failure row with
`kind`, `reason`, `questionId`, `caseSha256`, and `state: "failed"`. Persistence
of any typed failure forces classification `rejected`, not `inconclusive`.

## Rank-to-session mapping and metric semantics

Metrics iterate the original record ranks up to the cutoff. The first returned
occurrence of a gold session has binary gain one; a repeated occurrence has
gain zero but continues to occupy its original rank. A deduplicated list is
never created before the cutoff, so records beyond rank ten cannot be pulled
into the scored result.

## Cost accounting

`canonicalRecordBytes` and `canonicalFeatureBytes` are the sums of canonical
JSON bytes for every committed product `MemoryRecord` and lexical
`FeatureRecord` in that question. `normalizedInputBytes` sums UTF-8 bytes after
the product extractor's NFC and whitespace normalization for every mapped
message. `coveredNormalizedBytes` is the byte length of the union of the
actual product segment intervals for each item; overlap is counted once; text
beyond `maxInputBytes` or after the last allowed segment is not in this
denominator. The classifying ratio is
`canonicalFeatureBytes / coveredNormalizedBytes`; zero denominator with nonzero
numerator is infinity and zero-over-zero is zero (closed rule). Input bytes
never dilute the ratio. The p95 over the evaluation rows uses the frozen order
statistic `ceil(0.95*n)-1` of the ascending ratios (0 when n is 0), identical
in the analyzer and the verifier.

## Decision rule

Supported (freeze the current representation) only when all of the following
hold on the 353 sealed evaluation questions:

1. paired lower 95% bound of `NDCG@10(product - reference)` >= `-0.02`;
2. paired lower 95% bound of `Recall@10(product - reference)` >= `-0.02`;
3. product knowledge-update top-one error minus reference error
   (`errorRates.difference`) <= `0.02` on the evaluation rows;
4. every evaluation row passes the coverage and terminal-job gate, and p95
   `canonicalFeatureBytes / coveredNormalizedBytes` <= `2` with the frozen
   `cost-ratio-p95` gate counted in `metricGateFailures`;
5. all 500 treatment rows, rank/record/Block/session mappings, checksums,
   source hashes (recomputed by the verifier from the frozen source
   fingerprint, not just checked for a hex shape), independent metric
   recomputation, and mutation tests validate without structural or
   secret-leak failure.

A miss rejects production wiring for this representation. No outcome enables
`automaticRecall`, automatic task resumption, source-reference emission,
vector/hybrid retrieval, or configured Module startup.
`RUNTIME_MODULE_MIGRATION_REQUIRED` remains unchanged.
