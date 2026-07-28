# Dolly Large Language Model (LLM) Extension

Status: Draft

This document defines the conversation Module that turns a bounded Dolly input
batch into at most one validated model-assisted Block. It owns conversation
state, prompt trust, reasoning policy, tool rounds, and output validation. It
does not own endpoint networking, credentials, model capability discovery,
embedding, reranking, or provider wire protocols.

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described by Request for Comments (RFC) 2119 and RFC 8174.
Because this document is a Draft, these terms describe the proposed contract
and do not claim current implementation conformance.

## 1. Scope and dependencies

The LLM extension MUST obey:

- `core-runtime.md` for Module jobs, immutable inputs, actor serialization,
  zero-or-one Block output, retention changes, and commit outcomes;
- `block-payload.md` for ordered content and Block/Media reference items;
- `extension-process-protocol.md` for isolation, capabilities, durable background work, and quotas;
- `model-provider.md` for descriptor-bound chat operations, reasoning wire
  behavior, provider adaptation, usage, retry classification, and live fixtures;
- `media.md` for Media identity, crop access, and storage lifetime; and
- `security-operations.md` for secrets, networking, logs, and deployment.

Memory may use embedding or rerank operations from `model-provider.md` directly.
It MUST NOT depend on this conversation extension. This extension exposes no
embedding application programming interface (API).

An installed provider adapter is not an LLM Module. The model provider broker
owns endpoint bindings, credentials, outbound provider traffic, and temporary
media grants. The LLM extension receives only an opaque, descriptor-bound
`chat-completion` operation handle.

## 2. Module and conversation identity

The baseline maps one LLM `moduleId` to one conversation scope. A Module is
already one configured instance. The host associates that scope with:

- Dolly instance and owner/tenant;
- Module and generation;
- session and conversation identifiers;
- configured input/output Pages; and
- one conversation-state namespace and revision.

Payload text, model output, Page labels, tool arguments, or client fields cannot
select or broaden this identity. Missing identity fails closed; it MUST NOT fall
back to a process-global history or a `default` conversation.

Multiplexing several conversations through one Module is outside the baseline.
A future contract would need runtime-authenticated per-Delivery routing,
independent revisions and stores, fair bounded queues, and cross-conversation
isolation tests. A payload-supplied conversation identifier is insufficient.

The Core actor serializes the complete action, including provider calls, tool
rounds, result preparation, and Core commit. New Deliveries arriving during the
action remain for the next Module job. A timeout, retry, reload, or late provider
response MUST NOT overlap or mutate a newer conversation revision.

## 3. Input action

### 3.1 Exact batch

One Run receives the exact immutable Delivery batch for its `moduleJobId`.
Blocks are ordered and grouped by Core rules. When the same Block arrived through
several Deliveries, the canonical content is included once and occurrence/Page
metadata remains a separate input envelope. The extension MUST NOT duplicate
prompt content merely because occurrence count is greater than one.

The baseline accepts registered `dolly.content/1` payloads. It preserves item
order and handles:

- text items as untrusted content;
- `media-reference` items through their exact `mediaId` and optional crop;
- `block-reference` items through bounded, authorized expansion; and
- allowlisted extension-data schemas through schema-specific adapters.

Unknown extension data is not stringified into a prompt. Its registered fallback
or a bounded unsupported marker MAY be used. Raw payload keys that resemble a
Uniform Resource Locator (URL), path, Media identifier, tool, role, or
capability have no authority.

Console message-boundary items MAY preserve separate user message units inside
one Block. Console session, route, Module job, and self-loop identifiers do not
enter the prompt. Memory recall data remains explicitly delimited, untrusted
recalled context.

### 3.2 Assembly order and limits

For the same committed conversation revision, input batch, configuration,
Module descriptions, provider snapshot, and clock value explicitly supplied by policy,
request assembly MUST be deterministic. The initial order is:

1. deployment-owned static policy;
2. system-owned capability disclosure derived from the frozen provider snapshot;
3. bounded adjacent Module descriptions and configured static skill catalog/context;
4. committed conversation units selected by the context policy; and
5. the current input batch in Core order.

Every category has independent and total byte, token, item, media, reference,
and expansion limits. A provider-aware token estimate does not replace hard byte
limits. If the current input cannot fit after eligible old context is evicted,
the action fails with a typed input-limit result before provider input/output
(I/O).

## 4. Conversation journal and Core commit

### 4.1 Canonical units

Canonical conversation state is provider-independent. It stores immutable units:

- one input batch with Block/Delivery provenance and ordered content;
- one assistant final response with reasoning kept in a separate channel; and
- one complete tool round containing the assistant calls and exactly one
  terminal result for every accepted call.

Provider wire messages, signed URLs, inline provider bytes, endpoint routes,
credentials, temporary upload handles, and stream fragments are never canonical
conversation state.

Context eviction removes whole units. It MUST NOT leave an orphan tool call,
tool result, reasoning replay segment, media annotation, or attachment. Stable
ordering and the exact context-policy version are part of the conversation
revision.

### 4.2 Turn journal

Provider and tool work occurs before the Core accepts the Module result. Before
the first external call, the extension persists a turn journal entry keyed by
`moduleJobId`, with stable provider, correction, and tool invocation slots,
starting revision, exact inputs, and budgets. It updates the entry
transactionally as calls become known-terminal. The final form includes:

- starting conversation revision and exact input Delivery identifiers;
- frozen model operation snapshot identity;
- normalized provider request/result identities and terminal state;
- reasoning observation and separately retained reasoning segments when policy
  permits them;
- complete tool and effect journal;
- optional BlockProposal and Module retention changes;
- canonical Module `resultDigest`; and
- finite expiry and recovery status.

The extension assembles the final immutable Module result, computes its digest,
persists the matching terminal turn journal entry, and then returns that exact
result unchanged.
A retry of the same Module job finds the journal and reuses a known terminal
provider response and tool results. It MUST NOT call the model or repeat an
effect merely because `runId` changed.

A turn journal entry is not visible conversation history. It commits only after
the Extension process protocol `module-job-outcome` operation proves that the
same `moduleJobId` and
`resultDigest` committed. A lost notification is recovered by outcome lookup.
A nacked, rejected, conflicting, or abandoned result is discarded or retained
only as bounded diagnostics; it cannot advance conversation state.

Before every new action, the extension reconciles older turn journal entries so the
starting conversation revision includes every prior Core-committed turn. Turn
commit uses compare-and-set on that revision. A mismatch is an invariant error,
not permission to overwrite newer history.

### 4.3 Retained media and Blocks

If future context needs a Block or Media after the run lease closes, the
Module result MUST add a bounded strong reference owned by an enumerable
`module` record through
`ModuleRetentionChange`. Keys are scoped to the conversation and turn. Context
eviction or session close removes those strong references through a later serialized result.

Copying permitted text into conversation storage is derived retention and must
follow the declared privacy/delete policy. Retaining a `mediaId` without a Core
strong reference is invalid. Temporary provider grants never become retention keys.

## 5. Prompt trust

Only static deployment-owned policy selected outside extension/model content may
be encoded at system or equivalent privileged authority. The following are
untrusted unless an operator explicitly promotes one fixed, reviewed artifact:

- user and Console content;
- Block summaries and extension data;
- recalled memory;
- adjacent Module descriptions;
- skill names, descriptions, and bodies;
- tool descriptions from third parties;
- web, file, Model Context Protocol (MCP), and tool results;
- provider errors and model output; and
- prior assistant responses and reasoning.

Untrusted values are encoded as delimited user/tool context with provenance.
Text cannot grant a capability, change scope, approve a tool, alter budgets,
select a model, or become a system instruction because it asks to do so.

Capability disclosure is generated from trusted host state and the frozen model
descriptor. It states only verified modalities, unavailable capabilities, and
other facts required for honest behavior. Model, memory, skill, Module description, or tool
text cannot edit it.

Dynamic values such as current date are added to a request copy by an explicit
policy and clock capability. They do not mutate prior messages on every call.

## 6. Chat operation and reasoning policy

### 6.1 Operation selection

Configuration references one non-secret `ModelOperationRef` whose exact
operation is `chat-completion`. At action start, the model provider broker returns a frozen
snapshot. Unknown, incompatible, revoked, or capability-unknown requirements
fail before provider I/O.

The LLM extension cannot inspect or construct the endpoint route, attach a
credential, merge arbitrary provider fields, or use generic Hypertext Transfer
Protocol (HTTP) access to reach the
same endpoint. It submits a normalized chat invocation to the operation handle
with the exact `moduleJobId` and `runId`, deadline, cancellation, and finite budgets.

### 6.2 Reasoning policy

Each request selects one reasoning policy:

- `default`: use the descriptor default without requesting a change;
- `prefer`: request reasoning when controllable, but permit unavailable support
  and report that the preference was not satisfied;
- `require`: require a compatible mode and per-response observed reasoning; or
- `disable`: require reasoning to be disabled.

The provider descriptor, not a provider/model-name substring, declares whether
reasoning is `unsupported`, `always-on`, or `request-controlled`, and which
forbidden, boolean, enum, or adapter request strategy is legal. The required
mapping from the reasoning policy to the provider request is:

| Support | `default` | `prefer` | `require` | `disable` |
| --- | --- | --- | --- | --- |
| `unsupported` | no override | continue, unsatisfied | reject | no override |
| `always-on` | no override | no override | invoke, verify | reject |
| `request-controlled` | endpoint default | request on | request on, verify | request off |

The model provider broker owns the actual request field. The LLM
extension MUST NOT add
`enable_thinking` or another provider field itself. The optional owner Aether
fixture is defined only by its exact descriptor in `model-provider.md`; its
always-on and forbidden-field behavior MUST NOT become a generic Qwen rule.

### 6.3 Observation and replay

Requested or configured reasoning is not proof that it occurred. The host
model provider broker
returns one normalized observation:

- `observed`: its configured channel contained non-whitespace reasoning data;
- `not-observed`: the channel existed but was empty; or
- `unavailable`: no verified observation channel exists.

A `require` request succeeds only with `observed`; otherwise it returns
`REASONING_REQUIRED_NOT_OBSERVED`. Non-stream and arbitrarily fragmented stream
responses must yield the same observation. Final answer content and reasoning
segments remain separate throughout journal, state, events, and output.

Reasoning is hidden from users and routine logs by default. If the descriptor
requires replay on a matching tool-call turn, the canonical tool unit retains
the exact bounded reasoning channel and supplies it only to that continuation.
It MUST NOT synthesize reasoning, attach it to another turn, or merge it into
the visible final answer.

## 7. Multimodal assembly

Canonical input keeps the ordered `media-reference` items from Block content.
The LLM extension passes those authorized references plus the fixed model
description to the model operation. The model provider broker asks the
Media store for compatible input and owns its time-limited provider access. The
extension never receives a signed URL, object-store key, local path, provider
upload handle, or endpoint credential.

If a required modality is unsupported or unknown, the request fails before
provider I/O unless configuration names an explicit derived capability such as
optical character recognition (OCR), captioning, transcription, or frame
extraction. Derived text is labeled
with provenance and MUST NOT be described as the model inspecting the original
media.

A crop in a Media reference remains a logical request and does not create a
second `mediaId`. The Media store may create a temporary internal image for a
provider, but that implementation detail is not part of Block content. Every
model-emitted geometry value uses the coordinate convention declared by the
selected model configuration and is converted through `media.md`. Unknown
dimensions, ambiguous edge semantics, or unverified provider resize/padding
make automatic crop unsupported; values MUST NOT be plausibly clamped.

Model or tool output containing a URL, path, `image_url`, unrecognized media
identifier, or crop request is inert until a closed output schema and
authorized capability resolve it. It cannot inject a provider wire media object
directly.

## 8. Tool and approval state machine

### 8.1 Registry

The model sees only tools selected for this Module, session, and request. Tool
discovery does not grant exposure. Each normalized definition binds:

- stable internal identifier and explicit provider-safe wire-name mapping;
- closed argument and bounded result schemas;
- effect class and resource scope;
- approval, concurrency, idempotency, and outcome-query policy;
- deadline and byte limits; and
- required capability handles.

Duplicate/unrepresentable wire names fail registry construction. Tool names are
not decoded by delimiter-dependent regular expressions. Malformed arguments
produce a typed terminal result, never an assumed `{}`.

### 8.2 Turn transitions

```text
assembling -> model-pending -> assistant-received
assistant-received -> completed | approval-pending | tools-pending
approval-pending -> tools-pending | follow-up-pending
tools-pending -> follow-up-pending -> model-pending
any nonterminal state -> failed | cancelled | outcome-unknown
```

The loop is iterative and bounded, not recursive without limit. For every
assistant tool-call response, the extension MUST:

1. validate unique call identifiers, name mappings, argument schemas, descriptor rules,
   and remaining budgets;
2. durably reserve a complete tool round and deterministic `effectSlot` for each
   call before invoking anything;
3. obtain required approval from trusted policy or an authorized human channel;
4. invoke capabilities with deadline, cancellation, and idempotency key;
5. record exactly one terminal result per accepted call, including denial,
   failure, cancellation, and unknown outcome; and
6. commit the complete assistant-call/result unit before provider continuation.

Effect idempotency uses `(moduleJobId, effectSlot)`. A provider call identifier is
recorded for correlation but is not assumed stable after a provider retry. Lost
responses are reconciled from the journal or the tool's outcome API; an unknown
effect is never blindly repeated. The durable tool-round record uses
`dolly.tool-round/2`; version 2 replaces the former Module job identity field,
and readers MUST reject version 1 as `TOOL_ROUND_INVALID` rather than treating
that field as an alias.

Parallel calls are allowed only when the provider snapshot and every selected
tool declare compatible parallel/effect semantics. Otherwise the extension uses
stable response order. A provider continuation contains all required matching
terminal results and no orphan or duplicate.

### 8.3 Approval

Approval binds trusted tool identity, validated argument digest, effect class,
resource scope, requesting session/turn, policy revision, and expiry. A model
claim that an operation is safe or approved has no authority. Changed arguments,
revoked scope, or expiry invalidate approval.

External communication, destructive action, administrative action, and broad
writes require the configured trusted approval path. Denial is an honest tool
result. Cancellation or transport loss that leaves an effect uncertain produces
`outcome-unknown` and blocks automatic continuation/retry.

## 9. Response, output, and streaming

### 9.1 Response validation

Provider output is untrusted. The extension validates the normalized envelope,
channel sizes, finish reason, tool calls, output schema, item count, numeric
ranges, and every requested Core/media reference before preparing a result.

A required structured output failure is not hidden by a plausible plain-text
answer. An optional correction request is a separate budgeted model invocation
that includes the invalid candidate, bounded validation errors, and exact schema;
it has no additional tools or authority and must pass the same validator.

### 9.2 BlockProposal

The normal final output is one `dolly.content/1` BlockProposal. Text and media
placements preserve intended order; every reference uses an explicit Core slot.
Registered structured results use namespaced extension-data. The model cannot
choose `blockId`, source, sequence, timestamp, Delivery metadata, retention key,
capability handle, URL, path, or object key.

One successful Module job returns no BlockProposal or exactly one. All configured
output Pages receive the same committed Block. Multiple assistant candidates,
tool results, or content items are not multiple Module outputs.

An absent final text is valid only for a schema-approved non-text result. A
provider/tool failure MUST NOT fabricate a successful answer. Retryable failures
nack through Core policy; a configured permanent error Block must use a
registered bounded schema and is itself the single committed output.

### 9.3 Streaming

The model provider broker reconstructs provider streams into independent reasoning, final,
tool-argument, usage, and terminal channels. The LLM extension may forward
bounded provisional user-interface events through an authorized progress facility, but
those events are not Blocks or committed conversation state.

Slow consumers receive bounded backpressure. Disconnect, malformed stream,
timeout, or cancellation marks provisional output incomplete. Only a validated
terminal response or complete tool round enters the turn journal and can later
commit.

## 10. Budgets, cancellation, and failure

Each turn has finite limits for provider requests/retries, correction calls,
tool rounds/calls, approvals, prompt/output tokens, canonical bytes, media,
references, wall time, per-operation time, and billable usage where known.
Budget is reserved before work and reconciled from broker/tool usage. Retries and
continuations consume the same turn budget.

Cancellation fences provider and tool handles, stops new work, and rejects late
state commits. A provider request may retry only under the model provider broker's policy,
within the same logical request identity, deadline, and budget. The extension
MUST NOT retry capability/schema/auth denial, an undesirable but valid answer,
work after cancellation, or an unknown external effect.

A lost provider response is retried only when the model provider broker contract gives a safe
idempotency or outcome-reconciliation path. Otherwise the turn journal records
`outcome-unknown` and Core/operator policy decides recovery.

## 11. Configuration, privacy, and observability

The closed versioned configuration declares at least:

- descriptor-bound chat operation reference;
- reasoning policy;
- context selection and eviction policy;
- accepted input and output schemas;
- tool allowlist, approval policy, and effect limits;
- all request/turn/media/output budgets;
- retained-context and session-close policy; and
- permanent error and provisional streaming policy.

It contains no raw credential, endpoint URL, host path, object key, signed URL,
or private owner environment detail. The provider-independent default exposes no
tools, hides reasoning, accepts bounded text content, and uses deterministic
local/fake operation handles for tests.

Routine logs, metrics, errors, traces, and snapshots omit prompt/final content,
reasoning, tool arguments/results, media, signed URLs, credentials, and
capability handles. Safe metrics include counts, sizes, latency, reasoning
observation state, finish/error kinds, retry/tool rounds, and budget usage without
high-cardinality conversation identifiers.

## 12. Required conformance tests

The LLM suite uses fake Core, model operation, media, tool, approval, clock, and
storage capabilities. It performs no network access and requires no private
model, Object Storage Service (OSS) account, key, or paid call. Provider adapter
conformance and optional live fixtures belong to `model-provider.md` and
`docs/experiments/protocol.md`.

Required deterministic cases include:

1. exact Core batch order, same-Block occurrence grouping, arrivals during run,
   and zero-or-one output broadcast;
2. owner/session/conversation isolation and missing identity failing closed;
3. registered standard content, message boundaries, trust handling for memory,
   skills, and Module descriptions, unknown schema fallback, and bounded forward
   expansion;
4. deterministic prompt assembly and whole-unit context eviction under token,
   byte, media, and event limits;
5. turn journal crash points before/after provider response, tool journal,
   result return, Core commit, outcome notification, and conversation
   compare-and-set;
6. retry preserving `moduleJobId`, changing `runId`, and never duplicating a
   known provider result, tool effect, Block, turn, or retained strong reference;
7. all reasoning support/policy combinations, observed/empty/unavailable
   results, stream fragmentation, separate final content, and required replay;
8. proof that an always-on descriptor with a forbidden `enable_thinking` field
   causes no extension-side field injection and still requires per-response
   observation when the reasoning policy is `require`;
9. text-only, image-only, and mixed ordered content; unsupported modality;
   derived text disclosure; Media crop geometry; and host-owned access
   cleanup without a URL reaching extension state;
10. tool allowlisting, name collision, malformed arguments, approval/denial,
    stable effect slots, parallel restrictions, complete rounds, cancellation,
    budget exhaustion, and unknown outcomes;
11. structured output, correction, forged Core/media fields, unknown finish
    reason, malformed normalized responses, and deterministic output limits;
12. provisional streaming backpressure and failure never committing partial
    content;
13. context strong-reference add/evict/session-close handoff and collection; and
14. adversarial prompt injection through user, memory, Module description, skill, tool,
    provider error, and prior model content gaining no authority.

Fault tests MUST use process termination and the declared Extension isolation
where hard termination is claimed. A skipped required case or caught unhandled error
fails conformance.

## 13. Migration and acceptance

Migration from the current extension requires removing provider-family guesses,
unconditional provider fields, direct endpoint/credential use, mutable global
history, unscoped media placeholders, recursive tool loops, and prompt promotion
of memory or Module description text. Existing provider adapters move behind the shared
broker and must prove conformance to the exact provider protocol.

This Draft cannot become Accepted until the canonical conversation schemas,
turn journal and outcome recovery, context retention policy, normalized chat result,
tool and effect journal, reasoning policy mapping, and standard content output have
closed wire schemas and passing deterministic tests. Success against the owner's
private Aether fixture or any other live endpoint is optional evidence, never a
substitute for those tests.
