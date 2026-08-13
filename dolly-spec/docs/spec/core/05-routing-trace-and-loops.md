# Routing, Trace, and Loops

Status: normative for Dolly Core v1.

Dolly graphs MAY contain cycles. This document defines revisioned routing, causal lineage, deterministic fan-in, self-delivery, and fail-closed loop budgets without changing immutable Block or Activation semantics.

The RFC 2119/8174 requirement-keyword convention in [Identifiers and Canonical JSON](01-identifiers-and-canonical-json.md) applies here.

## 1. Revisioned graph

A `GraphSnapshot` is an immutable value identified by `graph_revision`. It contains:

- all Page definitions, including durability mode;
- all Module definitions needed for routing;
- directed Page-to-Module input edges;
- directed Module-to-Page output edges; and
- the exact `(module_id, descriptor_revision, descriptor_digest)` tuple for
  each referenced Module Descriptor and the revision/digest of every relevant
  policy snapshot.

There are no direct Module-to-Module edges. Communication always consists of a Block append to a Page followed by Delivery through a subscription.

Graph revisions start at one and increase by one on every accepted topology change or change to a Descriptor/policy revision pinned by the graph. A verified Descriptor update remains inactive until this graph installation. Before activating revision `R+1`, the control plane MUST compute the affected set and satisfy the cutover requirements for the change class defined by [Configuration and Graph Revision](../control-plane/01-configuration-and-graph-revision.md). A graph-only route change MUST retain every old object needed by a live frozen Manifest and MUST NOT invalidate that Manifest merely because its Module is in the affected set. A change that replaces Extension-owned state or process generation, immediately revokes authority, performs a destructive disposition, or cannot safely retain an old participant MUST instead quiesce and fence the applicable participants before cutover. Installing the complete snapshot and changing the active pointer to `R+1` MUST then be one transaction. Readers observe either complete `R` or complete `R+1`, never a mixture. Removing an input edge with pending durable Deliveries MUST be rejected unless the subscription has first caught up or an exact approved disposition defined by the control plane—such as transfer, archive, dead-letter, or audited skip/discard—completes before cutover.

An old graph revision MUST remain available while referenced by a nonterminal Activation Manifest, retained replay record, or audit hold. Removing a Page or Module in a new revision creates a tombstone in older retained revisions; it does not rewrite those revisions. A graph-revision mismatch alone MUST NOT rewrite or invalidate an otherwise live frozen Manifest. Such an Activation MAY commit after cutover to all and only its retained old output Pages. An Activation explicitly cancelled and fenced by a cutover that requires quiescence cannot commit.

## 2. Routing rule

When constructing an Activation Manifest, the Runtime freezes:

- the input subscriptions from exactly one graph revision;
- the sorted unique output Page set from that same revision; and
- the relevant neighbor Descriptor snapshots.

When a successful result contains a BlockDraft, the Runtime MUST append the resulting Block to all and only the manifest's frozen output Pages. It MUST NOT consult the current graph at commit time.

The following MUST NOT change routing:

- Action target or Action name;
- Block description, metadata, Part type, or research hint payload;
- current Page backlog, except that durable pressure MAY block the entire commit;
- a Module-supplied Page identifier;
- a newer graph or Descriptor revision; or
- whether the output appears useful.

Duplicate output edges to the same Page in source configuration are invalid with `ROUTE_DUPLICATE_EDGE`; the Runtime MUST NOT interpret them as repeated broadcast. Intentional repetition requires a new Block or an explicit bridge Module.

## 3. Trace identity and causal lineage

Every committed Block has one unique Runtime-assigned `trace_id`. For a root Block with no causal parents:

```text
causal_parents = []
root_trace_ids = [trace_id]
hop_count = 0
```

For a Module-produced Block:

```text
causal_parents = sorted distinct BlockIds from every manifest input item
root_trace_ids = sorted union of every parent's root_trace_ids
hop_count = 1 + maximum(parent.hop_count)
trace_id = a new UUIDv7
```

`causal_parents` MUST be sorted by `(parent.creation_commit_seq, parent.block_id)`. `root_trace_ids` MUST use bytewise UUID string order. These values are Runtime-derived and included in the Block digest.

The same Block arriving through several Pages appears once in `causal_parents` but retains all Delivery occurrences in the Activation Manifest. Thus fan-in provenance expresses both content causality and path multiplicity without inventing duplicate parents.

If a timer or manual Activation has no input Block and emits output, that output is a new trace root. A background task that was initiated by a prior Activation SHOULD request a new Activation carrying an explicit committed BlockRef or host correlation so the Runtime can preserve causality; hidden Extension state cannot manufacture a parent.

## 4. Self-delivery and cycles

A Module MAY have an output edge to a Page that is also one of its input Pages. It MAY therefore receive a later Delivery of its own earlier Block. The Runtime MUST NOT discard a Delivery solely because its producer equals the subscriber.

Self-delivery is always a later Activation because:

1. one Module is single-flight;
2. its output commit occurs after its manifest was frozen; and
3. the new Delivery has a higher `commit_seq` than every manifest input Delivery.

Block references remain acyclic even when the routing graph is cyclic: a new Block MAY reference only an earlier Block.

## 5. Loop and propagation budgets

Loop controls are deterministic safety limits, not a claim that the graph is acyclic. The v1 defaults are:

| Budget | Default | Charged to |
| --- | ---: | --- |
| maximum `hop_count` | 64 | output Block |
| maximum root traces joined by one Block | 16 | output Block |
| maximum committed Blocks per root trace | 4,096 | every root in `root_trace_ids` |
| maximum canonical Block bytes per root trace | 67,108,864 | every root in `root_trace_ids` |
| maximum Activations of one Module per root trace | 256 | every root represented by manifest input |
| automatic Activation token-bucket capacity per Module | 60 | Module |
| automatic Activation token-bucket refill | 1 token/second | Module |
| default maximum root-trace age | 24 hours | each root |

An instance configuration MAY lower limits. Raising a limit requires an explicit policy revision and MUST remain finite. Manual operator Activations consume rate tokens unless the operator uses a separately audited emergency override.

The resolved configuration fields are respectively `max_hops`,
`max_root_traces_per_block`, `max_trace_blocks`, `max_trace_bytes`,
`max_module_activations_per_root_trace`, `activation_bucket_capacity`,
`activation_refill_millitokens_per_second`, and `max_trace_age_ms`. The table
defaults normalize to `64`, `16`, `4096`, `67108864`, `256`, `60`, `1000`, and
`86400000`. They are persisted in `config_revision`; an Activation never reads
new limits on retry.

One automatic Activation costs exactly 1,000 millitokens. The Runtime stores
integer `credit_millitokens`, a monotonic refill anchor, and a fractional
nanosecond numerator. At a check it adds
`floor(elapsed_monotonic_ns * refill_millitokens_per_second / 1_000_000_000)`,
retains the division remainder, and clamps credit to
`1000 * activation_bucket_capacity`. Consumption and the updated credit/anchor
are committed with manifest creation. After restart, elapsed time is
reconstructed from persisted UTC using the injected Clock and clamped so a
backward jump adds no credit. This rule makes rate admission deterministic for
a recorded clock sequence.

For a Block joining several roots, the full Block count and bytes are charged once to **each** root. This conservative rule prevents fan-in from laundering an exhausted lineage into a new trace.

Trace age is measured from the persisted `created_at` of the root Block using the injected Clock. A backward wall-clock adjustment MUST NOT make a root younger than its previously observed age.

## 6. Enforcement and quarantine

Budget checks occur at two boundaries:

### 6.1 Before manifest creation

The Runtime checks Module/root Activation count, root age, and the Module token bucket. If a hard trace budget is exhausted, it MUST NOT invoke the Module. It MUST:

1. retain the candidate Deliveries;
2. quarantine the affected subscription or Module with `TRACE_BUDGET_EXCEEDED`;
3. persist the root IDs, observed counters, limit, candidate Delivery range, and graph revision; and
4. leave cursors unchanged.

Rate-token exhaustion is not quarantine. It delays manifest creation until a token is available. A configured maximum latency is an observability SLO, not permission to violate the safety rate limit; missing it MUST emit a metric and warning.

### 6.2 Before Block commit

The Runtime computes the prospective output lineage and charges. If committing would exceed a hard budget, it MUST NOT partially fan out or substitute a diagnostic Block. The Activation transitions to `quarantined`, the staged result is retained, input cursors remain unchanged, and the reason is `TRACE_BUDGET_EXCEEDED`.

Quarantine is deliberately visible and blocking. An authenticated operator MAY:

- cancel the Activation and issue audited subscription skips; or
- change the topology in a later graph revision for future Activations.

The frozen `config_revision` remains authoritative for the quarantined
Activation. A later budget increase MUST NOT authorize re-evaluation of that
Activation, and `ApplyResult` MUST NOT read current limits in place of its
frozen limits. Such a change applies only to future Manifests. An operator
action MUST NOT rewrite the frozen Manifest or pretend that the Module consumed
input it did not commit.

## 7. Trace counters

Trace counters MUST be derived from committed Runtime records, not trusted Extension reports. A per-Module/root semantic Activation count increments exactly once in the Manifest creation transaction, not on every dispatch attempt. Counter updates for an output Block occur in the same SQLite transaction as Block creation and durable fan-out.

For replay, the Runtime MUST be able to reconstruct:

- every root-to-descendant relationship;
- the exact parent set for every Block;
- the number and bytes charged to each root;
- Module Activation counts by root; and
- every limit decision and override.

Cached counters MAY be used, but a consistency check MUST compare them against durable lineage records after an unclean shutdown. A mismatch is `TRACE_COUNTER_CORRUPT` and places the instance in read-only recovery mode.

## 8. Causal properties

The Core ordering guarantees are:

1. every parent Block is committed before its child Block;
2. every input Delivery is committed before the output Block and its Deliveries;
3. all Deliveries in one manifest are ordered by global `commit_seq`;
4. all causal parents from a fan-in Activation are recorded, but Core does not claim one parent caused another; and
5. temporal adjacency or shared trace is association evidence, not a causal assertion beyond the explicit parent edge created by an Activation.

Core does not impose a total order on independent Module computations. Their committed Deliveries obtain a total observation order only when SQLite assigns `commit_seq`.

## 9. Errors

| Code | Retryable | Meaning |
| --- | ---: | --- |
| `ROUTE_GRAPH_REVISION_NOT_FOUND` | no | frozen graph snapshot is unavailable or corrupt |
| `ROUTE_DUPLICATE_EDGE` | no | graph contains the same directed edge more than once |
| `ROUTE_OUTPUT_SET_MISMATCH` | no | result or implementation attempted a different output set |
| `TRACE_ROOT_LIMIT` | no | root union exceeds the fixed configured maximum |
| `TRACE_BUDGET_EXCEEDED` | operator decision | hop, block, byte, Activation, or age budget is exhausted |
| `TRACE_RATE_DELAYED` | yes | token bucket delays automatic activation |
| `TRACE_COUNTER_CORRUPT` | no | cached and durable counters disagree |

## 10. Invariants

- **INV-ROUTING-001 — Revision isolation.** One Activation reads and writes according to one immutable graph revision.
- **INV-ROUTING-002 — Unconditional outputs.** A non-null result commits one append or lossy append reservation for every unique frozen output Page, or commits none; post-commit lossy visibility retains its declared exception.
- **INV-ROUTING-003 — No content routing.** Block content and Action targets do not alter Core Page routing.
- **INV-ROUTING-004 — Complete fan-in.** Every distinct input Block becomes a causal parent of a Module output.
- **INV-ROUTING-005 — Prior causality.** Every causal parent and Block reference is committed before its child.
- **INV-ROUTING-006 — Self-delivery allowed.** Producer equality alone never drops a Delivery.
- **INV-ROUTING-007 — Finite propagation.** Every automatic lineage is subject to finite, persisted loop and rate limits.
- **INV-ROUTING-008 — Visible stop.** Exceeding a hard loop budget quarantines evidence and leaves cursors unchanged; it never silently drops or fabricates success.

## 11. Crash expectations

| Crash point | Required recovery |
| --- | --- |
| during graph revision install | old or new complete snapshot is active |
| after manifest freezes revision, before graph update | later update does not alter the manifest |
| after graph update, before a surviving old-revision Activation commit | retained old outputs remain addressable and receive exactly the frozen old fan-out; an explicitly cancelled/fenced Activation cannot commit |
| during trace counter and Block transaction | output Block, counters, durable Deliveries, and cursor changes all appear or all roll back |
| after quarantine decision, before acknowledgement | persisted quarantine prevents automatic redispatch |

Storage requirements supporting these properties are defined in [Storage and Recovery](06-storage-and-recovery.md).
