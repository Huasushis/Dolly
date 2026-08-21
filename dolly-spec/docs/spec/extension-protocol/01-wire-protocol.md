# Extension Wire Protocol

Status: normative for Dolly Extension RPC v1.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be interpreted as normative requirements. Examples are non-normative unless explicitly stated otherwise.

## 1. Scope and transport roles

An Extension is a child process of one Runtime Worker. The Runtime Worker is the **Host**. The Host owns process creation, protocol selection, authorization, deadlines, and termination.

The Host **MUST** create two byte streams connected to the child process:

- Host-to-Extension input, exposed as the Extension's standard input; and
- Extension-to-Host output, exposed as the Extension's standard output.

Standard output **MUST contain only framed protocol messages**. An Extension **MUST NOT** write banners, logs, progress text, ANSI control sequences, or raw asset bytes to standard output. It **MAY** write bounded diagnostic text to standard error. The Host **MUST** capture, rate-limit, redact, and label standard error as untrusted Extension output.

The Host **MUST** initiate the protocol. Immediately after spawning the process, the first request **MUST** be `extension.initialize`. The Extension **MUST NOT** initiate requests or notifications until it has successfully answered that request. Any other pre-initialization message is a protocol violation.

JSON-RPC batch arrays are not supported in v1. Each frame **MUST** contain exactly one JSON-RPC object.

## 2. Frame format

Each message is encoded as:

1. a four-octet unsigned length in network byte order (big endian); followed by
2. exactly that many octets of UTF-8 JSON.

The length counts only JSON octets. A length of zero is invalid. There is no delimiter, newline rule, compression flag, or `Content-Length` header.

Receivers **MUST** support fragmented reads and multiple complete frames in one operating-system read. A receiver **MUST NOT** attempt to parse a frame until all declared bytes have arrived.

Before initialization completes, both parties **MUST** enforce a bootstrap
maximum frame length of 1,048,576 bytes. The `extension.initialize` parameters
and successful result **MUST** conform to
[`extension-initialize-request.schema.json`](../../../schemas/extension-initialize-request.schema.json)
and
[`extension-initialize-result.schema.json`](../../../schemas/extension-initialize-result.schema.json).
For every numeric limit, the effective value is the minimum of the Host offer,
the Extension response, and the Host hard limit; a response above the offer is
invalid rather than a counter-offer. `max_frame_bytes` and the complete-frame
`max_frame_nesting_depth` are negotiated independently from the semantic
`max_json_nesting_depth`. The v1 Host defaults are 4,194,304 bytes, 96 complete
frame levels, and 64 semantic levels respectively.

The following are fatal framing violations:

- a zero length;
- a length above the current limit;
- end-of-stream in the four-octet header;
- end-of-stream before all declared payload bytes arrive; or
- bytes following a declared frame that cannot begin another valid frame.

On a fatal framing violation, the receiver **MUST** close the protocol connection without trying to resynchronize. The Host **MUST** terminate the Extension and record `protocol_violation`; the frame **MUST NOT** be retried on the same process.

Large payloads **MUST** use Host services and opaque Asset identifiers. Raw asset data and unbounded Base64 values **MUST NOT** be carried in this stream.

## 3. JSON rules

Frame payloads **MUST** be valid UTF-8 without a byte-order mark and **MUST** decode to one JSON object. There **MUST NOT** be non-whitespace data before or after the object. JSON values **MUST** satisfy the Core canonical JSON profile, and conforming senders **MUST** emit JCS bytes.

A conforming decoder **MUST** reject:

- duplicate object member names at any depth;
- invalid Unicode scalar values;
- a complete-frame nesting depth greater than 96;
- a single string larger than the negotiated frame limit;
- non-JSON numeric values such as NaN or infinity; and
- integers outside the range that the method schema permits.

For the 96-level complete-frame ceiling, the top-level JSON-RPC object has
depth 1 and each directly nested object or array increases the depth by 1.
Independently, the registry declares exactly four kinds of semantic schema
root:

- request `params`;
- notification `params`;
- a successful response `result`; and
- a Dolly error response `error.data`.

Each selected schema resource is counted independently from its own root. A
root object or array has depth 1, a primitive has depth 0, and the recursive
rule is the one in
[Core Identifiers and Canonical JSON](../core/01-identifiers-and-canonical-json.md).
The JSON-RPC envelope, including its request, notification, response, and
`error` objects, does not consume the selected root's semantic quota. An
embedded document already validated at another declared schema root is a leaf
for the enclosing document's structural count. The effective
`max_json_nesting_depth` applies separately to every root and **MUST NOT**
exceed 64; at the v1 maximum, depth 64 is valid and depth 65 is invalid. These
resets never affect complete-frame depth, so every message **MUST** satisfy both
limits.

A semantic-depth violation in an otherwise valid complete frame is not a fatal
framing violation. After correlating the message where applicable, the receiver
**MUST** use the following closed disposition:

| Root over its effective limit | Observable error | Receiver execution | `retryable` / `outcome` | Connection |
| --- | --- | --- | --- | --- |
| request `params` | JSON-RPC `-32602 Invalid params` with conforming Dolly error data whose `code` is `RPC_INVALID_PARAMS` and whose `details.error_name` is `invalid_params` | zero method-handler invocations and zero backend dispatches | `false` / `not_applied` | remains reusable |
| notification `params` | no JSON-RPC response; a bounded local Dolly error diagnostic with `code: RPC_INVALID_PARAMS` and `details.error_name: invalid_params` | zero method-handler invocations and zero backend dispatches | `false` / `not_applied` | remains reusable |
| successful response `result` | no response-to-response; complete the correlated local wait with conforming Dolly error data whose `code` is `PROTOCOL_INVALID_RESPONSE` and whose `details.error_name` is `invalid_response` | do not deliver the result and perform zero receiver-side method-handler invocations or backend dispatches; callee-side execution is unproved | `false` / `unknown` | close; not reusable |
| error response `error.data` | no response-to-response; discard the peer's error data and complete the correlated local wait with the same `PROTOCOL_INVALID_RESPONSE` Dolly error | do not deliver or trust the peer's error and perform zero receiver-side method-handler invocations or backend dispatches; callee-side execution is unproved | `false` / `unknown` | close; not reusable |

Request and notification validation precedes method invocation, so rejection
proves `not_applied`. A response can be constructed after the callee crossed a
durable commit or external-effect boundary; invalid `result` or `error.data`
therefore proves nothing about callee-side handler execution, backend dispatch,
or operation outcome. The caller **MUST NOT** trust a malformed error's claimed
outcome, automatically replay the request, or allocate a fresh semantic
identity. It **MUST** use the method's registered reconciliation and unknown
outcome policy.

Closing after an invalid response is a semantic protocol-safety action, not a
reclassification as fatal framing: the frame boundary remains known, but the
peer has failed the closed response contract and JSON-RPC provides no legal
response to a response. Continuing to accept results from that process would
allow an already nonconforming peer to cross further method boundaries. The
receiver **MUST** close the protocol connection; if the Host is the receiver,
it **MUST** terminate the Extension and record `protocol_violation`. Other
outstanding requests take the indeterminate transport disposition in Section
9.

Integer-valued protocol fields **MUST** be JSON integers in `0..9007199254740991` unless their method schema explicitly defines a decimal-string encoding. Core sequence, revision, attempt, and lease-generation fields use the safe-integer form and **MUST** fail closed before exhaustion. Implementations **MUST NOT** infer identifiers from JSON number formatting.

Invalid UTF-8, invalid JSON, a duplicate key, or a top-level value other than an object is a fatal message violation. Because the frame boundary is known, the receiver **SHOULD** first send a JSON-RPC Parse Error with a null ID when it can do so safely, then **MUST** close the connection. It **MUST NOT** continue processing later frames from that process.

## 4. JSON-RPC profile

Messages **MUST** conform to JSON-RPC 2.0 with the following v1 restrictions:

- `jsonrpc` **MUST** equal `"2.0"`.
- Request IDs **MUST** be non-empty UTF-8 strings of at most 128 bytes.
- Numeric and null request IDs are forbidden.
- A sender **MUST NOT** reuse an ID while a request with that ID is outstanding on the same connection.
- `method` **MUST** be a non-empty string of at most 160 bytes.
- `params`, when present, **MUST** be an object.
- A response **MUST** contain exactly one of `result` or `error`.
- Every request **MUST** receive exactly one terminal response unless the connection closes.

Method schemas define additional limits. A receiver **MUST** validate a complete message before causing method-visible side effects.

An unknown request method **MUST** receive JSON-RPC `-32601 Method not found`. An unknown notification **MUST** be ignored and **SHOULD** increment a bounded diagnostic counter. Invalid method parameters **MUST** receive `-32602 Invalid params` and **MUST NOT** invoke the method.

The following standard errors are used unchanged. Their Dolly `data` envelope
uses the stable name and closed policy columns below; a null response ID is
permitted only for `parse_error` and `invalid_request` when the request ID
cannot be recovered.

| Code | Meaning | Stable `error_name` | Allowed `retryable` | Allowed `outcome` |
| ---: | --- | --- | --- | --- |
| `-32700` | Parse error | `parse_error` | `false` | `not_applied` |
| `-32600` | Invalid request | `invalid_request` | `false` | `not_applied` |
| `-32601` | Method not found | `method_not_found` | `false` | `not_applied` |
| `-32602` | Invalid params | `invalid_params` | `false` | `not_applied` |
| `-32603` | Internal error | `internal_error` | `false` | `not_applied`, `applied`, or `unknown` |

The Dolly v1 server-error range is:

| Code | Stable `error_name` | Allowed `retryable` | Allowed `outcome` | Caller policy |
| ---: | --- | --- | --- | --- |
| `-32001` | `deadline_exceeded` | `false` or `true` | any closed outcome | retry only when the concrete envelope and method policy permit it |
| `-32002` | `cancelled` | `false` or `true` | any closed outcome | method-specific |
| `-32003` | `not_ready` | `true` | `not_applied` | back off |
| `-32004` | `capability_denied` | `false` | `not_applied` | do not retry |
| `-32005` | `stale_generation` | `false` | `not_applied` | reconnect/reinitialize instead of retrying the stale request |
| `-32006` | `revision_conflict` | `true` | `not_applied` | reread state before retry |
| `-32007` | `temporarily_unavailable` | `true` | `not_applied` | back off |
| `-32008` | `resource_exhausted` | `true` | `not_applied` | reduce load before retry |
| `-32009` | `quarantined` | `false` | `not_applied` | operator action required |
| `-32010` | `state_migration_required` | `false` | `not_applied` | migration required |
| `-32011` | `permanent_failure` | `false` | `not_applied` or `applied` | do not retry |
| `-32012` | `protocol_version_unsupported` | `false` | `not_applied` | negotiate a supported version |

An error `data` object **MUST** be exactly the closed common error envelope: `code`,
`retryable`, `outcome`, `message`, `details`, and optional `correlation_id`.
The transport-category `error_name` from the table and any bounded structured
diagnostic **MUST** be members of `details`, not extra top-level fields. A
transport mapping **MUST NOT** replace or discard a Core code such
as `ACTIVATION_STALE_LEASE`. Error messages and data **MUST NOT** contain
secrets, authorization material, raw prompts, or unrestricted file contents.

### 4.1 V1 method directions

The caller column is normative. A peer **MUST NOT** call a method in the reverse direction.

| Caller → callee | Request methods |
| --- | --- |
| Host → Extension | `extension.initialize`, `extension.ping`, `extension.shutdown` |
| Host → Extension | `module.instantiate`, `module.activate`, `module.prepare_config`, `module.commit_config`, `module.abort_config` |
| Host → Extension | `module.snapshot`, `module.restore`, `module.migrate_state`, `module.operation_status`, `module.health`, `module.shutdown` |
| Extension → Host | `host.block.get`, `host.block.pin`, `host.block.unpin` |
| Extension → Host | `host.asset.import`, `host.asset.status`, `host.asset.get`, `host.asset.materialize_view` |
| Extension → Host | `host.model.invoke` |
| Extension → Host | `host.tool.invoke`, `host.tool.status` |
| Extension → Host | `host.ingress.submit`, `host.ingress.status`, `host.activation.status` |
| Extension → Host | `host.module.request_activation`, `host.module.request_wakeup` |
| Extension → Host | `host.config.propose`, `host.operation.status` |

The v1 notifications are:

| Sender → receiver | Notification | Meaning |
| --- | --- | --- |
| either direction | `$/cancelRequest` | best-effort cancellation of a request sent by the receiver |
| Host → Extension | `module.activation_disposition` | advisory notice of commit, cancellation, or quarantine |
| Extension → Host | `descriptor.changed` | request refresh of one Module Descriptor revision |
| Extension → Host | `extension.progress` | bounded non-durable progress for an existing operation |
| Extension → Host | `host.log.emit` | bounded untrusted structured log event |
| Extension → Host | `host.metrics.record` | bounded untrusted metric samples |

`extension.initialize` is always the first request and is always Host → Extension. `module.commit_config`, `module.abort_config`, and `module.operation_status` use the original configuration transaction/operation ID. `module.migrate_state` operates only on staged snapshot state and **MUST NOT** mutate the active source snapshot.

Lifecycle methods sent by an Extension, Host-service methods sent by a Host, or a cancellation targeting a request not originally sent by the receiver are invalid requests/notifications. A future method requires a negotiated protocol capability or protocol-version change; a manifest entry alone does not add a wire method.

The machine-readable params and success-result resource for every method and
the params resource for every notification are frozen by
[`extension-rpc-v1.registry.json`](../../../protocol/extension-rpc-v1.registry.json).
The [Extension RPC v1 Method Contract Catalog](05-method-contract-catalog.md)
is its human-readable mirror. An implementation MUST NOT substitute an
implementation-private shape, accept members rejected by the selected schema,
or return a success object through the JSON-RPC error branch. All
schema-fragment references use Draft 2020-12 `$defs` resolution.

### 4.2 Ingress and Activation disposition

`host.ingress.submit` parameters MUST conform to
`schemas/ingress-submit.schema.json`. The authenticated Module may target only
Pages in its `host.ingress.submit` grant. The Host sorts `target_page_ids`, then
uses the Core external-ingress transaction. The semantic operation digest
covers the canonical draft and sorted target set; it excludes the transport
`operation_id` and deadline. Success conforms to
`schemas/ingress-result.schema.json`.

If the submit response is lost, the Extension calls `host.ingress.status` with
the same scoped idempotency key. `absent` proves that no Core ingress commit
exists for that principal/key and permits replay of the identical submit;
`committed` returns the original complete result. A key reused with different
semantic input fails `STORAGE_IDEMPOTENCY_CONFLICT`. There is no direct Page
append method.

After an Activation reaches `committed`, `cancelled`, or `quarantined`, the Host
SHOULD send `module.activation_disposition` with the durable value defined by
`schemas/activation-status.schema.json`. The notification is advisory and may
be lost with the process. `host.activation.status`, scoped to the caller's own
Module and defined by `schemas/activation-status-request.schema.json`, is the
authoritative reconciliation path. An unauthorized and unknown Activation MUST
be indistinguishable. Extensions MUST NOT publish prepared semantic state based
only on an RPC response or notification that contradicts the queried durable
status. `quarantined` is nonterminal and reports `terminal: false`; only an
authenticated review may move it to `ready`, `result_staged`, or `cancelled`.
The status also returns the replay contract with its frozen Descriptor/config
source revisions, the last attempt's conservative dispatch/fence evidence, and
the closed one-shot authorization for any next attempt. That authorization
binds `source_attempt`, the exactly-next `authorized_attempt`, a closed reason,
and the digest of the Host-owned source evidence; it is consumed atomically by
lease issue and cleared by every non-retry disposition. `prepared` with
`transport_started: false` proves the Host wrote no frame; `started` and
`response_received` mean transport may have occurred; `fenced` includes the
Host evidence digest. These fields are audit projections of Core state, not
commands or Extension assertions.

The bound `org.dolly.validator.activation-status` revision 1 semantic
validator **MUST** additionally
enforce `authorized_attempt = source_attempt + 1`,
`source_attempt = last_dispatch.attempt`, and evidence lookup by reason.
`safe_before_dispatch` and `pure_compute` bind the retained fence evidence;
`explicit_retryable_failure` binds the authoritative response digest;
`activation_ledger` binds `sha256(JCS(activation-replay-evidence))`; and
`operator_review` binds the authenticated decision record. JSON Schema shape
validation alone is not sufficient for these cross-record equalities.

### 4.3 Asset import and status

`host.asset.import` parameters MUST conform to
`schemas/asset-import.schema.json`; its success result MUST conform to the
non-`absent` `ImportResult` fragment and every `host.asset.status` result MUST
conform to the `StatusResult` fragment in
`schemas/asset-status.schema.json`.
The Host MUST durably insert the `accepted` Import record, including the
canonical request digest and authenticated caller, before acquiring source
bytes or performing a remote effect. The import method MAY return any recorded
non-`absent` state; an RPC response is not the Asset availability commit point.

`host.asset.status` parameters MUST conform to
`schemas/asset-status-request.schema.json`. Its `operation_id` identifies the
status read and its `import_id` names the original import. The read requires the
current authenticated Module grant but no live Activation lease, and it never
starts, retries, cancels, or advances an import.

After a lost import response, the caller MUST query the same `import_id`.
`absent` proves that no durable Import record was created for that scoped ID and
permits replay of the byte-identical import. Any other state is authoritative;
the caller polls or follows the documented retry/cancellation operation instead
of creating a new import identity. `available` returns the original immutable
Asset identity, media type, and byte length. Reuse of an `import_id` with a
different canonical request fails `IMPORT_ID_CONFLICT` without touching the
existing record.

The term `asset_input` denotes only the preprocessed source parameters consumed
by `host.asset.import`. It is not a `BlockDraft` member. After availability, a
draft refers to the result only through the ordinary closed Asset Part
`{kind:"asset", asset_id, media_type, ...}`.

## 5. Ordering and concurrency

Frames are ordered independently in each byte-stream direction. Requests MAY be processed concurrently after initialization, and responses MAY be returned out of request order. Correlation is exclusively by request ID.

Both parties **MUST** continuously service their receive loop while awaiting a response. In particular, an Extension handling `module.activate` **MUST** remain able to receive cancellation and heartbeat messages and to correlate responses to reverse Host-service requests. An implementation **MUST NOT** block its only protocol reader while waiting for an RPC response, because that creates a cross-direction deadlock.

Notifications are observed in receive order. A receiver **MUST NOT** reorder two notifications for the same `module_id`. It MAY execute notifications for independent modules concurrently only when the method contract permits it.

The negotiated limits **MUST** include:

- maximum outstanding requests in each direction;
- maximum queued outbound bytes;
- maximum requests per second; and
- maximum notification rate.

The v1 defaults are 64 outstanding requests per direction and 16 MiB of queued outbound frames per process. A sender **MUST** apply backpressure before exceeding a negotiated limit. A receiver MAY terminate a process that persistently violates a limit, and the Host **MUST** classify that termination as `resource_protocol_violation`.

## 6. Deadlines

Every request that can perform I/O, model work, migration, snapshotting, activation, or shutdown **MUST** carry a method-schema deadline. The Host is authoritative for Host-to-Extension deadlines. Persisted deadlines **MUST** use the Core timestamp form `YYYY-MM-DDTHH:MM:SS.ffffffZ`. V1 request deadline fields are absolute `deadline` timestamps except that `module.activate` uses its immutable `manifest.deadline`; a relative duration is legal only in a differently named field explicitly declared by a method schema. Live expiry **MUST** be evaluated with the injected monotonic clock so a wall-clock adjustment cannot change an already-created deadline.

A receiver **MUST** reject a request whose deadline has already elapsed with `deadline_exceeded`. It **MUST** attempt to stop cancellable work when the deadline elapses. Deadline expiry does not imply rollback: if a method has passed its documented commit point, it **MUST** complete recovery to a documented terminal state and report that state on a subsequent status query.

Retries **MUST** obey the idempotency rules of the method. A caller **MUST NOT** infer that a timed-out request had no effect.

## 7. Cancellation

Cancellation uses the notification:

```json
{
  "jsonrpc": "2.0",
  "method": "$/cancelRequest",
  "params": { "id": "rpc_...", "reason": "operator_request" }
}
```

Cancellation is best-effort. The receiver **MUST** acknowledge it only through the terminal response of the original request:

- if cancellation wins before the method commit point, return `cancelled`;
- if the method has already committed, return its committed result;
- if cancellation races with another failure, return the terminal state selected by the method state machine.

Receiving cancellation after a terminal response is a no-op. Cancellation **MUST NOT** erase a durable transaction record or make a committed effect appear uncommitted.

## 8. Heartbeats and health

After initialization, the Host **MUST** periodically send `extension.ping` requests containing the current Worker epoch and Extension generation. The Extension **MUST** answer without waiting for module work to complete.

Ping parameters and results MUST conform to `ExtensionPingParams` and
`ExtensionPingResult` in
[`extension-lifecycle-rpc.schema.json`](../../../schemas/extension-lifecycle-rpc.schema.json).
The result echoes the operation, epoch, and generation; a mismatched echo is a
stale-generation protocol violation rather than a successful heartbeat.

Default policy is one ping every 30 seconds, a 10-second response deadline, and unhealthy classification after three consecutive missed pings. Deployments MAY tighten these values but **MUST** record the effective policy.

A successful ping proves only protocol-loop liveness. It **MUST NOT** be treated as proof that module state, a Provider, or a downstream service is healthy. Detailed health is queried separately.

## 9. Connection termination

Orderly shutdown uses the lifecycle methods before stream closure. Unexpected EOF, a broken pipe, or process exit terminates every outstanding request with an indeterminate transport outcome. The caller **MUST** resolve each affected operation from its durable state machine and idempotency key; it **MUST NOT** assume success or failure from EOF alone.

After closing the connection, the Host **MUST** revoke that connection's capability grant and generation. Messages from a stale process, another pipe, or a later process claiming the old request IDs **MUST NOT** be accepted.

## 10. Conformance requirements

A protocol implementation is conforming only if it passes golden tests for:

- every header split position and payload split position;
- multiple frames in one read;
- invalid lengths, UTF-8, JSON, duplicate keys, and depth;
- unknown requests and notifications;
- concurrent reverse RPC and out-of-order responses;
- cancellation on both sides of a method commit point;
- deadline and heartbeat races;
- bounded queues and frame floods; and
- EOF before and after durable commit.

## 11. Stable requirements and invariants

- `REQ-XRPC-001` — The Host sends `extension.initialize` as the first RPC after spawn; pre-initialization Extension traffic is rejected.
- `INV-XRPC-001` — Each accepted frame is one bounded four-byte-big-endian-length-prefixed UTF-8 JCS JSON-RPC object.
- `INV-XRPC-002` — Extension standard output contains protocol frames only; raw bytes and diagnostics never enter the frame stream.
- `INV-XRPC-003` — A request ID identifies at most one outstanding request and exactly one terminal response per connection.
- `REQ-XRPC-002` — Deadline, cancellation, EOF, and retry outcomes are resolved by the called method's durable state and idempotency identity, never by transport inference.
- `REQ-XRPC-003` — Every v1 request and notification is present exactly once in
  the method-contract catalog with closed machine-readable params and, for a
  request, a closed success result.
- `INV-XRPC-006` — Request params, notification params, success results, and
  Dolly error data are independent semantic schema roots. An over-limit input
  is rejected before handler or backend dispatch without closing the
  connection; an over-limit response is not delivered, has an unknown external
  outcome, and closes the non-reusable connection without being classified as
  a fatal framing violation.
