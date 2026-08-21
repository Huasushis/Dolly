# Host Services and Capability Enforcement

Status: normative for Extension-to-Host calls.

## 1. Security model

Third-party Extensions are untrusted by default. A manifest is a request for capabilities, not an authorization grant. The Host **MUST** apply deny-by-default policy and grant only capabilities explicitly enabled for that Extension alias and, where applicable, Module ID.

Process separation alone is not a security boundary. If the platform cannot enforce the configured filesystem, process, and network restrictions, the Host **MUST NOT** run an untrusted Extension unless an authenticated administrator enables a clearly labelled unsafe override. That override **MUST** be journaled and visible in health status.

Host services are the only supported route for an untrusted Extension to access Runtime Blocks, Assets, models, scheduling, configuration proposals, logs, and metrics.

## 2. Grant identity and enforcement

At successful initialization, the Host creates a capability grant bound to:

- instance ID;
- Extension alias and verified package digest;
- Worker epoch and Extension generation;
- the private pipe connection;
- optional Module IDs;
- method and object scopes;
- quotas and expiry; and
- policy revision.

The grant **MUST NOT** be placed in environment variables, command-line arguments, logs, or files readable by other Extensions. A JSON grant identifier is only a correlation value; authorization **MUST** also verify the connection, epoch, and generation.

Every Host-service call **MUST** be authorized before resolving object IDs, opening files, issuing network requests, or allocating large buffers. Revocation is immediate for new calls. In-flight calls MAY finish only if their method contract and revocation reason permit it.

## 3. Capability vocabulary

V1 capabilities use stable names and explicit scopes. At minimum:

| Capability | Permitted service | Required scope examples |
| --- | --- | --- |
| `host.blocks.read` | `host.block.get` | Block IDs reachable from current input, or configured Page/time range |
| `host.blocks.pin` | `host.block.pin`, `host.block.unpin` | owner Module, maximum duration/count/bytes |
| `host.assets.read` | metadata/read stream/materialize view | Asset IDs reachable from authorized Blocks |
| `host.assets.import` | `host.asset.import`, `host.asset.status` | own Import IDs; byte, media-type, origin, and storage quotas |
| `host.models.invoke` | `host.model.invoke` | Provider/model allowlist, input and output modalities, token/output-Asset-byte/cost/rate budgets |
| `host.tools.invoke` | `host.tool.invoke`, `host.tool.status` | server/tool/schema digest, arguments, side-effect class, confirmation, rate/time/output limits |
| `host.ingress.submit` | `host.ingress.submit`, `host.ingress.status` | own Module, exact target Pages, Block/byte/rate quotas |
| `host.activation.status` | `host.activation.status` | own Module's Activation IDs |
| `host.operation.status` | `host.operation.status` | own durable Host-operation IDs and their original method scope |
| `host.module.activate` | request Activation | own Module IDs, request rate, accepted reasons |
| `host.module.wakeup` | request wakeup | own Module IDs, horizon and outstanding-count limits |
| `host.config.propose` | propose JSON Patch | allowed paths and approval class; never direct apply |
| `host.log.emit` | structured log event | level, bytes/sec, field allowlist |
| `host.metrics.record` | bounded metric samples | metric names, label keys/cardinality, samples/sec |

A capability name without an object scope **MUST NOT** be interpreted as access to every object. Wildcard scope requires a separate explicit administrator grant.

An Extension **MUST NOT** call another Extension directly or request a capability on another Extension's behalf. Cross-Module communication uses committed Blocks, Actions, and configured Pages.

## 4. Common request context

Every Host-service request **MUST** resolve to exactly one Module or
initialization context and one canonical operation identity. Authority comes
from the authenticated pipe grant; a caller-supplied instance or Module field is
only a consistency check and **MUST NOT** select a different authority scope.
The canonical operation-identity field is `operation_id`, except that
`host.model.invoke` names the same concept `request_id` and
`host.asset.import` names it `import_id`. Those aliases have the same UUIDv7,
conflict, retention, retry, and audit semantics as `operation_id`; a retry
**MUST NOT** replace one with a fresh value.

Calls performed for an Activation **MUST** also carry the Activation ID and
lease token in their method schema or common request context. The Host **MUST**
reject a stale, unknown, or completed lease when a method requires live
Activation authority. A method that permits Module background work **MUST** say
so explicitly and still requires the current authenticated process grant.

Side-effecting services **MUST** define an idempotency key and a durable status query. Repeating the same key with identical arguments **MUST** return the original result. Repeating it with different arguments **MUST** fail with `revision_conflict`.

`host.operation.status` is the generic reconciliation path only for the target
methods enumerated by
[`host-operation-status.schema.json`](../../../schemas/host-operation-status.schema.json).
Its request has its own read `operation_id` and names the original method and
`target_operation_id`. The Host MUST authorize both the status capability and
the original method/object scope before revealing whether the target exists.
The read never starts, retries, cancels, or advances work. For an admitted
generic-status target, `absent` proves no durable pre-effect record exists, but
the target method's authorization transaction remains the only authority for a
later attempt; `unknown` preserves an unproved external outcome and forbids a
fresh semantic identity. Asset import, Tool, ingress, and Activation state
retain their dedicated status methods and MUST be rejected as generic status
targets. In particular, Tool `absent` is never dispatch or redispatch
authority.

Authorization success does not imply the operation succeeded. Responses **MUST** distinguish policy denial, invalid object scope, resource exhaustion, retryable service failure, and permanent failure.

## 5. Block services

`host.block.get` **MUST** return only immutable committed records. Drafts and uncommitted Activation output are not addressable.

Block get, pin, and unpin params and pin results MUST conform to the respective
definitions in
[`host-resource-rpc.schema.json`](../../../schemas/host-resource-rpc.schema.json).
`host.block.get` returns the existing authoritative `block.schema.json`
envelope. Pin and unpin MUST persist their operation identity and semantic
digest in the same transaction as the pin disposition; lost responses are
reconciled through `host.operation.status`.

The Host **MUST** enforce reachability or configured query scope before revealing whether a Block exists. An unauthorized and a nonexistent Block **SHOULD** be indistinguishable to an untrusted Extension.

Pins **MUST** include owner, reason, creation time, expiry, and byte accounting. Infinite pins are forbidden for untrusted Extensions. Pin creation and renewal **MUST** respect per-Module and per-Extension quotas. Process exit does not by itself remove a durable pin; the documented pin policy determines expiry.

## 6. Ingress and Activation status services

`host.ingress.submit` is the sole Extension-accessible route for publishing an
external draft outside an Activation. It is intended for authenticated Channel
adapters; a grant MUST name the caller Module and exact permitted Page set. The
Host derives producer identity, assigns Ingress/Block/Action/trace identities,
and performs the Core all-or-nothing ingress transaction. The Extension cannot
choose a trusted producer or append one Page at a time.

`host.ingress.status` is a read of the ingress idempotency ledger scoped to the
same authenticated principal. `host.activation.status` exposes only the
caller's own Module Activations and is the authoritative reconciliation source
for Extension-local prepared state. Neither status method requires a live
Activation lease, but both require the current authenticated process grant and
are rate-limited. Status reads never create, retry, cancel, or commit work.
Activation status includes only Host-owned dispatch evidence and the frozen
Runtime-approved replay contract; a caller cannot alter either by supplying a
status request or reconnecting under a new process generation.

## 7. Asset services

Asset access **MUST** use opaque IDs and bounded streams or platform handles created by the Host. An Extension **MUST NOT** receive the instance asset-store root merely because it can read one Asset.

`host.asset.import` accepts the closed preprocessed input in
`schemas/asset-import.schema.json`. It is explicitly permitted as Module
background work when no `activation_id`/`lease_token` pair is present; an import
performed for an Activation MUST carry both fields and pass the live-lease
check. The Host derives caller authority from the pipe grant, treats
`instance_id` and `module_id` only as consistency checks, and persists the
Import record before acquisition. `host.asset.import` returns the non-`absent`
`ImportResult` fragment and `host.asset.status` returns the `StatusResult`
fragment in `schemas/asset-status.schema.json`; the status request uses
`schemas/asset-status-request.schema.json`.

A repeated byte-identical import with the same `import_id` returns the recorded
state. After transport loss, the caller MUST use `host.asset.status`; only
`absent` permits replay, while `available`, terminal failure, and every
in-progress state are authoritative. The status read is scoped to Import IDs
owned by the authenticated Module. Unauthorized and unknown Import IDs SHOULD be
indistinguishable.

`asset_input` is protocol terminology for these preprocessed import parameters,
not an additional Part or trusted field accepted by `BlockDraft`. Once an import
is `available`, only its ordinary Asset Part reference may be placed in a draft.

For every import, the Host **MUST** enforce:

- declared and observed byte limits;
- media-type allowlists and content sniffing policy;
- hashing while streaming into a private temporary file;
- atomic publication only after complete validation;
- decoder pixel/dimension/frame limits;
- archive and decompression expansion limits; and
- cleanup of partial files after crash or deadline.

For remote URLs the Host **MUST** apply the threat-model SSRF policy to the initial target and every redirect. DNS resolution **MUST** be revalidated at connection time. Loopback, link-local, private, multicast, metadata-service, Unix-socket, file, and unsupported schemes are denied by default.

Every `remote_url` import MUST also carry the positive operation-local
`max_bytes` value required by the import schema; a content length is a hint,
not permission to cross that bound.

For module-file imports the Host **MUST** resolve paths relative to an authorized root without following escaping symlinks, junctions, or reparse points. A prior string `canonicalize` check alone is insufficient because of time-of-check/time-of-use races.

Asset views **MUST** be validated before decoder allocation. A view is immutable and **MUST** retain a reference to its source Asset until its own references expire.

`host.asset.get` and `host.asset.materialize_view` MUST use the closed resource
params/results in `host-resource-rpc.schema.json`. An Asset read returns only
metadata, bounded inline Base64, or a bounded expiring stream capability; it
never returns an instance path. Materializing a view persists the operation
record before decoder work and publishes the immutable derived Asset at its
commit point. A lost view response is reconciled with
`host.operation.status`.

## 8. Model service

`host.model.invoke` **MUST** be mediated by the Model Gateway. API keys **MUST NOT** be returned to the Extension. The Host **MUST** clear inherited credential and proxy environment variables unless policy explicitly requires them.

The grant **MUST** bound Provider, model, input and requested output modalities,
maximum input/output tokens, aggregate output-Asset bytes, concurrent requests,
rate, and cost. Before network send, the Host MUST prove that the requested
output set is a subset of both the pinned profile and the authenticated grant;
`unknown` is not support. The Host **MUST** record an idempotency/request ID
before sending a billable request. A transport timeout after Provider
acceptance is an indeterminate billable outcome; automatic retry **MUST**
follow Provider-specific policy and **MUST NOT** claim exactly-once billing.

Provider responses, reasoning transcripts, and prompts are sensitive payloads. Their storage and logging require an explicit retention policy.

The Host MUST insert the `host.model.invoke` request identity and semantic
digest before Provider dispatch. After transport loss the Extension queries
`host.operation.status` with target method `host.model.invoke`. `absent` proves
the Provider was not dispatched by this Host operation. Provider acceptance
without a reconciled response is `unknown`; it MUST NOT be auto-replayed merely
to obtain a response or billing record.

Provider media is not returned directly. For every normalized output ordinal,
the Host persists one `(authenticated Module, request_id, ordinal)` to
`import_id` binding and imports Provider bytes or a typed temporary HTTPS URL
through the Asset Service. While any such import is nonterminal,
`host.operation.status` for the model operation reports `running`,
`terminal=false`, and a null result. The model operation succeeds only after
all imports are `available` and their sniffed MIME types and byte lengths pass
the original request. Restart reconciles the same Import IDs and MUST NOT
redispatch the Provider. A post-Provider MIME, size, decoder, or URL-expiry
failure is terminal `failed` with `outcome: applied`, never a partial success
that silently omits media.

## 9. Tool broker

In v1 the Host owns each configured MCP `2025-06-18` tool-server
transport. An Extension is the logical client through `host.tool.invoke`; it
does not inherit the server process, socket, credential, or network authority.
The complete registry, transport-generation, credential-binding, update, and
reconciliation contract is defined by the normative
[Tool Broker](../services/tool-broker.md) chapter. The request MUST conform to
`schemas/tool-invoke.schema.json`: `tool_name` is the configured stable alias,
and `config_revision` selects the retained immutable Tool Broker registry
snapshot. The Host rejects a server, alias, schema digest, or configuration
revision that does not identify one exact enabled entry; it never falls forward
to the current registry. It then checks the exact arguments, side-effect class,
Activation lease, capability, optional human confirmation, and all quotas
before recording `AUTHORIZED` and dispatching. "Equivalent" or "latest" is
not a valid protocol version: candidate prepare must complete the exact legacy
initialize/initialized lifecycle, and later MCP stateless or multi-round-trip
messages are rejected under `REQ-TOOL-008`.

For `host.tool.invoke`, `operation_id` is also the canonical `tool_call_id` for
one immutable Tool operation. Reuse with the same semantic input returns its
recorded state/result; reuse with different input is a conflict. A scoped
`absent` status is only a read observation and grants no dispatch or redispatch
authority. A later invoke under that identity can proceed only through the Tool
Broker's atomic absent-row authorization transaction with a current live lease
and all current checks. A later attempt after a terminal `not_applied` result is
a newly authorized operation with a new ID, not a retry.
`tool_transaction_id` groups the model proposal, Tool result, and dependent
continuation but grants no replay authority. A later `host.tool.status` has its
own request `operation_id` and names the original call as
`target_operation_id`; it requires the caller's current authenticated Module
grant.

The Host MUST first require the request `module_id` to match the authenticated
Module, then query only `(authenticated_module_id,target_operation_id)`. The
status result's `operation_id` is the original `target_operation_id`, not the
fresh read ID. If that composite key is absent, status returns `absent` even if
another Module owns the same target UUID; no global UUID lookup or existence
oracle is allowed. This field therefore has the same meaning in an invoke
result and a later status result: the Tool call whose disposition is being
represented.

The accepted Host Tool-call ledger states are `AUTHORIZED`, `DISPATCHED`,
`SUCCEEDED`, `FAILED`, and `UNKNOWN`; wire results use their lowercase
equivalents from `schemas/tool-result.schema.json`. The closed durable binding
and ledger-record schemas are defined by the Tool Broker chapter. A wire
`denied` result is a pre-authorization response and creates no new Host call
row. Invoke uses the non-`absent` `InvokeResult` fragment; status uses
`StatusResult`.

`AUTHORIZED` proves through the exclusive send gate that no request byte was
eligible. The same operation can continue only to its exact frozen generation,
before its stored deadline, after the durable compare-and-set to `DISPATCHED`.
If that generation is unusable, zero-byte proof permits the immutable
failed/not-applied result `TOOL_DISPATCH_NOT_APPLIED`; inability to prove the
boundary first crosses to `DISPATCHED` without sending and then becomes
`unknown`. Once `DISPATCHED`, the Host may accept only the original request's
late response from its retained generation. Loss of an authoritative result
becomes `unknown`; no result, acknowledgement, error, timeout, or absence
authorizes automatic redispatch or an invented upstream status call. Tool
output is bounded untrusted data and grants no capability.

## 10. Scheduling services

An Extension MAY request its own Module Activation or wakeup only within its scope. The Host remains authoritative: it validates time bounds, coalesces equivalent requests, applies quotas, and **MAY** reject or delay hints.

Wakeups **MUST** use a durable idempotency key. Repeated requests with the same key update only as the method schema permits. An Extension **MUST NOT** create an unbounded number of distinct wakeups to bypass activation-rate limits.

Activation and wakeup requests and their success results MUST conform to the
corresponding `$defs` in
[`host-control-rpc.schema.json`](../../../schemas/host-control-rpc.schema.json).
The Host persists the operation digest with the scheduling/coalescing decision
before success. Loss is reconciled through `host.operation.status`; callers
MUST NOT mint another identity to bypass coalescing, horizon, or rate limits.

## 11. Configuration proposals

`host.config.propose` creates a proposal only. It **MUST NOT** change active configuration. The request **MUST** include a base revision, JSON Patch, reason, expected impact, and rollback condition. Authorization is checked for every JSON Pointer path.

The control plane decides whether a proposal is rejected, requires approval, or enters a configuration transaction. The proposing Extension **MUST NOT** approve its own elevated proposal.

Params MUST conform to
[`config-proposal.schema.json`](../../../schemas/config-proposal.schema.json),
including its absolute deadline, and success MUST conform to
`ConfigProposeResult` in `host-control-rpc.schema.json`. The proposal row and
operation digest are committed together. A lost response is reconciled through
`host.operation.status`; proposal creation never implies approval or active
configuration.

## 12. Logs and metrics

Extension logs and metrics are untrusted input. The Host **MUST**:

- add authoritative instance, Extension, generation, and Module fields;
- reject attempts to overwrite authoritative fields;
- redact known secret formats and configured sensitive fields;
- enforce event-size and byte-rate limits;
- escape terminal/control characters in human views; and
- cap metric name and label cardinality.

`host.log.emit` and `host.metrics.record` notification params MUST conform to
`LogEmitParams` and `MetricsRecordParams` in
[`extension-notification-rpc.schema.json`](../../../schemas/extension-notification-rpc.schema.json).
Unknown members, oversized batches, invalid names, and excessive label sets are
invalid notification input and confer no durable acknowledgement.

Payload logging is disabled by default. A capability to emit logs does not authorize an Extension to exfiltrate Block, prompt, Asset, or secret contents.

## 13. Filesystem, process, and network policy

An untrusted Extension starts with no ambient filesystem, child-process, or network authority. Platform sandboxing **MUST** implement the effective grant. Writable storage **SHOULD** be a Module-private brokered directory or opaque storage service. Shared Extension storage requires an explicit capability and quota.

### 13.1 Module storage isolation

`REQ-XCAP-003` — The Host MUST allocate a stable, never-reused
`storage_scope_id` for each logical Module and bind every Module-state handle to
that ID, the daemon installation, instance, Extension alias, Module ID, package
policy, Worker epoch, and current generation. Two Modules, two aliases, or two
Dolly instances MUST NOT receive capabilities resolving to the same writable
logical namespace unless an explicit shared-state contract names all
participants and its concurrency and migration semantics.

The capability token, not a caller-selected path, opens the state directory.
Normal Module configuration MUST NOT use a writable absolute database path or
raw database credential as an isolation mechanism. An Extension process hosting
several Modules keeps a separate connection/pool per scope or uses an
Extension-owned physical database whose every semantic primary/foreign key and
transaction includes `storage_scope_id`.

If several Modules intentionally use one external database service, the Host or
adapter MUST derive a collision-resistant tenant/schema prefix from the scope
ID, verify ownership before first write, and reject a pre-existing prefix owned
by a different scope. A backend that cannot enforce transactional tenant
isolation is non-conforming for shared use. Filesystem deduplication or one
physical database is an implementation detail and cannot weaken logical
isolation.

Snapshot, restore, migration, backup, and deletion MUST bind the scope ID.
Missing state does not authorize silent empty initialization when prior Host
records name that scope. State from another scope cannot be adopted by changing
a path or Module ID; adoption is an explicit offline migration with source and
target digests. Extension-level storage is limited to package-global caches and
catalogs unless an accepted shared-state contract says otherwise; it MUST NOT
hold per-Module Memory, cursor, policy, filter, or side-effect state without the
scope key.

### 13.2 Active-writer ownership and handoff

For each `(daemon_installation_id, instance_id, storage_scope_id)` the Host
MUST persist this writer state independently of Extension process state:

```text
Unowned -> Granted(writer_generation, owner) -> Releasing -> Released
Released -> Granted(writer_generation + 1, new_owner)
Releasing -> WriteFencedUnknown
WriteFencedUnknown -> Released       (Host/backend proof or operator repair)
```

`writer_generation` is a positive safe JSON integer, monotonically increasing
for that scope and included in backup metadata. Exhaustion fences the scope and
requires offline repair; it never wraps. The owner binds daemon installation,
instance, Extension alias, Module ID, Worker epoch, Extension generation, and
the connection-bound capability. At most one live handle may have
`access_mode=active_read_write`. Read-only access and writes to an independent
staging copy do not own the active namespace.

The Host MUST durably enter `Releasing`, stop new work, and revoke the old grant
before granting the next writer generation. A brokered service must reject all
writes carrying an old generation. If an Extension received a local OS handle
that cannot be revoked, the complete process lifecycle container and descendants
must be observed terminated before release. If either fact is uncertain, the
scope enters `WriteFencedUnknown`; no candidate receives active write authority.
An Extension acknowledgement, timeout, PID disappearance, SQLite transaction
serialization, or new process generation alone is not release proof.

A candidate package MAY receive `read_only` or `staging_read_write` handles
while the old active writer exists. Staging bytes are not authoritative and
cannot receive production Activations. Because v1 has no RPC that upgrades an
initialized handle in place, the simplest conforming replacement terminates a
staging probe and starts the serving generation only after writer release.

For an external shared database, every semantic write transaction must
atomically compare the current per-scope writer generation as well as the tenant
key. If the backend or adapter cannot enforce that fence, it cannot support
overlapping generations, cross-daemon takeover, or automatic failover. Several
Modules in one physical database remain legal only when both tenant isolation
and writer ownership are independent. Module-level stop in a multi-Module
process likewise requires a revocable brokered handle; otherwise the Host
replaces the complete process generation before regranting that scope.

The Host **MUST** close unneeded inherited handles and file descriptors, provide a minimal environment, set a controlled working directory, and avoid invoking the Extension through a shell.

Child-process creation and direct network egress are separate elevated capabilities. Granting model access does not grant arbitrary Internet access. Granting a workspace tool does not grant direct access to the entire user profile.

## 14. Resource quotas and abuse

The Host policy **MUST** define CPU, memory, child-process, open-file/handle, disk, Asset, RPC, log, metric, model, and wakeup limits. Unsupported platform limits **MUST** be reported; they MUST NOT be silently treated as enforced.

Repeated frame floods, unauthorized calls, quota evasion, path probing, or high-cardinality telemetry MAY immediately revoke the grant and quarantine the Extension. The audit event **MUST** identify the violated policy without storing attacker-controlled secrets.

## 15. Stable requirements and invariants

- `INV-XCAP-001` — Extension authority is deny-by-default and equals the intersection of verified identity, connection, epoch, generation, policy, capability, object scope, and quota.
- `INV-XCAP-002` — A manifest request never grants authority by itself.
- `INV-XCAP-003` — Block and Asset existence is not disclosed outside the caller's authorized reachability scope.
- `INV-XCAP-004` — Module semantic state remains bound to one stable
  ModuleStorageScopeId across restart and cannot collide with or be silently
  adopted by another Module, Extension alias, or Dolly instance.
- `INV-XCAP-005` — A Module storage scope has at most one active-write owner;
  handoff is a durable monotonically fenced transition, and uncertain release
  prevents a new writer rather than creating split-brain state.
- `REQ-XCAP-001` — Every side-effecting Host service has a durable idempotency identity and status query.
- `REQ-XCAP-002` — Unsupported sandbox controls are reported as unenforced and untrusted code is refused absent an audited unsafe override.
- The storage-scope verification surfaces governed by `REQ-XCAP-003` include
  every Module-state handle, shared-backend tenant, snapshot, restore, and
  activation ledger.
