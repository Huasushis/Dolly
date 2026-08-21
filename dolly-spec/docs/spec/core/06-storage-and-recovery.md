# Storage and Recovery

Status: normative for Dolly Core v1.

This document defines the durable boundary of Dolly Core v1, the minimum SQLite layout and constraints, atomic transactions, startup recovery, garbage-collection roots, and required behavior at each crash point.

The RFC 2119/8174 requirement-keyword convention in [Identifiers and Canonical JSON](01-identifiers-and-canonical-json.md) applies here.

## 1. Durability boundary

One Dolly instance has one authoritative Runtime SQLite database. A Core operation is durably committed only after SQLite reports a successful transaction commit under the required settings below. An in-memory cache, Extension acknowledgement, log line, lossy Page append, or provider response is not a Core commit.

The Runtime promises exactly-once **internal state commit per `activation_id`**
and one internal commit per accepted ingress or Runtime-event idempotency key
and operation digest. It does not promise exactly-once external side effects.
The external boundary is specified in
[Activation and Module](04-activation-and-module.md).

## 2. Required SQLite settings

Before writable startup, the Runtime MUST satisfy `REQ-TECH-003`, compare the
loaded SQLite runtime identity with the release attestation, and persist that
identity in diagnostic metadata. `STORAGE_UNSAFE_SQLITE_BUILD` is fail-closed:
unlike a deliberately weaker synchronous profile, it has no writable override.
The check occurs before migration, recovery writes, WAL checkpointing, or any
other instance mutation.

The Runtime MUST set and verify:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

Failure to obtain or retain these values is `STORAGE_UNSAFE_CONFIGURATION`; the Runtime MUST NOT start in writable **durable-conformance mode**. An explicitly selected unsafe performance profile MAY be writable only when the operator has enabled that named profile, every API and status surface marks the instance `UnsafeDurability`, and the implementation makes no durable-Page, power-loss, or exactly-once commit claim for that run. Such a run does not satisfy the Core durability acceptance tests.

Exactly one Runtime writer task SHOULD serialize Core write transactions. Read tasks MAY use separate read-only connections and SQLite snapshots. A process MUST hold an exclusive OS-level instance lock before opening the database for writing. A second process unable to acquire the lock MUST fail with `STORAGE_INSTANCE_LOCKED`.

Core's guarantee assumes the operating system and storage device honor durable flushes. Filesystem or hardware that falsely acknowledges flush is outside the guarantee and SHOULD be detected by deployment diagnostics.

## 3. Minimum logical schema

Physical normalization MAY differ, but a conforming database MUST enforce the equivalent keys and relationships.

| Logical table | Required key or constraint | Purpose |
| --- | --- | --- |
| `core_meta` | singleton | schema version, instance identity, clean-shutdown flag |
| `commit_sequence` | singleton `next_value` | instance-global sequence allocator |
| `commit_sequence_uses` | `commit_seq` | one cross-table ownership row for every committed use of the global sequence |
| `pages` | `page_id` | mode, limits, `next_page_seq`, tombstone revision |
| `page_sequence_uses` | `(page_id, page_seq)` | one cross-table ownership row for every durable or logical lossy Page append |
| `blocks` | `block_id`; unique non-null `producer_activation_id`; unique `creation_commit_seq` | canonical immutable envelope, body digest, creation sequence |
| `block_refs` | `(from_block_id, to_block_id, relation)` | durable Block reachability DAG |
| `block_causal_parents` | `(child_block_id, parent_block_id)` | Runtime-derived causal lineage and GC reachability |
| `block_assets` | `(block_id, asset_id, view_digest)` | durable Asset reachability |
| `deliveries` | `(page_id, page_seq)`; unique `commit_seq` | durable Page append log |
| `lossy_append_audit` | `(page_id, page_seq)`; unique `commit_seq` | non-replayable audit identity for a lossy logical append |
| `activation_outputs` | unique `(activation_id, page_id)` | prevents repeated fan-out on acknowledgement replay |
| `subscriptions` | `(page_id, module_id)` | next-uncommitted cursor and state |
| `subscription_skips` | unique skip record ID | audited cursor advance without Activation |
| `subscription_dead_letters` | `(page_id, module_id, page_seq)` | exact Delivery/Block evidence for an audited dead-letter cursor advance |
| `config_revisions` | `config_revision` | canonical immutable resolved configuration snapshots |
| `graph_revisions` | `graph_revision` | canonical immutable graph snapshots |
| `descriptor_revisions` | `(module_id, descriptor_revision)` | immutable Descriptor snapshots |
| `extension_generations` | `(extension_alias, extension_generation)` | durable Worker epoch, process/package identity, negotiated limits, Module binding, readiness, and activation-ledger continuity |
| `permission_policy_definitions` | `(policy_id, policy_revision)`; unique `definition_digest` | immutable operator-approved policy definitions without live backend authority |
| `permission_policy_bindings` | `(binding_id, binding_revision)`; unique `binding_digest`; one definition foreign key | non-secret installed-Host component selection metadata |
| `module_activation_premises` | `config_revision`; unique `premises_digest` | exact policy records and product-owned Linux service candidate for installed Linux Module startup |
| `modules` | `module_id`; unique non-null `nonterminal_activation_id`; at most one execution-slot binding | lifecycle, Module fence generation, current ownership, and pending host fence |
| `activations` | `activation_id`; at most one nonterminal per `module_id` | lifecycle, attempts, lease generation, frozen replay-contract source, one-shot next-attempt authorization, terminal result |
| `activation_manifests` | `activation_id`; unique `manifest_digest` per Activation | frozen canonical manifest bytes, complete effective configuration, and value/schema digests |
| `activation_dispatch_attempts` | primary `(activation_id, attempt)`; unique `(activation_id, lease_generation)`; non-unique Worker/Extension-generation indexes | prepared/started/response/fence evidence and exact frame/fence digests |
| `activation_replay_evidence` | primary `(activation_id, source_attempt, target_extension_generation)`; unique `evidence_digest` | immutable Host-verified activation-ledger continuity, outcome, and target-generation binding |
| `activation_results` | `(activation_id, result_digest)` | staged authoritative result and conflicting evidence |
| `runtime_event_operations` | `(runtime_source, event_key)`; unique `runtime_event_id`; unique `block_id` | trusted Runtime-event digest and replay identity |
| `trace_roots` | `root_trace_id` | root time and retained lineage |
| `trace_counters` | `(root_trace_id, counter_kind, subject)` | deterministic loop charges |
| `quarantines` | quarantine ID | reason, evidence, resolution |
| `core_journal` | unique `journal_seq` | replay and audit events |

Canonical JSON documents MUST be stored as BLOB bytes or a representation proven to round-trip to identical JCS bytes. Loading a row MUST verify its stored digest before exposing it to an Extension. For Blocks, this includes both `body_digest` and `envelope_digest`.

The database MUST use foreign keys or equivalent checks so that:

- a Delivery cannot reference an absent Block;
- a Block reference cannot reference an absent Block;
- a causal-parent edge cannot reference an absent child or parent Block, and
  the parent's `creation_commit_seq` MUST be less than the child's;
- an Activation Manifest occurrence cannot reference an absent durable Delivery or lossy append-audit identity, and a Manifest cannot reference an absent configuration revision, graph revision, source Descriptor, or mismatched source Descriptor digest; its `effective_config` and both configuration digests MUST verify against that retained revision;
- a Module's nonterminal Activation and execution-slot binding cannot reference
  an absent or differently owned Activation;
- an Activation dispatch-attempt row cannot reference an absent Activation and
  its attempt/generation tuple MUST equal one actually issued for that
  Activation;
- an activation-replay-evidence row cannot exist without its Activation and
  exact `(activation_id, source_attempt)` dispatch-attempt row; its `module_id`
  and `manifest_digest` MUST equal those frozen by that Activation, its ledger
  descriptor MUST equal the frozen replay contract byte-for-byte after JCS, and
  its target Extension generation MUST reference the
  `extension_generations` row under the Extension alias frozen for that Module
  and that row MUST retain the same Module/Extension binding;
- a permission-policy binding cannot exist without its exact definition triple,
  and an activation-premise row cannot exist without its exact configuration
  revision, complete selected definition/binding set, and verified digests;
- a committed activation output cannot exist without its Activation; and
- a durable subscription cannot reference an absent Page or Module tombstone.

## 4. Sequence allocation

`commit_sequence.next_value` is the next free positive value in the instance-global domain. Sequence values are reserved inside the same write transaction that inserts their records and their `commit_sequence_uses` ownership rows. Every ordered row MUST reference exactly one use row of the correct record kind, and no use row may be orphaned. The equivalent `page_sequence_uses` constraint spans durable Delivery and logical lossy-append tables. Rollback MAY leave no visible use of the attempted values; after a successful commit, a global or Page value MUST never be reused, including after Page mode changes.

A Block-output transaction reserves a contiguous range in this deterministic order:

1. one value for `BlockEnvelope.creation_commit_seq`;
2. one value for each frozen output Page's Delivery or logical lossy append, with all Pages sorted together by canonical `PageId`.

Pending lossy Delivery payloads are not retained in SQLite, but a non-replayable audit row containing `page_id`, `page_seq`, `commit_seq`, `block_id`, and origin is committed together with the updated Page `next_page_seq` high-water mark. This permits a deterministic trace of intended ordering while retaining declared lossy crash semantics. Recovery MUST NOT turn an audit row back into a pending Delivery.

Other Core records that require ordering, such as external ingress and audited skips, MAY consume values from the same domain. Therefore gaps between Delivery `commit_seq` values are valid; relative order is still total and stable.

## 5. Core transactions

### 5.1 Configuration and graph revision install

Before this transaction, the control plane MUST have satisfied the cutover requirements for the candidate's change class and completed every required backlog disposition. Graph-only routing changes MAY leave old frozen Activations live, in which case all referenced old objects MUST be retained. Changes requiring state/process replacement, immediate authority revocation, destructive disposition, or removal of an object that cannot be retained safely MUST quiesce and fence the applicable participants.

Every accepted configuration change inserts the complete canonical resolved configuration and advances `config_revision` in one transaction. If effective graph semantics also change, that same transaction inserts the complete canonical graph, advances `graph_revision`, and creates or drains subscriptions. A non-graph configuration change leaves the active `graph_revision` unchanged. The transaction appends its journal record and MUST NOT delete any configuration or graph snapshot referenced by a nonterminal Activation.

When the target configuration selects an installed Linux Module, that same
transaction MUST insert its one complete activation-premise record and all
referenced immutable permission-policy definition/backend-binding records.
Changing any definition, binding, installed-product origin, or service
candidate requires a new configuration revision and premise digest. Missing or
extra records abort the transaction; no later process, Ready, result,
acknowledgement, or absent record fills them.

### 5.2 External ingress

External ingress MUST carry an idempotency key scoped to the authenticated Channel or management principal. Its operation digest covers the canonical draft, the sorted unique target Page IDs, and every caller-controlled ingress option. The Runtime validates the draft and all Asset/Block references, preflights every durable target Page, then commits:

- one trusted external Block;
- all durable Delivery rows;
- lossy sequence high-water marks and non-replayable append-audit rows;
- trace counters;
- the ingress idempotency record; and
- journal events.

Inside that same commit transaction, immediately before sequence reservation,
the Runtime MUST recheck the active configuration and graph revisions, the
principal's authentication and authorization grant, the exact authorized
target set, all Block/Asset references and Action targets, and every durable
Page admission quota. A failed recheck MUST roll back without an ingress
identity or idempotency record and restart validation against one new revision
snapshot. It MUST NOT patch targets or trusted fields inside the failed
transaction.

Replay of the same ingress key and identical operation digest returns the original Block identity, even if the active graph has since changed. Replay with a different operation digest is `STORAGE_IDEMPOTENCY_CONFLICT` and MUST be quarantined.

The first accepted ingress operation receives a Runtime-assigned `IngressId`. Every Delivery created by that operation uses the same `origin.ingress_id`; retries return that identity and MUST NOT allocate another one.

An ingress idempotency key MUST contain 1 to 128 printable ASCII characters. It is opaque and case-sensitive.

### 5.3 Runtime event commit

A trusted Runtime subsystem that produces a Block MUST provide a stable
`runtime_source` QualifiedName and an event key containing 1 to 128 printable
ASCII characters. The key is opaque and case-sensitive within that source. The
operation digest covers the source, event key, canonical draft, sorted unique
target Page IDs, and every Runtime-event option. The first accepted operation
receives one Runtime-assigned `RuntimeEventId`; every Delivery uses that ID in
its Runtime origin.

The Runtime MUST validate and preflight the complete operation, then use one
SQLite transaction to recheck the active configuration and graph revisions,
source authority, exact target set, references, Action targets, and durable
Page quotas; reserve identities and sequences; insert the immutable Runtime
Block and its reachability edges; append every durable Delivery; reserve every
lossy append and audit row; charge traces; insert the idempotency record; and
append journal events. A Runtime root event has an empty causal-parent set.
Lossy in-memory appends occur only after commit under declared lossy semantics.

Replay with the same `(runtime_source, event_key)` and operation digest MUST
return the original `RuntimeEventId` and `BlockId` without another Block,
Delivery, trace charge, or Page sequence. A different digest is
`STORAGE_IDEMPOTENCY_CONFLICT`; the original operation remains authoritative
and the conflict MUST create a security incident.

### 5.4 Manifest creation

One transaction reads subscription cursors and candidate durable Deliveries from one consistent SQLite snapshot, freezes lossy candidates held under the Page lock, verifies each lossy candidate's durable append-audit identity, inserts the Activation and canonical Manifest, increments each applicable per-Module/root semantic Activation counter exactly once, and records all manifest-to-Delivery or append-audit references. It does not advance cursors.

That transaction MUST persist the inclusive `required_frame_bytes` and
`required_frame_nesting_depth` derived for the complete worst-case
`module.activate` frame. It also records the normalized replay contract and its
source `(module_id, descriptor_revision, config_revision)` as immutable cached
evidence; those cached bytes MUST verify against the retained Descriptor and
configuration and are not a second authority.

The same Manifest row MUST contain the complete Module-scoped
`effective_config`, `sha256(JCS(effective_config))`, and the digest of the closed
schema bundle that validated it. These bytes are part of the canonical Manifest
and frame-bound calculation. Retaining only `config_revision` while expecting a
replacement generation to consult mutable current configuration is
non-conforming.

If a cursor, configuration revision, graph revision, Descriptor, candidate
Delivery, or frozen gap's unreported status changed before commit, the
transaction MUST restart construction; it MUST NOT patch the already
constructed bytes. A gap created after the freeze remains eligible for the next
Manifest and does not rewrite this one.

### 5.5 Lease issue

One short transaction binds the current Worker epoch and Extension generation,
increments lease generation and attempt, records the current Module fence
generation, installs the matching Module execution-slot binding, writes a new
token hash and expiry, records dispatch state `prepared`, and transitions
`ready` or `retry_wait` to `leased`. The selected Extension generation MUST
satisfy the immutable Manifest's persisted frame byte/depth bounds. The
plaintext LeaseToken MUST NOT be stored after it
is no longer needed; a keyed hash or encrypted form MAY be stored for
verification. Issued Worker epoch, Extension generation, lease generation, and
token hashes MUST remain in audit history long enough to authenticate duplicate
or conflicting late results.

Before any request byte is eligible for transport, a second short transaction
MUST compare-and-set that exact attempt from `prepared` to `started` and store
the SHA-256 of the complete canonical frame. The sender may write only after
that commit. A response records `response_received`; host fencing records
`fenced` plus the host-evidence digest. A recovery reader treats `started` as
possibly delivered even when no socket-write evidence survived. It treats
`prepared` as not delivered only because the transport invariant forbids a
write before the marker.

For an `activation_ledger` replay, the Host MUST persist the closed canonical
record defined by
[the activation replay evidence schema](../../../schemas/activation-replay-evidence.schema.json)
before `FenceComplete` can authorize another attempt. The stored
`evidence_digest` is `sha256(JCS(record))`. Insertion MUST verify the source
attempt, frozen Manifest and replay contract, exact target generation and
ledger binding, continuity proof, state/result digests, and migration operation
when present. Reusing the same primary key with different canonical bytes or
digest is `STORAGE_IDEMPOTENCY_CONFLICT`; evidence is immutable rather than
last-writer-wins.

The `FenceComplete` transaction that selects a `complete` or `reconcilable`
record MUST atomically copy that record digest into the one-shot next-attempt
authorization. Negative, missing, corrupt, unresolved, or binding-invalid
evidence is retained for audit but MUST instead atomically quarantine the
Activation. The fence-evidence digest remains in the dispatch-attempt row and
MUST NOT be substituted for the replay-evidence digest.

### 5.6 Result staging

The first successful result under a valid fence is validated and inserted in a
dedicated transaction before result application. Inside that transaction the
Runtime MUST recheck that Module ownership, the execution-slot tuple, and the
current Module fence generation still authorize this exact Activation lease.
The transaction records canonical payload bytes, result digest, manifest
digest, Worker epoch, Extension generation, lease generation, issued LeaseToken
hash, and receive time, then transitions to `result_staged`.

This separate durable stage ensures a crash cannot cause the Runtime to invoke the Module again merely because result application had not completed.

### 5.7 Module quarantine fence

Every Module quarantine MUST be one transaction that increments the persisted
Module fence generation, revokes acceptance through the previous execution
slot, creates the Quarantine evidence, sets the Module lifecycle state, and
transitions its current nonterminal Activation to `quarantined` while retaining
its Manifest, result, and issued-fence evidence. A post-commit conflict leaves
the Activation named by the conflicting result committed but still applies
that transaction to any
different current Activation of the Module. If code may still execute, the
transaction MUST retain the physical execution-slot binding and mark a host
fence pending. A later transaction MAY clear it only after Runtime-owned
empty-slot proof or observed process exit.

### 5.8 Staged result application

The all-or-nothing transaction is:

```text
assert activation state is result_staged or commit_blocked
assert authoritative result digest and manifest digest
assert every durable cursor equals manifest cursor-span start
if result has output:
    validate BlockDraft and all references
    calculate trace lineage and budget charges
    project every durable input cursor to its frozen exclusive end
    preflight every durable output Page using the projected post-transaction
        cursor-and-candidate state from REQ-PAGE-001
    reserve Block and all output sequence values
    insert immutable Block, BlockRefPart/Asset edges, and every causal-parent edge
    insert every durable output Delivery
    insert unique activation_outputs rows
    persist lossy Page sequence high-water marks
    update trace counters
advance every durable input cursor to the frozen exclusive end
    record lossy input cursor spans and exact frozen-gap dispositions for post-commit application
mark Activation committed with authoritative digest
append journal events
COMMIT
apply lossy output appends, lossy input cursor changes, and dispositioned-gap cleanup in memory
```

If durable Page pressure prevents preflight, the Runtime sets `commit_blocked` in a separate transaction and retries this exact staged result later. It MUST NOT invoke the Module again. If a durable cursor does not equal its frozen start, the Runtime MUST roll back and then use one separate safety-stop transaction to retain the Activation in its prior `result_staged` or `commit_blocked` state, retain Module ownership of that Activation, persist tamper-evident incident evidence, and put the instance in `RecoveryRequired` with `ACTIVATION_CURSOR_CONFLICT`. Ordinary writes stop after that transaction. A crash between the suspect rollback and the safety-stop commit MUST be recovered by detecting the unchanged cursor/Manifest mismatch and completing the safety stop before ordinary writes are enabled. The Runtime MUST NOT also transition the Activation or Module to `quarantined`, because that would create a second divergent durable post-state for the same invariant failure; repair acts only through the documented RecoveryRequired workflow.

SQLite uniqueness on `blocks.producer_activation_id` and `activation_outputs` is a final exactly-once fence. A uniqueness conflict with the same stored result digest is treated as already committed. A conflict with different identities or digest is storage corruption or a result conflict, never a second output.

### 5.9 Subscription disposition

An explicit dead-letter or skip transaction verifies the expected current cursor, verifies that no nonterminal Activation freezes an overlapping span, inserts immutable disposition evidence, advances the cursor over one contiguous range, and appends a journal event. A skip MUST additionally compare `end_exclusive <= page.next_page_seq` in that same snapshot and transaction; it cannot reserve a disposition over future sequence values. It MUST NOT create a Module output or mark an Activation successful.

For dead-letter, the same transaction MUST insert one `subscription_dead_letters` record for every Delivery in the range, including its original Delivery and Block identities. Those records MUST keep the referenced Blocks reachable for at least the configured dead-letter retention period. For skip, the immutable evidence MUST identify the exact range and reviewed discard authority; no payload-retention claim is made.

## 6. Acknowledgement rule

The Runtime MUST acknowledge a durable operation only after SQLite commit returns success. If the acknowledgement is lost, replay MUST return the previously committed identity or result based on idempotency and uniqueness records.

An acknowledgement MUST distinguish:

- `committed`: SQLite transaction is durable;
- `not_committed`: the Runtime proves rollback or no transaction began; and
- `unknown`: the Runtime or caller lost contact without proof.

A caller receiving `unknown` MUST replay with the same idempotency identity. It MUST NOT mint a new semantic operation merely to discover the outcome.

## 7. Startup recovery

Startup in writable mode MUST perform this order:

1. inspect configuration read-only; when it contains an installed Linux Module,
   observe the Host platform and refuse non-Linux activation before
   acquiring or creating the instance controller lock or any writable resource;
2. acquire the exclusive instance controller lock;
3. claim and reread the exact active configuration revision under that lock;
4. open SQLite with the required PRAGMAs;
5. verify schema version and migrations;
6. run `PRAGMA quick_check` and a foreign-key check;
7. verify the instance identity and sequence bounds;
8. verify canonical digest samples and all nonterminal manifest/result digests;
9. for an installed Linux Module, load and resolve its exact
   [activation premises](../operations/04-module-activation-authority.md), verify
   the product-owned service/runtime binding, and prepare/read back the
   delegated root in the order defined there;
10. terminate or prove absence of Extension processes from the old worker epoch;
11. rebuild or verify trace counters after an unclean shutdown;
12. reconstruct Module and subscription states;
13. reset every lossy Page and record restart gaps before any recovered result
    can append new lossy output;
14. apply every `result_staged` or `commit_blocked` Activation in deterministic
    `(ManifestCreated journal_seq, activation_id)` order;
15. move every orphaned `leased` Activation through fencing to its safe
    recovered disposition with the same Manifest; and
16. for an installed Linux Module, mint and consume the one-use recovery
    handoff in installed composition; only now expose `ready` and eligible
    `retry_wait` work in deterministic
    `(ManifestCreated journal_seq, activation_id)` order.

No Extension MAY receive an Activation before steps 1–15 complete, and an
installed Linux Module cannot receive one before step 16 completes.
Recovery MUST NOT publish runnable work between configuration/premise
verification, reconstruction, lossy reset, staged application, orphan fencing,
and installed composition.

An integrity failure MUST start the instance in read-only recovery mode or refuse startup. It MUST NOT delete offending rows, reset cursors, or reconstruct canonical data from logs automatically.

## 8. Garbage collection

Garbage collection MUST be transactional mark-and-sweep or an equivalent algorithm proven safe under crashes. Reference count alone is insufficient because manifests, pins, audit holds, and Block DAG edges can change in separate transactions.

The root set includes:

- every retained durable Delivery;
- every retained subscription dead-letter record;
- every currently pending in-memory lossy Delivery while the process is alive and its Page lock is held for GC snapshotting;
- every nonterminal Activation Manifest and staged result;
- every unexpired ingress or other Core idempotency record that promises replay of a committed Block identity;
- every committed Block retained by audit policy;
- every Block reached to a fixed point by following `BlockRefPart` edges and
  child-to-parent causal edges from a rooted Block, plus every Asset reached by
  an `AssetPart` from any such Block;
- explicit Module and operator pins;
- quarantine evidence; and
- backup or legal-hold roots.

A Block body, causal parent, referenced Block, or Asset MUST NOT be deleted
while reachable from any root. The mark phase MUST traverse both
`block_refs` and `block_causal_parents` transitively before sweep. Expired pins
MUST be removed in a transaction before the next mark phase. Research hint
payloads and research-registry decisions MUST NOT affect reachability.

GC candidates SHOULD first be tombstoned, then physically removed after at least one successful subsequent GC epoch. The v1 default grace period is one hour. A crash at any point MUST leave either a valid live object or a tombstone that prevents broken references.

## 9. Crash-point matrix

| Label | Crash point | Required durable observation after restart |
| --- | --- | --- |
| `CP-01` | before manifest transaction begins | no Activation; cursors unchanged |
| `CP-02` | during manifest transaction | complete immutable manifest or no manifest |
| `CP-03` | after manifest commit, before lease | same Activation is `ready` |
| `CP-04` | after lease commit, before `started` marker | persisted lease is fenced; `prepared` proves no transport write, so the same Manifest may retry subject to its deadline/attempt limits |
| `CP-05` | after `started` marker, before any result | Core cursors remain unchanged; fence first, then the frozen `never_auto_retry`, `pure_compute`, or `activation_ledger` contract uniquely selects quarantine or same-Activation retry |
| `CP-06` | after response bytes, before result-stage commit | no authoritative result; fence first, then apply the same frozen replay-contract rule as CP-05; never infer safety from missing stage bytes |
| `CP-07` | after result-stage commit, before apply | exact staged payload is applied without Module reinvocation |
| `CP-08` | in result-apply transaction before SQLite commit | no Block, durable Delivery, cursor, trace counter, or committed state from that transaction is visible |
| `CP-09` | after SQLite commit, before Module acknowledgement | replay returns committed disposition; no duplicate Block or durable Delivery |
| `CP-10` | after durable commit, before first lossy append | durable state is complete; lossy output may be absent |
| `CP-11` | between lossy output appends | any already appended lossy item may have been observed; remaining items may be lost; no replay after restart |
| `CP-12` | during configuration/graph revision install | complete old or complete new resolved revision set is active; graph revision remains unchanged for a non-graph update |
| `CP-13` | during cursor dead-letter or skip | both complete disposition evidence and new cursor appear, or neither does |
| `CP-14` | during GC mark/tombstone/sweep | no reachable object becomes unavailable |
| `CP-15` | during a Runtime-event commit | the original Runtime Block, complete durable fan-out, lossy reservations, trace charges, and idempotency identity all appear, or none does; replay returns the original identities |

Fault-injection tests MUST exercise every labeled point.

## 10. Errors

The `outcome` column is the mandatory `DollyError.outcome` field from the
[standard Core error envelope](01-identifiers-and-canonical-json.md#7-standard-core-error-envelope);
it is part of every emitted storage error envelope.

| Code | Retryable | Outcome | Meaning |
| --- | ---: | --- | --- |
| `STORAGE_INSTANCE_LOCKED` | no | `not_applied` | another writer owns the instance |
| `STORAGE_UNSAFE_SQLITE_BUILD` | no | `not_applied` | loaded SQLite is older than 3.51.3 or does not match the release attestation |
| `STORAGE_UNSAFE_CONFIGURATION` | no | `not_applied` | required SQLite durability setting is absent |
| `STORAGE_BUSY` | yes | `not_applied` | lock contention exceeded the configured busy timeout |
| `STORAGE_FULL` | after operator action | `not_applied` | disk or quota cannot admit the transaction |
| `STORAGE_CORRUPT` | no | `not_applied` | SQLite, canonical bytes, references, or uniqueness are inconsistent |
| `STORAGE_IDEMPOTENCY_CONFLICT` | no | `not_applied` | one idempotency identity names different canonical operations |
| `STORAGE_SEQUENCE_CONFLICT` | no | `not_applied` | a supposedly unique sequence is repeated or regresses |
| `STORAGE_MIGRATION_REQUIRED` | no | `not_applied` | database schema is not supported by this binary |

`SQLITE_BUSY` and `SQLITE_FULL` MUST be translated to stable Core errors. Raw database messages MAY be logged after redaction but MUST NOT be the protocol contract.

## 11. Invariants

- **INV-STORAGE-001 — One writer.** At most one Runtime process writes one instance database.
- **INV-STORAGE-002 — Canonical persistence.** Every persisted Core value verifies against its canonical digest before use.
- **INV-STORAGE-003 — Sequence uniqueness.** No committed global or Page sequence value is reused.
- **INV-STORAGE-004 — One Activation output.** One `activation_id` commits at most one Block and at most one Delivery to each frozen output Page.
- **INV-STORAGE-005 — Atomic durable fan-out.** Output Block, all durable output Deliveries, all lossy append reservations, all durable cursor advances, trace counters, and committed Activation state appear together.
- **INV-STORAGE-006 — Staged recovery.** A persisted result is applied without another Module invocation.
- **INV-STORAGE-007 — Replay identity.** Lost acknowledgements are recovered using the same Activation or ingress idempotency identity.
- **INV-STORAGE-008 — Safe reclamation.** No reachable Block or Asset is physically removed.
- **INV-STORAGE-009 — Declared loss only.** Crash loss after SQLite commit is possible only for explicitly lossy Page state.
- **INV-STORAGE-010 — Runtime-event replay.** One Runtime-event operation key
  and digest commits at most one RuntimeEvent identity, Block, and complete
  fan-out; identical replay returns those identities.
- **INV-STORAGE-011 — Durable causality.** Every committed causal parent is an
  earlier durable Block and remains reachable while any rooted child reaches it.
- **INV-STORAGE-012 — Atomic Module quarantine.** A Module quarantine fence,
  lifecycle state, Quarantine evidence, and disposition of its current
  Activation cannot become durable in a partial combination.
- **INV-STORAGE-013 — Dispatch evidence precedes transport.** An Activation
  frame cannot cross the process boundary before its exact attempt has a
  durable `started` marker and frame digest; therefore `prepared` is safe
  evidence of no dispatch and `started` is conservative evidence of possible
  dispatch.
- **INV-STORAGE-014 — Ledger replay evidence.** An `activation_ledger`
  authorization names exactly one immutable Host-owned replay-evidence record,
  source attempt, target Extension generation, and frozen ledger descriptor;
  its digest cannot be replaced by fence evidence or a current-package claim.
- **INV-STORAGE-015 — Frozen effective configuration.** A Manifest stores and verifies the complete Module-scoped effective configuration plus its value and schema-bundle digests; redispatch never substitutes current configuration.
- **INV-STORAGE-016 — Cursor-conflict stop state.** An `ACTIVATION_CURSOR_CONFLICT` leaves the staged Activation and Module ownership unchanged while the instance enters `RecoveryRequired`.

The state-transition implementation against this storage model is specified in [Reference Abstract Machine](07-reference-abstract-machine.md).
