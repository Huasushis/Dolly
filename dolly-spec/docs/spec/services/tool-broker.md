# Tool Broker Specification

Status: **normative for Dolly v1**.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

`REQ-TOOL-001` — A Host Tool Broker conformance claim MUST satisfy every
normative registry, transport, schema, authorization, fencing, idempotency,
unknown-outcome, revision, and conformance-test obligation in this chapter.

## 1. Authority and boundary

The Host Tool Broker is the only v1 component that owns configured MCP or
equivalent tool-server transports. An LLM Extension is a logical client through
`host.tool.invoke` and `host.tool.status`; it never receives the server process,
socket, bearer credential, secret environment, or unrestricted network grant.
MCP is not a Dolly Extension protocol and cannot mutate Pages, cursors,
Activations, configuration, or capabilities.

Every callable tool is identified by the pair `(tool_server_id, tool_name)`.
Both are stable configuration keys. `tool_name` is a Dolly alias; an adapter
maps it to the separately stored `upstream_name`. Provider- or server-returned
names never become callable merely because discovery reported them.

## 2. Closed resolved registry

The resolved configuration MUST conform to
[`tool-broker-config.schema.json`](../../../schemas/tool-broker-config.schema.json).
For each server it fixes:

- enabled state, adapter, exact protocol version, and transport;
- allowed Module IDs and all byte/time/concurrency limits;
- one closed tool map;
- a bounded description, complete object-root input schema, complete output
  schema, and both JCS SHA-256 digests;
- side-effect class, closed idempotency policy, confirmation policy, and
  enabled state;
- exact package ID, semantic version, package digest, relative executable path,
  and executable digest for `stdio`, or an HTTPS endpoint,
  optional `SecretRef`, and optional SPKI pins for Streamable HTTP.

The normalizer MUST recompute every schema digest and reject a mismatch. A
configured tool schema is an embedded, self-contained JSON Schema 2020-12
document that MUST compile successfully before candidate prepare:
`$ref` and `$dynamicRef` values may be only `#` or RFC 6901 JSON Pointer
fragments beginning `#/` within that same document; named anchors, remote,
file, package-relative, and cross-document references are invalid. Its digest is
`sha256(JCS(complete embedded document))`; discovery annotations and ordering
cannot change it. A
tool input schema MUST itself be an object-form schema with root
`"type":"object"`; boolean and scalar-root input schemas are invalid because
Model Gateway definitions and `host.tool.invoke.arguments` are object-valued in
v1. Output schemas may be object-form or boolean schemas and may accept any
JSON result.

A `stdio` executable is a relative member of exactly `(package_id,
package_version, package_digest)`. On every generation start the Host resolves
only that immutable installed package, hashes the selected file, and requires
`executable_digest`; it MUST NOT resolve through `PATH`, a shell, the current
directory, a same-ID newer package, or an Extension-controlled file. Both
digests remain part of the retained registry revision and call ledger. A
Streamable HTTP endpoint MUST use `https`, contain no userinfo, query, or
fragment, pass
the same DNS/redirect/credential-forwarding controls as remote Assets on every
connection, and MUST NOT follow a redirect to a different origin. Raw secrets
are invalid configuration.

The built-in adapter ID is `mcp` at protocol `2025-06-18`. This is an explicit
v1 compatibility boundary, not an alias for "latest MCP". During candidate
prepare the client sends the legacy `initialize` request with
`protocolVersion = "2025-06-18"`, requires the response to select exactly that
version, and sends `notifications/initialized` before discovery or execution.
It MUST NOT fall forward to another version advertised or selected by the
server. A server that cannot complete that exact lifecycle is incompatible
with the candidate registry revision.

The v1 adapter validates the `2025-06-18` message schemas and lifecycle. It
does not send `server/discover`, does not implement the stateless per-request
metadata contract introduced by MCP `2026-07-28`, and does not interpret
`resultType: "input_required"` as authority to issue another `tools/call`.
Version-foreign lifecycle messages or result variants are protocol failures;
their disposition still follows the durable dispatch boundary in sections 5
and 6, so a protocol mismatch after `DISPATCHED` cannot prove
non-application.

MCP `2026-07-28` is deliberately deferred because its multi-round-trip model
requires each continuation to use a new JSON-RPC ID and to repeat the original
request with opaque `requestState` and possibly brokered client input. Treating
that continuation as a harmless transport retry would violate
`REQ-TOOL-002`. Supporting it therefore requires a new versioned Tool Broker
contract that freezes per-round identities, dispatch boundaries, capability
and consent routing, opaque-state bytes, round/deadline limits, crash recovery,
and final disposition. Merely upgrading an SDK is insufficient.

`REQ-TOOL-008` — A v1 MCP server binding MUST name exactly protocol
`2025-06-18` and complete its exact initialization lifecycle. The Host MUST
reject silent negotiation, version fall-forward, `2026-07-28` stateless or
multi-round-trip behavior, and any attempt to map an `input_required`
continuation onto the existing operation identity. A newer MCP revision
requires a versioned schema/adapter contract and migration ADR.

## 3. Discovery and contract pinning

Server discovery is untrusted verification input. During candidate prepare,
the Broker starts or connects to the server inside its declared trust policy,
performs the exact `2025-06-18` initialize/initialized lifecycle, obtains the
tool catalog, and requires
each configured `upstream_name` and input schema to match the configured
binding. Missing tools, extra required arguments, schema-digest mismatch,
duplicate names, protocol mismatch, or an oversized catalog reject the
candidate. Unconfigured discovered tools remain invisible.

Output schemas are Dolly-side validation contracts even when an upstream
protocol does not declare them. Every successful output MUST validate before it
can enter canonical LLM context. A server response is untrusted data and cannot
change the stored side-effect class, idempotency mode, confirmation policy, or
schema binding.

## 4. Transport generation and lifecycle

Each successful server start/connection receives a monotonically increasing
`tool_server_generation` under its server ID. The Host owns startup,
initialization, health, bounded restart, stderr/log capture, shutdown, and
resource containment. Environment variables are cleared by default; a stdio
server receives only the configured secret bindings and minimum runtime
environment. Arguments are passed as an argument vector, never through a
shell.

A generation is `Preparing`, `Ready`, `Draining`, `Stopped`, or `Quarantined`.
Only `Ready` can receive a new dispatch, and readiness is scoped to the exact
retained registry revisions that name that generation. A generation may remain
`Ready` for an old revision without being selectable by the current revision.
A ledger row permanently records the generation selected for an authorized
call; a late response from any other generation is rejected. Crash-loop,
framing, schema, capability, or resource abuse may quarantine the server without
stopping Core or unrelated servers.

## 5. Invocation and authorization

`host.tool.invoke` MUST conform to
[`tool-invoke.schema.json`](../../../schemas/tool-invoke.schema.json). The Host
binds its instance, `module_id`, `activation_id`, lease generation, and
`config_revision` to the current authenticated Activation; resolves the exact
retained registry revision; checks Module/server/tool enablement,
`host.tools.invoke` capability, arguments, schema digest, side-effect class,
confirmation, limits, and deadline; and selects one exact Ready server
generation.

The **Tool call ledger** is the Host-owned durable set of accepted Tool
operations and their dispositions. It is authority for whether one operation
may cross the Tool transport boundary; a trace, adapter object, queue item,
response, acknowledgement, or server log is not. Each accepted row is the
closed record
[`dolly.tool-call-ledger/v1`](../../../schemas/tool-call-ledger-record.schema.json)
in the instance's authoritative Runtime SQLite database.

Identity comparison and resolved execution use two different digests. Let `P`
be the complete `host.tool.invoke` params after removing only `operation_id`,
`deadline`, and `lease_token`. The always-computable caller digest is:

```text
request_digest = sha256(JCS({"method":"host.tool.invoke","params":P}))
```

The Host first looks up `(authenticated_module_id, operation_id)`. If a row
exists, it compares the stored `request_digest` without resolving any current
registry or generation: an equal digest returns the recorded state/result, and
a different digest returns `TOOL_IDEMPOTENCY_CONFLICT` without changing the
row. A repeated request's excluded deadline and lease token do not mutate an
existing row or refresh its accepted deadline. Only when the scoped identity is
absent does the Host perform current authorization and resolution.

After every check succeeds, the Host constructs the exact closed
[`dolly.tool-operation-binding/v1`](../../../schemas/tool-operation-binding.schema.json).
That binding freezes the Host-owned instance and authenticated identity fields,
Activation lease generation, accepted deadline, caller arguments and
idempotency key, exact registry Server object, selected server generation,
confirmation decision, and one Host-assigned `server_request_id`. The binding
MUST also satisfy these semantic checks:

- `server_contract` is byte-for-byte JCS-equal to the exact Server object in
  `config_revision`, and its `tools[tool_name]` entry exists and equals the
  authorized tool;
- the stored schema digest, side-effect class, and idempotency policy equal that
  tool entry; an `argument_key` pointer resolves in the stored arguments to the
  exact stored key, while policy `none` has a null key;
- the selected generation is Ready for that retained revision and server; and
- the confirmation decision is `not_required` exactly when the selected tool
  does not require confirmation; otherwise it is the consumed approval ID bound
  to the operation digest.

`operation_digest` is
`sha256(JCS(complete dolly.tool-operation-binding/v1 object))`. The Host inserts
the binding, `request_digest`, `operation_digest`, state `AUTHORIZED`, and
`ledger_revision = 1` in one SQLite transaction. Any single-use confirmation
consumption occurs in that same transaction. The operation is accepted only
after commit succeeds. A pre-authorization denial creates no Tool-call row.
`tool_transaction_id` groups the proposal, result, and dependent model turn but
does not authorize another operation.

For the built-in v1 MCP adapter, the exact outbound application payload is the
UTF-8 JCS encoding of:

```text
{
  "jsonrpc": "2.0",
  "id": binding.server_request_id,
  "method": "tools/call",
  "params": {
    "name": binding.server_contract.tools[binding.tool_name].upstream_name,
    "arguments": binding.arguments
  }
}
```

`outbound_digest` is the SHA-256 digest of those exact bytes. Transport framing,
HTTP headers, and TLS bytes are not part of that digest, but none of those
request bytes may become eligible for send before the durable transition in
section 6. The adapter MUST recompute the payload and digest from the stored
binding rather than a mutable discovery result or queue object.

`REQ-TOOL-005` — Tool identity comparison MUST use the pre-resolution
`request_digest`; an accepted row MUST additionally freeze the complete closed
operation binding and its digest. A pre-authorization denial MUST NOT create a
Tool call row, and an identity conflict MUST NOT mutate the existing row.

The v1 idempotency policy is a closed tagged union. Every `read_only`,
`non_idempotent_write`, and `unknown` tool has exactly `{"kind":"none"}` and a
null invoke key. Every `idempotent_write` has exactly
`{"kind":"argument_key","argument_pointer":"/..."}`. The pointer is RFC 6901
into the complete caller-supplied `arguments` object. It MUST resolve to a
string exactly equal to `host.tool.invoke.idempotency_key`; the Host does not
insert, replace, normalize, or remove that argument before upstream dispatch.
Missing, non-string, or unequal values are `TOOL_INPUT_INVALID` and no accepted
row or dispatch occurs.

An `argument_key` binding proves only that Dolly sends the caller's exact key in
the configured argument. It is not evidence that an upstream server durably
deduplicates that key, retains a disposition, or returns the original result.
MCP discovery does not attest those properties, and the v1 registry defines no
attestation authority, retention contract, or upstream status mapping from
which the Host could infer them. `server_status` is not a v1 mechanism; adding
it requires a versioned status request/result mapping and a new schema.

No v1 Tool class may be automatically redispatched after `DISPATCHED`. This
includes `read_only` and `idempotent_write`: their labels do not prove that a
second observation is identical, free, or side-effect-free in the concrete
server. An `absent` status result is only a scoped read observation; it never
authorizes dispatch or redispatch. A later invoke can create an operation only
through the absent-row authorization transaction above. Required confirmation
must name a live, single-use approval bound to the operation digest; approval
for one call cannot authorize another.

`REQ-TOOL-002` — Once a Tool operation reaches `DISPATCHED`, loss of an
authoritative result MUST become `TOOL_EXTERNAL_OUTCOME_UNKNOWN` without
automatic redispatch for every v1 side-effect class. `DISPATCHED`, transport
ambiguity, a result, acknowledgement, error, timeout, or `absent` lookup MUST
NOT authorize redispatch. `idempotent_write` and `argument_key` MUST NOT be
treated as a durable-deduplication attestation. A future post-dispatch replay
mechanism requires a versioned proof schema, verifier authority,
server/transport/schema binding, retention guarantee, and reconciliation
contract.

## 6. Durable transitions, result, status, and recovery

The durable states are `AUTHORIZED`, `DISPATCHED`, `SUCCEEDED`, `FAILED`, and
`UNKNOWN`. `AUTHORIZED` means no request byte is eligible for transport.
`DISPATCHED` is the durable **send-possible** boundary: it permits at most one
send attempt but does not assert that any byte was sent or applied. The only
forward transitions are:

```text
AUTHORIZED -> DISPATCHED -> SUCCEEDED | FAILED | UNKNOWN
AUTHORIZED -> FAILED
```

The direct `AUTHORIZED -> FAILED` transition is permitted only for
`TOOL_DISPATCH_NOT_APPLIED` with the zero-byte proof below. Terminal rows are
immutable. Every transition is a compare-and-set on the exact
`(module_id, operation_id, ledger_revision, state)` and increments
`ledger_revision` by one in the same transaction. A stale compare-and-set
changes nothing: the caller rereads the authoritative row and applies its
recorded disposition. It never retries the stale write or creates another row.

To cross the dispatch boundary, the Broker holds the exact generation's
exclusive transport fence, rechecks that the stored generation is still Ready
and the stored deadline and resources remain valid, and recomputes the exact
outbound bytes and digest from the stored binding. It then commits a
compare-and-set from
`AUTHORIZED` to `DISPATCHED` with that `outbound_digest`. Only a successful,
unambiguous SQLite commit may release one in-memory, one-use send permit bound
to the operation key, new ledger revision, server generation,
`server_request_id`, and outbound digest. The sender MUST require and consume
that permit before the first application, framing, HTTP, or TLS request byte.
No queue insertion, socket ownership, connection setup that emits request
bytes, or adapter write path may bypass this gate. The send fence is held until
the permit is consumed or destroyed.

An unknown SQLite commit acknowledgement releases no permit. On reread,
`AUTHORIZED` remains eligible for the same compare-and-set because zero bytes
were eligible; `DISPATCHED` is conservatively send-possible and MUST NOT
recreate a permit. This deliberately permits an unknown external outcome even
when a particular crash happened before a physical write.

A schema-valid, digest-valid `AUTHORIZED` row plus the verified exclusive send
gate is authoritative zero-byte proof. The Broker may continue that same
operation—not create or redispatch another operation—only to its exact stored
generation, before its stored deadline, by the `AUTHORIZED -> DISPATCHED`
transaction. If the frozen generation is unavailable or stale, the deadline
expired, or a reserved pre-dispatch resource was lost, that proof instead
permits `AUTHORIZED -> FAILED` with `TOOL_DISPATCH_NOT_APPLIED`. A replacement
generation is never selected. If the implementation cannot establish the
zero-byte proof, it MUST durably cross to `DISPATCHED` without releasing a send
permit and then terminate `UNKNOWN`.

`REQ-TOOL-006` — Failure or reopen after `AUTHORIZED` but before `DISPATCHED`
MUST preserve the accepted binding. The same operation may proceed to its exact
frozen generation only from authoritative zero-byte proof and a successful
dispatch compare-and-set. It terminates as `TOOL_DISPATCH_NOT_APPLIED` only
with that proof; any ambiguity crosses the durable dispatch boundary and
becomes `TOOL_EXTERNAL_OUTCOME_UNKNOWN`. No replacement generation, fresh
deadline, response, acknowledgement, error, timeout, or absence authorizes
dispatch.

The Broker validates and bounds the complete response before `SUCCEEDED`.
Response acceptance requires an exact match to the stored operation key,
server ID, server generation, `server_request_id`, and outbound digest, and
requires the row still to be `DISPATCHED`. A stale-generation, duplicate,
cross-request, or cross-Module response cannot settle any row; it is retained
as bounded security evidence and causes no transition. A valid terminal
transition stores the complete schema-valid `ToolResult`,
`terminal_result_digest = sha256(JCS(ToolResult))`, and the new record digest in
one transaction. A lost terminal-commit acknowledgement is resolved by reread
and returns the exact stored result.

Transport/provider IDs are audit correlation, not Dolly operation identity. A
late response is accepted only from the one already dispatched request while
the operation remains nonterminal. The Broker MUST NOT issue a second request
or an upstream status call to manufacture a disposition. A lost or ambiguous
result is terminal `UNKNOWN`; it MUST NOT be relabeled failed or silently
retried.

On database reopen, after SQLite integrity, foreign-key, schema, canonical-byte,
and digest checks succeed and before the Tool Broker becomes Ready, the Host
enumerates every `AUTHORIZED` and `DISPATCHED` row in deterministic
`(module_id, operation_id)` order. Enumeration MAY use bounded batches, but v1
sets no global bound on the number of retained Tool operations and every
nonterminal row must be visited.

`recover_operation(record, facts)` is a pure recovery decision: it performs no
I/O and reads no current registry. Its verified `facts` input contains only the
record's exact-generation availability, whether its stored deadline has
expired, and whether the exclusive send gate establishes zero-byte proof. It
returns:

```text
AUTHORIZED + proof + exact generation Ready + live deadline
    -> propose DISPATCHED and one send permit after successful CAS
AUTHORIZED + proof + unusable generation/deadline/resource
    -> propose FAILED / TOOL_DISPATCH_NOT_APPLIED
AUTHORIZED + no proof
    -> propose DISPATCHED with no permit, then UNKNOWN
DISPATCHED
    -> propose UNKNOWN / TOOL_EXTERNAL_OUTCOME_UNKNOWN
terminal
    -> no change
```

The caller rechecks the proposed transition by compare-and-set. A stale
proposal is discarded and the pure decision is rerun on the new row. Recovery
never recreates a send permit for a row already observed as `DISPATCHED`.

Every load validates the closed ledger schema and recomputes the record,
operation, outbound when present, and terminal-result digests. It also checks
that indexed identity fields equal the canonical record, revisions do not
regress or skip, the instance equals `core_meta`, and the referenced Activation
and configuration exist. Any mismatch, impossible state/field combination,
duplicate transport correlation, or bytes observed from the wrong request is
`STORAGE_CORRUPT`: writable startup or transition stops without deletion,
repair, redispatch, or fabricated terminal disposition. An unsupported ledger
schema version is `STORAGE_MIGRATION_REQUIRED`, never an implicit reinterpretation.

`host.tool.status` reads the Host ledger and never invokes, retries, cancels, or
advances an operation. The Host first authenticates the connection and requires
`request.module_id` to equal that authenticated Module. It looks up exactly
`(authenticated_module_id, target_operation_id)`. A missing composite key
returns `absent`, even if another Module has the same UUID, and reveals no other
row. For a present row, `ToolResult.operation_id` is the original invoke
identity. The result contains no independently trusted Module echo.

`REQ-TOOL-004` — Tool invocation and status identity is scoped by the
authenticated Module. A status lookup MUST reveal only the exact
`(module_id,target_operation_id)` row and MUST return indistinguishable
`absent` for a same UUID owned by another Module.

V1 defines no Tool-call-ledger deletion, pruning, operation-ID reuse, or
terminal-result cleanup authority. Terminal rows therefore remain authoritative.
A future cleanup policy requires an explicit versioned retention and
referential-integrity contract; this chapter makes no globally bounded storage
claim.

## 7. Configuration transactions

The tool registry is part of one immutable `config_revision`. A candidate
change MUST prepare every added or changed server and validate the full closed
catalog before the revision commits. Existing calls retain their old registry
snapshot and server generation. If a nonterminal Activation frozen to the old
revision can still initiate a Tool call, the old generation remains
revision-scoped `Ready`; the new revision cannot resolve or select it. Only
after no such call-capable Activation remains may the old generation enter
`Draining`, at which point it accepts no new calls but completes already
authorized/dispatched work. Its old definitions and ledger remain retained
while any nonterminal call or durable reference exists.

An update that must revoke the old generation immediately, for example after a
credential compromise or capability removal, MUST quiesce or terminally abort
every affected old-revision Activation before the configuration commit point.
It cannot both leave an Activation call-capable and make its only frozen Tool
generation non-Ready.

`REQ-TOOL-007` — A registry cutover MUST preserve a revision-scoped Ready
generation for every old-revision Activation that may still initiate a Tool
call, or quiesce/terminate those Activations before commit. Draining begins only
after no new old-revision call can be authorized.

A prepare failure leaves the old registry active. After the Host configuration
commit point, failure to activate a required target server enters the normal
`ForwardRecovering`/`Degraded` configuration state; it MUST NOT fall back to an
unverified current server. Credential rotation creates a new server generation
and never exposes either credential to an Extension.

## 8. Errors and conformance tests

For a syntactically valid `host.tool.invoke` with an admissible operation ID,
policy or execution failures are returned as a schema-valid `ToolResult`, not a
JSON-RPC error. The table is exhaustive for `ToolResult.error.code`; another
code is nonconforming. Shape/framing/invalid-params failures that prevent an
operation ledger row use the wire protocol's JSON-RPC error table instead.

Every error-bearing ToolResult has `retryable:false`, but only results for an
accepted operation binding occupy the Host Tool-call ledger. For an accepted
binding, `failed` and `unknown` are durable terminal results: reuse with the
stored `request_digest` returns the recorded result and never authorizes or
dispatches work. A `denied` response occurs before acceptance and creates no
new call row. Codes such as `TOOL_UNKNOWN`, `TOOL_STALE_LEASE`, and
`TOOL_STALE_CONFIG_REVISION` therefore require no unavailable resolved binding;
their `outcome:not_applied` describes only the rejected candidate.

When a terminal or denied response has `outcome:not_applied`, a higher layer
MAY make a fresh semantic decision and submit a new operation with a new
`operation_id`, new deadline, current fences, and any newly required
confirmation. That is a newly authorized operation, not a retry; the Broker
never synthesizes it, and any old row remains unchanged. The error is not proof
about any other operation. An `applied` or `unknown` result cannot be used as
non-execution evidence for another side effect.

`TOOL_IDEMPOTENCY_CONFLICT` is a derived rejection from a pre-existing row. The
Broker returns it after comparing `request_digest` but MUST NOT create a second
row, replace the accepted digests or result, or advance the original operation.
Its `outcome:not_applied` describes only the conflicting candidate request, not
the original operation.

`REQ-TOOL-003` — An error-bearing result for an accepted operation binding MUST
be immutable and `retryable:false`; a pre-authorization denial MUST create no
Tool call row and also be `retryable:false`. Any permitted later attempt after
authoritative `not_applied` is a separately authorized operation with a new
identity. An idempotency-conflict response MUST leave the pre-existing identity,
request/operation digests, state, and result byte-for-byte unchanged.

| Tool error code | Result status | `outcome` | `retryable` | Boundary and meaning |
| --- | --- | --- | ---: | --- |
| `TOOL_SERVER_UNAVAILABLE` | `denied` | `not_applied` | false | pre-authorization; no new row or dispatch; a later attempt is a new operation |
| `TOOL_SERVER_QUARANTINED` | `denied` | `not_applied` | false | pre-authorization; no new row or dispatch; operator repair required |
| `TOOL_UNKNOWN` | `denied` | `not_applied` | false | pre-resolution alias absent/disabled; no new row |
| `TOOL_CAPABILITY_DENIED` | `denied` | `not_applied` | false | pre-authorization Module/server/tool grant failed; no new row |
| `TOOL_STALE_LEASE` | `denied` | `not_applied` | false | pre-resolution Activation fence is not current; no new row |
| `TOOL_STALE_CONFIG_REVISION` | `denied` | `not_applied` | false | pre-resolution registry revision is unavailable/unauthorized; no new row |
| `TOOL_CONFIRMATION_REQUIRED` | `denied` | `not_applied` | false | pre-authorization; a separately approved new operation is required |
| `TOOL_CONFIRMATION_EXPIRED` | `denied` | `not_applied` | false | pre-authorization approval is absent/stale/used/digest-mismatched; no new row |
| `TOOL_INPUT_INVALID` | `denied` | `not_applied` | false | pre-authorization arguments/schema/key binding failed; no new row |
| `TOOL_REQUEST_LIMIT` | `denied` | `not_applied` | false | pre-authorization capacity/deadline policy rejection; no new row |
| `TOOL_IDEMPOTENCY_CONFLICT` | `denied` | `not_applied` | false | derived from existing request-digest mismatch; no new row; original unchanged |
| `TOOL_DISPATCH_NOT_APPLIED` | `failed` | `not_applied` | false | accepted row; frozen generation/deadline/resource failed before the durable dispatch boundary, with zero-byte proof |
| `TOOL_UPSTREAM_NOT_APPLIED` | `failed` | `not_applied` | false | authoritative upstream response proves this operation was not applied |
| `TOOL_UPSTREAM_FAILED` | `failed` | `not_applied` | false | authoritative upstream response proves terminal non-application |
| `TOOL_OUTPUT_INVALID` | `failed` | `applied` | false | upstream completed but returned invalid typed output |
| `TOOL_RESPONSE_LIMIT` | `failed` | `applied` | false | upstream completed but bounded response could not be admitted |
| `TOOL_EXTERNAL_OUTCOME_UNKNOWN` | `unknown` | `unknown` | false | dispatch may have reached the server and no authoritative disposition exists |

Candidate registry/schema/package failures use `TOOL_CONFIG_INVALID`,
`retryable:false`, `outcome:not_applied` in the configuration transaction and
never create a Tool call row. Pre-dispatch transport/protocol startup failure is
`TOOL_SERVER_UNAVAILABLE` only before an operation binding is accepted; after
`AUTHORIZED`, proved zero-byte failure is `TOOL_DISPATCH_NOT_APPLIED`. Any
unproved failure at or after the durable dispatch marker is
`TOOL_EXTERNAL_OUTCOME_UNKNOWN`. These mappings cannot be weakened by an
upstream server error string. All errors use the common envelope.

The following crash/reopen vectors are mandatory storage-writer gates:

| Vector | Required reopened observation |
| --- | --- |
| `TST-TOOL-001` | a disconnected `DISPATCHED` call becomes immutable `UNKNOWN`; no send permit or redispatch |
| `TST-TOOL-002` | an `argument_key` call reopened after dispatch becomes `UNKNOWN`; the key is not attestation |
| `TST-TOOL-006` | an `AUTHORIZED` call whose exact generation is lost becomes `FAILED` only from zero-byte proof |
| `TST-TOOL-009` | an `AUTHORIZED` call with proof and the exact Ready generation performs one successful dispatch CAS and at most one send |
| `TST-TOOL-010` | loss of the dispatch-commit acknowledgement recreates no send permit; a durable `DISPATCHED` row becomes `UNKNOWN` |
| `TST-TOOL-011` | loss of a terminal-commit acknowledgement returns the exact stored terminal result and digest |
| `TST-TOOL-012` | a record/schema/digest/index mismatch blocks writable Tool Broker readiness as `STORAGE_CORRUPT` |
| `TST-TOOL-013` | stale CAS and wrong-generation/request responses leave the authoritative row unchanged |

Tests MUST also cover closed binding/ledger schema rejection, record and
terminal-result digest recomputation, registry digest recomputation,
unconfigured discovery, duplicate/renamed tools, non-object input schemas,
malicious schemas, stdio package/executable substitution and path/shell/env
injection, HTTP SSRF/redirect/DNS rebinding/TLS policy, startup and crash loops,
stale generation and cross-request responses, compare-and-set races and
revision gaps, both v1 idempotency policy variants, argument-pointer/key
mismatch, proof that an argument key is not a replay attestation, confirmation
races, same-ID terminal-result replay versus fresh-ID reauthorization,
same-target-UUID cross-Module status non-disclosure, proof that `absent` grants
no dispatch authority, failure between authorization and dispatch, kill before
and after the durable dispatch marker, lost commit acknowledgements, lost
responses and status reconciliation, output prompt injection/size/schema
rejection, registry hot update with in-flight calls, secret redaction, and proof
that no tool result can grant capability or mutate Core outside the requesting
Activation. They MUST reject a configured protocol other than `2025-06-18`, a
server-selected version mismatch, version-foreign lifecycle frames, and an
`input_required` result without ever issuing a continuation request.
