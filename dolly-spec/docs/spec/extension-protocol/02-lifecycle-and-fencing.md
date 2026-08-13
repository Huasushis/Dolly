# Extension Lifecycle and Generation Fencing

Status: normative for process Extensions and Module instances.

In this document, unqualified **generation** means an Extension process generation. Core `lease_generation` is a separate per-Activation dispatch fence and is always named explicitly.

## 1. Authority and durable identity

The Host is the sole authority for Extension and Module lifecycle. An Extension **MUST NOT** declare itself current, change its own generation, or resume a Module without Host instruction.

The Host **MUST** persist the following before spawning an Extension process:

- `worker_epoch`: a fresh unpredictable identifier for each Runtime Worker incarnation;
- `extension_alias`: the instance-local configured Extension identity;
- `package_digest` and declared package version;
- `extension_generation`: a monotonically increasing Core safe JSON integer for that alias; and
- the expected Extension and Module protocol identities.

Every spawn attempt, including a retry of the same package, **MUST** receive a new Extension generation. Generation reuse is forbidden. Exhausting the Core safe-integer range **MUST** put the instance into an operator-repair state rather than reuse a value.

The Host **MUST** bind the Extension generation and Worker epoch to the operating-system pipe connection. Values repeated in JSON are consistency checks, not bearer credentials.

## 2. Extension process state machine

The durable Host state is:

```text
Discovered -> Verified -> Spawning -> Initializing -> Ready
                                  \-> Exited
Ready -> Draining -> Stopping -> Exited
Ready -> Failed -> Backoff -> Spawning
Failed/Backoff -> Quarantined
Quarantined -> Verified       (explicit operator action only)
Exited -> Verified            (configured or explicitly resumed intent only)
```

Rules:

- `Verified` means package identity, manifest, executable path, policy, and signature requirements passed. Verification **MUST NOT** execute package code.
- The Host **MUST** persist `Spawning` and the new generation before process creation.
- `Initializing` begins only after the process and private pipes exist.
- `Ready` begins only after successful version negotiation, capability grant creation, and health validation.
- Only a `Ready` generation MAY receive new Module activations.
- `Draining` forbids new activations but permits in-flight requests, snapshot, status, cancellation, and shutdown.
- Any unexpected exit from `Initializing`, `Ready`, or `Draining` becomes `Failed`.
- `Exited` does not imply successful snapshot or state commit.
- `Quarantined` is sticky and **MUST** require an authenticated operator action or an explicitly configured repair workflow to leave.
- Observed process state is distinct from durable lifecycle intent
  `run | hold | remove`. Presence in an active configuration normally means
  `run`; a temporary operator hold is durable Runtime state and removal is a
  configuration transaction. `Exited -> Verified` is legal only while the
  Host is serving the instance and intent remains `run`. Planned daemon exit
  does not silently turn configured intent into `hold`, while an operator hold
  does not enter the crash-restart loop.

The Host **MUST** write every transition and reason to the Event Journal. A crash during a transition **MUST** resume from the durable state, never from the child process's claim.

## 3. Initialization direction and negotiation

After spawn, the Host **MUST** send `extension.initialize`. Its parameters **MUST** include:

- expected Extension ID and package digest;
- expected package version;
- Worker epoch and generation;
- the exact `config_revision`, frozen Extension-level configuration object,
  `sha256(JCS(extension_config))`, and its transitive schema-bundle digest;
- offered protocol versions in Host preference order;
- bootstrap and proposed negotiated limits, including `max_frame_bytes` and
  `max_frame_nesting_depth`;
- granted Host-service method names, without secret values;
- opaque directory or storage handles that policy permits; and
- the stable Host-assigned `storage_scope_id` for every expected Module and
  Module-state handle; and
- Host implementation and SDK compatibility information.

The request and successful response **MUST** conform to
[`extension-initialize-request.schema.json`](../../../schemas/extension-initialize-request.schema.json)
and
[`extension-initialize-result.schema.json`](../../../schemas/extension-initialize-result.schema.json).
`expected_modules` freezes each Runtime-approved replay contract for this
negotiation. Storage-handle capabilities are opaque, connection-bound grants;
they are not paths and an Extension **MUST NOT** derive authority from their
text.

Before the process can become `Ready`, the Host recomputes the Extension
configuration digest, verifies the schema bundle against the verified package,
and validates the object. The Extension response echoes the revision and both
digests, proving which process-level object it accepted. A mismatch is a
permanent initialization failure for that package/configuration pair; the Host
does not substitute current configuration or start a crash-retry loop.

The Extension response **MUST** include the selected protocol version, its
compiled Extension identity and version, supported Module types, integer state
schema versions, accepted configuration binding, effective limits, and any
activation-ledger continuity bindings. For every numeric limit, the effective value **MUST** equal the
minimum of the Host offer, the Extension response, and the Host hard limit.
The Host **MUST** reject an identity mismatch, a version not present in the
verified manifest, an unoffered protocol version, or any claimed effective
limit above its offer. Complete-frame depth and semantic schema-root depth use
the distinct counting rules in the wire protocol.

An advertised Module state-schema number does not prove activation-ledger
continuity. For every expected Module whose frozen contract names an
`activation_ledger`, the response **MUST** contain exactly one matching
`ledger_bindings` item and no item may name a non-ledger Module. Before accepting
the binding, the Host **MUST** verify the exact ledger descriptor, target
package and generation, exclusive Module-state-directory grant, and either
an initialized empty ledger, retained state, or a completed, idempotent
migration with its proof digest. `initialized` is legal only when both source
fields are null and Host durable state proves that this Module has no prior
ledger and no Activation that could require replay. `retained` requires a
source generation and digest equal to the target-state digest; `migrated`
requires the completed migration operation and both state digests. A missing,
duplicate, mismatched, or unproved binding makes that generation incompatible
for that Module.

Before selecting a generation as current for a Module, the Host **MUST** inspect
that Module's immutable Manifests that can legally receive a future
`module.activate`: states `ready`, `leased`, `fencing`, `retry_wait`, plus a
`quarantined` Activation that has no authoritative result and may be explicitly
released. `result_staged`, `commit_blocked`, and a quarantined Activation with
an authoritative result will be applied from staged bytes and do not require
redispatch; they therefore do not block an otherwise compatible generation.
For every redispatchable Manifest, effective `max_frame_bytes` **MUST** be at
least `required_frame_bytes`, and effective complete-frame parser depth **MUST**
be at least `required_frame_nesting_depth` without exceeding 96. These are
immutable, digest-covered inclusive bounds for the complete legal redispatch
frame. The generation **MUST** also be verified capable of executing the
Manifest's exact `effective_config_schema_digest` and complete
`effective_config` bytes, and of loading every retained schema bundle and
semantic-validator revision named by a targeted input Action's creation-time
`contract_binding`. Compatibility is tested against the immutable Manifest and
Block bytes, never against the Module's current configuration or Descriptor.

An incompatible generation may complete process initialization, but **MUST
NOT** become current or `Ready` for the affected Module. It does not block
unrelated Modules of the alias. The Host **MAY** keep a compatible old
generation current before cutover; it **MUST NOT** rewrite, truncate, re-batch,
re-identify a live Manifest, substitute a current configuration, or rebind an
ActionContract to fit the candidate.

A stateful generation holding only `read_only` or `staging_read_write` storage
may initialize for bounded migration or probes but MUST NOT become the serving
generation or receive production Activations. Serving selection additionally
requires the exact Host-owned `active_read_write` owner and writer generation
for every Module scope that the Activation can mutate.

No common protocol version is a permanent initialization failure for that package/configuration pair. It **MUST NOT** enter an automatic crash-retry loop.

The initialization request is the only permitted request before `Ready`. The Extension **MUST NOT** call Host services during initialization unless that service is explicitly designated `initialization_safe` in the grant.

## 4. Module instance state machine

Each configured Module has a durable state independent of the process state:

```text
Absent -> Instantiating -> Ready -> Activating -> CommitPending -> Ready
                       \-> Failed
Ready/Activating/CommitPending -> Quiescing -> Quiesced
Quiesced -> Snapshotting -> Quiesced
Quiesced -> Restoring -> Ready
Ready/Quiesced -> Stopping -> Stopped
Stopped/Failed -> Instantiating -> Ready
Instantiating/Quiesced -> Restoring -> Ready
Failed -> Quarantined    (policy or repeated permanent failure)
```

The Host **MUST** enforce at most one nonterminal Core Activation per `module_id`, regardless of how many RPC requests an Extension process can handle. `CommitPending` covers a returned result that remains staged or blocked in Core; no new Activation **MAY** dispatch in that state. Different Modules MAY activate concurrently within one process.

`Stopped` is a detached process state, not deletion, destructive reset, or an
empty-state instruction. If desired configuration still contains the Module,
the next serving process uses a fresh instantiate operation ID and the same
`storage_scope_id`. Ordinary restart reopens and verifies retained scoped state;
`module.restore` is used only with an exact Host-retained snapshot. Replaying an
old shutdown operation cannot reopen a Module. Unexpected loss of a hosting
process moves each attached nonterminal Module to `Failed` or an equivalent
recovery-required Host state; it cannot remain observably `Ready`.

`module.instantiate`, `module.restore`, `module.snapshot`, and `module.shutdown` **MUST** be idempotent with respect to their operation IDs. A repeated request with the same operation ID and identical digest **MUST** return the original terminal result. Reuse with different parameters **MUST** fail with `revision_conflict`.

The closed params and success-result shapes for lifecycle, configuration,
snapshot, migration, status, health, and shutdown methods are the corresponding
`$defs` in
[`extension-lifecycle-rpc.schema.json`](../../../schemas/extension-lifecycle-rpc.schema.json).
For every state-changing Module method, the Extension MUST durably record the
operation ID and semantic digest before its documented commit point.
`module.operation_status` uses a fresh read `operation_id` plus the original
`target_operation_id` and exact target method; the method qualifier is required
because prepare, commit, and abort deliberately share one configuration
transaction identity. The status read MUST NOT start, retry, cancel, or advance the target.
`absent` proves no durable operation record exists. `unknown` is terminal
uncertainty and MUST NOT be reported as `absent` or resolved by minting a new
operation ID. A succeeded status MUST return the exact typed success result
and digest originally recorded for the target method.

`module.instantiate` receives the complete frozen `effective_config` produced
by the normative shallow overlay, its JCS digest, its transitive schema-bundle
digest, the exact configuration revision, and the stable Host-assigned
`storage_scope_id`. It also binds the Host-granted storage access mode and, for
an active writer, its positive per-scope writer generation. Its success result
echoes these bindings. The Host
recomputes and validates them before dispatch and
rejects a response that acknowledges different bytes or revision. An Extension
never merges an Extension object and Module object itself.

The same `storage_scope_id` MUST appear in the expected-Module initialization
record, Module-state handle, instantiate request/result, activation-ledger
continuity binding, replay evidence, and every snapshot. A mismatch is a
permanent state-identity failure, not a request to initialize an empty database.
Process generation, Worker epoch, config revision, and storage scope are
different concepts; restarting a process changes the first two and preserves
the last.

## 5. Activation fencing

Before dispatch, the Host **MUST** durably create an Activation lease containing at least:

- `activation_id`;
- `module_id`;
- Worker epoch;
- Extension generation;
- Core `lease_generation` and `attempt`;
- a unique lease token;
- input-manifest digest;
- config and graph revisions;
- lease expiry; and
- retry ordinal.

The `module.activate` request **MUST** contain the immutable manifest plus Worker
epoch, Extension generation, Core lease generation, lease token, and attempt,
exactly as defined by `activation-request.schema.json`. Lease expiry and any
implementation-internal retry ordinal distinct from `attempt` are Host state
and are not additional wire fields. The
result **MUST** echo the activation ID, Worker epoch, Extension generation, Core
lease generation, lease token, and input-manifest digest. `attempt` remains a
Host-recorded request/retry ordinal; it is not part of the v1 result envelope
and is not an independent fence beyond the echoed generation and token.

Issuing a lease **MUST** first persist a per-attempt dispatch record in
`prepared`, with `transport_started=false` and no frame digest. The Host then
constructs the exact canonical request, verifies its byte and complete-frame
depth bounds, and atomically changes that record to `started` with
`transport_started=true` and the frame digest. Only after that transaction
commits may any frame byte become eligible for pipe transport. A crash in
`prepared` proves no send; a crash in `started` is conservatively treated as a
possible send. This is the normative ordering implemented by Core
`DispatchLease`.

Every `neighbor_descriptors` item in the immutable manifest **MUST** be the
closed object `{module_id, descriptor_revision, source_descriptor_digest,
relationships, projection}`. `source_descriptor_digest` **MUST** equal
`sha256(JCS(source_descriptor))` for the complete original Module Descriptor in
the frozen graph revision. The Host **MUST** derive every projected value from
that same source Descriptor; neither the relationship labels nor projected
values may be accepted from the Extension.

`relationships` **MUST** be exactly one of the following canonical arrays:
`["input_producer"]`, `["output_consumer"]`, or
`["input_producer","output_consumer"]`. The associated `projection` is a
closed object and **MUST** contain exactly the fields authorized by that array:

| Relationships | Exact projection fields |
|---|---|
| `input_producer` | `display_name`, `trust`, `metadata`, `emits` |
| `output_consumer` | `display_name`, `trust`, `metadata`, `accepts`, `actions` |
| both, in canonical order | `display_name`, `trust`, `metadata`, `emits`, `accepts`, `actions` |

The Host **MUST NOT** expose any other source-Descriptor field through the
projection. In particular, the projection is not a Module Descriptor and
**MUST NOT** be encoded, hashed, cached, or compared as though it reused the
source Descriptor tuple bytes. The top-level `module_id`,
`descriptor_revision`, and `source_descriptor_digest` identify and bind the
source separately.

The Host deduplicates neighbors by top-level `module_id`, includes the canonical
two-label array when both relationships exist, and orders items by
`(module_id, descriptor_revision)`. Relationship labels come only from the
frozen graph revision.

The Manifest's own `descriptor_revision` and `config_revision` also freeze the
Runtime-approved `activation_replay_contract`. An omitted Descriptor-template
request is normalized before commit to
`{"mode":"never_auto_retry","evidence":"none","ledger":null}`. A new Descriptor,
configuration, package, or generation MUST NOT retroactively increase that
authority.

After any dispatch whose result was not durably staged, automatic redispatch is
forbidden under `never_auto_retry`. Under `fenced_replay`, redispatch is legal
only after the Host has the ordinary host-owned empty-slot proof and the frozen
evidence is still valid: `pure_compute` means the approved handler produced no
externally visible effect other than its result, and `activation_ledger` means a
durable Module-state-directory ledger with the exact approved namespace and
schema version can return or reconcile the original disposition. A candidate
generation MUST prove that ledger was retained or atomically migrated before
becoming Ready for the Module.

Before an `activation_ledger` retry, the Host **MUST** persist a closed record
conforming to
[`activation-replay-evidence.schema.json`](../../../schemas/activation-replay-evidence.schema.json).
It binds the exact Module, Activation, Manifest, source attempt, target
generation, ledger descriptor, continuity proof, observed ledger state, and
permitted disposition. The Host derives this evidence from the exclusively
granted Module-state directory and verified migration record; Extension prose
or a bare state-schema number is not evidence. Only `complete` or
`reconcilable` permits a reconciliation dispatch that returns the retained
result or completes the retained intent without creating a second effect.
`absent`, `unknown`, or `corrupt` **MUST** quarantine as an unknown external
outcome.

The contract never turns an unknown external effect into a safe replay and does
not override deadline, attempt, quarantine, or revocation policy.

At result staging, the Host **MUST** compare every fence field with the current durable lease. A mismatch, expired lease, superseded Extension or lease generation, quiesced Module, or non-current Worker epoch **MUST** reject the result as Core `ACTIVATION_STALE_LEASE` (transport category `stale_generation`) without advancing cursors or committing outputs. Once a result is durably staged under a valid fence, Core applies that exact result without invoking the Module again.

A process that loses its pipe, misses its generation, or is moved to `Draining` cannot regain authority by reconnecting. Extension RPC v1 has no process reconnection. Recovery always spawns a new generation and replays durable work according to the Activation state machine.

If the Host commits an Activation and its response is lost, replay of the same `activation_id` **MUST** resolve to the already committed result. A different output digest for that ID **MUST** quarantine the Module as nondeterministic/idempotency-violating; the Host **MUST NOT** silently replace the first result.

## 6. Background work

An Extension MAY run background computation while `Ready`, subject to its grant and quotas. Background work:

- **MUST NOT** publish a Block or advance a Page cursor directly;
- **MUST NOT** acquire authority for an expired generation;
- **MUST** use a Host-issued operation/idempotency ID for durable effects;
- **MAY** request a future Activation or wakeup through an authorized Host service; and
- **MUST** be cancelled or rendered unable to commit when the process enters `Draining`.

An Extension-owned database update made outside an Activation is not covered by the Runtime's cursor/output transaction. Such a Module **MUST** implement a documented durable inbox/outbox protocol keyed by the Host operation ID, or it is non-conforming for crash recovery.

## 7. Crash policy

Automatic restart uses exponential backoff. The default delays are 1, 2, 4, 8, 16, 32, and then 60 seconds, capped at 60 seconds. Jitter MAY be used only if its sampled value is recorded so replay and incident analysis can reproduce the choice.

By default, five unexpected exits within a rolling five-minute window put the Extension alias in `Quarantined`. Permanent initialization failures, manifest mismatches, protocol violations, and capability abuse MAY quarantine immediately.

On process failure the Host **MUST**:

1. revoke the connection grant and generation;
2. mark outstanding RPC transport outcomes as indeterminate;
3. expire or fence Activation leases;
4. resolve committed operations from durable Host records;
5. reschedule only operations whose method contract permits retry; and
6. preserve diagnostics without payload secrets.

## 8. Shutdown

For planned shutdown the Host **MUST** durably record `Draining` and the exact
set of Modules attached to that process generation, stop new dispatch and
background commits, and wait for each in-flight Activation or staged result to
reach its prescribed drain disposition. It then sends `module.shutdown` with a
stable operation ID to every attached `Ready` or `Quiesced` Module. Independent
Modules SHOULD be shut down concurrently; Page topology does not create a
lifecycle ordering. An accepted explicit shared-state contract MAY declare a
bounded acyclic dependency order.

The Host reconciles every lost Module response with
`module.operation_status`. Only after all Modules have a terminal shutdown
receipt, or the common shutdown deadline expires, may it send
`extension.shutdown`. A timed-out or indeterminate Module enters `Failed` or a
recovery-required state. Process exit and `remaining_module_count` are not
evidence that a Module operation succeeded. `unresolved_module_ids` is sorted
by UTF-8 bytes and its length MUST equal `remaining_module_count`.

`extension.shutdown` and `module.shutdown` MUST use the closed parameter and
result definitions in `extension-lifecycle-rpc.schema.json`. Repeating the
same operation ID is idempotent. Loss of the Extension-level response is
resolved from Host-observed process state and exit, while loss of a
Module-level response is resolved through `module.operation_status`.

`module.shutdown` does not delete Module state, even when its reason is
`remove`; removal, tombstoning, retention, and eventual deletion remain
Host-controlled configuration/retention operations. After Module shutdown the
Host revokes its storage grant. For a brokered handle it records broker
revocation; for a non-revocable local handle it must observe termination of the
complete process lifecycle container before recording writer release. An
Extension response alone is not release proof.

The v1 default is:

- 10 seconds to drain;
- 5 seconds for graceful process exit after the shutdown response;
- then operating-system termination; and
- after another 5 seconds, forceful kill.

The effective deadlines **MUST** be recorded. Forceful termination **MUST NOT** make outstanding work appear failed or successful; durable operation records determine recovery.

## 9. Orphan handling

Every child process **MUST** be placed in the platform lifecycle container defined by the cross-platform contract. A newly started Worker **MUST** search for a prior ownership record before accepting instance writes. Old processes cannot be trusted merely because their PID still exists; PID reuse **MUST NOT** be used as proof of identity.

The Worker epoch, generation, exclusive instance lock, and private pipe identity together form the fence. If exclusivity cannot be established, the Worker **MUST** refuse to start.

## 10. Stable requirements and invariants

- `INV-XLIFE-001` — Every spawn uses a never-reused Extension generation bound to one Worker epoch and private connection.
- `INV-XLIFE-002` — Only the current `Ready` Extension generation receives new work.
- `INV-XLIFE-003` — A Module has at most one nonterminal Core Activation, including a staged or commit-blocked result.
- `INV-XLIFE-004` — A result can stage only when Worker epoch, Extension generation, lease generation, token, manifest digest, and Module fence all match durable authority.
- `REQ-XLIFE-001` — Crash recovery revokes old authority before retry and never treats process exit as proof of side-effect outcome.
- `INV-XLIFE-005` — Extension shutdown cannot bypass the Module shutdown
  barrier, and neither a process exit nor an unresolved operation is rewritten
  as a successful Module stop.
- `REQ-XLIFE-002` — A configured stopped or failed Module restarts through a
  fresh instantiate operation under the same storage scope; restore is reserved
  for an exact verified snapshot and removal never implies state deletion.
