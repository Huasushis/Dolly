# Reference Abstract Machine

Status: normative for Dolly Core v1.

This document is the executable semantic reference for Dolly Core. An implementation MAY use actors, tasks, queues, caches, or a different database layout, but every externally observable result MUST be equivalent to a legal transition sequence of this machine.

The RFC 2119/8174 requirement-keyword convention in [Identifiers and Canonical JSON](01-identifiers-and-canonical-json.md) applies here.

The machine incorporates:

- [Identifiers and Canonical JSON](01-identifiers-and-canonical-json.md);
- [Block and Action](02-block-and-action.md);
- [Page, Delivery, and Subscription](03-page-delivery-subscription.md);
- [Activation and Module](04-activation-and-module.md);
- [Routing, Trace, and Loops](05-routing-trace-and-loops.md); and
- [Storage and Recovery](06-storage-and-recovery.md).

## 1. State

One instance state is the tuple:

```text
S = (
  instance_id,
  next_commit_seq,
  active_config_revision,
  active_graph_revision,
  Configs,
  Graphs,
  Pages,
  Blocks,
  DurableDeliveries,
  LossyQueues,
  Subscriptions,
  Modules,
  StorageWriterOwnership,
  Activations,
  ActivationReplayEvidence,
  RuntimeEventOperations,
  TraceCounters,
  Quarantines,
  Journal
)
```

Maps are keyed by the identities defined in the identifier specification. Canonical map iteration is bytewise ascending key order.

### 1.1 Page state

```text
PageState = (
  page_id,
  mode: durable | lossy,
  next_page_seq,
  limits,
  tombstone_revision?
)
```

For a durable Page, its Delivery sequence is in `DurableDeliveries`. For a lossy Page, pending records are in `LossyQueues`; only sequence high-water marks are durable.

### 1.2 Subscription state

```text
SubscriptionState = (
  page_id,
  module_id,
  cursor,              // next uncommitted page_seq
  status,
  gap_log
)
```

### 1.3 Module state

```text
ModuleState = (
  module_id,
  storage_scope_id,
  lifecycle_state,
  descriptor_revision,
  nonterminal_activation_id?,
  module_fence_generation,
  execution_slot?,          // activation_id, worker_epoch, extension_generation, lease_generation
  host_fence_pending,
  activation_rate_bucket,
  administrative_pause_pending,
  input_eligibility?       // persisted first/last arrival and eligible wall/monotonic deadlines
)
```

`StorageWriterOwnership` is keyed by `storage_scope_id` and stores
`state: unowned | granted | releasing | released | write_fenced_unknown`, the
last positive `writer_generation`, and an optional owner tuple of Worker epoch,
Extension alias/generation, Module ID, and capability digest. A staging handle
is bound to a distinct non-authoritative backing object and never appears as
the active owner.

### 1.4 Activation state

```text
ActivationState = (
  activation_id,
  module_id,
  canonical_manifest,
  manifest_digest,
  frozen_replay_contract,       // cached value plus descriptor/config source revisions
  dispatch_evidence,            // attempt -> prepared/started/response_received/fenced evidence
  next_attempt_authorization?,  // closed one-shot object bound to source/authorized attempts and evidence digest
  state,
  attempt,
  worker_epoch?,
  extension_generation?,
  lease_generation,
  module_fence_generation_at_lease?,
  current_lease_token_hash?,
  issued_fence_evidence,
  execution_deadline_wall?,
  execution_deadline_monotonic?,
  lease_expiry_wall?,
  lease_expiry_monotonic?,
  fencing_deadline_wall?,
  fencing_deadline_monotonic?,
  retry_delay_ms?,
  retry_not_before_wall?,
  retry_not_before_monotonic?,
  authoritative_result?,
  authoritative_result_digest?,
  committed_block_id?,
  last_error?
)
```

An Activation's canonical manifest is immutable after insertion.

`ActivationReplayEvidence` is keyed by
`(activation_id, source_attempt, target_extension_generation)`. Each value is
an immutable pair of `canonical_record` and `evidence_digest`; the record is
the Host-owned object defined by the
[activation replay evidence schema](../../../schemas/activation-replay-evidence.schema.json),
and the digest is its computed `sha256(JCS(record))`. It is not an Extension
assertion.

## 2. Environment inputs

The abstract machine receives these explicit environment inputs:

- authenticated management and ingress requests;
- Extension transport events and process-exit observations;
- injected wall and monotonic Clock readings;
- injected cryptographic UUID and token bytes;
- injected retry-jitter samples;
- authenticated Host verifier outputs for activation-ledger continuity and
  outcome state;
- authenticated Host/broker/backend observations that an exact Module storage
  writer generation was revoked, fenced, or remains uncertain;
- Host-service completion events whose service-owned ledger, frozen adapter
  version, and dispatch disposition have already passed the applicable service
  state machine; Core never infers an MCP version or converts a version-foreign
  Tool continuation into an Activation retry;
- SQLite transaction success or a classified storage error; and
- operator quarantine decisions.

Replay MUST record enough of these inputs to reproduce all decisions. Given the same initial durable state and the same ordered input tape, the machine MUST produce identical canonical manifests, digests, state transitions, sequence assignments, and durable journal events. Secret LeaseToken bytes MAY be replaced by deterministic test tokens in a replay environment.

## 3. General transition rule

Every transition has:

1. a precondition evaluated against one state snapshot;
2. zero or one durable SQLite transaction;
3. a deterministic post-state if that transaction commits;
4. a stable error and no durable post-state if it rolls back; and
5. a journal event for every successful durable semantic change.

An implementation MUST NOT expose a post-state before its transaction commits.

## 4. Transition table

| Transition | Required pre-state | Success post-state | Failure post-state |
| --- | --- | --- | --- |
| `InstallConfig` | valid non-graph candidate, current config revision `C`, cutover preconditions satisfied | complete config revision `C+1` active; graph unchanged | unchanged |
| `InstallGraph` | valid config/graph candidates, current revisions `C`/`R`, cutover preconditions satisfied | complete config `C+1` and graph `R+1` active | unchanged |
| `Ingress` | idempotency key unused or identical | Block and all durable target Deliveries committed | unchanged |
| `RuntimeEvent` | trusted Runtime source; idempotency key unused or identical | Runtime Block and all durable target Deliveries committed | unchanged |
| `GrantStorageWriter` | scope is `unowned` or `released`; no live prior owner; next generation available | one active owner at the next writer generation | unchanged or `write_fenced_unknown` when prior release cannot be proved |
| `ReleaseStorageWriter` | exact current owner and generation; Module fenced from new work | `releasing`, then `released` only after broker/backend/process proof | `write_fenced_unknown` |
| `BuildManifest` | Module `idle`, input or wake reason eligible | immutable Activation `ready`; Module `waiting` and owns nonterminal ID | unchanged or delayed |
| `IssueLease` | Activation `ready` or `retry_wait`; Module execution slot empty | Activation `leased`; Module `running` | unchanged, or quarantine when Manifest deadline elapsed |
| `DispatchLease` | Activation `leased`; exact attempt `prepared`; bound generation compatible | exact frame digest durably marked `started`, then frame becomes transport-eligible | unchanged; no bytes written |
| `ReceiveResult(success)` | current valid lease | authoritative result `result_staged` | unchanged or quarantine |
| `ReceiveResult(retryable)` | current valid lease | `retry_wait`, or `quarantined` when attempts exhausted; cursor unchanged | unchanged |
| `ReceiveResult(permanent)` | current valid lease | Activation and Module `quarantined` | unchanged |
| `BeginFence` | lease timed out or transport outcome unknown | Activation and Module `fencing` | unchanged |
| `RecordReplayEvidence` | Activation `fencing`; frozen contract is `activation_ledger`; Host verifier output available | one immutable target-generation-bound replay-evidence record | unchanged on invalid input or idempotency conflict |
| `FenceComplete` | execution slot proven empty | `retry_wait`, or `cancelled` if authorized | quarantine if proof fails |
| `ApplyResult` | `result_staged` or `commit_blocked` | Activation `committed`; Module `idle` | `commit_blocked`, unchanged, or quarantine |
| `CancelActivation` | never dispatched, or execution successfully fenced | Activation `cancelled`; Module ownership cleared | unchanged |
| `ResolveQuarantine` | authenticated reviewed decision | original authoritative path resumed, or cancelled | unchanged |
| `CompleteQuarantineFence` | quarantined Module has a pending host fence | execution slot proven empty and cleared; Module remains quarantined | unchanged |
| `DeadLetterRange` | authenticated policy, expected cursor matches | cursor advanced with exact retained Delivery/Block evidence | unchanged |
| `SkipRange` | authenticated policy, expected cursor matches | cursor advanced with skip evidence | unchanged |
| `LossyEvict` | lossy queue exceeds a limit | oldest prefix removed; gaps recorded | not applicable |
| `Recover` | instance lock held; integrity valid | deterministic recovered runnable state | read-only or refused startup |

## 5. Transition pseudocode

Pseudocode uses `atomic { ... }` for one Runtime SQLite transaction. `require`
failure causes no state change. `owned_wait_state(M)` is `paused` when a durable
administrative pause is pending for a Module that still owns a nonterminal
Activation, and `waiting` otherwise. `frozen_activation_config(A)` means the
Module activation object and instance limits in
`Configs[A.manifest.config_revision]`; it never means the current
configuration. `frozen_replay_contract(A)` is the normalized contract cached
at Manifest creation and verified against the own Descriptor revision and
resolved configuration named by that Manifest; current Descriptor/package
state cannot increase it. `generation_can_carry(G, A)` means G is Ready for
the Module, its effective frame byte/depth limits meet both immutable Manifest
bounds, Host package verification proves that it can validate and execute
`A.manifest.effective_config_schema_digest`, Host verification proves it can
load every retained schema bundle and semantic-validator revision in an input
Action `contract_binding` targeted to `A.module_id`, and, for
`activation_ledger`, it is bound to the exact retained or atomically migrated
ledger namespace/schema version.

`valid_replay_evidence(record, A, G)` means all of the following are true:
the record validates against the closed activation-replay-evidence schema; it
was produced by the authenticated Host verifier; its `module_id`,
`storage_scope_id`, `activation_id`, `manifest_digest`, `source_attempt`, and
`target_extension_generation` exactly equal `A.module_id`,
`Modules[A.module_id].storage_scope_id`, `A.activation_id`,
`A.manifest_digest`, `A.attempt`, and `G.generation`; G's accepted
activation-ledger continuity binding names that same Module and storage scope;
its JCS-normalized `ledger` is byte-identical to the descriptor in
`frozen_replay_contract(A)`; its retained-state or migration continuity proof
and every named state, result, and migration digest verify against durable
Host observations; and its state/disposition/nullability combination is legal
under that schema. `replay_evidence_digest(record)` is exactly
`sha256(JCS(record))`. Neither an Extension-supplied assertion nor the ordinary
host-fence digest satisfies this predicate.

`current_execution_fence(M, A, envelope)` means all of the following are true
in the same state snapshot: `A.state` is `leased`; the
Activation ID, Manifest digest, Worker epoch, Extension generation, lease
generation, and LeaseToken hash all match `A`; `M.nonterminal_activation_id`
equals `A.activation_id`; `M.lifecycle_state` is `running`;
`M.host_fence_pending` is false; `M.execution_slot` equals
`(A.activation_id, envelope.worker_epoch, envelope.extension_generation,
envelope.lease_generation)`; and `M.module_fence_generation` equals
`A.module_fence_generation_at_lease`.

`quarantine_module(M, reason, cause, expected_execution_fence?)` is one atomic
transaction. When an expected fence is supplied, it first rechecks that fence.
It increments `M.module_fence_generation`, revokes result acceptance through
the old slot, retains bounded redacted evidence, sets `M.lifecycle_state` to
`quarantined`, clears `next_attempt_authorization` on every Activation it
dispositions, and journals the reason. If `M.nonterminal_activation_id` names
an Activation, that current Activation becomes `quarantined` with its Manifest,
authoritative result, and issued-fence evidence retained. If an execution slot
still may be live, the transaction leaves the physical slot binding in place
and sets `M.host_fence_pending = true`; after commit the Runtime requests
cancellation and obtains host-owned empty-slot proof or terminates the process.
Only `CompleteQuarantineFence` may then clear that slot. When `cause` is a
different already committed Activation, its state remains `committed` and a
separate post-commit Quarantine record is created, while the current
nonterminal Activation is still dispositioned as above.

When the cause is bytes received under an authenticated current execution
fence, the same transaction first records that attempt as
`response_received`, preserving its `transport_started` flag and frame digest.
No invalid or permanent response can leave dispatch evidence looking merely
`prepared` or `started`.

### 5.1 InstallConfig and InstallGraph

```text
InstallConfig(candidate_config, cutover_evidence):
  C := S.active_config_revision
  validate complete resolved configuration and finite limits
  require candidate_config.revision == C + 1
  require candidate_config has no effective graph change
  require control-plane cutover preconditions for cutover_evidence.change_class are satisfied
  canonical_config := JCS(candidate_config)
  atomic {
    insert Configs[C + 1] = canonical_config
    S.active_config_revision = C + 1
    Journal += ConfigInstalled(C + 1, sha256(canonical_config), S.active_graph_revision)
  }

InstallGraph(candidate_config, candidate_graph, cutover_evidence):
  C := S.active_config_revision
  R := S.active_graph_revision
  validate complete resolved configuration, identifiers, Pages, Modules, unique edges, and finite limits
  require candidate_config.revision == C + 1
  require candidate_graph.revision == R + 1
  require control-plane cutover preconditions for cutover_evidence.change_class are satisfied
  if cutover_evidence leaves old Activations live for a graph-only route change:
    require every object referenced by their frozen Manifests is retained
  if cutover_evidence says the change replaces state/process, revokes authority, is destructive, or cannot retain an old object:
    require applicable participants are quiesced and fenced
  require every removed object can enter draining/tombstone state
  require every stranded durable range has an exact completed approved disposition
  canonical_config := JCS(candidate_config)
  canonical_graph := JCS(candidate_graph)
  atomic {
    insert Configs[C + 1] = canonical_config
    insert Graphs[R + 1] = canonical_graph
    create new subscriptions with explicit/default start cursors
    mark removed subscriptions draining
    S.active_config_revision = C + 1
    S.active_graph_revision = R + 1
    Journal += GraphInstalled(C + 1, R + 1, sha256(canonical_config), sha256(canonical_graph))
  }
```

### 5.2 Ingress

```text
Ingress(principal, ingress_key, draft, target_pages):
  operation_digest := sha256(JCS({draft, sorted_unique_target_page_ids, caller_options}))
  if existing ingress_key:
    require existing operation_digest == operation_digest
    return existing BlockId
  validate BlockDraft and local references
  R := S.active_graph_revision
  C := S.active_config_revision
  validate the predicted committed BlockEnvelope under Configs[C], including canonical semantic depth
  pages := unique target_pages sorted by PageId
  require every page exists in Graphs[R]
  preflight all durable pages
  ids := generate trusted Ingress, Block, Action, and Trace IDs
  atomic {
    require S.active_graph_revision == R and S.active_config_revision == C
    require ingress_key is still unused; if an identical operation won the race, roll back and replay it
    recheck principal authentication, authorization, and current grant under Graphs[R] and Configs[C]
    require pages are still exactly the sorted unique authorized target set and every page exists in Graphs[R]
    revalidate the predicted committed BlockEnvelope, all local references, and every frozen-graph Action target under Configs[C]
    recheck every durable target Page quota and admission limit
    reserve one creation commit_seq and one commit_seq per target page
    construct immutable external Block
    insert Block and reachability edges
    append every durable Delivery
    advance lossy Page sequence high-water marks and insert non-replayable append-audit rows
    update trace counters
    record ingress_key -> (operation_digest, IngressId, BlockId)
    Journal += IngressCommitted(...)
  }
  append to every lossy queue in sorted Page order, applying LossyEvict
  return BlockId
```

If any revision, authorization, target, reference, or quota recheck fails, the
transaction creates no identity or idempotency record. The caller MUST restart
the operation from validation against one new `(R, C)` snapshot; it MUST NOT
patch the draft or target set inside the failed transaction.

### 5.3 RuntimeEvent

```text
RuntimeEvent(runtime_source, event_key, draft, target_pages, runtime_options):
  require runtime_source is a trusted Runtime subsystem QualifiedName
  require event_key is 1..128 printable ASCII characters
  pages := unique target_pages sorted by PageId
  operation_digest := sha256(JCS({runtime_source, event_key, draft, pages, runtime_options}))
  if RuntimeEventOperations[(runtime_source, event_key)] exists:
    require existing operation_digest == operation_digest
    return existing (RuntimeEventId, BlockId)
  R := S.active_graph_revision
  C := S.active_config_revision
  validate the predicted immutable Runtime Block, local references, and authorized pages under Graphs[R] and Configs[C]
  require causal_parents is empty
  preflight every durable target Page
  ids := generate trusted RuntimeEvent, Block, Action, and Trace IDs
  atomic {
    require S.active_graph_revision == R and S.active_config_revision == C
    require the operation key is still unused; if an identical operation won the race, roll back and replay it
    recheck runtime_source authority, exact target set, all references, Action targets, and every durable Page quota
    reserve one Block creation commit_seq and one commit_seq per target Page
    construct one immutable Block with producer.kind = runtime and causal_parents = []
    insert Block plus BlockRefPart and Asset reachability edges
    append every durable Delivery with origin.runtime_event_id = RuntimeEventId
    advance lossy Page sequence high-water marks and insert non-replayable append-audit rows with the same origin
    update trace counters
    RuntimeEventOperations[(runtime_source, event_key)] = (operation_digest, RuntimeEventId, BlockId)
    Journal += RuntimeEventCommitted(...)
  }
  append to every lossy queue in sorted Page order, applying LossyEvict
  return (RuntimeEventId, BlockId)
```

An identical replay returns the original identities without another Block or
Delivery. A different operation digest under the same key is
`STORAGE_IDEMPOTENCY_CONFLICT`, creates a security incident, and MUST NOT alter
the original operation.

### 5.4 BuildManifest

```text
BuildManifest(module_id, reason):
  M := Modules[module_id]
  require M.lifecycle_state == idle
  require M.nonterminal_activation_id is absent
  R := S.active_graph_revision
  C := S.active_config_revision
  cfg := Configs[C]
  require count(nonterminal Activations) < cfg.limits.max_pending_activations; otherwise delay with ACTIVATION_CAPACITY_DELAYED
  if reason == input:
    require M.input_eligibility exists
    require its persisted/reconstructed debounce or max-wait eligibility deadline is reached by Clock.monotonic
  require one automatic rate token is available unless an audited override applies
  candidates := []
  gaps := []
  for P in Graphs[R].input_pages(M), sorted by PageId:
    Sub := Subscriptions[(P, M)]
    require Sub.status == active
    candidates += contiguous available Delivery prefix beginning at Sub.cursor
    gaps += declared lossy gaps at the prefix boundary
  ordered := candidates sorted by (commit_seq, page_id, page_seq)
  if reason == input:
    require ordered is nonempty or gaps contains at least one unreported LossyGap
  selected := longest global prefix within cfg manifest limits, semantic-depth limits,
              and the complete module.activate byte/frame-depth limits, reserving
              worst-case lexical widths for every allowed retry envelope
  require selection is a prefix for each Page
  check root age and per-Module/root Activation budgets
  manifest := freeze(
    new ActivationId,
    M,
    reason,
    R,
    C and exactly the Descriptor revisions pinned by Graphs[R],
    effective_config := complete Module-scoped Configs[C] effective value,
    effective_config_digest := sha256(JCS(effective_config)),
    effective_config_schema_digest := retained closed schema-bundle digest,
    grouped selected occurrences,
    cursor spans,
    gaps,
    sorted unique Graphs[R].output_pages(M),
    one authorized projection wrapper per deduplicated neighbor, with verified
      source Descriptor digest and graph-derived relationship labels,
    required_frame_bytes := inclusive worst-case complete request byte bound,
    required_frame_nesting_depth := inclusive complete-frame depth bound,
    deadline := Clock.wall + cfg.modules[module_id].activation.execution_timeout_ms
  )
  atomic {
    recheck active configuration/graph revisions, every graph-pinned Descriptor
      revision/digest, effective-config bytes/schema digest, every durable cursor,
      selected Delivery identity, and that every frozen gap is still unreported
    consume and persist one automatic rate token unless the audited override applies
    insert canonical manifest and digest in state ready
    cache normalized frozen_replay_contract with its Descriptor/config source revisions
    initialize dispatch_evidence empty and next_attempt_authorization absent
    increment each applicable per-Module/root semantic Activation counter once
    M.nonterminal_activation_id = manifest.activation_id
    M.lifecycle_state = waiting
    clear or recompute M.input_eligibility from the first Delivery or gap not frozen in this Manifest
    Journal += ManifestCreated(...)
  }
```

An inputless Module MAY build a manifest only for an explicit timer,
background-ready, or manual reason. It MUST NOT spin by repeatedly constructing
empty `input` manifests. A Manifest containing at least one previously
unreported `LossyGap` is not empty for this rule and MAY contain no
`input_items` or `cursor_spans`; committing it dispositions the exact gap and
prevents repeated gap-only construction.

### 5.5 IssueLease

```text
IssueLease(A):
  M := Modules[A.module_id]
  require A.state in {ready, retry_wait}
  require M.lifecycle_state == waiting
  require M.nonterminal_activation_id == A.activation_id
  require M.execution_slot is absent and M.host_fence_pending == false
  cfg := frozen_activation_config(A)
  if A.state == retry_wait:
    require deadline_remaining(A.retry_not_before_wall, Clock.wall, Clock.monotonic) <= 0
    require A.next_attempt_authorization exists
  authorized_target := absent
  if A.next_attempt_authorization exists:
    auth := A.next_attempt_authorization
    require auth.source_attempt == A.attempt
    require auth.authorized_attempt == A.attempt + 1 without integer overflow
    require auth.reason in {safe_before_dispatch, explicit_retryable_failure, pure_compute, activation_ledger, operator_review}
    source_dispatch := A.dispatch_evidence[auth.source_attempt]
    match auth.reason:
      safe_before_dispatch:
        require source_dispatch.state == fenced and source_dispatch.transport_started == false
        require source_dispatch.fence_evidence_digest == auth.evidence_digest
      explicit_retryable_failure:
        response := the persisted canonical validated response for (A.activation_id, auth.source_attempt)
        require source_dispatch.state == response_received and source_dispatch.transport_started == true
        require response.status == retryable_failure and response.error.retryable == true
        require response.result_digest == auth.evidence_digest
      pure_compute:
        require frozen_replay_contract(A) == (fenced_replay, pure_compute, ledger=null)
        require source_dispatch.state == fenced and source_dispatch.transport_started == true
        require source_dispatch.fence_evidence_digest == auth.evidence_digest
        require the persisted Host effect-audit for the fenced attempt positively records no Host-service, network, Extension-ledger, or other external-effect path
      activation_ledger:
        require frozen_replay_contract(A).mode == fenced_replay
        require frozen_replay_contract(A).evidence == activation_ledger
        entry := the unique durable ActivationReplayEvidence value whose evidence_digest equals auth.evidence_digest
        require entry exists
        record := parse and schema-validate entry.canonical_record
        require replay_evidence_digest(record) == entry.evidence_digest
        require record.activation_id == A.activation_id and record.source_attempt == auth.source_attempt
        G_record := the durable Extension generation named by record.target_extension_generation
        require valid_replay_evidence(record, A, G_record)
        require (record.ledger_state, record.replay_disposition) in {(complete, return_result), (reconcilable, reconcile_only)}
        if record.ledger_state == complete:
          require the ledger's retained canonical result exists and hashes to record.result_digest
          grant only return_existing_result scope for that exact result
        else:
          require record.ledger_state == reconcilable and record.result_digest is null
          grant only reconcile_existing_effect scope for the intent identified by record.state_digest
        authorized_target := G_record
      operator_review:
        decision := the unique persisted reviewed quarantine decision whose digest equals auth.evidence_digest
        require decision exists and authorizes exactly (A.activation_id, auth.source_attempt, auth.authorized_attempt)
        require decision cites the current Module fence generation and every quarantine whose authority it lifts
  manifest_remaining := deadline_remaining(A.manifest.deadline, Clock.wall, Clock.monotonic)
  if manifest_remaining <= 0:
    quarantine_module(M, ACTIVATION_DEADLINE_EXCEEDED, A)
    return
  G := authorized_target if present, otherwise one current Ready Extension generation for M
  if G's frame byte/depth limits do not meet A.manifest's bounds:
    return ACTIVATION_FRAME_INCOMPATIBLE without changing A, M, attempt, or lease generation
  if G cannot execute A.manifest's effective-config schema/value or a targeted
     input Action's creation-time contract binding:
    return ACTIVATION_CONTEXT_INCOMPATIBLE without changing A, M, attempt, or lease generation
  if G lacks the exact activation-ledger continuity required by A's frozen replay contract:
    return ACTIVATION_REPLAY_NOT_AUTHORIZED without changing A, M, attempt, or lease generation
  require generation_can_carry(G, A)
  lease_token := random 32 bytes
  atomic {
    recheck A is dispatchable, M owns A, M has no execution slot or pending host fence, the exact one-shot authorization and all reason-specific evidence above are still valid, G is still the authorized target when one was bound, and generation_can_carry(G, A)
    A.worker_epoch = current Runtime Worker epoch
    A.extension_generation = G.generation
    A.lease_generation += 1
    A.attempt += 1
    A.module_fence_generation_at_lease = M.module_fence_generation
    A.current_lease_token_hash = hash(lease_token)
    execution_budget = min(cfg.execution_timeout_ms, manifest_remaining)
    A.execution_deadline_wall = Clock.wall + execution_budget
    A.execution_deadline_monotonic = Clock.monotonic + execution_budget
    A.lease_expiry_wall = A.execution_deadline_wall + cfg.lease_grace_ms
    A.lease_expiry_monotonic = Clock.monotonic + (A.lease_expiry_wall - Clock.wall)
    A.dispatch_evidence[A.attempt] = (state=prepared, transport_started=false, frame_digest=null, fence_evidence_digest=null)
    A.next_attempt_authorization = absent
    A.state = leased
    M.execution_slot = (A.activation_id, A.worker_epoch, A.extension_generation, A.lease_generation)
    M.lifecycle_state = running
    Journal += LeaseIssued(A.activation_id, A.worker_epoch, A.extension_generation, A.lease_generation, A.attempt)
  }

DispatchLease(A, lease_token):
  require A.state == leased and current Module execution fence matches A
  require A.dispatch_evidence[A.attempt].state == prepared
  G := the bound authenticated Extension generation
  require generation_can_carry(G, A)
  frame := exact canonical module.activate request containing the immutable Manifest and current lease envelope
  require byte_length(frame) <= A.manifest.required_frame_bytes
  require complete_frame_depth(frame) <= A.manifest.required_frame_nesting_depth
  atomic {
    recheck the same lease, prepared evidence, generation compatibility, and frame digest inputs
    A.dispatch_evidence[A.attempt] = (state=started, transport_started=true, frame_digest=sha256(frame), fence_evidence_digest=null)
    Journal += ActivationDispatchStarted(A.activation_id, A.attempt, sha256(frame))
  }
  only after commit, make frame bytes eligible for transport
```

When `A.execution_deadline_monotonic` is reached, the Host requests
cancellation but keeps the current fence authoritative for bounded response
transport until `A.lease_expiry_monotonic`. It MUST NOT authorize new Extension
work in that interval. If no valid result has staged by lease expiry, the next
transition is `BeginFence`; `IssueLease` is not legal until `FenceComplete`.

### 5.6 ReceiveResult

```text
ReceiveResult(envelope):
  A := Activations[envelope.activation_id]
  M := Modules[A.module_id]
  require authenticated Extension connection for A.module_id
  require envelope.worker_epoch and envelope.extension_generation match the connection binding
  require envelope.manifest_digest == A.manifest_digest

  if A.authoritative_result_digest exists:
    require (envelope.worker_epoch, envelope.extension_generation, envelope.lease_generation, hash(envelope.lease_token)) matches retained issued-generation evidence
    if the closed result schema, canonical JSON profile, or declared payload digest is invalid:
      quarantine_module(M, ACTIVATION_INVALID_RESULT or ACTIVATION_RESULT_DIGEST_MISMATCH, A)
      retain bounded redacted invalid-result evidence
      return ACTIVATION_INVALID_RESULT or ACTIVATION_RESULT_DIGEST_MISMATCH
    if envelope.result_digest == A.authoritative_result_digest:
      return existing disposition
    quarantine_module(M, ACTIVATION_RESULT_CONFLICT, A)
    retain both payloads; preserve A as committed when it was already committed
    return conflict

  require current monotonic time is before A.lease_expiry_monotonic
  require current_execution_fence(M, A, envelope)
  if the closed result schema, canonical JSON profile, or declared payload digest is invalid:
    quarantine_module(M, ACTIVATION_INVALID_RESULT or ACTIVATION_RESULT_DIGEST_MISMATCH, A, current_execution_fence(M, A, envelope))
    return ACTIVATION_INVALID_RESULT or ACTIVATION_RESULT_DIGEST_MISMATCH
  cfg := frozen_activation_config(A)

  match envelope.payload.status:
    retryable_failure:
      require output is null
      require scheduling_hint is null, error is present, and error.retryable == true
      if A.attempt >= cfg.max_attempts:
        quarantine_module(M, ACTIVATION_RETRY_EXHAUSTED, A, current_execution_fence(M, A, envelope))
      else:
        retry_delay := full_jitter(cfg.retry_base_ms, cfg.retry_cap_ms, A.attempt)
        atomic recheck current_execution_fence(M, A, envelope); persist the canonical validated retryable_failure payload and result digest as source-response evidence; set current dispatch evidence to response_received; clear current lease; persist retry delay and wall/monotonic retry-not-before deadlines; set A.next_attempt_authorization = {authorized_attempt:A.attempt+1, source_attempt:A.attempt, reason:explicit_retryable_failure, evidence_digest:envelope.result_digest}; set A.state = retry_wait; M.lifecycle_state = owned_wait_state(M); clear M.execution_slot; Journal += ActivationRetryScheduled(...)
    permanent_failure:
      require output is null
      require scheduling_hint is null, error is present, and error.retryable == false
      quarantine_module(M, the permanent failure, A, current_execution_fence(M, A, envelope))
    success:
      require error is null
      validation := completely validate BlockDraft, quotas, frozen-graph Action targets, and local references
      if validation fails:
        quarantine_module(M, ACTIVATION_INVALID_RESULT, A, current_execution_fence(M, A, envelope))
        return
      atomic {
        require current_execution_fence(M, A, envelope)
        insert authoritative canonical payload and digest
        set current dispatch evidence to response_received while preserving its frame digest
        retain every referenced Block and Asset as a staged-result GC root
        A.state = result_staged
        clear current lease while retaining Worker epoch, Extension generation, lease generation, and token-hash audit evidence
        M.lifecycle_state = owned_wait_state(M)
        clear M.execution_slot but retain Module nonterminal ownership
        Journal += ResultStaged(...)
      }
```

### 5.7 BeginFence, FenceComplete, and CompleteQuarantineFence

```text
BeginFence(A, reason):
  M := Modules[A.module_id]
  require A.state == leased
  require M.execution_slot names A
  cfg := frozen_activation_config(A)
  atomic {
    A.state = fencing
    M.module_fence_generation += 1
    M.host_fence_pending = true
    M.lifecycle_state = fencing
    A.fencing_deadline_wall = Clock.wall + cfg.fencing_grace_ms
    A.fencing_deadline_monotonic = Clock.monotonic + cfg.fencing_grace_ms
    Journal += ActivationFencingStarted(A.activation_id, reason)
  }
  request authenticated cancellation
  if no host-owned empty-slot proof exists by the fencing deadline:
    terminate the hosting Extension process

RecordReplayEvidence(A, G, record):
  require A.state == fencing and A.dispatch_evidence[A.attempt].transport_started == true
  require frozen_replay_contract(A).mode == fenced_replay
  require frozen_replay_contract(A).evidence == activation_ledger
  require G is the proposed durable target Extension generation for A.module_id
  require record came from the authenticated Host ledger verifier, not the Extension
  require valid_replay_evidence(record, A, G)
  digest := replay_evidence_digest(record)
  key := (A.activation_id, A.attempt, G.generation)
  atomic {
    recheck A, its frozen Manifest/contract, source dispatch attempt, G, and every Host verification input
    if ActivationReplayEvidence[key] exists:
      require its (canonical_record, evidence_digest) equals (JCS(record), digest); otherwise return STORAGE_IDEMPOTENCY_CONFLICT and record a security incident
      return the existing digest
    ActivationReplayEvidence[key] = (canonical_record=JCS(record), evidence_digest=digest)
    Journal += ActivationReplayEvidenceRecorded(A.activation_id, A.attempt, G.generation, record.ledger_state, record.replay_disposition, digest)
  }

FenceComplete(A, evidence):
  M := Modules[A.module_id]
  require A.state == fencing
  require M.execution_slot names A and M.host_fence_pending == true
  require evidence is Runtime-owned host fencing proof or observed Extension process exit
  cfg := frozen_activation_config(A)
  dispatch := A.dispatch_evidence[A.attempt]
  contract := frozen_replay_contract(A)
  if an authorized cancellation decision is already recorded:
    disposition := cancel
  else if dispatch.transport_started == false:
    disposition := retry(safe_before_dispatch, evidence.digest, replay_scope=none)
  else if contract == (never_auto_retry, none, ledger=null):
    disposition := quarantine(ACTIVATION_REPLAY_NOT_AUTHORIZED)
  else if contract == (fenced_replay, pure_compute, ledger=null):
    if Host-service, network, Extension-ledger, or other effect evidence exists:
      disposition := quarantine(ACTIVATION_REPLAY_CONTRACT_VIOLATION)
    else:
      disposition := retry(pure_compute, evidence.digest, replay_scope=none)
  else if contract.evidence == activation_ledger:
    G_target := the one current Ready target generation selected by the deterministic scheduler for M
    entry := ActivationReplayEvidence[(A.activation_id, A.attempt, G_target.generation)] if that exact entry exists
    if entry is absent:
      disposition := quarantine(ACTIVATION_EXTERNAL_OUTCOME_UNKNOWN)
    else if entry.canonical_record cannot be parsed and schema-validated:
      disposition := quarantine(ACTIVATION_REPLAY_CONTRACT_VIOLATION)
    else:
      record := parsed entry.canonical_record
      if replay_evidence_digest(record) != entry.evidence_digest or not valid_replay_evidence(record, A, G_target):
        disposition := quarantine(ACTIVATION_REPLAY_CONTRACT_VIOLATION)
      else if record.ledger_state in {absent, unknown, corrupt} or record.replay_disposition == quarantine:
        disposition := quarantine(ACTIVATION_EXTERNAL_OUTCOME_UNKNOWN)
      else if (record.ledger_state, record.replay_disposition) == (complete, return_result):
        disposition := retry(activation_ledger, entry.evidence_digest, replay_scope=return_result)
      else if (record.ledger_state, record.replay_disposition) == (reconcilable, reconcile_only):
        disposition := retry(activation_ledger, entry.evidence_digest, replay_scope=reconcile_only)
      else:
        disposition := quarantine(ACTIVATION_EXTERNAL_OUTCOME_UNKNOWN)
  if disposition is retry(authorization, authorization_digest, replay_scope) and A.attempt >= cfg.max_attempts:
    disposition := quarantine(ACTIVATION_RETRY_EXHAUSTED)
  else if disposition is retry(authorization, authorization_digest, replay_scope):
    retry_delay := full_jitter(cfg.retry_base_ms, cfg.retry_cap_ms, A.attempt)
    disposition := retry(authorization, authorization_digest, replay_scope, retry_delay)
  atomic {
    recheck the same slot, fence evidence, frozen contract, selected target generation, Host effect audit or exact immutable replay-evidence record and digest, and all disposition inputs
    retain evidence in A.issued_fence_evidence
    set current dispatch evidence state = fenced and fence_evidence_digest = evidence.digest, preserving transport_started and frame_digest
    clear current lease and M.execution_slot
    M.host_fence_pending = false
    if disposition == cancel:
      A.state = cancelled
      A.next_attempt_authorization = absent
      M.nonterminal_activation_id = absent
      M.lifecycle_state = idle unless an administrative pause is pending
      Journal += ActivationCancelled(...)
    else if disposition is quarantine(reason):
      M.module_fence_generation += 1
      A.state = quarantined
      A.next_attempt_authorization = absent
      M.lifecycle_state = quarantined
      insert Quarantine(reason, retained evidence)
      Journal += ModuleQuarantined(...)
    else if disposition is retry(authorization, authorization_digest, replay_scope, retry_delay):
      persist retry delay and wall/monotonic retry-not-before deadlines
      A.next_attempt_authorization = {authorized_attempt:A.attempt+1, source_attempt:A.attempt, reason:authorization, evidence_digest:authorization_digest}
      A.state = retry_wait
      M.lifecycle_state = owned_wait_state(M)
      Journal += ActivationRetryScheduled(A.activation_id, A.attempt+1, authorization, authorization_digest, replay_scope)
    Journal += ActivationFenceProven(A.activation_id, evidence.digest)
  }

CompleteQuarantineFence(M, evidence):
  require M.lifecycle_state == quarantined
  require M.host_fence_pending == true and M.execution_slot exists
  require evidence is Runtime-owned host fencing proof or observed Extension process exit
  atomic {
    recheck the same slot and evidence
    retain evidence with the dispositioned Activation and Quarantine record
    clear M.execution_slot
    M.host_fence_pending = false
    Journal += QuarantineFenceProven(M.module_id, evidence.digest)
  }
```

For `activation_ledger`, the digest installed by `FenceComplete` and consumed
by `IssueLease` MUST be the selected record's `sha256(JCS(record))`; the
host-fence digest remains separate dispatch evidence. A `complete` record
grants only the ability to look up and return the already recorded canonical
result whose digest the record names. A `reconcilable` record grants only the
ability to reconcile the existing intent/effect named by its state digest to a
proven terminal outcome. The target Extension MUST NOT initiate the effect
again in either branch, and the Runtime MUST reject any Host-mediated effect
operation outside that scope. Missing, negative, corrupt, binding-invalid, or
unresolved evidence is a quarantine decision, never an implicit retry grant.

### 5.8 CancelActivation and ResolveQuarantine

```text
CancelActivation(A, principal, reason):
  M := Modules[A.module_id]
  require principal has cancellation authority
  require A.attempt == 0 or successful fence evidence exists
  require M.execution_slot is absent and M.host_fence_pending == false
  external_outcome := not_started if A.attempt == 0 or A.dispatch_evidence[A.attempt].transport_started == false else the persisted effect outcome or unknown
  atomic {
    A.state = cancelled
    A.next_attempt_authorization = absent
    M.nonterminal_activation_id = absent
    M.lifecycle_state = idle unless an administrative pause is pending
    Journal += ActivationCancelled(A.activation_id, principal, reason, external_outcome)
  }

ResolveQuarantine(A, principal, decision):
  M := Modules[A.module_id]
  require principal has quarantine-review authority
  require A.state == quarantined or a separate post-commit quarantine exists
  require M.execution_slot is absent and M.host_fence_pending == false
  require the decision cites M.module_fence_generation and resolves every open Module-quarantine record whose authority it lifts
  if A.state == committed:
    require M.nonterminal_activation_id is absent; otherwise resolve the current quarantined Activation first
    atomic resolve only the Module quarantine to idle or paused; never change committed result; Journal += QuarantineResolved(...)
  else if decision == retry and no authoritative result exists:
    atomic set A.state = ready; A.next_attempt_authorization = {authorized_attempt:A.attempt+1, source_attempt:A.attempt, reason:operator_review, evidence_digest:decision.digest}; Modules[A.module_id].lifecycle_state = owned_wait_state(Modules[A.module_id]); Journal += QuarantineResolved(...)
  else if decision == re_evaluate and authoritative result exists:
    require the result can pass the exact frozen policy without substituting current limits
    require A was not quarantined for TRACE_BUDGET_EXCEEDED
    atomic set A.state = result_staged; A.next_attempt_authorization = absent; Modules[A.module_id].lifecycle_state = owned_wait_state(Modules[A.module_id]); Journal += QuarantineResolved(...)
  else if decision == cancel:
    CancelActivation(A, principal, reviewed reason)
  else:
    reject decision
```

### 5.9 ApplyResult

```text
ApplyResult(A):
  M := Modules[A.module_id]
  require A.state in {result_staged, commit_blocked}
  R := Graphs[A.manifest.graph_revision]
  cfg := frozen_activation_config(A)
  result := A.authoritative_result
  require result.status == success
  outputs := A.manifest.output_page_ids
  require outputs == sorted unique R.output_pages(A.module_id)

  if any durable cursor differs from its frozen start:
    roll back the suspect result transaction
    in one separate safety-stop transaction, recheck A and M ownership unchanged,
      persist incident evidence, set instance RecoveryRequired, and do not mutate A or M
    stop writes for ACTIVATION_CURSOR_CONFLICT
    return

  if result.output exists:
    validate predicted complete BlockEnvelope and all references under cfg,
             including canonical size and semantic depth
    parents := all distinct manifest BlockIds sorted by creation order
    lineage := derive new trace ID, root union, parents, and hop count
    check prospective trace budgets
    projected_cursors := every durable input subscription cursor after applying
      this Manifest's frozen span ends; all other subscribers retain current cursors
    preflight every durable output Page using REQ-PAGE-001 projected entries/bytes
    if trace budget check fails:
      quarantine_module(M, TRACE_BUDGET_EXCEEDED, A)
      return
    if durable output preflight reports PAGE_BACKPRESSURE:
      atomic set A.state = commit_blocked; Modules[A.module_id].lifecycle_state = owned_wait_state(Modules[A.module_id])
      return

  atomic {
    recheck activation, result digest, cursors, budgets, and projected pressure
    if output exists:
      reserve Block creation and output commit/page sequences
      insert exactly one immutable Block for A
      insert one durable causal-parent edge for every member of parents
      insert all durable output Deliveries in PageId order
      persist all lossy high-water marks and non-replayable append-audit rows
      insert one unique activation-output record for every frozen output Page
      update lineage and budget counters
    advance every durable cursor to its frozen exclusive end
    record every lossy input cursor span and exact frozen-gap disposition for post-commit application
    A.state = committed
    A.next_attempt_authorization = absent
    A.committed_block_id = new BlockId or absent
    Modules[A.module_id].nonterminal_activation_id = absent
    Modules[A.module_id].lifecycle_state = idle unless an administrative pause was already requested
    Journal += ActivationCommitted(...)
  }

  for each lossy input cursor span:
    Sub.cursor = max(Sub.cursor, span.to_page_seq)
    subtract the committed span from every post-freeze gap and preserve only
      non-empty residual missing ranges
  remove from pending-report state only the exact gaps dispositioned by this committed Manifest
  if output exists:
    append output to every lossy output Page
```

If either preflight or the transactional recheck fails with durable Page pressure, a short transaction sets `commit_blocked`; later execution resumes at `ApplyResult`, never `IssueLease`. If the transactional recheck finds a cursor conflict, it rolls back, leaves the Activation and Module ownership in the same pre-transaction state, and enters `RecoveryRequired` through the separate safety-stop transaction; it does not also quarantine them. A crash before that safety-stop transaction commits is recovered by detecting the same cursor/Manifest mismatch and completing the safety stop before any ordinary write is enabled. A hard trace-budget violation instead rolls back and quarantines the Activation and Module with the staged result retained.

### 5.10 Subscription disposition

```text
DeadLetterRange(principal, page_id, module_id, expected_cursor, end_exclusive, reason):
  require principal has dead-letter authority
  require end_exclusive > expected_cursor
  require no nonterminal Activation freezes an overlapping cursor span
  records := exact contiguous durable Deliveries [expected_cursor, end_exclusive)
  require every record and referenced Block is available
  atomic {
    require Sub.cursor == expected_cursor
    insert immutable dead-letter evidence for every (DeliveryId, BlockId)
    retain every referenced Block for dead-letter policy
    Sub.cursor = end_exclusive
    Journal += SubscriptionDeadLettered(...)
  }

SkipRange(principal, page_id, module_id, expected_cursor, end_exclusive, reason):
  require principal has skip authority
  require end_exclusive > expected_cursor
  require end_exclusive <= Pages[page_id].next_page_seq
  require no nonterminal Activation freezes an overlapping cursor span
  atomic {
    require Sub.cursor == expected_cursor
    require end_exclusive <= Pages[page_id].next_page_seq
    insert immutable skip evidence [expected_cursor, end_exclusive)
    Sub.cursor = end_exclusive
    Journal += SubscriptionSkipped(...)
  }
```

### 5.11 LossyEvict

```text
LossyEvict(page_id):
  require Page.mode == lossy
  consider the queue after its newly audited logical append
  while item or byte limit is exceeded, including when the new item alone is oversized:
    remove oldest Delivery
  for each affected subscription:
    advance in-memory cursor to first retained sequence, or Page.next_page_seq if none remains
    append LossyGap(old_cursor, new_cursor, overflow)
```

### 5.12 Recover

```text
Recover():
  acquire exclusive instance lock
  open and verify SQLite configuration, schema, integrity, and digests
  prove old Extension execution epoch absent; otherwise terminate it
  for every granted or releasing Module storage scope, revoke the old grant and obtain broker/backend/process-container release proof
  move a scope without release proof to write_fenced_unknown and do not grant or dispatch its Module
  verify/rebuild counters after unclean shutdown
  reconstruct monotonic execution, lease, fencing, and retry-not-before deadlines from persisted wall deadlines, clamped into zero through each persisted originally authorized duration
  reset lossy queues and record restart gaps
  apply every result_staged or commit_blocked Activation in (ManifestCreated journal_seq, activation_id) order
  move orphaned leased Activations through fencing to retry_wait, cancellation, or quarantine according to their persisted dispatch evidence, one-shot authorization, and frozen replay contract
  expose ready and retry_wait work only after the above completes
```

### 5.13 Module storage writer handoff

```text
GrantStorageWriter(module_id, owner):
  M := Modules[module_id]
  W := StorageWriterOwnership[M.storage_scope_id]
  require W.state in {unowned, released}
  require no Host grant or backend lease names a different live owner
  require W.writer_generation < 9007199254740991
  transaction:
    W.writer_generation += 1
    W.owner = owner bound to M.module_id, M.storage_scope_id, current Worker epoch, Extension alias/generation, and capability digest
    W.state = granted
    Journal += StorageWriterGranted(M.storage_scope_id, W.writer_generation, owner)

ReleaseStorageWriter(module_id, owner, proof):
  M := Modules[module_id]
  W := StorageWriterOwnership[M.storage_scope_id]
  require W.state in {granted, releasing}
  require owner and writer_generation equal W.owner and W.writer_generation
  require M has no execution slot and cannot accept new dispatch
  transaction set W.state = releasing; Journal += StorageWriterReleasing(...)
  revoke the Host broker grant
  if proof establishes broker rejection, backend fenced generation, or termination of every holder of a non-revocable OS handle:
    transaction clear W.owner; set W.state = released; Journal += StorageWriterReleased(...)
  else:
    transaction set W.state = write_fenced_unknown; Journal += StorageWriterReleaseUnknown(...)
```

`IssueLease` additionally requires that a stateful Module's current serving
generation owns the exact `granted` writer tuple. Read-only and staging handles
never satisfy this precondition. A successful Extension shutdown response is
not a `ReleaseStorageWriter` proof.

## 6. Error-state rules

The following failures have fixed state effects:

| Failure class | Activation state effect | Cursor effect | Module effect |
| --- | --- | --- | --- |
| invalid result or BlockDraft before staging | `quarantined` | none | quarantined |
| stale lease | none | none | none |
| retryable Extension failure | `retry_wait` | none | retains Activation ownership |
| permanent Extension failure | `quarantined` | none | quarantined |
| result digest conflict | quarantined unless already committed | none beyond prior commit | quarantined |
| durable backpressure after staging | `commit_blocked` | none | retains Activation ownership |
| trace hard limit | `quarantined` | none | quarantined |
| unresolved external outcome without safe replay | `quarantined` | none | quarantined |
| SQLite rollback | prior durable state | none | prior durable state |
| unexplained cursor or sequence invariant failure | instance `RecoveryRequired` | none | dispatch stopped |
| lossy overflow | Activation unaffected | lossy cursor gap | unaffected |

No error path MAY synthesize success, advance a durable cursor without successful Activation commit or complete dead-letter/skip evidence, or create only a subset of durable output Deliveries.

## 7. Safety invariants

All invariants in the six component documents are incorporated by reference. Additionally:

- **INV-RAM-001 — One legal next state.** For a fixed state and explicit environment input, every transition has one deterministic durable post-state or a classified no-change failure.
- **INV-RAM-002 — Manifest ownership.** A Module's `nonterminal_activation_id` is present if and only if exactly one nonterminal Activation belongs to it.
- **INV-RAM-003 — Manifest/cursor consistency.** Before commit, every durable cursor equals its frozen span start; after commit, it equals the frozen exclusive end unless a later transaction advanced it.
- **INV-RAM-004 — Result authority.** At most one result digest is authoritative for an Activation; disagreement is evidence, not a choice point.
- **INV-RAM-005 — Complete durable transition.** A committed output transition contains one Block, one Delivery per frozen durable output Page, one reservation/audit row per frozen lossy output Page, every durable input cursor advance, trace charges, and terminal Activation state.
- **INV-RAM-006 — Current revision isolation.** Installing a new configuration or graph cannot change any byte, policy snapshot, or route of an existing Manifest.
- **INV-RAM-007 — Retry identity.** Dispatch retry MAY change only Worker epoch, Extension generation, attempt, lease generation, lease token, issue/expiry times, and persisted backoff; it never changes semantic input or Manifest bytes.
- **INV-RAM-008 — Loss boundary.** Only in-memory state of explicitly lossy Pages MAY be absent after a successful durable commit and subsequent crash.
- **INV-RAM-009 — External uncertainty.** Internal rollback or retry never implies rollback of an Extension's remote side effect.
- **INV-RAM-010 — Current Module fence.** A result can first become
  authoritative only while the persisted Module ownership, execution-slot
  binding, and Module fence generation all name that exact Activation lease.
- **INV-RAM-011 — Runtime-event identity.** Identical replay of a committed
  Runtime-event operation returns its original RuntimeEvent and Block identities;
  a conflicting digest cannot mutate or duplicate the operation.
- **INV-RAM-012 — Dispatch-before-write evidence.** A request can become
  transport-eligible only after the same attempt's exact frame digest is
  durably `started`; `prepared` therefore proves no transport, while `started`
  conservatively means possible transport.
- **INV-RAM-013 — One-shot replay authority.** A `retry_wait` Activation can
  receive a new lease only by consuming one durable authorization whose source
  attempt, next attempt, reason, and evidence digest bind an explicit retryable
  response, proved pre-dispatch fence, frozen replay contract, or reviewed
  operator decision. The authorized attempt is exactly source attempt plus one.
- **INV-RAM-014 — Frame-compatible generation.** `IssueLease` selects only a
  generation satisfying both immutable Manifest frame bounds and, when
  applicable, its frozen activation-ledger identity.
- **INV-RAM-015 — Ledger-evidence continuity.** An `activation_ledger`
  authorization exists only when one immutable Host-owned schema-valid record
  binds the exact Activation, Manifest, source attempt, target generation, and
  frozen ledger descriptor. Its authorization digest is
  `sha256(JCS(record))`, and consuming it cannot grant any operation beyond
  returning the recorded result or reconciling the recorded existing effect.
- **INV-RAM-016 — Frozen execution context.** Build and dispatch bind the complete Module-scoped effective configuration and its schema digest; a generation that cannot execute them is never selected.
- **INV-RAM-017 — Projected Page admission.** `ApplyResult` computes every durable output quota from the single projected atomic cursor-and-append post-state.
- **INV-RAM-018 — One active Module writer.** A storage scope has at most one
  active writer owner and one monotonically increasing writer generation; an
  uncertain release prevents subsequent grant and Module dispatch.

## 8. Liveness conditions

Core guarantees safety unconditionally within its storage assumptions. Progress additionally requires:

- available storage capacity;
- a responding or replaceable Extension;
- an operator decision for quarantined poison input;
- durable subscribers that eventually consume, dead-letter, skip, or are removed; and
- finite configured retry and loop policies.

If those conditions hold, the Runtime SHOULD eventually dispatch every eligible durable Delivery and SHOULD eventually retry every `commit_blocked` result. Fair scheduling MUST prevent one busy Module from indefinitely starving another ready Module of the same priority.

Core does not promise progress through an unreviewed quarantine.

## 9. Crash equivalence

For every crash point `CP-01` through `CP-15` in [Storage and Recovery](06-storage-and-recovery.md), recovered state MUST be observationally equivalent to either:

- the abstract state immediately before the interrupted SQLite transaction; or
- the abstract state immediately after its complete commit.

No third partial durable state is legal. Lossy post-commit operations are the declared exception and remain constrained by `INV-RAM-008`.

## 10. Required model-based tests

A Core implementation MUST execute randomized transition sequences against this abstract machine and compare its durable projection after every step. The generator MUST include:

- chains, fan-in, fan-out, diamonds, self-loops, and intersecting cycles;
- repeated Block occurrences over several Pages;
- configuration and graph updates during every Activation state;
- single-role and dual-role neighbor projection, authorization filtering,
  source-Descriptor digest mismatch, and deterministic projection ordering;
- lease expiry, stale results, identical result replay, and conflicting digests;
- crashes before and after the durable dispatch marker, every replay-contract
  form, one-shot authorization consumption, ledger record absence, unknown or
  corrupt state, retained and migrated continuity, complete-result return,
  reconcile-only scope, evidence-digest substitution, and a replacement
  generation with smaller frame limits;
- backpressure on each frozen output Page in turn;
- SQLite busy/full errors and a crash at every labeled crash point;
- mixed durable and lossy input/output Pages;
- identical and conflicting Runtime-event replay, including a crash during its
  all-or-nothing fan-out transaction;
- result/quarantine races in which a Module fence wins before result staging;
- explicit subscription dead-letters, skips, and quarantine review;
- sequence and quota boundaries; and
- external-effect outcomes `not_started`, `succeeded`, `failed`, and `unknown`.

The test oracle MUST compare canonical manifests and Blocks, Delivery and cursor identities, global order, state transitions, trace counters, quarantine evidence, and journal events. Comparing only final user-visible text is insufficient.
