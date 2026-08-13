# Memory Baseline Extension Specification

Status: **normative for Dolly v1 M0/M1**. Automatic injection, consolidation, association graphs, procedural transfer, and Reflection Policy are not part of the stable baseline unless separately promoted.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

`REQ-MEM-001` — A stable Memory Baseline conformance claim MUST satisfy every
normative ingestion, provenance, retrieval, abstention, conflict, isolation,
failure, and conformance test obligation in this chapter without depending on
an Experimental subsystem.

`REQ-MEM-002` — Every search MUST construct and freeze an effective query
basis, exclude every Memory record whose source provenance intersects that
basis before ranking or context expansion, and prevent Memory-produced query,
recall, decision, and evidence values from becoming new Memory evidence.

`REQ-MEM-003` — Recalled content MUST cross Module boundaries only through an
ordinary Block and, when selected for a model request, a typed
`memory_evidence` part in an `external` canonical message. Dynamic recalled
content MUST NOT enter Premise, a system/developer message, capability policy,
tool authority, or approval input.

## 1. Responsibility and exclusions

The Memory Baseline Extension durably ingests evidence from committed Blocks and provides provenance-preserving lexical, dense, and hybrid retrieval. It MUST support explicit search and abstention. It MUST NOT claim causality, rewrite a source Block, silently overwrite a conflicting fact, modify an LLM prompt, create or enable a Skill, pin all historical Blocks, or make Core delivery correctness depend on an index.

The built-in v1 package Extension ID is `org.dolly.memory`; index or embedding
variants are configuration revisions, not new Action owners.

Indexing is a derived, recoverable service. A Memory crash or stale index MUST not lose or acknowledge Core inputs incorrectly. Later experimental stages MUST be removable without degrading M0/M1 source records.

## 2. Configuration

Configuration MUST specify eligible Pages and Block/part kinds, text extraction revision, record and chunk limits, lexical index revision, embedding profile and preprocessing revision, fusion method, result and token limits, source-retention policy, and background-worker resource limits.

Dense retrieval and reranking MAY be disabled. When enabled, their model/profile, vector dimension, preprocessing, and revision MUST be recorded. Changing an embedding revision MUST build a side-by-side index; it MUST NOT reinterpret old vectors as new ones.

Every Memory Module stores semantic records, jobs, indexes, presentation
decisions, and model/profile metadata under its Host-assigned
`storage_scope_id`. Multiple Memory Modules MAY share a physical database only
when every table, index, and transaction is tenant-scoped and the adapter
verifies a unique scope-owned namespace before write. A writable raw database
path in Module configuration, a table name derived only from `module_id`, or
“the process has one current Memory” is non-conforming. A scope mismatch,
missing scope marker with retained Host state, or backend without enforceable
tenant isolation fails instantiation; it MUST NOT merge records or initialize
empty state. Restart and compatible upgrade preserve the scope; an explicit
destructive reset allocates a new one.

Automatic context selection is optional and disabled by default in v1. If
enabled under an experimental flag, it MUST have a typed threshold, finite
token cap, effective-query-basis self-match suppression, observable
abstention, immutable per-candidate decisions, and an immediate rollback
switch. Rate control applies to automatic retrieval attempts, not to an
individual record's eligibility. A time-only per-record ban such as “once per
day” is invalid. The complete repeat policy is defined by
[Memory Context Selection Research](../research/memory-injection.md).

## 3. Inputs, outputs, and actions

Semantic inputs are committed Block deliveries selected by a Runtime Activation.
Explicit operations are targeted Actions inside those Blocks, not direct
Extension calls. Operational inputs also include background-job wakeups and
configuration revisions. Stable action responses are `ActionResult` JSON Parts
packed into the Activation's zero-or-one output BlockDraft. Stable baseline
ingestion MUST NOT emit unsolicited Blocks; an ingestion-only Activation
normally succeeds with no output. An experimental automatic-injection result,
when enabled, is only a Block draft returned through the normal Activation
commit path and MUST never be appended directly to a Page.

The Block is the only cross-Module carrier, regardless of whether retrieval was
explicit or automatic. Premise may describe the Memory Action contract but
MUST remain a deterministic projection of a frozen Module Descriptor. An LLM
Extension that chooses to use a search result constructs typed external Memory
evidence under the rules in the research chapter; it does not copy the text
into the Descriptor projection.

## 4. Durable records

The stable record conforms to `schemas/memory-record.schema.json`, for example:

```json
{
  "memory_id": "0198ab31-6c44-7e8a-b2bb-000000000091",
  "record_revision": 1,
  "page_id": "conversation",
  "source_block_ids": ["0198ab31-6c44-7e8a-b2bb-000000000092"],
  "record_type": "evidence",
  "text": "The source evidence text.",
  "event_time_start": null,
  "event_time_end": null,
  "ingestion_time": "2026-08-10T01:02:03.000000Z",
  "valid_time": {"from": null, "until": null},
  "provenance": {"extractor_revision": "extractor-v1", "part_paths": ["/body/parts/0"], "chunk_ordinal": 0, "model_profile_revision": null, "validation_state": "source_fidelity"},
  "confidence": 1.0,
  "status": "current",
  "supersedes_memory_id": null,
  "conflict_set_id": null
}
```

Extracted source evidence has confidence `1.0` only for fidelity to its source
text, not for truth, and uses `validation_state: source_fidelity`. Every record
MUST use one of `source_fidelity`, `unvalidated`, `validated`, or `rejected`.
Derived claims MUST name every supporting Block, extractor/model revision, and
validation state. A non-null `model_profile_revision` MUST be the closed
`ProfileRef` object `{profile_id, revision}` from
`schemas/model-request.schema.json`, not a bare revision integer. A null
model-profile revision means that no model produced the record; it MUST NOT mean
that the producing profile identity or revision was forgotten. A record with
`validation_state: rejected` MUST NOT have `status: current`; it remains
auditable under a non-current status and retrieval MUST expose that validation
state whenever the record is eligible for an authorized diagnostic query.

The ingestion identity MUST include `(source_block_id, extraction_revision, part_path, chunk_ordinal)`. Reprocessing that identity MUST upsert the same derived record. A changed extraction revision creates a new version and does not destroy rollback data until retention permits.

## 5. Ingestion

On a committed delivery, the Extension MUST durably enqueue source Block IDs, then release the Activation input. It MUST query immutable Block content by ID when background work runs. It MUST NOT retain in-memory Block pointers until a daily job.

If media extraction is configured, the worker MUST acquire a finite Asset lease, release it promptly, and record the extractor and source asset/view. An asset failure MUST mark that derivative unavailable without discarding text evidence.

Ingestion stages MUST be independently retryable and idempotent: normalize, extract, chunk, lexical index, embedding, and optional rerank preparation. Permanent errors MUST quarantine only the affected derivative and remain inspectable. Search MUST continue over the last consistent index revision.

## 6. Search action and result

The stable action below MUST target a Module configured with Extension owner
`org.dolly.memory` and reach it through a subscribed Page:

```json
{
  "name": "org.dolly.memory.search",
  "target": {"module_id": "conversation-memory"},
  "arguments": {
    "query_parts": [{"kind": "text", "text": "scheduler", "format": "plain"}],
    "query_basis_block_ids": [],
    "filters": {"page_ids": [], "time": null, "record_types": [], "statuses": ["current"]},
    "limit": 10,
    "token_budget": 1500,
    "index_revision": null
  }
}
```

`arguments` MUST conform to `schemas/memory-search.schema.json`.

`query_basis_block_ids` lists earlier committed Blocks whose text, Assets, or
expanded references contributed to `query_parts`. The effective basis is the
union of that list, the Action-containing Block, and every source Block in the
frozen Activation Manifest. A first-party query compiler MUST include every
earlier Block it used; it cannot omit a source merely because it copied only a
short span. The Extension deduplicates and sorts the effective set by lowercase
UUID text and computes:

```text
query_basis_digest = sha256(JCS({"source_block_ids": <sorted effective set>}))
query_digest = sha256(JCS({
  "arguments": <validated Action arguments>,
  "effective_query_basis_block_ids": <sorted effective set>,
  "selected_index_revision": <actual revision>
}))
```

Every Memory record whose `source_block_ids` intersects the effective set MUST
be removed before scoring, top-k, adjacent-context expansion, or experimental
association expansion. The result returns both digests and the effective-set
count. A replay of the same committed Activation returns the same
`retrieval_id` and result bytes.

Search MUST use the latest fully committed compatible index unless a revision is requested. On success, the `ActionResult.result` payload MUST conform to
[`schemas/memory-search-result.schema.json`](../../../schemas/memory-search-result.schema.json).
The response identifies its schema, retrieval identity, low trust class, query
and query-basis digests, effective-basis count, exact index revision, whether
the result set was truncated, and zero or more closed result records. Each
result includes Memory ID and record revision, source Block IDs, bounded
evidence span, record type and status,
`validation_state`, nullable `supersedes_memory_id` and `conflict_set_id`,
nullable lexical/dense/rerank component scores, final score, retrieval reason,
and an explicit derived-summary flag. Search results reuse the record-status and
validation-state definitions: `rejected` evidence MUST NOT be returned as
`current`, and every `disputed` result MUST preserve at least one non-null
supersession or conflict-set link. A derived summary MUST identify at least one
source Memory ID; a non-derived result MUST carry an empty derived-source
array. An empty result MUST include one of the schema's closed abstention
reasons, while a non-empty result MUST use JSON `null` for that field.

The ActionContract MUST bind result semantic validator
`org.dolly.validator.memory-search-result` revision `1`. It rejects duplicate
`(memory_id, record_revision)` identities even when the duplicate entries have
different excerpts or scores. This identity rule prevents one search result
from overweighting a record; it does not suppress that record in a later
search or model request.

Fusion and reranking MUST be deterministic for fixed index/model revisions and query. Ties MUST use a stable key. Filters MUST be applied before final top-k. The Extension MUST enforce the caller's authorization to every source; a result with no visible evidence MUST be omitted.

When evidence is insufficient, the correct response is an empty result with an abstention reason. The Extension MUST NOT generate plausible memories to fill the requested limit.

## 7. Updates, conflicts, and deletion

A new statement that conflicts with an older fact MUST create a new version
linked by `supersedes_memory_id` or `conflict_set_id`. The old record becomes
`historical` or `disputed`; it MUST NOT be overwritten. Retrieval exposes
uncertainty with the explicit `disputed` status and MUST NOT collapse it to
`current` or `historical`. Any record whose own status is `disputed` MUST have a
non-null `supersedes_memory_id` or `conflict_set_id`; a disconnected disputed
record is invalid.

Deletion or retention expiry of source material MUST propagate to derivatives and indexes. A Memory record MUST not keep an Asset alive unless it has an explicit durable reference justified by policy. Source erasure MUST remove inaccessible evidence from results even before asynchronous index compaction completes.

Manual `org.dolly.memory.retract` and `org.dolly.memory.correct` actions, if
enabled, MUST be authorized, audited, and versioned. They MUST not edit the
source Block.

## 8. Stable versus experimental behavior

Stable v1 includes reliable ingestion, provenance, lexical search, versioned dense/hybrid search when configured, filters, explicit search, abstention, and conflict-preserving updates.

The following are Experimental and MUST be feature-flagged and separately
measured: unsolicited automatic retrieval and context selection, repeat-aware
selection, LLM consolidation, procedural-memory transfer, temporal association
expansion, abstraction/trajectory matching, forgetting policies, and Reflection
Policy. Experimental failure MUST fall back to stable search and MUST NOT
corrupt stable records or indexes.

Stable explicit search MUST NOT consult prior model-request inclusion count,
last inclusion time, or context-selection decisions. Within one target model
request, the LLM Extension includes one record revision at most once. Across
different requests, the same record remains eligible, including twice on the
same day. The experimental policy records why it was included or suppressed;
presentation alone MUST NOT boost baseline ranking, importance, or retention.

Temporal co-occurrence MUST never be labeled causal. Association work is governed by the research specification, not this baseline.

## 9. Failure and Activation semantics

Ingestion acknowledgements MUST be keyed by `activation_id` and source Block identity. Replaying an Activation MUST not enqueue duplicate logical work. Extension-local semantic state prepared during an Activation MUST be reconciled with Runtime commit status before becoming visible.

Search is read-only and MAY be safely retried against the same index revision. A timeout after an index revision changes MAY produce different results and therefore MUST record the revision actually used.

Errors MUST use the common error envelope. `details` MUST identify stage, source identity where authorized, index revision, and redacted cause. Disk full, corrupt index, embedding outage, model mismatch, unauthorized source, and stale revision MUST be distinguishable by stable `code` values.

## 10. Conformance tests

Tests MUST cover duplicate ingestion, crash at every stage, reindex and rollback,
source/derivative provenance with a complete ProfileRef and validation state,
rejection of bare profile revisions and `rejected/current` records, Unicode and
huge parts, binary exclusion, asset-lease release, lexical-only operation
during embedding outage, deterministic fusion/ties, exact search-result schema
and semantic validation, duplicate Memory identity rejection, authorization
filtering, empty-result abstention, current and declared query-basis exclusion,
conflicting facts with linked `disputed` retrieval and valid time, source
erasure before compaction, index corruption rebuild, automatic-selection kill
switch, same-request deduplication, legitimate same-day cross-request
repetition, external-role prompt-injection containment, and proof that no
association, Skill creation, prompt mutation, Page append, or cursor
advancement occurs implicitly.
