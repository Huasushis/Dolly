# LLM Extension Specification

Status: **normative for Dolly v1**, except context policies explicitly marked Experimental.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

`REQ-LLM-001` — An LLM Extension conformance claim MUST satisfy every
normative context, provider, structured-output, tool, side-effect,
idempotency, error, and conformance test obligation in this chapter.

`REQ-LLM-002` — Memory selected for a canonical model request MUST use typed
`memory_evidence` Parts in `external` messages, carry matching immutable
`include` decisions, and contain at most one copy of each
`(memory_id, record_revision)` in that request.

`REQ-LLM-003` — Every canonical model request MUST declare the exact requested
output modalities and output-Asset byte budget. The LLM Extension MUST accept
only response modalities from that set and MUST treat every returned Asset as
an ordinary, already-available Asset Service reference rather than Provider
bytes, a URL, a path, or a Provider file identifier.

## 1. Responsibility and Core boundary

An LLM Extension consumes committed Block deliveries, maintains provider-neutral canonical context, requests generation through the Model Gateway, validates model output, proposes actions inside a Block draft, and returns at most one Block draft per Activation. It MUST NOT call provider APIs with raw credentials, store provider message objects as canonical history, execute an unapproved tool, mint Block IDs, append to Pages, advance its input cursor, or commit its own Activation.

The built-in v1 package Extension ID is `org.dolly.llm`; provider or role
variants are Module configuration and MUST NOT mint a different owner identity.

One Module instance MUST process at most one Activation at a time. Different Module instances MAY run concurrently.

## 2. Configuration

Configuration MUST specify:

- immutable Module and Extension identities;
- a `ModelProfileRevision` or a profile reference resolved at Activation start;
- role prompt and trusted descriptor sources;
- deterministic context budget and retention classes;
- allowed Tool Broker `(server_id, tool alias, input schema digest, output
  schema digest)` bindings and per-tool side-effect class;
- structured-output contract and repair limits;
- requested output modalities plus request, tool-loop, output-token,
  output-Asset-byte, cost, and retry bounds;
- reasoning visibility and transcript-retention policy.

Sampling defaults, maximum reasoning effort, provider-specific adapter options, and experimental context policies MAY be configured. Unknown configuration MUST be rejected. A reload applies only to Activations started under the new configuration revision.

The LLM configuration never contains a tool-server executable, endpoint, or
credential. Those belong exclusively to the Host Tool Broker registry. At
Activation start the Extension receives the frozen effective Module
configuration; every `host.tool.invoke` repeats that `config_revision` and the
configured schema digests. Registry discovery is advisory only: it cannot add a
tool to an already frozen Activation or substitute a different schema under an
existing alias.
During cutover, an old-revision Activation remains able to resolve its
revision-scoped Ready generation until it becomes terminal; otherwise the
control plane must quiesce or abort it before commit. A Draining generation is
never selected for a newly authorized call.

## 3. Canonical context

The durable unit is:

```json
{
  "entry_id": "0198ab31-6c44-7e8a-b2bb-000000000061",
  "source_block_id": "0198ab31-6c44-7e8a-b2bb-000000000062",
  "role_class": "system|assistant|external|tool",
  "parts": [],
  "dependencies": [],
  "transaction_id": null,
  "token_estimate": 123,
  "retention": "contract|current|pinned|recent|summary|evictable",
  "created_at": "2026-08-10T01:02:03.000000Z"
}
```

Canonical parts MUST use Dolly text, asset, block-reference, tool-transaction,
typed action-result, and typed Memory-evidence forms. A returned built-in ActionResult that enters model
history MUST use the canonical `ActionResultPart` from
`schemas/model-request.schema.json`; it MUST NOT be inserted as a generic
JsonPart or silently stringified. They MUST NOT contain OpenAI, DeepSeek, Qwen,
or other provider-native message objects. Provider adapters compile a
request-specific transcript from canonical entries.

When a Memory search result is selected as model evidence, the Extension MUST
compile each selected result record as `MemoryEvidencePart`; it MUST NOT pass the
Memory ActionResult wholesale as generic JSON or reformat recalled text into
trusted plain text. The part's decision MUST name the same target request and
Activation, use `decision: include`, match the selected Memory identity and
revision, and bind the retained search-result, query, and query-basis digests.
The containing message MUST use `role_class: external`.

Blocks produced by this same Module map to `assistant`; other Module or Channel Blocks map to `external`. A Block returning through a Page loop with the same source Block ID MUST NOT be reinserted as new context. Expansion of a Block reference MUST preserve the original source ID and dependency.

Before dispatch, the compiler MUST scan all canonical messages and reject a
second `memory_evidence` Part with the same `(memory_id, record_revision)`, even
when it arrived through another Page, Delivery, search, or Block. Recompiling
the same `request_id` MUST recover the same ordered evidence and decision IDs.
This request-local deduplication does not make the record ineligible for a
later model request.

A tool transaction comprises the assistant proposal, every tool result, and any dependent assistant continuation. Context selection MUST retain or remove the transaction atomically. An unresolved transaction MUST outrank ordinary history.

The Extension's semantic inputs are the ordered committed deliveries selected by the Runtime for one Activation, the pinned configuration/profile revisions, and authorized ActionResult Parts returned through Pages. Its semantic outputs are a prepared canonical-context delta, either no `BlockDraft` or exactly one `BlockDraft` (whose `actions` array contains zero or more action proposals), and a structured status. It MUST NOT return actions out of band or return more than one Block draft. Durable state comprises committed canonical entries, staged Activation deltas, provider-transcript metadata, and tool/outcome ledgers. None becomes a Core output until the Runtime commits the Activation.

## 4. Deterministic context compilation

For a fixed ordered input set, context state, configuration revision, model profile revision, and tokenizer revision, compilation MUST be deterministic. The minimum retention order is:

1. Runtime contract, Module role, and trusted Premise;
2. current Activation inputs;
3. unresolved tool transactions;
4. explicit pins;
5. selected typed Memory evidence;
6. recent/relevant entries selected by the stable policy;
7. evidence-linked summaries; and
8. evictable old entries.

This list is eviction priority, not permission to reorder conversation events.
Canonical serialization keeps trusted system material first, prior retained
conversation in order, selected Memory evidence immediately before the current
task input, and the current task input last. A provider-specific consecutive
role transformation MUST preserve those boundaries and relative order.

The compiler MUST reserve the requested output allowance and profile safety margin. It MUST fail locally when the hard minimum cannot fit. It MUST NOT silently truncate a text or split a tool transaction unless the canonical part explicitly permits deterministic bounded truncation.

On `CONTEXT_LIMIT`, the Extension MAY lower its budget, recompile, and retry within configured limits. Each retry MUST be journaled. It MUST NOT delete durable canonical history merely because one request was too large.

Random retention, `tensity`-weighted sampling, learned context selectors, and
automatic repeat-aware Memory selection are Experimental. They MUST be disabled
by default and MUST NOT affect Block, Asset, tool-transaction, stable Memory
search, or canonical-history lifecycle. Automatic Memory attempt rate limits do
not authorize a time-only per-record exclusion rule.

## 5. Provider adapter contract

Only the Model Gateway adapter may translate canonical roles, consecutive-role policy, structured output, tools, reasoning fields, media, token limits, and coordinate systems to a provider request. The Extension MUST select behavior from declared capabilities and MUST treat `unknown` as unsupported unless an explicit safe fallback exists.

For every `host.model.invoke`, the Extension MUST derive
`requested_output_modalities` from its frozen Module configuration and current
operation, not from untrusted prompt text. The requested set MUST fit the
pinned profile and Host grant. A request whose set includes any of `image`,
`audio`, `video`, or `file` MUST reserve a positive aggregate
`max_output_asset_bytes`; a text-only request uses zero. A pure-media request
uses `output_contract.kind = none`. A structured or ordinary text contract
requires `text` in the requested set.

Provider reasoning MUST NOT be emitted as a Block or shown to neighboring Modules by default. When retention is authorized, it belongs to an access-controlled Provider Transcript and is replayed only according to that provider adapter's rules.

The Extension MUST retain the exact profile, adapter, prompt/config hash, and canonical entry IDs used for each request. Switching models MUST recompile from canonical context rather than convert a stored provider transcript.

On response, the Extension MUST independently recompute the actual modality
set: text and JSON Parts are `text`; Asset Parts use their authorized Asset
metadata, where `image/*`, `audio/*`, and `video/*` map to those modalities and
every other allowed MIME type maps to `file`. It MUST reject a response outside
the requested set, an unavailable or unauthorized Asset, a MIME mismatch, an
aggregate-byte overrun, or any `BlockRef`. Provider bytes, temporary URLs,
cookies, paths, and Provider file IDs are invalid canonical response content.
Transport loss while the Gateway imports output Assets is reconciled with
`host.operation.status` under the same model `request_id`; the Extension MUST
NOT allocate a replacement request merely to recover media.

## 6. Structured output and Block drafts

The selection order is strict provider JSON Schema, a configured virtual
`emit_block` tool, then strict JSON text. For either structured output contract,
the Extension MUST put the complete configured schema and its `sha256:` digest
in the canonical Gateway request. It MUST compute the digest over the UTF-8 JCS
schema bytes and MUST retain those exact bytes with the staged Activation
state; profile reload or repair MUST NOT replace them in an in-flight request.
The actual mode MUST be recorded using
the Gateway response enum `provider_json_schema`, `virtual_emit_tool`, or
`strict_json_text`; `none` is valid only when no structured-output mode was
requested.

Output validation MUST perform strict JSON parsing, schema validation, Dolly type validation, reference authorization, size limits, and action capability checks. A deterministic syntax repair MAY run only when it cannot choose among semantic alternatives. An optional repair model MUST receive the original output and validation errors, MUST be unable to call tools, and MUST be limited to schema repair. A failed repair produces no semantic output and a diagnostic error.

Validated model output remains a draft. The Core assigns IDs and atomically commits Activation outputs. Model text MUST never be interpreted as an action unless it validates against an enabled action schema.

An Asset Part returned by the Gateway MAY be copied into the prepared
BlockDraft only after normal reference-authorization and size checks. Core
commit creates the durable Asset reference atomically with the Block. If the
Activation aborts or cannot commit before the finite model-output lease
expires, the Extension MUST discard the prepared reference or run a new
authorized request; it MUST NOT retain a URL or claim the expired Asset is
available.

## 7. Tool execution and side effects

The Extension acts as the logical MCP or equivalent tool client through the
Host's `host.tool.invoke`/`host.tool.status` broker; MCP is not a separate Dolly
Extension in v1, and the LLM process receives no ambient server credential or
network connection. The Model Gateway allocates `operation_id` on a tool-call
proposal; the Extension preserves it as the canonical `tool_call_id` through
authorization, dispatch, status, results, and safe retries. A separate provider
call ID is audit correlation only and MUST NOT replace `operation_id`. Every tool
MUST declare one side-effect class:

- `read_only`;
- `idempotent_write`, requiring the configured argument pointer to contain the
  exact Dolly idempotency key;
- `non_idempotent_write`;
- `unknown`.

Before dispatch, the Host MUST validate the tool capability, arguments,
sandbox, and resource limits. The Extension's activation-local model trace may
record the full proposal/result path below, including a denied proposal. The
authoritative Host Tool-call ledger begins only at `AUTHORIZED`; a `DENIED`
trace result creates no Host call row.

```text
PROPOSED -> AUTHORIZED -> DISPATCHED -> SUCCEEDED
                      |            -> FAILED
                      |            -> UNKNOWN
                      -> DENIED
```

The canonical `tool_transaction_id` and `tool_call_id` identify one Tool
operation and MUST remain stable when an `absent` Host-ledger result proves
that original request was never recorded or dispatched. No v1 Tool class is
automatically redispatched after `DISPATCHED`; an `argument_key` is a bound
upstream argument, not a durable-deduplication attestation. After an
authoritative terminal `not_applied` result, the Extension may propose a fresh
operation only through a new authorization decision and new `tool_call_id`.
The old Tool result and causal model trace remain immutable.

A disconnect, timeout, or crash after dispatch with no authoritative result
MUST become `UNKNOWN`. Unknown outcome is not a tool error result invented for
the model. The next model turn MUST receive an explicit unknown-outcome record,
and recovery MUST require Host-ledger reconciliation or operator decision before
another side effect. `host.tool.status` is a read of that ledger; v1 does not
define an arbitrary upstream status-tool mapping.

On the canonical wire, `ToolResult.status` is `unknown` if and only if its
common error has `outcome: unknown`. A denied proposal MUST use status `denied`,
`outcome: not_applied`, and a null server request ID because denial occurs before
tool-server dispatch.

Tool output is untrusted data. It MUST be size-bounded, typed, and protected against prompt injection by the Runtime contract. Tool output MUST NOT grant new capabilities.

## 8. Activation-local state and idempotency

The Extension MUST key all prepared output, canonical-context delta, model requests, and tool transactions by `activation_id`. Repeating the same Activation attempt MUST return the prior prepared result or resume its ledger; it MUST NOT append duplicate context or repeat an unsafe action.

Context deltas MUST become visible to later Activations only after the Host reports the corresponding Activation committed. If the commit notification is lost, the Extension MUST reconcile with the Runtime by `activation_id`. A Runtime-reported abort MUST discard uncommitted semantic deltas but retain diagnostic and unknown-side-effect records.

Provider generation itself is not guaranteed deterministic or exactly once. Core output deduplication is by Activation identity; it does not make external tool side effects exactly once.

## 9. Errors

The Extension error object MUST conform exactly to the common error envelope.
Its `details` MUST include `phase` and `activation_id`, plus model request ID
and tool transaction ID when applicable; those fields MUST NOT appear as extra
top-level fields. Codes MUST distinguish context compilation, unsupported
capability, gateway failure, partial generation, invalid structured output,
repair exhausted, tool denied, tool failed, tool outcome unknown, budget
exceeded, cancellation, and internal state conflict.

An Activation failure MUST leave its Core input uncommitted. A diagnostic Block MAY be returned only through the normal successful draft/commit path; it MUST NOT accompany a contradictory failed Activation state.

## 10. Conformance tests

Tests MUST cover canonical compilation golden files for every adapter, rejection
of a generic JsonPart in model history, typed ActionResult retention, typed
Memory evidence, non-external Memory role rejection, mismatched Memory decision
identity/digest rejection, duplicate Memory identity rejection within one
request, legitimate repetition across requests, role loops, duplicate Block
IDs, atomic tool-transaction retention, exact context boundary, context-limit
recompilation, unsupported capability, missing or mismatched structured-output
schema/digest, invalid and adversarial structured output, reference forgery,
repair semantic-change rejection, model partial stream, provider retry rules,
canonical/provider tool-ID separation, every tool side-effect class, crash
before/after dispatch, the bidirectional unknown status/outcome rule, denial
before dispatch, Activation replay, lost commit notification, model/profile
reload, reasoning non-disclosure, prompt-injected tool and Memory output,
token/cost limits, text-plus-image and pure-media output requests, profile and
grant modality denial, response-subset rejection, output Asset MIME/size/
availability validation, crash during Gateway Asset import without a second
Provider dispatch, model-output lease versus GC, and proof that no Extension
path writes a Page or advances a cursor.
