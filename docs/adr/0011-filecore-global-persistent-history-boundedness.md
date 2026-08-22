# ADR-0011: Bounded FileCore global persistent history

Status: Proposed

Date: 2026-08-22

## Scope

This record decides only the protocol for one FileCore-owned, instance-global
persistent history. It does not authorize bootstrap, public activation, H3,
telemetry, guard changes, or removal of `RUNTIME_MODULE_MIGRATION_REQUIRED`.
It also does not replace the Runtime SQLite authority decision; the history
protocol is a consumer of that authority.

In this record, a **history entry** is one immutable canonical JSON envelope
emitted by a producer. A **reader** obtains entries in sequence order. A
**producer checkpoint** is a durable producer-authored statement naming the
oldest sequence range that may be deleted. A reader acknowledgement is not a
checkpoint and cannot authorize deletion.

## Concrete frozen facts

The imported frozen specifications establish these facts:

1. Durable Page history is already bounded by a different contract. A durable
   Page has finite entry and referenced-Block quotas; pressure is
   `PAGE_BACKPRESSURE`, oldest/newest dropping is forbidden, and Delivery
   reclamation requires every durable subscriber cursor to pass the Delivery,
   no nonterminal Activation reference, elapsed audit retention, and no legal
   hold or pin. `retention.max_age_ms` is only a best-effort cap after those
   conditions. See `dolly-spec/docs/spec/core/03-page-delivery-subscription.md`,
   section 6.
2. Core durability has one authoritative Runtime SQLite database. A cache,
   acknowledgement, log, lossy append, or provider response is not a commit;
   writes use the required SQLite settings, the instance lock, and an atomic
   transaction. Explicit expected-version migration is required. See
   `dolly-spec/docs/spec/core/06-storage-and-recovery.md`, sections 1--3 and
   3.1.
3. The frozen Runtime authority contract does not define a bounded FileCore
   history. It explicitly makes no global aggregate-boundedness claim for
   `FileCoreStateStore` or file-backed result journals. See
   `dolly-spec/docs/adrs/0014-installed-module-activation-authority.md` and
   `dolly-spec/docs/adrs/0015-runtime-authority-database.md`.
4. The frozen Tool call ledger has no v1 cleanup, compaction that drops
   logical fields, or operation-ID reuse. Any future retention transaction is
   expressly a new normative contract. See
   `dolly-spec/docs/spec/core/06-storage-and-recovery.md`, section 5.10.
5. The current TypeScript `FileCoreStateStore` is a single current JSON
   snapshot (`dolly.core-state/18` or `/19`) with a monotonic `revision`, a
   `stateDigest`, an optional whole-file `maxBytes` limit, a synchronous
   cross-process lock, and atomic replacement. Its revision is a concurrency
   fence, not a retained history sequence. It has no producer watermark,
   checkpoint, reader cursor, or deletion eligibility record.
6. The current TypeScript `FileModuleResultCommitRepository` is a single JSON
   document (`dolly.module-result-commit-repository/1`) containing the current
   record for each Module job. It has a document revision, CAS transitions, a
   whole-document `maxBytes` limit, and exact-revision deletion. That deletion
   is a cleanup step for a known result-commit effect; it is not a retention
   protocol and has no reader or producer checkpoint semantics.
7. Existing tests prove snapshot/revision persistence, stale-writer refusal,
   atomic-write failure closure, result-journal terminal-capacity reservation,
   and exact-revision deletion. They do not prove a bounded aggregate history,
   a durable versioned watermark, reader replay/gap semantics, or migration of
   history authority.

Therefore the protocol is **not fully frozen**. A runtime implementation on the
current line would have to invent authority, ordering, deletion, reader, and
migration semantics.

## Precise unresolved decisions

The following decisions are absent from the frozen protocol and require an
explicit approval rather than an implementation guess:

- **Bound measure.** Whether the product bound is the logical canonical-entry
  measure proposed below, a physical SQLite-file limit, or both. SQLite page
  allocation/WAL bytes are storage concerns and cannot be inferred from a
  canonical JSON byte count.
- **Scope and reader slots.** Whether “global” means one stream per Runtime
  `(daemon_installation_id, instance_id)` (the recommendation) or one stream
  per Module/storage scope. A global stream gives one deletion frontier and
  one replay order; per-Module streams isolate pressure but multiply migration
  and checkpoint state.
- **Reader evidence.** Whether authenticated reader observations may be
  included as evidence in a producer checkpoint. The recommendation permits
  an evidence digest for audit but never delegates deletion authority to a
  reader, an acknowledgement, or an absent reader.
- **Legacy migration semantics.** Whether a legacy JSON snapshot should expose
  a synthetic history entry. The recommendation does not synthesize one: the
  old formats contain no ordered history and cannot prove one.

## Viable protocols and trade-offs

### A. Time/count automatic eviction

Store a finite count and age, then delete the oldest entries whenever the
limit is crossed.

- **Advantages:** small implementation and predictable operator settings.
- **Disadvantages:** wall-clock age does not prove a reader no longer needs an
  entry; automatic eviction makes the producer's policy implicit; it provides
  no durable, versioned deletion premise; and a successful compaction could be
  mistaken for authority. It conflicts with the required one-way authority
  direction and is rejected.

### B. Reader-acknowledgement frontier

Persist one cursor per reader and delete through the minimum acknowledged
cursor.

- **Advantages:** familiar log semantics and natural slow-reader protection.
- **Disadvantages:** a reader acknowledgement, a missing reader, or a stale
  cache would directly mint upstream deletion authority. Reader availability
  becomes a correctness dependency, and reader registration/removal itself
  needs an unprovided authority protocol. This is rejected for FileCore global
  history even though the durable Page contract has its own cursor rules.

### C. Producer checkpoint followed by bounded canonical log (recommended)

The producer alone publishes a durable, versioned checkpoint. A separate
compaction transaction may delete only the exact range named by a committed
checkpoint. Readers and acknowledgements are observable state, never deletion
authority.

- **Advantages:** the authority direction is explicit and testable; the
  producer can make a policy decision without treating absence or consumer
  progress as proof; checkpoint publication and deletion have independent,
  crash-recoverable boundaries; and count/byte limits can be checked before
  every append.
- **Costs:** a producer that does not publish checkpoints eventually receives
  backpressure; a slow reader can receive an honest history gap after a
  producer-authorized deletion; and the physical SQLite-file bound remains a
  separate storage decision.

## Recommended protocol

Adopt protocol C after approval. The following is the complete proposed v1
contract; while this ADR is `Proposed`, it is design guidance and not a
conformance claim.

### Authority and durable records

The history lives in the same authoritative Runtime SQLite database and under
the same controller lock as Core state. There is no JSON history sidecar,
process-memory history, or Extension-owned deletion path. One instance-global
`history_id` is bound to the exact Runtime identity tuple.

The logical tables are:

- `filecore_history_head`, one row per `history_id`, containing the closed
  record `dolly.filecore-history-head/v1` and these fields:
  `history_id`, `producer_id`, `producer_epoch`, `head_revision`,
  `next_sequence`, `retained_from`, `produced_through`,
  `retained_entry_count`, `retained_entry_bytes`, `max_entries`, `max_bytes`,
  `max_readers`, `legacy_source_digest`, and `head_digest`.
- `filecore_history_entries`, keyed by `(history_id, sequence)`, containing
  the closed record `dolly.filecore-history-entry/v1`:
  `history_id`, `sequence`, `producer_epoch`, `producer_entry_id`,
  `entry_jcs`, `entry_digest`, `entry_bytes`, and the committing
  `head_revision`. `entry_jcs` is the exact canonical JSON byte sequence;
  `entry_digest` is its SHA-256 digest. `producer_entry_id` is unique within
  the producer epoch so a lost acknowledgement can replay safely.
- `filecore_history_checkpoint`, one current row per `history_id`, containing
  the closed record `dolly.filecore-history-checkpoint/v1`:
  `history_id`, `checkpoint_version`, `producer_id`, `producer_epoch`,
  `producer_revision`, `delete_through`, `issued_at`, `evidence_digest`, and
  `checkpoint_digest`. Replacing this row is allowed only with the next
  checkpoint version and an exact producer epoch; the previous checkpoint is
  not needed for reader replay and is not an unbounded second history.
- `filecore_history_readers`, at most `max_readers` rows per `history_id`,
  containing a configured `reader_id`, `cursor`, `reader_revision`, and
  `cursor_digest`. Reader rows are bounded metadata for replay diagnostics;
  they never authorize deletion and are not part of the producer checkpoint.

Every closed record rejects unknown fields. Indexed columns are projections of
its canonical bytes and must compare equal on every load. `head_digest` and
`checkpoint_digest` cover all fields of their respective records except the
self-referential digest field. `head_revision`, `checkpoint_version`, and
`sequence` are positive safe integers with no reuse or wraparound.

The retained-history bound is the exact logical measure

```text
retained_entry_count = number of rows in filecore_history_entries
retained_entry_bytes = sum(entry.entry_bytes)
                    = sum(UTF-8 byte length of entry.entry_jcs)
```

Both `max_entries` and `max_bytes` are finite, persisted producer policy. A
candidate entry that would exceed either limit is refused before mutation with
`HISTORY_LIMIT_EXCEEDED`; an entry larger than `max_bytes` is refused with
`HISTORY_ENTRY_TOO_LARGE`. Counts and bytes are updated in the same transaction
as row insertion/deletion and are recomputed and checked on reopen. This
proposal claims a logical retained-history bound, not a bound on SQLite page,
WAL, or the complete Runtime database file; the physical-storage question is
one of the approvals above.

### Producer, checkpoint, and deletion ordering

1. A producer is admitted with the exact `history_id`, `producer_id`, and
   `producer_epoch`. A replacement producer must first persist a new epoch
   through the existing Host/Runtime authority; an old epoch is fenced.
2. `append` runs in `BEGIN IMMEDIATE`, rereads the current head, and checks the
   expected `head_revision` and producer epoch. The next entry is exactly
   `produced_through + 1`; a duplicate `producer_entry_id` with equal digest
   returns the existing entry, while a different digest is
   `HISTORY_IDEMPOTENCY_CONFLICT`. Append never deletes older entries and
   never infers a checkpoint.
3. `publishCheckpoint` is available only to the producer authority. It writes
   the next `checkpoint_version`, requires `delete_through <= produced_through`,
   binds `producer_revision` and `producer_epoch`, and commits the checkpoint
   before any deletion transaction. A reader, reader acknowledgement, empty
   reader set, cache, or compactor cannot call this operation. An evidence
   digest may identify authenticated observations used by the producer's
   policy, but it does not transfer authority.
4. `deleteEligible` rereads the current checkpoint and requires the exact
   `(checkpoint_version, checkpoint_digest, producer_epoch)` supplied by the
   caller. It deletes only entries with `sequence <= delete_through`, updates
   `retained_from` to one past the greatest deleted sequence, and updates the
   count/byte projections in one transaction. No checkpoint means no deletion;
   a stale checkpoint is `HISTORY_CHECKPOINT_STALE`; a checkpoint beyond the
   producer frontier is invalid. A successful delete cannot create or advance
   a checkpoint.
5. Physical compaction may rewrite SQLite storage after logical deletion, but
   it must preserve every remaining sequence, canonical byte sequence, digest,
   and head projection. A successful physical compaction alone cannot advance
   `retained_from` or mint deletion authority.
6. Every writer operation uses the same immediate transaction and a
   compare-and-set on `head_revision`. A stale writer is rejected rather than
   overwriting a newer head. Consumer cursor writes use their own
   `reader_revision`; they never change producer sequence, checkpoint version,
   or deletion eligibility.

A producer that reaches a bound without a committed checkpoint receives
backpressure and must stop accepting entries. It cannot recover by silently
retaining only a cache, dropping oldest entries, or treating compaction success
as permission to delete.

### Reader and history semantics

A reader always reads committed SQLite rows in ascending `sequence` order.
`from-head` starts at the current `retained_from`; `from-now` starts at
`produced_through + 1`; an explicit cursor is not silently rewritten.

- `cursor < retained_from` returns `HISTORY_GAP` with the exact
  `retained_from`, `produced_through`, `head_revision`, and `checkpoint_digest`;
  it returns no fabricated entries and does not advance the cursor.
- `cursor > produced_through + 1` returns `HISTORY_CURSOR_AHEAD`.
- `cursor == produced_through + 1` returns an empty committed page.
- Otherwise the reader receives a contiguous, ordered range bounded by the
  requested count and byte limits. Reading does not acknowledge or advance.
- `ack` advances only the configured reader's cursor by compare-and-set and
  records the exact head revision observed. It is useful evidence for the
  producer, but it cannot publish or advance a checkpoint and cannot delete a
  history row.

A consumer that needs replay beyond `retained_from` must receive the explicit
gap and choose its own recovery; FileCore must not recreate acknowledged or
missing history.

### Crash, concurrency, and corruption behavior

- A crash before a transaction commits exposes none of its rows, projection
  changes, or cursor changes. A crash after commit exposes all of them.
- If an acknowledgement is lost, reopen reads the exact head/checkpoint and
  entry digests. The caller retries only by idempotent `producer_entry_id` or
  exact expected checkpoint version; an ambiguous commit is not redispatched
  or replaced by a new identity.
- A checkpoint may be durable while deletion is still pending. Recovery keeps
  the old entries, then may retry `deleteEligible` with the exact checkpoint.
  A deletion commit that is ambiguous is resolved by rereading the head and
  entries; no arbitrary second deletion is issued.
- Corrupt canonical bytes, unknown fields, digest/projection mismatch, a
  sequence gap, a non-monotonic version, or a mismatched producer epoch fails
  closed as storage corruption/fencing. Recovery does not patch, infer a
  checkpoint, or delete the suspect row.
- The existing platform preflight and controller-lock rules remain in force.
  This ADR does not change non-Linux refusal ordering or any startup guard.

### Migration and rollback

Migration is an explicit offline operation under the instance controller lock
and the Runtime SQLite expected-version procedure. It validates the complete
legacy source, its canonical bytes/digest, and the target schema before one
transaction. A crash before commit creates no history authority; a crash after
commit is resolved by rereading the exact target head/checkpoint digest.

Current `FileCoreStateStore` snapshots and
`FileModuleResultCommitRepository` documents contain current state/result
records but no ordered history or producer deletion premise. Migration therefore
must not manufacture entries from their `revision`, records array, logs, cache,
reader progress, or successful cleanup. It records the exact legacy source
digest in `legacy_source_digest`, initializes an empty history with
`produced_through = 0`, `retained_from = 1`, and checkpoint version `0`, and
reports `HISTORY_GAP` for any request for pre-migration history. If a future
source format contains a recognized history, migration must preserve every
entry and its sequence/digest and must not lower its retained floor.

After a successful cutover, legacy JSON files are read-only/recover-only and
cannot be a second authority. There is no downgrade migration that lets a
legacy writer resume. `RUNTIME_MODULE_MIGRATION_REQUIRED` remains unchanged;
no public activation may rely on an unmigrated history store.

## Observable acceptance tests

The implementation lane must add focused conformance evidence for all of the
following before this ADR can become `Accepted`:

1. **Closed records and projections:** canonical JCS bytes, digests, exact
   fields, sequence/version monotonicity, unknown-field rejection, and
   corruption detection on every projection mismatch.
2. **Bounded append:** count and canonical-byte limits reject the candidate
   before any row, head revision, or producer sequence changes; a duplicate
   idempotency key replays the same entry and a conflicting digest refuses.
3. **Authority direction:** reader progress, an acknowledgement, an empty
   reader set, a cache-only observation, and a successful physical compaction
   cannot advance a checkpoint or delete a row. Only the producer authority
   with the current epoch can publish a checkpoint.
4. **Checkpoint-before-delete:** deletion without a checkpoint, with a stale
   checkpoint, with a wrong digest/epoch, or beyond `produced_through` refuses
   without mutation. The exact checkpoint permits only its inclusive range.
5. **Reader behavior:** `from-head`, `from-now`, contiguous replay, empty
   frontier, cursor-ahead refusal, and honest post-deletion `HISTORY_GAP` are
   deterministic across reopen; reading never advances a cursor.
6. **Crash and concurrency ordering:** competing writers serialize under the
   controller lock; stale head/reader revisions and producer epochs are
   fenced; injected failures before and after checkpoint, append, and delete
   commit reopen to the corresponding all-old or all-new state without a
   duplicate entry or invented deletion premise.
7. **Bounded reader metadata:** configured reader slots cannot exceed
   `max_readers`, and reader acknowledgements cannot grow an unbounded history
   table.
8. **Migration:** an exact expected legacy source migrates once, preserves its
   source digest and current state authority, creates the explicit empty
   pre-migration boundary, refuses source corruption/mismatch without mutation,
   and never reconstructs history from a revision, cache, ACK, or cleanup.
9. **SQLite parity:** TypeScript and Rust implementations observe identical
   canonical records, transaction ordering, limits, digests, and gap/error
   vectors against the shared Runtime SQLite database.

## Approval required

The Runtime authority/storage owner and the Core/FileCore owner must approve
this ADR before implementation begins, specifically confirming:

1. the logical canonical-entry count/byte measure as the v1 retention bound (or
   supplying a separate physical SQLite bound);
2. one instance-global stream with finite configured reader slots;
3. producer-issued checkpoints as the sole deletion authority, with reader ACKs
   as non-authoritative evidence only; and
4. an explicit migration gap rather than fabricated legacy history, while
   retaining `RUNTIME_MODULE_MIGRATION_REQUIRED`.

Until that approval and one Luna review, this record remains `Proposed` and no
FileCore runtime/source change is authorized by it.
