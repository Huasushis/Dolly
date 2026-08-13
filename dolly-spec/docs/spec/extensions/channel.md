# Channel Extension Specification

Status: **normative for Dolly v1**.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

`REQ-CHANNEL-001` — A Channel conformance claim MUST satisfy every normative
boundary, state, ordering, authorization, idempotency, error, and conformance
test obligation in this chapter; partial support MUST be reported as a named
non-conforming capability subset.

## 1. Responsibility and boundary

A Channel Extension adapts an external conversation transport, CLI, or test harness to Dolly Blocks and adapts explicit Dolly actions back to that transport. It owns transport sessions, external-message deduplication, upload coordination, and an outbound delivery ledger.

It MUST NOT append directly to a Page, mint a Block or Asset ID, advance a Module cursor, treat arbitrary Blocks as outbound messages, expose management APIs under conversation privileges, or infer permission from model-generated text. All inbound data is an untrusted draft submitted to the Core. All outbound delivery requires a validated `org.dolly.channel.send` action explicitly addressed to the configured Channel Module.

## 2. Configuration

The built-in v1 Channel package has the fixed Extension ID
`org.dolly.channel`; transport variants such as web, CLI, or test harness are
module types or adapter configuration, not different Extension owners.
Configuration MUST be strictly schema-validated and revisioned. It MUST include
transport kind and account identity, ingress enablement, accepted modalities
and byte limits, session-mapping policy, outbound rate/concurrency limits, and
an opaque `SecretRef` for transport credentials when needed. If an Extension ID
is represented in a resolved record, it MUST equal `org.dolly.channel`.

Configuration SHOULD also specify allowed sender/channel identifiers, attachment media policy, maximum text and part count, message-edit/delete handling, and retention of transport IDs. Unknown fields MUST be rejected unless namespaced for the selected transport adapter.

A hot reload MUST build and validate a new adapter before routing new work to it. In-flight inbound and outbound operations retain their old configuration revision. Changing account identity MUST create a new deduplication namespace.

## 3. Durable state

The Extension MUST maintain:

- `SessionMap(transport_account, external_conversation_id) -> DollySessionId`;
- `InboundLedger(transport_account, external_message_id) -> received|assets_pending|submitted|accepted|rejected` plus request and Block IDs;
- `OutboundLedger(action_id) -> prepared|dispatched|confirmed|partial|failed|unknown` plus every transport message ID and per-piece outcome when known;
- transport cursor or webhook receipt state when the transport requires it.

State keys MUST include the configured transport account. Reusing an external ID in another account MUST NOT collide.

## 4. Inbound processing

For each transport event, the Extension MUST authenticate the transport, authorize the sender and conversation, normalize text without changing its semantic characters, and validate part counts and sizes. Attachments MUST be imported through the Asset Service. The inbound Block draft MUST not be submitted until every referenced asset is `AVAILABLE`, or it MUST represent failed attachments explicitly without a fabricated reference.

The draft metadata MUST include a namespaced record equivalent to:

```json
{
  "org.dolly.channel": {
    "channel_id": "web-primary",
    "transport": "web",
    "session_id": "session-main",
    "external_conversation_id": "opaque-redacted-id",
    "external_message_id": "opaque-id",
    "sender_class": "user",
    "received_at": "2026-08-09T15:00:00.000000Z",
    "event_kind": "message"
  }
}
```

The Extension MUST NOT put transport credentials, cookies, local paths, or signed attachment URLs into metadata. An external edit or deletion MUST create a new immutable event that references the original external message; it MUST NOT mutate an accepted Block.

The Channel submits the draft only through `host.ingress.submit`, using a stable
idempotency key derived from its account-scoped inbound ledger and only the
configured target Pages. Submitting an already-accepted ledger item MUST return
the prior Ingress/Block/Delivery mapping. If the response is lost, the
Extension MUST call `host.ingress.status` with that key before resubmitting.
Only an authoritative `absent` permits replay of the byte-identical request.

## 5. Inputs, outputs, and actions

The Channel has two input classes:

1. authenticated external transport events;
2. targeted Actions contained in committed Blocks selected into an Activation
   for its configured Module ID.

Its only ordinary ingress output is a Block draft derived from an external
event. A consumed outbound Action produces an `ActionResult` JSON Part through
the same single Activation output Block contract; it is not an action RPC
response and MUST NOT masquerade as an inbound user message.

The v1 outbound action is:

```json
{
  "name": "org.dolly.channel.send",
  "action_id": "0198ab31-6c44-7e8a-b2bb-000000000091",
  "target": {"module_id": "web-channel"},
  "arguments": {
    "session_id": "session-main",
    "parts": [{"kind": "text", "text": "Hello.", "format": "plain"}],
    "reply_to_external_message_id": null
  }
}
```

The ActionContract `arguments_schema` binding MUST name
`schemas/channel-send.schema.json`, its verified schema-bundle digest, and
`semantic_validator: null`. On confirmed success, the `result_schema` binding
MUST name `schemas/channel-send-result.schema.json`, its verified bundle digest,
and semantic validator
`{"id":"org.dolly.validator.channel-send-result","revision":1}`.
Failed, partial, or unknown sends have `result: null` under the common
`ActionResult` rules.

After JSON Schema validation, that result validator MUST require
`messages[i].ordinal == i` for every array position and bytewise uniqueness of
every `external_message_id`. Thus the array is ordered, ordinals are contiguous
from zero, and transport IDs cannot alias two confirmed pieces. It receives only
the frozen Action/result validation context and MUST perform no transport or
ledger I/O.

At Block commit, the Runtime MUST validate the Action's common schema, owner,
target, and graph reachability. During the target Module's Activation, the
Channel MUST validate the operation-specific arguments and capability before
sending. It MUST verify that the session belongs to its account and policy.
Every text or Asset part is the Core `Part` schema, not a Channel-owned copy.
Before dispatch, the Channel MUST apply the Core AssetPart authorization,
authoritative detected-media-type, safe-view, and crop-bound checks; it MUST
NOT trust the action's `media_type` as an override or re-label active content.
Asset parts MUST be read under a short Asset lease. An
`org.dolly.channel.send` action MUST NOT recursively re-enter Dolly as an
inbound user message; if the transport echoes sent messages, the outbound
transport ID MUST be suppressed by the inbound ledger.

## 6. Delivery and unknown outcomes

`action_id` is the outbound idempotency key. If the transport supports an idempotency key, the Extension MUST supply a stable derivation of `action_id`. If it does not, the Extension MUST persist `dispatched` before or atomically with send initiation and reconcile by transport message ID when possible.

A timeout or crash after bytes may have reached the transport MUST produce outcome `unknown`, not `failed`. The Extension MUST NOT automatically repeat an unknown send unless the transport guarantees idempotency or an operator/authorized caller explicitly chooses a duplicate-risk recovery. A confirmed action replay MUST return the existing result.

Multi-part splitting MAY occur only under a documented deterministic adapter
rule. The ledger MUST record every piece ordinal, resulting transport ID, and
piece outcome. If at least one piece is confirmed and at least one other piece
failed or remains unknown, the ledger enters terminal `partial`. Its `ActionResult` MUST
use `status: failed`, `result: null`, and common error code
`CHANNEL_PARTIAL_DELIVERY` with `retryable: false`, `outcome: applied`, and
`details.delivery_outcome: partial`; `details` MUST also identify confirmed,
failed, and unknown piece ordinals without payload content. This mapping reports
partial application without adding a non-common ActionResult status. A partial
send MUST NOT be collapsed to success or retried wholesale. A later selective
retry requires a new explicitly authorized operation or a transport guarantee
that the same per-piece idempotency identities are safe.

## 7. Failure behavior

Transport unavailability MUST not advance Core input state or cause unrelated Page loss. Inbound polling/webhook cursors MUST be committed only after the inbound ledger is durable. Outbound rate limits MUST use bounded queues and caller deadlines.

Errors MUST use the common error envelope, including `code`, `retryable`, and top-level `outcome` (`not_applied|applied|unknown`). A Channel-specific `delivery_outcome` in `details` MUST distinguish `not_sent|sent|partial|unknown`. Codes SHOULD distinguish authentication, authorization, malformed event, unsupported media, asset import, rate limit, transport timeout, transport rejection, session missing, duplicate conflict, and internal failure.

Management routes MUST use a distinct authorization domain and MAY be disabled independently. A conversation user MUST never gain configuration, logs, session enumeration, or arbitrary-send privileges through the Channel endpoint.

## 8. Conformance tests

Tests MUST cover duplicate webhook and poll delivery, crash before and after Core submission, unknown Core outcome reconciliation, attachment failure, MIME spoofing, edits/deletes as immutable events, echoed outbound suppression, two-account ID collision, action replay, provider idempotency, timeout after send with unknown outcome, partial multi-part send and its failed/applied ActionResult mapping, duplicate/gapped/out-of-order result ordinals, duplicate external message IDs, missing or mismatched result-validator revision, session authorization, rate-limit backpressure, hot reload during send, secret redaction, and proof that no Channel operation can directly mutate a Page or cursor.
