# Activation and Module

Status: normative for Dolly Core v1.

An Activation is the sole Core operation by which a Module consumes Page input and optionally produces one Block. This document freezes manifest bytes, dispatch fencing, single-flight behavior, result acceptance, commit semantics, and external-side-effect limits.

The RFC 2119/8174 requirement-keyword convention in [Identifiers and Canonical JSON](01-identifiers-and-canonical-json.md) applies here.

## 1. Module instance

A Module is one configured instance of an Extension module type. Multiple Modules MAY be hosted by one Extension process, but their identity, state directory, Descriptor, subscriptions, Activations, quotas, and quarantine state are independent.

One Module MUST have at most one nonterminal Activation at a time. “Nonterminal” includes a persisted manifest waiting for dispatch, a leased execution, retry wait, a staged result, and commit blocked by backpressure. Different Modules MAY execute concurrently subject to Runtime resource limits.

Each Module MUST persist a monotonically increasing `module_fence_generation`
and at most one Runtime-owned execution-slot binding. The binding contains the
`activation_id`, Worker epoch, Extension generation, and lease generation. A
lease records the Module fence generation that was current when that binding
was installed. This generation is internal trusted state, not a field supplied
by the Extension. A result MAY first become authoritative only while the
Module still owns that Activation, the execution-slot binding matches the
result fence, and the recorded and current Module fence generations are equal.
The generation is an unsigned 64-bit integer initialized to zero and MUST NOT
wrap; exhaustion is `STORAGE_SEQUENCE_CONFLICT` and stops writable dispatch.
The execution slot is initially absent and `host_fence_pending` is initially
false.

The v1 normalization default for the instance-wide `max_pending_activations` limit is 4,096. It counts every nonterminal Activation, including `quarantined`. At the limit, the Runtime MUST delay new Manifest creation with `ACTIVATION_CAPACITY_DELAYED`, leave all candidate cursors unchanged, and continue recovery and terminal progress for existing Activations. Capacity pressure alone MUST NOT quarantine input or discard a persisted Manifest. A resolved configuration MUST materialize this finite limit.

A Module MAY run internal background I/O, indexing, downloads, or precomputation, but background work MUST NOT append to a Page, advance a subscription, or fabricate an Activation result. It MAY only request a future Activation or wakeup through the Host. Extension-owned background-state consistency is the Extension's responsibility, and process fencing terminates that work together with the Activation handler.

### 1.1 Module states

The states below are the Core scheduling projection, not the Extension protocol lifecycle state. A conforming Host MUST map them consistently: Core `idle`/pre-dispatch `waiting` map to a protocol Module that is ready for the applicable operation, `running` maps to `Activating`, and result-staged or commit-blocked `waiting` maps to `CommitPending`. A protocol lifecycle state MUST NOT grant dispatch when this Core projection forbids it.

| State | New manifest allowed | Existing Activation dispatch allowed | Description |
| --- | ---: | ---: | --- |
| `starting` | no | no | Extension instance and Descriptor are being established |
| `idle` | yes | no | no nonterminal Activation exists |
| `waiting` | no | yes when Activation is `ready` or `retry_wait` | a nonterminal Activation exists but no code is executing |
| `running` | no | no | one current Activation lease owns the execution slot |
| `fencing` | no | no | prior execution is being cancelled or its process terminated |
| `paused` | no | no | administratively paused; input may continue accumulating |
| `quarantined` | no | no | integrity, determinism, or crash-loop violation requires review |
| `stopped` | no | no | instance has been shut down |

Valid transitions are:

```text
starting -> idle | quarantined | stopped
idle -> waiting | paused | stopped
waiting -> running | idle | paused | quarantined | stopped
running -> waiting | fencing | paused | quarantined | stopped
fencing -> waiting | paused | quarantined | stopped
paused -> idle | waiting | quarantined | stopped
quarantined -> idle | waiting | paused | stopped
```

Recovery from `quarantined` MUST require an authenticated, audited operation. It MUST NOT happen because a timer elapsed.

Quarantining a Module is a fencing operation, not only a lifecycle label. In
one SQLite transaction the Runtime MUST increment `module_fence_generation`,
revoke result acceptance through the old execution-slot binding, set the Module
to `quarantined`, create the Quarantine evidence, and disposition the Module's
current nonterminal Activation. That Activation becomes `quarantined` with its
Manifest, authoritative result, and fence evidence retained. If code may still
be executing, the same transaction marks its host fence pending; the Runtime
MUST then request cancellation and obtain Runtime-owned empty-slot proof or
terminate the hosting process. It MUST NOT erase or reuse the physical
execution slot before that proof. A conflict reported for an already committed
Activation leaves that Activation committed and creates a separate Quarantine
record, but the same transaction still fences the Module and quarantines any
different current nonterminal Activation.

An administrative pause requested while the Module is `running` sets a durable pending-pause flag; it MUST NOT pretend that the execution slot is empty. A `running -> paused` transition is legal only in the same durable transition that receives a terminal handler response or completes fencing and releases that slot. Stopping a running Module MUST pass through `fencing` unless the Runtime already has equivalent host-owned proof that the execution slot is empty.

Persisting a new Manifest changes the Module from `idle` to `waiting`. Issuing its lease changes `waiting` to `running`. A retryable result, a staged result, or durable commit backpressure returns it to `waiting` while retaining `nonterminal_activation_id`, or to `paused` if an administrative pause is pending. Successful commit or safe cancellation clears that identifier and returns it to `idle`, unless an administrative pause is pending.

## 2. ActivationManifest

The Runtime constructs and persists this logical value before dispatch:

```json
{
  "schema": "dolly.activation-manifest/v1",
  "activation_id": "0198ab31-6c44-7e8a-b2bb-000000000004",
  "module_id": "main-brain",
  "reason": "input",
  "created_at": "2026-08-10T18:30:00.123456Z",
  "graph_revision": 17,
  "config_revision": 42,
  "descriptor_revision": 9,
  "effective_config": {"model": "example-model", "temperature": 0},
  "effective_config_digest": "sha256:...",
  "effective_config_schema_digest": "sha256:...",
  "input_items": [],
  "cursor_spans": [],
  "lossy_gaps": [],
  "output_page_ids": ["conversation", "review"],
  "neighbor_descriptors": [],
  "required_frame_bytes": 2048,
  "required_frame_nesting_depth": 4,
  "deadline": "2026-08-10T18:32:00.123456Z",
  "manifest_digest": "sha256:..."
}
```

Manifest `reason` is one of `input`, `timer`, `background_ready`, or `manual`. A recovery dispatch does not create a new manifest and does not change this field; `recovery` is recorded only as the reason on the new dispatch attempt.

At Manifest creation, `deadline` is `created_at + execution_timeout_ms` using the frozen resolved configuration and an injected monotonic anchor. It is the overall execution deadline for that Activation, not a fresh budget per attempt. Retry backoff and redispatch do not move it.

`input_items`, occurrences, ordering, cursor spans, lossy gaps, and the
Runtime-derived authorized neighbor projection wrappers are defined in
[Page, Delivery, and Subscription](03-page-delivery-subscription.md).
`output_page_ids` is the sorted unique output Page set from exactly
`graph_revision`. The Runtime MUST retain that graph snapshot, every source
Descriptor named by a neighbor wrapper, and the referenced resolved
configuration and authorization-policy snapshot until the Activation becomes
terminal.

`config_revision` identifies one immutable resolved configuration snapshot,
including its Host-only resolved feature flags. `effective_config` is the
complete Module-scoped, secret-reference-only object produced by the normative
shallow overlay of Extension configuration and Module configuration that the
same revision would place in `ModuleInstantiateParams.effective_config`; it
includes every Extension-visible materialized config field and MUST NOT omit a
value merely because the current process already has it in memory. Host-only
`feature_flags` remain frozen by the retained `config_revision` and are not
copied into this object. If an Extension needs a switch, its resolved value
MUST be a declared Extension or Module config field.
`effective_config_digest` is `sha256(JCS(effective_config))`.
`effective_config_schema_digest` content-addresses the complete closed
transitive schema bundle used to validate that value, using the bundle rule in
[Module Descriptor](../01-architecture/06-module-descriptor.md). These fields
materialize the referenced snapshot for execution; they do not create a second
authority independent of `config_revision`. The Runtime MUST verify all three
against the retained configuration before Manifest persistence and on every
load.

`REQ-ACT-001` — Every `module.activate` handler MUST execute against the exact
Manifest `effective_config` bytes and schema digest, never the Module's current
configuration merely because a later revision is active. A replacement
Extension generation is compatible with a live Manifest only when Host package
verification proves that generation can validate and execute that exact
`effective_config_schema_digest`; the request itself carries the complete
frozen value. If the proof is unavailable, the generation MUST NOT become
current for that Module or receive a lease for the Manifest. The Host keeps a
compatible generation, safely cancels the old Manifest before cutover, or
reports `ACTIVATION_CONTEXT_INCOMPATIBLE`; it MUST NOT dispatch under substituted
configuration.

The manifest digest is computed with `manifest_digest` omitted. Once the manifest transaction commits, every other manifest byte is immutable. A retry MUST use the same `activation_id`, canonical manifest bytes, and digest. New Page data, a Descriptor update, graph update, model change, or configuration change MUST NOT alter it.

Before persistence, the Runtime MUST prove that the complete canonical
`module.activate` request—Manifest, lease envelope with bounded fence values,
and bounded JSON-RPC wrapper—fits the effective negotiated
`max_frame_bytes` and complete-frame nesting limit. The proof MUST reserve the
maximum possible lexical width of `extension_generation`, `lease_generation`,
`attempt`, and the request ID for every retry allowed by the frozen policy; a
later retry MUST NOT become undispatchable merely because an integer gained a
digit. The inclusive resulting upper bounds are persisted as
`required_frame_bytes` and `required_frame_nesting_depth` and are covered by
`manifest_digest`. Configuration validation MUST prove them from the actual
canonical authorized neighbor projection-wrapper set and the configured batch
maxima. If the smallest otherwise eligible request cannot fit, the Runtime MUST
leave cursors unchanged and fail closed with `MANIFEST_FRAME_LIMIT`; it MUST
NOT persist an undispatchable Activation.

## 3. Persistent Activation states

| State | Manifest present | Active lease | Result staged | Cursor advanced | Terminal |
| --- | ---: | ---: | ---: | ---: | ---: |
| `ready` | yes | no | no | no | no |
| `leased` | yes | yes | no | no | no |
| `fencing` | yes | maybe | no | no | no |
| `retry_wait` | yes | no | no | no | no |
| `result_staged` | yes | no | yes | no | no |
| `commit_blocked` | yes | no | yes | no | no |
| `committed` | yes | no | yes | yes or empty | yes |
| `quarantined` | yes | no | maybe | no | no |
| `cancelled` | yes | no | no | no | yes |

Here “Active lease” means result-acceptance authority. A quarantined Activation
has no such authority even when the Runtime still retains a physical
execution-slot binding solely to complete a pending host fence.

Allowed transitions are:

```text
ready -> leased | cancelled | quarantined
leased -> result_staged | retry_wait | fencing | quarantined
fencing -> retry_wait | quarantined | cancelled
retry_wait -> leased | cancelled | quarantined
result_staged -> committed | commit_blocked | quarantined
commit_blocked -> committed | quarantined
quarantined -> ready | result_staged | cancelled
```

`cancelled` is permitted only if the Runtime proves that the manifest was never dispatched, or after fencing has made the old execution incapable of returning a valid result. Cancellation after an uncertain external side effect does not make that effect disappear and MUST record `outcome: unknown`.

Cancelling a non-dispatched or successfully fenced Activation MUST clear the Module's `nonterminal_activation_id` and return the Module to `idle` or its pending administrative state. Resolving quarantine to `ready` is permitted only when no authoritative result exists. If an authoritative staged result exists, a reviewed re-evaluation MAY return to `result_staged` only when it remains valid under the exact frozen policy; it MUST NOT substitute current limits, invoke the Module, or accept a replacement digest. In particular, a later trace-budget increase cannot re-authorize an Activation quarantined under its frozen hard limit.

## 4. Lease and generation fencing

Before every dispatch, the Runtime MUST bind the lease to the current persisted `worker_epoch` and `extension_generation`, then atomically:

1. increment `lease_generation`;
2. generate a new `LeaseToken`;
3. set `attempt := attempt + 1`;
4. persist the lease issue and expiry times; and
5. record the current `module_fence_generation` on the lease, install the
   matching Runtime-owned Module execution-slot binding, and transition the
   Activation to `leased`; and
6. persist dispatch state `prepared` for this attempt.

The dispatch envelope contains the immutable manifest plus:

```json
{
  "worker_epoch": "0198ab31-6c44-7e8a-b2bb-000000000010",
  "extension_generation": 7,
  "lease_generation": 3,
  "lease_token": "<base64url capability>",
  "attempt": 3
}
```

The token MUST be delivered only over the authenticated Extension transport. It MUST be redacted from logs and traces.
LeaseToken and retained token-hash comparisons that control result authority MUST use a constant-time comparison after the bound connection, Worker epoch, and generation checks pass.

Before lease issue, the Runtime MUST choose a Ready Extension generation whose
effective negotiated `max_frame_bytes` and complete-frame nesting limit are at
least the Manifest's two persisted required bounds and whose verified package
can execute the Manifest's exact `effective_config_schema_digest` and load
every retained schema bundle and semantic-validator revision named by an input
Action `contract_binding` targeted to this Module. An incompatible generation
MUST NOT receive that Manifest, become the Module's current generation while it
owns such a live Manifest, or cause an attempt/lease increment. The Runtime
waits for a compatible generation or reaches the immutable Manifest deadline;
it never shrinks, rebuilds, or re-digests the Manifest to accommodate a
replacement process.

Lease issue is not evidence that request bytes crossed the process boundary.
Immediately before the first frame byte can be written, a separate durable
transition MUST change that attempt's dispatch state from `prepared` to
`started` and retain the SHA-256 of the exact canonical frame. No byte may be
written while the marker is absent. The ordering is intentionally conservative:
a crash after `started` but before the socket write is treated as possibly
dispatched. A valid response records `response_received`; successful host
fencing records `fenced` together with the fence-evidence digest. These records
are retained for the Activation audit lifetime.

The v1 normalization defaults are `execution_timeout_ms = 120000`,
`lease_grace_ms = 30000`, and `fencing_grace_ms = 5000`. Lease expiry is the
effective execution deadline plus the configured lease grace; that extra
interval exists only for bounded transport completion and Runtime fencing and
MUST NOT authorize new Extension work. Configuration MAY set execution timeout
from 1 through 3,600 seconds, lease grace from 1 through 300 seconds, and
fencing grace from 0 through 60 seconds. The effective execution deadline MUST
be clamped to the immutable Manifest `deadline`; lease grace MAY extend past
that execution deadline but cannot make work after it conforming.

A resolved Module configuration MUST materialize `execution_timeout_ms`, `lease_grace_ms`, and `fencing_grace_ms`; dispatch MUST use the values frozen by the Manifest's `config_revision`.

Core v1 does not support Extension-requested Activation deadline or lease extension. A configuration change to `execution_timeout_ms` affects future Manifests only and MUST NOT change the current Manifest or lease.

Lease expiry does not prove that Extension code stopped. Before redispatching the same Activation, the Runtime MUST enter `fencing` and do one of:

- receive proof from a Runtime-owned execution host that it has forcibly removed the generation from its enforced per-Module execution registry; or
- terminate the hosting Extension process and observe process exit.

When the effective execution deadline is reached, the Runtime MUST request
cancellation and the Extension MUST begin no new work for that Activation. The
current lease remains the only authoritative fence during the configured lease
grace so a response already being completed or transported can still stage.
When lease expiry is reached without a staged result, the Runtime MUST reject
later results, enter `fencing`, and follow the proof rules above. It MUST NOT
move directly from expiry to redispatch.

On entering `fencing`, the Runtime MAY request cancellation and wait at most the configured `fencing_grace_ms`. If host-owned proof of an empty execution slot is still absent at that deadline, it MUST terminate the hosting Extension process; the grace interval MUST NOT authorize redispatch.

An acknowledgement emitted only by ordinary untrusted Extension code is not proof and MUST NOT avoid process termination. Only after a valid fence MAY a new lease generation be issued. This preserves single-flight even when an Extension ignores cancellation. Surviving remote side effects remain subject to section 9.

If one Extension process hosts several Modules, terminating it fences every leased Activation in that process. The Runtime MUST transition each affected Activation according to its own attempt and retry policy before restarting the process; it MUST NOT assume that unrelated in-flight calls completed.

A result received after lease expiry, or whose Worker epoch, Extension generation, lease generation, or token does not match the current lease, fails with `ACTIVATION_STALE_LEASE` and cannot stage a result. It MUST NOT advance a cursor or create a Block.

## 5. ActivationResult and result digest

The response envelope is:

```json
{
  "worker_epoch": "0198ab31-6c44-7e8a-b2bb-000000000010",
  "extension_generation": 7,
  "activation_id": "0198ab31-6c44-7e8a-b2bb-000000000004",
  "manifest_digest": "sha256:...",
  "lease_generation": 3,
  "lease_token": "<base64url capability>",
  "payload": {
    "status": "success",
    "output": null,
    "scheduling_hint": null,
    "error": null
  },
  "result_digest": "sha256:..."
}
```

`result_digest` is computed over canonical `payload` only. It deliberately excludes Worker epoch, Extension generation, lease generation, and token, so a byte-equivalent result has the same digest across fenced retry generations.

`payload.status` is one of:

| Status | `output` | Cursor behavior | Next state |
| --- | --- | --- | --- |
| `success` | zero or one BlockDraft | commit on successful Runtime transaction | `result_staged` |
| `retryable_failure` | MUST be `null`; scheduling hint also MUST be `null` | unchanged | `retry_wait`, or `quarantined` when attempts are exhausted |
| `permanent_failure` | MUST be `null`; scheduling hint also MUST be `null` | unchanged | `quarantined` |

An error object is REQUIRED for either failure status and forbidden for success.
For `retryable_failure`, `error.retryable` MUST be `true`; for
`permanent_failure`, it MUST be `false`. A successful empty output still
consumes the frozen input when committed.

The Runtime MUST completely validate and canonicalize the first result received under the current valid fence before persisting it. Before that validation it MUST atomically observe that the Module's `nonterminal_activation_id`, current execution-slot binding, and `module_fence_generation` still authorize exactly this Activation and result fence. Validation includes the BlockDraft schema, trusted-field exclusion, quotas, Action targets against the frozen graph, and existence and ordering of every local Block/Asset reference. Persisting a staged result MUST make those referenced objects GC roots until the Activation is terminal. The persisted payload creates the authoritative staged digest.

A result that fails this validation is a protocol violation. The Runtime MUST quarantine the Activation and Module, retain the invalid bytes subject to secret redaction, and MUST NOT wait for another result under the same lease.

After a result is staged or committed:

- a repeated result with the same `result_digest` is an idempotent duplicate and receives the existing disposition;
- any result authenticated by the bound Extension connection, Worker epoch, Extension generation, and a token hash retained for an actually issued lease generation of the same `activation_id` and manifest, with a different `result_digest`, is `ACTIVATION_RESULT_CONFLICT`;
- on conflict, the Runtime MUST quarantine the Activation and Module, retain both payloads as security-sensitive evidence, and MUST NOT choose the later result; and
- a result committed before a later conflict remains in `committed`; Core MUST NOT roll it back. A separate Quarantine record is created and the Module is quarantined.

A stale-lease response received before any result is staged is rejected as stale and does not establish an authoritative digest.

The Runtime MUST retain issued Worker epoch, Extension generation, lease generation, and token hashes for the Activation's audit lifetime. An unauthenticated value or a token never issued for that Activation MUST be rejected without performing result-conflict comparison; otherwise an attacker could quarantine a Module by guessing an Activation ID.

## 6. Result commit

For a staged successful result, the Runtime performs one SQLite transaction:

```text
verify activation is result_staged or commit_blocked
verify persisted manifest_digest and staged result_digest
verify every durable subscription cursor equals its frozen span start
if output is not null:
    validate BlockDraft
    create one immutable Block with Runtime identity
    causal_parents := all distinct input BlockIds in the manifest
    outputs := manifest.output_page_ids (not the current graph)
    project every durable input cursor to its frozen span end
    preflight every durable output Page against the projected cursor-and-append
        state defined by REQ-PAGE-001
    append the Block to every durable output Page
    reserve every lossy output Page sequence and persist its non-replayable append audit
advance every durable input cursor to its frozen span end
record every lossy input cursor span and exact frozen-gap disposition for post-commit in-memory application
mark Activation committed with result_digest
append journal records
commit
apply lossy input cursor changes and remove only dispositioned gaps in memory
if output is not null:
    append the output to every lossy output Page under lossy semantics
```

The output Page set is unconditional. The Module cannot add, remove, or replace outputs in its result. Action targets, scheduling hints, current topology, Page pressure, and Runtime heuristics MUST NOT cause partial durable fan-out.

If any durable output cannot admit the Block, the transaction is not attempted or is rolled back, state becomes `commit_blocked`, and the Runtime retries commit without invoking the Module again. A staged result MUST NOT be discarded merely because backpressure lasted a long time.

If a manifest has only lossy outputs, Core still durably commits the Block, cursor advances, result digest, lossy Page sequence high-water marks, and non-replayable append-audit rows before attempting the in-memory appends.

## 7. Failure and retry policy

The v1 normalized defaults are `max_attempts = 5`, `retry_base_ms = 500`, and
`retry_cap_ms = 30000`. Retry delay uses full-jitter exponential backoff:

```text
upper_bound = min(retry_cap_ms, retry_base_ms * 2^(attempt - 1))
delay = uniform(0, upper_bound)
```

`upper_bound` and `delay` are whole milliseconds. `uniform(0, upper_bound)` is
an unbiased inclusive integer sample from the injected random source; the
implementation MUST clamp to `retry_cap_ms` before any exponentiation could
overflow. The sampled delay MUST be persisted so recovery does not resample it. Operators
MAY configure 1 through 64 total attempts; `1` means no automatic redispatch.
`retry_base_ms` MUST be at most `retry_cap_ms`. Exhaustion transitions to
`quarantined`; input cursors remain unchanged.

A resolved Module configuration MUST materialize `max_attempts`, `retry_base_ms`, and `retry_cap_ms`; a retry MUST use the values frozen by the Manifest's `config_revision`.

Protocol/schema violations, forged identities, and result-digest conflicts are
never automatically retryable. A valid `retryable_failure` response is an
explicit Extension assertion of safe retry: it releases the Runtime-owned
execution slot and may enter `retry_wait` without process fencing.

For a crash, process exit, or transport loss with no authoritative result, the
Runtime first fences the prior execution. If that attempt remained durably
`prepared`, it was provably never dispatched and may retry subject to deadline
and attempt limits. If it reached `started`, automatic redispatch is governed
only by the `activation_replay_contract` from the exact own Descriptor revision
and resolved configuration revision frozen by the Manifest:

- `never_auto_retry` + `none` quarantines with
  `ACTIVATION_REPLAY_NOT_AUTHORIZED`; only a reviewed operator decision may
  create another attempt;
- `fenced_replay` + `pure_compute` permits same-Activation redispatch only while
  Runtime evidence confirms that the handler used no Host service, Extension
  effect ledger, or external side-effect path; contradictory evidence is
  `ACTIVATION_REPLAY_CONTRACT_VIOLATION`; and
- `fenced_replay` + `activation_ledger` permits same-Activation redispatch only
  to a generation bound to the approved durable ledger namespace and schema
  version. The handler MUST look up `(activation_id, manifest_digest)` before
  any effect, return its prior result when present, and reconcile an incomplete
  intent rather than issue the effect again.

Before authorizing the `activation_ledger` case, the Runtime MUST persist one
Host-owned record conforming to the
[activation replay evidence schema](../../../schemas/activation-replay-evidence.schema.json).
The canonical record MUST bind the exact `module_id`, `activation_id`,
`manifest_digest`, source attempt, proposed target Extension generation, and
ledger descriptor from the frozen replay contract. Its continuity proof MUST
bind either the retained ledger state or the approved migration operation and
resulting state digest. The one-shot next-attempt authorization MUST use
`sha256(JCS(record))` as its `evidence_digest`; the ordinary host-fence digest
is necessary fencing evidence but is not ledger replay evidence.

`ledger_state` values `absent`, `unknown`, or `corrupt`, any schema/digest or
binding failure, and any otherwise unresolved outcome MUST quarantine the
Activation and MUST NOT create a replay authorization. `complete` is eligible
only with `replay_disposition: return_result` and authorizes the target
generation solely to return the already recorded canonical result.
`reconcilable` is eligible only with `replay_disposition: reconcile_only` and
authorizes that generation solely to reconcile the existing intent/effect. It
MUST NOT issue the external effect again; inability to reconcile to a proven
terminal disposition becomes `ACTIVATION_EXTERNAL_OUTCOME_UNKNOWN`.

The normalized contract and its source Descriptor/configuration revisions,
per-attempt dispatch state/frame digest, fence evidence, Host-owned activation
replay evidence and digest, and the selected replay disposition MUST be durable
and queryable. A package update or current
configuration MUST NOT upgrade an existing Activation's authority. If ledger
state is absent, incompatible, corrupt, or yields an unresolved external
outcome, the Activation transitions to `quarantined` with
`ACTIVATION_EXTERNAL_OUTCOME_UNKNOWN`; the Runtime MUST NOT blindly
redispatch it.

The Runtime MUST NOT issue a new lease after the immutable Manifest `deadline`. If no authoritative result exists when that deadline prevents further dispatch, the Activation and Module transition to `quarantined` with `ACTIVATION_DEADLINE_EXCEEDED`; input cursors remain unchanged. A result already staged before the deadline continues through `ApplyResult` and is not reinvoked.

## 8. Scheduling hints

A success payload MAY contain:

```json
{
  "not_before": "2026-08-10T18:31:00.000000Z",
  "desired_by": "2026-08-10T18:32:00.000000Z",
  "load_signal": "underloaded"
}
```

`load_signal` is one of `underloaded`, `balanced`, or `overloaded`. A hint is untrusted. The Runtime MUST validate and clamp it to policy, MUST record whether it was accepted, and MUST NOT let it change the current manifest, current cursor commit, or retry correctness.

## 9. External side effects

The Runtime's SQLite transaction provides exactly-once **internal commit per Activation**, enforced by unique `activation_id` and Delivery constraints. It does not provide exactly-once effects in email, filesystems, remote APIs, MCP servers, model providers, or any Extension-owned database.

An Extension performing an external side effect:

- MUST use a stable idempotency key derived from `activation_id` and a stable operation ordinal when the target supports it;
- MUST persist an intent in its own effect ledger before a non-idempotent or billable request is sent, and MUST persist the observed outcome before reporting success;
- MUST distinguish `not_started`, `succeeded`, `failed`, and `unknown` outcomes;
- MUST NOT report a retryable safe failure when the remote outcome is unknown unless re-execution is idempotent; and
- SHOULD expose a reconciliation operation for unknown outcomes.

The Runtime MUST preserve the same `activation_id` across retries. Creating a new Activation to “try again” an unknown effect is forbidden unless an operator explicitly starts a new semantic operation.

On replay after an Extension crash, a ledgered intent without a proven terminal remote outcome MUST resolve to `unknown` or a status query; the Extension MUST NOT send the operation again merely because its prior response to the Runtime was lost.

## 10. Errors

| Code | Retryable | Meaning |
| --- | ---: | --- |
| `ACTIVATION_STALE_LEASE` | no for this response | token or generation is not current |
| `ACTIVATION_MANIFEST_MISMATCH` | no | response names different manifest bytes |
| `ACTIVATION_RESULT_DIGEST_MISMATCH` | no | declared digest does not match payload |
| `ACTIVATION_INVALID_RESULT` | no | result payload, BlockDraft, target, quota, or reference validation failed |
| `ACTIVATION_RESULT_CONFLICT` | no | two accepted payload digests disagree |
| `ACTIVATION_RETRY_EXHAUSTED` | no | configured automatic attempts are exhausted |
| `ACTIVATION_DEADLINE_EXCEEDED` | no | immutable Manifest deadline prevents another dispatch; operator review is required |
| `ACTIVATION_REPLAY_NOT_AUTHORIZED` | no | a dispatched attempt's frozen replay contract forbids automatic redispatch |
| `ACTIVATION_REPLAY_CONTRACT_VIOLATION` | no | observed effects or ledger state contradict the approved replay evidence |
| `ACTIVATION_EXTERNAL_OUTCOME_UNKNOWN` | no | external effect may have occurred and safe replay or reconciliation is unavailable |
| `ACTIVATION_FRAME_INCOMPATIBLE` | after compatible generation | candidate Extension generation cannot carry this immutable Manifest's required frame bounds |
| `ACTIVATION_CONTEXT_INCOMPATIBLE` | after compatible generation, reviewed cancellation, or audited input disposition | candidate Extension generation cannot execute the Manifest's frozen effective-configuration schema/bytes or a targeted input Action's creation-time binding |
| `ACTIVATION_CURSOR_CONFLICT` | no | frozen cursor start is no longer current; instance enters `RecoveryRequired` |
| `ACTIVATION_COMMIT_BLOCKED` | yes | durable Page backpressure prevents commit |
| `ACTIVATION_CAPACITY_DELAYED` | yes | instance-wide nonterminal Activation limit delays Manifest creation without consuming input |
| `MODULE_BUSY` | yes | another nonterminal Activation owns the Module |
| `MODULE_QUARANTINED` | no | operator review is required |
| `MODULE_FENCE_FAILED` | no | prior execution could not be proven stopped |

## 11. Invariants

- **INV-ACTIVATION-001 — Single flight.** A Module has at most one nonterminal Activation and one valid execution lease.
- **INV-ACTIVATION-002 — Frozen replay.** All retries use byte-identical persisted manifest bytes and the same `activation_id`.
- **INV-ACTIVATION-003 — Fenced authority.** Only a result carrying the current Worker epoch, Extension generation, lease token and generation, Activation ID, and manifest digest, while the matching current Module execution fence remains authoritative, MAY first stage a result.
- **INV-ACTIVATION-004 — Result consistency.** Once authoritative, a different result digest quarantines the Activation and Module.
- **INV-ACTIVATION-005 — Atomic durable effect.** Block creation, complete durable fan-out, every lossy append reservation, durable input cursor advancement, and Activation commit occur together or not at all.
- **INV-ACTIVATION-006 — Empty success consumes.** A committed successful result with no output still advances the frozen input cursor spans.
- **INV-ACTIVATION-007 — Frozen outputs.** Every non-null output is routed to all and only output Pages in the manifest's graph revision.
- **INV-ACTIVATION-008 — Internal boundary.** Exactly-once claims stop at the Runtime SQLite transaction boundary.
- **INV-ACTIVATION-009 — Frozen replay authority.** A dispatched attempt is
  automatically repeated only when its own frozen replay contract and durable
  fence/dispatch evidence authorize that exact same Activation.
- **INV-ACTIVATION-010 — Frame continuity.** Every selected Extension generation
  can carry the immutable Manifest under both persisted frame bounds; process
  replacement never rewrites the Manifest.
- **INV-ACTIVATION-011 — Effective-configuration continuity.** The complete Module-scoped effective configuration and its value/schema digests are Manifest bytes; every generation executes those exact bytes or receives no lease.

## 12. Crash expectations

| Crash point | Required recovery |
| --- | --- |
| after manifest commit, before lease | Activation returns to `ready` with identical bytes |
| after lease persistence, before durable dispatch marker | lease is fenced; the provably undelivered identical Manifest may retry under a new lease generation |
| after durable dispatch marker, before response | cursor unchanged; fence first, then the frozen replay contract uniquely selects retry or quarantine |
| after response bytes, before staging | no authoritative result exists; fence first, then the same frozen replay rule applies |
| after result staging, before commit | Runtime applies the staged payload without invoking the Module again |
| during commit transaction | SQLite rollback leaves staged result and unchanged cursors |
| after commit, before acknowledgement | duplicate result receives committed disposition; no duplicate durable output |

The complete transition system is restated as an executable reference in [Reference Abstract Machine](07-reference-abstract-machine.md).
