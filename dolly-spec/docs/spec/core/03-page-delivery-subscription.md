# Page, Delivery, and Subscription

Status: normative for Dolly Core v1.

This document defines Page broadcast logs, per-Module subscriptions, Delivery identity, ordering, cursor semantics, durable and lossy behavior, and the only permitted cross-Page merge. Blocks are defined in [Block and Action](02-block-and-action.md).

The RFC 2119/8174 requirement-keyword convention in [Identifiers and Canonical JSON](01-identifiers-and-canonical-json.md) applies here.

## 1. Page semantics

A Page is a named, append-only logical broadcast log. Appending one Block to a Page creates one Delivery. Every active subscriber has an independent cursor; consuming a Delivery for one Module does not consume it for another.

A Page MUST have exactly one durability mode for a given `graph_revision`:

| Mode | Pending Delivery storage | Cursor storage | Crash guarantee |
| --- | --- | --- | --- |
| `durable` | SQLite | SQLite | admitted Deliveries survive restart until safely reclaimable |
| `lossy` | bounded memory | bounded memory, with a persisted Page sequence high-water mark | pending Deliveries MAY disappear on process crash or restart |

Changing durability mode requires a new graph revision and a drained Page. It MUST NOT be performed as a live in-place mutation.

## 2. DeliveryRecord

The logical committed record is:

```json
{
  "page_id": "conversation",
  "page_seq": 31,
  "commit_seq": 4813,
  "block_id": "0198ab31-6c44-7e8a-b2bb-000000000001",
  "origin": {
    "kind": "activation",
    "activation_id": "0198ab31-6c44-7e8a-b2bb-000000000004"
  }
}
```

`origin.kind` is one of `activation`, `external`, or `runtime`. Its corresponding trusted identifier is assigned by the Runtime. An activation origin contains exactly `activation_id`; an external origin contains exactly `ingress_id`; and a Runtime origin contains exactly `runtime_event_id`. Fields belonging to another origin variant are forbidden.

For every Page:

- `page_seq` starts at one and every committed durable append or durably sequenced lossy append consumes exactly the current `next_page_seq`; an allocation in a rolled-back transaction is not an append and MAY be reused;
- no two records share `(page_id, page_seq)`; and
- the Page maintains `next_page_seq`, the next value to assign.

`commit_seq` comes from one instance-global sequence domain shared by committed Core records. Every Delivery has a unique `commit_seq`. Therefore Deliveries from different Pages have a deterministic total order. Wall-clock time MUST NOT break ordering ties.

The normative cross-Page order is ascending `(commit_seq, page_id, page_seq)`. `commit_seq` is unique in v1; the remaining members are defensive deterministic tie-breakers for imported diagnostics and consistency checks.

## 3. Repeated arrival and occurrences

Repeat count is a property of Delivery, not Block.

If the same Block reaches a Module through two input Pages, the frozen Activation item is:

```json
{
  "block": {
    "schema": "dolly.block/v1",
    "id": "0198ab31-6c44-7e8a-b2bb-000000000001",
    "created_at": "2026-08-10T18:30:00.123456Z",
    "creation_commit_seq": 4812,
    "producer": {"kind": "module", "instance_id": "main", "module_id": "source"},
    "trace": {
      "trace_id": "0198ab31-6c44-7e8a-b2bb-000000000002",
      "root_trace_ids": ["0198ab31-6c44-7e8a-b2bb-000000000002"],
      "causal_parents": [],
      "hop_count": 0
    },
    "body": {"description": "", "parts": [], "actions": [], "metadata": {}, "hints": {}},
    "body_digest": "sha256:a3ddb3c6f43faae5f314da4640ea4a6995f2523e1d45c8d0ed920c7bdd9c10e9",
    "envelope_digest": "sha256:9f6e6174d8933c807e74dc3bb228b9980b677e5647be16810d2b18df2cc85966"
  },
  "occurrences": [
    {"page_id": "conversation", "page_seq": 31, "commit_seq": 4813},
    {"page_id": "review", "page_seq": 18, "commit_seq": 4815}
  ],
  "occurrence_count": 2
}
```

The Runtime MUST transmit the complete immutable Block envelope once per Activation item and MUST preserve every selected occurrence. `occurrence_count` MUST equal the number of entries in `occurrences`. It MUST NOT modify the Block, add a count to it, or collapse the two Delivery records in storage.

Two Deliveries of the same Block on the same Page remain two occurrences if they have different `page_seq` values. Core does not infer whether repeated publication was intentional.

## 4. Subscription cursor

For subscription `(page_id, module_id)`, `cursor` is exactly:

> the lowest `page_seq` not yet committed as consumed, dead-lettered, or explicitly skipped for that subscription, and not declared unavailable by a permitted `LossyGap`.

It is **not** the last processed sequence. If `cursor == page.next_page_seq`, the subscriber is caught up.

On subscription creation, `start_position` MUST be explicit or use the v1 default `latest`:

| Value | Initial cursor |
| --- | --- |
| `latest` | the Page's current `next_page_seq` |
| `earliest` | the lowest retained `page_seq`, or `next_page_seq` if the Page is empty |

A cursor:

- MUST be monotonic;
- MUST advance only over a contiguous Page prefix;
- MUST NOT advance merely because an Activation was dispatched;
- MUST NOT advance past a durable Delivery whose Block body is unavailable.

A durable cursor MUST advance atomically with successful Activation result commit or with one of the audited dispositions below. A lossy cursor advances in memory after successful durable Activation commit, or under the explicit overflow/restart gap rules in section 7; it has no stronger crash guarantee.

The only non-Activation advances are these explicit audited transactions:

| Disposition | Required durable evidence | Meaning |
| --- | --- | --- |
| `SubscriptionDeadLetter` | every original Delivery identity and Block identity, the contiguous half-open range, reason code, principal, and time | input was not successfully processed, but its exact payload remains durably reachable for inspection or replay tooling |
| `SubscriptionSkip` | the contiguous half-open range, reason code, principal, and time | input is intentionally discarded for this subscription under reviewed policy |

A dead-letter transaction MUST retain an immutable reference to every affected Block for at least the Page's configured `retention.min_age_ms`; the v1 normalization default is seven days. It MAY additionally publish a diagnostic Block to a configured dead-letter Page, but that publication is a separate append and MUST NOT be the only disposition evidence. Silent cursor jumps are forbidden.

`SubscriptionDeadLetter` is defined only for a durable Page whose complete Delivery range remains available. Lossy overflow or restart loss is represented by `LossyGap`, never by fabricated dead-letter evidence.

A dead-letter or skip range MUST begin at the current cursor and MUST NOT overlap a cursor span frozen by a nonterminal Activation. The operator MUST first safely cancel or resolve that Activation.

`REQ-PAGE-002` — A `SubscriptionSkip` range is limited to already allocated
Page sequence space. In the same transaction that compares `expected_cursor`,
the Runtime MUST require `end_exclusive <= page.next_page_seq`; otherwise it
returns `SUBSCRIPTION_DISPOSITION_CONFLICT` and leaves the cursor unchanged.
An audited skip cannot pre-disposition a future Delivery that does not yet have
a committed Page sequence identity.

## 5. Subscription state

| State | Receives new Deliveries | May build an Activation | Cursor may advance |
| --- | ---: | ---: | ---: |
| `active` | yes | yes | yes |
| `paused` | yes | no | only explicit dead-letter or skip |
| `quarantined` | yes | no | only explicit reviewed dead-letter or skip |
| `draining` | no new graph membership | existing frozen manifests only | yes |
| `deleted` | no | no | no |

Valid transitions are:

```text
active <-> paused
active|paused -> quarantined
quarantined -> paused
active|paused -> draining -> deleted
```

Deletion MUST wait until no nonterminal Activation Manifest references the subscription. A deleted subscription cannot be resurrected under the same graph revision.

## 6. Durable Page behavior

The v1 normalization defaults for a durable Page are 1,000,000 uncommitted Deliveries and 67,108,864 referenced canonical Block bytes. A resolved configuration MUST materialize both `quota.max_entries` and `quota.max_bytes`; configuration MAY lower or raise either value, but both MUST remain finite.

Admission usage is Page-level because a broadcast Delivery row is stored once. It is the unique pending Delivery range from the lowest non-deleted durable subscription cursor through the candidate append. A repeated Delivery counts as another entry and counts its referenced canonical Block bytes again for quota, even when its `block_id` repeats. Audit-retained rows below every cursor do not count as uncommitted admission usage, but they remain subject to storage-capacity policy.

`REQ-PAGE-001` — Activation output admission MUST use the projected state of
the complete atomic result transaction, not the transaction's pre-state. For a
candidate append on durable Page `P` at `q = P.next_page_seq`, let
`projected_cursor(s)` equal the frozen `to_page_seq` for each durable input
subscription advanced by this Activation and equal the current cursor for every
other non-deleted durable subscriber. Define:

```text
projected_low(P) = min({projected_cursor(s) for non-deleted s on P} union {q})
projected_entries(P) = committed Delivery rows with
                       projected_low(P) <= page_seq < q,
                       plus the candidate append at q
projected_entry_count(P) = |projected_entries(P)|
projected_byte_count(P) = sum(canonical Block bytes once per projected entry)
```

The candidate is admissible exactly when both projected counts fit the Page's
frozen effective quota. Thus an Activation that consumes the sole pending entry
of a self-loop Page and atomically appends its successor does not deadlock at
`max_entries = 1`; a different subscriber that remains behind still blocks the
append. Preflight and the in-transaction recheck MUST use this same formula.

When appending to a durable Page would exceed either admission limit:

- a Module Activation commit MUST fail as retryable `PAGE_BACKPRESSURE` without advancing input cursors and without partially appending to other durable outputs;
- external ingress MUST fail before Block commit with retryable `PAGE_BACKPRESSURE`; and
- the Runtime MUST expose the blocking Page and every subscription at the lowest cursor in metrics and diagnostics.

A durable Page MUST NOT drop oldest or newest data to recover from pressure. An operator MAY explicitly dead-letter, skip, or delete a subscription, but that is an audited semantic change.

Durable Delivery reclamation requires all of:

1. every non-deleted durable subscriber cursor is greater than the Delivery's `page_seq`;
2. no nonterminal Activation Manifest references the Delivery;
3. the configured audit retention has elapsed; and
4. no legal hold or pin retains it.

The v1 normalization default for Page `retention.min_age_ms` is seven days, measured after condition 1 becomes true; the default `retention.max_age_ms` is `null`. A non-null `retention.max_age_ms` MAY cap best-effort retention only after all four reclamation conditions hold; it MUST NOT force deletion of a still-needed durable Delivery.

## 7. Lossy Page behavior

Lossy Pages are for progress, telemetry, or replaceable signals. They MUST NOT carry the sole copy of data required for correctness.

The fixed v1 defaults are:

| Setting | Default |
| --- | ---: |
| maximum pending Deliveries | 1,024 |
| maximum pending referenced canonical Block bytes | 16,777,216 |
| overflow policy | `drop_oldest` |

Every numeric `LossyGap` denotes the half-open missing Page range
`[from_page_seq, to_page_seq)` and MUST have
`from_page_seq < to_page_seq`. `to_page_seq` is always exclusive. Only a
restart gap may use a `null` lower bound.

For each lossy logical append, the Runtime considers the prior queue followed by
the new Delivery and evicts the minimum oldest prefix needed to satisfy both
limits. If the new Delivery alone exceeds the byte limit, that prefix includes
the new Delivery and the resulting queue is empty; its durable append-audit row
still exists and its loss is still a gap. For every affected subscription the
Runtime MUST record an in-memory `LossyGap` and move its cursor to the first
retained sequence, or to `next_page_seq` when the queue is empty. A Module
Manifest MUST expose each gap that occurred since its previous Activation; it
MUST NOT pretend that the missing Deliveries were processed.

`next_page_seq` for a lossy Page MUST be persisted whenever any Core transaction,
including Activation, ingress, or Runtime-event output, allocates a lossy output
sequence. Sequence values MUST NOT be reused after restart. After restart, all
lossy subscriptions start at the persisted `next_page_seq`. The Runtime records
a restart `LossyGap` whose lower bound is the last persisted diagnostic cursor
when available and is otherwise `null`; the exclusive upper bound is the
persisted `next_page_seq`. A `null` lower bound explicitly means that the exact
lost range is unknowable.

A `LossyGap` remains unreported until it is frozen into a Manifest whose result
commits. Dispatch, retry, staging, quarantine, and cancellation do not report or
erase it. The durable Activation-commit transaction MUST record the exact frozen
gap tuples as lossy input dispositions; only after that commit may the Runtime
remove those gaps from the in-memory pending-report set. A gap created after the
Manifest was frozen is not part of that disposition and MUST remain available
to a future Manifest. Recovery uses the durable disposition plus the new restart
gap, so a crash between durable commit and in-memory cleanup cannot silently
lose an unreported gap.

`REQ-PAGE-003` — Creating or recovering a previously unreported `LossyGap`
makes an idle active subscription input-eligible exactly as a retained Delivery
arrival does. After the ordinary debounce/max-wait deadline, the Runtime MUST
be able to persist an `input` Manifest containing that gap even when
`input_items` and `cursor_spans` are both empty. A gap-only Manifest is not the
forbidden empty-input spin: the same gap remains single-flight and eligible for
another attempt only until one such Manifest commits its disposition. This
guarantees that immediate eviction of an oversized lossy append, or a restart
with no later arrival, cannot leave loss permanently unreported.

A post-freeze overflow gap can overlap the Manifest's frozen cursor span even
though the Manifest retained and successfully processed those Block bytes. On
commit, the Runtime MUST subtract the committed half-open cursor span from every
later numeric gap on that Page and retain only non-empty residual missing
ranges. If a restart gap has `from_page_seq = null` and the committed span
belongs to that Page, the known processed prefix ends at the span's
`to_page_seq`; the residual lower bound becomes that value, or the gap is removed
when its upper bound is not greater. Adjacent residuals with the same reason MAY
be coalesced deterministically. The Runtime MUST NOT report a sequence as lost
after that same Manifest committed it as processed.

Lossy append occurs after the durable SQLite commit. A crash in that interval MAY lose the lossy Delivery. Core MUST NOT replay it after restart. This is the sole intentional exception to durable output atomicity and MUST be visible from Page configuration.

## 8. Frozen cross-Page merge

Core MUST merge input from multiple Pages only while constructing one persisted `ActivationManifest`. There is no mutable combined mailbox outside that manifest.

For input-driven scheduling, the v1 normalization defaults are `debounce_ms = 200` and `max_wait_ms = 3000`. Eligible pending input means at least one retained candidate Delivery or one unreported `LossyGap`. When an idle Module first has eligible pending input, the Runtime records `first_pending_at`; it also records `last_arrival_at` whenever that pending candidate set grows, including when a gap is created or recovered. The eligibility deadline is:

```text
eligible_at = min(last_arrival_at + debounce_ms,
                  first_pending_at + max_wait_ms)
```

The Runtime MUST NOT build the input Manifest before `eligible_at`, and it SHOULD build it promptly afterward subject to persisted rate limits and higher-priority safety work. These wall deadlines MUST be persisted or exactly reconstructible from committed journal events and MUST be evaluated with the injected monotonic clock while the process is alive. Additional arrivals after a Manifest is persisted belong only to a future Manifest.

The Runtime performs this deterministic algorithm:

```text
build_manifest(module M, graph revision R):
  require no nonterminal manifest for M
  inputs := R.input_pages(M), sorted by PageId
  gaps := []
  for each input page P:
      read the available contiguous prefix beginning at subscription.cursor
      append every unreported LossyGap at that prefix boundary to gaps,
        including when no retained item exists
  merge all candidate Deliveries by (commit_seq, page_id, page_seq)
  for reason == input, require at least one candidate Delivery or frozen gap
  select the longest merged prefix satisfying the configured batch limits
      and whose complete canonical module.activate request fits max_frame_bytes
      and whose ActivationManifest semantic structure fits max_json_nesting_depth
      except that the first available Block may exceed max_batch_bytes
      but may not exceed the hard Block limit
  verify that selected Deliveries form a prefix on every participating Page
  group selected Deliveries by block_id
  order groups by their first occurrence's Delivery order
  freeze Block bytes, occurrences, cursor spans, gaps, R, all revisions,
    complete effective_config, and its value/schema digests
  persist the canonical manifest and its digest before dispatch, atomically
    rechecking that every frozen gap is still unreported
```

The v1 normalization defaults are `max_blocks = 128`, `max_occurrences = 512`,
`max_input_bytes = 1,048,576` referenced canonical Block bytes,
`max_descriptor_bytes = 1,048,576` aggregate canonical
`neighbor_descriptors` projection-wrapper bytes, and a normalizer-derived
`manifest_structural_reserve_bytes`. `max_input_bytes` sums the canonical
`BlockEnvelope` once per distinct `input_item`, not once per occurrence. The
hard limits are 256 Blocks, 2,048 occurrences, 8,388,608 Block bytes, and
1,048,576 Descriptor bytes. The Runtime MUST also account for the exact frozen
effective-configuration bytes, Descriptor bytes, occurrences, cursor spans,
gaps, lease envelope, and bounded JSON-RPC wrapper when enforcing the negotiated
`max_frame_bytes`; the derived
reserve is a configuration-admission proof, not a substitute for this exact
check. It MUST also validate the complete wire document against the independent
wire parse-depth limit. For the resolved `max_json_nesting_depth` semantic
limit, the Manifest structural document, every embedded immutable Block, every
neighbor Descriptor, and every schema-declared `JsonValue` are checked from
their respective schema roots as specified in
[Identifiers and Canonical JSON](01-identifiers-and-canonical-json.md); JSON-RPC
and lease-envelope wrapping is not charged to that semantic quota. A resolved
configuration MUST materialize every batching field so replay
never depends on binary-local defaults. Execution and retry fields are
materialized under [Activation and Module](04-activation-and-module.md).

Manifest arrays have one canonical semantic order: `input_items` by first occurrence Delivery order; each item's `occurrences` by `(commit_seq, page_id, page_seq)`; `cursor_spans` by `page_id`; `lossy_gaps` by `(page_id, to_page_seq, from_page_seq)` with `null` before integers; `output_page_ids` by bytewise `PageId`; and `neighbor_descriptors` by `(module_id, descriptor_revision)`. A sender MUST NOT preserve hash-map iteration or arrival-race order in these arrays.

Each `neighbor_descriptors` entry is a Runtime-derived, closed projection
wrapper with `module_id`, `descriptor_revision`, `source_descriptor_digest`,
`relationships`, and `projection`. The Runtime MUST construct it as follows:

1. Select the immutable source Descriptor named by `(module_id,
   descriptor_revision)` in the Manifest's frozen graph and verify
   `source_descriptor_digest` over its complete canonical bytes.
2. Add `input_producer` when the neighbor outputs to at least one frozen input
   Page of the receiving Module. Add `output_consumer` when the neighbor
   subscribes to at least one frozen output Page of the receiving Module.
3. Deduplicate by `module_id`. The only legal relationship arrays are exactly
   `["input_producer"]`, `["output_consumer"]`, or
   `["input_producer","output_consumer"]`; this order is canonical.
4. Always project the policy-authorized `display_name`, Runtime-assigned
   `trust`, and namespaced `metadata`. For `input_producer`, additionally
   project only `emits`. For `output_consumer`, additionally project only
   `accepts` and the Actions the receiver is authorized to target. A dual-role
   entry contains both field groups once.
5. Apply authorization and deterministic truncation from the frozen policy
   snapshot before byte accounting. The projection is a view and MUST NOT be
   represented as, or assigned the identity of, a different source Descriptor;
   its exact bytes are instead bound by the enclosing Manifest digest.

The Runtime MUST NOT disclose a source Descriptor field merely to make a byte
budget easier to calculate, and MUST NOT query a live Extension while building
the projection. If a required authorized projection cannot fit the effective
descriptor or frame limit, Manifest creation fails closed with
`MANIFEST_FRAME_LIMIT`; it MUST NOT silently omit the neighbor, a relationship,
or an authorized Action contract.

For every Page represented in a manifest, `cursor_spans` contains a half-open range `[from_page_seq, to_page_seq)`. `from_page_seq` MUST equal the subscription cursor observed during construction. Successful commit sets a durable cursor to `to_page_seq`. A lossy cursor may already have advanced because of overflow while the Manifest was nonterminal; post-commit application MUST set it to `max(current_cursor, to_page_seq)` and MUST preserve every intervening `LossyGap`. A Page with no selected Delivery has no cursor span and cannot have its cursor changed by that Activation.

Once persisted, the manifest's selected Delivery identities, ordering, Block
canonical bytes, occurrences, cursor spans, graph revision, descriptors,
configuration revision, complete effective configuration, and configuration
value/schema digests MUST NOT change. A retry MUST use byte-identical manifest
JSON and the same `manifest_digest`, even if new Deliveries arrive or
configuration changes.

## 9. Page append and fan-out

For a Module output, the output Page set is the exact unique set frozen in the Activation Manifest's graph revision. If an output Block exists, the Runtime MUST attempt to append it to every Page in that set. It MUST NOT choose a subset based on load, Action target, current graph, or Extension response.

Durable appends and cursor advancement form one SQLite transaction. All frozen output Pages, regardless of mode, are ordered together by canonical `PageId` before sequence allocation. A failure on any durable Page aborts every durable append, lossy logical append reservation, Block creation, Activation commit, and cursor advance.

Lossy outputs follow the separately declared semantics in section 7. A later graph revision that removes or deletes a Page MUST retain a tombstoned representation until every Activation frozen against the older revision is terminal. The tombstone preserves replay and reference resolution; it does not authorize an Activation cancelled or fenced by graph cutover to commit.

## 10. Errors

| Code | Retryable | Meaning |
| --- | ---: | --- |
| `PAGE_NOT_FOUND` | no | Page is absent from the applicable graph revision |
| `PAGE_BACKPRESSURE` | yes | durable admission limit prevents atomic commit |
| `PAGE_SEQUENCE_GAP` | no | durable Page or cursor has an unexplained gap; instance enters `RecoveryRequired` |
| `ACTIVATION_CURSOR_CONFLICT` | no | persisted cursor differs from the manifest's frozen start; instance enters `RecoveryRequired` |
| `PAGE_MODE_CHANGE_REQUIRES_DRAIN` | no | live durability-mode change was requested |
| `SUBSCRIPTION_QUARANTINED` | no | Module cannot activate until reviewed |
| `SUBSCRIPTION_DISPOSITION_CONFLICT` | no | dead-letter or skip range is noncontiguous, overlaps a frozen manifest, or does not begin at the expected cursor |
| `MANIFEST_BATCH_LIMIT` | no | hard batch limit would be exceeded |
| `MANIFEST_FRAME_LIMIT` | no | even the minimum eligible complete `module.activate` request cannot fit the negotiated frame limit; configuration or Descriptor repair is required |

## 11. Invariants

- **INV-PAGELOG-001 — Broadcast independence.** Every subscriber observes its own cursor over the same Page log.
- **INV-PAGELOG-002 — Cursor meaning.** A cursor always names the next Page sequence without a committed consumption, dead-letter, skip, or permitted lossy-gap disposition.
- **INV-PAGELOG-003 — Cursor atomicity.** A normal cursor advance and the corresponding Activation output commit are one durable transaction.
- **INV-PAGELOG-004 — Delivery identity.** Repetition and Page path are represented only by distinct Delivery records and frozen occurrences.
- **INV-PAGELOG-005 — Total order.** `commit_seq` determines one deterministic cross-Page Delivery order.
- **INV-PAGELOG-006 — Frozen merge.** Cross-Page merging exists only inside a persisted immutable Activation Manifest.
- **INV-PAGELOG-007 — Durable no-drop.** A durable Page never silently drops an admitted pending Delivery.
- **INV-PAGELOG-008 — Loss declaration.** Loss is permitted only on a Page explicitly configured `lossy`, and every non-crash gap is reported.
- **INV-PAGELOG-009 — Complete fan-out.** A non-null Module output is routed according to every output edge in the frozen graph revision, never the current graph revision.
- **INV-PAGELOG-010 — Frozen neighbor projection.** Each neighbor appears once with exact graph-derived relationship labels, a verified source Descriptor digest, and only the fields authorized by the frozen policy; retry bytes never change.
- **INV-PAGELOG-011 — Truthful lossy gaps.** A reported lossy gap excludes every sequence actually consumed by a committed Manifest, including sequences evicted while that Manifest was nonterminal.
- **INV-PAGELOG-012 — Projected admission.** Durable output quota admission is computed from the complete projected cursor-and-append post-state of the atomic Activation transaction.
- **INV-PAGELOG-013 — No future skip.** A subscription disposition cannot advance beyond the Page sequence high-water mark observed in that transaction.
- **INV-PAGELOG-014 — Eventual gap input.** An unreported lossy gap independently makes an idle active Module eligible for a gap-only input Manifest.

## 12. Crash expectations

| Crash point | Required recovery |
| --- | --- |
| before manifest persistence | no Activation exists; cursors are unchanged |
| after manifest persistence, before dispatch | same canonical manifest is ready for dispatch |
| after durable dispatch marker, before result | cursors are unchanged; after fencing, the exact frozen replay contract selects same-Manifest retry or quarantine |
| during durable output transaction | SQLite exposes either all Block, Delivery, cursor, and Activation changes or none |
| after durable commit, before caller acknowledgement | replay observes already committed state and creates no duplicate durable Delivery |
| after durable commit, before lossy append | durable state remains; missing lossy output is permitted and is not replayed |
| during dead-letter or skip transaction | both immutable disposition evidence and the new cursor appear, or neither does |

Activation lifecycle and fencing are specified in [Activation and Module](04-activation-and-module.md); the transaction layout is specified in [Storage and Recovery](06-storage-and-recovery.md).
