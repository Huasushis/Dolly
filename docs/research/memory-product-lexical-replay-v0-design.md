# Memory product lexical replay v0 design

Status: design frozen before the first LongMemEval outcome run.

This experiment asks one narrow engineering question: is Dolly's current
product lexical representation close enough to the already frozen
session-document BM25 reference to justify building its installed-Module and
durable-journal wiring? It does not test association, checkpointing, vector
retrieval, Agent answers, automatic recall, automatic resume, or product
startup.

## Why this is the next comparison

The classifiable LongMemEval repeated-position run rejected the association
design: all three evaluation NDCG contrasts were exactly zero and the tested
graph cost exceeded its frozen limit. That result keeps the session-document
content BM25 ranking as a useful reference, but it does not validate Dolly's
product implementation. The two lexical paths differ materially:

- the reference uses one NFKC-normalized session document, removes a frozen
  stop-word set, ignores one-code-point terms, and deduplicates query terms;
- the product uses one Memory Block per session, one text item per message,
  NFC normalization, all Unicode letter/number tokens, repeated query-term
  weighting, 512-byte segments, and 64-byte overlap;
- the product ranks records, not sessions. Several high-ranking segments from
  one session can consume several result positions.

Therefore production wiring before this replay would mix a representation
choice with integration work and make a later failure expensive to interpret.

## Frozen treatment

The treatment reads only the 500 gold-blind `cases.jsonl` rows from the
classifiable `retrieval-v4-20260813a` projection. It never reads
`answer_session_ids`, answers, question type, split, or reference rankings.

For each question, independently:

1. Create a fresh `InMemoryMemoryJournal`, `MemoryStore`, authenticated
   session namespace, product text extractor, feature plan, and lexical
   generation.
2. Map every projected LongMemEval session to one `dolly.content/1` source
   Block. Each message becomes one text item with exact text
   `<lowercase role>: <content>`; message and session order are preserved.
3. Submit all session Deliveries through `runMemoryModuleAction`, commit the
   returned admission, and drain `MemoryBackgroundIndexer` to a fixed point
   with concurrency one. Any permanent failure, cancellation, leaked read
   lease, configured limit failure, or nonterminal job aborts the run.
4. Submit exactly one explicit `dolly.memory.query/1` action with
   `mode:"lexical"`, `limit:10`, `contextExpansion:0`, an empty lexical
   threshold profile, and `includeSourceRefs:false`. No embedding operation,
   network, model, provider, automatic injection, or automatic recall exists.
5. Take the first ten ranked Memory records, then map each record's
   `sourceBlockId` to its source session. Do not collapse before truncation and
   do not backfill. The first occurrence of a session may be relevant; later
   occurrences consume a rank and count as nonrelevant duplicates.

The executable treatment is
`scripts/experiments/probes/memory-product-lexical-replay-v0/product-lexical.mts`.
It imports the real product modules rather than copying their tokenizer,
segmenter, BM25, store, or Module action into an experiment-only implementation.
The conformance test locks both the complete path and duplicate-session rank
semantics.

## Data and reference

The dataset remains LongMemEval-S with SHA-256
`08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894`.
The exact existing split is 147 development and 353 evaluation questions.
The reference is the frozen `content` top-10 ranking from
`retrieval-v4-20260813a`; it is read-only and is not refit.

The formal runner must verify the complete v4 checksum inventory and bind each
case by `questionId` and `caseSha256` before treatment. The treatment receives
only the case row. A separate analyzer receives the split/gold and the two
ranking files after every treatment row is durable.

## Metrics

The primary paired evaluation metrics are NDCG@10 and Recall@10 with distinct
gold session identifiers. A repeated returned session after its first
occurrence has zero gain and cannot increase recall. The analyzer also reports
Hit@1/5/10, NDCG@1/5, Recall@1/5, the exact paired discordant cases, and
knowledge-update top-one error using the existing six-type LongMemEval
classification.

Cost is deterministic, not wall-clock based:

- `canonicalFeatureBytes` is the sum of canonical JSON bytes for every
  committed product lexical `FeatureRecord` in that question;
- `normalizedSourceBytes` is the sum of UTF-8 bytes after the product extractor's
  NFC and whitespace normalization for every mapped message text;
- the reported ratio is `canonicalFeatureBytes / normalizedSourceBytes`, with
  zero denominator and nonzero numerator treated as infinity.

Record count, feature count, duplicated-session positions, empty sessions, and
skipped text items are descriptive outputs. Timing and RSS may be recorded for
operations planning but cannot classify the result without a separately frozen
reference host and measurement protocol.

Paired confidence intervals use the same pre-generated, shared 10,000-row
evaluation resample matrix as the v4 reference analysis. The formal protocol
must copy that exact matrix-generation and binary64 aggregation rule; it may
not generate a new bootstrap stream per metric or condition.

## Frozen decision rule

The treatment is a candidate for production wiring only if all of the
following hold on the 353 sealed evaluation questions:

1. the paired lower 95 percent bound of
   `NDCG@10(product - reference)` is at least `-0.02`;
2. the paired lower 95 percent bound of
   `Recall@10(product - reference)` is at least `-0.02`;
3. product knowledge-update top-one error minus reference error is at most
   `0.02`;
4. p95 `canonicalFeatureBytes / normalizedSourceBytes` is at most `2`;
5. all 500 treatment rows, all expected record/session mappings, checksums,
   source hashes, independent metric recomputation, and preregistered mutation
   tests validate without a structural or secret-leak failure.

This is a noninferiority screen for the current lexical representation, not a
claim that Memory improves an Agent. A pass freezes the current extractor,
analyzer, segment, rank, and duplicate semantics for the next reversible
engineering slice: installed real-process adapter, durable file journal, Block
reader, restart/delete/isolation tests, and explicit-query-only admission.
Persistent inverted-index work remains conditional on a separate 10,000-record
latency/RSS budget.

A miss on any gate rejects production wiring for this representation. The
evaluation split must not be inspected to tune the tokenizer, segment size,
overlap, collapse rule, thresholds, or query encoding. A later attempt may
change one preregistered representation factor using development data and must
receive a new version and sealed evaluation.

## Evidence and release limits

Before a classifiable run, a follow-up commit must add the closed artifact
schemas, runner, gold-aware analyzer, independent verifier, exact source
inventory, checksum inventory, and mutation harness. This design and its two
conformance fixtures are not retrieval evidence by themselves.

No outcome from this replay can enable `automaticRecall`, automatic task
resumption, source-reference emission, vector/hybrid retrieval, or configured
Module startup. `RUNTIME_MODULE_MIGRATION_REQUIRED` remains unchanged.
