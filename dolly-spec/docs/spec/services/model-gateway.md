# Model Gateway Specification

Status: **normative for Dolly v1**.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

`REQ-MODEL-001` — A Model Gateway conformance claim MUST satisfy every
normative profile, request, response, adapter, retry, usage, budget, secret,
network, and conformance test obligation in this chapter.

`REQ-MODEL-002` — A canonical request containing `memory_evidence` MUST keep
that evidence in `external` messages, reject suppress/mismatched decisions and
duplicate Memory identities, and compile it to a provider's non-system
user/tool-level data representation without granting instruction authority.

`REQ-MODEL-003` — A model request MUST explicitly name its requested output
modalities and aggregate output-Asset byte budget. A successful response MUST
contain only requested modalities, and provider media MUST become an
independently verified `AVAILABLE` Asset before its Asset Part can be returned.
Provider bytes, temporary URLs, cookies, paths, and provider file IDs are never
canonical response Parts.

## 1. Purpose and trust boundary

The Model Gateway is the sole v1 service authorized to hold provider credentials and make model-provider network requests. Extensions submit provider-neutral requests; provider adapters compile them into wire requests and normalize responses. An Extension MUST NOT receive a provider API key, Authorization header, credential-bearing URL, or unrestricted gateway environment.

The Gateway does not own LLM conversation state, execute tools, commit Blocks, or decide Page routing. Those remain Extension and Core responsibilities. A successful model response is data, not permission to perform a side effect.

## 2. Model profile

Every request MUST name an immutable `ModelProfileRevision`, not only a provider model string. A profile MUST contain:

```json
{
  "profile_id": "model-main",
  "revision": 17,
  "provider_adapter": "openai-compatible-v2",
  "provider_model": "example-model",
  "endpoint": "https://api.example.invalid/v1",
  "credential_ref": "secret://provider/model-main",
  "context_window_tokens": 131072,
  "max_output_tokens": 8192,
  "safety_margin_tokens": 1024,
  "tokenizer": {"kind": "named", "id": "example-tokenizer", "revision": "2026-08"},
  "input_modalities": ["text", "image"],
  "output_modalities": ["text"],
  "tool_calling": "supported",
  "parallel_tool_calls": "unknown",
  "structured_output": "json_schema",
  "reasoning": "provider_managed",
  "streaming": "supported",
  "image_coordinates": "provider-specific-profile-id",
  "pricing_revision": "2026-08-01",
  "enabled": true,
  "adapter_options": {}
}
```

Boolean capability claims such as tool calling, parallel tool calls, and
streaming MUST use `supported`, `unsupported`, or `unknown`. Mode-valued fields
such as structured output and reasoning use their closed schema enums and also
include `unknown`. Absence MUST NOT mean support. OpenAI-compatible syntax MUST
NOT be treated as semantic compatibility.

Profile fields are resolved in this descending precedence:

1. explicit, validated operator configuration;
2. authenticated provider discovery tied to a timestamp and adapter revision;
3. Dolly's versioned built-in registry;
4. a conservative default that marks capabilities `unknown` and refuses unsafe assumptions.

The key in the configured `profiles` map MUST equal the contained `profile_id`;
the control plane rejects a mismatch. The resolved profile and provenance of
every field MUST be inspectable. A running request MUST retain its original
revision even if configuration reloads.

## 3. Canonical request

The Gateway MUST accept a canonical request conforming to
`schemas/model-request.schema.json`, for example:

```json
{
  "request_id": "0198ab31-6c44-7e8a-b2bb-000000000083",
  "module_id": "main-brain",
  "activation_id": "0198ab31-6c44-7e8a-b2bb-000000000084",
  "lease_token": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "profile": {"profile_id": "model-main", "revision": 17},
  "operation": "generate",
  "messages": [
    {
      "entry_id": "0198ab31-6c44-7e8a-b2bb-000000000085",
      "role_class": "system",
      "parts": [{"kind": "text", "text": "Follow the runtime contract.", "format": "plain"}],
      "transaction_id": null
    }
  ],
  "tools": [],
  "requested_output_modalities": ["text"],
  "output_contract": {"kind": "text"},
  "sampling": {"temperature": 0.2, "seed": 1},
  "budget": {"max_output_tokens": 2048, "max_output_asset_bytes": 0, "max_cost_microunits": null},
  "deadline": "2026-08-10T01:02:03.000000Z",
  "metadata": {"trace_id": "0198ab31-6c44-7e8a-b2bb-000000000086"},
  "adapter_options": {}
}
```

Allowed request-history part kinds are canonical text, Asset Service
references/views, Block references, provider-neutral tool call/result records,
the typed `ActionResultPart`, and the typed `MemoryEvidencePart` defined by the
request schema. An
`ActionResultPart` contains exactly `kind: "action_result"` and a `result`
conforming to `schemas/action-result.schema.json`; it is not a generic JSON
escape hatch. A generic Dolly `JsonPart` MUST NOT appear directly in canonical
model history; structured data belongs in a typed tool result, typed action
result, or the selected output contract. Provider-native message objects MUST
NOT appear in canonical history.
Unknown fields in correctness-sensitive objects MUST be rejected unless
introduced through a namespaced adapter-options object explicitly allowed by
the selected profile.

A `MemoryEvidencePart` contains exactly one selected Memory result record and
one immutable `include` decision. Before provider dispatch, the request
validator MUST verify the decision's target request, Activation, Module,
retrieval, Memory, record revision, search-result digest, query digest, and
query-basis digest against retained LLM Extension state. It MUST reject a
second `(memory_id, record_revision)` anywhere in the same request. The same
identity remains legal in a different request.

For `json_schema` and `block_draft` output contracts, `schema` MUST contain the
complete JSON Schema sent to or enforced for the provider request. The Gateway
MUST recompute `schema_digest` as `sha256:` followed by the lowercase SHA-256 of
the UTF-8 JCS bytes of `schema` and MUST reject a mismatch before network send.
A digest without locally available matching schema bytes is not a valid output
contract. For `block_draft`, the supplied schema MUST describe the exact
configured BlockDraft output contract that the LLM Extension will validate; a
digest lookup in an undeclared local registry MUST NOT substitute for those
request bytes.

Adapter options MUST be schema-validated, versioned, and recorded in the request audit. They MUST NOT override the secret boundary, deadline, context limit, output limit, or tool permission set.

Before provider dispatch, the Gateway MUST prove that
`requested_output_modalities` is a subset of both the pinned profile's declared
output modalities and the authenticated `host.models.invoke` grant. Unknown is
not support. Text, `json_schema`, and `block_draft` output contracts require the
`text` modality. A media-only request uses the `none` text contract. The request
budget counts actual bytes of every media occurrence, even when content hashes
deduplicate.

## 4. Canonical response and error

A successful non-streaming response MUST conform to
`schemas/model-response.schema.json` and therefore contains the request and
profile revisions, provider request ID if available, normalized output parts,
normalized tool-call proposals, finish reason, usage provenance, cost, and
retry history. It also identifies the actual structured-output mode as `none`,
`provider_json_schema`, `virtual_emit_tool`, or `strict_json_text`; a fallback
MUST NOT be reported as provider schema enforcement. Provider reasoning MAY be stored in an access-controlled
provider transcript when policy permits; it MUST NOT be inserted into canonical
messages or returned as ordinary assistant content by default.

Canonical response Parts are text, JSON, or Asset only; a provider cannot mint
a BlockRef. Text and JSON map to `text`. An Asset maps from the Asset Service's
sniffed type: `image/*`, `audio/*`, and `video/*` map to their named modality,
and every other authorized type maps to `file`. The actual set may be smaller
than requested but MUST be a subset of the request.

For each provider media occurrence the Gateway first persists one Runtime-
allocated UUIDv7 `import_id` under `(authenticated Module, request_id,
zero_based_output_ordinal)`. It then imports bytes through a bounded Host stream
or imports a specifically typed temporary HTTPS URL with the remaining request
byte bound. A text string resembling a URL is never fetched. Provider MIME is
only a declaration; Asset sniffing is authoritative.

The model operation remains `running` while any output import is nonterminal.
It succeeds only after every import is `AVAILABLE`, passes the requested
modality and aggregate byte budget, and holds a finite model-output lease until
the caller can create a durable Block reference or terminates. Crash recovery
queries each original Import ID and never calls the provider again to recover
media. An expired URL, rejected MIME, unsafe decoder result, or size violation
after provider completion makes the operation terminal failed with `outcome:
applied`; it does not silently omit the media. Stable codes distinguish
`MODEL_OUTPUT_MODALITY_UNREQUESTED`, `MODEL_OUTPUT_ASSET_REJECTED`,
`MODEL_OUTPUT_ASSET_LIMIT`, and `MODEL_OUTPUT_ASSET_UNAVAILABLE`.

Every failure MUST use:

```json
{
  "code": "RATE_LIMITED",
  "retryable": true,
  "outcome": "unknown",
  "message": "redacted diagnostic",
  "correlation_id": "0198ab31-6c44-7e8a-b2bb-000000000081",
  "details": {
    "class": "provider|transport|validation|budget|policy|internal",
    "phase": "before_send|request_sent|headers|streaming|complete",
    "provider_phase_outcome": "not_sent|no_response|partial|complete|unknown",
    "provider_status": 429,
    "provider_code": "redacted stable value or null",
    "request_id": "0198ab31-6c44-7e8a-b2bb-000000000082",
    "provider_request_id": null,
    "retry_after_ms": 1000
  }
}
```

The top-level object MUST conform exactly to the common error schema. The
top-level `outcome` uses the common Dolly meanings `not_applied`, `applied`, or
`unknown`. All Gateway-specific fields shown above belong inside `details`.
`details.provider_phase_outcome` supplies transport and stream detail; it MUST
NOT be used to infer that billing or a tool side effect did not occur.

Stable Gateway codes MUST distinguish invalid canonical request, unsupported capability, context limit, output limit, authentication failure, permission failure, rate limit, timeout, transport failure, provider 5xx, invalid provider response, partial stream, budget exceeded, cancelled, and internal failure.

## 5. Context and output limits

Before sending, the adapter MUST compile the exact provider payload and estimate tokens with the profile tokenizer. The admissibility condition is:

```text
compiled_input_tokens + requested_max_output_tokens + profile_safety_margin
    <= effective_context_window
```

`effective_context_window` is the value resolved by the profile precedence in Section 2, clamped by any smaller hard limit actually observed from the same provider endpoint, model, and compatible profile revision. Discovery and registry values participate through profile resolution; they do not independently override a higher-priority explicit value. A larger value from any source MUST NOT override a smaller observed hard limit until an operator validates a new provider/model revision.

If the context window or tokenizer is unknown, the profile MUST supply an operator-approved conservative byte/token bound or the Gateway MUST reject the request with `CAPABILITY_UNKNOWN`. It MUST NOT optimistically send an unbounded request.

On a provider context-limit response, the Gateway MUST record a redacted observation for profile review and return `CONTEXT_LIMIT`. It MUST NOT silently remove canonical messages. Recompiling a smaller context is the LLM Extension's responsibility.

## 6. Tool and structured-output compilation

Adapters MUST map canonical tool schemas, call IDs, result IDs,
consecutive-role rules, Memory-evidence boundaries, asset representations, and
structured-output contracts according to the selected profile. Unsupported
features MUST fail before network send. An adapter MUST NOT emulate an
unsupported side-effecting tool by executing it.

The canonical `external` role may map to a provider user or tool/data role, but
Memory evidence MUST never map to a system or developer role. If consecutive
role restrictions require concatenation, the adapter MUST insert a stable
delimiter that labels the bytes as untrusted recalled evidence and MUST keep
the current task input after that evidence. Provider syntax cannot upgrade the
evidence's canonical trust class.

Provider tool calls are proposals. Each proposal MUST contain a Runtime-domain
UUIDv7 `operation_id`, which is the canonical `tool_call_id`, and a separate
`provider_call_id` preserving the provider identifier when one exists. A missing
provider identifier is represented by JSON `null`; it MUST NOT be replaced by
the canonical identifier. Allocating the canonical identifier does not execute
the call. Tool results supplied in a later request MUST remain bound to their
canonical transaction and dependencies.

If JSON Schema is supported, the adapter MUST use the provider's strictest declared mode and the verified schema bytes from the canonical request. Otherwise it MAY use a configured virtual emit tool or strict JSON text fallback over those same verified schema bytes. The adapter MUST NOT resolve a different schema after digest validation. The response MUST identify the actual mode with the closed `structured_output_mode` enum; it MUST NOT claim schema enforcement for prompt-only JSON.

## 7. Retry, cancellation, and streaming

The Gateway MAY automatically retry only when all of the following hold:

- the error policy marks the condition retryable;
- no complete response or application-visible stream item was delivered;
- the deadline and attempt limit permit another attempt;
- retrying cannot execute a tool or other external side effect;
- the same canonical request, profile revision, and adapter options are used.

429, selected 5xx, connection establishment failure, and a connection closed before response bytes MAY be retried with server-directed delay or bounded exponential backoff with jitter. Authentication, permission, validation, unsupported capability, and budget failures MUST NOT be retried automatically.

Once any stream delta is exposed to the caller, an interrupted generation has
`details.provider_phase_outcome = "partial"` and top-level `outcome =
"applied"`: caller-visible output was applied even when provider completion or
billing remains unknown inside `details`. It MUST NOT be automatically
restarted as if it were the same output. A caller MAY start a new request and
MUST record that it is a recovery attempt. Cancellation is best effort; after a
request was sent, provider completion and cost may remain unknown.

`request_id` deduplicates Gateway bookkeeping, not necessarily provider generation. Reusing it with different canonical content MUST fail. Reusing it after a completed response MUST return the stored terminal record within the configured retention window.

## 8. Usage, cost, and budgets

Every usage component MUST be represented independently as `{value,
provenance}`. Provenance is `provider_reported`, `tokenizer_estimated`, or
`unknown`; `unknown` requires `value: null`. Input, output, reasoning, cached,
image, audio, and tool-related units MUST remain separate. A provider-reported
value for one component MUST NOT cause estimated or unavailable components to
inherit that provenance.

Cost MUST be stored in integer billing microunits with currency, pricing
revision, and provenance. Provider-billed cost is `actual`; a computation from
reported usage is `estimated`; unavailable cost is `unknown` and requires a
null amount, never a fabricated zero. A preflight cost budget SHOULD reject an estimate above the limit. A provider overrun discovered after completion MUST be reported and MUST NOT discard the response.

Rate and concurrency limits MUST be enforced per credential and profile. Every
matching profile, credential, and profile-credential record applies
simultaneously; the effective allowance is the most restrictive remaining
allowance, never last-writer-wins. Duplicate records with the same scope key are
invalid configuration. Queueing MUST respect the caller deadline. Cost or rate
throttling MUST NOT mutate Extension or Core state.

## 9. Secret and network boundary

Credentials MUST be referenced by opaque `SecretRef` in configuration and resolved only inside the Gateway. Secret values MUST be encrypted or delegated to an operating-system secret store at rest, redacted from errors and telemetry, excluded from Extension environment variables, and never returned by discovery APIs.

Base URLs and proxy settings MUST be allowlisted or privileged configuration. Redirects MUST NOT forward Authorization to a different origin. TLS verification MUST be enabled; disabling it requires an explicit development-only policy that cannot be hot-enabled in production.

Request audit payloads MUST redact Authorization, cookies, signed asset URLs, secrets embedded in adapter options, and configured sensitive message fields. Payload capture MUST be off by default.

## 10. Conformance tests

The Gateway MUST have adapter contract tests using recorded or simulated provider responses for role mapping, tools, parallel calls, structured output, reasoning replay rules, assets, usage, streaming, and every normalized error.

Tests MUST cover profile precedence, unknown capability refusal, exact
context-boundary cases, observed smaller limits, request-ID conflict, retry
before bytes, no retry after stream exposure, cancellation with unknown
outcome, provider malformed JSON/SSE, 429 delay, deadline expiry in queue,
mixed per-component usage provenance, actual/estimated/unknown cost,
canonical/provider tool-call ID separation, typed ActionResult history, typed
Memory evidence, Memory-in-system rejection, suppress/mismatched decision
rejection, duplicate Memory identity rejection within one request, allowed
cross-request repetition, missing or mismatched output-schema bytes/digest,
truthful structured-output fallback mode, secret redaction, redirect credential
stripping, and profile reload during an in-flight request.

The suite MUST additionally cover text plus image, pure media generation,
profile/grant modality denial, provider BlockRef rejection, MIME mismatch,
per-item and aggregate output size, temporary URL expiry and redaction, crash
during every Asset-import state, one Provider dispatch after restart, Asset
lease versus GC, and proof that no response is returned before all media Assets
are `AVAILABLE`.
